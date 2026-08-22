const STATE_VERSION = 1;
const TEMPORAL_ENTITY_TTL_MS = 36 * 60 * 60 * 1000;

function text(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalized(value) {
  return text(value, 1200)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function cleanRecord(value, maxEntries = 30) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, maxEntries).map(([key, item]) => [
    text(key, 80),
    typeof item === "number" || typeof item === "boolean" || item === null
      ? item
      : text(item, 500),
  ]).filter(([key]) => key));
}

function cleanList(value, maxItems = 20) {
  return Array.isArray(value)
    ? value.map((item) => typeof item === "object" ? cleanRecord(item) : text(item, 300)).filter(Boolean).slice(0, maxItems)
    : [];
}

function cleanToolResults(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-8).map((item) => ({
    tool: text(item?.tool, 80),
    timestamp: text(item?.timestamp, 60),
    results: cleanRecord(item?.results, 20),
  })).filter((item) => item.tool);
}

export function createDefaultConversationState(now = () => new Date()) {
  return {
    activeTopic: "general",
    activeGoal: "answer the current request",
    activeIntent: "GENERAL",
    activeEntities: [],
    activeEvent: null,
    activeMerchant: null,
    activeLocation: null,
    activeDateRange: null,
    activePlatform: null,
    activeDriverGoal: null,
    activeFilters: {},
    knownFacts: {},
    userPreferences: {},
    pendingClarification: null,
    lastSuccessfulTool: null,
    previousToolResults: [],
    lastUserCorrection: null,
    lastAssistantClaim: null,
    confidence: 0.5,
    updatedAt: now().toISOString(),
    version: STATE_VERSION,
  };
}

export function sanitizeConversationState(value, now = () => new Date()) {
  const fallback = createDefaultConversationState(now);
  if (!value || typeof value !== "object") return fallback;
  const activeEvent = value.activeEvent && typeof value.activeEvent === "object"
    ? cleanRecord(value.activeEvent, 20)
    : null;
  return {
    ...fallback,
    activeTopic: text(value.activeTopic, 60) || fallback.activeTopic,
    activeGoal: text(value.activeGoal, 500) || fallback.activeGoal,
    activeIntent: text(value.activeIntent, 80) || fallback.activeIntent,
    activeEntities: cleanList(value.activeEntities, 20),
    activeEvent: activeEvent && Object.keys(activeEvent).length ? activeEvent : null,
    activeMerchant: text(value.activeMerchant, 160) || null,
    activeLocation: value.activeLocation && typeof value.activeLocation === "object" ? cleanRecord(value.activeLocation, 10) : null,
    activeDateRange: value.activeDateRange && typeof value.activeDateRange === "object" ? cleanRecord(value.activeDateRange, 10) : null,
    activePlatform: text(value.activePlatform, 80) || null,
    activeDriverGoal: text(value.activeDriverGoal, 300) || null,
    activeFilters: cleanRecord(value.activeFilters, 20),
    knownFacts: cleanRecord(value.knownFacts, 40),
    userPreferences: cleanRecord(value.userPreferences, 30),
    pendingClarification: text(value.pendingClarification, 500) || null,
    lastSuccessfulTool: text(value.lastSuccessfulTool, 80) || null,
    previousToolResults: cleanToolResults(value.previousToolResults),
    lastUserCorrection: text(value.lastUserCorrection, 500) || null,
    lastAssistantClaim: text(value.lastAssistantClaim, 800) || null,
    confidence: Math.max(0, Math.min(1, Number(value.confidence ?? fallback.confidence))),
    updatedAt: text(value.updatedAt, 60) || fallback.updatedAt,
    version: STATE_VERSION,
  };
}

const PLATFORM_PATTERNS = [
  ["uber", "Uber"], ["lyft", "Lyft"], ["doordash", "DoorDash"],
  ["spark", "Spark"], ["amazon flex", "Amazon Flex"], ["roadie", "Roadie"],
  ["instacart", "Instacart"], ["shipt", "Shipt"], ["grubhub", "Grubhub"],
  ["veho", "Veho"],
];

function detectPlatform(input) {
  return PLATFORM_PATTERNS.find(([needle]) => input.includes(needle))?.[1] || null;
}

function isCorrection(input) {
  return /^(digo|me refiero a|no[, ]+hablo de|no eso|o sea|quise decir|i mean|no[, ]+i mean|rather)/.test(input)
    || /\b(para hacer|para trabajar con)\b/.test(input);
}

function detectExplicitTopic(input) {
  if (/\b(clima|tiempo para|pronostico|weather|forecast|lluvia|temperatura)\b/.test(input)) return "weather";
  if (/\b(auto scan|driver mode|gigprofit|conecto mi banco|conectar mi banco|bank connection|rear camera|front camera|dual camera|safety recording|tax center|tax ai|restore purchases|restaurar (mi )?compra|export(ar|o)? (el )?(pdf|csv)|dynamic island|live activit|settings|ajustes|radar no|como funciona|como activo|donde)\b/.test(input)) return "app_knowledge";
  if (/\b(acepto|aceptar|declino|oferta|offer)\b/.test(input) || (/\$\s*\d/.test(input) && /\b(milla|mile|km|minuto|minute)\b/.test(input))) return "offer_evaluation";
  if (/\b(quiero|meta|objetivo|goal)\b/.test(input) && /\$\s*\d/.test(input) && /\b(hoy|today|turno|shift|ganar|make|earn)\b/.test(input)) return "daily_plan";
  if (/\b(aeropuerto|airport)\b/.test(input)) return "airport_strategy";
  if (/\b(evento|eventos|concierto|ticketmaster|concert|venue|estadio|arena)\b/.test(input)) return "events";
  if (/\b(impuesto|deduccion|tax|gasto sin revisar|transaccion)\b/.test(input)) return "tax";
  if (/\b(radar|accidente|policia reportada|zona activa)\b/.test(input)) return "radar";
  if (/\b(navega|navegacion|ruta|eta|cuanto falta|navigate|end route)\b/.test(input)) return "navigation";
  if (/\b(ganancias|historial|sesiones|millas maneje|earnings|driving history)\b/.test(input)) return "gigprofit_data";
  return null;
}

function detectKnowledgeEntity(input) {
  const entries = [
    ["auto scan", "auto_scan", "Auto Scan"], ["driver mode", "driver_mode", "Driver Mode"],
    ["banco", "bank_connection", "Bank Connection"], ["bank", "bank_connection", "Bank Connection"],
    ["rear camera", "rear_camera", "Rear Camera"], ["front camera", "front_camera", "Front Camera"],
    ["dual camera", "dual_camera", "Dual Camera"], ["safety", "safety_recording", "Safety Recording"],
    ["radar", "radar", "Radar"], ["tax center", "tax_center", "Tax Center"],
    ["tax ai", "tax_ai", "Tax AI"], ["pdf", "exports", "PDF and CSV Export"],
    ["csv", "exports", "PDF and CSV Export"], ["restore", "restore_purchases", "Restore Purchases"],
    ["restaurar", "restore_purchases", "Restore Purchases"], ["settings", "settings", "Settings"],
    ["ajustes", "settings", "Settings"], ["dynamic island", "live_activities", "Live Activities and Dynamic Island"],
  ];
  const match = entries.find(([needle]) => input.includes(needle));
  return match ? { type: "feature", id: match[1], name: match[2] } : null;
}

function eventFromContext(appContext = {}) {
  const event = appContext?.radarSummary?.primaryEvent;
  if (!event || typeof event !== "object" || !text(event.title, 200)) return null;
  return {
    title: text(event.title, 200),
    venue: text(event.venue, 200),
    date: text(event.date, 80),
    startTime: text(event.time || event.startTime, 80),
    city: text(event.city || appContext?.location?.city, 120),
    category: text(event.type || event.category, 100),
    source: text(event.source, 60) || "Ticketmaster",
    estimatedAttendance: Number.isFinite(Number(event.estimatedAttendance)) ? Number(event.estimatedAttendance) : null,
  };
}

function parseFilters(input, previous = {}) {
  const filters = { ...previous };
  const attendance = input.match(/(?:mas de|more than|over)\s*([\d,.]+)\s*(?:personas|people)?/);
  if (attendance) filters.minimumAttendance = Number(attendance[1].replace(/[,\.]/g, ""));
  return filters;
}

function inferIntent({ input, topic, previous, correction, activeEvent }) {
  if (topic === "weather") return "WEATHER_CURRENT";
  if (topic === "app_knowledge") return "APP_KNOWLEDGE";
  if (topic === "offer_evaluation") return "OFFER_EVALUATION";
  if (topic === "daily_plan") return "DAILY_PLAN";
  if (topic === "airport_strategy") return "AIRPORT_STRATEGY";
  if (topic === "tax") return "TAX";
  if (topic === "radar") return "RADAR";
  if (topic === "navigation") return "NAVIGATION";
  if (topic === "gigprofit_data") return "GIGPROFIT_DATA";
  if (/\b(algun otro|alguno mas|another one|any other)\b/.test(input) && previous.activeTopic === "events") return "EVENTS_ALTERNATIVE";
  if ((/\b(a que hora|cuando|what time|when)\b/.test(input) || correction) && activeEvent && detectPlatform(input)) return "DRIVER_EVENT_STRATEGY";
  if (/\b(a que hora|cuando|what time|when)\b/.test(input) && activeEvent && /\b(recomiend\w*|convien\w*|should i|best)\b/.test(input)) return "DRIVER_EVENT_STRATEGY";
  if (topic === "events") return "EVENTS";
  return "GENERAL";
}

export function resolveConversationState({ previousState, question, appContext = {}, now = () => new Date() }) {
  const previous = sanitizeConversationState(previousState, now);
  const input = normalized(question);
  const correction = isCorrection(input);
  const platform = detectPlatform(input);
  const explicitTopic = detectExplicitTopic(input);
  const knowledgeEntity = detectKnowledgeEntity(input);
  const contextualEvent = eventFromContext(appContext);
  const expired = previous.activeEvent && Date.parse(previous.updatedAt) < now().getTime() - TEMPORAL_ENTITY_TTL_MS;
  let activeEvent = expired ? null : previous.activeEvent;
  if (contextualEvent) activeEvent = contextualEvent;

  let topic = explicitTopic || previous.activeTopic || "general";
  if (correction && platform && activeEvent) topic = "driver_strategy";
  if (!explicitTopic && /\b(a que hora|cuando|what time|when)\b/.test(input) && activeEvent && /\b(recomiend\w*|convien\w*|should i|best)\b/.test(input)) topic = "driver_strategy";
  if (!explicitTopic && /\b(algun otro|alguno mas|another one|any other)\b/.test(input) && previous.activeTopic === "events") topic = "events";

  const strongTopicChange = Boolean(explicitTopic && explicitTopic !== previous.activeTopic && !correction);
  if (strongTopicChange && !["events", "driver_strategy"].includes(topic)) activeEvent = null;
  if (topic === "airport_strategy") activeEvent = null;

  const intent = inferIntent({ input, topic, previous, correction, activeEvent });
  const activePlatform = platform || previous.activePlatform;
  let goal = previous.activeGoal;
  if (intent === "DRIVER_EVENT_STRATEGY") goal = `find the best time and positioning strategy to work ${activePlatform || "a gig platform"} around the active event`;
  else if (intent === "EVENTS" || intent === "EVENTS_ALTERNATIVE") goal = "find relevant events matching the active filters";
  else if (intent === "WEATHER_CURRENT") goal = "get current weather for the active location";
  else if (intent === "APP_KNOWLEDGE") goal = "explain or troubleshoot the requested GigProfit feature";
  else if (intent === "OFFER_EVALUATION") goal = "evaluate the gig offer without inventing missing inputs";
  else if (intent === "DAILY_PLAN") goal = "build an estimated, non-guaranteed driver shift plan";
  else if (intent === "AIRPORT_STRATEGY") goal = "plan an airport driving strategy";

  const location = appContext?.location || {};
  const knownFacts = { ...previous.knownFacts };
  if (activeEvent) {
    for (const [key, value] of Object.entries(activeEvent)) {
      if (value !== "" && value !== null && value !== undefined) knownFacts[`event.${key}`] = value;
    }
  }

  let activeEntities = previous.activeEntities;
  if (activeEvent) activeEntities = [{ type: "event", name: activeEvent.title }];
  else if (topic === "airport_strategy") activeEntities = [{ type: "place", name: "airport" }];
  else if (topic === "app_knowledge") {
    activeEntities = knowledgeEntity
      ? [knowledgeEntity]
      : previous.activeEntities.filter((item) => item?.type === "feature");
  } else if (strongTopicChange) activeEntities = [];

  return sanitizeConversationState({
    ...previous,
    activeTopic: topic,
    activeGoal: goal,
    activeIntent: intent,
    activeEntities,
    activeEvent,
    activeLocation: location.city || location.state ? { city: text(location.city, 120), state: text(location.state, 80), timezone: text(location.timezone, 80) } : previous.activeLocation,
    activeDateRange: appContext?.currentDateTime?.localDate ? { localDate: appContext.currentDateTime.localDate } : previous.activeDateRange,
    activePlatform,
    activeDriverGoal: ["driver_strategy", "airport_strategy", "daily_plan"].includes(topic) ? goal : previous.activeDriverGoal,
    activeFilters: parseFilters(input, strongTopicChange ? {} : previous.activeFilters),
    knownFacts,
    userPreferences: { ...previous.userPreferences, ...(appContext?.settings || {}) },
    pendingClarification: intent === "OFFER_EVALUATION" && !/\b\d+\s*(min|minuto|minute)/.test(input) ? "trip duration" : null,
    lastUserCorrection: correction ? text(question, 500) : previous.lastUserCorrection,
    confidence: explicitTopic || activeEvent ? 0.9 : 0.65,
    updatedAt: now().toISOString(),
  }, now);
}

export function completeConversationState({ state, tool, toolContext, assistantClaim, now = () => new Date() }) {
  const current = sanitizeConversationState(state, now);
  const result = toolContext ? {
    tool: text(tool, 80),
    timestamp: text(toolContext.timestamp, 60) || now().toISOString(),
    results: cleanRecord(toolContext.results, 20),
  } : null;
  return sanitizeConversationState({
    ...current,
    lastSuccessfulTool: text(tool, 80) || current.lastSuccessfulTool,
    previousToolResults: result ? [...current.previousToolResults, result].slice(-8) : current.previousToolResults,
    lastAssistantClaim: text(assistantClaim, 800) || null,
    updatedAt: now().toISOString(),
  }, now);
}

export function conversationStatePrompt(state) {
  const clean = sanitizeConversationState(state);
  return [
    "STRUCTURED CONVERSATION STATE",
    JSON.stringify(clean),
    "Resolve the current turn from this state before selecting tools.",
    "A correction updates the goal while retaining still-relevant verified entities.",
    "An explicit topic change overrides lastSuccessfulTool and stale sources.",
    "Use previous verified results without re-querying unless new or current data is required.",
  ].join("\n");
}
