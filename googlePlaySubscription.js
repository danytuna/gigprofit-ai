import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

const ACTIVE_SUBSCRIPTION_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);

const PRODUCT_PLANS = new Map([
  ["standard_monthly", "standard"],
  ["standard_yearly", "standard"],
  ["pro_monthly", "pro"],
  ["pro_yearly", "pro"],
]);

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseServiceAccount(base64Value) {
  if (!base64Value) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is required for Google Play verification.");
  }

  const credentials = JSON.parse(
    Buffer.from(base64Value, "base64").toString("utf8")
  );

  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error("The service account cannot authorize Google Play verification.");
  }

  return credentials;
}

export function planForGooglePlayProduct(productId) {
  return PRODUCT_PLANS.get(String(productId || "").trim()) || null;
}

export function hashGooglePlayPurchaseToken(purchaseToken) {
  return createHash("sha256")
    .update(String(purchaseToken || ""))
    .digest("hex");
}

export function parseGooglePlaySubscription({
  payload,
  requestedProductId,
  now = new Date(),
}) {
  const productId = String(requestedProductId || "").trim();
  const plan = planForGooglePlayProduct(productId);

  if (!plan) {
    throw new Error("Unsupported Google Play product.");
  }

  const state = String(payload?.subscriptionState || "");
  if (!ACTIVE_SUBSCRIPTION_STATES.has(state)) {
    throw new Error("The Google Play subscription is not active.");
  }

  const matchingLineItem = Array.isArray(payload?.lineItems)
    ? payload.lineItems.find((item) => item?.productId === productId)
    : null;

  if (!matchingLineItem) {
    throw new Error("The purchase token does not match the requested product.");
  }

  const expiryTime = new Date(matchingLineItem.expiryTime || "");
  if (!Number.isFinite(expiryTime.getTime()) || expiryTime <= now) {
    throw new Error("The Google Play subscription has expired.");
  }

  return {
    plan,
    productId,
    state,
    expiryTime: expiryTime.toISOString(),
    orderId: String(
      matchingLineItem.latestSuccessfulOrderId
      || payload?.latestOrderId
      || ""
    ),
  };
}

export function createGooglePlaySubscriptionVerifier({
  serviceAccountBase64,
  packageName = "com.dany.gigprofit",
  fetchImpl = globalThis.fetch,
  accessTokenProvider,
  requestTimeoutMs = 10_000,
}) {
  let authPromise = null;

  async function accessToken() {
    if (accessTokenProvider) {
      const provided = await withTimeout(
        Promise.resolve().then(accessTokenProvider),
        requestTimeoutMs,
        "Google Play authorization timed out."
      );
      if (!provided) {
        throw new Error("Google Play authorization did not return an access token.");
      }
      return provided;
    }

    authPromise ??= (async () => {
      const auth = new GoogleAuth({
        credentials: parseServiceAccount(serviceAccountBase64),
        scopes: ["https://www.googleapis.com/auth/androidpublisher"],
      });
      return auth.getClient();
    })();

    const client = await authPromise;
    const token = await withTimeout(
      client.getAccessToken(),
      requestTimeoutMs,
      "Google Play authorization timed out."
    );
    const value = typeof token === "string" ? token : token?.token;

    if (!value) {
      throw new Error("Google Play authorization did not return an access token.");
    }

    return value;
  }

  return async function verifyGooglePlaySubscription({
    productId,
    purchaseToken,
  }) {
    const cleanToken = String(purchaseToken || "").trim();
    if (!cleanToken) {
      throw new Error("Missing Google Play purchase token.");
    }

    if (!planForGooglePlayProduct(productId)) {
      throw new Error("Unsupported Google Play product.");
    }

    const token = await accessToken();
    const endpoint =
      "https://androidpublisher.googleapis.com/androidpublisher/v3"
      + `/applications/${encodeURIComponent(packageName)}`
      + `/purchases/subscriptionsv2/tokens/${encodeURIComponent(cleanToken)}`;

    const response = await fetchImpl(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        payload?.error?.message || "Google Play could not verify this subscription."
      );
      error.status = response.status;
      throw error;
    }

    return parseGooglePlaySubscription({
      payload,
      requestedProductId: productId,
    });
  };
}
