import {
  X509Certificate,
  createHash,
  verify as verifySignature,
} from "node:crypto";

export const APPLE_STOREKIT_PRODUCTS = new Map([
  ["standard_monthly", "standard"],
  ["standard_yearly", "standard"],
  ["pro_monthly", "pro"],
  ["pro_yearly", "pro"],
]);

function base64URLBuffer(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function parseJSONPart(value, label) {
  try {
    return JSON.parse(base64URLBuffer(value).toString("utf8"));
  } catch {
    throw new Error(`Invalid StoreKit ${label}.`);
  }
}

function certificateIsCurrent(certificate, now) {
  const validFrom = new Date(certificate.validFrom);
  const validTo = new Date(certificate.validTo);
  return Number.isFinite(validFrom.valueOf())
    && Number.isFinite(validTo.valueOf())
    && validFrom <= now
    && now <= validTo;
}

// StoreKit JWS certificates are Apple-PKI certificates, not public-Web TLS
// certificates. Node's `tls.rootCertificates` intentionally contains the
// Mozilla/Web PKI trust store and does not include Apple's private StoreKit
// roots. Trusting that list makes every genuine StoreKit JWS fail on Railway.
//
// Apple documents the StoreKit/App Store Server verification flow as being
// anchored to the Apple Root Certificates published at:
// https://www.apple.com/certificateauthority/
//
// StoreKit 2 signed transactions currently carry a three-certificate x5c
// chain. Pin the SHA-256 fingerprints of the modern Apple roots used for App
// Store signed data instead of relying on the host OS/Node CA bundle.
const APPLE_STOREKIT_ROOT_SHA256 = new Set([
  // Apple Root CA - G2
  "c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050",
  // Apple Root CA - G3
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179",
]);

function normalizedFingerprint256(certificate) {
  return String(certificate?.fingerprint256 || "")
    .replaceAll(":", "")
    .trim()
    .toLowerCase();
}

function isPinnedAppleStoreKitRoot(certificate) {
  if (!certificate) {
    return false;
  }

  const fingerprint = normalizedFingerprint256(certificate);
  if (!APPLE_STOREKIT_ROOT_SHA256.has(fingerprint)) {
    return false;
  }

  // The x5c root must actually be a CA and must be self-signed. The fingerprint
  // pin is the trust decision; these checks reject malformed chains early.
  return certificate.ca
    && certificate.subject === certificate.issuer
    && certificate.verify(certificate.publicKey);
}

function certificateChainsToTrustedRoot(certificates) {
  if (certificates.length !== 3) {
    return false;
  }

  for (let index = 0; index < certificates.length - 1; index += 1) {
    const certificate = certificates[index];
    const issuer = certificates[index + 1];
    if (certificate.issuer !== issuer.subject || !certificate.verify(issuer.publicKey)) {
      return false;
    }
  }

  return isPinnedAppleStoreKitRoot(certificates.at(-1));
}

function deterministicAccountToken(uid) {
  const bytes = Buffer.from(
    createHash("sha256").update(String(uid || ""), "utf8").digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function expectedStoreKitAppAccountToken(uid) {
  if (!String(uid || "").trim()) {
    throw new Error("A Firebase UID is required.");
  }
  return deterministicAccountToken(uid);
}

export function planForAppleProduct(productId) {
  return APPLE_STOREKIT_PRODUCTS.get(String(productId || "").trim()) || null;
}

export function validateAppleStoreKitPayload({
  payload,
  uid,
  expectedBundleId = "com.dany.GigProfit",
  now = new Date(),
  allowInactive = false,
}) {
  const productId = String(payload?.productId || "");
  const plan = planForAppleProduct(productId);
  if (!plan) {
    throw new Error("Unknown StoreKit product.");
  }
  if (String(payload?.bundleId || "") !== expectedBundleId) {
    throw new Error("StoreKit bundle identifier does not match.");
  }

  const expectedToken = expectedStoreKitAppAccountToken(uid);
  const transactionToken = String(payload?.appAccountToken || "").toLowerCase();
  const accountTokenMatches = !transactionToken || transactionToken === expectedToken;

  const expiresDate = new Date(Number(payload?.expiresDate || 0));
  if (!Number.isFinite(expiresDate.valueOf())) {
    throw new Error("StoreKit subscription is not active.");
  }
  const isRevoked = Boolean(payload?.revocationDate);
  const isExpired = expiresDate <= now;
  if (!allowInactive && isExpired) {
    throw new Error("StoreKit subscription is not active.");
  }
  if (!allowInactive && isRevoked) {
    throw new Error("StoreKit subscription was revoked.");
  }

  const transactionId = String(payload?.transactionId || "").trim();
  const originalTransactionId = String(payload?.originalTransactionId || "").trim();
  if (!transactionId || !originalTransactionId) {
    throw new Error("StoreKit transaction identifiers are missing.");
  }

  return {
    plan,
    productId,
    transactionId,
    originalTransactionId,
    appAccountToken: transactionToken || null,
    expectedAppAccountToken: expectedToken,
    accountTokenMatches,
    status: isRevoked ? "revoked" : (isExpired ? "expired" : "active"),
    expiresAt: expiresDate.toISOString(),
    environment: String(payload?.environment || ""),
  };
}

export function verifyAppleStoreKitTransaction({
  signedTransactionInfo,
  uid,
  expectedBundleId = "com.dany.GigProfit",
  now = new Date(),
  allowInactive = false,
}) {
  const compactJWS = String(signedTransactionInfo || "").trim();
  const parts = compactJWS.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid StoreKit signed transaction.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJSONPart(encodedHeader, "JWS header");
  const payload = parseJSONPart(encodedPayload, "JWS payload");

  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
    throw new Error("Unsupported StoreKit signature.");
  }

  const certificates = header.x5c.map((der) => (
    new X509Certificate(Buffer.from(String(der), "base64"))
  ));

  if (!certificates.every((certificate) => certificateIsCurrent(certificate, now))) {
    throw new Error("StoreKit signing certificate is not valid.");
  }

  if (!certificateChainsToTrustedRoot(certificates)) {
    throw new Error("StoreKit certificate chain is not trusted.");
  }

  const signatureIsValid = verifySignature(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
    {
      key: certificates[0].publicKey,
      dsaEncoding: "ieee-p1363",
    },
    base64URLBuffer(encodedSignature),
  );

  if (!signatureIsValid) {
    throw new Error("StoreKit transaction signature is invalid.");
  }

  return validateAppleStoreKitPayload({
    payload,
    uid,
    expectedBundleId,
    now,
    allowInactive,
  });
}
