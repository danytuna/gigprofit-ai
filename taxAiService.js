import crypto from "node:crypto";

const DEFAULT_MODEL = "gpt-4.1-mini";
const REVIEW_STATUS = {
  PREPARING: "preparing",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};
const RETRY_DELAYS_MS = [500, 1000, 2000];
const TAX_REVIEW_USER_MESSAGE = "AI Tax Review is temporarily unavailable. Please try again.";
const TAX_SUGGESTION_SCHEMA_NAME = "gigprofit_tax_review_suggestions";
const VALID_CLASSIFICATIONS = ["business", "personal", "needs_review", "excluded"];
const VALID_DEDUCTIBILITY = ["deductible", "partially_deductible", "not_deductible", "needs_review"];
const MERCHANT_LOOKUP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const merchantLookupCache = new Map();

function normalizeBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function buildTaxConfigFromEnv(env = process.env) {
  return {
    enabled: normalizeBool(env.AI_TAX_REVIEW_ENABLED, true),
    batchSize: clampInt(env.AI_TAX_BATCH_SIZE, 5, 100, 10),
    maxTransactionsPerRun: clampInt(env.AI_TAX_MAX_TRANSACTIONS_PER_RUN, 10, 5000, 1000),
    highConfidenceThreshold: Number(env.AI_TAX_HIGH_CONFIDENCE_THRESHOLD || 0.92),
    autoApplyEnabled: normalizeBool(env.AI_TAX_AUTO_APPLY_ENABLED, false),
    dailyRunLimit: clampInt(env.AI_TAX_DAILY_RUN_LIMIT, 1, 100, 3),
    model: String(env.AI_TAX_MODEL || env.OPENAI_COPILOT_MODEL || DEFAULT_MODEL),
    requestTimeoutMs: clampInt(env.AI_TAX_REQUEST_TIMEOUT_MS, 10000, 120000, 45000),
    webSearchEnabled: normalizeBool(env.AI_WEB_SEARCH_ENABLED, true),
  };
}

function merchantKey(transaction) {
  const merchant = String(transaction.merchantName || transaction.originalName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return merchant;
}

function includesAny(text, fragments) {
  return fragments.some((fragment) => text.includes(fragment));
}

const VEHICLE_USE_FRAGMENTS = [
  "gas", "fuel", "gasoline", "petrol", "diesel", "charging", "supercharger", "ev charging",
  "parking", "parkmobile", "meter", "toll", "ez pass", "sunpass", "fastrak", "tollway",
  "car wash", "carwash", "detailing", "detail", "auto detail", "wash", "cleaning",
  "oil change", "oil", "lube", "maintenance", "repair", "mechanic", "garage",
  "autozone", "o reilly", "advance auto", "pep boys", "jiffy lube", "valvoline", "discount tire",
  "tires", "tire", "alignment", "brake", "brakes", "battery", "alternator", "wiper", "wipers",
  "inspection", "state inspection", "smog", "emissions", "registration", "renewal", "tag", "tags",
  "license plate", "dmv", "rmv", "car insurance", "auto insurance", "vehicle insurance",
  "lease", "leasing", "rental car", "car rental", "rideshare", "uber driver", "lyft driver",
  "dashcam", "phone mount", "car mount", "charger", "cigarette lighter", "12v", "vehicle",
];

const VEHICLE_USE_CATEGORIES = [
  "auto and transport",
  "gas stations",
  "parking",
  "tolls",
  "ride sharing",
  "vehicle services",
  "auto care",
  "auto parts",
  "car wash",
  "auto repair",
  "travel",
  "transportation",
  "parking & tolls",
  "vehicle insurance",
  "insurance",
  "public transportation",
];

function vehicleSignalLevel(combined, category) {
  return {
    matched: includesAny(combined, VEHICLE_USE_FRAGMENTS) || includesAny(category, VEHICLE_USE_CATEGORIES),
    partial: includesAny(combined, [
      "gas", "fuel", "gasoline", "petrol", "diesel", "charging", "supercharger", "ev charging",
      "oil change", "oil", "lube", "maintenance", "repair", "mechanic", "garage",
      "autozone", "o reilly", "advance auto", "pep boys", "jiffy lube", "valvoline", "discount tire",
      "tires", "tire", "alignment", "brake", "brakes", "battery", "wiper", "wipers",
      "inspection", "state inspection", "smog", "emissions", "registration", "renewal", "tag", "tags",
      "license plate", "dmv", "rmv", "car insurance", "auto insurance", "vehicle insurance",
      "lease", "leasing", "rental car", "car rental", "rideshare", "uber driver", "lyft driver",
      "dashcam", "phone mount", "car mount", "charger", "vehicle",
    ]),
  };
}

function buildSafeAiTransaction(transaction) {
  return {
    id: transaction.id,
    merchant: transaction.merchantName || transaction.originalName,
    amount: transaction.amount,
    date: transaction.date,
    plaidCategory: transaction.detailedCategory || transaction.primaryCategory || null,
    recurring: Boolean(transaction.recurring),
    pending: Boolean(transaction.pending),
    isIncome: Boolean(transaction.isIncome),
    existingClassification: transaction.classification,
    existingTransactionType: transaction.transactionType || null,
    userNote: typeof transaction.userNote === "string" && transaction.userNote.trim()
      ? transaction.userNote.trim().slice(0, 240)
      : null,
    merchantKey: merchantKey(transaction),
  };
}

function buildSuggestion({
  transaction,
  classification,
  deductibility,
  taxCategory,
  confidence,
  reason,
  requiresUserReview = true,
  flags = [],
  classificationSource = "ai_suggestion",
  transactionType = null,
  merchantIdentity = null,
  webLookupUsed = false,
  source = null,
}) {
  const resolvedTransactionType = transactionType || (
    transaction.isIncome ? "income" : classification === "excluded" ? "transfer" : "expense"
  );
  return {
    transactionId: transaction.id,
    classification,
    deductibility,
    taxCategory,
    businessUsePercentage: null,
    confidence,
    reason,
    requiresUserReview,
    flags,
    classificationSource,
    transactionType: resolvedTransactionType,
    merchantIdentity,
    webLookupUsed: Boolean(webLookupUsed),
    source: source || (classificationSource === "ai_suggestion" ? "ai" : "localRule"),
    modelVersion: null,
    ruleVersion: "tax-rules-v4-strict-vehicle",
    reviewedAt: new Date().toISOString(),
  };
}

function deterministicSuggestion(transaction, rules = []) {
  const merchant = merchantKey(transaction);
  const category = String(transaction.detailedCategory || transaction.primaryCategory || "").toLowerCase();
  const originalName = String(transaction.originalName || "").toLowerCase();
  const combined = `${merchant} ${category} ${originalName}`.replace(/\s+/g, " ").trim();

  const matchingRule = rules
    .filter((rule) => rule.enabled !== false)
    .sort((a, b) => a.priority - b.priority)
    .find((rule) => {
      const merchantPattern = String(rule.merchantPattern || "").toLowerCase().trim();
      const plaidCategory = String(rule.plaidCategory || "").toLowerCase().trim();
      const matchesMerchant = merchantPattern ? combined.includes(merchantPattern) : true;
      const matchesCategory = plaidCategory ? category.includes(plaidCategory) : true;
      return matchesMerchant && matchesCategory;
    });

  if (matchingRule) {
    return buildSuggestion({
      transaction,
      classification: matchingRule.classification,
      deductibility: matchingRule.deductibility,
      taxCategory: matchingRule.taxCategory,
      confidence: 0.99,
      reason: "Applied your saved merchant decision.",
      requiresUserReview: false,
      flags: [],
      classificationSource: "user_rule",
    });
  }

  if (transaction.isIncome || Number(transaction.amount) < 0) {
    return buildSuggestion({
      transaction,
      classification: "business",
      deductibility: "not_deductible",
      taxCategory: "Income",
      confidence: 0.98,
      reason: "Income is reportable but is not a deductible expense.",
      requiresUserReview: false,
      flags: ["income_detected"],
      classificationSource: "imported",
    });
  }

  if (includesAny(combined, [
    "payment thank you", "credit card payment", "autopay", "online payment",
    "transfer", "zelle", "venmo", "cash app", "paypal transfer",
  ])) {
    return buildSuggestion({
      transaction,
      classification: "excluded",
      deductibility: "not_deductible",
      taxCategory: "Transfer",
      confidence: 0.99,
      reason: "This appears to be a transfer or card payment, not a new expense.",
      requiresUserReview: false,
      flags: ["transfer_like"],
      classificationSource: "imported",
    });
  }

  const gasStations = [
    "shell", "chevron", "texaco", "exxon", "mobil", "bp", "sunoco", "marathon",
    "citgo", "valero", "circle k", "quiktrip", "quick trip", "qt ", "racetrac",
    "raceway", "wawa", "sheetz", "speedway", "love's", "loves travel", "pilot",
    "flying j", "murphy usa", "costco gas", "sam's club fuel", "sams club fuel",
    "bj's gas", "7-eleven", "76 gas",
  ];
  const insideSignals = ["inside", "store", "mart", "market", "food", "kitchen", "cafe", "snack"];
  const fuelSignals = ["outside", "fuel", "pay at pump", "pump", "gasoline", "service station"];
  const isGasStation = includesAny(combined, gasStations);
  const isInsidePurchase = includesAny(combined, insideSignals);
  const isFuelPurchase = includesAny(combined, fuelSignals) || category.includes("gasoline") || category.includes("fuel");

  if (isGasStation && isInsidePurchase && !isFuelPurchase) {
    return buildSuggestion({
      transaction,
      classification: "personal",
      deductibility: "not_deductible",
      taxCategory: "Personal",
      confidence: 0.98,
      reason: "The descriptor indicates an inside-store purchase rather than fuel.",
      requiresUserReview: false,
      flags: ["gas_station_inside"],
      classificationSource: "imported",
    });
  }

  if (isGasStation && isFuelPurchase) {
    return buildSuggestion({
      transaction,
      classification: "business",
      deductibility: "deductible",
      taxCategory: "Gas and charging",
      confidence: 0.98,
      reason: "The merchant and descriptor clearly identify a fuel purchase.",
      requiresUserReview: false,
      flags: ["confirmed_fuel"],
      classificationSource: "imported",
    });
  }

  if (isGasStation) {
    return buildSuggestion({
      transaction,
      classification: "needs_review",
      deductibility: "needs_review",
      taxCategory: "Gas and charging",
      confidence: 0.55,
      reason: "This is a gas-station charge, but the descriptor does not confirm fuel or an inside purchase.",
      requiresUserReview: true,
      flags: ["ambiguous_gas_station", "group_by_merchant"],
      classificationSource: "ai_suggestion",
    });
  }

  const clearVehicleGroups = [
    { terms: ["autozone", "advance auto", "o'reilly auto", "oreilly auto", "napa auto", "carquest"], category: "Vehicle parts and supplies" },
    { terms: ["discount tire", "tire kingdom", "firestone", "goodyear", "ntb", "tires plus", "big o tires"], category: "Tires and maintenance" },
    { terms: ["jiffy lube", "valvoline", "take 5 oil", "midas", "pep boys", "maaco", "safelite"], category: "Repairs and maintenance" },
    { terms: ["dmv", "department of motor vehicles", "motor vehicle division", "vehicle registration", "license plate", "state inspection", "emissions inspection"], category: "Registration and licensing" },
    { terms: ["car wash", "autobell", "mister car wash", "zips car wash", "detail", "detailing"], category: "Vehicle cleaning" },
    { terms: ["ez pass", "e-zpass", "sunpass", "fastrak", "toll", "parkmobile", "parking meter", "parking garage"], category: "Parking and tolls" },
    { terms: ["aaa roadside", "roadside assistance", "towing", "tow service", "wrecker"], category: "Towing and roadside assistance" },
    { terms: ["auto insurance", "car insurance", "vehicle insurance"], category: "Vehicle insurance" },
    { terms: ["battery", "interstate batteries", "batteries plus"], category: "Vehicle parts and supplies" },
  ];

  for (const group of clearVehicleGroups) {
    if (includesAny(combined, group.terms)) {
      return buildSuggestion({
        transaction,
        classification: "business",
        deductibility: "deductible",
        taxCategory: group.category,
        confidence: 0.96,
        reason: `This merchant clearly matches ${group.category.toLowerCase()}.`,
        requiresUserReview: false,
        flags: ["confirmed_vehicle_expense"],
        classificationSource: "imported",
      });
    }
  }

  const ambiguousVehicleSignals = [
    "auto", "automotive", "motor", "mechanic", "repair", "garage", "collision",
    "body shop", "tire", "oil change", "lube", "transmission", "brake", "alignment",
    "inspection", "registration", "roadside", "tow", "car wash", "detailing",
    "parking", "toll", "insurance", "vehicle parts", "auto parts",
  ];

  if (includesAny(combined, ambiguousVehicleSignals)) {
    // Leave potentially eligible but unconfirmed vehicle merchants for AI + web identity lookup.
    return null;
  }

  // Strict default: anything outside the supported vehicle categories is personal.
  return buildSuggestion({
    transaction,
    classification: "personal",
    deductibility: "not_deductible",
    taxCategory: "Personal",
    confidence: 0.97,
    reason: "This transaction is outside GigProfit's supported vehicle-expense categories.",
    requiresUserReview: false,
    flags: ["strict_personal_default"],
    classificationSource: "imported",
  });
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeModelName(model) {
  return String(model || "").trim().toLowerCase();
}

function getModelCapabilities(model) {
  const normalized = normalizeModelName(model);
  const supportsVerbosity =
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("gpt-5-mini") ||
    normalized.startsWith("gpt-5-nano");
  const supportsReasoning =
    supportsVerbosity ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4");

  return {
    supportsReasoning,
    supportsVerbosity,
  };
}

function stripEmptyValues(value) {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => stripEmptyValues(item))
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripEmptyValues(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  return value;
}

function buildTaxSuggestionTextFormat() {
  return {
    type: "json_schema",
    name: TAX_SUGGESTION_SCHEMA_NAME,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["suggestions"],
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "transactionId",
              "classification",
              "deductibility",
              "taxCategory",
              "businessUsePercentage",
              "confidence",
              "reason",
              "requiresUserReview",
              "flags",
              "transactionType",
              "merchantIdentity",
              "webLookupUsed",
              "source",
            ],
            properties: {
              transactionId: { type: "string" },
              classification: { type: "string", enum: VALID_CLASSIFICATIONS },
              deductibility: { type: "string", enum: VALID_DEDUCTIBILITY },
              taxCategory: { type: "string" },
              businessUsePercentage: { type: ["number", "null"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" },
              requiresUserReview: { type: "boolean" },
              flags: {
                type: "array",
                items: { type: "string" },
              },
              transactionType: { type: "string", enum: ["income", "expense", "transfer", "refund"] },
              merchantIdentity: { type: ["string", "null"] },
              webLookupUsed: { type: "boolean" },
              source: { type: "string", enum: ["localRule", "ai", "aiAndWeb", "manual", "imported", "fallback"] },
            },
          },
        },
      },
    },
  };
}

function buildTaxReviewInput(transactions) {
  return [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: [
            "You are GigProfit Tax AI.",
            "Classify each transaction for tax organization only.",
            "Do not provide legal advice or chain-of-thought.",
            "Return only the structured output requested.",
            "Keep reasons short, practical, and under 160 characters.",
            "Never invent transaction IDs.",
            "GigProfit uses a strict vehicle-expense-only policy.",
            "Business categories allowed: confirmed fuel/charging, repair or maintenance shops, automotive parts stores, DMV/registration/inspection, vehicle insurance, car wash/detailing, tolls, work parking, tires, oil service, batteries, towing, and roadside assistance.",
            "Everything outside those supported vehicle categories must be personal and not_deductible.",
            "Use needs_review only when the merchant plausibly belongs to one of the supported vehicle categories but cannot be confirmed.",
            "For an ambiguous vehicle merchant, use web search to identify the merchant. If identity still cannot be confirmed, keep it in needs_review and add group_by_merchant.",
            "Gas-station descriptors are authoritative: FUEL/PUMP/OUTSIDE is business; INSIDE/STORE/MART/FOOD is personal; unclear descriptors remain needs_review.",
            "Never classify meals, general retail, phone, subscriptions, home expenses, office supplies, or unrelated merchants as business.",
            "Review every supplied transaction independently and never infer one transaction from another.",
            "Do not treat credit-card payments, bank transfers, refunds, cash movements, or loan payments as new deductible expenses.",
            "Respect user notes. If evidence is insufficient, keep the item in needs_review rather than guessing.",
            "Set webLookupUsed and source=aiAndWeb only when a web search was actually used.",
          ].join("\n"),
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({
            instructions: {
              expenseContext: "Self-employed gig driver using a vehicle in the United States.",
              allowedClassifications: VALID_CLASSIFICATIONS,
              allowedDeductibility: VALID_DEDUCTIBILITY,
            },
            transactions,
          }),
        },
      ],
    },
  ];
}

export function buildTaxReviewResponsesParams({ model, transactions, webSearchEnabled = false }) {
  const capabilities = getModelCapabilities(model);
  return stripEmptyValues({
    model,
    input: buildTaxReviewInput(transactions),
    text: {
      ...(capabilities.supportsVerbosity ? { verbosity: "medium" } : {}),
      format: buildTaxSuggestionTextFormat(),
    },
    reasoning: capabilities.supportsReasoning
      ? { effort: "medium" }
      : undefined,
    tools: webSearchEnabled
      ? [{ type: "web_search", external_web_access: true, search_context_size: "low" }]
      : undefined,
    tool_choice: webSearchEnabled ? "auto" : undefined,
  });
}

function pickFirstObject(...values) {
  return values.find((value) => value && typeof value === "object") || null;
}

function sanitizeErrorMessage(message) {
  if (typeof message !== "string" || !message.trim()) {
    return "Unknown error";
  }

  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .trim();
}

function extractOpenAIErrorDetails(error) {
  const responseData = pickFirstObject(error?.response?.data, error?.data);
  const nestedError = pickFirstObject(error?.error, responseData?.error, error?.cause?.error);
  const cause = pickFirstObject(error?.cause);
  const causeResponseData = pickFirstObject(cause?.response?.data, cause?.data);
  const causeNestedError = pickFirstObject(cause?.error, causeResponseData?.error);

  const status =
    error?.status ??
    error?.response?.status ??
    error?.statusCode ??
    cause?.status ??
    cause?.response?.status ??
    cause?.statusCode ??
    null;
  const requestId =
    error?.request_id ||
    error?.requestID ||
    error?.response?.data?.request_id ||
    nestedError?.request_id ||
    cause?.request_id ||
    cause?.requestID ||
    cause?.response?.data?.request_id ||
    causeNestedError?.request_id ||
    null;
  const code =
    error?.code ||
    nestedError?.code ||
    error?.response?.data?.error_code ||
    cause?.code ||
    causeNestedError?.code ||
    cause?.response?.data?.error_code ||
    null;
  const type =
    error?.type ||
    nestedError?.type ||
    error?.response?.data?.error_type ||
    cause?.type ||
    causeNestedError?.type ||
    cause?.response?.data?.error_type ||
    null;
  const param =
    error?.param ||
    nestedError?.param ||
    cause?.param ||
    causeNestedError?.param ||
    null;
  const message =
    error?.response?.data?.error_message ||
    nestedError?.message ||
    cause?.response?.data?.error_message ||
    causeNestedError?.message ||
    error?.message ||
    cause?.message ||
    "Unknown error";

  return {
    name: error?.name || cause?.name || "Error",
    code: code || (typeof status === "number" ? `HTTP_${status}` : "UNKNOWN"),
    status: typeof status === "number" ? status : null,
    requestId: typeof requestId === "string" && requestId.trim() ? requestId : null,
    type: typeof type === "string" && type.trim() ? type : null,
    param: typeof param === "string" && param.trim() ? param : null,
    message: sanitizeErrorMessage(message),
    causeName: cause?.name || null,
    causeCode: cause?.code || causeNestedError?.code || null,
  };
}

function logTaxAiError({ logger, config, phase, attempt, batchSize, error }) {
  const details = extractOpenAIErrorDetails(error);
  logger.error("AI TAX REVIEW ERROR", {
    name: details.name,
    code: details.code,
    status: details.status,
    requestId: details.requestId,
    errorType: details.type,
    errorParam: details.param,
    errorMessage: details.message,
    causeName: details.causeName,
    causeCode: details.causeCode,
    model: config.model,
    attempt,
    batchSize,
    phase,
  });
  return details;
}

function isRetryableTaxAiError(error) {
  const details = extractOpenAIErrorDetails(error);
  if ([400, 401, 403].includes(details.status)) {
    return false;
  }
  if ([429, 500, 502, 503, 504].includes(details.status)) {
    return true;
  }

  const normalizedCode = String(details.code || "").toUpperCase();
  if (["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "ETIMEDOUT"].includes(normalizedCode)) {
    return true;
  }

  return details.message.toLowerCase().includes("fetch failed");
}

function validateSuggestionShape(payload) {
  const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : null;
  if (!suggestions) {
    throw new Error("Structured output missing suggestions array.");
  }

  return suggestions.map((item) => {
    if (!item || typeof item.transactionId !== "string" || !item.transactionId.trim()) {
      throw new Error("Structured output suggestion is missing transactionId.");
    }
    if (!VALID_CLASSIFICATIONS.includes(item.classification)) {
      throw new Error("Structured output suggestion has invalid classification.");
    }
    if (!VALID_DEDUCTIBILITY.includes(item.deductibility)) {
      throw new Error("Structured output suggestion has invalid deductibility.");
    }
    const supportedBusinessCategories = [
      "gas", "charging", "repair", "maintenance", "tire", "oil", "vehicle parts",
      "automotive", "registration", "licensing", "inspection", "vehicle insurance",
      "car wash", "vehicle cleaning", "parking", "toll", "towing", "roadside", "battery",
    ];
    const proposedCategory = typeof item.taxCategory === "string" && item.taxCategory.trim()
      ? item.taxCategory.trim()
      : "Needs professional review";
    const categoryIsSupported = supportedBusinessCategories.some((term) => proposedCategory.toLowerCase().includes(term));
    const proposedBusiness = item.classification === "business";
    const strictClassification = proposedBusiness && !categoryIsSupported ? "personal" : item.classification;
    const strictDeductibility = strictClassification === "personal" ? "not_deductible" : item.deductibility;
    const strictCategory = strictClassification === "personal" ? "Personal" : proposedCategory;

    return {
      transactionId: item.transactionId,
      classification: strictClassification,
      deductibility: strictDeductibility,
      taxCategory: strictCategory,
      businessUsePercentage: item.businessUsePercentage ?? null,
      confidence: typeof item.confidence === "number"
        ? Math.max(0, Math.min(1, item.confidence))
        : 0.5,
      reason: typeof item.reason === "string" && item.reason.trim()
        ? item.reason.trim().slice(0, 160)
        : "AI suggested a review.",
      requiresUserReview: item.requiresUserReview !== false,
      flags: Array.isArray(item.flags)
        ? item.flags.filter((flag) => typeof flag === "string" && flag.trim()).slice(0, 8)
        : [],
      classificationSource: "ai_suggestion",
      transactionType: ["income", "expense", "transfer", "refund"].includes(item.transactionType)
        ? item.transactionType
        : item.classification === "excluded" ? "transfer" : "expense",
      merchantIdentity: typeof item.merchantIdentity === "string" && item.merchantIdentity.trim()
        ? item.merchantIdentity.trim().slice(0, 120)
        : null,
      webLookupUsed: item.webLookupUsed === true,
      source: ["localRule", "ai", "aiAndWeb", "manual", "imported", "fallback"].includes(item.source)
        ? item.source
        : item.webLookupUsed === true ? "aiAndWeb" : "ai",
      modelVersion: null,
      ruleVersion: "tax-rules-v4-strict-vehicle",
      reviewedAt: new Date().toISOString(),
    };
  });
}

class TaxAiReviewError extends Error {
  constructor(message, { phase, details, batchSize, attempt } = {}) {
    super(message);
    this.name = "TaxAiReviewError";
    this.phase = phase || "processing";
    this.details = details || null;
    this.batchSize = batchSize || null;
    this.attempt = attempt || null;
  }
}

async function classifyWithAI({ openaiClient, transactions, config, logger }) {
  if (!openaiClient || !transactions.length) {
    return [];
  }

  const now = Date.now();
  const enrichedTransactions = transactions.map((transaction) => {
    const cached = merchantLookupCache.get(transaction.merchantKey);
    if (!cached || now - cached.savedAt > MERCHANT_LOOKUP_CACHE_TTL_MS) {
      return transaction;
    }
    return { ...transaction, cachedMerchantIdentity: cached.identity };
  });
  const needsWebLookup = Boolean(config.webSearchEnabled) && enrichedTransactions.some(
    (transaction) => transaction.merchantKey && !transaction.cachedMerchantIdentity
  );

  const request = buildTaxReviewResponsesParams({
    model: config.model,
    transactions: enrichedTransactions,
    webSearchEnabled: needsWebLookup,
  });

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const timeoutMs = config.requestTimeoutMs || 45000;
      const controller = new AbortController();
      let timeoutHandle;
      const hardTimeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          const timeoutError = new Error("OpenAI tax review request timed out.");
          timeoutError.name = "TimeoutError";
          timeoutError.code = "ETIMEDOUT";
          reject(timeoutError);
        }, timeoutMs);
      });

      let response;
      try {
        response = await Promise.race([
          openaiClient.responses.parse(request, { signal: controller.signal }),
          hardTimeout,
        ]);
      } finally {
        clearTimeout(timeoutHandle);
      }
      const parsed = response.output_parsed || parseJsonObject(response.output_text || "");
      const suggestions = validateSuggestionShape(parsed);
      for (const suggestion of suggestions) {
        if (!suggestion.webLookupUsed || !suggestion.merchantIdentity) continue;
        const transaction = enrichedTransactions.find((item) => item.id === suggestion.transactionId);
        if (transaction?.merchantKey) {
          merchantLookupCache.set(transaction.merchantKey, {
            identity: suggestion.merchantIdentity,
            savedAt: Date.now(),
          });
        }
      }
      return suggestions;
    } catch (error) {
      const phase = error?.message?.startsWith("Structured output")
        ? "validation"
        : error instanceof SyntaxError
        ? "parsing"
        : "openai_request";
      const details = logTaxAiError({
        logger,
        config,
        phase,
        attempt,
        batchSize: transactions.length,
        error,
      });

      if (!isRetryableTaxAiError(error) || attempt >= RETRY_DELAYS_MS.length) {
        throw new TaxAiReviewError(TAX_REVIEW_USER_MESSAGE, {
          phase,
          details,
          batchSize: transactions.length,
          attempt,
        });
      }

      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
}

function countBy(items, key) {
  return items.reduce((accumulator, item) => {
    const value = item[key] || "unknown";
    accumulator[value] = (accumulator[value] || 0) + 1;
    return accumulator;
  }, {});
}

function buildReviewSummary(suggestions, config) {
  const countsByClassification = countBy(suggestions, "classification");
  const highConfidence = suggestions.filter((item) => Number(item.confidence || 0) >= config.highConfidenceThreshold).length;
  return {
    total: suggestions.length,
    business: countsByClassification.business || 0,
    personal: countsByClassification.personal || 0,
    needs_review: countsByClassification.needs_review || 0,
    excluded: countsByClassification.excluded || 0,
    highConfidence,
  };
}

function normalizeReviewPhase(currentPhase, fallback = REVIEW_STATUS.PREPARING) {
  const normalized = String(currentPhase || fallback || REVIEW_STATUS.PREPARING).trim().toLowerCase();
  if (["preparing", "reviewing", "saving", "finalizing", "completed", "failed", "cancelled"].includes(normalized)) {
    return normalized;
  }
  if (["processing", "queued"].includes(normalized)) {
    return "reviewing";
  }
  return fallback || REVIEW_STATUS.PREPARING;
}

function buildProgressPercent({
  processedTransactions,
  totalTransactions,
  processedBatches,
  totalBatches,
  status,
}) {
  if (status === REVIEW_STATUS.COMPLETED) {
    return 100;
  }

  const transactions = Math.max(0, Number(processedTransactions || 0));
  const total = Math.max(0, Number(totalTransactions || 0));
  const batches = Math.max(0, Number(processedBatches || 0));
  const totalBatchCount = Math.max(0, Number(totalBatches || 0));

  if (total > 0) {
    return Math.max(0, Math.min(100, Math.round((transactions / total) * 100)));
  }

  if (totalBatchCount > 0) {
    return Math.max(0, Math.min(100, Math.round((batches / totalBatchCount) * 100)));
  }

  return 0;
}

function buildReviewProgressRecord({
  id,
  year,
  mode,
  status,
  currentPhase,
  processedTransactions,
  totalTransactions,
  processedBatches,
  totalBatches,
  selectedTransactionIds = [],
  transactionSetHash = null,
  sourceYear = null,
  sourceAccountCount = null,
  heartbeatAt = null,
  reusedExistingReview = false,
  summary = {},
  counts = {},
  suggestions = [],
  autoApplyHighConfidence = false,
  errorMessage = null,
  errorCode = null,
  createdAt = null,
  updatedAt = null,
}) {
  const normalizedStatus = String(status || REVIEW_STATUS.PREPARING).toLowerCase();
  const normalizedPhase = normalizeReviewPhase(
    currentPhase,
    normalizedStatus === REVIEW_STATUS.COMPLETED
      ? "completed"
      : normalizedStatus === REVIEW_STATUS.FAILED
      ? "failed"
      : normalizedStatus === REVIEW_STATUS.CANCELLED
      ? "cancelled"
      : "preparing"
  );
  const normalizedProcessedTransactions = Math.max(0, Number(processedTransactions || 0));
  const normalizedTotalTransactions = Math.max(0, Number(totalTransactions || 0));
  const normalizedProcessedBatches = Math.max(0, Number(processedBatches || 0));
  const normalizedTotalBatches = Math.max(0, Number(totalBatches || 0));
  const percent = buildProgressPercent({
    processedTransactions: normalizedProcessedTransactions,
    totalTransactions: normalizedTotalTransactions,
    processedBatches: normalizedProcessedBatches,
    totalBatches: normalizedTotalBatches,
    status: normalizedStatus,
  });
  const progress = {
    stage: normalizedPhase,
    stageIndex: {
      preparing: 0,
      reviewing: 1,
      saving: 2,
      finalizing: 3,
      completed: 4,
      failed: 4,
      cancelled: 4,
    }[normalizedPhase] ?? 0,
    totalStages: 5,
    processed: normalizedProcessedTransactions,
    total: normalizedTotalTransactions,
  };
  const now = updatedAt || new Date().toISOString();

  return {
    id,
    year,
    mode,
    status: normalizedStatus,
    currentPhase: normalizedPhase,
    progressPercent: percent,
    processedTransactions: normalizedProcessedTransactions,
    totalTransactions: normalizedTotalTransactions,
    processedBatches: normalizedProcessedBatches,
    totalBatches: normalizedTotalBatches,
    autoApplyHighConfidence,
    selectedTransactionIds,
    transactionSetHash,
    sourceYear,
    sourceAccountCount,
    heartbeatAt: heartbeatAt || now,
    reusedExistingReview,
    summary,
    progress,
    suggestions,
    counts,
    createdAt: createdAt || now,
    updatedAt: now,
    errorMessage,
    errorCode,
  };
}

async function runTaxAiReview({
  uid,
  store,
  openaiClient,
  logger = console,
  config = buildTaxConfigFromEnv(),
  reviewId,
  year,
  mode = "unreviewed",
  transactions,
  rules = [],
  isCancelled = async () => false,
  transactionSetHash = null,
  sourceYear = null,
  sourceAccountCount = null,
}) {
  const cappedTransactions = transactions.slice(0, config.maxTransactionsPerRun);
  const totalTransactions = cappedTransactions.length;
  const totalBatches = Math.ceil(totalTransactions / config.batchSize);
  const startedAt = new Date().toISOString();
  const suggestions = [];
  let processedTransactions = 0;
  let processedBatches = 0;
  let currentPhase = "preparing";

  const saveProgress = async ({
    status = REVIEW_STATUS.PROCESSING,
    phase = currentPhase,
    extra = {},
  } = {}) => store.upsertReview(uid, buildReviewProgressRecord({
    id: reviewId,
    year,
    mode,
    status,
    currentPhase: phase,
    processedTransactions,
    totalTransactions,
    processedBatches,
    totalBatches,
    selectedTransactionIds: [],
    transactionSetHash,
    sourceYear,
    sourceAccountCount,
    heartbeatAt: new Date().toISOString(),
    autoApplyHighConfidence: false,
    createdAt: startedAt,
    summary: extra.summary || {},
    counts: extra.counts || {},
    suggestions: extra.suggestions || [],
    errorMessage: extra.errorMessage || null,
    errorCode: extra.errorCode || null,
  }));

  await saveProgress({ status: REVIEW_STATUS.PREPARING, phase: "preparing" });

  try {
    const batches = chunk(cappedTransactions, config.batchSize);
    for (const batch of batches) {
      if (await isCancelled()) {
        currentPhase = "cancelled";
        return await saveProgress({
          status: REVIEW_STATUS.CANCELLED,
          phase: "cancelled",
          extra: {
            errorMessage: "AI Tax Review was cancelled.",
            errorCode: "CANCELLED",
          },
        });
      }

      currentPhase = "reviewing";
      const aiCandidates = [];
      for (const transaction of batch) {
        const suggestion = deterministicSuggestion(transaction, rules);
        if (suggestion) {
          suggestions.push(suggestion);
        } else {
          aiCandidates.push(transaction);
        }
      }

      if (aiCandidates.length) {
        try {
          const aiResults = await classifyWithAI({
            openaiClient,
            transactions: aiCandidates.map(buildSafeAiTransaction),
            config,
            logger,
          });
          suggestions.push(...aiResults);
        } catch (error) {
          const isStructuredOutputFailure =
            error instanceof TaxAiReviewError &&
            ["validation", "parsing"].includes(String(error.phase || "").toLowerCase());

          if (isStructuredOutputFailure) {
            logger.error("AI TAX STRUCTURED OUTPUT FAILURE", {
              reviewId: String(reviewId || "").slice(0, 8),
              processedTransactions,
              batchSize: batch.length,
              phase: error.phase,
              errorCode: error.details?.code || "INVALID_STRUCTURED_OUTPUT",
            });

            throw error;
          }

          const details = error instanceof TaxAiReviewError
            ? error.details
            : extractOpenAIErrorDetails(error);
          logger.error("AI TAX BATCH FALLBACK", {
            reviewId: String(reviewId || "").slice(0, 8),
            processedTransactions,
            batchSize: batch.length,
            errorCode: details?.code || error?.code || "UNKNOWN",
          });

          for (const transaction of aiCandidates) {
            suggestions.push(buildSuggestion({
              transaction,
              classification: "needs_review",
              deductibility: "needs_review",
              taxCategory: "Needs professional review",
              confidence: 0,
              reason: "AI could not finish this transaction. Please review it manually.",
              requiresUserReview: true,
              flags: ["ai_batch_fallback"],
              classificationSource: "ai_suggestion",
            }));
          }
        }
      }

      processedTransactions = Math.min(totalTransactions, processedTransactions + batch.length);
      processedBatches = Math.min(totalBatches || 0, processedBatches + 1);
      await saveProgress({
        status: REVIEW_STATUS.PROCESSING,
        phase: "reviewing",
      });
    }

    const summary = buildReviewSummary(suggestions, config);
    processedTransactions = totalTransactions;
    processedBatches = totalBatches;
    currentPhase = "completed";
    const review = await store.upsertReview(uid, buildReviewProgressRecord({
      id: reviewId,
      year,
      mode,
      status: REVIEW_STATUS.COMPLETED,
      currentPhase: "completed",
      processedTransactions,
      totalTransactions,
      processedBatches,
      totalBatches,
      createdAt: startedAt,
      transactionSetHash,
      sourceYear,
      sourceAccountCount,
      heartbeatAt: new Date().toISOString(),
      summary,
      counts: summary,
      suggestions,
      errorMessage: null,
      errorCode: null,
    }));

    return review;
  } catch (error) {
    const details = error instanceof TaxAiReviewError
      ? error.details
      : extractOpenAIErrorDetails(error);
    await store.upsertReview(uid, buildReviewProgressRecord({
      id: reviewId,
      year,
      mode,
      status: REVIEW_STATUS.FAILED,
      currentPhase: error?.phase || currentPhase || "failed",
      processedTransactions,
      totalTransactions,
      processedBatches,
      totalBatches,
      createdAt: startedAt,
      transactionSetHash,
      sourceYear,
      sourceAccountCount,
      heartbeatAt: new Date().toISOString(),
      errorMessage: error?.message || TAX_REVIEW_USER_MESSAGE,
      errorCode: details?.code || "UNKNOWN",
      suggestions: [],
    }));
    throw error instanceof TaxAiReviewError
      ? error
      : new TaxAiReviewError(TAX_REVIEW_USER_MESSAGE, {
          phase: currentPhase,
          details,
        });
  }
}

function nextReviewId() {
  return `review_${crypto.randomUUID()}`;
}

export {
  buildSafeAiTransaction,
  buildTaxConfigFromEnv,
  buildReviewProgressRecord,
  deterministicSuggestion,
  extractOpenAIErrorDetails,
  nextReviewId,
  REVIEW_STATUS,
  runTaxAiReview,
  validateSuggestionShape,
};
