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
}) {
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
  };
}

function deterministicSuggestion(transaction, rules = []) {
  const merchant = merchantKey(transaction);
  const category = String(transaction.detailedCategory || transaction.primaryCategory || "").toLowerCase();
  const originalName = String(transaction.originalName || "").toLowerCase();
  const combined = `${merchant} ${category} ${originalName}`.trim();
  const absAmount = Math.abs(Number(transaction.amount || 0));

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
      reason: "Applied your saved tax rule.",
      requiresUserReview: false,
      flags: [],
      classificationSource: "user_rule",
    });
  }

  if (transaction.isIncome || Number(transaction.amount) < 0) {
    const incomeSource = includesAny(combined, [
      "uber", "lyft", "doordash", "instacart", "spark", "grubhub", "shipt", "roadie", "amazon flex",
    ]);
    if (incomeSource || category.includes("deposit") || category.includes("payroll")) {
      return buildSuggestion({
        transaction,
        classification: "business",
        deductibility: "not_deductible",
        taxCategory: "Income",
        confidence: 0.97,
        reason: "This looks like work-related income, not a deductible expense.",
        requiresUserReview: false,
        flags: ["income_detected"],
        classificationSource: "imported",
      });
    }
  }

  if (includesAny(combined, [
    "payment thank you", "credit card payment", "autopay", "online payment", "transfer", "zelle", "venmo", "cash app", "paypal transfer",
  ])) {
    return buildSuggestion({
      transaction,
      classification: "excluded",
      deductibility: "not_deductible",
      taxCategory: "Transfer",
      confidence: 0.99,
      reason: "This appears to be a transfer or card payment, so it should not be counted as a new tax expense.",
      requiresUserReview: false,
      flags: ["transfer_like"],
      classificationSource: "imported",
    });
  }

  if (absAmount >= 500) {
    return buildSuggestion({
      transaction,
      classification: "needs_review",
      deductibility: "needs_review",
      taxCategory: "Needs professional review",
      confidence: 0.4,
      reason: "Higher-amount transactions stay in review unless you confirm them.",
      requiresUserReview: true,
      flags: ["high_amount"],
    });
  }

  if (includesAny(combined, ["shell", "chevron", "exxon", "bp", "mobil", "raceway", "wawa", "qt", "quiktrip"])) {
    return buildSuggestion({
      transaction,
      classification: "business",
      deductibility: "partially_deductible",
      taxCategory: "Gas and charging",
      confidence: 0.9,
      reason: "This merchant looks like fuel, but business-use percentage still needs your confirmation.",
      requiresUserReview: true,
      flags: ["mixed_use_possible"],
    });
  }

  if (includesAny(combined, ["autozone", "o reilly", "advance auto", "pep boys", "jiffy lube", "valvoline", "discount tire"])) {
    return buildSuggestion({
      transaction,
      classification: "business",
      deductibility: "partially_deductible",
      taxCategory: "Repairs and maintenance",
      confidence: 0.88,
      reason: "This looks like vehicle maintenance, but the business-use share may need review.",
      requiresUserReview: true,
      flags: ["vehicle_related"],
    });
  }

  if (includesAny(combined, ["parking", "parkmobile", "meter", "toll", "ez pass", "sunpass", "fastrak"])) {
    return buildSuggestion({
      transaction,
      classification: "business",
      deductibility: "deductible",
      taxCategory: includesAny(combined, ["toll", "ez pass", "sunpass", "fastrak"]) ? "Parking and tolls" : "Parking and tolls",
      confidence: 0.95,
      reason: "This looks like a driving-related parking or toll charge.",
      requiresUserReview: false,
      flags: [],
      classificationSource: "imported",
    });
  }

  if (includesAny(combined, ["walmart", "amazon", "target", "costco"])) {
    return buildSuggestion({
      transaction,
      classification: "needs_review",
      deductibility: "needs_review",
      taxCategory: "Needs professional review",
      confidence: 0.38,
      reason: "This merchant is often mixed-use, so it needs manual review before treating it as business or personal.",
      requiresUserReview: true,
      flags: ["mixed_use_possible", "ambiguous_merchant"],
    });
  }

  if (includesAny(combined, ["restaurant", "coffee", "starbucks", "chipotle", "subway", "dunkin"])) {
    return buildSuggestion({
      transaction,
      classification: "needs_review",
      deductibility: "needs_review",
      taxCategory: "Meals",
      confidence: 0.35,
      reason: "Meals should not be auto-marked deductible without more business context.",
      requiresUserReview: true,
      flags: ["meals_need_context"],
    });
  }

  return null;
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
            "Use needs_review for ambiguous, mixed-use, transfer-like, or uncertain expenses.",
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

export function buildTaxReviewResponsesParams({ model, transactions }) {
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
    return {
      transactionId: item.transactionId,
      classification: item.classification,
      deductibility: item.deductibility,
      taxCategory: typeof item.taxCategory === "string" && item.taxCategory.trim()
        ? item.taxCategory.trim()
        : "Needs professional review",
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

  const request = buildTaxReviewResponsesParams({
    model: config.model,
    transactions,
  });

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await openaiClient.responses.parse(request);
      const parsed = response.output_parsed || parseJsonObject(response.output_text || "");
      return validateSuggestionShape(parsed);
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
}) {
  const cappedTransactions = transactions.slice(0, config.maxTransactionsPerRun);
  const suggestions = [];
  const ambiguous = [];

  let currentPhase = REVIEW_STATUS.PREPARING;
  const saveProgress = async (processed, { status = currentPhase, stage = currentPhase, extra = {} } = {}) => {
    await store.upsertReview(uid, {
      id: reviewId,
      year,
      status,
      progress: {
        stage,
        stageIndex: status === REVIEW_STATUS.COMPLETED ? 2 : status === REVIEW_STATUS.PROCESSING ? 1 : 0,
        totalStages: 3,
        processed,
        total: cappedTransactions.length,
      },
      ...extra,
    });
  };

  await saveProgress(0, { status: REVIEW_STATUS.PREPARING, stage: "preparing" });

  try {
    for (const transaction of cappedTransactions) {
      const suggestion = deterministicSuggestion(transaction, rules);
      if (suggestion) {
        suggestions.push(suggestion);
      } else {
        ambiguous.push(transaction);
      }
    }

    currentPhase = REVIEW_STATUS.PROCESSING;
    await saveProgress(suggestions.length, { status: REVIEW_STATUS.PROCESSING, stage: "processing" });

    const aiBatches = chunk(ambiguous.map(buildSafeAiTransaction), config.batchSize);
    for (const batch of aiBatches) {
      const aiResults = await classifyWithAI({
        openaiClient,
        transactions: batch,
        config,
        logger,
      });
      suggestions.push(...aiResults);
      await saveProgress(suggestions.length, { status: REVIEW_STATUS.PROCESSING, stage: "processing" });
    }

    currentPhase = REVIEW_STATUS.COMPLETED;
    await saveProgress(cappedTransactions.length, { status: REVIEW_STATUS.COMPLETED, stage: "completed" });

    const summary = buildReviewSummary(suggestions, config);
    const review = await store.upsertReview(uid, {
      id: reviewId,
      year,
      mode,
      status: REVIEW_STATUS.COMPLETED,
      summary,
      counts: summary,
      suggestions,
      progress: {
        stage: "completed",
        stageIndex: 2,
        totalStages: 3,
        processed: cappedTransactions.length,
        total: cappedTransactions.length,
      },
    });

    return review;
  } catch (error) {
    const details = error instanceof TaxAiReviewError
      ? error.details
      : extractOpenAIErrorDetails(error);
    await saveProgress(suggestions.length, {
      status: REVIEW_STATUS.FAILED,
      stage: error?.phase || currentPhase || "failed",
      extra: {
        errorMessage: error?.message || TAX_REVIEW_USER_MESSAGE,
        errorCode: details?.code || "UNKNOWN",
      },
    });
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
  deterministicSuggestion,
  extractOpenAIErrorDetails,
  nextReviewId,
  REVIEW_STATUS,
  runTaxAiReview,
  validateSuggestionShape,
};
