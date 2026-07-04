import express from "express";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { fileURLToPath } from "url";
import { applyHttpSecurity, createPlaidRateLimiter } from "./httpSecurity.js";
import { getFirebaseAdminServices } from "./firebaseAdmin.js";
import { createRequireFirebaseAuth } from "./requireFirebaseAuth.js";
import { resolveEncryptionKey, encryptSecret, decryptSecret } from "./plaidCrypto.js";
import { createPlaidStore } from "./plaidStore.js";
import { createPlaidRouter } from "./plaidRouter.js";
import { createAskHandler, createOpenAIClient } from "./aiCopilot.js";

dotenv.config();

const app = express();
const NODE_ENV = process.env.NODE_ENV || "development";

function validateRequiredEnvironment({
  nodeEnv,
  variables,
}) {
  const missing = variables.filter((name) => {
    const value = process.env[name];
    return typeof value !== "string" || value.trim() === "";
  });

  if (!missing.length) {
    return;
  }

  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

validateRequiredEnvironment({
  nodeEnv: NODE_ENV,
  variables: NODE_ENV === "production"
    ? [
        "NODE_ENV",
        "PLAID_ENV",
        "PLAID_CLIENT_ID",
        "PLAID_SECRET",
        "FIREBASE_SERVICE_ACCOUNT_BASE64",
        "PLAID_TOKEN_ENCRYPTION_KEY",
        "ALLOWED_ORIGINS",
        "OPENAI_API_KEY",
        "TICKETMASTER_API_KEY",
        "MAPBOX_ACCESS_TOKEN",
      ]
    : [],
});

applyHttpSecurity(app, {
  allowedOrigins: process.env.ALLOWED_ORIGINS || "",
  nodeEnv: NODE_ENV,
});
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 8080;

// --------------------------------------------------
// ENV HELPERS
// --------------------------------------------------

const PLAID_ENV_RAW = (process.env.PLAID_ENV || "production").toLowerCase();

const resolvedPlaidEnvironment =
  PLAID_ENV_RAW === "production"
    ? PlaidEnvironments.production
    : PLAID_ENV_RAW === "development"
    ? PlaidEnvironments.development
    : PlaidEnvironments.sandbox;

const hasPlaidKeys =
  !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SECRET;

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
const plaidEncryptionKey = resolveEncryptionKey({
  envValue: process.env.PLAID_TOKEN_ENCRYPTION_KEY || "",
  nodeEnv: NODE_ENV,
});
const firebaseAdminServices = getFirebaseAdminServices({
  serviceAccountBase64:
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "",
  nodeEnv: NODE_ENV,
});
const requireFirebaseAuth = createRequireFirebaseAuth(
  firebaseAdminServices.auth
);
const plaidStore = createPlaidStore(
  firebaseAdminServices.firestore,
  firebaseAdminServices.admin
);

// --------------------------------------------------
// OPENAI
// --------------------------------------------------

const client = createOpenAIClient({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30_000,
  logger: console,
});

// --------------------------------------------------
// PLAID
// --------------------------------------------------

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: resolvedPlaidEnvironment,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
        "PLAID-SECRET": process.env.PLAID_SECRET || "",
      },
    },
  })
);

const plaidRouter = createPlaidRouter({
  plaidClient,
  hasPlaidKeys,
  plaidEnvironment: PLAID_ENV_RAW,
  requireFirebaseAuth,
  store: plaidStore,
  encryptionKey: plaidEncryptionKey,
  encryptSecret,
  decryptSecret,
  nodeEnv: NODE_ENV,
  plaidWebhookUrl:
    process.env.PLAID_WEBHOOK_URL ||
    "https://gigprofit-ai-production.up.railway.app/plaid/webhook",
  admin: firebaseAdminServices.admin,
});

// --------------------------------------------------
// COMMUNITY REPORTS (memory-only v1)
// --------------------------------------------------

const COMMUNITY_REPORT_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const communityReports = [];

function cleanupCommunityReports() {
  const cutoff = Date.now() - COMMUNITY_REPORT_TTL_MS;

  for (let i = communityReports.length - 1; i >= 0; i -= 1) {
    if (communityReports[i].createdAt < cutoff) {
      communityReports.splice(i, 1);
    }
  }
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function parseExpectedMidpoint(text) {
  const nums = String(text || "").match(/\d+/g);

  if (!nums || !nums.length) return 24;

  const parsed = nums.map(Number).filter((n) => !Number.isNaN(n));

  if (parsed.length >= 2) {
    return (parsed[0] + parsed[1]) / 2;
  }

  return parsed[0] || 24;
}

function getCommunitySnapshot(city, zoneName) {
  cleanupCommunityReports();

  const cityKey = normalizeKey(city);
  const zoneKey = normalizeKey(zoneName);

  const cityReports = communityReports.filter(
    (report) => normalizeKey(report.city) === cityKey
  );

  const zoneReports = cityReports.filter(
    (report) => normalizeKey(report.zone) === zoneKey
  );

  return {
    cityCount: cityReports.length,
    zoneCount: zoneReports.length,
    cityAvgHourly: average(cityReports.map((r) => r.hourlyRate)),
    zoneAvgHourly: average(zoneReports.map((r) => r.hourlyRate)),
    cityAvgPerMile: average(cityReports.map((r) => r.dollarsPerMile)),
    zoneAvgPerMile: average(zoneReports.map((r) => r.dollarsPerMile)),
  };
}

function buildDynamicExpected({
  baseExpectedText,
  trafficLevelValue,
  timeBonusPoints,
  eventBoost,
  community,
}) {
  const baseMid = parseExpectedMidpoint(baseExpectedText);

  let center = baseMid;
  let source = "base";
  let sampleCount = 0;

  if (community.zoneAvgHourly && community.zoneCount >= 3) {
    center = community.zoneAvgHourly;
    source = "zone";
    sampleCount = community.zoneCount;
  } else if (community.cityAvgHourly && community.cityCount >= 6) {
    center = community.cityAvgHourly;
    source = "city";
    sampleCount = community.cityCount;
  } else if (community.zoneAvgHourly) {
    center = baseMid * 0.5 + community.zoneAvgHourly * 0.5;
    source = "blended-zone";
    sampleCount = community.zoneCount;
  } else if (community.cityAvgHourly) {
    center = baseMid * 0.7 + community.cityAvgHourly * 0.3;
    source = "blended-city";
    sampleCount = community.cityCount;
  }

  switch (trafficLevelValue) {
    case "light":
      center *= 1.03;
      break;
    case "moderate":
      center *= 0.98;
      break;
    case "busy":
      center *= 0.9;
      break;
    case "heavy":
      center *= 0.8;
      break;
    default:
      center *= 1.0;
  }

  center *= 1 + Math.min(timeBonusPoints * 0.004, 0.06);
  center += Math.min(eventBoost * 0.2, 4);

  const lowData =
    (community.zoneCount || 0) < 3 &&
    (community.cityCount || 0) < 6;

  if (lowData) {
    center *= 0.75;
  }

  if (
    (trafficLevelValue === "busy" || trafficLevelValue === "heavy") &&
    lowData
  ) {
    center *= 0.85;
  }

  if (center > 32 && lowData) {
    center = 32;
  }

  center = clamp(center, 12, 60);

  let spread = 0.25;

  if (sampleCount >= 10) {
    spread = 0.12;
  } else if (sampleCount >= 5) {
    spread = 0.16;
  } else if (sampleCount >= 3) {
    spread = 0.2;
  }

  const low = clamp(center * (1 - spread / 2), 10, 55);
  const high = clamp(center * (1 + spread / 2), 12, 65);

  return {
    expected: `$${Math.round(low)}-$${Math.round(high)}/hr`,
    expectedLow: Number(low.toFixed(1)),
    expectedHigh: Number(high.toFixed(1)),
    expectedSource: source,
    expectedSampleCount: sampleCount,
  };
}

// --------------------------------------------------
// TICKETMASTER
// --------------------------------------------------

async function getNearbyEvents(city) {
  const apiKey = process.env.TICKETMASTER_API_KEY;

  if (!apiKey) return [];

  try {
    const url =
      `https://app.ticketmaster.com/discovery/v2/events.json` +
      `?apikey=${apiKey}` +
      `&city=${encodeURIComponent(city)}` +
      `&size=8` +
      `&sort=date,asc`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Ticketmaster request failed: ${response.status}`);
    }

    const data = await response.json();
    const events = data?._embedded?.events || [];

    return events.map((event) => {
      const venue = event?._embedded?.venues?.[0];

      return {
        name: event?.name || "Unknown Event",
        venue: venue?.name || "Unknown Venue",
        lat: venue?.location?.latitude ? parseFloat(venue.location.latitude) : null,
        lon: venue?.location?.longitude ? parseFloat(venue.location.longitude) : null,
        date: event?.dates?.start?.localDate || null,
        time: event?.dates?.start?.localTime || null,
      };
    });
  } catch (error) {
    console.error("TICKETMASTER ERROR:", error.message);
    return [];
  }
}

// --------------------------------------------------
// CITY ZONES
// --------------------------------------------------

function getCityZones(city) {
  const zoneMap = {
    Charlotte: [
      {
        city: "Charlotte",
        name: "Uptown",
        type: "downtown",
        lat: 35.2271,
        lon: -80.8431,
        baseScore: 84,
        expected: "$24-$36/hr",
        description:
          "Strong business, hotel, commuter, and event traffic in central Charlotte.",
      },
      {
        city: "Charlotte",
        name: "South End",
        type: "nightlife",
        lat: 35.213,
        lon: -80.8576,
        baseScore: 88,
        expected: "$28-$40/hr",
        description:
          "One of the best nightlife and restaurant zones in Charlotte, especially evenings.",
      },
      {
        city: "Charlotte",
        name: "NoDa",
        type: "nightlife",
        lat: 35.2479,
        lon: -80.8057,
        baseScore: 78,
        expected: "$22-$34/hr",
        description:
          "Popular arts and bar district with solid evening and weekend demand.",
      },
      {
        city: "Charlotte",
        name: "CLT Airport",
        type: "airport",
        lat: 35.2144,
        lon: -80.9473,
        baseScore: 80,
        expected: "$22-$35/hr",
        description:
          "Strong airport demand during travel peaks and useful for longer rides.",
      },
      {
        city: "Charlotte",
        name: "University City",
        type: "university",
        lat: 35.3071,
        lon: -80.7359,
        baseScore: 70,
        expected: "$18-$28/hr",
        description:
          "Student and campus traffic can create short-trip demand during active hours.",
      },
    ],
  };

  return zoneMap[city] || zoneMap["Charlotte"];
}

// --------------------------------------------------
// RADAR HELPERS
// --------------------------------------------------

function timeBonus(type, hour) {
  switch (type) {
    case "nightlife":
      return hour >= 19 || hour <= 2 ? 12 : 0;
    case "downtown":
      return (hour >= 7 && hour <= 10) || (hour >= 16 && hour <= 19) ? 10 : 3;
    case "airport":
      return (hour >= 5 && hour <= 9) || (hour >= 16 && hour <= 20) ? 8 : 2;
    case "university":
      return hour >= 8 && hour <= 18 ? 6 : 1;
    case "shopping":
      return hour >= 11 && hour <= 19 ? 5 : 1;
    default:
      return 0;
  }
}

function trafficPenaltyFromMinutes(minutes) {
  if (minutes <= 8) return 0;
  if (minutes <= 15) return 3;
  if (minutes <= 22) return 7;
  if (minutes <= 30) return 12;
  return 18;
}

function trafficLevel(minutes) {
  if (minutes <= 8) return "light";
  if (minutes <= 15) return "moderate";
  if (minutes <= 25) return "busy";
  return "heavy";
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.asin(Math.sqrt(a));
  return earthRadiusMiles * c;
}

function distancePenalty(miles) {
  if (miles < 2) return 0;
  if (miles < 5) return 4;
  if (miles < 8) return 8;
  if (miles < 12) return 14;
  return 22;
}

function estimateDriveMinutes(miles) {
  return Math.max(1, Math.round((miles / 25) * 60));
}

async function getTrafficDriveMinutes(originLon, originLat, destLon, destLat) {
  const token = process.env.MAPBOX_ACCESS_TOKEN;

  if (!token) return null;

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/` +
    `${originLon},${originLat};${destLon},${destLat}` +
    `?alternatives=false&geometries=geojson&overview=simplified&steps=false&access_token=${token}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Mapbox traffic request failed: ${response.status}`);
  }

  const data = await response.json();
  const route = data?.routes?.[0];

  if (!route?.duration) return null;

  return Math.max(1, Math.round(route.duration / 60));
}

function formatEventSummary(events) {
  if (!events.length) return "No major events detected";

  return events
    .slice(0, 5)
    .map((event) => {
      const parts = [event.name];
      if (event.venue) parts.push(`at ${event.venue}`);
      if (event.date) parts.push(`on ${event.date}`);
      if (event.time) parts.push(`at ${event.time}`);
      return parts.join(" ");
    })
    .join("\n");
}

// --------------------------------------------------
// BASIC
// --------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "gigprofit-ai",
    environment: NODE_ENV,
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "gigprofit-ai",
    environment: NODE_ENV,
  });
});

// --------------------------------------------------
// COMMUNITY
// --------------------------------------------------

app.post("/community/report", (req, res) => {
  try {
    const { city, zone, pay, miles, minutes, source = "scan" } = req.body || {};

    const payNumber = Number(pay);
    const milesNumber = Number(miles);
    const minutesNumber = Number(minutes);

    if (
      !city ||
      !zone ||
      Number.isNaN(payNumber) ||
      Number.isNaN(milesNumber) ||
      Number.isNaN(minutesNumber) ||
      payNumber <= 0 ||
      milesNumber <= 0 ||
      minutesNumber <= 0
    ) {
      return res.status(400).json({ error: "Invalid community report payload" });
    }

    const hourlyRate = (payNumber / minutesNumber) * 60;
    const dollarsPerMile = payNumber / milesNumber;

    communityReports.push({
      city,
      zone,
      pay: payNumber,
      miles: milesNumber,
      minutes: minutesNumber,
      hourlyRate,
      dollarsPerMile,
      source,
      createdAt: Date.now(),
    });

    cleanupCommunityReports();

    return res.json({
      ok: true,
      reportsInMemory: communityReports.length,
    });
  } catch (error) {
    console.error("COMMUNITY REPORT ERROR:", error);
    return res.status(500).json({ error: "Community report failed" });
  }
});

// --------------------------------------------------
// AI ASSISTANT
// --------------------------------------------------

app.post("/ask", createAskHandler({
  openaiClient: client,
  hasOpenAIKey,
  logger: console,
}));

// --------------------------------------------------
// RADAR
// --------------------------------------------------

app.post("/radar/recommend", async (req, res) => {
  try {
    if (!hasOpenAIKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
    }

    const {
      city = "Charlotte",
      latitude,
      longitude,
      hour,
      mode = "manual",
    } = req.body || {};

    const resolvedHour =
      typeof hour === "number" && hour >= 0 && hour <= 23
        ? hour
        : new Date().getHours();

    const cityZones = getCityZones(city);
    const events = await getNearbyEvents(city);

    let referenceLat = cityZones[0]?.lat ?? 35.2271;
    let referenceLon = cityZones[0]?.lon ?? -80.8431;

    if (typeof latitude === "number" && typeof longitude === "number") {
      referenceLat = latitude;
      referenceLon = longitude;
    }

    const scoredZones = await Promise.all(
      cityZones.map(async (zone) => {
        const miles = distanceMiles(referenceLat, referenceLon, zone.lat, zone.lon);

        let driveMinutes = estimateDriveMinutes(miles);
        let liveTraffic = false;

        try {
          const liveMinutes = await getTrafficDriveMinutes(
            referenceLon,
            referenceLat,
            zone.lon,
            zone.lat
          );

          if (typeof liveMinutes === "number") {
            driveMinutes = liveMinutes;
            liveTraffic = true;
          }
        } catch (trafficError) {
          console.error("TRAFFIC ERROR:", trafficError.message);
        }

        let eventBoost = 0;
        const nearbyEvents = [];

        for (const event of events) {
          if (typeof event.lat !== "number" || typeof event.lon !== "number") continue;

          const eventDistance = distanceMiles(zone.lat, zone.lon, event.lat, event.lon);

          if (eventDistance < 2) {
            eventBoost += 12;
            nearbyEvents.push(event.name);
          } else if (eventDistance < 5) {
            eventBoost += 6;
            nearbyEvents.push(event.name);
          }
        }

        const level = trafficLevel(driveMinutes);
        const bonus = timeBonus(zone.type, resolvedHour);
        const community = getCommunitySnapshot(city, zone.name);

        const dynamicExpected = buildDynamicExpected({
          baseExpectedText: zone.expected,
          trafficLevelValue: level,
          timeBonusPoints: bonus,
          eventBoost,
          community,
        });

        const finalScore = Math.max(
          1,
          zone.baseScore +
            bonus +
            eventBoost -
            distancePenalty(miles) -
            trafficPenaltyFromMinutes(driveMinutes)
        );

        return {
          city: zone.city,
          name: zone.name,
          type: zone.type,
          lat: zone.lat,
          lon: zone.lon,
          baseScore: zone.baseScore,
          expected: dynamicExpected.expected,
          description: zone.description,
          distanceMiles: Number(miles.toFixed(1)),
          driveMinutes,
          trafficLevel: level,
          liveTraffic,
          finalScore,
          eventBoost,
          nearbyEvents: Array.from(new Set(nearbyEvents)).slice(0, 3),
          expectedLow: dynamicExpected.expectedLow,
          expectedHigh: dynamicExpected.expectedHigh,
          expectedSource: dynamicExpected.expectedSource,
          expectedSampleCount: dynamicExpected.expectedSampleCount,
          communityZoneCount: community.zoneCount,
          communityCityCount: community.cityCount,
          communityZoneAvgHourly: community.zoneAvgHourly,
          communityCityAvgHourly: community.cityAvgHourly,
        };
      })
    );

    scoredZones.sort((a, b) => b.finalScore - a.finalScore);

    const aiPrompt = `
You are GigProfit Radar AI for Uber and Lyft drivers.

User city: ${city}
Mode: ${mode}
Current hour: ${resolvedHour}

Live events nearby:
${formatEventSummary(events)}

Top candidate zones:
${scoredZones
  .slice(0, 3)
  .map(
    (z, i) => `
${i + 1}. ${z.name}
type: ${z.type}
score: ${z.finalScore}
distance: ${z.distanceMiles} miles
drive time: ${z.driveMinutes} min
traffic level: ${z.trafficLevel}
expected earnings: ${z.expected}
description: ${z.description}
event boost: ${z.eventBoost}
nearby events: ${z.nearbyEvents.length ? z.nearbyEvents.join(", ") : "none"}
community zone count: ${z.communityZoneCount}
community city count: ${z.communityCityCount}
community zone avg hourly: ${z.communityZoneAvgHourly ?? "n/a"}
community city avg hourly: ${z.communityCityAvgHourly ?? "n/a"}
`
  )
  .join("\n")}

Write a short driver-friendly recommendation in plain English.

Format exactly like this:

Best move now: <zone>

Why:
<1-2 short lines>

Traffic:
<light / moderate / busy / heavy>

Expected:
<earnings>

Recommendation:
<Drive there now / Stay nearby / Maybe>
`.trim();

    const aiResponse = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are a concise radar copilot for Uber and Lyft drivers. Be direct and practical.",
        },
        { role: "user", content: aiPrompt },
      ],
    });

    const explanation =
      aiResponse.choices?.[0]?.message?.content ?? "No recommendation generated.";

    res.json({
      city,
      mode,
      hour: resolvedHour,
      bestZone: scoredZones[0],
      zones: scoredZones,
      explanation,
      events: events.slice(0, 5),
      communityReportsInMemory: communityReports.length,
    });
  } catch (error) {
    console.error("RADAR ERROR:", error);
    res.status(500).json({
      error: "Radar recommendation failed",
      details: error?.message || String(error),
    });
  }
});

// --------------------------------------------------
// OFFLINE STATE PACKS
// --------------------------------------------------

function getOfflineStatePack(stateCode = "NC") {
  const code = String(stateCode || "NC").toUpperCase();

  const statePacks = {
    NC: {
      stateCode: "NC",
      stateName: "North Carolina",
      majorCities: [
        {
          name: "Charlotte",
          lat: 35.2271,
          lon: -80.8431
        },
        {
          name: "Raleigh",
          lat: 35.7796,
          lon: -78.6382
        },
        {
          name: "Greensboro",
          lat: 36.0726,
          lon: -79.7920
        }
      ],
      airports: [
        {
          name: "CLT Airport",
          lat: 35.2144,
          lon: -80.9473,
          priority: "high"
        },
        {
          name: "RDU Airport",
          lat: 35.8801,
          lon: -78.7880,
          priority: "high"
        }
      ],
      hotspots: [
        {
          name: "Uptown Charlotte",
          type: "downtown",
          lat: 35.2271,
          lon: -80.8431,
          expected: "$24-$36/hr"
        },
        {
          name: "South End",
          type: "nightlife",
          lat: 35.2130,
          lon: -80.8576,
          expected: "$28-$40/hr"
        },
        {
          name: "NoDa",
          type: "nightlife",
          lat: 35.2479,
          lon: -80.8057,
          expected: "$22-$34/hr"
        }
      ],
      generatedAt: new Date().toISOString()
    },

    SC: {
      stateCode: "SC",
      stateName: "South Carolina",
      majorCities: [
        {
          name: "Columbia",
          lat: 34.0007,
          lon: -81.0348
        },
        {
          name: "Charleston",
          lat: 32.7765,
          lon: -79.9311
        },
        {
          name: "Greenville",
          lat: 34.8526,
          lon: -82.3940
        }
      ],
      airports: [
        {
          name: "CHS Airport",
          lat: 32.8986,
          lon: -80.0405,
          priority: "high"
        }
      ],
      hotspots: [
        {
          name: "Downtown Charleston",
          type: "downtown",
          lat: 32.7765,
          lon: -79.9311,
          expected: "$22-$34/hr"
        }
      ],
      generatedAt: new Date().toISOString()
    }
  };

  return statePacks[code] || statePacks["NC"];
}

app.get("/offline/state-pack", async (req, res) => {
  try {
    const state = req.query.state || "NC";

    const pack = getOfflineStatePack(state);

    return res.json({
      ok: true,
      source: "gigprofit-offline-pack",
      pack
    });
  } catch (error) {
    console.error("OFFLINE PACK ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to generate offline state pack",
      details: error?.message || String(error)
    });
  }
});

// --------------------------------------------------
// PLAID
// --------------------------------------------------

app.use("/plaid", createPlaidRateLimiter(), plaidRouter);

// --------------------------------------------------
// START
// --------------------------------------------------

const currentModulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] || "";

if (currentModulePath === invokedPath) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`GigProfit backend listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Plaid env: ${PLAID_ENV_RAW}`);
    console.log(`Plaid configured: ${hasPlaidKeys ? "yes" : "no"}`);
    console.log(`OpenAI configured: ${hasOpenAIKey ? "yes" : "no"}`);
  });
}

export { app };
        
