const VERIFIED_SUBSCRIPTION_SOURCES = new Set([
  "storekit-verified-jws",
  "google-play-verified",
]);

const PLAN_RANK = Object.freeze({
  free: 0,
  standard: 1,
  pro: 2,
});

export function normalizeCanonicalPlan(value) {
  const plan = String(value || "free").trim().toLowerCase();
  return plan === "standard" || plan === "pro" ? plan : "free";
}

function dateValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

/**
 * The users/{uid} document is the sole authorization record. Paid access is
 * valid only when its canonical `plan` was written by a verified store sync.
 * Legacy aliases are deliberately ignored so missing data can never grant Pro.
 */
export function resolveCanonicalSubscription(userData = {}, now = new Date()) {
  const storedPlan = normalizeCanonicalPlan(userData.plan);
  const status = String(userData.subscriptionStatus || "").trim().toLowerCase();
  const source = String(userData.subscriptionSource || "").trim().toLowerCase();
  const expiresAt = dateValue(userData.subscriptionExpiresAt);
  const productId = String(userData.subscriptionProductId || "").trim() || null;
  const originalTransactionId = String(
    userData.subscriptionOriginalTransactionId || "",
  ).trim() || null;

  const result = (plan, resolvedStatus, resolvedSource) => ({
    plan,
    status: resolvedStatus,
    source: resolvedSource,
    expiresAt,
    productId,
    originalTransactionId,
  });

  if (storedPlan === "free") {
    const terminalStatus = ["expired", "revoked", "transferred"].includes(status)
      ? status
      : "free";
    return result("free", terminalStatus, source || "canonical-user-record");
  }

  if (status !== "active") {
    return result("free", status || "not_synchronized", source || "canonical-user-record");
  }

  if (!VERIFIED_SUBSCRIPTION_SOURCES.has(source)) {
    return result("free", "not_synchronized", source || "unverified");
  }

  if (!expiresAt || expiresAt <= now) {
    return result("free", "expired", source);
  }

  if (source === "storekit-verified-jws" && !originalTransactionId) {
    return result("free", "not_synchronized", source);
  }

  return result(storedPlan, "active", source);
}

export function resolveStoredSubscriptionPlan(userData = {}, now = new Date()) {
  return resolveCanonicalSubscription(userData, now).plan;
}

export async function readCanonicalSubscription({ firestore, uid, now = new Date() }) {
  if (!firestore || !uid) {
    const error = new Error("Canonical subscription store is unavailable.");
    error.code = "SUBSCRIPTION_STORE_UNAVAILABLE";
    throw error;
  }

  const snapshot = await firestore.collection("users").doc(uid).get();
  if (!snapshot.exists) {
    return {
      plan: "free",
      status: "not_synchronized",
      source: "missing-user-record",
      expiresAt: null,
      productId: null,
      originalTransactionId: null,
    };
  }

  return resolveCanonicalSubscription(snapshot.data() || {}, now);
}

export function subscriptionAccessError({ requiredPlan, subscription, localPlanHint }) {
  const required = normalizeCanonicalPlan(requiredPlan);
  const hint = normalizeCanonicalPlan(localPlanHint);

  if ((PLAN_RANK[subscription.plan] || 0) >= (PLAN_RANK[required] || 0)) {
    return null;
  }

  if ((PLAN_RANK[hint] || 0) >= (PLAN_RANK[required] || 0)) {
    return {
      status: 409,
      code: "PLAN_NOT_SYNCHRONIZED",
      errorType: "subscription_sync",
      message: "Your verified purchase is still synchronizing. Please try again shortly.",
    };
  }

  if (subscription.plan === "standard" && required === "pro") {
    return {
      status: 403,
      code: "STANDARD_INSUFFICIENT",
      errorType: "subscription_access",
      message: "This feature requires the Pro plan.",
    };
  }

  return {
    status: 403,
    code: required === "pro" ? "PRO_REQUIRED" : "STANDARD_REQUIRED",
    errorType: "subscription_access",
    message: `This feature requires the ${required === "pro" ? "Pro" : "Standard"} plan.`,
  };
}

export function createCanonicalPlanAuthorizer({ firestore, requiredPlan = "pro", now = () => new Date() }) {
  return async function requireCanonicalPlan(req, res, next) {
    try {
      const subscription = await readCanonicalSubscription({
        firestore,
        uid: req.auth?.uid,
        now: now(),
      });
      const accessError = subscriptionAccessError({
        requiredPlan,
        subscription,
        localPlanHint: req.headers["x-gigprofit-local-plan"],
      });

      if (accessError) {
        return res.status(accessError.status).json({
          ok: false,
          code: accessError.code,
          error_type: accessError.errorType,
          error: accessError.message,
          message: accessError.message,
          current_plan: subscription.plan,
          required_plan: normalizeCanonicalPlan(requiredPlan),
        });
      }

      req.subscription = subscription;
      return next();
    } catch {
      return res.status(503).json({
        ok: false,
        code: "SUBSCRIPTION_BACKEND_UNAVAILABLE",
        error_type: "temporary_backend_failure",
        error: "Subscription authorization is temporarily unavailable.",
        message: "Subscription authorization is temporarily unavailable.",
      });
    }
  };
}
