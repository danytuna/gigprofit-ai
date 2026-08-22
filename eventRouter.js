import express from "express";
import {
  interpretTrustedEventRange,
  resolveTrustedTimeContext,
} from "./trustedTime.js";

const MAX_RADIUS_MILES = 100;
const MAX_RESULTS = 50;
const timeZoneCache = new Map();

function validTimeZone(value) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}

async function resolveEventTimeZone({ latitude, longitude, requestedTimeZone, apiKey, fetchImpl, logger }) {
  const fallback = validTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !process.env.GOOGLE_MAPS_API_KEY) return fallback;
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const cached = timeZoneCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.timezone;
  try {
    const params = new URLSearchParams({ location: `${latitude},${longitude}`, timestamp: String(Math.floor(Date.now()/1000)), key: process.env.GOOGLE_MAPS_API_KEY });
    const response = await fetchImpl(`https://maps.googleapis.com/maps/api/timezone/json?${params}`, { signal: AbortSignal.timeout(8_000) });
    const payload = await response.json();
    if (!response.ok || payload?.status !== "OK" || !validTimeZone(payload?.timeZoneId)) throw new Error(payload?.status || `HTTP_${response.status}`);
    timeZoneCache.set(key, { timezone: payload.timeZoneId, expiresAt: Date.now() + 86_400_000 });
    return payload.timeZoneId;
  } catch (error) {
    logger.warn?.("EVENT_TIMEZONE_LOOKUP_FAILED", { code: error?.message || "Error" });
    return fallback;
  }
}

function localDateParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(date).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
}

function dateOnlyUTC(parts, addDays = 0) {
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day)+addDays));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function text(value, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function number(value, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : null;
}

export function createEventRouter({ apiKey, fetchImpl = fetch, logger = console, now = () => new Date() }) {
  const router = express.Router();

  router.get("/search", async (req, res) => {
    if (!apiKey) {
      logger.error("TICKETMASTER_CONFIGURATION_MISSING");
      return res.status(503).json({ code: "EVENTS_UNAVAILABLE", error: "Events are temporarily unavailable." });
    }

    const latitude = number(req.query.latitude, -90, 90);
    const longitude = number(req.query.longitude, -180, 180);
    const radius = number(req.query.radius ?? 20, 1, MAX_RADIUS_MILES);
    const size = number(req.query.size ?? 25, 1, MAX_RESULTS);
    const city = text(req.query.city, 80);
    if ((latitude === null || longitude === null) && !city) {
      return res.status(400).json({ code: "INVALID_LOCATION", error: "A city or coordinates are required." });
    }

    const daysAhead = Math.max(1, Math.min(14, Number(req.query.daysAhead || 1)));
    const requestedTimeZone = text(req.query.timezone ?? req.query.timezoneIdentifier, 80);
    const trustedTime = await resolveTrustedTimeContext({
      latitude,
      longitude,
      timezoneIdentifier: requestedTimeZone,
      apiKey: process.env.GOOGLE_MAPS_API_KEY || "",
      fetchImpl,
      logger,
      now,
    });
    const requestedPeriod = text(req.query.period, 20).toLowerCase();
    const period = requestedPeriod || (daysAhead > 1 ? "upcoming" : "today");
    const eventRange = interpretTrustedEventRange(trustedTime, { period, daysAhead });

    const params = new URLSearchParams({ apikey: apiKey, size: String(size), sort: "date,asc" });
    if (latitude !== null && longitude !== null) {
      params.set("latlong", `${latitude},${longitude}`);
      params.set("radius", String(radius));
      params.set("unit", "miles");
    } else {
      params.set("city", city);
    }
    const aliases = {
      keyword: req.query.keyword,
      classificationName: req.query.classificationName ?? req.query.category,
      // Relative ranges are always computed from Railway's trusted clock.
      // Client start/end values are intentionally ignored as temporal authority.
      startDateTime: eventRange.startDateTime,
      endDateTime: eventRange.endDateTime,
    };
    for (const key of ["keyword", "classificationName", "startDateTime", "endDateTime"]) {
      const value = text(aliases[key], key.includes("DateTime") ? 40 : 100);
      if (value) params.set(key, value);
    }

    try {
      const response = await fetchImpl(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = await response.json();
      const events = (payload?._embedded?.events || []).map((event) => {
        const venue = event?._embedded?.venues?.[0] || {};
        return {
          id: text(event?.id, 120), title: text(event?.name, 200),
          date: event?.dates?.start?.dateTime || event?.dates?.start?.localDate || null,
          localDate: event?.dates?.start?.localDate || null,
          localTime: event?.dates?.start?.localTime || null,
          venue: text(venue?.name, 200) || null,
          address: text(venue?.address?.line1, 240) || null,
          city: text(venue?.city?.name, 100) || null,
          state: text(venue?.state?.stateCode || venue?.state?.name, 80) || null,
          latitude: number(venue?.location?.latitude, -90, 90),
          longitude: number(venue?.location?.longitude, -180, 180),
          category: text(event?.classifications?.[0]?.segment?.name, 80) || "general",
          distanceMiles: number(event?.distance, 0, MAX_RADIUS_MILES),
          source: "ticketmaster",
          externalURL: text(event?.url, 500) || null,
          imageURL: text(event?.images?.[0]?.url, 500) || null,
        };
      }).filter((event) => event.id && event.title);
      return res.json({
        provider: "ticketmaster",
        fetchedAt: trustedTime.trustedNowUTC,
        trustedTime,
        ...(req.query.debug === "1" && process.env.NODE_ENV !== "production"
          ? { debug: eventRange }
          : {}),
        events,
      });
    } catch (error) {
      logger.error("TICKETMASTER_SEARCH_FAILED", {
        code: error?.message || error?.name || "Error",
        status: error?.status || null,
      });
      return res.status(502).json({ code: "EVENTS_PROVIDER_ERROR", error: "Events could not be loaded right now." });
    }
  });

  return router;
}
