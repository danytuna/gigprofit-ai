const timeZoneCache = new Map();

export function isValidTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function partsFor(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function offsetSeconds(date, timeZone) {
  const parts = partsFor(date, timeZone);
  const localAsUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((localAsUTC - date.getTime()) / 1000);
}

export function buildTrustedTimeContext({
  trustedNowUTC = new Date(),
  timezoneIdentifier = "UTC",
  source = "Railway + UTC",
} = {}) {
  const instant = trustedNowUTC instanceof Date ? trustedNowUTC : new Date(trustedNowUTC);
  if (Number.isNaN(instant.getTime())) throw new TypeError("trustedNowUTC must be a valid date");
  const timezone = isValidTimeZone(timezoneIdentifier) ? timezoneIdentifier : "UTC";
  const parts = partsFor(instant, timezone);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}:${parts.second}`;
  const utcOffset = offsetSeconds(instant, timezone);

  return Object.freeze({
    trustedNowUTC: instant.toISOString(),
    timezoneIdentifier: timezone,
    localDateTime: `${localDate}T${localTime}`,
    localDate,
    localTime,
    dayOfWeek: parts.weekday,
    utcOffset,
    source,
    // Compatibility aliases for existing iOS/backend consumers.
    iso8601: instant.toISOString(),
    timezone,
    weekday: parts.weekday,
    utcOffsetSeconds: utcOffset,
  });
}

export async function resolveTrustedTimeContext({
  latitude,
  longitude,
  timezoneIdentifier,
  apiKey = "",
  fetchImpl = fetch,
  logger = console,
  now = () => new Date(),
} = {}) {
  const trustedNowUTC = now();
  const validHint = isValidTimeZone(timezoneIdentifier) ? timezoneIdentifier : "UTC";
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);

  if (hasCoordinates && apiKey) {
    const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
    const cached = timeZoneCache.get(cacheKey);
    if (cached && cached.expiresAt > trustedNowUTC.getTime()) {
      return buildTrustedTimeContext({
        trustedNowUTC,
        timezoneIdentifier: cached.timezone,
        source: "Railway + validated location",
      });
    }

    try {
      const params = new URLSearchParams({
        location: `${latitude},${longitude}`,
        timestamp: String(Math.floor(trustedNowUTC.getTime() / 1000)),
        key: apiKey,
      });
      const response = await fetchImpl(`https://maps.googleapis.com/maps/api/timezone/json?${params}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = await response.json();
      if (payload?.status !== "OK" || !isValidTimeZone(payload?.timeZoneId)) {
        throw new Error(payload?.status || "INVALID_TIMEZONE_RESPONSE");
      }
      timeZoneCache.set(cacheKey, {
        timezone: payload.timeZoneId,
        expiresAt: trustedNowUTC.getTime() + 86_400_000,
      });
      return buildTrustedTimeContext({
        trustedNowUTC,
        timezoneIdentifier: payload.timeZoneId,
        source: "Railway + validated location",
      });
    } catch (error) {
      logger.warn?.("TRUSTED_TIMEZONE_LOOKUP_FAILED", { code: error?.message || "Error" });
    }
  }

  return buildTrustedTimeContext({
    trustedNowUTC,
    timezoneIdentifier: validHint,
    source: validHint === "UTC" ? "Railway + UTC" : "Railway + validated timezone",
  });
}

function addLocalDays(localDate, days) {
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function localDateTimeToUTC(localDateTime, timeZone) {
  const [datePart, timePart] = localDateTime.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  const localAsUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = new Date(localAsUTC);
  candidate = new Date(localAsUTC - offsetSeconds(candidate, timeZone) * 1000);
  candidate = new Date(localAsUTC - offsetSeconds(candidate, timeZone) * 1000);
  return candidate.toISOString().replace(".000Z", "Z");
}

export function interpretTrustedEventRange(context, { period = "today", daysAhead = 1 } = {}) {
  const normalized = String(period || "today").trim().toLowerCase();
  let startOffset = 0;
  let endOffset = Math.max(1, Math.min(14, Number(daysAhead) || 1));
  let startTime = "00:00:00";

  if (normalized === "tomorrow") {
    startOffset = 1;
    endOffset = 2;
  } else if (normalized === "tonight") {
    startTime = context.localTime > "17:00:00" ? context.localTime : "17:00:00";
    endOffset = 1;
  } else if (normalized === "weekend") {
    const weekdayIndex = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(context.dayOfWeek);
    startOffset = weekdayIndex === 0 ? 0 : Math.max(0, 6 - weekdayIndex);
    endOffset = startOffset + (weekdayIndex === 0 ? 1 : 2);
  } else if (normalized === "upcoming") {
    endOffset = Math.max(1, Math.min(14, Number(daysAhead) || 7));
  } else {
    endOffset = 1;
  }

  const startDate = addLocalDays(context.localDate, startOffset);
  const endDate = addLocalDays(context.localDate, endOffset);
  const startLocalDateTime = `${startDate}T${startTime}`;
  const endLocalDateTime = `${endDate}T00:00:00`;
  return {
    interpretedRange: normalized,
    startDateTime: localDateTimeToUTC(startLocalDateTime, context.timezoneIdentifier),
    endDateTime: localDateTimeToUTC(endLocalDateTime, context.timezoneIdentifier),
    startLocalDateTime,
    endLocalDateTime,
    timezone: context.timezoneIdentifier,
    trustedLocalDate: context.localDate,
  };
}
