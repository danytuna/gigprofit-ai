import crypto from "node:crypto";

const DEFAULT_MODEL = "gpt-4.1-mini";
const REVIEW_STATUS = {
  PREPARING: "preparing",
  PROCESSING: "processing",
  PAUSED: "paused",
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
  const amount = Number(transaction.amount || 0);
  return {
    id: transaction.id,
    merchant: transaction.merchantName || transaction.originalName,
    originalName: transaction.originalName || null,
    amount,
    direction: amount < 0 ? "inflow" : amount > 0 ? "outflow" : "zero",
    date: transaction.date,
    plaidPrimaryCategory: transaction.primaryCategory || null,
    plaidDetailedCategory: transaction.detailedCategory || null,
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
    classification === "excluded" ? "transfer" : "expense"
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

  const amount = Number(transaction.amount || 0);
  const isInflow = amount < 0;
  const normalizedCategory = category.replace(/[_-]+/g, " ");

  // Cross-account reconciliation is stronger evidence than a merchant/category guess.
  if (transaction.internalTransferMatch) {
    return buildSuggestion({
      transaction,
      classification: "excluded",
      deductibility: "not_deductible",
      taxCategory: "Internal transfer",
      confidence: 0.999,
      reason: "Matched to an equal and opposite movement in another connected account.",
      requiresUserReview: false,
      flags: ["matched_internal_transfer"],
      classificationSource: "imported",
      transactionType: "transfer",
    });
  }

  const refundSignals = [
    "refund", "reversal", "reversed", "purchase return", "returned purchase",
    "merchant credit", "cashback", "cash back", "rebate", "tax refund",
  ];
  const loanSignals = [
    "cash advance", "loan", "loan proceeds", "loan disbursement", "loan deposit",
    "borrow", "borrowed", "advance deposit", "line of credit advance",
    "earnin", "moneylion", "brigit", "cleo cash advance", "dave advance",
  ];
  const strongTransferSignals = [
    "transfer from checking", "transfer from savings", "transfer to checking",
    "transfer to savings", "online transfer from", "online transfer to",
    "account transfer", "internal transfer", "bank transfer",
    "payment thank you", "credit card payment", "card payment", "autopay payment",
  ];
  const peerToPeerSignals = ["zelle", "venmo", "cash app", "paypal"];
  const payrollSignals = [
    "payroll", "salary", "paycheck", "direct deposit payroll", "direct dep payroll",
    "wages", "employer deposit",
  ];
  const gigIncomeSignals = [
    "uber", "lyft", "doordash", "door dash", "grubhub", "instacart",
    "amazon flex", "spark driver", "walmart spark", "roadie", "shipt",
  ];
  const categoryLooksLikeRefund = normalizedCategory.includes("refund") || normalizedCategory.includes("cashback");
  const categoryLooksLikeTransfer = normalizedCategory.includes("transfer") || normalizedCategory.includes("credit card payment");
  const categoryLooksLikeIncome = normalizedCategory.includes("income") && !categoryLooksLikeRefund;
  const categoryLooksLikeStrongIncome = categoryLooksLikeIncome && !normalizedCategory.includes("other income");

  // IMPORTANT: an inflow is only a direction. It is not automatically taxable income.
  if (isInflow) {
    if (categoryLooksLikeRefund || includesAny(combined, refundSignals)) {
      return buildSuggestion({
        transaction,
        classification: "excluded",
        deductibility: "not_deductible",
        taxCategory: "Refund or reversal",
        confidence: 0.995,
        reason: "This credit appears to reverse or refund a prior payment rather than create new income.",
        requiresUserReview: false,
        flags: ["refund_like"],
        classificationSource: "imported",
        transactionType: "refund",
      });
    }

    if (includesAny(combined, loanSignals)) {
      return buildSuggestion({
        transaction,
        classification: "excluded",
        deductibility: "not_deductible",
        taxCategory: "Loan or cash advance",
        confidence: 0.99,
        reason: "Loan proceeds and cash advances are cash inflows, not earned income.",
        requiresUserReview: false,
        flags: ["loan_proceeds"],
        classificationSource: "imported",
        transactionType: "transfer",
      });
    }

    if (categoryLooksLikeTransfer || includesAny(combined, strongTransferSignals)) {
      return buildSuggestion({
        transaction,
        classification: "excluded",
        deductibility: "not_deductible",
        taxCategory: "Transfer",
        confidence: 0.995,
        reason: "This credit appears to move existing money rather than create new income.",
        requiresUserReview: false,
        flags: ["transfer_like"],
        classificationSource: "imported",
        transactionType: "transfer",
      });
    }

    // P2P services can carry either business income or ordinary transfers. Category labels
    // alone are not enough to promote them into taxable income.
    if (includesAny(combined, peerToPeerSignals) && !includesAny(combined, gigIncomeSignals) && !includesAny(combined, payrollSignals)) {
      return null;
    }

    if (categoryLooksLikeStrongIncome || includesAny(combined, payrollSignals) || includesAny(combined, gigIncomeSignals)) {
      return buildSuggestion({
        transaction,
        classification: "business",
        deductibility: "not_deductible",
        taxCategory: includesAny(combined, gigIncomeSignals) ? "Gig income" : "Income",
        confidence: categoryLooksLikeStrongIncome || includesAny(combined, payrollSignals) ? 0.99 : 0.96,
        reason: "The bank category and/or descriptor provides strong evidence that this credit is earned income.",
        requiresUserReview: false,
        flags: ["income_detected"],
        classificationSource: "imported",
        transactionType: "income",
      });
    }

    // Generic OTHER_INCOME and unknown ACH credits still need contextual review.
    if (categoryLooksLikeIncome) {
      return null;
    }

    return null;
  }

  // Outgoing card payments and obvious account transfers are not new deductible expenses.
  // P2P outflows are intentionally left for AI because they may represent a real business purchase.
  if (categoryLooksLikeTransfer || includesAny(combined, strongTransferSignals)) {
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
      transactionType: "transfer",
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
            "Determine transactionType before deciding tax classification.",
            "Plaid amount semantics: a negative amount is money entering the account (inflow); a positive amount is money leaving the account (outflow). An inflow is NOT automatically income.",
            "For inflows, distinguish earned income from internal/account transfers, credit-card payments, refunds/reversals, loan proceeds/cash advances, and ambiguous P2P/ACH credits.",
            "Only use transactionType=income when the descriptor/category provides strong evidence of salary, payroll, gig-platform payout, or other earned/reportable income.",
            "Loan proceeds, cash advances, own-account transfers, card payments, and refunds are not income. Use transfer or refund as appropriate.",
            "If an inflow could be either income or a transfer and evidence is insufficient, use classification=needs_review, transactionType=transfer, taxCategory=Unclassified inflow, and require user review. Never guess income.",
            "For expenses, GigProfit uses a strict vehicle-expense-only policy.",
            "Business expense categories allowed: confirmed fuel/charging, repair or maintenance shops, automotive parts stores, DMV/registration/inspection, vehicle insurance, car wash/detailing, tolls, work parking, tires, oil service, batteries, towing, and roadside assistance.",
            "Everything outside those supported vehicle expense categories must be personal and not_deductible.",
            "Use needs_review for expenses only when the merchant plausibly belongs to one of the supported vehicle categories but cannot be confirmed.",
            "For an ambiguous vehicle merchant, use web search to identify the merchant. If identity still cannot be confirmed, keep it in needs_review and add group_by_merchant.",
            "Gas-station descriptors are authoritative: FUEL/PUMP/OUTSIDE is business; INSIDE/STORE/MART/FOOD is personal; unclear descriptors remain needs_review.",
            "Never classify meals, general retail, phone, subscriptions, home expenses, office supplies, or unrelated merchants as business expenses.",
            "Review every supplied transaction independently and never infer one transaction from another unless an explicit matched-transfer flag is provided.",
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

function isQuotaExhaustedTaxAiError(error) {
  const details = error?.details && typeof error.details === "object"
    ? error.details
    : extractOpenAIErrorDetails(error);
  const code = String(details.code || "").toLowerCase();
  const type = String(details.type || "").toLowerCase();
  const message = String(details.message || "").toLowerCase();
  return code === "credit_balance_exhausted" ||
    code === "insufficient_quota" ||
    type === "insufficient_quota" ||
    message.includes("no credits remaining") ||
    message.includes("insufficient quota");
}

function isRetryableTaxAiError(error) {
  const details = extractOpenAIErrorDetails(error);
  if (isQuotaExhaustedTaxAiError(error)) {
    return false;
  }
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
    const transactionType = ["income", "expense", "transfer", "refund"].includes(item.transactionType)
      ? item.transactionType
      : item.classification === "excluded" ? "transfer" : "expense";
    const normalizedConfidence = typeof item.confidence === "number"
      ? Math.max(0, Math.min(1, item.confidence))
      : 0.5;
    const uncertainIncome = transactionType === "income" && (
      normalizedConfidence < 0.92 || item.requiresUserReview !== false
    );
    const effectiveTransactionType = uncertainIncome ? "transfer" : transactionType;
    const categoryIsSupported = supportedBusinessCategories.some((term) => proposedCategory.toLowerCase().includes(term));
    const proposedBusiness = item.classification === "business";
    // The strict vehicle-category gate applies only to expenses. Income has a separate
    // classification path and must not be rewritten to personal merely because its
    // tax category is not a vehicle expense. Low-confidence income is kept out of totals
    // until it is confirmed instead of being guessed into reportable income.
    const strictClassification = uncertainIncome
      ? "needs_review"
      : proposedBusiness && effectiveTransactionType === "expense" && !categoryIsSupported
        ? "personal"
        : item.classification;
    const strictDeductibility = uncertainIncome || effectiveTransactionType !== "expense" || strictClassification === "personal"
      ? "not_deductible"
      : item.deductibility;
    const strictCategory = uncertainIncome
      ? "Unclassified inflow"
      : strictClassification === "personal" && effectiveTransactionType === "expense"
        ? "Personal"
        : proposedCategory;

    return {
      transactionId: item.transactionId,
      classification: strictClassification,
      deductibility: strictDeductibility,
      taxCategory: strictCategory,
      businessUsePercentage: item.businessUsePercentage ?? null,
      confidence: normalizedConfidence,
      reason: typeof item.reason === "string" && item.reason.trim()
        ? item.reason.trim().slice(0, 160)
        : "AI suggested a review.",
      requiresUserReview: uncertainIncome ? true : item.requiresUserReview !== false,
      flags: Array.isArray(item.flags)
        ? item.flags.filter((flag) => typeof flag === "string" && flag.trim()).slice(0, 8)
        : [],
      classificationSource: "ai_suggestion",
      transactionType: effectiveTransactionType,
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
  if (["preparing", "reviewing", "paused", "saving", "finalizing", "completed", "failed", "cancelled"].includes(normalized)) {
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