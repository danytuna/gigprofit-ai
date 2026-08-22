import express from "express";

function cleanString(value, maxLength = 300) {
  return String(value || "").trim().slice(0, maxLength);
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

export function createDriverMapRouter({
  apiKey,
  fetchImpl = globalThis.fetch,
  logger = console,
  requestTimeoutMs = 8_000,
}) {
  const router = express.Router();

  async function googleRequest(res, pathname, parameters) {
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: "Google Maps server APIs are not configured.",
      });
    }

    const search = new URLSearchParams({
      ...parameters,
      key: apiKey,
    });

    try {
      const response = await fetchImpl(
        `https://maps.googleapis.com${pathname}?${search}`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(requestTimeoutMs),
        }
      );
      const payload = await response.json().catch(() => ({}));

      const googleStatus = String(payload?.status || "").trim().toUpperCase();
      if (
        !response.ok
        || (googleStatus && !["OK", "ZERO_RESULTS"].includes(googleStatus))
      ) {
        return res.status(502).json({
          ok: false,
          error: "Google Maps is temporarily unavailable.",
        });
      }

      return res.json(payload);
    } catch (error) {
      logger.error("Driver Maps proxy failed", {
        path: pathname,
        message: error?.name === "TimeoutError"
          ? "upstream timeout"
          : error?.message || String(error),
      });
      return res.status(502).json({
        ok: false,
        error: "Google Maps is temporarily unavailable.",
      });
    }
  }

  router.get("/autocomplete", (req, res) => {
    const input = cleanString(req.query.input, 180);
    if (input.length < 3) {
      return res.status(400).json({ ok: false, error: "Search input is too short." });
    }

    const latitude = finiteCoordinate(req.query.latitude, -90, 90);
    const longitude = finiteCoordinate(req.query.longitude, -180, 180);
    return googleRequest(res, "/maps/api/place/autocomplete/json", {
      input,
      components: "country:us",
      ...(latitude !== null && longitude !== null
        ? { location: `${latitude},${longitude}`, radius: "50000" }
        : {}),
      ...(cleanString(req.query.sessionToken, 120)
        ? { sessiontoken: cleanString(req.query.sessionToken, 120) }
        : {}),
    });
  });

  router.get("/place-details", (req, res) => {
    const placeId = cleanString(req.query.placeId, 240);
    if (!placeId) {
      return res.status(400).json({ ok: false, error: "Missing place ID." });
    }

    return googleRequest(res, "/maps/api/place/details/json", {
      place_id: placeId,
      fields: "geometry,formatted_address,name",
      ...(cleanString(req.query.sessionToken, 120)
        ? { sessiontoken: cleanString(req.query.sessionToken, 120) }
        : {}),
    });
  });

  router.get("/geocode", (req, res) => {
    const address = cleanString(req.query.address, 240);
    if (!address) {
      return res.status(400).json({ ok: false, error: "Missing address." });
    }
    return googleRequest(res, "/maps/api/geocode/json", { address });
  });

  router.post("/directions", (req, res) => {
    const originLatitude = finiteCoordinate(req.body?.origin?.latitude, -90, 90);
    const originLongitude = finiteCoordinate(req.body?.origin?.longitude, -180, 180);
    const destinationLatitude =
      finiteCoordinate(req.body?.destination?.latitude, -90, 90);
    const destinationLongitude =
      finiteCoordinate(req.body?.destination?.longitude, -180, 180);

    if (
      originLatitude === null
      || originLongitude === null
      || destinationLatitude === null
      || destinationLongitude === null
    ) {
      return res.status(400).json({
        ok: false,
        error: "Directions require valid origin and destination coordinates.",
      });
    }

    return googleRequest(res, "/maps/api/directions/json", {
      origin: `${originLatitude},${originLongitude}`,
      destination: `${destinationLatitude},${destinationLongitude}`,
      mode: "driving",
      alternatives: "false",
      departure_time: "now",
      traffic_model: "best_guess",
    });
  });

  return router;
}
