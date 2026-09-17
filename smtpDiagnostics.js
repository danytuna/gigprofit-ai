import nodemailer from "nodemailer";

// This module provides a safe, non-destructive way to verify SMTP
// connectivity/authentication using the same CREATOR_EMAIL_SMTP_*
// environment variables consumed by referrals.js. It never sends mail
// and never logs/returns credential values.

const CREATOR_EMAIL_SMTP_HOST =
  process.env.CREATOR_EMAIL_SMTP_HOST ||
  "smtp.gmail.com";

const CREATOR_EMAIL_SMTP_PORT =
  Math.max(1, Number(process.env.CREATOR_EMAIL_SMTP_PORT || 465));

const CREATOR_EMAIL_SMTP_SECURE =
  String(
    process.env.CREATOR_EMAIL_SMTP_SECURE ??
    (CREATOR_EMAIL_SMTP_PORT === 465 ? "true" : "false")
  ).toLowerCase() === "true";

function nowISO() {
  return new Date().toISOString();
}

function creatorEmailConfigured() {
  return Boolean(
    String(process.env.CREATOR_EMAIL_SMTP_USER || "").trim() &&
    String(process.env.CREATOR_EMAIL_SMTP_PASS || "").trim()
  );
}

// Strips any possible credential values (SMTP user/pass) out of an error
// message, keeping only the SMTP response code and a generic message.
function sanitizeSmtpError(error) {
  const user = String(process.env.CREATOR_EMAIL_SMTP_USER || "").trim();
  const pass = String(process.env.CREATOR_EMAIL_SMTP_PASS || "").trim();

  let message = String(error?.response || error?.message || error || "Unknown SMTP error");

  if (user) {
    message = message.split(user).join("[redacted]");
  }
  if (pass) {
    message = message.split(pass).join("[redacted]");
  }

  // Only keep the SMTP response code (if present) plus a short generic
  // description — drop anything that looks like it could echo back
  // connection strings, headers, or credentials.
  const codeMatch = message.match(/\b(\d{3})\b/);
  const code = codeMatch ? codeMatch[1] : null;

  let genericMessage;
  switch (error?.code) {
    case "EAUTH":
      genericMessage = "Authentication failed";
      break;
    case "ETIMEDOUT":
      genericMessage = "Connection timed out";
      break;
    case "ECONNECTION":
    case "ECONNREFUSED":
      genericMessage = "Connection refused";
      break;
    case "ESOCKET":
      genericMessage = "Socket/TLS error";
      break;
    case "EDNS":
    case "ENOTFOUND":
      genericMessage = "DNS lookup failed";
      break;
    default:
      genericMessage = /auth/i.test(message)
        ? "Authentication failed"
        : "SMTP error";
  }

  return code ? `${code} ${genericMessage}` : genericMessage;
}

// Best-effort classification of which stage the failure occurred at,
// based on nodemailer/Node error codes — without exposing raw details.
function classifyStage(error) {
  const code = String(error?.code || "").toUpperCase();

  if (["ENOTFOUND", "EAI_AGAIN", "EDNS"].includes(code)) {
    return "dns-lookup";
  }
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNECTION"].includes(code)) {
    return "connect";
  }
  if (code === "ESOCKET" || /ssl|tls/i.test(String(error?.message || ""))) {
    return "tls";
  }
  if (code === "EAUTH" || /auth/i.test(String(error?.message || ""))) {
    return "auth";
  }

  return "connect";
}

/**
 * Verifies SMTP connectivity, TLS handshake, and authentication using the
 * CREATOR_EMAIL_SMTP_* environment variables. Does NOT send any email and
 * does NOT expose credential values. Safe to call repeatedly.
 *
 * @returns {Promise<{ success: boolean, stage: string, sanitizedError?: string, timestamp: string }>}
 */
export async function testSmtpConnection() {
  if (!creatorEmailConfigured()) {
    return {
      success: false,
      stage: "auth",
      sanitizedError: "SMTP credentials are not configured",
      timestamp: nowISO(),
    };
  }

  let transporter;

  try {
    transporter = nodemailer.createTransport({
      host: CREATOR_EMAIL_SMTP_HOST,
      port: CREATOR_EMAIL_SMTP_PORT,
      secure: CREATOR_EMAIL_SMTP_SECURE,
      auth: {
        user: process.env.CREATOR_EMAIL_SMTP_USER,
        pass: process.env.CREATOR_EMAIL_SMTP_PASS,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    // verify() performs DNS resolution, connects, negotiates TLS, and
    // authenticates — but never sends a message.
    await transporter.verify();

    return {
      success: true,
      stage: "success",
      timestamp: nowISO(),
    };
  } catch (error) {
    return {
      success: false,
      stage: classifyStage(error),
      sanitizedError: sanitizeSmtpError(error),
      timestamp: nowISO(),
    };
  } finally {
    try {
      transporter?.close?.();
    } catch {
      // ignore
    }
  }
}
