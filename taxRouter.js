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
      const allTransactions = await taxStore.listTransactions(req.auth.uid);
      const yearTransactions = allTransactions.filter((transaction) => new Date(transaction.date || "").getUTCFullYear() === year);
      const grouped = new Map();
      for (const transaction of yearTransactions) {
        const key = transactionDedupeKey(transaction);
        if (!key) continue;
        const items = grouped.get(key) || [];
        items.push(transaction);
        grouped.set(key, items);
      }

      const duplicates = Array.from(grouped.values()).filter((items) => items.length > 1);
      const pendingPostedPairs = duplicates.filter((items) => items.some((item) => item.pending) && items.some((item) => !item.pending)).length;
      return res.json({
        ok: true,
        year,
        totalDocuments: yearTransactions.length,
        uniquePlaidTransactionIds: grouped.size,
        duplicatesFound: duplicates.length,
        pendingPostedPairs,
      });
    } catch (error) {
      logger.error("TAX DUPLICATE REPORT ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to build duplicate report." });
    }
  });

  router.patch("/transactions/:transactionId", async (req, res) => {
    try {
      const current = await taxStore.getTransaction(req.auth.uid, req.params.transactionId);
      if (!current) {
        return res.status(404).json({ ok: false, error: "Transaction not found." });
      }

      const patch = {
        classification: req.body?.classification,
        deductibility: req.body?.deductibility,
        businessUsePercentage: req.body?.businessUsePercentage,
        taxCategory: req.body?.taxCategory,
        scheduleCategory: req.body?.scheduleCategory,
        userNote: req.body?.userNote,
        classificationSource: "manual",
        userConfirmed: true,
      };

      const updated = await taxStore.upsertTransaction(
        req.auth.uid,
        applyPatchToTransaction(current, patch)
      );

      return res.json({ ok: true, transaction: buildTransactionResponse(updated) });
    } catch (error) {
      logger.error("TAX PATCH TRANSACTION ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to update transaction." });
    }
  });

  router.post("/transactions/bulk-classify", async (req, res) => {
    try {
      const transactionIds = Array.isArray(req.body?.transactionIds) ? req.body.transactionIds : [];
      if (!transactionIds.length) {
        return res.status(400).json({ ok: false, error: "Missing transactionIds." });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({ ok: false, error: "Bulk changes require explicit confirmation." });
      }

      const saved = [];
      for (const transactionId of transactionIds) {
        const current = await taxStore.getTransaction(req.auth.uid, transactionId);
        if (!current) continue;
        saved.push(await taxStore.upsertTransaction(
          req.auth.uid,
          applyPatchToTransaction(current, {
            classification: req.body?.classification,
            deductibility: req.body?.deductibility,
            taxCategory: req.body?.taxCategory,
            businessUsePercentage: req.body?.businessUsePercentage,
            classificationSource: "manual",
            userConfirmed: true,
          })
        ));
      }

      return res.json({ ok: true, updated: saved.length, transactions: saved.map(buildTransactionResponse) });
    } catch (error) {
      logger.error("TAX BULK CLASSIFY ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to apply bulk classification." });
    }
  });

  function buildCandidatesForReview({ yearTransactions, mode, selectedIds = [], reprocess = false }) {
    let candidates = Array.isArray(yearTransactions) ? yearTransactions : [];
    if (mode === "selected") {
      const selectedSet = new Set(selectedIds);
      candidates = candidates.filter((transaction) =>
        selectedSet.has(transaction.id) && isReviewableTaxTransaction(transaction)
      );
    } else if (mode === "review_only") {
      candidates = candidates.filter((transaction) =>
        isReviewableTaxTransaction(transaction) &&
        !transaction.userConfirmed &&
        transaction.classification === "needs_review" &&
        transaction.classificationSource !== "ai_suggestion"
      );
    } else if (mode === "unreviewed") {
      candidates = candidates.filter((transaction) =>
        reprocess ? isReviewableTaxTransaction(transaction) : isAiEligibleTransaction(transaction)
      );
    } else {
      // Full-year audit. Obvious income/transfers/refunds are already resolved by the
      // deterministic layer; every remaining tax-relevant transaction is audited here.
      candidates = candidates.filter((transaction) => isReviewableTaxTransaction(transaction));
    }
    return dedupeTransactions(candidates);
  }

  async function finalizeCompletedReview({ uid, review, candidates, selectedIds, initialCreatedAt }) {
    const totalTransactions = candidates.length;
    const totalBatches = Math.ceil(totalTransactions / config.batchSize);
    const progressTotals = {
      processedTransactions: review.processedTransactions ?? totalTransactions,
      totalTransactions: review.totalTransactions ?? totalTransactions,
      processedBatches: review.processedBatches ?? totalBatches,
      totalBatches: review.totalBatches ?? totalBatches,
      heartbeatAt: new Date().toISOString(),
      sourceTransactionCount: review.sourceTransactionCount ?? null,
      autoResolvedTransactions: review.autoResolvedTransactions ?? 0,
      aiRequestedTransactions: review.aiRequestedTransactions ?? 0,
      aiCompletedTransactions: review.aiCompletedTransactions ?? 0,
      aiFailedTransactions: review.aiFailedTransactions ?? 0,
    };

    await taxStore.upsertReview(uid, buildReviewProgressRecord({
      ...review,
      id: review.id,
      year: review.year,
      mode: review.mode,
      status: REVIEW_STATUS.PROCESSING,
      currentPhase: "saving",
      selectedTransactionIds: selectedIds,
      createdAt: initialCreatedAt || review.createdAt,
      suggestions: review.suggestions || [],
      ...progressTotals,
    }));

    const persistedSuggestions = [];
    for (const suggestion of review.suggestions || []) {
      const current = await taxStore.getTransaction(uid, suggestion.transactionId);
      if (!current) continue;
      if (current.userConfirmed || ["manual", "user_rule"].includes(current.classificationSource)) {
        continue;
      }
      const transaction = await taxStore.upsertTransaction(uid, applyPatchToTransaction(current, {
        classification: suggestion.classification,
        transactionType: suggestion.transactionType,
        deductibility: suggestion.deductibility,
        taxCategory: suggestion.taxCategory,
        businessUsePercentage: suggestion.businessUsePercentage,
        classificationSource: "ai_suggestion",
        confidence: suggestion.confidence,
        aiReason: suggestion.reason,
        userConfirmed: false,
        reviewId: review.id,
      }));
      persistedSuggestions.push({ transaction, suggestion });
    }

    const savedSuggestions = persistedSuggestions.map(({ transaction, suggestion }) => ({
      transactionId: transaction.id,
      transactionType: suggestion.transactionType,
      classification: transaction.classification,
      deductibility: transaction.deductibility,
      taxCategory: transaction.taxCategory,
      businessUsePercentage: suggestion.businessUsePercentage ?? null,
      confidence: transaction.confidence,
      reason: transaction.aiReason,
      requiresUserReview: suggestion.requiresUserReview !== false,
      flags: suggestion.flags || [],
      merchantIdentity: suggestion.merchantIdentity || null,
      webLookupUsed: suggestion.webLookupUsed === true,
      source: suggestion.source || (suggestion.webLookupUsed ? "aiAndWeb" : "ai"),
      modelVersion: suggestion.modelVersion || config.model,
      ruleVersion: suggestion.ruleVersion || "tax-rules-v5-audit-control",
      reviewedAt: suggestion.reviewedAt || new Date().toISOString(),
    }));

    const finalizingReview = await taxStore.upsertReview(uid, buildReviewProgressRecord({
      ...review,
      id: review.id,
      year: review.year,
      mode: review.mode,
      status: REVIEW_STATUS.PROCESSING,
      currentPhase: "finalizing",
      selectedTransactionIds: selectedIds,
      createdAt: initialCreatedAt || review.createdAt,
      suggestions: savedSuggestions,
      ...progressTotals,
      heartbeatAt: new Date().toISOString(),
    }));

    return taxStore.upsertReview(uid, buildReviewProgressRecord({
      ...finalizingReview,
      id: review.id,
      year: review.year,
      mode: review.mode,
      status: REVIEW_STATUS.COMPLETED,
      currentPhase: "completed",
      selectedTransactionIds: selectedIds,
      createdAt: initialCreatedAt || review.createdAt,
      suggestions: savedSuggestions,
      ...progressTotals,
      heartbeatAt: new Date().toISOString(),
    }));
  }

  function launchReviewWorker({ uid, review, candidates, selectedIds = [] }) {
    void (async () => {
      try {
        const rules = await taxStore.listRules(uid);
        const result = await runTaxAiReview({
          uid,
          store: taxStore,
          openaiClient,
          logger,
          config,
          reviewId: review.id,
          year: review.year,
          mode: review.mode,
          transactions: candidates,
          rules,
          selectedTransactionIds: selectedIds,
          transactionSetHash: review.transactionSetHash,
          sourceYear: review.sourceYear ?? review.year,
          sourceAccountCount: review.sourceAccountCount ?? 0,
          sourceTransactionCount: review.sourceTransactionCount ?? null,
          resumeFromProcessedTransactions: review.processedTransactions || 0,
          resumeFromProcessedBatches: review.processedBatches || 0,
          initialSuggestions: review.suggestions || [],
          initialAutoResolvedTransactions: review.autoResolvedTransactions || 0,
          initialAiRequestedTransactions: review.aiRequestedTransactions || 0,
          initialAiCompletedTransactions: review.aiCompletedTransactions || 0,
          initialAiFailedTransactions: review.aiFailedTransactions || 0,
          createdAt: review.createdAt,
          readControlState: async () => {
            const current = await taxStore.getReview(uid, review.id);
            return current?.status || REVIEW_STATUS.PROCESSING;
          },
        });

        if ([REVIEW_STATUS.PAUSED, REVIEW_STATUS.CANCELLED].includes(result.status)) {
          return;
        }
        if (result.status !== REVIEW_STATUS.COMPLETED) {
          return;
        }
        await finalizeCompletedReview({
          uid,
          review: result,
          candidates,
          selectedIds,
          initialCreatedAt: review.createdAt,
        });
      } catch (backgroundError) {
        logger.error("TAX AI REVIEW BACKGROUND ERROR", errorSummary(backgroundError));
        const current = await taxStore.getReview(uid, review.id);
        // runTaxAiReview already persists a durable failure/paused checkpoint. Only create
        // a fallback failure record when no state was saved at all.
        if (!current || isActiveReviewStatus(current.status)) {
          const structuredCode = backgroundError?.phase === "validation"
            ? "INVALID_STRUCTURED_OUTPUT"
            : backgroundError?.details?.code || backgroundError?.details?.type || backgroundError?.code || "REVIEW_INTERRUPTED";
          await taxStore.upsertReview(uid, buildReviewProgressRecord({
            ...review,
            id: review.id,
            status: REVIEW_STATUS.FAILED,
            currentPhase: "failed",
            processedTransactions: current?.processedTransactions || review.processedTransactions || 0,
            totalTransactions: current?.totalTransactions || review.totalTransactions || candidates.length,
            processedBatches: current?.processedBatches || review.processedBatches || 0,
            totalBatches: current?.totalBatches || review.totalBatches || Math.ceil(candidates.length / config.batchSize),
            selectedTransactionIds: selectedIds,
            sourceTransactionCount: current?.sourceTransactionCount ?? review.sourceTransactionCount ?? null,
            autoResolvedTransactions: current?.autoResolvedTransactions || review.autoResolvedTransactions || 0,
            aiRequestedTransactions: current?.aiRequestedTransactions || review.aiRequestedTransactions || 0,
            aiCompletedTransactions: current?.aiCompletedTransactions || review.aiCompletedTransactions || 0,
            aiFailedTransactions: current?.aiFailedTransactions || review.aiFailedTransactions || 0,
            suggestions: current?.suggestions || review.suggestions || [],
            heartbeatAt: new Date().toISOString(),
            errorMessage: backgroundError?.message || "AI Tax Review was interrupted. Your completed progress was saved.",
            errorCode: structuredCode,
          }));
        }
      }
    })();
  }

  router.post("/ai/review", async (req, res) => {
    try {
      if (!config.enabled) {
        return res.status(403).json({ ok: false, error: "AI Tax Review is disabled." });
      }

      const year = normalizeYear(req.body?.year);
      const mode = ["unreviewed", "review_only", "selected", "all"].includes(req.body?.mode) ? req.body.mode : "unreviewed";
      const reprocess = req.body?.reprocess === true;
      const autoApplyHighConfidence = config.autoApplyEnabled && req.body?.autoApplyHighConfidence === true;
      const selectedIds = Array.isArray(req.body?.transactionIds) ? req.body.transactionIds : [];
      const selectedKey = [...selectedIds].sort().join("|");
      const existingReviews = await taxStore.listReviews(req.auth.uid);
      const allTransactions = await taxStore.listTransactions(req.auth.uid);
      const yearTransactions = dedupeTransactions(allTransactions.filter((transaction) =>
        new Date(transaction.date || "").getUTCFullYear() === year && transaction.pending !== true
      ));
      const latestReview = findLatestReviewForYear(existingReviews, year);
      const currentTaxCenterCounts = buildTaxCenterCounts(yearTransactions, latestReview);
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = existingReviews.filter((review) => String(review.createdAt || "").slice(0, 10) === today).length;
      if (todayCount >= config.dailyRunLimit) {
        return res.status(429).json({ ok: false, error: "Daily AI tax review limit reached." });
      }

      const existing = existingReviews.find((review) =>
        review.year === year &&
        review.mode === mode &&
        String((review.selectedTransactionIds || []).slice().sort().join("|")) === selectedKey &&
        ["queued", "running", "preparing", "processing"].includes(String(review.status || "").toLowerCase())
      );
      if (existing && isStalledReview(existing)) {
        await taxStore.upsertReview(req.auth.uid, buildReviewProgressRecord({
          ...existing,
          status: REVIEW_STATUS.PAUSED,
          currentPhase: "paused",
          errorMessage: "AI Tax Review was interrupted. Progress is saved and can be resumed.",
          errorCode: "REVIEW_INTERRUPTED",
          heartbeatAt: new Date().toISOString(),
        }));
      }

      const candidates = buildCandidatesForReview({ yearTransactions, mode, selectedIds, reprocess });
      const sourceAccountCount = new Set(
        yearTransactions.map((transaction) => String(transaction.accountId || transaction.itemId || "").trim()).filter(Boolean)
      ).size;
      const transactionSetHash = hashTransactionSet({
        year,
        mode,
        selectedTransactionIds: selectedIds,
        transactions: candidates,
        sourceAccountCount,
      });
      const matchingReview = existingReviews.find((review) =>
        review.year === year &&
        review.mode === mode &&
        review.transactionSetHash === transactionSetHash &&
        String((review.selectedTransactionIds || []).slice().sort().join("|")) === selectedKey &&
        ["queued", "running", "preparing", "processing"].includes(String(review.status || "").toLowerCase())
      );

      if (shouldReuseExistingReview(matchingReview, currentTaxCenterCounts)) {
        return res.json({ ok: true, review: buildReviewResponse(matchingReview, currentTaxCenterCounts), reused: true });
      }

      const reviewId = nextReviewId();
      const totalTransactions = candidates.length;
      const totalBatches = Math.ceil(totalTransactions / config.batchSize);
      const initialReview = await taxStore.upsertReview(req.auth.uid, buildReviewProgressRecord({
        id: reviewId,
        year,
        mode,
        status: REVIEW_STATUS.PREPARING,
        currentPhase: "preparing",
        processedTransactions: 0,
        totalTransactions,
        processedBatches: 0,
        totalBatches,
        selectedTransactionIds: selectedIds,
        autoApplyHighConfidence,
        transactionSetHash,
        sourceYear: year,
        sourceAccountCount,
        sourceTransactionCount: yearTransactions.length,
        heartbeatAt: new Date().toISOString(),
      }));
      const initialTaxCenterCounts = buildTaxCenterCounts(yearTransactions, initialReview);

      launchReviewWorker({ uid: req.auth.uid, review: initialReview, candidates, selectedIds });
      return res.status(201).json({ ok: true, review: buildReviewResponse(initialReview, initialTaxCenterCounts) });
    } catch (error) {
      logger.error("TAX AI REVIEW ERROR", errorSummary(error));
      return res.status(503).json({ ok: false, error: error?.message || "AI Tax Review is temporarily unavailable. Please try again." });
    }
  });

  router.get("/ai/reviews/:reviewId", async (req, res) => {
    const review = await taxStore.getReview(req.auth.uid, req.params.reviewId);
    if (!review) {
      return res.status(404).json({ ok: false, error: "AI review not found." });
    }
    if (isStalledReview(review)) {
      const stalledReview = await taxStore.upsertReview(req.auth.uid, buildReviewProgressRecord({
        ...review,
        status: REVIEW_STATUS.PAUSED,
        currentPhase: "paused",
        errorMessage: "AI Tax Review was interrupted. Completed progress is saved and can be resumed.",
        errorCode: "REVIEW_INTERRUPTED",
        heartbeatAt: new Date().toISOString(),
      }));
      const yearTransactions = dedupeTransactions((await taxStore.listTransactions(req.auth.uid))
        .filter((item) => new Date(item.date || "").getUTCFullYear() === review.year));
      const taxCenterCounts = buildTaxCenterCounts(yearTransactions, stalledReview);
      return res.json({ ok: true, review: buildReviewResponse(stalledReview, taxCenterCounts) });
    }
    const yearTransactions = (await taxStore.listTransactions(req.auth.uid))
      .filter((item) => new Date(item.date || "").getUTCFullYear() === review.year);
    const dedupedYearTransactions = dedupeTransactions(yearTransactions);
    const taxCenterCounts = buildTaxCenterCounts(dedupedYearTransactions, review);
    return res.json({ ok: true, review: buildReviewResponse(review, taxCenterCounts) });
  });

  router.post("/ai/reviews/:reviewId/pause", async (req, res) => {
    try {
      const review = await taxStore.getReview(req.auth.uid, req.params.reviewId);
      if (!review) return res.status(404).json({ ok: false, error: "AI review not found." });
      if (!["queued", "running", "preparing", "processing"].includes(String(review.status || "").toLowerCase())) {
        return res.json({ ok: true, review: buildReviewResponse(review), changed: false });
      }
      const paused = await taxStore.upsertReview(req.auth.uid, buildReviewProgressRecord({
        ...review,
        status: REVIEW_STATUS.PAUSED,
        currentPhase: "paused",
        suggestions: review.suggestions || [],
        heartbeatAt: new Date().toISOString(),
        errorMessage: "AI Tax Review is paused. Completed progress is saved.",
        errorCode: "PAUSED_BY_USER",
      }));
      return res.json({ ok: true, review: buildReviewResponse(paused), changed: true });
    } catch (error) {
      logger.error("TAX AI PAUSE ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to pause AI Tax Review." });
    }
  });

  router.post("/ai/reviews/:reviewId/resume", async (req, res) => {
    try {
      const review = await taxStore.getReview(req.auth.uid, req.params.reviewId);
      if (!review) return res.status(404).json({ ok: false, error: "AI review not found." });
      if (String(review.status || "").toLowerCase() !== REVIEW_STATUS.PAUSED) {
        return res.status(409).json({ ok: false, error: "Only a paused AI review can be resumed." });
      }

      const allTransactions = await taxStore.listTransactions(req.auth.uid);
      const yearTransactions = dedupeTransactions(allTransactions.filter((transaction) =>
        new Date(transaction.date || "").getUTCFullYear() === review.year && transaction.pending !== true
      ));
      const selectedIds = Array.isArray(review.selectedTransactionIds) ? review.selectedTransactionIds : [];
      const candidates = buildCandidatesForReview({
        yearTransactions,
        mode: review.mode,
        selectedIds,
        reprocess: review.mode === "all",
      });
      const sourceAccountCount = new Set(
        yearTransactions.map((transaction) => String(transaction.accountId || transaction.itemId || "").trim()).filter(Boolean)
      ).size;
      const currentHash = hashTransactionSet({
        year: review.year,
        mode: review.mode,
        selectedTransactionIds: selectedIds,
        transactions: candidates,
        sourceAccountCount,
      });
      if (review.transactionSetHash && currentHash !== review.transactionSetHash) {
        return res.status(409).json({
          ok: false,
          error: "Bank activity changed since this review started. Start a new full-year audit so GigProfit can reconcile the new transactions safely.",
          errorCode: "TRANSACTION_SET_CHANGED",
        });
      }

      const resumed = await taxStore.upsertReview(req.auth.uid, buildReviewProgressRecord({
        ...review,
        status: REVIEW_STATUS.PROCESSING,
        currentPhase: "reviewing",
        totalTransactions: candidates.length,
        totalBatches: Math.ceil(candidates.length / config.batchSize),
        selectedTransactionIds: selectedIds,
        sourceAccountCount,
        sourceTransactionCount: yearTransactions.length,
        suggestions: review.suggestions || [],
        heartbeatAt: new Date().toISOString(),
        errorMessage: null,
        errorCode: null,
      }));
      launchReviewWorker({ uid: req.auth.uid, review: resumed, candidates, selectedIds });
      return res.json({ ok: true, review: buildReviewResponse(resumed), resumed: true });
    } catch (error) {
      logger.error("TAX AI RESUME ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to resume AI Tax Review." });
    }
  });

  router.post("/ai/reviews/:reviewId/cancel", async (req, res) => {
    try {
      const review = await taxStore.getReview(req.auth.uid, req.params.reviewId);
      if (!review) return res.status(404).json({ ok: false, error: "AI review not found." });
      const stopped = await taxStore.upsertReview(req.auth.uid, buildReviewProgressRecord({
        ...review,
        status: REVIEW_STATUS.CANCELLED,
        currentPhase: "cancelled",
        suggestions: review.suggestions || [],
        heartbeatAt: new Date().toISOString(),
        errorMessage: "AI Tax Review was stopped. Completed progress was kept.",
        errorCode: "CANCELLED_BY_USER",
      }));
      return res.json({ ok: true, review: buildReviewResponse(stopped), stopped: true });
    } catch (error) {
      logger.error("TAX AI CANCEL ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to stop AI Tax Review." });
    }
  });

  router.post("/ai/reviews/:reviewId/apply", async (req, res) => {
    try {
      const review = await taxStore.getReview(req.auth.uid, req.params.reviewId);
      if (!review) {
        return res.status(404).json({ ok: false, error: "AI review not found." });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({ ok: false, error: "Applying AI suggestions requires explicit confirmation." });
      }

      const preview = buildApplyPreview(review, {
        mode: req.body?.mode || "all",
        transactionIds: Array.isArray(req.body?.transactionIds) ? req.body.transactionIds : [],
      }, config.highConfidenceThreshold);
      if (!preview.count) {
        return res.status(400).json({ ok: false, error: "No AI suggestions are available to apply." });
      }

      const saved = [];
      const pendingWrites = [];
      let needsReview = 0;
      let skippedManual = 0;
      let invalid = 0;
      let failed = 0;
      for (const suggestion of preview.suggestions) {
        const current = await taxStore.getTransaction(req.auth.uid, suggestion.transactionId);
        if (!current) {
          invalid += 1;
          continue;
        }
        if (current.userConfirmed || ["manual", "user_rule"].includes(current.classificationSource)) {
          skippedManual += 1;
          continue;
        }
        const isSafe = suggestion.requiresUserReview !== true
          && suggestion.classification !== "needs_review"
          && suggestion.deductibility !== "needs_review"
          && Number(suggestion.confidence || 0) >= config.highConfidenceThreshold;
        if (!isSafe) {
          needsReview += 1;
          continue;
        }
        pendingWrites.push(applyPatchToTransaction(current, {
          classification: suggestion.classification,
          transactionType: suggestion.transactionType,
          deductibility: suggestion.deductibility,
          taxCategory: suggestion.taxCategory,
          classificationSource: "ai_approved",
          confidence: suggestion.confidence,
          aiReason: suggestion.reason,
          userConfirmed: true,
        }));
      }

      for (let index = 0; index < pendingWrites.length; index += 400) {
        const batch = pendingWrites.slice(index, index + 400);
        try {
          saved.push(...await taxStore.bulkUpsertTransactions(req.auth.uid, batch));
        } catch (error) {
          failed += batch.length;
          logger.error("TAX AI APPLY BATCH ERROR", {
            reviewId: String(req.params.reviewId || "").slice(0, 8),
            batchSize: batch.length,
            errorCode: error?.code || "BATCH_WRITE_FAILED",
          });
        }
      }

      await taxStore.upsertReview(req.auth.uid, {
        ...review,
        status: "applied",
        appliedAt: new Date().toISOString(),
      });

      return res.json({
        ok: true,
        updated: saved.length,
        applied: saved.length,
        needsReview,
        skippedManual,
        invalid,
        failed,
        transactions: saved.map(buildTransactionResponse),
        preview: {
          count: preview.count,
          message: `These are organization suggestions for tax review and do not replace professional advice.`,
        },
      });
    } catch (error) {
      logger.error("TAX AI APPLY ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to apply AI suggestions." });
    }
  });


  router.post("/ai/reset-active-review", async (req, res) => {
    try {
      const year = normalizeYear(req.body?.year);
      const reviews = await taxStore.listReviews(req.auth.uid);
      const active = reviews
        .filter((review) => review.year === year && isActiveReviewStatus(review.status))
        .sort((left, right) => reviewSortValue(right).localeCompare(reviewSortValue(left)))[0] || null;

      if (!active) {
        return res.json({ ok: true, reset: false });
      }

      const resetReview = await taxStore.upsertReview(req.auth.uid, buildReviewProgressRecord({
        ...active,
        id: active.id,
        status: REVIEW_STATUS.CANCELLED,
        currentPhase: "cancelled",
        processedTransactions: active.processedTransactions || 0,
        totalTransactions: active.totalTransactions || 0,
        processedBatches: active.processedBatches || 0,
        totalBatches: active.totalBatches || 0,
        heartbeatAt: new Date().toISOString(),
        errorMessage: "AI Tax Review was reset by the user.",
        errorCode: "MANUAL_RESET",
      }));

      return res.json({ ok: true, reset: true, review: buildReviewResponse(resetReview) });
    } catch (error) {
      logger.error("TAX AI RESET ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to reset AI Tax Review." });
    }
  });

  router.delete("/ai/reviews/:reviewId", async (req, res) => {
    const review = await taxStore.getReview(req.auth.uid, req.params.reviewId);
    if (!review) {
      return res.status(404).json({ ok: false, error: "AI review not found." });
    }
    await taxStore.deleteTransactionsByReview(req.auth.uid, req.params.reviewId);
    await taxStore.deleteReview(req.auth.uid, req.params.reviewId);
    return res.json({ ok: true, deleted: true });
  });

  router.get("/rules", async (req, res) => {
    const rules = await taxStore.listRules(req.auth.uid);
    return res.json({ ok: true, rules });
  });

  router.post("/rules", async (req, res) => {
    const rule = await taxStore.upsertRule(req.auth.uid, {
      merchantPattern: req.body?.merchantPattern || null,
      plaidCategory: req.body?.plaidCategory || null,
      accountScope: req.body?.accountScope || null,
      classification: req.body?.classification,
      deductibility: req.body?.deductibility,
      taxCategory: req.body?.taxCategory || null,
      businessUsePercentage: req.body?.businessUsePercentage ?? null,
      enabled: req.body?.enabled !== false,
      priority: req.body?.priority || 100,
      source: "user",
    });
    return res.status(201).json({ ok: true, rule });
  });

  router.patch("/rules/:ruleId", async (req, res) => {
    const current = await taxStore.getRule(req.auth.uid, req.params.ruleId);
    if (!current) {
      return res.status(404).json({ ok: false, error: "Rule not found." });
    }
    const rule = await taxStore.upsertRule(req.auth.uid, {
      ...current,
      merchantPattern: req.body?.merchantPattern ?? current.merchantPattern,
      plaidCategory: req.body?.plaidCategory ?? current.plaidCategory,
      accountScope: req.body?.accountScope ?? current.accountScope,
      classification: req.body?.classification ?? current.classification,
      deductibility: req.body?.deductibility ?? current.deductibility,
      taxCategory: req.body?.taxCategory ?? current.taxCategory,
      businessUsePercentage: req.body?.businessUsePercentage ?? current.businessUsePercentage,
      enabled: req.body?.enabled ?? current.enabled,
      priority: req.body?.priority ?? current.priority,
    });
    return res.json({ ok: true, rule });
  });

  router.delete("/rules/:ruleId", async (req, res) => {
    const deleted = await taxStore.deleteRule(req.auth.uid, req.params.ruleId);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: "Rule not found." });
    }
    return res.json({ ok: true, deleted: true });
  });

  router.post("/rules/:ruleId/apply-retroactively", async (req, res) => {
    const rule = await taxStore.getRule(req.auth.uid, req.params.ruleId);
    if (!rule) {
      return res.status(404).json({ ok: false, error: "Rule not found." });
    }
    if (req.body?.confirm !== true) {
      return res.status(400).json({ ok: false, error: "Retroactive rule application requires explicit confirmation." });
    }
    const transactions = await taxStore.listTransactions(req.auth.uid);
    const updated = [];
    for (const transaction of transactions) {
      const suggestion = deterministicSuggestion(transaction, [rule]);
      if (!suggestion || suggestion.classificationSource !== "user_rule") continue;
      updated.push(await taxStore.upsertTransaction(req.auth.uid, applyPatchToTransaction(transaction, {
        classification: suggestion.classification,
        deductibility: suggestion.deductibility,
        taxCategory: suggestion.taxCategory,
        businessUsePercentage: rule.businessUsePercentage ?? null,
        classificationSource: "user_rule",
        confidence: suggestion.confidence,
        aiReason: suggestion.reason,
        userConfirmed: true,
        lastAppliedRuleId: rule.id,
      })));
    }
    return res.json({ ok: true, updated: updated.length, transactions: updated.map(buildTransactionResponse) });
  });

  router.get("/summary", async (req, res) => {
    const year = normalizeYear(req.query.year);
    const transactions = (await taxStore.listTransactions(req.auth.uid))
      .filter((item) => new Date(item.date || "").getUTCFullYear() === year);
    const latestReview = findLatestReviewForYear(await taxStore.listReviews(req.auth.uid), year);
    const taxCenterCounts = buildTaxCenterCounts(transactions, latestReview);
    const effectiveTransactions = buildSummaryTransactions(
      transactions,
      latestReview,
      config.highConfidenceThreshold
    );
    return res.json({
      ok: true,
      year,
      summary: {
        ...buildSummary(effectiveTransactions, config.highConfidenceThreshold),
        taxCenterCounts,
      },
      latestReview: latestReview ? buildReviewResponse(latestReview, taxCenterCounts) : null,
    });
  });

  router.delete("/suggestions", async (req, res) => {
    const deleted = await taxStore.clearSuggestions(req.auth.uid);
    return res.json({ ok: true, deleted });
  });

  router.delete("/rules", async (req, res) => {
    const deleted = await taxStore.clearRules(req.auth.uid);
    return res.json({ ok: true, deleted });
  });

  return router;
}

export {
  buildTaxCenterCounts,
  buildReviewResponse,
  buildSummary,
  buildTransactionResponse,
  fetchPlaidTransactionsForUser,
  findLatestReviewForYear,
  mapPlaidTransaction,
  shouldReuseExistingReview,
  yearDateRange,
};
