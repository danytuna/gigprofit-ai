import crypto from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix = "tax") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeYear(value, fallback = new Date().getUTCFullYear()) {
  const year = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(year) || year < 2020 || year > 2100) {
    return fallback;
  }

  return year;
}

function buildTransactionDocRef(firestore, uid, transactionId) {
  return firestore
    .collection("users")
    .doc(uid)
    .collection("taxTransactions")
    .doc(transactionId);
}

function buildRuleDocRef(firestore, uid, ruleId) {
  return firestore
    .collection("users")
    .doc(uid)
    .collection("taxRules")
    .doc(ruleId);
}

function buildReviewDocRef(firestore, uid, reviewId) {
  return firestore
    .collection("users")
    .doc(uid)
    .collection("taxAiReviews")
    .doc(reviewId);
}

function normalizeTransactionRecord(record = {}) {
  return {
    id: String(record.id || record.plaidTransactionId || ""),
    plaidTransactionId: String(record.plaidTransactionId || record.id || ""),
    accountId: record.accountId || null,
    itemId: record.itemId || null,
    merchantName: record.merchantName || null,
    originalName: record.originalName || record.name || "",
    amount: Number(record.amount || 0),
    isoCurrencyCode: record.isoCurrencyCode || "USD",
    authorizedDate: record.authorizedDate || null,
    date: record.date || null,
    pending: Boolean(record.pending),
    pendingTransactionId: record.pendingTransactionId || null,
    primaryCategory: record.primaryCategory || null,
    detailedCategory: record.detailedCategory || null,
    classification: record.classification || "needs_review",
    deductibility: record.deductibility || "needs_review",
    businessUsePercentage: record.businessUsePercentage ?? null,
    taxCategory: record.taxCategory || null,
    scheduleCategory: record.scheduleCategory || null,
    userNote: record.userNote || "",
    classificationSource: record.classificationSource || "imported",
    confidence: typeof record.confidence === "number" ? record.confidence : null,
    aiReason: record.aiReason || null,
    userConfirmed: Boolean(record.userConfirmed),
    reviewedAt: record.reviewedAt || null,
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || nowIso(),
    schemaVersion: Number(record.schemaVersion || 1),
    isIncome: Boolean(record.isIncome),
    reviewId: record.reviewId || null,
    flags: Array.isArray(record.flags) ? record.flags : [],
    merchantKey: record.merchantKey || null,
    lastAppliedRuleId: record.lastAppliedRuleId || null,
  };
}

function normalizeRuleRecord(rule = {}) {
  return {
    id: String(rule.id || generateId("rule")),
    merchantPattern: rule.merchantPattern || null,
    plaidCategory: rule.plaidCategory || null,
    accountScope: rule.accountScope || null,
    classification: rule.classification || "needs_review",
    deductibility: rule.deductibility || "needs_review",
    taxCategory: rule.taxCategory || null,
    businessUsePercentage: rule.businessUsePercentage ?? null,
    enabled: rule.enabled !== false,
    priority: Number(rule.priority || 100),
    createdAt: rule.createdAt || nowIso(),
    updatedAt: rule.updatedAt || nowIso(),
    source: rule.source || "user",
    schemaVersion: Number(rule.schemaVersion || 1),
  };
}

function normalizeReviewRecord(review = {}) {
  return {
    id: String(review.id || generateId("review")),
    year: normalizeYear(review.year),
    mode: review.mode || "unreviewed",
    status: review.status || "queued",
    autoApplyHighConfidence: Boolean(review.autoApplyHighConfidence),
    selectedTransactionIds: Array.isArray(review.selectedTransactionIds) ? review.selectedTransactionIds : [],
    summary: review.summary || {},
    progress: review.progress || {},
    suggestions: Array.isArray(review.suggestions) ? review.suggestions : [],
    counts: review.counts || {},
    createdAt: review.createdAt || nowIso(),
    updatedAt: review.updatedAt || nowIso(),
    schemaVersion: Number(review.schemaVersion || 1),
  };
}

function createMemoryStore() {
  const transactionsByUser = new Map();
  const rulesByUser = new Map();
  const reviewsByUser = new Map();

  function txMap(uid) {
    if (!transactionsByUser.has(uid)) {
      transactionsByUser.set(uid, new Map());
    }

    return transactionsByUser.get(uid);
  }

  function ruleMap(uid) {
    if (!rulesByUser.has(uid)) {
      rulesByUser.set(uid, new Map());
    }

    return rulesByUser.get(uid);
  }

  function reviewMap(uid) {
    if (!reviewsByUser.has(uid)) {
      reviewsByUser.set(uid, new Map());
    }

    return reviewsByUser.get(uid);
  }

  return {
    async listTransactions(uid) {
      return Array.from(txMap(uid).values()).map(clone);
    },
    async getTransaction(uid, transactionId) {
      return clone(txMap(uid).get(transactionId) || null);
    },
    async upsertTransaction(uid, record) {
      const normalized = normalizeTransactionRecord(record);
      txMap(uid).set(normalized.id, normalized);
      return clone(normalized);
    },
    async bulkUpsertTransactions(uid, records) {
      const saved = [];
      for (const record of records) {
        saved.push(await this.upsertTransaction(uid, record));
      }
      return saved;
    },
    async deleteTransactionsByReview(uid, reviewId) {
      let deleted = 0;
      for (const [id, value] of txMap(uid).entries()) {
        if (value.reviewId === reviewId && value.classificationSource === "ai_suggestion" && !value.userConfirmed) {
          txMap(uid).delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
    async listRules(uid) {
      return Array.from(ruleMap(uid).values())
        .map(clone)
        .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    },
    async getRule(uid, ruleId) {
      return clone(ruleMap(uid).get(ruleId) || null);
    },
    async upsertRule(uid, rule) {
      const normalized = normalizeRuleRecord(rule);
      ruleMap(uid).set(normalized.id, normalized);
      return clone(normalized);
    },
    async deleteRule(uid, ruleId) {
      return ruleMap(uid).delete(ruleId);
    },
    async clearRules(uid) {
      const count = ruleMap(uid).size;
      rulesByUser.set(uid, new Map());
      return count;
    },
    async listReviews(uid) {
      return Array.from(reviewMap(uid).values()).map(clone);
    },
    async getReview(uid, reviewId) {
      return clone(reviewMap(uid).get(reviewId) || null);
    },
    async upsertReview(uid, review) {
      const normalized = normalizeReviewRecord(review);
      reviewMap(uid).set(normalized.id, normalized);
      return clone(normalized);
    },
    async deleteReview(uid, reviewId) {
      return reviewMap(uid).delete(reviewId);
    },
    async clearSuggestions(uid) {
      let deleted = 0;
      for (const [id, value] of txMap(uid).entries()) {
        if (value.classificationSource === "ai_suggestion" && !value.userConfirmed) {
          txMap(uid).delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

function createFirestoreStore({ firestore, admin }) {
  const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();

  return {
    async listTransactions(uid) {
      const snapshot = await firestore
        .collection("users")
        .doc(uid)
        .collection("taxTransactions")
        .get();

      return snapshot.docs.map((doc) => normalizeTransactionRecord({ id: doc.id, ...doc.data() }));
    },
    async getTransaction(uid, transactionId) {
      const doc = await buildTransactionDocRef(firestore, uid, transactionId).get();
      if (!doc.exists) return null;
      return normalizeTransactionRecord({ id: doc.id, ...doc.data() });
    },
    async upsertTransaction(uid, record) {
      const normalized = normalizeTransactionRecord(record);
      const payload = {
        ...normalized,
        createdAt: normalized.createdAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      await buildTransactionDocRef(firestore, uid, normalized.id).set(payload, { merge: true });
      return normalizeTransactionRecord(payload);
    },
    async bulkUpsertTransactions(uid, records) {
      const batch = firestore.batch();
      const saved = [];
      for (const record of records) {
        const normalized = normalizeTransactionRecord(record);
        saved.push(normalized);
        batch.set(
          buildTransactionDocRef(firestore, uid, normalized.id),
          {
            ...normalized,
            createdAt: normalized.createdAt || serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
      await batch.commit();
      return saved;
    },
    async deleteTransactionsByReview(uid, reviewId) {
      const snapshot = await firestore
        .collection("users")
        .doc(uid)
        .collection("taxTransactions")
        .where("reviewId", "==", reviewId)
        .where("classificationSource", "==", "ai_suggestion")
        .where("userConfirmed", "==", false)
        .get();

      if (snapshot.empty) return 0;

      const batch = firestore.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      return snapshot.size;
    },
    async listRules(uid) {
      const snapshot = await firestore
        .collection("users")
        .doc(uid)
        .collection("taxRules")
        .orderBy("priority", "asc")
        .orderBy("createdAt", "asc")
        .get();

      return snapshot.docs.map((doc) => normalizeRuleRecord({ id: doc.id, ...doc.data() }));
    },
    async getRule(uid, ruleId) {
      const doc = await buildRuleDocRef(firestore, uid, ruleId).get();
      if (!doc.exists) return null;
      return normalizeRuleRecord({ id: doc.id, ...doc.data() });
    },
    async upsertRule(uid, rule) {
      const normalized = normalizeRuleRecord(rule);
      await buildRuleDocRef(firestore, uid, normalized.id).set({
        ...normalized,
        createdAt: normalized.createdAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      return normalized;
    },
    async deleteRule(uid, ruleId) {
      const ref = buildRuleDocRef(firestore, uid, ruleId);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    },
    async clearRules(uid) {
      const snapshot = await firestore.collection("users").doc(uid).collection("taxRules").get();
      if (snapshot.empty) return 0;
      const batch = firestore.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      return snapshot.size;
    },
    async listReviews(uid) {
      const snapshot = await firestore
        .collection("users")
        .doc(uid)
        .collection("taxAiReviews")
        .orderBy("createdAt", "desc")
        .get();

      return snapshot.docs.map((doc) => normalizeReviewRecord({ id: doc.id, ...doc.data() }));
    },
    async getReview(uid, reviewId) {
      const doc = await buildReviewDocRef(firestore, uid, reviewId).get();
      if (!doc.exists) return null;
      return normalizeReviewRecord({ id: doc.id, ...doc.data() });
    },
    async upsertReview(uid, review) {
      const normalized = normalizeReviewRecord(review);
      await buildReviewDocRef(firestore, uid, normalized.id).set({
        ...normalized,
        createdAt: normalized.createdAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      return normalized;
    },
    async deleteReview(uid, reviewId) {
      const ref = buildReviewDocRef(firestore, uid, reviewId);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    },
    async clearSuggestions(uid) {
      const snapshot = await firestore
        .collection("users")
        .doc(uid)
        .collection("taxTransactions")
        .where("classificationSource", "==", "ai_suggestion")
        .where("userConfirmed", "==", false)
        .get();
      if (snapshot.empty) return 0;
      const batch = firestore.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      return snapshot.size;
    },
  };
}

function createTaxStore({ firestore, admin, mode = "firestore" } = {}) {
  if (mode === "memory" || !firestore || !admin) {
    return createMemoryStore();
  }

  return createFirestoreStore({ firestore, admin });
}

export {
  createTaxStore,
  normalizeRuleRecord,
  normalizeTransactionRecord,
  normalizeReviewRecord,
  normalizeYear,
};
