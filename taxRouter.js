import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";

import { normalizeYear } from "./taxStore.js";
import {
  buildReviewProgressRecord,
  buildTaxConfigFromEnv,
  deterministicSuggestion,
  nextReviewId,
  runTaxAiReview,
  REVIEW_STATUS,
} from "./taxAiService.js";

function createTaxRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    // Tax AI progress polling is a legitimate background workflow. The old 180/15m
    // cap could throttle a single active review and freeze the UI at a stale percent.
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator(req) {
      return `${req.auth?.uid || "anon"}:${req.ip || "ip"}`;
    },
  });
}

function safeTaxLog(logger, message, payload) {
  logger.info(message, payload);
}

function errorSummary(error) {
  return {
    status: error?.response?.status || error?.status || null,
    requestId: error?.response?.data?.request_id || error?.request_id || null,
    errorCode: error?.response?.data?.error_code || error?.code || null,
    errorType: error?.response?.data?.error_type || error?.type || null,
    errorMessage: error?.response?.data?.error_message || error?.message || "Unknown error",
  };
}

function normalizeAccount(account, item) {
  return {
    accountId: account.account_id || "",
    itemId: item.itemId,
    institutionName: item.institutionName || "Connected Bank",
    name: account.name || "Account",
    mask: account.mask || "",
    subtype: account.subtype || "",
    type: account.type || "",
  };
}

function mapPlaidTransaction(transaction, item, account) {
  const personalCategory = transaction.personal_finance_category || {};
  return {
    id: transaction.transaction_id,
    plaidTransactionId: transaction.transaction_id,
    accountId: transaction.account_id || "",
    itemId: item.itemId,
    merchantName: transaction.merchant_name || null,
    originalName: transaction.name || "",
    amount: Number(transaction.amount || 0),
    isoCurrencyCode: transaction.iso_currency_code || "USD",
    authorizedDate: transaction.authorized_date || null,
    date: transaction.date || null,
    pending: Boolean(transaction.pending),
    pendingTransactionId: transaction.pending_transaction_id || null,
    primaryCategory: personalCategory.primary || null,
    detailedCategory: personalCategory.detailed || null,
    institutionName: item.institutionName || "Connected Bank",
    accountName: account?.name || null,
    accountMask: account?.mask || null,
    // `amount < 0` means an inflow in Plaid; it does NOT mean taxable income.
    // Income is assigned only after deterministic/AI classification below.
    isIncome: false,
    schemaVersion: 2,
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function compactPlaidRequest(value) {
  if (Array.isArray(value)) {
    const items = value
      .filter((item) => item !== undefined && item !== null)
      .map((item) => compactPlaidRequest(item));
    return items;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => [key, compactPlaidRequest(item)])
    .filter(([, item]) => {
      if (Array.isArray(item)) {
        return item.length > 0;
      }
      if (item && typeof item === "object") {
        return Object.keys(item).length > 0;
      }
      return item !== undefined && item !== null;
    });

  return Object.fromEntries(entries);
}

function sanitizedAccountIds(accountIds) {
  if (!Array.isArray(accountIds)) return undefined;
  const cleaned = accountIds
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

export function buildPlaidTransactionsGetRequest({
  accessToken,
  startDate,
  endDate,
  count,
  offset,
  accountIds,
}) {
  return compactPlaidRequest({
    access_token: accessToken,
    start_date: startDate,
    end_date: endDate,
    options: {
      count,
      offset,
      account_ids: sanitizedAccountIds(accountIds),
    },
  });
}

export function buildPlaidTransactionsSyncRequest({
  accessToken,
  cursor,
  count,
  accountId,
}) {
  return compactPlaidRequest({
    access_token: accessToken,
    cursor,
    count,
    options: {
      account_id: accountId ? String(accountId).trim() : undefined,
    },
  });
}

function summarizePlaidRequestKeys(request) {
  const topLevelKeys = Object.keys(request || {})
    .filter((key) => key !== "access_token")
    .sort();
  const optionKeys = request?.options && typeof request.options === "object"
    ? Object.keys(request.options).sort()
    : [];
  return { topLevelKeys, optionKeys };
}

function logPlaidRequestError(logger, endpoint, request, error) {
  logger.error("TAX PLAID REQUEST ERROR", {
    plaidEndpoint: endpoint,
    ...errorSummary(error),
    requestKeys: summarizePlaidRequestKeys(request),
  });
}

function mergePendingClassification(baseRecord, pendingRecord) {
  if (!pendingRecord) return baseRecord;

  return {
    ...baseRecord,
    classification: pendingRecord.classification,
    deductibility: pendingRecord.deductibility,
    businessUsePercentage: pendingRecord.businessUsePercentage,
    taxCategory: pendingRecord.taxCategory,
    scheduleCategory: pendingRecord.scheduleCategory,
    userNote: pendingRecord.userNote,
    classificationSource: pendingRecord.classificationSource,
    confidence: pendingRecord.confidence,
    aiReason: pendingRecord.aiReason,
    userConfirmed: pendingRecord.userConfirmed,
    reviewedAt: pendingRecord.reviewedAt,
    flags: pendingRecord.flags || [],
    lastAppliedRuleId: pendingRecord.lastAppliedRuleId || null,
    transactionType: pendingRecord.transactionType || baseRecord.transactionType || null,
    isIncome: pendingRecord.transactionType === "income" || Boolean(pendingRecord.isIncome),
    schemaVersion: Math.max(Number(baseRecord.schemaVersion || 1), Number(pendingRecord.schemaVersion || 1)),
  };
}

function buildTransactionResponse(record) {
  return compactObject({
    id: record.id,
    plaidTransactionId: record.plaidTransactionId,
    accountId: record.accountId,
    itemId: record.itemId,
    merchantName: record.merchantName,
    originalName: record.originalName,
    amount: record.amount,
    isoCurrencyCode: record.isoCurrencyCode,
    authorizedDate: record.authorizedDate,
    date: record.date,
    pending: record.pending,
    pendingTransactionId: record.pendingTransactionId,
    primaryCategory: record.primaryCategory,
    detailedCategory: record.detailedCategory,
    institutionName: record.institutionName,
    accountName: record.accountName,
    accountMask: record.accountMask,
    classification: record.classification,
    deductibility: record.deductibility,
    businessUsePercentage: record.businessUsePercentage,
    taxCategory: record.taxCategory,
    scheduleCategory: record.scheduleCategory,
    userNote: record.userNote,
    classificationSource: record.classificationSource,
    confidence: record.confidence,
    aiReason: record.aiReason,
    userConfirmed: record.userConfirmed,
    reviewedAt: record.reviewedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    schemaVersion: record.schemaVersion,
    isIncome: record.isIncome,
    transactionType: record.transactionType,
    flags: record.flags,
  });
}

function buildReviewResponse(review, taxCenterCounts = null) {
  const summary = review?.summary && typeof review.summary === "object" ? review.summary : {};
  const counts = review?.counts && typeof review.counts === "object" ? review.counts : {};
  const suggestions = Array.isArray(review?.suggestions) ? review.suggestions : [];
  const progressMeta = review?.progress && typeof review.progress === "object" ? review.progress : {};
  const totalTransactions = Number(review?.totalTransactions ?? progressMeta.total ?? summary.total ?? 0);
  const processedTransactions = Number(review?.processedTransactions ?? progressMeta.processed ?? 0);
  const totalBatches = Number(review?.totalBatches ?? 0);
  const processedBatches = Number(review?.processedBatches ?? 0);
  const storedProgressPercent = Number(review?.progressPercent);
  const computedProgressPercent = totalTransactions > 0
    ? Math.min(100, Math.round((processedTransactions / totalTransactions) * 100))
    : 0;
  const progressPercent = Number.isFinite(storedProgressPercent) && storedProgressPercent > 0
    ? storedProgressPercent
    : computedProgressPercent;
  const currentPhase = review?.currentPhase || progressMeta.stage || null;
  const progress = progressMeta
    ? compactObject({
        stage: progressMeta.stage,
        stageIndex: progressMeta.stageIndex,
        totalStages: progressMeta.totalStages,
        processed: progressMeta.processed,
        total: progressMeta.total,
      })
    : null;

  return compactObject({
    id: String(review?.id || ""),
    reviewId: String(review?.id || ""),
    year: Number(review?.year || new Date().getUTCFullYear()),
    mode: review?.mode || "unreviewed",
    status: review?.status || "queued",
    currentPhase,
    progressPercent,
    processedTransactions,
    totalTransactions,
    processedBatches,
    totalBatches,
    selectedTransactionIds: Array.isArray(review?.selectedTransactionIds) ? review.selectedTransactionIds : [],
    summary,
    counts,
    transactionCount: Number(summary.total || totalTransactions || progress?.total || 0),
    suggestionCount: suggestions.length,
    suggestions,
    progress,
    updatedAt: review?.updatedAt || null,
    heartbeatAt: review?.heartbeatAt || review?.updatedAt || null,
    transactionSetHash: review?.transactionSetHash || null,
    sourceYear: review?.sourceYear ?? null,
    sourceAccountCount: review?.sourceAccountCount ?? null,
    sourceTransactionCount: review?.sourceTransactionCount ?? null,
    autoResolvedTransactions: Number(review?.autoResolvedTransactions || 0),
    aiRequestedTransactions: Number(review?.aiRequestedTransactions || 0),
    aiCompletedTransactions: Number(review?.aiCompletedTransactions || 0),
    aiFailedTransactions: Number(review?.aiFailedTransactions || 0),
    reusedExistingReview: review?.reusedExistingReview ?? null,
    taxCenterCounts: taxCenterCounts || undefined,
    errorMessage: review?.errorMessage || null,
    errorCode: review?.errorCode || null,
  });
}

function shouldReuseExistingReview(existingReview, taxCenterCounts) {
  if (!existingReview) return false;
  if (!isActiveReviewStatus(existingReview.status)) return false;
  if (isStalledReview(existingReview)) return false;
  const updatedAt = Date.parse(existingReview.updatedAt || existingReview.createdAt || "");
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > 5 * 60 * 1000) {
    return false;
  }
  return true;
}

async function fetchPlaidTransactionsForUser({
  uid,
  store,
  plaidClient,
  decryptSecret,
  encryptionKey,
  logger,
  itemId,
  startDate,
  endDate,
}) {
  const allItems = await store.getItems(uid);
  const items = itemId
    ? allItems.filter((item) => item.itemId === itemId)
    : allItems;

  const results = await Promise.all(items.map(async (item) => {
    const accessToken = decryptSecret(item, encryptionKey);
    const pageSize = 500;
    let offset = 0;
    let totalTransactions = Infinity;
    const transactions = [];

    while (offset < totalTransactions) {
      const request = buildPlaidTransactionsGetRequest({
        accessToken,
        startDate,
        endDate,
        count: pageSize,
        offset,
      });

      let response;
      try {
        response = await plaidClient.transactionsGet(request);
      } catch (error) {
        logPlaidRequestError(logger, "transactionsGet", request, error);
        throw error;
      }

      const pageTransactions = response.data.transactions || [];
      totalTransactions = Number(response.data.total_transactions || pageTransactions.length);
      transactions.push(...pageTransactions);

      if (!pageTransactions.length || pageTransactions.length < pageSize) {
        break;
      }

      offset += pageTransactions.length;
    }

    return {
      item,
      transactions,
    };
  }));

  return results.flatMap(({ item, transactions }) =>
    transactions.map((transaction) => {
      const account = Array.isArray(item.accounts)
        ? item.accounts.find((candidate) => candidate.account_id === transaction.account_id)
        : null;
      return mapPlaidTransaction(transaction, item, account);
    })
  );
}

function yearDateRange(year) {
  const currentYear = new Date().getUTCFullYear();
  const endDate = year >= currentYear
    ? new Date().toISOString().slice(0, 10)
    : `${year}-12-31`;

  return {
    startDate: `${year}-01-01`,
    endDate,
  };
}

function passesFilters(record, query = {}) {
  const matchesClassification = !query.classification || record.classification === query.classification;
  const matchesDeductibility = !query.deductibility || record.deductibility === query.deductibility;
  const matchesItem = !query.item_id || record.itemId === query.item_id;
  const matchesPending = query.pending === undefined || String(record.pending) === String(query.pending) || (String(query.pending) === "posted" && record.pending === false);
  const matchesSource = !query.source || record.classificationSource === query.source;
  const merchant = `${record.merchantName || ""} ${record.originalName || ""}`.toLowerCase();
  const matchesSearch = !query.search || merchant.includes(String(query.search).toLowerCase());
  return matchesClassification && matchesDeductibility && matchesItem && matchesPending && matchesSource && matchesSearch;
}

function resolvedTransactionType(transaction) {
  if (["income", "expense", "transfer", "refund"].includes(transaction?.transactionType)) {
    return transaction.transactionType;
  }
  if (transaction?.isIncome) return "income";
  if (transaction?.classification === "excluded") return "transfer";
  return "expense";
}

function isExpenseTransaction(transaction) {
  return resolvedTransactionType(transaction) === "expense";
}

function isReviewableTaxTransaction(transaction) {
  if (!transaction || transaction.pending === true) return false;
  const type = resolvedTransactionType(transaction);
  if (type === "refund") return false;
  if (type === "income" || type === "transfer") {
    return transaction.classification === "needs_review";
  }
  return true;
}

function isUnappliedAiSuggestion(transaction) {
  return transaction?.classificationSource === "ai_suggestion" &&
    !transaction?.userConfirmed;
}

function isManualReviewTransaction(transaction) {
  return transaction?.pending !== true &&
    transaction?.classification === "needs_review" &&
    transaction?.classificationSource !== "ai_suggestion";
}

function isAiEligibleTransaction(transaction) {
  return isReviewableTaxTransaction(transaction) &&
    !transaction?.userConfirmed &&
    transaction?.classificationSource !== "ai_suggestion" &&
    transaction?.classification !== "excluded";
}

function reviewSortValue(review) {
  return String(review?.updatedAt || review?.createdAt || "");
}

function maskIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function transactionDedupeKey(record) {
  return String(record?.pendingTransactionId || record?.plaidTransactionId || record?.id || "");
}

function transactionSortValue(record) {
  return String(record?.updatedAt || record?.createdAt || record?.reviewedAt || "");
}

function choosePreferredTransaction(left, right) {
  const leftScore = [
    left?.userConfirmed ? 100 : 0,
    left?.pending ? 0 : 50,
    left?.classificationSource === "manual" ? 30 : 0,
    left?.classificationSource === "user_rule" ? 20 : 0,
    left?.classificationSource === "ai_suggestion" ? 10 : 0,
    Date.parse(left?.updatedAt || left?.createdAt || "") || 0,
  ].reduce((sum, value) => sum + value, 0);
  const rightScore = [
    right?.userConfirmed ? 100 : 0,
    right?.pending ? 0 : 50,
    right?.classificationSource === "manual" ? 30 : 0,
    right?.classificationSource === "user_rule" ? 20 : 0,
    right?.classificationSource === "ai_suggestion" ? 10 : 0,
    Date.parse(right?.updatedAt || right?.createdAt || "") || 0,
  ].reduce((sum, value) => sum + value, 0);

  return rightScore > leftScore ? right : left;
}

function dedupeTransactions(records) {
  const grouped = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    const key = transactionDedupeKey(record);
    if (!key) continue;
    const existing = grouped.get(key);
    grouped.set(key, existing ? choosePreferredTransaction(existing, record) : record);
  }

  return Array.from(grouped.values())
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")) || transactionSortValue(right).localeCompare(transactionSortValue(left)));
}

function hasStrongTransferEvidence(record) {
  const text = [
    record?.merchantName,
    record?.originalName,
    record?.primaryCategory,
    record?.detailedCategory,
  ].filter(Boolean).join(" ").toLowerCase().replace(/[_-]+/g, " ");

  return [
    "transfer",
    "account transfer",
    "online transfer",
    "credit card payment",
    "payment thank you",
    "card payment",
    "autopay payment",
  ].some((fragment) => text.includes(fragment));
}

function markMatchedInternalTransfers(records) {
  const transactions = Array.isArray(records) ? records.map((record) => ({ ...record })) : [];
  const byAmount = new Map();

  for (const transaction of transactions) {
    if (transaction.pending || !transaction.accountId) continue;
    const amount = Number(transaction.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const cents = Math.round(Math.abs(amount) * 100);
    const bucket = byAmount.get(cents) || [];
    bucket.push(transaction);
    byAmount.set(cents, bucket);
  }

  const matchedIds = new Set();
  for (const bucket of byAmount.values()) {
    for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
      const left = bucket[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex += 1) {
        const right = bucket[rightIndex];
        if (left.accountId === right.accountId) continue;
        const leftAmount = Number(left.amount || 0);
        const rightAmount = Number(right.amount || 0);
        if (!(leftAmount < 0 && rightAmount > 0) && !(leftAmount > 0 && rightAmount < 0)) continue;
        if (!hasStrongTransferEvidence(left) || !hasStrongTransferEvidence(right)) continue;

        const leftDate = Date.parse(`${left.date || ""}T00:00:00Z`);
        const rightDate = Date.parse(`${right.date || ""}T00:00:00Z`);
        if (!Number.isFinite(leftDate) || !Number.isFinite(rightDate)) continue;
        const dayDifference = Math.abs(leftDate - rightDate) / (24 * 60 * 60 * 1000);
        if (dayDifference > 3) continue;

        matchedIds.add(left.id);
        matchedIds.add(right.id);
      }
    }
  }

  return transactions.map((transaction) => ({
    ...transaction,
    internalTransferMatch: matchedIds.has(transaction.id),
  }));
}

function hashTransactionSet({ year, mode, selectedTransactionIds = [], transactions = [], sourceAccountCount = 0 }) {
  const hash = crypto.createHash("sha256");
  const transactionKeys = dedupeTransactions(transactions).map((transaction) => transactionDedupeKey(transaction));
  hash.update([
    `year:${year}`,
    `mode:${mode}`,
    `accounts:${sourceAccountCount}`,
    `selected:${[...selectedTransactionIds].slice().sort().join("|")}`,
    `transactions:${transactionKeys.join("|")}`,
  ].join("\n"));
  return hash.digest("hex");
}

function buildReviewDiagnostics({
  review,
  uid,
  reusedExistingReview,
  pollingReviewId = null,
  activeReviewId = null,
  sourceYear = null,
  sourceAccountCount = null,
  transactionSetHash = null,
}) {
  return {
    reviewId: maskIdentifier(review?.id),
    uid: maskIdentifier(uid),
    status: review?.status || null,
    currentPhase: review?.currentPhase || null,
    processedTransactions: Number(review?.processedTransactions ?? 0),
    totalTransactions: Number(review?.totalTransactions ?? 0),
    processedBatches: Number(review?.processedBatches ?? 0),
    totalBatches: Number(review?.totalBatches ?? 0),
    progressPercent: Number(review?.progressPercent ?? 0),
    createdAt: review?.createdAt || null,
    updatedAt: review?.updatedAt || null,
    transactionSetHash: transactionSetHash ? `${String(transactionSetHash).slice(0, 8)}...` : null,
    sourceYear,
    sourceAccountCount,
    reusedExistingReview: Boolean(reusedExistingReview),
    pollingReviewId: pollingReviewId ? maskIdentifier(pollingReviewId) : null,
    activeReviewId: activeReviewId ? maskIdentifier(activeReviewId) : null,
  };
}

function isActiveReviewStatus(status) {
  return ["queued", "preparing", "processing", "running"].includes(String(status || "").toLowerCase());
}

function isStalledReview(review) {
  if (!review || !isActiveReviewStatus(review.status)) {
    return false;
  }

  const timestamp = Date.parse(review.updatedAt || review.createdAt || "");
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return Date.now() - timestamp > 5 * 60 * 1000;
}

function findLatestReviewForYear(reviews, year) {
  return (Array.isArray(reviews) ? reviews : [])
    .filter((review) => review?.year === year)
    .sort((left, right) => reviewSortValue(right).localeCompare(reviewSortValue(left)))[0] || null;
}

function buildTaxCenterCounts(transactions, latestReview = null) {
  const postedTransactions = (Array.isArray(transactions) ? transactions : []).filter((transaction) => transaction?.pending !== true);
  const reviewableTransactions = postedTransactions.filter(isReviewableTaxTransaction);
  const actionableTransactions = postedTransactions.filter((transaction) =>
    resolvedTransactionType(transaction) !== "income" && !transaction.userConfirmed
  );
  const expenseTransactions = postedTransactions.filter(isExpenseTransaction);
  const processingReview = latestReview && isActiveReviewStatus(latestReview.status) && !isStalledReview(latestReview)
    ? latestReview
    : null;

  return {
    totalTransactions: postedTransactions.filter((transaction) => resolvedTransactionType(transaction) !== "income").length,
    unreviewedTransactionCount: actionableTransactions.length,
    manualReviewCount: postedTransactions.filter(isManualReviewTransaction).length,
    aiEligibleTransactionCount: reviewableTransactions.filter(isAiEligibleTransaction).length,
    aiReviewProcessingCount: Number(processingReview?.processedTransactions ?? processingReview?.progress?.processed ?? 0),
    aiSuggestionCount: Array.isArray(latestReview?.suggestions)
      ? latestReview.suggestions.length
      : postedTransactions.filter((transaction) => transaction.classificationSource === "ai_suggestion").length,
    unappliedAiSuggestionCount: postedTransactions.filter(isUnappliedAiSuggestion).length,
    confirmedBusinessCount: expenseTransactions.filter((transaction) => transaction.userConfirmed && transaction.classification === "business").length,
    confirmedPersonalCount: expenseTransactions.filter((transaction) => transaction.userConfirmed && transaction.classification === "personal").length,
    excludedCount: postedTransactions.filter((transaction) => transaction.classification === "excluded").length,
  };
}

function buildSummary(transactions, threshold) {
  const summary = {
    totalBusiness: 0,
    totalPersonal: 0,
    totalNeedsReview: 0,
    totalPotentiallyDeductible: 0,
    totalConfirmedByUser: 0,
    totalSuggestedByAI: 0,
    totalExcluded: 0,
    totalIncome: 0,
    counts: {
      all: transactions.length,
      business: 0,
      personal: 0,
      needs_review: 0,
      excluded: 0,
      deductible: 0,
      ai_suggestions: 0,
      confirmed: 0,
      high_confidence: 0,
    },
    taxCenterCounts: {
      totalTransactions: 0,
      unreviewedTransactionCount: 0,
      manualReviewCount: 0,
      aiEligibleTransactionCount: 0,
      aiReviewProcessingCount: 0,
      aiSuggestionCount: 0,
      unappliedAiSuggestionCount: 0,
      confirmedBusinessCount: 0,
      confirmedPersonalCount: 0,
      excludedCount: 0,
    },
  };

  for (const transaction of transactions) {
    const value = Math.abs(Number(transaction.amount || 0));
    const transactionType = resolvedTransactionType(transaction);
    const isExcludedType = transactionType === "transfer" || transactionType === "refund";
    const isPending = transaction.pending === true;
    const isReportableIncome = transactionType === "income" &&
      transaction.classification !== "excluded" &&
      transaction.classification !== "personal" &&
      !isExcludedType &&
      !isPending;
    const isBusinessExpense = transactionType === "expense" &&
      transaction.classification === "business" &&
      !isPending;

    if (isReportableIncome) {
      summary.totalIncome += value;
    }

    switch (transaction.classification) {
      case "business":
        if (isBusinessExpense) summary.totalBusiness += value;
        summary.counts.business += 1;
        break;
      case "personal":
        summary.totalPersonal += value;
        summary.counts.personal += 1;
        break;
      case "excluded":
        summary.totalExcluded += value;
        summary.counts.excluded += 1;
        break;
      default:
        summary.totalNeedsReview += value;
        summary.counts.needs_review += 1;
        break;
    }

    const isHighConfidenceAutomaticDeduction =
      Number(transaction.confidence || 0) >= threshold &&
      ["imported", "ai_suggestion", "ai_approved", "user_rule"].includes(transaction.classificationSource);
    if (
      transactionType === "expense" &&
      !isPending &&
      transaction.classification === "business" &&
      (transaction.deductibility === "deductible" || transaction.deductibility === "partially_deductible") &&
      (transaction.userConfirmed || isHighConfidenceAutomaticDeduction)
    ) {
      const percentage = transaction.deductibility === "partially_deductible"
        ? Math.max(0, Math.min(100, Number(transaction.businessUsePercentage || 0))) / 100
        : 1;
      summary.totalPotentiallyDeductible += value * percentage;
      summary.counts.deductible += 1;
    }

    if (transaction.userConfirmed) {
      summary.totalConfirmedByUser += value;
      summary.counts.confirmed += 1;
    }

    if (transaction.classificationSource === "ai_suggestion") {
      summary.totalSuggestedByAI += value;
      summary.counts.ai_suggestions += 1;
    }

    if (Number(transaction.confidence || 0) >= threshold) {
      summary.counts.high_confidence += 1;
    }
  }

  return summary;
}

function buildSummaryTransactions(transactions, latestReview, threshold) {
  const source = Array.isArray(transactions) ? transactions : [];
  const suggestions = Array.isArray(latestReview?.suggestions) ? latestReview.suggestions : [];
  if (!suggestions.length) return source;

  const safeSuggestions = new Map();
  for (const suggestion of suggestions) {
    if (!suggestion?.transactionId) continue;
    const confidence = Number(suggestion.confidence || 0);
    const isSafe =
      suggestion.requiresUserReview !== true &&
      suggestion.classification !== "needs_review" &&
      suggestion.deductibility !== "needs_review" &&
      confidence >= threshold;
    if (isSafe) safeSuggestions.set(suggestion.transactionId, suggestion);
  }
  if (!safeSuggestions.size) return source;

  return source.map((transaction) => {
    if (transaction.userConfirmed || ["manual", "user_rule", "ai_approved"].includes(transaction.classificationSource)) {
      return transaction;
    }
    const suggestion = safeSuggestions.get(transaction.id) || safeSuggestions.get(transaction.plaidTransactionId);
    if (!suggestion) return transaction;
    return applyPatchToTransaction(transaction, {
      classification: suggestion.classification,
      transactionType: suggestion.transactionType,
      deductibility: suggestion.deductibility,
      taxCategory: suggestion.taxCategory,
      businessUsePercentage: suggestion.businessUsePercentage,
      classificationSource: "ai_suggestion",
      confidence: suggestion.confidence,
      aiReason: suggestion.reason,
      userConfirmed: false,
      reviewId: latestReview.id,
      reviewedAt: suggestion.reviewedAt,
    });
  });
}

function applyPatchToTransaction(current, patch) {
  const next = {
    ...current,
    ...compactObject({
      classification: patch.classification,
      transactionType: patch.transactionType,
      deductibility: patch.deductibility,
      businessUsePercentage: patch.businessUsePercentage,
      taxCategory: patch.taxCategory,
      scheduleCategory: patch.scheduleCategory,
      userNote: patch.userNote,
      aiReason: patch.aiReason,
      confidence: patch.confidence,
      classificationSource: patch.classificationSource,
      lastAppliedRuleId: patch.lastAppliedRuleId,
      reviewId: patch.reviewId,
    }),
    userConfirmed: patch.userConfirmed ?? current.userConfirmed ?? false,
    reviewedAt: patch.reviewedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const finalType = resolvedTransactionType(next);
  next.transactionType = finalType;
  next.isIncome = finalType === "income";
  next.schemaVersion = Math.max(2, Number(next.schemaVersion || 1));
  return next;
}

function buildApplyPreview(review, options, highConfidenceThreshold) {
  const suggestions = Array.isArray(review.suggestions) ? review.suggestions : [];
  let selected = suggestions;

  if (options.mode === "selected") {
    const selectedIds = new Set(options.transactionIds || []);
    selected = suggestions.filter((item) => selectedIds.has(item.transactionId));
  } else if (options.mode === "high_confidence") {
    selected = suggestions.filter((item) => Number(item.confidence || 0) >= highConfidenceThreshold);
  }

  return {
    suggestions: selected,
    count: selected.length,
    totalAmount: selected.reduce((sum, item) => sum + Math.abs(Number(item.amount || 0)), 0),
  };
}

export function createTaxRouter({
  taxStore,
  plaidStore,
  plaidClient,
  decryptSecret,
  encryptionKey,
  openaiClient,
  logger = console,
  config = buildTaxConfigFromEnv(process.env),
}) {
  const router = express.Router();
  router.use(createTaxRateLimiter());

  router.get("/transactions", async (req, res) => {
    try {
      const year = normalizeYear(req.query.year);
      const range = yearDateRange(year);
      const allRules = await taxStore.listRules(req.auth.uid);
      const rawTransactions = await fetchPlaidTransactionsForUser({
        uid: req.auth.uid,
        store: plaidStore,
        plaidClient,
        decryptSecret,
        encryptionKey,
        itemId: String(req.query.item_id || "").trim() || null,
        startDate: range.startDate,
        endDate: range.endDate,
        logger,
      });
      const replacedPendingIds = new Set(
        rawTransactions
          .filter((transaction) => !transaction.pending && transaction.pendingTransactionId)
          .map((transaction) => transaction.pendingTransactionId)
      );
      const liveTransactions = rawTransactions.filter((transaction) => {
        if (!transaction.pending) return true;
        return !replacedPendingIds.has(transaction.id);
      });
      const reconciledTransactions = markMatchedInternalTransfers(liveTransactions);
      const storedTransactions = await taxStore.listTransactions(req.auth.uid);
      const storedMap = new Map(storedTransactions.map((item) => [item.plaidTransactionId || item.id, item]));

      const merged = reconciledTransactions.map((transaction) => {
        const existing = storedMap.get(transaction.plaidTransactionId) || storedMap.get(transaction.id) || (
          transaction.pendingTransactionId
            ? storedMap.get(transaction.pendingTransactionId)
            : null
        );
        const pendingSource = transaction.pendingTransactionId
          ? storedMap.get(transaction.pendingTransactionId)
          : null;
        const deterministic = deterministicSuggestion(transaction, allRules);
        const protectedExisting = existing && (
          existing.userConfirmed ||
          ["manual", "user_rule", "ai_approved"].includes(existing.classificationSource)
        );
        const modernAiSuggestion = existing &&
          existing.classificationSource === "ai_suggestion" &&
          Number(existing.schemaVersion || 1) >= 2;

        const automaticSeed = mergePendingClassification({
          ...transaction,
          classification: deterministic?.classification || "needs_review",
          deductibility: deterministic?.deductibility || "needs_review",
          businessUsePercentage: deterministic?.businessUsePercentage || null,
          taxCategory: deterministic?.taxCategory || (Number(transaction.amount || 0) < 0 ? "Unclassified inflow" : null),
          classificationSource: deterministic?.classificationSource || "imported",
          confidence: deterministic?.confidence || null,
          aiReason: deterministic?.reason || (Number(transaction.amount || 0) < 0
            ? "Money entered the account, but there is not enough evidence yet to call it taxable income."
            : null),
          userConfirmed: deterministic?.classificationSource === "user_rule",
          transactionType: deterministic?.transactionType || (Number(transaction.amount || 0) < 0 ? "transfer" : "expense"),
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userNote: existing?.userNote || "",
          flags: deterministic?.flags || (Number(transaction.amount || 0) < 0 ? ["unclassified_inflow"] : []),
          schemaVersion: 2,
        }, pendingSource);

        // Preserve explicit human decisions and current-version AI suggestions. Everything
        // imported by the old `inflow = income` engine is reclassified automatically.
        const seeded = protectedExisting || modernAiSuggestion ? existing : automaticSeed;
        const finalTransactionType = resolvedTransactionType(seeded);

        return buildTransactionResponse({
          ...seeded,
          ...transaction,
          classification: seeded.classification,
          deductibility: seeded.deductibility,
          businessUsePercentage: seeded.businessUsePercentage,
          taxCategory: seeded.taxCategory,
          scheduleCategory: seeded.scheduleCategory,
          userNote: seeded.userNote,
          classificationSource: seeded.classificationSource,
          confidence: seeded.confidence,
          aiReason: seeded.aiReason,
          userConfirmed: seeded.userConfirmed,
          reviewedAt: seeded.reviewedAt,
          createdAt: seeded.createdAt,
          updatedAt: new Date().toISOString(),
          flags: seeded.flags || [],
          lastAppliedRuleId: seeded.lastAppliedRuleId || null,
          transactionType: finalTransactionType,
          isIncome: finalTransactionType === "income",
          schemaVersion: Math.max(2, Number(seeded.schemaVersion || 1)),
          id: transaction.id,
          plaidTransactionId: transaction.plaidTransactionId,
        });
      });

      await taxStore.bulkUpsertTransactions(req.auth.uid, merged);
      const refreshed = dedupeTransactions((await taxStore.listTransactions(req.auth.uid))
        .filter((record) => new Date(record.date || "").getUTCFullYear() === year)
        .filter((record) => {
          if (replacedPendingIds.has(record.id) || replacedPendingIds.has(record.plaidTransactionId)) {
            return false;
          }
          return true;
        }));
      const latestReview = findLatestReviewForYear(await taxStore.listReviews(req.auth.uid), year);
      const scopedTransactions = refreshed.filter((record) => passesFilters(record, req.query));
      const effectiveScopedTransactions = buildSummaryTransactions(
        scopedTransactions,
        latestReview,
        config.highConfidenceThreshold
      );
      const taxCenterCounts = buildTaxCenterCounts(refreshed, latestReview);
      const summary = {
        ...buildSummary(effectiveScopedTransactions, config.highConfidenceThreshold),
        taxCenterCounts,
      };

      return res.json({
        ok: true,
        year,
        transactions: scopedTransactions.map(buildTransactionResponse),
        summary,
        latestReview: latestReview ? buildReviewResponse(latestReview, taxCenterCounts) : null,
        rulesCount: allRules.length,
      });
    } catch (error) {
      logger.error("TAX TRANSACTIONS ERROR", errorSummary(error));
      return res.status(500).json({
        ok: false,
        error: "Failed to load tax transactions.",
      });
    }
  });

  router.get("/transactions/duplicates/report", async (req, res) => {
    try {
      const year = normalizeYear(req.query.year);