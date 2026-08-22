export const DEFAULT_RADAR_RADIUS_MILES = 15;

const STRUCTURAL_TYPES = [
  "airport",
  "university",
  "shopping_mall",
  "train_station",
  "transit_station",
  "hospital",
];

const ACTIVITY_TYPES = [
  "restaurant",
  "bar",
  "night_club",
  "movie_theater",
  "tourist_attraction",
  "convention_center",
  "stadium",
  "grocery_store",
];

const SIGNAL_WEIGHTS = Object.freeze({
  airport: 7,
  university: 5,
  shopping_mall: 4,
  train_station: 4,
  transit_station: 3,
  hospital: 2,
  restaurant: 1.3,
  bar: 2,
  night_club: 3,
  movie_theater: 1.5,
  tourist_attraction: 1.5,
  convention_center: 2,
  stadium: 2,
  grocery_store: 1,
});

const DISTRICT_CONFIG = Object.freeze({
  airport: { baseScore: 67, expected: "$19-$31/hr", radiusMiles: 4.5 },
  university: { baseScore: 59, expected: "$16-$27/hr", radiusMiles: 3.0 },
  downtown: { baseScore: 64, expected: "$18-$30/hr", radiusMiles: 3.0 },
  nightlife: { baseScore: 62, expected: "$18-$30/hr", radiusMiles: 2.3 },
  shopping: { baseScore: 56, expected: "$16-$25/hr", radiusMiles: 2.5 },
  transit: { baseScore: 57, expected: "$17-$27/hr", radiusMiles: 2.5 },
  medical: { baseScore: 51, expected: "$15-$23/hr", radiusMiles: 2.0 },
  commercial: { baseScore: 54, expected: "$16-$25/hr", radiusMiles: 2.5 },
  neighborhood: { baseScore: 49, expected: "$15-$23/hr", radiusMiles: 2.2 },
  locality: { baseScore: 47, expected: "$15-$22/hr", radiusMiles: 3.5 },
});

const geocodeCache = new Map();
const discoveryCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const GEOCODE_CACHE_TTL_MS = 30 * 60 * 1000;
const RADAR_DISCOVERY_CACHE_VERSION = 4;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeRadiusMiles(value) {
  const parsed = Number(value);
  return clamp(Number.isFinite(parsed) ? parsed : DEFAULT_RADAR_RADIUS_MILES, 5, DEFAULT_RADAR_RADIUS_MILES);
}

export function isValidCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 &&
    !(latitude === 0 && longitude === 0);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function canonicalName(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isGenericAreaName(name, city) {
  const value = canonicalName(name);
  const cityValue = canonicalName(city);
  if (!value) return true;
  return [
    "united states",
    "usa",
    "current area",
    "nearby area",
  ].includes(value) || value === cityValue;
}

export function destinationPoint(latitude, longitude, distanceMiles, bearingDegrees) {
  const earthRadiusMiles = 3958.7613;
  const angularDistance = distanceMiles / earthRadiusMiles;
  const bearing = bearingDegrees * Math.PI / 180;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    latitude: lat2 * 180 / Math.PI,
    longitude: ((lon2 * 180 / Math.PI + 540) % 360) - 180,
  };
}

export function buildRadialSamplePoints(latitude, longitude, radiusMiles = DEFAULT_RADAR_RADIUS_MILES) {
  const radius = normalizeRadiusMiles(radiusMiles);
  const points = [{ latitude, longitude, source: "driver-location" }];

  // A coarse four-point grid often resolves every sample to the parent city
  // (for example, Charlotte) and misses neighborhoods such as South End,
  // NoDa, University City, or nearby small towns. Use staggered rings that
  // cover the urban core, inner neighborhoods, and the full 15-mile radius.
  const ringDefinitions = [
    { miles: Math.min(1.75, radius * 0.14), bearings: [0, 60, 120, 180, 240, 300] },
    { miles: Math.min(4.25, radius * 0.32), bearings: [30, 90, 150, 210, 270, 330] },
    { miles: Math.min(8.5, radius * 0.62), bearings: [0, 60, 120, 180, 240, 300] },
    { miles: Math.min(13.5, radius * 0.90), bearings: [30, 90, 150, 210, 270, 330] },
  ];

  for (const definition of ringDefinitions) {
    if (definition.miles < 0.75) continue;
    for (const bearing of definition.bearings) {
      points.push({
        ...destinationPoint(latitude, longitude, definition.miles, bearing),
        source: "radial-sample",
      });
    }
  }

  return points;
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusMiles = 3958.7613;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function primarySignalType(place) {
  const candidates = [place?.primaryType, ...(place?.types || [])].filter(Boolean);
  return candidates.find((type) => SIGNAL_WEIGHTS[type]) || null;
}

export function normalizeActivitySignal(place) {
  const signalType = primarySignalType(place);
  const latitude = Number(place?.location?.latitude);
  const longitude = Number(place?.location?.longitude);
  if (!signalType || !isValidCoordinate(latitude, longitude)) return null;

  const areaCandidates = place?.addressDescriptor?.areas || [];
  const areaName = areaCandidates
    .map((area) => cleanText(area?.displayName?.text))
    .find(Boolean) || null;

  return {
    id: place?.id || null,
    displayName: cleanText(place?.displayName?.text),
    signalType,
    types: Array.isArray(place?.types) ? place.types : [],
    weight: SIGNAL_WEIGHTS[signalType] || 1,
    latitude,
    longitude,
    areaName,
  };
}

async function placesNearbyRequest({ latitude, longitude, radiusMeters, types, apiKey, fetchImpl }) {
  const response = await fetchImpl("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.primaryType,places.types,places.addressDescriptor,places.businessStatus",
    },
    body: JSON.stringify({
      includedTypes: types,
      maxResultCount: 20,
      rankPreference: "POPULARITY",
      locationRestriction: {
        circle: {
          center: { latitude, longitude },
          radius: radiusMeters,
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Google Places request failed: ${response.status}`);
  const payload = await response.json();
  return (payload?.places || []).map(normalizeActivitySignal).filter(Boolean);
}

async function discoverActivitySignals({ latitude, longitude, radiusMiles, apiKey, fetchImpl, logger }) {
  if (!apiKey) return [];
  const radiusMeters = normalizeRadiusMiles(radiusMiles) * 1609.344;
  try {
    const [structural, activity] = await Promise.all([
      placesNearbyRequest({ latitude, longitude, radiusMeters, types: STRUCTURAL_TYPES, apiKey, fetchImpl }),
      placesNearbyRequest({ latitude, longitude, radiusMeters, types: ACTIVITY_TYPES, apiKey, fetchImpl }),
    ]);
    const seen = new Set();
    return [...structural, ...activity].filter((signal) => {
      const key = signal.id || `${signal.signalType}|${signal.latitude.toFixed(4)}|${signal.longitude.toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (error) {
    logger.warn?.("RADAR PLACES ERROR:", error?.message || String(error));
    return [];
  }
}

function geocodeCacheKey(latitude, longitude) {
  return `${latitude.toFixed(3)}|${longitude.toFixed(3)}`;
}

function readFreshCache(cache, key, ttl) {
  const item = cache.get(key);
  if (!item || Date.now() - item.createdAt > ttl) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function addressComponent(result, acceptedTypes) {
  for (const component of result?.address_components || []) {
    if ((component?.types || []).some((type) => acceptedTypes.includes(type))) {
      return cleanText(component.long_name);
    }
  }
  return null;
}

export function extractGeocodeContext(payload) {
  const results = payload?.results || [];
  let neighborhood = null;
  let sublocality = null;
  let locality = null;
  let state = null;

  for (const result of results) {
    neighborhood = neighborhood || addressComponent(result, ["neighborhood"]);
    sublocality = sublocality || addressComponent(result, [
      "sublocality_level_1",
      "sublocality_level_2",
      "sublocality_level_3",
      "sublocality",
    ]);
    locality = locality || addressComponent(result, ["locality", "postal_town"]);
    state = state || addressComponent(result, ["administrative_area_level_1"]);
  }

  return {
    neighborhood: cleanText(neighborhood),
    sublocality: cleanText(sublocality),
    locality: cleanText(locality),
    state: cleanText(state),
  };
}

function normalizedAreaDisplayName(name, parentLocality = "") {
  const cleanName = cleanText(name);
  const locality = canonicalName(parentLocality);
  const canonical = canonicalName(cleanName);

  // Google commonly calls Uptown Charlotte "Charlotte Center City".
  // Keep this presentation alias narrow so other cities retain Google's real name.
  if (locality === "charlotte" && ["charlotte center city", "center city"].includes(canonical)) {
    return "Uptown";
  }

  return cleanName;
}

export function extractAreaFromGeocodePayload(payload, requestedCity = "") {
  const context = extractGeocodeContext(payload);
  const requested = canonicalName(requestedCity);
  const localityKey = canonicalName(context.locality);

  const neighborhoodName = normalizedAreaDisplayName(context.neighborhood, context.locality);
  const sublocalityName = normalizedAreaDisplayName(context.sublocality, context.locality);
  const localityName = normalizedAreaDisplayName(context.locality, context.locality);

  if (neighborhoodName && canonicalName(neighborhoodName) !== requested && canonicalName(neighborhoodName) !== localityKey) {
    return { name: neighborhoodName, level: "neighborhood", locality: context.locality, state: context.state };
  }

  if (sublocalityName && canonicalName(sublocalityName) !== requested && canonicalName(sublocalityName) !== localityKey) {
    return { name: sublocalityName, level: "sublocality", locality: context.locality, state: context.state };
  }

  // A locality is useful only when it is a nearby town/suburb different from
  // the driver's primary city. Never turn the parent city itself into a zone.
  if (localityName && requested && canonicalName(localityName) !== requested) {
    return { name: localityName, level: "locality", locality: context.locality, state: context.state };
  }

  return null;
}

async function reverseGeocodeContext({ latitude, longitude, city, apiKey, fetchImpl, logger }) {
  if (!apiKey || !isValidCoordinate(latitude, longitude)) return { area: null, locality: null, state: null };
  const key = `${geocodeCacheKey(latitude, longitude)}|${canonicalName(city)}`;
  const cached = readFreshCache(geocodeCache, key, GEOCODE_CACHE_TTL_MS);
  if (cached !== null) return cached;

  try {
    const params = new URLSearchParams({
      latlng: `${latitude},${longitude}`,
      key: apiKey,
    });
    const response = await fetchImpl(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    if (!response.ok) throw new Error(`Google Geocoding request failed: ${response.status}`);
    const payload = await response.json();
    const context = extractGeocodeContext(payload);
    const value = {
      area: extractAreaFromGeocodePayload(payload, city),
      locality: context.locality || null,
      state: context.state || null,
    };
    geocodeCache.set(key, { createdAt: Date.now(), value });
    return value;
  } catch (error) {
    logger.warn?.("RADAR GEOCODING ERROR:", error?.message || String(error));
    const value = { area: null, locality: null, state: null };
    geocodeCache.set(key, { createdAt: Date.now(), value });
    return value;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

function districtTypeFor({ name, level, signals }) {
  const lower = canonicalName(name);
  const counts = signals.reduce((result, signal) => {
    result[signal.signalType] = (result[signal.signalType] || 0) + 1;
    return result;
  }, {});
  const restaurants = (counts.restaurant || 0) + (counts.bar || 0) + (counts.night_club || 0);
  const retail = (counts.shopping_mall || 0) + (counts.grocery_store || 0);
  const transit = (counts.train_station || 0) + (counts.transit_station || 0);

  // Structural signals must not relabel a nearby neighborhood. A neighborhood
  // can sit beside an airport or campus without being the airport/campus zone.
  // Only explicit structural district anchors may receive those types.
  if (lower.includes("airport") || (level === "district" && (counts.airport || 0) > 0)) return "airport";
  if (/university|college|campus/.test(lower) || (level === "district" && (counts.university || 0) > 0)) return "university";
  if (/downtown|uptown|center city|city center|financial district|central business/.test(lower)) return "downtown";
  if ((counts.night_club || 0) >= 1 || (counts.bar || 0) >= 2 || restaurants >= 5) return "nightlife";
  if ((counts.shopping_mall || 0) >= 1 || retail >= 3) return "shopping";
  if (transit >= 2) return "transit";
  if ((counts.hospital || 0) >= 1) return "medical";
  if (restaurants + retail + transit >= 4) return "commercial";
  return level === "locality" ? "locality" : "neighborhood";
}

function signalSummary(signals) {
  const counts = {};
  for (const signal of signals) counts[signal.signalType] = (counts[signal.signalType] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([type, count]) => `${type}:${count}`);
}

function buildDistrictZone(cluster, city) {
  const signalWeight = cluster.signals.reduce((sum, signal) => sum + Number(signal.weight || 0), 0);
  const latitude = Number.isFinite(cluster.fixedLatitude)
    ? cluster.fixedLatitude
    : cluster.latitudeTotal / cluster.pointCount;
  const longitude = Number.isFinite(cluster.fixedLongitude)
    ? cluster.fixedLongitude
    : cluster.longitudeTotal / cluster.pointCount;
  const type = districtTypeFor({ name: cluster.name, level: cluster.level, signals: cluster.signals });
  const config = DISTRICT_CONFIG[type] || DISTRICT_CONFIG.neighborhood;
  const activityEvidence = clamp(Math.round(signalWeight / 3), 0, 10);
  const baseScore = clamp(config.baseScore + Math.min(activityEvidence, 7), 35, 76);
  const confidence = cluster.signals.length >= 5 ? "high" : cluster.signals.length >= 2 || cluster.sources.size >= 2 ? "medium" : "low";

  return {
    city: city || cluster.locality || "Current Area",
    name: cluster.name,
    type,
    lat: latitude,
    lon: longitude,
    baseScore,
    expected: config.expected,
    description: `${cluster.name} is evaluated as a ${type} district using nearby activity density and verified area boundaries.`,
    zoneRadiusMiles: config.radiusMiles,
    zoneConfidence: confidence,
    activityEvidence,
    activitySignals: signalSummary(cluster.signals),
    zoneSource: Array.from(cluster.sources).sort().join("+") || "area-discovery",
  };
}

function addObservation(clusters, observation, city) {
  const name = cleanText(observation?.name);
  if (!name) return;
  if (isGenericAreaName(name, city)) return;
  const key = cleanText(observation?.keyOverride) || canonicalName(name);
  if (!key) return;

  const current = clusters.get(key) || {
    name,
    level: observation.level || "neighborhood",
    locality: observation.locality || city || null,
    latitudeTotal: 0,
    longitudeTotal: 0,
    pointCount: 0,
    signals: [],
    sources: new Set(),
    fixedLatitude: Number.isFinite(observation.fixedLatitude) ? observation.fixedLatitude : null,
    fixedLongitude: Number.isFinite(observation.fixedLongitude) ? observation.fixedLongitude : null,
  };
  current.latitudeTotal += observation.latitude;
  current.longitudeTotal += observation.longitude;
  current.pointCount += 1;
  if (Number.isFinite(observation.fixedLatitude) && Number.isFinite(observation.fixedLongitude)) {
    current.fixedLatitude = observation.fixedLatitude;
    current.fixedLongitude = observation.fixedLongitude;
  }
  current.signals.push(...(observation.signals || []));
  current.sources.add(observation.source || "unknown");
  clusters.set(key, current);
}


function isLikelyPassengerAirport(signal) {
  if (signal?.signalType !== "airport") return false;
  const name = canonicalName(signal.displayName);
  if (!name) return false;
  if (/heliport|helipad|flight school|aviation school|air ambulance/.test(name)) return false;
  return /airport|international|regional|municipal|airfield|airpark/.test(name);
}

function selectStructuralAnchors(signals, latitude, longitude) {
  const anchors = [];
  const airports = signals
    .filter(isLikelyPassengerAirport)
    .map((signal) => ({
      signal,
      distance: distanceMiles(latitude, longitude, signal.latitude, signal.longitude),
      majorRank: /international/.test(canonicalName(signal.displayName)) ? 0 :
        /regional|municipal/.test(canonicalName(signal.displayName)) ? 1 : 2,
    }))
    .sort((a, b) => a.majorRank - b.majorRank || a.distance - b.distance);

  // One canonical airport district prevents multiple airports/heliports from
  // being averaged into a pin that does not match any real airport.
  if (airports[0]) anchors.push({ ...airports[0].signal, anchorName: "Airport Area", anchorKey: "structural-airport-primary" });

  for (const signal of signals) {
    if (signal.signalType === "airport") continue;
    const anchorName = genericAnchorName(signal);
    if (!anchorName) continue;
    const anchorKey = `structural-${signal.signalType}-${signal.id || `${signal.latitude.toFixed(4)}-${signal.longitude.toFixed(4)}`}`;
    anchors.push({ ...signal, anchorName, anchorKey });
  }
  return anchors;
}
function genericAnchorName(signal) {
  if (signal.signalType === "airport") return "Airport Area";
  if (signal.signalType === "university") return "University Area";
  if (signal.signalType === "shopping_mall") return "Shopping District";
  if (["train_station", "transit_station"].includes(signal.signalType)) return "Transit District";
  if (signal.signalType === "hospital") return "Medical District";
  return null;
}

export async function discoverNationwideZones({
  city,
  latitude,
  longitude,
  radiusMiles = DEFAULT_RADAR_RADIUS_MILES,
  apiKey,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  if (!isValidCoordinate(latitude, longitude)) return [];
  const radius = normalizeRadiusMiles(radiusMiles);
  const cacheKey = `${RADAR_DISCOVERY_CACHE_VERSION}|${latitude.toFixed(3)}|${longitude.toFixed(3)}|${radius}`;
  const cached = readFreshCache(discoveryCache, cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const signals = await discoverActivitySignals({ latitude, longitude, radiusMiles: radius, apiKey, fetchImpl, logger });
  const clusters = new Map();

  // Resolve the driver's real parent city first. iOS may send "Current Area";
  // without this step Google can return the parent locality (for example
  // Charlotte) as though it were a neighborhood and attach it to a sampled pin.
  const centerContext = await reverseGeocodeContext({
    latitude,
    longitude,
    city: "",
    apiKey,
    fetchImpl,
    logger,
  });
  const resolvedCity = cleanText(centerContext.locality) || cleanText(city) || "Current Area";

  // Prefer neighborhood/district names already attached to Google Places results.
  for (const signal of signals) {
    const areaName = signal.areaName;
    if (areaName && !isGenericAreaName(areaName, resolvedCity)) {
      addObservation(clusters, {
        name: areaName,
        level: "neighborhood",
        locality: resolvedCity,
        latitude: signal.latitude,
        longitude: signal.longitude,
        signals: [signal],
        source: "google-area-descriptor",
      }, resolvedCity);
    }
  }

  // Reverse-geocode a compact radial grid so nearby named neighborhoods and small towns
  // can be found without turning individual businesses or venues into radar zones.
  const samplePoints = buildRadialSamplePoints(latitude, longitude, radius);
  const fallbackAnchors = signals
    // Airport Area already has a canonical verified anchor below. Do not add a
    // second reverse-geocoded airport fallback that can duplicate or move it.
    .filter((signal) => !signal.areaName && ["university", "shopping_mall", "train_station"].includes(signal.signalType))
    .slice(0, 6)
    .map((signal) => ({ latitude: signal.latitude, longitude: signal.longitude, source: "activity-anchor", signal }));

  const geocodeTargets = [...samplePoints, ...fallbackAnchors];
  const geocoded = await mapWithConcurrency(geocodeTargets, 4, async (target) => {
    const context = await reverseGeocodeContext({
      latitude: target.latitude,
      longitude: target.longitude,
      city: resolvedCity,
      apiKey,
      fetchImpl,
      logger,
    });
    return { target, area: context.area };
  });

  // Structural places are broad districts, never venue/business names. Airport
  // anchors are resolved to one real passenger airport and keep its exact
  // coordinates; they are never averaged with heliports or other airports.
  for (const signal of selectStructuralAnchors(signals, latitude, longitude)) {
    addObservation(clusters, {
      name: signal.anchorName,
      keyOverride: signal.anchorKey,
      level: "district",
      locality: resolvedCity,
      latitude: signal.latitude,
      longitude: signal.longitude,
      fixedLatitude: signal.latitude,
      fixedLongitude: signal.longitude,
      signals: [signal],
      source: "structural-area-verified",
    }, resolvedCity);
  }

  for (const { target, area } of geocoded) {
    if (area?.name) {
      const nearbySignals = signals.filter((signal) =>
        !STRUCTURAL_TYPES.includes(signal.signalType) &&
        distanceMiles(target.latitude, target.longitude, signal.latitude, signal.longitude) <= 2.75
      );
      addObservation(clusters, {
        name: area.name,
        level: area.level,
        locality: area.locality,
        latitude: target.latitude,
        longitude: target.longitude,
        signals: target.signal ? [target.signal, ...nearbySignals] : nearbySignals,
        source: "reverse-geocoding",
      }, resolvedCity);
    } else if (target.signal) {
      const genericName = genericAnchorName(target.signal);
      if (genericName) {
        addObservation(clusters, {
          name: genericName,
          level: "district",
          locality: resolvedCity,
          latitude: target.latitude,
          longitude: target.longitude,
          signals: [target.signal],
          source: "activity-anchor",
        }, resolvedCity);
      }
    }
  }

  // Assign every remaining activity signal to its nearest discovered neighborhood.
  for (const signal of signals) {
    if (STRUCTURAL_TYPES.includes(signal.signalType)) continue;
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const cluster of clusters.values()) {
      const clusterLat = cluster.latitudeTotal / cluster.pointCount;
      const clusterLon = cluster.longitudeTotal / cluster.pointCount;
      const miles = distanceMiles(signal.latitude, signal.longitude, clusterLat, clusterLon);
      if (miles < nearestDistance) {
        nearest = cluster;
        nearestDistance = miles;
      }
    }
    if (nearest && nearestDistance <= 3.5 && !nearest.signals.some((item) => item.id && item.id === signal.id)) {
      nearest.signals.push(signal);
    }
  }

  let zones = Array.from(clusters.values())
    .map((cluster) => buildDistrictZone(cluster, resolvedCity))
    .filter((zone) => distanceMiles(latitude, longitude, zone.lat, zone.lon) <= radius + 0.75)
    .sort((a, b) => {
      if (b.activityEvidence !== a.activityEvidence) return b.activityEvidence - a.activityEvidence;
      return distanceMiles(latitude, longitude, a.lat, a.lon) - distanceMiles(latitude, longitude, b.lat, b.lon);
    });

  // Keep distinct named districts. A venue/business name never enters this list.
  const seen = new Set();
  zones = zones.filter((zone) => {
    const key = canonicalName(zone.name);
    const parentCityKey = canonicalName(resolvedCity);
    if (!key || key === parentCityKey || isGenericAreaName(zone.name, resolvedCity) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);

  if (!zones.length) {
    const sectorDefinitions = [
      { name: "Central Area", miles: 0, bearing: 0 },
      { name: "North Area", miles: Math.min(6, radius * 0.45), bearing: 0 },
      { name: "East Area", miles: Math.min(6, radius * 0.45), bearing: 90 },
      { name: "South Area", miles: Math.min(6, radius * 0.45), bearing: 180 },
      { name: "West Area", miles: Math.min(6, radius * 0.45), bearing: 270 },
    ];

    zones = sectorDefinitions.map((sector) => {
      const point = sector.miles > 0
        ? destinationPoint(latitude, longitude, sector.miles, sector.bearing)
        : { latitude, longitude };
      return {
        city: resolvedCity,
        name: sector.name,
        type: sector.name === "Central Area" ? "downtown" : "locality",
        lat: point.latitude,
        lon: point.longitude,
        baseScore: sector.name === "Central Area" ? DISTRICT_CONFIG.downtown.baseScore : DISTRICT_CONFIG.locality.baseScore,
        expected: sector.name === "Central Area" ? DISTRICT_CONFIG.downtown.expected : DISTRICT_CONFIG.locality.expected,
        description: "Google neighborhood names were unavailable. Radar is using a low-confidence geographic sector until live area data becomes available.",
        zoneRadiusMiles: DISTRICT_CONFIG.locality.radiusMiles,
        zoneConfidence: "low",
        activityEvidence: 0,
        activitySignals: [],
        zoneSource: "geographic-sector-fallback",
      };
    });
  }

  discoveryCache.set(cacheKey, { createdAt: Date.now(), value: zones });
  return zones;
}

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export function encodeGeohash(latitude, longitude, precision = 9) {
  let minLat = -90;
  let maxLat = 90;
  let minLon = -180;
  let maxLon = 180;
  let hash = "";
  let bits = 0;
  let value = 0;
  let evenBit = true;

  while (hash.length < precision) {
    if (evenBit) {
      const midpoint = (minLon + maxLon) / 2;
      if (longitude >= midpoint) {
        value = (value << 1) | 1;
        minLon = midpoint;
      } else {
        value <<= 1;
        maxLon = midpoint;
      }
    } else {
      const midpoint = (minLat + maxLat) / 2;
      if (latitude >= midpoint) {
        value = (value << 1) | 1;
        minLat = midpoint;
      } else {
        value <<= 1;
        maxLat = midpoint;
      }
    }
    evenBit = !evenBit;
    bits += 1;
    if (bits === 5) {
      hash += GEOHASH_BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

export async function getNationwideEvents({
  latitude,
  longitude,
  radiusMiles = DEFAULT_RADAR_RADIUS_MILES,
  trustedRange,
  apiKey,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  if (!apiKey || !isValidCoordinate(latitude, longitude)) return [];
  try {
    const params = new URLSearchParams({
      apikey: apiKey,
      geoPoint: encodeGeohash(latitude, longitude),
      radius: String(normalizeRadiusMiles(radiusMiles)),
      unit: "miles",
      size: "40",
      sort: "date,asc",
      countryCode: "US",
    });
    if (trustedRange?.startDateTime) params.set("startDateTime", trustedRange.startDateTime);
    if (trustedRange?.endDateTime) params.set("endDateTime", trustedRange.endDateTime);
    const response = await fetchImpl(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
    if (!response.ok) throw new Error(`Ticketmaster request failed: ${response.status}`);
    const data = await response.json();
    return (data?._embedded?.events || []).map((event) => {
      const venue = event?._embedded?.venues?.[0];
      return {
        name: event?.name || "Unknown Event",
        venue: venue?.name || "Unknown Venue",
        lat: venue?.location?.latitude ? Number(venue.location.latitude) : null,
        lon: venue?.location?.longitude ? Number(venue.location.longitude) : null,
        date: event?.dates?.start?.localDate || null,
        time: event?.dates?.start?.localTime || null,
      };
    });
  } catch (error) {
    logger.warn?.("TICKETMASTER RADAR ERROR:", error?.message || String(error));
    return [];
  }
}

export function genericOfflineStatePack(stateCode) {
  const code = String(stateCode || "").trim().toUpperCase();
  return {
    stateCode: /^[A-Z]{2}$/.test(code) ? code : "US",
    stateName: /^[A-Z]{2}$/.test(code) ? code : "United States",
    majorCities: [],
    airports: [],
    hotspots: [],
    source: "location-required",
    message: "Open Radar with location access to discover named neighborhoods and districts within 15 miles anywhere in the United States.",
    generatedAt: new Date().toISOString(),
  };
}
