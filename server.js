import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CITY_CENTERS = {
  Charlotte: { lat: 35.2271, lon: -80.8431 },
  Atlanta: { lat: 33.7490, lon: -84.3880 },
  Miami: { lat: 25.7617, lon: -80.1918 },
  Orlando: { lat: 28.5383, lon: -81.3792 },
  Tampa: { lat: 27.9506, lon: -82.4572 },
  Nashville: { lat: 36.1627, lon: -86.7816 },
  Dallas: { lat: 32.7767, lon: -96.7970 },
  Houston: { lat: 29.7604, lon: -95.3698 },
  Austin: { lat: 30.2672, lon: -97.7431 },
  Chicago: { lat: 41.8781, lon: -87.6298 },
  "New York": { lat: 40.7128, lon: -74.0060 },
  "Los Angeles": { lat: 34.0522, lon: -118.2437 },
  Phoenix: { lat: 33.4484, lon: -112.0740 },
  "Las Vegas": { lat: 36.1699, lon: -115.1398 },
  "San Francisco": { lat: 37.7749, lon: -122.4194 },
  Seattle: { lat: 47.6062, lon: -122.3321 },
};

function getCityZones(city) {
  const center = CITY_CENTERS[city] || CITY_CENTERS["Charlotte"];

  return [
    {
      city,
      name: `${city} Downtown`,
      type: "downtown",
      lat: center.lat,
      lon: center.lon,
      baseScore: 82,
      expected: "$24–$36/hr",
      description: "Usually strong for dense trip volume, offices, hotels, and events.",
    },
    {
      city,
      name: `${city} Airport`,
      type: "airport",
      lat: center.lat - 0.04,
      lon: center.lon - 0.09,
      baseScore: 74,
      expected: "$22–$32/hr",
      description: "Can be strong during travel peaks and for longer rides.",
    },
    {
      city,
      name: `${city} Nightlife`,
      type: "nightlife",
      lat: center.lat - 0.02,
      lon: center.lon - 0.01,
      baseScore: 86,
      expected: "$28–$40/hr",
      description: "Best in evenings and weekends when bars and restaurants are active.",
    },
    {
      city,
      name: `${city} University`,
      type: "university",
      lat: center.lat + 0.06,
      lon: center.lon + 0.05,
      baseScore: 69,
      expected: "$20–$30/hr",
      description: "Good short-trip demand from students and campus traffic.",
    },
    {
      city,
      name: `${city} Shopping District`,
      type: "shopping",
      lat: center.lat + 0.03,
      lon: center.lon - 0.05,
      baseScore: 64,
      expected: "$18–$27/hr",
      description: "Steady daytime demand near malls and retail centers.",
    },
    {
      city,
      name: `${city} Suburbs`,
      type: "suburbs",
      lat: center.lat - 0.08,
      lon: center.lon + 0.09,
      baseScore: 57,
      expected: "$16–$23/hr",
      description: "Usually weaker, but can work around commuter rush hours.",
    },
  ];
}

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
    case "suburbs":
      return (hour >= 6 && hour <= 9) || (hour >= 15 && hour <= 19) ? 4 : 0;
    default:
      return 0;
  }
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

app.get("/", (req, res) => {
  res.send("GigProfit AI backend running");
});

app.post("/ask", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
You are GigProfit AI, a smart assistant for Uber, Lyft, and delivery drivers.

Your job:
- analyze offers fast
- help drivers decide if an order is worth taking
- speak in plain, practical English
- be concise
- never use LaTeX, formulas, markdown tables, or academic explanations
- never sound like a math tutor

When the user gives pay, miles, or time:
1. calculate dollars per mile
2. if time is given, calculate estimated dollars per hour
3. give a verdict first:
   - GOOD ORDER
   - MAYBE
   - BAD ORDER

Preferred format:

Verdict: GOOD ORDER / MAYBE / BAD ORDER

$/mile: X.XX
$/hour: X.XX (if possible)

Why:
one or two short lines

Recommendation:
Accept / Maybe / Decline
          `.trim(),
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content ?? "No response";
    res.json({ reply: text });
  } catch (error) {
    console.error("ASK ERROR:", error);
    res.status(500).json({ error: "AI request failed" });
  }
});

app.post("/radar/recommend", async (req, res) => {
  try {
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

    const cityCenter = CITY_CENTERS[city] || CITY_CENTERS["Charlotte"];
    const baseLat =
      typeof latitude === "number" ? latitude : cityCenter.lat;
    const baseLon =
      typeof longitude === "number" ? longitude : cityCenter.lon;

    const scoredZones = cityZones
      .map((zone) => {
        const miles = distanceMiles(baseLat, baseLon, zone.lat, zone.lon);
        const driveMinutes = estimateDriveMinutes(miles);

        const finalScore = Math.max(
          1,
          zone.baseScore + timeBonus(zone.type, resolvedHour) - distancePenalty(miles)
        );

        return {
          ...zone,
          distanceMiles: Number(miles.toFixed(1)),
          driveMinutes,
          finalScore,
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    const bestZone = scoredZones[0];

    const aiPrompt = `
You are GigProfit Radar AI.

User city: ${city}
Mode: ${mode}
Current hour: ${resolvedHour}

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
expected earnings: ${z.expected}
description: ${z.description}
`
  )
  .join("\n")}

Write a short driver-friendly recommendation in plain English.

Format exactly like this:

Best move now: <zone>

Why:
<1-2 short lines>

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
            "You are a concise radar copilot for gig drivers. Be direct and practical.",
        },
        {
          role: "user",
          content: aiPrompt,
        },
      ],
    });

    const explanation =
      aiResponse.choices?.[0]?.message?.content ?? "No recommendation generated.";

    res.json({
      city,
      mode,
      hour: resolvedHour,
      bestZone,
      zones: scoredZones,
      explanation,
    });
  } catch (error) {
    console.error("RADAR ERROR:", error);
    res.status(500).json({ error: "Radar recommendation failed" });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GigProfit backend listening on port ${PORT}`);
});