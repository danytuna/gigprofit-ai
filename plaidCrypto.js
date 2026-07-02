import crypto from "crypto";

function base64ToBuffer(value) {
  try {
    return Buffer.from(String(value || ""), "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

export function resolveEncryptionKey({
  envValue,
  nodeEnv = "development",
}) {
  const keyBuffer = base64ToBuffer(envValue);

  if (keyBuffer.length === 32) {
    return keyBuffer;
  }

  if (nodeEnv === "production") {
    throw new Error(
      "PLAID_TOKEN_ENCRYPTION_KEY is missing or invalid. It must decode to exactly 32 bytes."
    );
  }

  return null;
}

export function encryptSecret(plaintext, keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext || ""), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedAccessToken: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptSecret(payload, keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes.");
  }

  const encryptedAccessToken = String(
    payload?.encryptedAccessToken || ""
  ).trim();
  const iv = String(payload?.iv || "").trim();
  const authTag = String(payload?.authTag || "").trim();

  if (!encryptedAccessToken || !iv || !authTag) {
    throw new Error("Encrypted Plaid payload is incomplete.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyBuffer,
    Buffer.from(iv, "base64")
  );

  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedAccessToken, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
