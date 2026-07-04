import crypto from "node:crypto";

const DEFAULT_MODEL = "gpt-4.1-mini";
const REVIEW_STAGES = [
  "Preparing transactions",
  "Reviewing merchants",
  "Detecting transfers",
  "Finding recurring patterns",
  "Preparing suggestions",
  "Review complete",
];

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
    batchSize: clampInt(env.AI_TAX_BATCH_SIZE, 5, 100, 50),
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

function sanitizeAiLogError(error, logger, config) {
  logger.error("AI TAX REVIEW ERROR", {
    code: error?.code || error?.type || "UNKNOWN",
    status: error?.status || null,
    requestId: error?.request_id || error?.requestID || null,
    model: config.model,
  });
}

async function classifyWithAI({ openaiClient, transactions, config, logger }) {
  if (!openaiClient || !transactions.length) {
    return [];
  }

  const prompt = {
    role: "user",
    content: [
      {
        type: "input_text",
        text: [
          "Review these GigProfit transactions and return strict JSON.",
          "These are organizational suggestions for tax review, not legal conclusions.",
          "Never mark transfers, card payments, deposits, loans, medical, legal, or ambiguous mixed-use merchants as auto-approved deductions.",
          "Return JSON with this shape:",
          "{\"results\":[{\"transactionId\":\"...\",\"classification\":\"business|personal|needs_review|excluded\",\"deductibility\":\"deductible|partially_deductible|not_deductible|needs_review\",\"taxCategory\":\"...\",\"confidence\":0.0,\"reason\":\"...\",\"requiresUserReview\":true,\"flags\":[\"...\"]}]}",
          `Transactions: ${JSON.stringify(transactions)}`,
        ].join("\n"),
      },
    ],
  };

  try {
    const response = await openaiClient.responses.create({
      model: config.model,
      input: [prompt],
    });

    const outputText = response.output_text || "";
    const parsed = parseJsonObject(outputText);
    const results = Array.isArray(parsed?.results) ? parsed.results : [];

    return results
      .filter((item) => item && typeof item.transactionId === "string")
      .map((item) => ({
        transactionId: item.transactionId,
        classification: item.classification || "needs_review",
        deductibility: item.deductibility || "needs_review",
        taxCategory: item.taxCategory || "Needs professional review",
        confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
        reason: item.reason || "AI suggested a review.",
        requiresUserReview: item.requiresUserReview !== false,
        flags: Array.isArray(item.flags) ? item.flags : [],
        classificationSource: "ai_suggestion",
      }));
  } catch (error) {
    sanitizeAiLogError(error, logger, config);
    return transactions.map((transaction) => ({
      transactionId: transaction.id,
      classification: "needs_review",
      deductibility: "needs_review",
      taxCategory: "Needs professional review",
      confidence: 0.2,
      reason: "AI could not confidently classify this transaction right now.",
      requiresUserReview: true,
      flags: ["ai_unavailable"],
      classificationSource: "ai_suggestion",
    }));
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
  transactions,
  rules = [],
}) {
  const cappedTransactions = transactions.slice(0, config.maxTransactionsPerRun);
  const suggestions = [];
  const ambiguous = [];

  let stageIndex = 0;
  const saveProgress = async (processed) => {
    await store.upsertReview(uid, {
      id: reviewId,
      year,
      status: stageIndex >= REVIEW_STAGES.length - 1 ? "completed" : "running",
      progress: {
        stage: REVIEW_STAGES[stageIndex],
        stageIndex,
        totalStages: REVIEW_STAGES.length,
        processed,
        total: cappedTransactions.length,
      },
    });
  };

  await saveProgress(0);
  stageIndex = 1;

  for (const transaction of cappedTransactions) {
    const suggestion = deterministicSuggestion(transaction, rules);
    if (suggestion) {
      suggestions.push(suggestion);
    } else {
      ambiguous.push(transaction);
    }
  }

  await saveProgress(suggestions.length);
  stageIndex = 2;
  await saveProgress(suggestions.length);
  stageIndex = 3;
  await saveProgress(suggestions.length);

  const aiBatches = chunk(ambiguous.map(buildSafeAiTransaction), config.batchSize);
  for (const batch of aiBatches) {
    const aiResults = await classifyWithAI({
      openaiClient,
      transactions: batch,
      config,
      logger,
    });
    suggestions.push(...aiResults);
    await saveProgress(suggestions.length);
  }

  stageIndex = 4;
  await saveProgress(suggestions.length);
  stageIndex = 5;
  await saveProgress(cappedTransactions.length);

  const summary = buildReviewSummary(suggestions, config);
  const review = await store.upsertReview(uid, {
    id: reviewId,
    year,
    mode: "unreviewed",
    status: "completed",
    summary,
    counts: summary,
    suggestions,
    progress: {
      stage: REVIEW_STAGES.at(-1),
      stageIndex: REVIEW_STAGES.length - 1,
      totalStages: REVIEW_STAGES.length,
      processed: cappedTransactions.length,
      total: cappedTransactions.length,
    },
  });

  return review;
}

function nextReviewId() {
  return `review_${crypto.randomUUID()}`;
}

export {
  buildSafeAiTransaction,
  buildTaxConfigFromEnv,
  deterministicSuggestion,
  nextReviewId,
  REVIEW_STAGES,
  runTaxAiReview,
};
