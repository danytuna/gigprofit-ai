import express from "express";
import rateLimit from "express-rate-limit";

import { normalizeYear } from "./taxStore.js";
import { buildTaxConfigFromEnv, deterministicSuggestion, nextReviewId, runTaxAiReview } from "./taxAiService.js";

function createTaxRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 180,
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
    isIncome: Number(transaction.amount || 0) < 0,
    schemaVersion: 1,
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
    flags: record.flags,
  });
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
  };

  for (const transaction of transactions) {
    const value = Math.abs(Number(transaction.amount || 0));
    if (transaction.isIncome) {
      summary.totalIncome += value;
    }

    switch (transaction.classification) {
      case "business":
        summary.totalBusiness += value;
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

    if (transaction.deductibility === "deductible" || transaction.deductibility === "partially_deductible") {
      summary.totalPotentiallyDeductible += value;
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

function applyPatchToTransaction(current, patch) {
  const next = {
    ...current,
    ...compactObject({
      classification: patch.classification,
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
      const storedTransactions = await taxStore.listTransactions(req.auth.uid);
      const storedMap = new Map(storedTransactions.map((item) => [item.plaidTransactionId || item.id, item]));

      const merged = liveTransactions.map((transaction) => {
        const existing = storedMap.get(transaction.plaidTransactionId) || storedMap.get(transaction.id);
        const pendingSource = transaction.pendingTransactionId
          ? storedMap.get(transaction.pendingTransactionId)
          : null;
        const deterministic = deterministicSuggestion(transaction, allRules);
        const seeded = existing || mergePendingClassification({
          ...transaction,
          classification: deterministic?.classification || "needs_review",
          deductibility: deterministic?.deductibility || "needs_review",
          businessUsePercentage: deterministic?.businessUsePercentage || null,
          taxCategory: deterministic?.taxCategory || null,
          classificationSource: deterministic?.classificationSource || "imported",
          confidence: deterministic?.confidence || null,
          aiReason: deterministic?.reason || null,
          userConfirmed: deterministic?.classificationSource === "user_rule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userNote: "",
          flags: deterministic?.flags || [],
        }, pendingSource);
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
          updatedAt: seeded.updatedAt,
          flags: seeded.flags || [],
          lastAppliedRuleId: seeded.lastAppliedRuleId || null,
        });
      });

      await taxStore.bulkUpsertTransactions(req.auth.uid, merged);
      const refreshed = (await taxStore.listTransactions(req.auth.uid))
        .filter((record) => new Date(record.date || "").getUTCFullYear() === year)
        .filter((record) => {
          if (replacedPendingIds.has(record.id) || replacedPendingIds.has(record.plaidTransactionId)) {
            return false;
          }
          return true;
        })
        .filter((record) => passesFilters(record, req.query))
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

      return res.json({
        ok: true,
        year,
        transactions: refreshed.map(buildTransactionResponse),
        summary: buildSummary(refreshed, config.highConfidenceThreshold),
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

  router.post("/ai/review", async (req, res) => {
    try {
      if (!config.enabled) {
        return res.status(403).json({ ok: false, error: "AI Tax Review is disabled." });
      }

      const year = normalizeYear(req.body?.year);
      const mode = ["unreviewed", "selected", "all"].includes(req.body?.mode) ? req.body.mode : "unreviewed";
      const reprocess = req.body?.reprocess === true;
      const selectedIds = Array.isArray(req.body?.transactionIds) ? req.body.transactionIds : [];
      const selectedKey = [...selectedIds].sort().join("|");
      const existingReviews = await taxStore.listReviews(req.auth.uid);
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = existingReviews.filter((review) => String(review.createdAt || "").slice(0, 10) === today).length;
      if (todayCount >= config.dailyRunLimit) {
        return res.status(429).json({ ok: false, error: "Daily AI tax review limit reached." });
      }
      if (!reprocess) {
        const existing = existingReviews.find((review) =>
          review.year === year &&
          review.mode === mode &&
          String((review.selectedTransactionIds || []).slice().sort().join("|")) === selectedKey &&
          ["queued", "running", "completed", "applied"].includes(review.status)
        );
        if (existing) {
          return res.json({ ok: true, review: existing, reused: true });
        }
      }
      const reviewId = nextReviewId();

      const allTransactions = await taxStore.listTransactions(req.auth.uid);
      let candidates = allTransactions.filter((transaction) => new Date(transaction.date || "").getUTCFullYear() === year);

      if (mode === "selected") {
        const selectedSet = new Set(selectedIds);
        candidates = candidates.filter((transaction) => selectedSet.has(transaction.id));
      } else if (mode === "unreviewed") {
        candidates = candidates.filter((transaction) => reprocess || !transaction.userConfirmed);
      }

      const rules = await taxStore.listRules(req.auth.uid);
      await taxStore.upsertReview(req.auth.uid, {
        id: reviewId,
        year,
        mode,
        status: "running",
        selectedTransactionIds: selectedIds,
        autoApplyHighConfidence: false,
        progress: {
          stage: "Preparing transactions",
          stageIndex: 0,
          totalStages: 6,
          processed: 0,
          total: candidates.length,
        },
      });

      const review = await runTaxAiReview({
        uid: req.auth.uid,
        store: taxStore,
        openaiClient,
        logger,
        config,
        reviewId,
        year,
        transactions: candidates,
        rules,
      });

      const persistedSuggestions = [];
      for (const suggestion of review.suggestions) {
        const current = await taxStore.getTransaction(req.auth.uid, suggestion.transactionId);
        if (!current) continue;
        persistedSuggestions.push(await taxStore.upsertTransaction(req.auth.uid, applyPatchToTransaction(current, {
          classification: suggestion.classification,
          deductibility: suggestion.deductibility,
          taxCategory: suggestion.taxCategory,
          classificationSource: "ai_suggestion",
          confidence: suggestion.confidence,
          aiReason: suggestion.reason,
          userConfirmed: false,
          reviewId,
        })));
      }

      const responseReview = await taxStore.upsertReview(req.auth.uid, {
        ...review,
        suggestions: persistedSuggestions.map((transaction) => ({
          transactionId: transaction.id,
          classification: transaction.classification,
          deductibility: transaction.deductibility,
          taxCategory: transaction.taxCategory,
          confidence: transaction.confidence,
          reason: transaction.aiReason,
          requiresUserReview: !transaction.userConfirmed,
          flags: transaction.flags || [],
        })),
      });

      return res.status(201).json({ ok: true, review: responseReview });
    } catch (error) {
      logger.error("TAX AI REVIEW ERROR", errorSummary(error));
      return res.status(500).json({ ok: false, error: "Failed to prepare AI tax review." });
    }
  });

  router.get("/ai/reviews/:reviewId", async (req, res) => {
    const review = await taxStore.getReview(req.auth.uid, req.params.reviewId);
    if (!review) {
      return res.status(404).json({ ok: false, error: "AI review not found." });
    }
    return res.json({ ok: true, review });
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

      const saved = [];
      for (const suggestion of preview.suggestions) {
        const current = await taxStore.getTransaction(req.auth.uid, suggestion.transactionId);
        if (!current) continue;
        saved.push(await taxStore.upsertTransaction(
          req.auth.uid,
          applyPatchToTransaction(current, {
            classification: suggestion.classification,
            deductibility: suggestion.deductibility,
            taxCategory: suggestion.taxCategory,
            classificationSource: "ai_approved",
            confidence: suggestion.confidence,
            aiReason: suggestion.reason,
            userConfirmed: true,
          })
        ));
      }

      await taxStore.upsertReview(req.auth.uid, {
        ...review,
        status: "applied",
        appliedAt: new Date().toISOString(),
      });

      return res.json({
        ok: true,
        updated: saved.length,
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
    return res.json({
      ok: true,
      year,
      summary: buildSummary(transactions, config.highConfidenceThreshold),
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
  buildSummary,
  buildTransactionResponse,
  fetchPlaidTransactionsForUser,
  mapPlaidTransaction,
  yearDateRange,
};
