import express from "express";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import nodemailer from "nodemailer";

const APP_STORE_URL =
  process.env.GIGPROFIT_APP_STORE_URL ||
  "https://apps.apple.com/us/app/gigprofit/id6765807887";

const REFERRAL_BASE_URL =
  process.env.REFERRAL_BASE_URL ||
  "https://gigprofitapp.com";

const CONTACT_EMAIL = "danny.novaprime@gmail.com";

const OWNER_PORTAL_URL =
  process.env.OWNER_PORTAL_URL ||
  `${REFERRAL_BASE_URL}/owner`;

const OWNER_CASHAPP_CASHTAG =
  normalizeCashtag(process.env.OWNER_CASHAPP_CASHTAG || "$novaprimellc") ||
  "$novaprimellc";

const DATA_PATH =
  process.env.REFERRAL_DATA_PATH ||
  path.join(process.cwd(), "data", "gigprofit-referrals.json");

const MAX_RECENT_FINGERPRINTS = 1500;
const UNIQUE_WINDOW_DAYS = 14;
const DEFAULT_ACCOUNT_BONUS = 1;
const MIN_PAYOUT = Math.max(0, Number(process.env.REFERRAL_MIN_PAYOUT || 0));

const STRIPE_API_VERSION =
  process.env.STRIPE_API_VERSION ||
  "2026-08-26.preview";
const STRIPE_FINANCIAL_ACCOUNT_ID =
  String(process.env.STRIPE_FINANCIAL_ACCOUNT_ID || "").trim();
const STRIPE_AUTOFUND_ENABLED =
  String(process.env.STRIPE_AUTOFUND_ENABLED || "false").toLowerCase() === "true";
const STRIPE_AUTOFUND_FULL_PAYOUT_FROM_BANK =
  String(
    process.env.STRIPE_AUTOFUND_FULL_PAYOUT_FROM_BANK || "false"
  ).toLowerCase() === "true";
const STRIPE_AUTOFUND_SOURCE_PAYOUT_METHOD_ID =
  String(process.env.STRIPE_AUTOFUND_SOURCE_PAYOUT_METHOD_ID || "").trim();
const STRIPE_AUTOFUND_MIN_BALANCE_CENTS = Math.max(
  0,
  Math.floor(Number(process.env.STRIPE_AUTOFUND_MIN_BALANCE_CENTS || 20000))
);
const STRIPE_AUTOFUND_TARGET_BALANCE_CENTS = Math.max(
  STRIPE_AUTOFUND_MIN_BALANCE_CENTS,
  Math.floor(Number(process.env.STRIPE_AUTOFUND_TARGET_BALANCE_CENTS || 50000))
);
const STRIPE_AUTOFUND_MAX_SINGLE_DEBIT_CENTS = Math.max(
  100,
  Math.floor(Number(process.env.STRIPE_AUTOFUND_MAX_SINGLE_DEBIT_CENTS || 100000))
);
const STRIPE_PAYOUT_SYNC_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.STRIPE_PAYOUT_SYNC_INTERVAL_MS || 300_000)
);
const STRIPE_RETURN_MONITOR_DAYS = Math.max(
  3,
  Math.floor(Number(process.env.STRIPE_RETURN_MONITOR_DAYS || 14))
);
const PAYOUT_ESTIMATE_MIN_DAYS = Math.max(
  1,
  Math.floor(Number(process.env.CREATOR_PAYOUT_ESTIMATE_MIN_DAYS || 1))
);
const PAYOUT_ESTIMATE_MAX_DAYS = Math.max(
  PAYOUT_ESTIMATE_MIN_DAYS,
  Math.floor(Number(process.env.CREATOR_PAYOUT_ESTIMATE_MAX_DAYS || 3))
);

const REEL_NEXT_MIN_LIFETIME_PAID = Math.max(
  0,
  Number(process.env.REEL_NEXT_MIN_LIFETIME_PAID || 200)
);
const REEL_NEXT_MIN_VERIFIED_DOWNLOADS = Math.max(
  0,
  Math.floor(Number(process.env.REEL_NEXT_MIN_VERIFIED_DOWNLOADS || 25))
);
const REEL_NEXT_MIN_DAYS = Math.max(
  0,
  Math.floor(Number(process.env.REEL_NEXT_MIN_DAYS || 14))
);
const SECOND_REEL_MIN_MULTIPLIER = Math.max(
  1,
  Number(process.env.SECOND_REEL_MIN_MULTIPLIER || 1.25)
);

const CREATOR_PORTAL_URL =
  process.env.CREATOR_PORTAL_URL ||
  `${REFERRAL_BASE_URL}/creator`;

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

const CREATOR_EMAIL_FROM =
  process.env.CREATOR_EMAIL_FROM ||
  `GigProfit Creator Program <${process.env.CREATOR_EMAIL_SMTP_USER || CONTACT_EMAIL}>`;

let creatorMailer = null;

let loaded = false;
let store = {
  version: 4,
  updatedAt: null,
  creators: {},
  payouts: {},
  accountAttributions: {},
  funding: {},
};

let writeQueue = Promise.resolve();

function nowISO() {
  return new Date().toISOString();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeCashtag(value) {
  const clean = String(value || "").trim().replace(/^\$+/, "");
  if (!clean || clean.length > 30 || /\s/.test(clean)) return null;
  if (!/^[A-Za-z0-9_]+$/.test(clean)) return null;
  return `$${clean}`;
}

function normalizeReelUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;

    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        ["fbclid", "gclid", "igshid", "igsh", "tt_from", "share_app_id"].includes(lower)
      ) {
        url.searchParams.delete(key);
      }
    }

    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return null;
  }
}

function reelPlatformFor(urlValue) {
  try {
    const host = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("tiktok.com")) return "TikTok";
    if (host.includes("youtube.com") || host === "youtu.be") return "YouTube";
    if (host.includes("facebook.com") || host === "fb.watch") return "Facebook";
    if (host.includes("threads.net")) return "Threads";
    if (host.includes("x.com") || host.includes("twitter.com")) return "X";
    return host;
  } catch {
    return "Video";
  }
}

function hashSecret(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");
    return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function safeEqualText(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function creatorEmailConfigured() {
  return Boolean(
    String(process.env.CREATOR_EMAIL_SMTP_USER || "").trim() &&
    String(process.env.CREATOR_EMAIL_SMTP_PASS || "").trim()
  );
}

function getCreatorMailer() {
  if (!creatorEmailConfigured()) return null;
  if (creatorMailer) return creatorMailer;

  creatorMailer = nodemailer.createTransport({
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

  return creatorMailer;
}

function creatorInvitationMessage(creator, accessKey) {
  const referralUrl =
    `${REFERRAL_BASE_URL}/r/${encodeURIComponent(creator.code)}`;

  const subject = "Welcome to the GigProfit Creator Program";

  const text = [
    `Hi ${creator.name},`,
    "",
    "You've been added to the GigProfit Creator Program by Nova Prime LLC.",
    "",
    "Your creator login:",
    `Creator Portal: ${CREATOR_PORTAL_URL}`,
    `Referral code: ${creator.code}`,
    `Email: ${creator.email}`,
    `Creator access key: ${accessKey}`,
    "",
    "Your referral link:",
    referralUrl,
    "",
    "Compensation:",
    `Reel fee: $${moneyNumber(creator.reelFee).toFixed(2)}`,
    `Valid account-created bonus: $${moneyNumber(creator.accountBonus).toFixed(2)} per valid GigProfit account created`,
    "",
    "Use only the referral code in the Referral code field — do not paste the full referral URL.",
    "Keep your access key private. Your dashboard shows downloads, valid accounts created, earnings, available balance, and Cash Out requests. Downloads and clicks are analytics only and do not directly generate creator compensation.",
    "",
    `Creator support: ${CONTACT_EMAIL}`,
    "",
    "GigProfit · Nova Prime LLC",
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#07080c;color:#f7f8fb;padding:32px">
      <div style="max-width:620px;margin:0 auto;background:#11151f;border:1px solid #252b38;border-radius:18px;padding:28px">
        <div style="font-size:14px;color:#ff7a1a;font-weight:700;letter-spacing:.04em">GIGPROFIT CREATOR PROGRAM</div>
        <h1 style="font-size:28px;margin:10px 0 8px">Welcome, ${htmlEscape(creator.name)}</h1>
        <p style="color:#b8c0cf">You've been added to the GigProfit Creator Program by Nova Prime LLC.</p>

        <div style="background:#0b0e14;border-radius:14px;padding:18px;margin:22px 0">
          <div style="color:#8f9aab;font-size:12px;text-transform:uppercase">Creator login</div>
          <p><strong>Portal:</strong> <a style="color:#69a3ff" href="${htmlEscape(CREATOR_PORTAL_URL)}">${htmlEscape(CREATOR_PORTAL_URL)}</a></p>
          <p><strong>Referral code:</strong> ${htmlEscape(creator.code)}</p>
          <p><strong>Email:</strong> ${htmlEscape(creator.email)}</p>
          <p><strong>Access key:</strong><br><code style="display:inline-block;margin-top:6px;padding:9px 12px;background:#171c27;border-radius:8px;color:#fff">${htmlEscape(accessKey)}</code></p>
        </div>

        <div style="background:#0b0e14;border-radius:14px;padding:18px;margin:22px 0">
          <div style="color:#8f9aab;font-size:12px;text-transform:uppercase">Your referral link</div>
          <p><a style="color:#69a3ff" href="${htmlEscape(referralUrl)}">${htmlEscape(referralUrl)}</a></p>
        </div>

        <div style="background:#0b0e14;border-radius:14px;padding:18px;margin:22px 0">
          <div style="color:#8f9aab;font-size:12px;text-transform:uppercase">Compensation</div>
          <p><strong>Reel fee:</strong> $${moneyNumber(creator.reelFee).toFixed(2)}</p>
          <p><strong>Valid account-created bonus:</strong> $${moneyNumber(creator.accountBonus).toFixed(2)} per valid GigProfit account created</p>
        </div>

        <p style="color:#b8c0cf"><strong>Important:</strong> In the Referral code field, enter only <strong>${htmlEscape(creator.code)}</strong>, not the full referral URL.</p>
        <p style="color:#b8c0cf">Keep your access key private. Your dashboard shows downloads, valid accounts created, earnings, available balance, and Cash Out requests. Downloads and clicks are analytics only and do not directly generate creator compensation.</p>
        <p style="color:#8f9aab;margin-top:28px">Creator support: <a style="color:#69a3ff" href="mailto:${htmlEscape(CONTACT_EMAIL)}">${htmlEscape(CONTACT_EMAIL)}</a></p>
        <div style="color:#687284;font-size:12px;margin-top:26px">GigProfit · Nova Prime LLC</div>
      </div>
    </div>
  `;

  return { subject, text, html, referralUrl };
}

async function sendCreatorInvitation(creator, accessKey) {
  const mailer = getCreatorMailer();

  if (!mailer) {
    return {
      configured: false,
      sent: false,
      error: "Creator email delivery is not configured",
    };
  }

  const message = creatorInvitationMessage(creator, accessKey);

  try {
    const info = await mailer.sendMail({
      from: CREATOR_EMAIL_FROM,
      to: creator.email,
      replyTo: CONTACT_EMAIL,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    return {
      configured: true,
      sent: true,
      messageId: info?.messageId || null,
      sentAt: nowISO(),
    };
  } catch (error) {
    console.error("CREATOR INVITATION EMAIL ERROR:", error);
    return {
      configured: true,
      sent: false,
      error: error?.message || String(error),
    };
  }
}


async function sendProgramEmail({ to, subject, title, textLines = [], htmlLines = [] }) {
  const mailer = getCreatorMailer();

  if (!mailer) {
    return {
      configured: false,
      sent: false,
      error: "Creator email delivery is not configured",
    };
  }

  const text = [
    title,
    "",
    ...textLines,
    "",
    `Support: ${CONTACT_EMAIL}`,
    "",
    "GigProfit · Nova Prime LLC",
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#07080c;color:#f7f8fb;padding:32px">
      <div style="max-width:620px;margin:0 auto;background:#11151f;border:1px solid #252b38;border-radius:18px;padding:28px">
        <div style="font-size:14px;color:#ff7a1a;font-weight:700;letter-spacing:.04em">GIGPROFIT CREATOR PROGRAM</div>
        <h1 style="font-size:26px;margin:10px 0 18px">${htmlEscape(title)}</h1>
        ${htmlLines.join("\n")}
        <p style="color:#8f9aab;margin-top:28px">Support: <a style="color:#69a3ff" href="mailto:${htmlEscape(CONTACT_EMAIL)}">${htmlEscape(CONTACT_EMAIL)}</a></p>
        <div style="color:#687284;font-size:12px;margin-top:26px">GigProfit · Nova Prime LLC</div>
      </div>
    </div>
  `;

  try {
    const info = await mailer.sendMail({
      from: CREATOR_EMAIL_FROM,
      to,
      replyTo: CONTACT_EMAIL,
      subject,
      text,
      html,
    });

    return {
      configured: true,
      sent: true,
      messageId: info?.messageId || null,
      sentAt: nowISO(),
    };
  } catch (error) {
    console.error("CREATOR PROGRAM EMAIL ERROR:", error);
    return {
      configured: true,
      sent: false,
      error: error?.message || String(error),
    };
  }
}

async function sendOwnerReelReviewNotification(creator, reel) {
  if (!reel) return { sent: false, error: "Reel submission missing" };

  const fee = moneyNumber(reel.plannedFee ?? creator.reelFee);
  return sendProgramEmail({
    to: CONTACT_EMAIL,
    subject: `GigProfit Reel #${reel.number} Review — ${creator.name}`,
    title: `Reel #${reel.number} Submitted`,
    textLines: [
      `Creator: ${creator.name}`,
      `Platform: ${reel.platform || "Video"}`,
      `Reel fee if approved: $${fee.toFixed(2)}`,
      `Video: ${reel.url}`,
      "",
      `Review it here: ${OWNER_PORTAL_URL}`,
    ],
    htmlLines: [
      `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0">
        <p><strong>Creator:</strong> ${htmlEscape(creator.name)}</p>
        <p><strong>Reel:</strong> #${Number(reel.number || 1)}</p>
        <p><strong>Platform:</strong> ${htmlEscape(reel.platform || "Video")}</p>
        <p><strong>Reel fee if approved:</strong> $${fee.toFixed(2)}</p>
      </div>`,
      `<p><a style="display:inline-block;background:#ff7a1a;color:#111;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px" href="${htmlEscape(reel.url)}">Open submitted video</a></p>`,
      `<p><a style="color:#69a3ff" href="${htmlEscape(OWNER_PORTAL_URL)}">Open Owner Center to approve or reject</a></p>`,
    ],
  });
}

async function sendCreatorReelStatusNotification(creator, reel, type) {
  if (!creator?.email || !reel) {
    return { sent: false, error: "Creator email or Reel submission missing" };
  }

  const fee = moneyNumber(reel.approvedFee ?? reel.plannedFee ?? creator.reelFee);

  if (type === "approved") {
    return sendProgramEmail({
      to: creator.email,
      subject: `Your GigProfit Reel #${reel.number} was approved — $${fee.toFixed(2)} added`,
      title: `Reel #${reel.number} Approved`,
      textLines: [
        `Hi ${creator.name},`,
        "Your GigProfit promotional Reel has been approved.",
        `Reel fee credited: $${fee.toFixed(2)}`,
        `Video: ${reel.url}`,
        "",
        "The Reel fee is now included in your GigProfit earnings.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your GigProfit promotional Reel #${Number(reel.number || 1)} has been <strong>approved</strong>.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Reel fee credited:</strong> $${fee.toFixed(2)}</div>`,
        `<p><a style="color:#69a3ff" href="${htmlEscape(CREATOR_PORTAL_URL)}">Open Creator Center</a></p>`,
      ],
    });
  }

  if (type === "rejected") {
    return sendProgramEmail({
      to: creator.email,
      subject: `Update on your GigProfit Reel #${reel.number}`,
      title: `Reel #${reel.number} Needs Changes`,
      textLines: [
        `Hi ${creator.name},`,
        "Your submitted Reel was not approved.",
        `Reason: ${reel.rejectionReason || "Please contact Creator Support for details."}`,
        "",
        "No Reel fee was credited. You can submit a corrected or new video for the same Reel opportunity.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your submitted Reel #${Number(reel.number || 1)} was <strong>not approved</strong>.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Reason:</strong> ${htmlEscape(reel.rejectionReason || "Please contact Creator Support for details.")}</div>`,
        `<p style="color:#b8c0cf">No Reel fee was credited. You can submit a corrected video for this same opportunity.</p>`,
      ],
    });
  }

  return { sent: false, error: "Unknown Reel notification type" };
}

async function sendOwnerNextReelRequestNotification(creator, request) {
  return sendProgramEmail({
    to: CONTACT_EMAIL,
    subject: `GigProfit Reel #${request.number} Opportunity Request — ${creator.name}`,
    title: `Reel #${request.number} Opportunity Request`,
    textLines: [
      `Creator: ${creator.name}`,
      `Lifetime paid: $${moneyNumber(creator.metrics?.paidEarnings).toFixed(2)}`,
      `Verified downloads: ${Number(creator.metrics?.installs || 0)}`,
      `Minimum Reel fee: $${moneyNumber(request.minimumFee).toFixed(2)}`,
      `Suggested Reel fee: $${moneyNumber(request.suggestedFee).toFixed(2)}`,
      "",
      `Approve or reject it here: ${OWNER_PORTAL_URL}`,
    ],
    htmlLines: [
      `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0">
        <p><strong>Creator:</strong> ${htmlEscape(creator.name)}</p>
        <p><strong>Requested:</strong> Reel #${Number(request.number)}</p>
        <p><strong>Lifetime paid:</strong> $${moneyNumber(creator.metrics?.paidEarnings).toFixed(2)}</p>
        <p><strong>Verified downloads:</strong> ${Number(creator.metrics?.installs || 0)}</p>
        <p><strong>Minimum fee:</strong> $${moneyNumber(request.minimumFee).toFixed(2)}</p>
      </div>`,
      `<p><a style="display:inline-block;background:#ff7a1a;color:#111;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px" href="${htmlEscape(OWNER_PORTAL_URL)}">Review Reel Opportunity</a></p>`,
    ],
  });
}

async function sendCreatorNextReelRequestStatus(creator, request, type) {
  if (!creator?.email) {
    return { sent: false, error: "Creator email missing" };
  }

  if (type === "approved") {
    return sendProgramEmail({
      to: creator.email,
      subject: `GigProfit Reel #${request.number} is unlocked`,
      title: `Reel #${request.number} Opportunity Approved`,
      textLines: [
        `Hi ${creator.name},`,
        `Your request for another GigProfit Reel has been approved.`,
        `Approved Reel fee: $${moneyNumber(request.approvedFee).toFixed(2)}`,
        "",
        "Publish the new GigProfit promotional video and submit its public link in your Creator Center. The fee is credited only after the finished video is reviewed and approved.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your Reel #${Number(request.number)} opportunity has been <strong>approved</strong>.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Approved Reel fee:</strong> $${moneyNumber(request.approvedFee).toFixed(2)}</div>`,
        `<p><a style="color:#69a3ff" href="${htmlEscape(CREATOR_PORTAL_URL)}">Open Creator Center</a></p>`,
      ],
    });
  }

  if (type === "rejected") {
    return sendProgramEmail({
      to: creator.email,
      subject: `Update on your GigProfit Reel #${request.number} opportunity`,
      title: "Additional Reel Request Update",
      textLines: [
        `Hi ${creator.name},`,
        "Your request for another paid GigProfit Reel was not approved at this time.",
        `Reason: ${request.rejectionReason || "Please contact Creator Support for details."}`,
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your request for Reel #${Number(request.number)} was not approved at this time.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Reason:</strong> ${htmlEscape(request.rejectionReason || "Please contact Creator Support for details.")}</div>`,
      ],
    });
  }

  return { sent: false, error: "Unknown Reel opportunity notification type" };
}

async function sendOwnerPayoutRequestNotification(creator, payout) {
  const destination =
    payout.method === "bank_account"
      ? [payout.bankName, payout.bankLast4 ? `•••• ${payout.bankLast4}` : null]
          .filter(Boolean)
          .join(" ")
      : payout.cashtag || "Payout destination";

  return sendProgramEmail({
    to: CONTACT_EMAIL,
    subject: `New GigProfit Cash Out Request — $${moneyNumber(payout.amount).toFixed(2)} — ${creator.name}`,
    title: "New Cash Out Request",
    textLines: [
      `Creator: ${creator.name}`,
      `Amount: $${moneyNumber(payout.amount).toFixed(2)}`,
      `Destination: ${destination}`,
      `Method: ${payout.method === "bank_account" ? "Bank account via Stripe" : "Legacy Cash App"}`,
      `Payout ID: ${payout.id}`,
      "",
      `Estimated bank arrival after approval: ${PAYOUT_ESTIMATE_MIN_DAYS}–${PAYOUT_ESTIMATE_MAX_DAYS} business days (estimate)`,
      `Review and approve or reject it here: ${OWNER_PORTAL_URL}`,
    ],
    htmlLines: [
      `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0">
        <p><strong>Creator:</strong> ${htmlEscape(creator.name)}</p>
        <p><strong>Amount:</strong> $${moneyNumber(payout.amount).toFixed(2)}</p>
        <p><strong>Destination:</strong> ${htmlEscape(destination)}</p>
        <p><strong>Method:</strong> ${payout.method === "bank_account" ? "Bank account via Stripe" : "Legacy Cash App"}</p>
        <p><strong>Payout ID:</strong> ${htmlEscape(payout.id)}</p>
      </div>`,
      `<p><strong>Estimated arrival:</strong> ${PAYOUT_ESTIMATE_MIN_DAYS}–${PAYOUT_ESTIMATE_MAX_DAYS} business days after approval. Bank processing times, weekends and holidays can affect delivery.</p>`,
      `<p><a style="display:inline-block;background:#ff7a1a;color:#111;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px" href="${htmlEscape(OWNER_PORTAL_URL)}">Review Cash Out</a></p>`,
    ],
  });
}

async function sendCreatorPayoutStatusNotification(creator, payout, type) {
  if (!creator?.email) {
    return {
      configured: creatorEmailConfigured(),
      sent: false,
      error: "Creator email missing",
    };
  }

  const amount = moneyNumber(payout.amount).toFixed(2);
  const destination =
    payout.method === "bank_account"
      ? [payout.bankName, payout.bankLast4 ? `•••• ${payout.bankLast4}` : null]
          .filter(Boolean)
          .join(" ")
      : payout.cashtag || "Payout destination";
  const arrival =
    payout.expectedArrivalDate ||
    `${PAYOUT_ESTIMATE_MIN_DAYS}–${PAYOUT_ESTIMATE_MAX_DAYS} business days`;

  if (type === "approved") {
    return sendProgramEmail({
      to: creator.email,
      subject: `Your GigProfit payout of $${amount} was approved`,
      title: "Cash Out Approved",
      textLines: [
        `Hi ${creator.name},`,
        `Your Cash Out request for $${amount} has been approved.`,
        `Destination: ${destination}`,
        `Estimated arrival: ${arrival}`,
        "",
        "Your payout is being processed. Bank processing times, weekends and holidays may affect the delivery date.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your Cash Out request for <strong>$${amount}</strong> has been approved.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0">
          <p><strong>Destination:</strong> ${htmlEscape(destination)}</p>
          <p><strong>Estimated arrival:</strong> ${htmlEscape(arrival)}</p>
        </div>`,
        `<p style="color:#b8c0cf">Approval means the payout has been released for processing; it does not mean your bank has received it yet.</p>`,
      ],
    });
  }

  if (type === "paid") {
    return sendProgramEmail({
      to: creator.email,
      subject: `Your GigProfit payout of $${amount} has been sent`,
      title: "Payout Sent",
      textLines: [
        `Hi ${creator.name},`,
        `Your GigProfit payout of $${amount} has been sent.`,
        `Destination: ${destination}`,
        payout.expectedArrivalDate
          ? `Stripe expected arrival: ${payout.expectedArrivalDate}`
          : `Typical bank arrival: ${PAYOUT_ESTIMATE_MIN_DAYS}–${PAYOUT_ESTIMATE_MAX_DAYS} business days`,
        "",
        "You can view the payout in your Creator Center history.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your GigProfit payout of <strong>$${amount}</strong> has been sent.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0">
          <p><strong>Destination:</strong> ${htmlEscape(destination)}</p>
          <p><strong>Estimated arrival:</strong> ${htmlEscape(arrival)}</p>
        </div>`,
        `<p><a style="color:#69a3ff" href="${htmlEscape(CREATOR_PORTAL_URL)}">Open Creator Center</a></p>`,
      ],
    });
  }

  if (type === "rejected") {
    return sendProgramEmail({
      to: creator.email,
      subject: "Update on your GigProfit Cash Out request",
      title: "Cash Out Request Update",
      textLines: [
        `Hi ${creator.name},`,
        `Your Cash Out request for $${amount} was not approved.`,
        `Reason: ${payout.failureReason || "Contact Creator Support for details."}`,
        "",
        "The reserved amount has been returned to your available balance.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your Cash Out request for <strong>$${amount}</strong> was not approved.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Reason:</strong> ${htmlEscape(payout.failureReason || "Contact Creator Support for details.")}</div>`,
        '<p style="color:#b8c0cf">The reserved amount has been returned to your available balance.</p>',
      ],
    });
  }

  return {
    configured: creatorEmailConfigured(),
    sent: false,
    error: "Unknown payout notification type",
  };
}

async function notifyPayoutOnce(payout, type) {
  payout.notifications ||= {};

  const key = `${type}At`;
  if (payout.notifications[key]) {
    return { sent: false, skipped: true };
  }

  const creator = store.creators[payout.creatorCode];
  if (!creator) {
    return { sent: false, error: "Creator not found" };
  }

  const result = await sendCreatorPayoutStatusNotification(creator, payout, type);

  if (result.sent) {
    payout.notifications[key] = result.sentAt || nowISO();
    payout.notifications[`${type}MessageId`] = result.messageId || null;
  } else {
    payout.notifications[`${type}Error`] = result.error || null;
  }

  return result;
}

function moneyNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function ensureCreatorShape(creator) {
  creator.metrics ||= {};
  creator.recentFingerprints ||= [];
  creator.cashApp ||= {};
  creator.reelFee = moneyNumber(creator.reelFee);
  creator.accountBonus = moneyNumber(
    creator.accountBonus ??
    creator.downloadBonus ??
    creator.commissionPerDownload ??
    DEFAULT_ACCOUNT_BONUS
  );
  // Legacy field retained only for old stored records/UI compatibility.
  creator.downloadBonus = creator.accountBonus;

  const legacySubmission =
    creator.reelSubmission && typeof creator.reelSubmission === "object"
      ? creator.reelSubmission
      : null;
  const legacyCompleted = Boolean(creator.reelCompleted);

  if (!Array.isArray(creator.reels)) {
    creator.reels = [];
  }

  if (creator.reels.length === 0 && legacySubmission) {
    creator.reels.push({
      ...legacySubmission,
      id: legacySubmission.id || `reel_${crypto.randomUUID()}`,
      number: 1,
      attempt: 1,
      plannedFee: moneyNumber(
        legacySubmission.approvedFee ??
        creator.reelFee
      ),
    });
  } else if (creator.reels.length === 0 && legacyCompleted) {
    creator.reels.push({
      id: `reel_${crypto.randomUUID()}`,
      number: 1,
      attempt: 1,
      url: null,
      normalizedUrl: null,
      platform: "Legacy",
      plannedFee: creator.reelFee,
      approvedFee: creator.reelFee,
      status: "approved",
      submittedAt: creator.createdAt || nowISO(),
      reviewedAt: creator.updatedAt || creator.createdAt || nowISO(),
      approvedAt: creator.updatedAt || creator.createdAt || nowISO(),
      rejectedAt: null,
      rejectionReason: null,
      reviewedBy: "Legacy migration",
      notifications: {},
    });
  }

  creator.reels = creator.reels.map((reel, index) => {
    const normalized = reel || {};
    normalized.id = normalized.id || `reel_${crypto.randomUUID()}`;
    normalized.number = Math.max(1, Math.floor(Number(normalized.number || index + 1)));
    normalized.attempt = Math.max(1, Math.floor(Number(normalized.attempt || 1)));
    normalized.status = normalized.status || "pending";
    normalized.url = normalized.url || null;
    normalized.normalizedUrl =
      normalized.normalizedUrl ||
      normalizeReelUrl(normalized.url) ||
      normalized.url ||
      null;
    normalized.platform =
      normalized.platform ||
      (normalized.url ? reelPlatformFor(normalized.url) : null);
    normalized.plannedFee = moneyNumber(
      normalized.plannedFee ??
      normalized.approvedFee ??
      creator.reelFee
    );
    normalized.approvedFee =
      normalized.approvedFee === null || normalized.approvedFee === undefined
        ? null
        : moneyNumber(normalized.approvedFee);
    normalized.rejectionReason = normalized.rejectionReason || null;
    normalized.notifications ||= {};
    return normalized;
  });

  creator.reelProgram ||= {};
  creator.reelProgram.goodStanding =
    creator.reelProgram.goodStanding === undefined
      ? true
      : Boolean(creator.reelProgram.goodStanding);
  creator.reelProgram.nextRequest =
    creator.reelProgram.nextRequest && typeof creator.reelProgram.nextRequest === "object"
      ? creator.reelProgram.nextRequest
      : null;
  creator.reelProgram.activeOpportunity =
    creator.reelProgram.activeOpportunity &&
    typeof creator.reelProgram.activeOpportunity === "object"
      ? creator.reelProgram.activeOpportunity
      : null;

  const approved = creator.reels.filter((reel) => reel.status === "approved");
  creator.reelCompleted = approved.length > 0;
  creator.reelSubmission = creator.reels.length
    ? creator.reels[creator.reels.length - 1]
    : null;

  creator.metrics.clicks = Number(creator.metrics.clicks || 0);
  creator.metrics.uniqueClicks = Number(creator.metrics.uniqueClicks || 0);
  creator.metrics.installs = Number(creator.metrics.installs || 0);
  creator.metrics.accountsCreated = Number(creator.metrics.accountsCreated || 0);
  creator.metrics.subscriptions = Number(creator.metrics.subscriptions || 0);
  creator.metrics.revenue = moneyNumber(creator.metrics.revenue || 0);
  creator.metrics.paidEarnings = moneyNumber(
    creator.metrics.paidEarnings ??
    creator.metrics.paidCommission ??
    0
  );

  creator.cashApp.cashtag = creator.cashApp.cashtag || null;
  creator.cashApp.connected = Boolean(creator.cashApp.connected);
  creator.cashApp.provider = creator.cashApp.provider || null;
  creator.cashApp.providerCustomerId = creator.cashApp.providerCustomerId || null;
  creator.cashApp.providerGrantId = creator.cashApp.providerGrantId || null;
  creator.cashApp.updatedAt = creator.cashApp.updatedAt || null;

  creator.bankPayout ||= {};
  creator.bankPayout.provider =
    creator.bankPayout.provider || "stripe_global_payouts";
  creator.bankPayout.recipientId = creator.bankPayout.recipientId || null;
  creator.bankPayout.payoutMethodId = creator.bankPayout.payoutMethodId || null;
  creator.bankPayout.connected = Boolean(creator.bankPayout.connected);
  creator.bankPayout.status =
    creator.bankPayout.status ||
    (creator.bankPayout.connected ? "connected" : "not_connected");
  creator.bankPayout.bankName = creator.bankPayout.bankName || null;
  creator.bankPayout.last4 = creator.bankPayout.last4 || null;
  creator.bankPayout.capabilityStatus =
    creator.bankPayout.capabilityStatus || null;
  creator.bankPayout.requirementsPending =
    Math.max(0, Number(creator.bankPayout.requirementsPending || 0));
  creator.bankPayout.updatedAt = creator.bankPayout.updatedAt || null;
  creator.bankPayout.onboardingStartedAt =
    creator.bankPayout.onboardingStartedAt || null;

  creator.invitation ||= {};
  creator.invitation.lastSentAt = creator.invitation.lastSentAt || null;
  creator.invitation.lastMessageId = creator.invitation.lastMessageId || null;
  creator.invitation.lastError = creator.invitation.lastError || null;
  creator.invitation.delivery = creator.invitation.delivery || "not_sent";
  creator.invitation.sendCount = Math.max(
    0,
    Math.floor(Number(creator.invitation.sendCount || 0))
  );

  return creator;
}

function ensureStoreShape(parsed = {}) {
  const next = {
    version: 4,
    updatedAt: parsed?.updatedAt || null,
    creators: parsed?.creators || {},
    payouts: parsed?.payouts || {},
    accountAttributions: parsed?.accountAttributions || {},
    funding: parsed?.funding || {},
  };

  next.funding.activeInboundTransferId =
    next.funding.activeInboundTransferId || null;
  next.funding.activeIntentId =
    next.funding.activeIntentId || null;
  next.funding.activeAmountCents =
    Math.max(0, Math.floor(Number(next.funding.activeAmountCents || 0)));
  next.funding.startedAt = next.funding.startedAt || null;
  next.funding.lastStatus = next.funding.lastStatus || null;
  next.funding.lastError = next.funding.lastError || null;
  next.funding.lastErrorAt = next.funding.lastErrorAt || null;
  next.funding.lastCompletedAt = next.funding.lastCompletedAt || null;
  next.funding.lastAvailableUsdCents =
    Number.isFinite(Number(next.funding.lastAvailableUsdCents))
      ? Number(next.funding.lastAvailableUsdCents)
      : null;

  for (const creator of Object.values(next.creators)) {
    ensureCreatorShape(creator);
  }

  return next;
}

function creatorActivityScore(creator) {
  ensureCreatorShape(creator);
  const metrics = creator.metrics || {};
  return [
    Number((creator.reels || []).length > 0),
    Number((creator.reels || []).some((reel) => ["approved", "pending"].includes(reel.status))),
    Number(metrics.clicks || 0) +
      Number(metrics.installs || 0) +
      Number(metrics.accountsCreated || 0),
    Number(metrics.paidEarnings || 0),
    Number(Boolean(creator.bankPayout?.connected || creator.cashApp?.cashtag)),
  ];
}

function compareCanonicalCreators(a, b) {
  const as = creatorActivityScore(a.creator);
  const bs = creatorActivityScore(b.creator);

  for (let i = 0; i < as.length; i += 1) {
    if (as[i] !== bs[i]) return bs[i] - as[i];
  }

  const at = Date.parse(a.creator.createdAt || "") || Number.MAX_SAFE_INTEGER;
  const bt = Date.parse(b.creator.createdAt || "") || Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;

  return String(a.code).localeCompare(String(b.code));
}

function dedupeCreatorsByEmail(inputStore) {
  const groups = new Map();

  for (const [code, creator] of Object.entries(inputStore.creators || {})) {
    const email = normalizeEmail(creator?.email);
    if (!email) continue;
    if (!groups.has(email)) groups.set(email, []);
    groups.get(email).push({ code, creator });
  }

  const removed = [];
  const remap = new Map();

  for (const [email, entries] of groups.entries()) {
    if (entries.length <= 1) continue;

    const ordered = [...entries].sort(compareCanonicalCreators);
    const keep = ordered[0];

    for (const duplicate of ordered.slice(1)) {
      removed.push({
        email,
        keptCode: keep.code,
        removedCode: duplicate.code,
      });
      remap.set(duplicate.code, keep.code);
      delete inputStore.creators[duplicate.code];
    }
  }

  if (remap.size) {
    for (const payout of Object.values(inputStore.payouts || {})) {
      const mappedCode = remap.get(payout.creatorCode);
      if (!mappedCode) continue;
      const canonical = inputStore.creators[mappedCode];
      payout.creatorCode = mappedCode;
      if (canonical?.name) payout.creatorName = canonical.name;
      payout.updatedAt = nowISO();
    }

    for (const attribution of Object.values(inputStore.accountAttributions || {})) {
      const mappedCode = remap.get(attribution?.creatorCode);
      if (mappedCode) attribution.creatorCode = mappedCode;
    }
  }

  return { changed: removed.length > 0, removed };
}

async function ensureLoaded() {
  if (loaded) return;

  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = ensureStoreShape(JSON.parse(raw));
    const dedupe = dedupeCreatorsByEmail(parsed);

    if (dedupe.changed) {
      const dir = path.dirname(DATA_PATH);
      await fs.mkdir(dir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = path.extname(DATA_PATH) || ".json";
      const base = ext ? DATA_PATH.slice(0, -ext.length) : DATA_PATH;
      const backupPath = `${base}.backup.${timestamp}${ext}`;
      await fs.writeFile(backupPath, raw, "utf8");

      parsed.updatedAt = nowISO();
      const tempPath = `${DATA_PATH}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(parsed, null, 2), "utf8");
      await fs.rename(tempPath, DATA_PATH);

      console.log(
        "REFERRAL DUPLICATE CREATOR CLEANUP:",
        JSON.stringify({
          backupPath,
          removed: dedupe.removed,
          remainingCreators: Object.keys(parsed.creators).length,
        })
      );
    }

    store = parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("REFERRAL DATA LOAD ERROR:", error);
    }
    store = ensureStoreShape(store);
  }

  loaded = true;
}

async function persist() {
  await ensureLoaded();
  store.updatedAt = nowISO();

  writeQueue = writeQueue.then(async () => {
    const dir = path.dirname(DATA_PATH);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${DATA_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tempPath, DATA_PATH);
  });

  return writeQueue;
}

function getClientIP(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

function fingerprintFor(req, creatorCode) {
  const raw = [
    process.env.REFERRAL_HASH_SALT || "gigprofit-referrals-v1",
    creatorCode,
    getClientIP(req),
    String(req.headers["user-agent"] || ""),
  ].join("|");

  return hashSecret(raw);
}

function cleanupFingerprints(creator) {
  const cutoff = Date.now() - UNIQUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  creator.recentFingerprints = (creator.recentFingerprints || [])
    .filter((item) => {
      const ts = Date.parse(item?.createdAt || "");
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .slice(-MAX_RECENT_FINGERPRINTS);
}

function creatorPayouts(code) {
  return Object.values(store.payouts || {})
    .filter((payout) => payout.creatorCode === code)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function reservedAmountForCreator(code) {
  const reservingStatuses = new Set(["requested", "approved", "funding", "processing"]);
  return moneyNumber(
    creatorPayouts(code)
      .filter((payout) => reservingStatuses.has(payout.status))
      .reduce((sum, payout) => sum + Number(payout.amount || 0), 0)
  );
}

function approvedReelsFor(creator) {
  ensureCreatorShape(creator);
  return creator.reels
    .filter((reel) => reel.status === "approved")
    .sort((a, b) => {
      const an = Number(a.number || 0);
      const bn = Number(b.number || 0);
      if (an !== bn) return an - bn;
      return String(a.approvedAt || "").localeCompare(String(b.approvedAt || ""));
    });
}

function pendingReelFor(creator) {
  ensureCreatorShape(creator);
  return [...creator.reels]
    .reverse()
    .find((reel) => reel.status === "pending") || null;
}

function lastRejectedReelForNextSlot(creator) {
  ensureCreatorShape(creator);
  const approvedCount = approvedReelsFor(creator).length;
  const nextNumber = approvedCount + 1;
  return [...creator.reels]
    .reverse()
    .find((reel) => reel.status === "rejected" && Number(reel.number) === nextNumber) || null;
}

function lastApprovedReel(creator) {
  const approved = approvedReelsFor(creator);
  return approved.length ? approved[approved.length - 1] : null;
}

function nextReelFeePolicy(creator) {
  ensureCreatorShape(creator);
  const approved = approvedReelsFor(creator);
  const nextNumber = approved.length + 1;

  if (nextNumber === 1) {
    const fee = moneyNumber(creator.reelFee);
    return { number: 1, minimumFee: fee, suggestedFee: fee };
  }

  const previousFee = moneyNumber(
    approved[approved.length - 1]?.approvedFee ??
    approved[approved.length - 1]?.plannedFee ??
    creator.reelFee
  );

  if (nextNumber === 2) {
    const minimumFee = moneyNumber(previousFee * SECOND_REEL_MIN_MULTIPLIER);
    return {
      number: 2,
      minimumFee,
      suggestedFee: minimumFee,
    };
  }

  return {
    number: nextNumber,
    minimumFee: previousFee,
    suggestedFee: moneyNumber(previousFee * 1.25),
  };
}

function nextReelEligibility(creator) {
  ensureCreatorShape(creator);

  const approved = approvedReelsFor(creator);
  const lastApproved = approved.length ? approved[approved.length - 1] : null;
  const paid = moneyNumber(creator.metrics.paidEarnings || 0);
  const downloads = Number(creator.metrics.installs || 0);
  const goodStanding = Boolean(creator.reelProgram.goodStanding);
  const now = Date.now();
  const lastApprovedMs = Date.parse(lastApproved?.approvedAt || "");
  const daysSinceLastApproved = Number.isFinite(lastApprovedMs)
    ? Math.max(0, Math.floor((now - lastApprovedMs) / 86400000))
    : 0;

  const requirements = {
    previousReelApproved: {
      met: approved.length > 0,
      current: approved.length,
      required: 1,
      label: "Previous Reel approved",
    },
    lifetimePaid: {
      met: paid >= REEL_NEXT_MIN_LIFETIME_PAID,
      current: paid,
      required: REEL_NEXT_MIN_LIFETIME_PAID,
      label: "Lifetime paid",
    },
    verifiedDownloads: {
      met: downloads >= REEL_NEXT_MIN_VERIFIED_DOWNLOADS,
      current: downloads,
      required: REEL_NEXT_MIN_VERIFIED_DOWNLOADS,
      label: "Verified downloads",
    },
    waitingPeriod: {
      met: Boolean(lastApproved) && daysSinceLastApproved >= REEL_NEXT_MIN_DAYS,
      current: daysSinceLastApproved,
      required: REEL_NEXT_MIN_DAYS,
      label: "Days since last approved Reel",
    },
    goodStanding: {
      met: goodStanding,
      current: goodStanding,
      required: true,
      label: "Account standing",
    },
  };

  const noPendingReel = !pendingReelFor(creator);
  const noOpenOpportunity =
    !creator.reelProgram.activeOpportunity ||
    creator.reelProgram.activeOpportunity.status !== "unlocked";
  const noPendingRequest =
    !creator.reelProgram.nextRequest ||
    creator.reelProgram.nextRequest.status !== "requested";

  const eligible =
    approved.length > 0 &&
    Object.values(requirements).every((item) => item.met) &&
    noPendingReel &&
    noOpenOpportunity &&
    noPendingRequest;

  return {
    eligible,
    requirements,
    approvedReels: approved.length,
    nextReelNumber: approved.length + 1,
    feePolicy: nextReelFeePolicy(creator),
    blockedByPendingReel: !noPendingReel,
    blockedByOpenOpportunity: !noOpenOpportunity,
    blockedByPendingRequest: !noPendingRequest,
  };
}

function earningsForCreator(creator) {
  ensureCreatorShape(creator);

  const reelEarnings = moneyNumber(
    approvedReelsFor(creator).reduce(
      (sum, reel) =>
        sum + Number(reel.approvedFee ?? reel.plannedFee ?? 0),
      0
    )
  );
  const accountEarnings =
    Number(creator.metrics.accountsCreated || 0) *
    Number(creator.accountBonus || 0);
  const grossEarnings = moneyNumber(reelEarnings + accountEarnings);
  const paidEarnings = moneyNumber(creator.metrics.paidEarnings || 0);
  const pendingPayouts = reservedAmountForCreator(creator.code);
  const availableEarnings = moneyNumber(
    Math.max(0, grossEarnings - paidEarnings - pendingPayouts)
  );

  return {
    reelEarnings,
    accountEarnings: moneyNumber(accountEarnings),
    // Downloads remain analytics only. Legacy value is always zero.
    downloadEarnings: 0,
    grossEarnings,
    paidEarnings,
    pendingPayouts,
    availableEarnings,
  };
}

function reelView(reel) {
  if (!reel) return null;
  return {
    id: reel.id || null,
    number: Number(reel.number || 1),
    attempt: Number(reel.attempt || 1),
    status: reel.status || "pending",
    url: reel.url || null,
    platform: reel.platform || (reel.url ? reelPlatformFor(reel.url) : null),
    plannedFee: moneyNumber(reel.plannedFee || 0),
    approvedFee:
      reel.approvedFee === null || reel.approvedFee === undefined
        ? null
        : moneyNumber(reel.approvedFee),
    submittedAt: reel.submittedAt || null,
    reviewedAt: reel.reviewedAt || null,
    approvedAt: reel.approvedAt || null,
    rejectedAt: reel.rejectedAt || null,
    rejectionReason: reel.rejectionReason || null,
  };
}

function reelSubmissionView(creator) {
  ensureCreatorShape(creator);
  return reelView(
    creator.reels.length ? creator.reels[creator.reels.length - 1] : null
  ) || {
    status: "not_submitted",
    number: 1,
    attempt: 0,
    url: null,
    platform: null,
    plannedFee: moneyNumber(creator.reelFee),
    approvedFee: null,
    submittedAt: null,
    reviewedAt: null,
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
  };
}

function payoutView(payout) {
  return {
    id: payout.id,
    creatorCode: payout.creatorCode,
    creatorName: payout.creatorName,
    amount: moneyNumber(payout.amount),
    method: payout.method,
    cashtag: payout.cashtag || null,
    bankName: payout.bankName || null,
    bankLast4: payout.bankLast4 || null,
    status: payout.status,
    provider: payout.provider || null,
    providerPayoutId: payout.providerPayoutId || null,
    providerStatus: payout.providerStatus || null,
    fundingInboundTransferId: payout.fundingInboundTransferId || null,
    fundingAmount: payout.fundingAmountCents
      ? moneyNumber(Number(payout.fundingAmountCents) / 100)
      : 0,
    fundingStartedAt: payout.fundingStartedAt || null,
    fundingStatus: payout.fundingStatus || null,
    expectedArrivalDate: payout.expectedArrivalDate || null,
    estimatedArrival:
      payout.estimatedArrival ||
      `${PAYOUT_ESTIMATE_MIN_DAYS}–${PAYOUT_ESTIMATE_MAX_DAYS} business days`,
    createdAt: payout.createdAt,
    approvedAt: payout.approvedAt || null,
    paidAt: payout.paidAt || null,
    rejectedAt: payout.rejectedAt || null,
    failureReason: payout.failureReason || null,
  };
}

function creatorView(creator, includePrivate = false) {
  ensureCreatorShape(creator);
  const earnings = earningsForCreator(creator);

  const view = {
    code: creator.code,
    name: creator.name,
    status: creator.status,
    referralUrl: `${REFERRAL_BASE_URL}/r/${encodeURIComponent(creator.code)}`,
    campaignUrl: creator.campaignUrl || null,
    reelFee: moneyNumber(creator.reelFee),
    reelCompleted: Boolean(creator.reelCompleted),
    reelSubmission: reelSubmissionView(creator),
    reels: creator.reels.slice(-30).reverse().map(reelView),
    reelProgram: {
      goodStanding: Boolean(creator.reelProgram.goodStanding),
      eligibility: nextReelEligibility(creator),
      nextRequest: creator.reelProgram.nextRequest || null,
      activeOpportunity: creator.reelProgram.activeOpportunity || null,
    },
    accountBonus: moneyNumber(creator.accountBonus),
    // Deprecated compatibility alias; compensation is based on accounts created.
    downloadBonus: moneyNumber(creator.accountBonus),
    minimumPayout: MIN_PAYOUT,
    payoutEstimate: {
      minBusinessDays: PAYOUT_ESTIMATE_MIN_DAYS,
      maxBusinessDays: PAYOUT_ESTIMATE_MAX_DAYS,
      label: `${PAYOUT_ESTIMATE_MIN_DAYS}–${PAYOUT_ESTIMATE_MAX_DAYS} business days`,
    },
    bankPayout: {
      connected: Boolean(creator.bankPayout?.connected),
      status: creator.bankPayout?.status || "not_connected",
      provider: creator.bankPayout?.provider || "stripe_global_payouts",
      bankName: creator.bankPayout?.bankName || null,
      last4: creator.bankPayout?.last4 || null,
      capabilityStatus: creator.bankPayout?.capabilityStatus || null,
      requirementsPending: Number(
        creator.bankPayout?.requirementsPending || 0
      ),
      updatedAt: creator.bankPayout?.updatedAt || null,
    },
    cashApp: {
      cashtag: creator.cashApp?.cashtag || null,
      connected: Boolean(creator.cashApp?.connected),
      provider: creator.cashApp?.provider || null,
      updatedAt: creator.cashApp?.updatedAt || null,
    },
    metrics: {
      clicks: Number(creator.metrics?.clicks || 0),
      uniqueClicks: Number(creator.metrics?.uniqueClicks || 0),
      installs: Number(creator.metrics?.installs || 0),
      accountsCreated: Number(creator.metrics?.accountsCreated || 0),
      subscriptions: Number(creator.metrics?.subscriptions || 0),
      revenue: moneyNumber(creator.metrics?.revenue || 0),
      ...earnings,
    },
    payouts: creatorPayouts(creator.code).slice(0, 20).map(payoutView),
    createdAt: creator.createdAt,
    updatedAt: creator.updatedAt,
  };

  if (includePrivate) {
    view.email = creator.email;
    view.notes = creator.notes || "";
    view.invitation = {
      delivery: creator.invitation?.delivery || "not_sent",
      lastSentAt: creator.invitation?.lastSentAt || null,
      lastError: creator.invitation?.lastError || null,
      sendCount: Number(creator.invitation?.sendCount || 0),
    };
    view.cashApp.providerCustomerId = creator.cashApp?.providerCustomerId || null;
    view.cashApp.providerGrantId = creator.cashApp?.providerGrantId || null;
    view.bankPayout.recipientId = creator.bankPayout?.recipientId || null;
    view.bankPayout.payoutMethodId = creator.bankPayout?.payoutMethodId || null;
  }

  return view;
}

function requireAdmin(req, res, next) {
  const configured = String(process.env.REFERRAL_ADMIN_KEY || "");

  if (!configured) {
    return res.status(503).json({
      error: "Referral admin access is not configured yet",
      requiredEnv: "REFERRAL_ADMIN_KEY",
    });
  }

  const provided = String(req.headers["x-referral-admin-key"] || "");

  if (!safeEqualText(configured, provided)) {
    return res.status(401).json({ error: "Invalid admin key" });
  }

  next();
}

function creatorAuthorized(req, creator) {
  const provided = String(req.headers["x-creator-key"] || "");
  if (!provided) return false;
  return safeEqualHex(hashSecret(provided), creator.accessKeyHash);
}

function uniqueCode(base) {
  if (!store.creators[base]) return base;

  let index = 2;
  while (store.creators[`${base}-${index}`]) index += 1;
  return `${base}-${index}`;
}

function stripeGlobalPayoutsKey() {
  return String(
    process.env.STRIPE_GLOBAL_PAYOUTS_KEY ||
    process.env.STRIPE_SECRET_KEY ||
    ""
  ).trim();
}

function stripeRestrictedKeyConfigured() {
  return stripeGlobalPayoutsKey().startsWith("rk_");
}

function stripeGlobalPayoutsConfigured() {
  return Boolean(
    stripeRestrictedKeyConfigured() &&
    STRIPE_FINANCIAL_ACCOUNT_ID
  );
}

function stripeAutofundConfigured() {
  return Boolean(
    STRIPE_AUTOFUND_ENABLED &&
    stripeGlobalPayoutsConfigured() &&
    STRIPE_AUTOFUND_SOURCE_PAYOUT_METHOD_ID
  );
}

function stripeInboundPendingUsdCents(financialAccount) {
  const value =
    financialAccount?.balance?.inbound_pending?.usd?.value ??
    financialAccount?.balance?.inbound_pending?.USD?.value;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function stripeInboundTransferState(transfer) {
  const history = Array.isArray(transfer?.transfer_history)
    ? transfer.transfer_history
    : [];
  const types = history.map((entry) => String(entry?.type || "").toLowerCase());

  if (types.includes("bank_debit_returned")) return "returned";
  if (types.includes("bank_debit_failed")) return "failed";
  if (types.includes("bank_debit_succeeded")) return "succeeded";
  if (types.includes("bank_debit_processing")) return "processing";
  if (types.includes("bank_debit_queued")) return "queued";

  const raw = String(transfer?.status || "").toLowerCase();
  return raw || "pending";
}

function stripeInboundTransferFailureReason(transfer) {
  const history = Array.isArray(transfer?.transfer_history)
    ? transfer.transfer_history
    : [];
  const terminal = [...history].reverse().find((entry) =>
    ["bank_debit_failed", "bank_debit_returned"].includes(
      String(entry?.type || "").toLowerCase()
    )
  );
  if (!terminal) return null;
  const type = String(terminal.type || "").toLowerCase();
  return (
    terminal?.[type]?.failure_reason ||
    terminal?.[type]?.return_reason ||
    type.replaceAll("_", " ")
  );
}

function payoutAutomationConfigured() {
  return (
    stripeGlobalPayoutsConfigured() ||
    Boolean(
      process.env.CREATOR_PAYOUT_PROVIDER_URL &&
      process.env.CREATOR_PAYOUT_PROVIDER_TOKEN
    )
  );
}

async function stripeApiRequest(
  endpoint,
  {
    method = "GET",
    body = null,
    stripeContext = null,
    idempotencyKey = null,
  } = {}
) {
  const secret = stripeGlobalPayoutsKey();
  if (!secret) {
    throw new Error("Stripe bank payouts are not configured on GigProfit yet");
  }
  if (!secret.startsWith("rk_")) {
    throw new Error(
      "Stripe Global Payouts requires a live Restricted API Key (rk_live_...), not a standard secret key"
    );
  }

  const headers = {
    Authorization: `Bearer ${secret}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };

  if (stripeContext) {
    headers["Stripe-Context"] = stripeContext;
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  if (body !== null) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`https://api.stripe.com${endpoint}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `Stripe HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.stripe = data;
    throw error;
  }

  return data;
}

function stripePayoutStatus(rawValue) {
  const raw = String(rawValue || "").toLowerCase();

  if (
    [
      "posted",
      "paid",
      "completed",
      "succeeded",
      "delivered",
    ].includes(raw)
  ) {
    return "paid";
  }

  if (
    [
      "failed",
      "canceled",
      "cancelled",
      "returned",
      "rejected",
      "declined",
    ].includes(raw)
  ) {
    return "failed";
  }

  return "processing";
}

function stripeRecipientCapabilityStatus(account) {
  const local =
    account?.configuration?.recipient?.capabilities?.bank_accounts?.local;
  if (typeof local === "string") return local.toLowerCase();
  return String(local?.status || "").toLowerCase() || null;
}

function stripeRecipientRequirementsPending(account) {
  const entries = Array.isArray(account?.requirements?.entries)
    ? account.requirements.entries
    : [];
  return entries.filter((entry) =>
    Array.isArray(entry?.restricts_capabilities)
      ? entry.restricts_capabilities.length > 0
      : Boolean(entry?.restricts_capabilities)
  ).length;
}

async function retrieveStripeRecipientAccount(recipientId) {
  if (!recipientId) return null;

  const include = [
    "configuration.recipient",
    "requirements",
  ]
    .map(
      (item, index) =>
        `include[${index}]=${encodeURIComponent(item)}`
    )
    .join("&");

  return stripeApiRequest(
    `/v2/core/accounts/${encodeURIComponent(recipientId)}?${include}`
  );
}

async function retrieveStripeFundingAccount() {
  if (!STRIPE_FINANCIAL_ACCOUNT_ID) return null;
  return stripeApiRequest(
    `/v2/money_management/financial_accounts/${encodeURIComponent(
      STRIPE_FINANCIAL_ACCOUNT_ID
    )}`
  );
}

async function retrieveStripeInboundTransfer(id) {
  if (!id) return null;
  return stripeApiRequest(
    `/v2/money_management/inbound_transfers/${encodeURIComponent(id)}`
  );
}

async function createStripeInboundTransfer(amountCents, intentId) {
  if (!stripeAutofundConfigured()) {
    throw new Error(
      "Stripe automatic bank funding is not fully configured"
    );
  }

  const amount = Math.max(100, Math.floor(Number(amountCents || 0)));
  if (amount > STRIPE_AUTOFUND_MAX_SINGLE_DEBIT_CENTS) {
    throw new Error(
      `Automatic bank funding is capped at ${(
        STRIPE_AUTOFUND_MAX_SINGLE_DEBIT_CENTS / 100
      ).toFixed(2)} per transfer`
    );
  }

  const endpoint = "/v2/money_management/inbound_transfers";
  const description = "GigProfit creator payout funding".slice(0, 100);

  try {
    return await stripeApiRequest(endpoint, {
      method: "POST",
      idempotencyKey: intentId,
      body: {
        from: STRIPE_AUTOFUND_SOURCE_PAYOUT_METHOD_ID,
        to: {
          financial_account: STRIPE_FINANCIAL_ACCOUNT_ID,
        },
        amount: {
          value: amount,
          currency: "usd",
        },
        description,
      },
    });
  } catch (error) {
    const code = String(
      error?.stripe?.error?.code ||
      error?.stripe?.code ||
      ""
    ).toLowerCase();
    const message = String(error?.message || "").toLowerCase();
    const schemaError =
      Number(error?.status) === 400 &&
      (
        code.includes("invalid_argument") ||
        message.includes("unknown") ||
        message.includes("invalid") ||
        message.includes("required")
      );

    if (!schemaError) throw error;

    return stripeApiRequest(endpoint, {
      method: "POST",
      idempotencyKey: intentId,
      body: {
        from: {
          payment_method: STRIPE_AUTOFUND_SOURCE_PAYOUT_METHOD_ID,
        },
        to: {
          financial_account: STRIPE_FINANCIAL_ACCOUNT_ID,
          balance_type: "storage",
        },
        money_movement_amounts: {
          destination: {
            value: amount,
            currency: "usd",
          },
        },
        description,
      },
    });
  }
}

async function startStripeAutofund(amountCents, reason = "creator_payout") {
  if (!stripeAutofundConfigured()) {
    throw new Error(
      "Automatic Stripe bank funding is disabled or missing a funding source"
    );
  }

  const funding = store.funding || (store.funding = {});
  if (funding.activeInboundTransferId) {
    return {
      alreadyActive: true,
      id: funding.activeInboundTransferId,
      amountCents: Number(funding.activeAmountCents || 0),
      status: funding.lastStatus || "pending",
    };
  }

  const amount = Math.max(100, Math.floor(Number(amountCents || 0)));
  if (amount > STRIPE_AUTOFUND_MAX_SINGLE_DEBIT_CENTS) {
    throw new Error(
      `Required automatic bank funding (${(amount / 100).toFixed(2)}) exceeds the configured safety cap`
    );
  }

  const intentId =
    funding.activeIntentId ||
    `gigprofit-autofund-${crypto.randomUUID()}`;

  funding.activeIntentId = intentId;
  funding.activeAmountCents = amount;
  funding.startedAt = funding.startedAt || nowISO();
  funding.lastStatus = "starting";
  funding.lastError = null;
  funding.lastErrorAt = null;
  await persist();

  try {
    const transfer = await createStripeInboundTransfer(amount, intentId);
    if (!transfer?.id) {
      throw new Error("Stripe did not return an InboundTransfer ID");
    }

    funding.activeInboundTransferId = transfer.id;
    funding.lastStatus = stripeInboundTransferState(transfer);
    funding.lastError = null;
    funding.lastErrorAt = null;
    funding.reason = reason;
    await persist();

    return {
      alreadyActive: false,
      id: transfer.id,
      amountCents: amount,
      status: funding.lastStatus,
    };
  } catch (error) {
    funding.lastStatus = "error";
    funding.lastError = error?.message || String(error);
    funding.lastErrorAt = nowISO();
    await persist();
    throw error;
  }
}

function clearCompletedAutofund(status = "completed") {
  const funding = store.funding || (store.funding = {});
  funding.lastStatus = status;
  funding.lastCompletedAt = nowISO();
  funding.activeInboundTransferId = null;
  funding.activeIntentId = null;
  funding.activeAmountCents = 0;
  funding.startedAt = null;
}

async function maybeStartBufferFunding(currentAvailableCents) {
  if (!stripeAutofundConfigured()) return null;

  const available = Math.max(0, Number(currentAvailableCents || 0));
  if (available >= STRIPE_AUTOFUND_MIN_BALANCE_CENTS) return null;
  if (store.funding?.activeInboundTransferId) return null;

  const amount = Math.max(
    100,
    STRIPE_AUTOFUND_TARGET_BALANCE_CENTS - available
  );

  return startStripeAutofund(amount, "buffer_replenishment");
}

function stripeAvailableUsdCents(financialAccount) {
  const value =
    financialAccount?.balance?.available?.usd?.value ??
    financialAccount?.balance?.available?.USD?.value;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

async function createStripeRecipientOnboarding(creator) {
  if (!stripeGlobalPayoutsConfigured()) {
    throw new Error(
      "Stripe bank payouts are not fully configured on GigProfit yet"
    );
  }

  ensureCreatorShape(creator);

  if (!creator.bankPayout.recipientId) {
    const account = await stripeApiRequest("/v2/core/accounts", {
      method: "POST",
      idempotencyKey: `creator-recipient-${creator.code}`,
      body: {
        contact_email: creator.email,
        display_name: creator.name,
        identity: {
          country: "us",
          entity_type: "individual",
        },
        configuration: {
          recipient: {
            capabilities: {
              bank_accounts: {
                local: {
                  requested: true,
                },
              },
            },
          },
        },
      },
    });

    if (!account?.id) {
      throw new Error("Stripe did not return a recipient ID");
    }

    creator.bankPayout.recipientId = account.id;
  }

  const firstOnboarding = !creator.bankPayout.onboardingStartedAt;
  const useCase = firstOnboarding
    ? {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          return_url: `${CREATOR_PORTAL_URL}?bank=connected`,
          refresh_url: `${CREATOR_PORTAL_URL}?bank=refresh`,
        },
      }
    : {
        type: "account_update",
        account_update: {
          configurations: ["recipient"],
          return_url: `${CREATOR_PORTAL_URL}?bank=connected`,
          refresh_url: `${CREATOR_PORTAL_URL}?bank=refresh`,
        },
      };

  const link = await stripeApiRequest("/v2/core/account_links", {
    method: "POST",
    idempotencyKey: `creator-bank-link-${creator.code}-${Date.now()}`,
    body: {
      account: creator.bankPayout.recipientId,
      use_case: useCase,
    },
  });

  if (!link?.url) {
    throw new Error("Stripe did not return a bank onboarding link");
  }

  creator.bankPayout.status = "onboarding";
  creator.bankPayout.onboardingStartedAt =
    creator.bankPayout.onboardingStartedAt || nowISO();
  creator.bankPayout.updatedAt = nowISO();

  return {
    url: link.url,
    expiresAt: link.expires_at || null,
  };
}

async function refreshStripeBankPayoutStatus(creator) {
  ensureCreatorShape(creator);

  if (!creator.bankPayout.recipientId || !stripeGlobalPayoutsConfigured()) {
    return creator.bankPayout;
  }

  let account;
  let payoutMethods;

  try {
    [account, payoutMethods] = await Promise.all([
      retrieveStripeRecipientAccount(creator.bankPayout.recipientId),
      stripeApiRequest(
        "/v2/money_management/payout_methods?limit=100",
        {
          stripeContext: creator.bankPayout.recipientId,
        }
      ),
    ]);
  } catch (error) {
    creator.bankPayout.status = creator.bankPayout.connected
      ? "connected"
      : "onboarding";
    creator.bankPayout.updatedAt = nowISO();
    throw error;
  }

  const capabilityStatus = stripeRecipientCapabilityStatus(account);
  const requirementsPending = stripeRecipientRequirementsPending(account);
  const methods = Array.isArray(payoutMethods?.data)
    ? payoutMethods.data
    : [];
  const bankMethod =
    methods.find(
      (item) =>
        item?.type === "bank_account" &&
        item?.restricted !== true &&
        item?.bank_account?.archived !== true &&
        (
          !Array.isArray(item?.available_payout_speeds) ||
          item.available_payout_speeds.includes("standard")
        )
    ) || null;

  creator.bankPayout.capabilityStatus = capabilityStatus;
  creator.bankPayout.requirementsPending = requirementsPending;

  if (bankMethod && capabilityStatus === "active") {
    creator.bankPayout.payoutMethodId = bankMethod.id;
    creator.bankPayout.connected = true;
    creator.bankPayout.status = "connected";
    creator.bankPayout.bankName =
      bankMethod.bank_account?.bank_name ||
      creator.bankPayout.bankName ||
      "Bank account";
    creator.bankPayout.last4 =
      bankMethod.bank_account?.last4 ||
      creator.bankPayout.last4 ||
      null;
  } else {
    creator.bankPayout.connected = false;
    creator.bankPayout.status =
      capabilityStatus === "restricted"
        ? "restricted"
        : "onboarding";
    creator.bankPayout.payoutMethodId = bankMethod?.id || null;
  }

  creator.bankPayout.updatedAt = nowISO();
  return creator.bankPayout;
}

async function sendStripeBankPayout(payout) {
  if (!stripeGlobalPayoutsConfigured()) {
    throw new Error(
      "Stripe bank payouts are not fully configured on GigProfit yet"
    );
  }

  const creator = store.creators[payout.creatorCode];
  if (!creator) {
    throw new Error("Creator not found");
  }

  await refreshStripeBankPayoutStatus(creator);
  if (
    !creator.bankPayout.connected ||
    creator.bankPayout.capabilityStatus !== "active" ||
    !creator.bankPayout.recipientId ||
    !creator.bankPayout.payoutMethodId
  ) {
    const suffix = creator.bankPayout.requirementsPending
      ? ` (${creator.bankPayout.requirementsPending} Stripe requirement(s) still pending)`
      : "";
    throw new Error(
      `Creator bank account is not fully active for Stripe payouts${suffix}`
    );
  }

  const amountCents = Math.round(Number(payout.amount) * 100);
  const fundingAccount = await retrieveStripeFundingAccount();
  const availableUsdCents = stripeAvailableUsdCents(fundingAccount);
  store.funding ||= {};
  store.funding.lastAvailableUsdCents = availableUsdCents;

  if (
    STRIPE_AUTOFUND_FULL_PAYOUT_FROM_BANK &&
    !payout.fundingStartedAt
  ) {
    if (!stripeAutofundConfigured()) {
      throw new Error(
        "Automatic Stripe bank funding is not fully configured"
      );
    }

    const fundingResult = await startStripeAutofund(
      amountCents,
      `payout:${payout.id}`
    );

    payout.status = "funding";
    payout.provider = "stripe_global_payouts";
    payout.providerStatus = "FUNDING";
    payout.fundingInboundTransferId = fundingResult.id || null;
    payout.fundingAmountCents = fundingResult.amountCents || amountCents;
    payout.fundingStartedAt = nowISO();
    payout.fundingStatus = fundingResult.status || "pending";
    payout.estimatedArrival =
      "Approved; funding directly from the Nova Prime bank account before the creator payout is sent.";
    payout.updatedAt = nowISO();
    await persist();

    return {
      mode: "automated",
      status: "funding",
      provider: "stripe_global_payouts",
      providerPayoutId: null,
      providerStatus: "FUNDING",
      fundingInboundTransferId: payout.fundingInboundTransferId,
      fundingAmountCents: payout.fundingAmountCents,
      raw: fundingResult,
    };
  }

  if (
    availableUsdCents !== null &&
    availableUsdCents < amountCents
  ) {
    if (!stripeAutofundConfigured()) {
      throw new Error(
        `Insufficient Stripe Global Payouts balance. Available: ${(
          availableUsdCents / 100
        ).toFixed(2)}; requested: ${(amountCents / 100).toFixed(2)}`
      );
    }

    const desiredBalance = Math.max(
      amountCents,
      STRIPE_AUTOFUND_TARGET_BALANCE_CENTS
    );
    const fundingAmountCents = Math.max(
      100,
      desiredBalance - availableUsdCents
    );
    const fundingResult = await startStripeAutofund(
      fundingAmountCents,
      `payout:${payout.id}`
    );

    payout.status = "funding";
    payout.provider = "stripe_global_payouts";
    payout.providerStatus = "FUNDING";
    payout.fundingInboundTransferId = fundingResult.id || null;
    payout.fundingAmountCents = fundingResult.amountCents || fundingAmountCents;
    payout.fundingStartedAt = payout.fundingStartedAt || nowISO();
    payout.fundingStatus = fundingResult.status || "pending";
    payout.estimatedArrival =
      "Funding bank transfer in progress; payout sends automatically when funds are available";
    payout.updatedAt = nowISO();
    await persist();

    return {
      mode: "automated",
      status: "funding",
      provider: "stripe_global_payouts",
      providerPayoutId: null,
      providerStatus: "FUNDING",
      fundingInboundTransferId: payout.fundingInboundTransferId,
      fundingAmountCents: payout.fundingAmountCents,
      raw: fundingResult,
    };
  }

  const data = await stripeApiRequest(
    "/v2/money_management/outbound_payments",
    {
      method: "POST",
      idempotencyKey: payout.id,
      body: {
        from: {
          financial_account: STRIPE_FINANCIAL_ACCOUNT_ID,
          currency: "usd",
        },
        to: {
          recipient: creator.bankPayout.recipientId,
          payout_method: creator.bankPayout.payoutMethodId,
          currency: "usd",
        },
        amount: {
          value: amountCents,
          currency: "usd",
        },
        description: `GigProfit creator payout - ${creator.name}`.slice(0, 150),
      },
    }
  );

  const remainingAfterSend =
    availableUsdCents === null
      ? null
      : Math.max(0, availableUsdCents - amountCents);

  if (
    remainingAfterSend !== null &&
    stripeAutofundConfigured() &&
    remainingAfterSend < STRIPE_AUTOFUND_MIN_BALANCE_CENTS
  ) {
    void maybeStartBufferFunding(remainingAfterSend).catch((error) => {
      console.error(
        "STRIPE AUTOFUND BUFFER ERROR:",
        error?.message || error
      );
    });
  }

  return {
    mode: "automated",
    status: stripePayoutStatus(data?.status),
    provider: "stripe_global_payouts",
    providerPayoutId: data?.id || null,
    providerStatus: String(data?.status || "processing").toUpperCase(),
    expectedArrivalDate:
      data?.expected_arrival_date ||
      data?.expectedArrivalDate ||
      null,
    raw: data,
  };
}

function rollbackPaidCreditForReturnedPayout(payout) {
  if (!payout?.paidEarningsCredited) return;

  const creator = store.creators[payout.creatorCode];
  if (!creator) return;

  ensureCreatorShape(creator);
  creator.metrics.paidEarnings = moneyNumber(
    Math.max(
      0,
      Number(creator.metrics.paidEarnings || 0) -
        Number(payout.amount || 0)
    )
  );
  creator.updatedAt = nowISO();
  payout.paidEarningsCredited = false;
  payout.paidEarningsReversedAt = nowISO();
}

async function syncStripePayout(payout) {
  if (
    payout?.provider !== "stripe_global_payouts" ||
    !payout?.providerPayoutId ||
    !stripeGlobalPayoutsConfigured()
  ) {
    return false;
  }

  const data = await stripeApiRequest(
    `/v2/money_management/outbound_payments/${encodeURIComponent(
      payout.providerPayoutId
    )}`
  );

  const nextStatus = stripePayoutStatus(data?.status);
  payout.providerStatus = String(data?.status || "").toUpperCase();
  payout.expectedArrivalDate =
    data?.expected_arrival_date ||
    data?.expectedArrivalDate ||
    payout.expectedArrivalDate ||
    null;

  if (nextStatus === "paid") {
    finalizePaidPayout(payout);
    await notifyPayoutOnce(payout, "paid");
  } else if (nextStatus === "failed") {
    rollbackPaidCreditForReturnedPayout(payout);
    payout.status = "failed";
    payout.failureReason =
      data?.status_details?.returned?.reason ||
      data?.failure_reason?.message ||
      data?.failure_reason ||
      "Stripe bank payout failed, was canceled, or was returned";
  } else {
    payout.status = "processing";
  }

  payout.updatedAt = nowISO();
  return true;
}

async function syncStripeAutofundingAndFundedPayouts() {
  if (!stripeAutofundConfigured()) return false;

  const hasFundingWork =
    Boolean(store.funding?.activeInboundTransferId) ||
    Object.values(store.payouts || {}).some(
      (payout) =>
        payout.method === "bank_account" &&
        payout.status === "funding"
    );

  if (!hasFundingWork) return false;

  let changed = false;
  const funding = store.funding || (store.funding = {});
  let fundingAccount = await retrieveStripeFundingAccount();
  let availableUsdCents = stripeAvailableUsdCents(fundingAccount);
  const inboundPendingUsdCents = stripeInboundPendingUsdCents(fundingAccount);
  funding.lastAvailableUsdCents = availableUsdCents;

  if (funding.activeInboundTransferId) {
    try {
      const transfer = await retrieveStripeInboundTransfer(
        funding.activeInboundTransferId
      );
      const state = stripeInboundTransferState(transfer);
      funding.lastStatus = state;
      funding.lastError = null;
      funding.lastErrorAt = null;

      if (["failed", "returned"].includes(state)) {
        const reason =
          stripeInboundTransferFailureReason(transfer) ||
          "Bank funding transfer failed or was returned";
        funding.lastError = reason;
        funding.lastErrorAt = nowISO();

        for (const payout of Object.values(store.payouts || {})) {
          if (
            payout.status === "funding" &&
            payout.fundingInboundTransferId === funding.activeInboundTransferId
          ) {
            payout.status = "requested";
            payout.approvedAt = null;
            payout.failureReason =
              `Automatic bank funding failed: ${reason}`;
            payout.fundingStatus = state;
            payout.fundingInboundTransferId = null;
            payout.fundingAmountCents = 0;
            payout.fundingStartedAt = null;
            payout.updatedAt = nowISO();
          }
        }

        clearCompletedAutofund(state);
        changed = true;
      } else if (
        state === "succeeded" &&
        inboundPendingUsdCents === 0
      ) {
        clearCompletedAutofund("available");
        changed = true;
      }
    } catch (error) {
      funding.lastError = error?.message || String(error);
      funding.lastErrorAt = nowISO();
    }
  }

  fundingAccount = await retrieveStripeFundingAccount();
  availableUsdCents = stripeAvailableUsdCents(fundingAccount);
  funding.lastAvailableUsdCents = availableUsdCents;

  const fundedPayouts = Object.values(store.payouts || {})
    .filter(
      (payout) =>
        payout.method === "bank_account" &&
        payout.status === "funding"
    )
    .sort((a, b) =>
      String(a.approvedAt || a.createdAt).localeCompare(
        String(b.approvedAt || b.createdAt)
      )
    );

  for (const payout of fundedPayouts) {
    const amountCents = Math.round(Number(payout.amount || 0) * 100);
    if (
      availableUsdCents === null ||
      availableUsdCents < amountCents
    ) {
      continue;
    }

    try {
      payout.fundingStatus = "available";
      const result = await sendStripeBankPayout(payout);
      payout.provider = result.provider || "stripe_global_payouts";
      payout.providerPayoutId = result.providerPayoutId || null;
      payout.providerStatus = result.providerStatus || null;
      payout.expectedArrivalDate =
        result.expectedArrivalDate ||
        payout.expectedArrivalDate ||
        null;

      if (result.status === "paid") {
        finalizePaidPayout(payout);
        await notifyPayoutOnce(payout, "paid");
      } else if (result.status === "processing") {
        payout.status = "processing";
        await notifyPayoutOnce(payout, "approved");
      } else if (result.status === "funding") {
        payout.status = "funding";
      }

      payout.updatedAt = nowISO();
      availableUsdCents = Math.max(0, availableUsdCents - amountCents);
      changed = true;
    } catch (error) {
      payout.failureReason = error?.message || String(error);
      payout.updatedAt = nowISO();
      changed = true;
    }
  }

  const stillFunding = Object.values(store.payouts || {}).filter(
    (payout) =>
      payout.method === "bank_account" &&
      payout.status === "funding"
  );

  if (
    stillFunding.length &&
    !store.funding?.activeInboundTransferId &&
    availableUsdCents !== null
  ) {
    const totalNeeded = stillFunding.reduce(
      (sum, payout) =>
        sum + Math.round(Number(payout.amount || 0) * 100),
      0
    );

    if (availableUsdCents < totalNeeded) {
      const desired = Math.max(
        totalNeeded,
        STRIPE_AUTOFUND_TARGET_BALANCE_CENTS
      );
      const amount = Math.max(100, desired - availableUsdCents);

      try {
        const result = await startStripeAutofund(
          amount,
          "queued_creator_payouts"
        );
        for (const payout of stillFunding) {
          if (!payout.fundingInboundTransferId) {
            payout.fundingInboundTransferId = result.id || null;
            payout.fundingAmountCents = result.amountCents || amount;
            payout.fundingStartedAt =
              payout.fundingStartedAt || nowISO();
            payout.fundingStatus = result.status || "pending";
          }
        }
        changed = true;
      } catch (error) {
        funding.lastError = error?.message || String(error);
        funding.lastErrorAt = nowISO();
      }
    }
  }

  if (changed) await persist();
  return changed;
}

async function syncProcessingStripePayoutsForCreator(code) {
  const cutoff =
    Date.now() -
    STRIPE_RETURN_MONITOR_DAYS * 24 * 60 * 60 * 1000;

  const pending = creatorPayouts(code).filter((payout) => {
    if (payout.provider !== "stripe_global_payouts") return false;
    if (["approved", "processing"].includes(payout.status)) return true;

    if (payout.status === "paid") {
      const sentAt = Date.parse(
        payout.paidAt ||
        payout.updatedAt ||
        payout.createdAt ||
        ""
      );
      return Number.isFinite(sentAt) && sentAt >= cutoff;
    }

    return false;
  });

  let changed = false;
  for (const payout of pending.slice(0, 10)) {
    try {
      changed = (await syncStripePayout(payout)) || changed;
    } catch (error) {
      console.error("STRIPE PAYOUT STATUS SYNC ERROR:", error);
    }
  }

  if (changed) {
    await persist();
  }
}

async function sendPayoutToProvider(payout) {
  if (payout.method === "bank_account") {
    return sendStripeBankPayout(payout);
  }

  if (
    !process.env.CREATOR_PAYOUT_PROVIDER_URL ||
    !process.env.CREATOR_PAYOUT_PROVIDER_TOKEN
  ) {
    return {
      mode: "manual",
      status: "approved",
    };
  }

  const response = await fetch(process.env.CREATOR_PAYOUT_PROVIDER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CREATOR_PAYOUT_PROVIDER_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": payout.id,
    },
    body: JSON.stringify({
      payoutId: payout.id,
      creatorCode: payout.creatorCode,
      creatorName: payout.creatorName,
      amount: moneyNumber(payout.amount),
      amountCents: Math.round(Number(payout.amount) * 100),
      currency: "USD",
      method: payout.method || "cash_app",
      cashtag: payout.cashtag || null,
      senderCashtag: OWNER_CASHAPP_CASHTAG,
      idempotencyKey: payout.id,
      purpose: "creator_services",
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error ||
      data?.message ||
      `Payout provider HTTP ${response.status}`;
    throw new Error(message);
  }

  const rawStatus = String(
    data?.status ||
    data?.payout?.status ||
    "processing"
  ).toUpperCase();

  let status = "processing";
  if (["CAPTURED", "PAID", "COMPLETED", "SUCCEEDED"].includes(rawStatus)) {
    status = "paid";
  } else if (["DECLINED", "FAILED", "REJECTED"].includes(rawStatus)) {
    status = "failed";
  }

  return {
    mode: "automated",
    status,
    provider: data?.provider || "payout-provider",
    providerPayoutId:
      data?.providerPayoutId ||
      data?.payout_id ||
      data?.payout?.payout_id ||
      data?.payout?.id ||
      null,
    providerStatus: rawStatus,
    expectedArrivalDate:
      data?.expectedArrivalDate ||
      data?.expected_arrival_date ||
      null,
    raw: data,
  };
}

function finalizePaidPayout(payout) {
  if (payout.status === "paid") return;

  const creator = store.creators[payout.creatorCode];
  if (!creator) return;

  ensureCreatorShape(creator);
  if (!payout.paidEarningsCredited) {
    creator.metrics.paidEarnings = moneyNumber(
      Number(creator.metrics.paidEarnings || 0) + Number(payout.amount || 0)
    );
    payout.paidEarningsCredited = true;
  }

  payout.status = "paid";
  payout.paidAt = payout.paidAt || nowISO();
  creator.updatedAt = nowISO();
}

let stripeBackgroundSyncStarted = false;

function startStripeBackgroundSync() {
  if (stripeBackgroundSyncStarted || !stripeGlobalPayoutsConfigured()) return;
  stripeBackgroundSyncStarted = true;

  const run = async () => {
    try {
      await ensureLoaded();
      let changed = false;

      try {
        changed =
          (await syncStripeAutofundingAndFundedPayouts()) ||
          changed;
      } catch (error) {
        console.error(
          "STRIPE AUTOFUND BACKGROUND ERROR:",
          error?.message || error
        );
      }

      for (const creator of Object.values(store.creators)) {
        ensureCreatorShape(creator);

        if (
          creator.bankPayout?.recipientId &&
          ["onboarding", "connected", "restricted"].includes(
            creator.bankPayout?.status
          )
        ) {
          try {
            const before = JSON.stringify(creator.bankPayout);
            await refreshStripeBankPayoutStatus(creator);
            if (JSON.stringify(creator.bankPayout) !== before) changed = true;
          } catch (error) {
            console.error(
              "STRIPE BANK BACKGROUND STATUS ERROR:",
              creator.code,
              error?.message || error
            );
          }
        }

        const beforePayouts = JSON.stringify(
          creatorPayouts(creator.code).map((payout) => ({
            id: payout.id,
            status: payout.status,
            providerStatus: payout.providerStatus,
            expectedArrivalDate: payout.expectedArrivalDate,
            paidEarningsCredited: payout.paidEarningsCredited,
          }))
        );

        await syncProcessingStripePayoutsForCreator(creator.code);

        const afterPayouts = JSON.stringify(
          creatorPayouts(creator.code).map((payout) => ({
            id: payout.id,
            status: payout.status,
            providerStatus: payout.providerStatus,
            expectedArrivalDate: payout.expectedArrivalDate,
            paidEarningsCredited: payout.paidEarningsCredited,
          }))
        );
        if (beforePayouts !== afterPayouts) changed = true;
      }

      if (changed) await persist();
    } catch (error) {
      console.error(
        "STRIPE CREATOR BACKGROUND SYNC ERROR:",
        error?.message || error
      );
    }
  };

  const timer = setInterval(run, STRIPE_PAYOUT_SYNC_INTERVAL_MS);
  timer.unref?.();
  setTimeout(run, 15_000).unref?.();
}

export function createReferralRouter({ requireFirebaseAuth } = {}) {
  const router = express.Router();

  // Load and sanitize persisted creator data at process start, not only on the
  // first referral request. This also removes historical duplicate-email
  // creator records and creates a backup before rewriting the store.
  void ensureLoaded().catch((error) => {
    console.error("REFERRAL STARTUP LOAD ERROR:", error);
  });
  startStripeBackgroundSync();

  const requireReferralAccountAuth =
    typeof requireFirebaseAuth === "function"
      ? requireFirebaseAuth
      : (_req, res) =>
          res.status(503).json({
            error: "Account attribution authentication is unavailable",
          });

  router.get("/health", async (_req, res) => {
    await ensureLoaded();

    return res.json({
      ok: true,
      service: "gigprofit-referrals",
      version: 4,
      creators: Object.keys(store.creators).length,
      payouts: Object.keys(store.payouts).length,
      payoutAutomationConfigured: payoutAutomationConfigured(),
      stripeBankPayoutsConfigured: stripeGlobalPayoutsConfigured(),
      stripeRestrictedKeyConfigured: stripeRestrictedKeyConfigured(),
      stripeAutofundConfigured: stripeAutofundConfigured(),
      stripeAutofundEnabled: STRIPE_AUTOFUND_ENABLED,
      stripeAutofundFullPayoutFromBank:
        STRIPE_AUTOFUND_FULL_PAYOUT_FROM_BANK,
      stripeAutofundMinBalance: moneyNumber(
        STRIPE_AUTOFUND_MIN_BALANCE_CENTS / 100
      ),
      stripeAutofundTargetBalance: moneyNumber(
        STRIPE_AUTOFUND_TARGET_BALANCE_CENTS / 100
      ),
      stripeAutofundStatus: {
        active: Boolean(store.funding?.activeInboundTransferId),
        lastStatus: store.funding?.lastStatus || null,
        lastError: store.funding?.lastError || null,
        lastAvailableBalance:
          store.funding?.lastAvailableUsdCents === null ||
          store.funding?.lastAvailableUsdCents === undefined
            ? null
            : moneyNumber(store.funding.lastAvailableUsdCents / 100),
      },
      stripeBackgroundSyncEnabled: stripeGlobalPayoutsConfigured(),
      stripePayoutSyncIntervalSeconds:
        Math.round(STRIPE_PAYOUT_SYNC_INTERVAL_MS / 1000),
      creatorEmailConfigured: creatorEmailConfigured(),
      reelProgramPolicy: {
        minimumLifetimePaid: REEL_NEXT_MIN_LIFETIME_PAID,
        minimumVerifiedDownloads: REEL_NEXT_MIN_VERIFIED_DOWNLOADS,
        minimumDaysBetweenApprovedReels: REEL_NEXT_MIN_DAYS,
        secondReelMinimumMultiplier: SECOND_REEL_MIN_MULTIPLIER,
      },
      storage: DATA_PATH,
      contact: CONTACT_EMAIL,
    });
  });

  router.post("/click/:code", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({
        error: "Referral link not found",
        redirectUrl: APP_STORE_URL,
      });
    }

    ensureCreatorShape(creator);
    creator.metrics.clicks += 1;

    cleanupFingerprints(creator);
    const fingerprint = fingerprintFor(req, code);
    const alreadyCounted = creator.recentFingerprints.some(
      (item) => item.hash === fingerprint
    );

    if (!alreadyCounted) {
      creator.metrics.uniqueClicks += 1;
      creator.recentFingerprints.push({
        hash: fingerprint,
        createdAt: nowISO(),
      });
      creator.recentFingerprints =
        creator.recentFingerprints.slice(-MAX_RECENT_FINGERPRINTS);
    }

    creator.updatedAt = nowISO();
    await persist();

    return res.json({
      ok: true,
      code,
      redirectUrl: creator.campaignUrl || APP_STORE_URL,
    });
  });

  router.post(
    "/account-created/:code",
    requireReferralAccountAuth,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator || creator.status !== "active") {
        return res.status(404).json({ error: "Referral creator not found" });
      }

      const uid = String(req.auth?.uid || "").trim();
      if (!uid) {
        return res.status(401).json({ error: "Authenticated account required" });
      }

      ensureCreatorShape(creator);
      store.accountAttributions ||= {};

      const attributionKey = hashSecret(
        `gigprofit-account-attribution:${uid}`
      );
      const existing = store.accountAttributions[attributionKey];

      if (existing) {
        return res.json({
          ok: true,
          counted: false,
          alreadyCounted: true,
          creatorCode: existing.creatorCode,
          sameCreator: existing.creatorCode === code,
        });
      }

      store.accountAttributions[attributionKey] = {
        creatorCode: code,
        createdAt: nowISO(),
        emailHash: req.auth?.email
          ? hashSecret(
              `gigprofit-account-email:${normalizeEmail(req.auth.email)}`
            )
          : null,
      };

      creator.metrics.accountsCreated =
        Number(creator.metrics.accountsCreated || 0) + 1;
      creator.updatedAt = nowISO();
      await persist();

      return res.status(201).json({
        ok: true,
        counted: true,
        creatorCode: code,
        accountsCreated: creator.metrics.accountsCreated,
      });
    }
  );

  router.post("/creator/login", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.body?.code);
    const email = normalizeEmail(req.body?.email);
    const accessKey = String(req.body?.accessKey || "");
    const creator = store.creators[code];

    if (
      !creator ||
      creator.status !== "active" ||
      creator.email !== email ||
      !safeEqualHex(hashSecret(accessKey), creator.accessKeyHash)
    ) {
      return res.status(401).json({ error: "Invalid creator credentials" });
    }

    return res.json({
      ok: true,
      creator: creatorView(creator, false),
    });
  });

  router.get("/creator/:code", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({ error: "Creator not found" });
    }

    if (!creatorAuthorized(req, creator)) {
      return res.status(401).json({ error: "Invalid creator key" });
    }

    await syncProcessingStripePayoutsForCreator(code);

    return res.json({
      ok: true,
      creator: creatorView(creator, false),
    });
  });

  router.post("/creator/:code/reel", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({ error: "Creator not found" });
    }

    if (!creatorAuthorized(req, creator)) {
      return res.status(401).json({ error: "Invalid creator key" });
    }

    ensureCreatorShape(creator);

    if (pendingReelFor(creator)) {
      return res.status(409).json({
        error: "A Reel is already pending review",
      });
    }

    const normalizedUrl = normalizeReelUrl(req.body?.url);
    if (!normalizedUrl) {
      return res.status(400).json({
        error: "Enter a valid public video URL",
      });
    }

    for (const other of Object.values(store.creators)) {
      ensureCreatorShape(other);
      for (const existing of other.reels) {
        if (
          existing.normalizedUrl === normalizedUrl &&
          ["pending", "approved"].includes(existing.status)
        ) {
          return res.status(409).json({
            error: "This video link has already been submitted to GigProfit",
          });
        }
      }
    }

    const approvedCount = approvedReelsFor(creator).length;
    const nextNumber = approvedCount + 1;
    const rejectedRetry = lastRejectedReelForNextSlot(creator);

    let plannedFee;
    let attempt = 1;

    if (rejectedRetry) {
      plannedFee = moneyNumber(rejectedRetry.plannedFee);
      attempt =
        Math.max(
          0,
          ...creator.reels
            .filter((reel) => Number(reel.number) === nextNumber)
            .map((reel) => Number(reel.attempt || 1))
        ) + 1;
    } else if (nextNumber === 1) {
      plannedFee = moneyNumber(creator.reelFee);
    } else {
      const opportunity = creator.reelProgram.activeOpportunity;
      if (
        !opportunity ||
        opportunity.status !== "unlocked" ||
        Number(opportunity.number) !== nextNumber
      ) {
        return res.status(403).json({
          error: "This Reel opportunity is locked. Qualify and request approval for another Reel first.",
          eligibility: nextReelEligibility(creator),
        });
      }
      plannedFee = moneyNumber(opportunity.approvedFee);
    }

    const timestamp = nowISO();
    const reel = {
      id: `reel_${crypto.randomUUID()}`,
      number: nextNumber,
      attempt,
      url: normalizedUrl,
      normalizedUrl,
      platform: reelPlatformFor(normalizedUrl),
      plannedFee,
      status: "pending",
      submittedAt: timestamp,
      reviewedAt: null,
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      approvedFee: null,
      reviewedBy: null,
      notifications: {},
    };

    creator.reels.push(reel);
    creator.reelSubmission = reel;

    if (creator.reelProgram.activeOpportunity?.status === "unlocked") {
      creator.reelProgram.activeOpportunity = {
        ...creator.reelProgram.activeOpportunity,
        status: "submitted",
        submittedReelId: reel.id,
        submittedAt: timestamp,
      };
    }

    creator.updatedAt = timestamp;
    await persist();

    const ownerNotification = await sendOwnerReelReviewNotification(creator, reel);
    if (ownerNotification.sent) {
      reel.notifications.ownerSubmittedAt = ownerNotification.sentAt || nowISO();
      reel.notifications.ownerSubmittedMessageId =
        ownerNotification.messageId || null;
    } else {
      reel.notifications.ownerSubmittedError = ownerNotification.error || null;
    }
    await persist();

    return res.status(201).json({
      ok: true,
      reelSubmission: reelView(reel),
      creator: creatorView(creator, false),
    });
  });

  router.post("/creator/:code/reels/request-next", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({ error: "Creator not found" });
    }

    if (!creatorAuthorized(req, creator)) {
      return res.status(401).json({ error: "Invalid creator key" });
    }

    ensureCreatorShape(creator);
    const eligibility = nextReelEligibility(creator);

    if (!eligibility.eligible) {
      return res.status(403).json({
        error: "You have not met all requirements for another paid Reel yet",
        eligibility,
      });
    }

    const policy = eligibility.feePolicy;
    const request = {
      id: `reelreq_${crypto.randomUUID()}`,
      number: policy.number,
      status: "requested",
      minimumFee: moneyNumber(policy.minimumFee),
      suggestedFee: moneyNumber(policy.suggestedFee),
      requestedAt: nowISO(),
      reviewedAt: null,
      approvedFee: null,
      rejectionReason: null,
      notifications: {},
    };

    creator.reelProgram.nextRequest = request;
    creator.updatedAt = nowISO();
    await persist();

    const ownerNotification = await sendOwnerNextReelRequestNotification(
      creator,
      request
    );
    if (ownerNotification.sent) {
      request.notifications.ownerRequestedAt =
        ownerNotification.sentAt || nowISO();
      request.notifications.ownerRequestedMessageId =
        ownerNotification.messageId || null;
    } else {
      request.notifications.ownerRequestedError =
        ownerNotification.error || null;
    }
    await persist();

    return res.status(201).json({
      ok: true,
      request,
      creator: creatorView(creator, false),
    });
  });

  router.post("/creator/:code/bank/connect", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({ error: "Creator not found" });
    }

    if (!creatorAuthorized(req, creator)) {
      return res.status(401).json({ error: "Invalid creator key" });
    }

    if (!stripeGlobalPayoutsConfigured()) {
      return res.status(503).json({
        error: "Bank payouts are being connected to Stripe and are not available yet",
        code: "STRIPE_BANK_PAYOUTS_NOT_CONFIGURED",
      });
    }

    const hasActivePayout = creatorPayouts(code).some((payout) =>
      ["requested", "approved", "processing"].includes(payout.status)
    );
    if (hasActivePayout) {
      return res.status(409).json({
        error: "Bank payout details cannot be changed while a payout is pending",
      });
    }

    try {
      const onboarding = await createStripeRecipientOnboarding(creator);
      creator.updatedAt = nowISO();
      await persist();

      return res.json({
        ok: true,
        url: onboarding.url,
        expiresAt: onboarding.expiresAt,
        creator: creatorView(creator, false),
      });
    } catch (error) {
      console.error("STRIPE BANK ONBOARDING ERROR:", error);
      return res.status(502).json({
        error: "Unable to start secure bank connection",
        details: error?.message || String(error),
      });
    }
  });

  router.get("/creator/:code/bank/status", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({ error: "Creator not found" });
    }

    if (!creatorAuthorized(req, creator)) {
      return res.status(401).json({ error: "Invalid creator key" });
    }

    try {
      await refreshStripeBankPayoutStatus(creator);
      creator.updatedAt = nowISO();
      await persist();

      return res.json({
        ok: true,
        bankPayout: creatorView(creator, false).bankPayout,
        creator: creatorView(creator, false),
      });
    } catch (error) {
      console.error("STRIPE BANK STATUS ERROR:", error);
      return res.status(502).json({
        error: "Unable to refresh bank connection status",
        details: error?.message || String(error),
        creator: creatorView(creator, false),
      });
    }
  });

  router.put("/creator/:code/cashapp", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({ error: "Creator not found" });
    }

    if (!creatorAuthorized(req, creator)) {
      return res.status(401).json({ error: "Invalid creator key" });
    }

    const cashtag = normalizeCashtag(req.body?.cashtag);
    if (!cashtag) {
      return res.status(400).json({
        error: "Enter a valid Cash App $Cashtag",
      });
    }

    const hasActivePayout = creatorPayouts(code).some((payout) =>
      ["requested", "approved", "processing"].includes(payout.status)
    );

    if (hasActivePayout) {
      return res.status(409).json({
        error: "Cash App cannot be changed while a payout is pending",
      });
    }

    ensureCreatorShape(creator);
    creator.cashApp = {
      ...creator.cashApp,
      cashtag,
      connected: false,
      provider: "manual-cashtag",
      providerCustomerId: null,
      providerGrantId: null,
      updatedAt: nowISO(),
    };
    creator.updatedAt = nowISO();

    await persist();

    return res.json({
      ok: true,
      creator: creatorView(creator, false),
      warning:
        "GigProfit stores the destination $Cashtag. The creator name shown is the GigProfit registration name unless an official payout provider later verifies the Cash App account.",
    });
  });

  router.post("/creator/:code/payouts", async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator || creator.status !== "active") {
      return res.status(404).json({ error: "Creator not found" });
    }

    if (!creatorAuthorized(req, creator)) {
      return res.status(401).json({ error: "Invalid creator key" });
    }

    ensureCreatorShape(creator);

    if (!creator.bankPayout?.connected) {
      return res.status(400).json({
        error: "Connect a verified bank payout destination before requesting Cash Out",
      });
    }

    const amount = moneyNumber(req.body?.amount);
    const earnings = earningsForCreator(creator);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Payout amount must be greater than $0" });
    }

    if (amount > earnings.availableEarnings) {
      return res.status(400).json({
        error: `Maximum available payout is $${earnings.availableEarnings.toFixed(2)}`,
        available: earnings.availableEarnings,
      });
    }

    if (MIN_PAYOUT > 0 && amount < MIN_PAYOUT && amount !== earnings.availableEarnings) {
      return res.status(400).json({
        error: `Minimum payout is $${MIN_PAYOUT.toFixed(2)} unless withdrawing the full available balance`,
      });
    }

    const payoutId = `pay_${crypto.randomUUID()}`;
    const timestamp = nowISO();

    const payout = {
      id: payoutId,
      creatorCode: code,
      creatorName: creator.name,
      amount,
      method: "bank_account",
      cashtag: null,
      bankName: creator.bankPayout.bankName || "Bank account",
      bankLast4: creator.bankPayout.last4 || null,
      status: "requested",
      provider: null,
      providerPayoutId: null,
      providerStatus: null,
      expectedArrivalDate: null,
      estimatedArrival:
        `${PAYOUT_ESTIMATE_MIN_DAYS}–${PAYOUT_ESTIMATE_MAX_DAYS} business days`,
      failureReason: null,
      notifications: {
        ownerRequestedAt: null,
        approvedAt: null,
        paidAt: null,
        rejectedAt: null,
      },
      createdAt: timestamp,
      approvedAt: null,
      paidAt: null,
      rejectedAt: null,
      updatedAt: timestamp,
    };

    store.payouts[payoutId] = payout;
    creator.updatedAt = timestamp;
    await persist();

    const ownerNotification = await sendOwnerPayoutRequestNotification(creator, payout);
    payout.notifications ||= {};
    if (ownerNotification.sent) {
      payout.notifications.ownerRequestedAt = ownerNotification.sentAt || nowISO();
      payout.notifications.ownerRequestedMessageId = ownerNotification.messageId || null;
    } else {
      payout.notifications.ownerRequestedError = ownerNotification.error || null;
    }
    await persist();

    return res.status(201).json({
      ok: true,
      payout: payoutView(payout),
      creator: creatorView(creator, false),
    });
  });

  router.get("/admin/creators", requireAdmin, async (_req, res) => {
    await ensureLoaded();

    for (const creator of Object.values(store.creators)) {
      await syncProcessingStripePayoutsForCreator(creator.code);
    }

    const creators = Object.values(store.creators)
      .map((creator) => creatorView(creator, true))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({
      ok: true,
      creators,
      payoutAutomationConfigured: payoutAutomationConfigured(),
      stripeBankPayoutsConfigured: stripeGlobalPayoutsConfigured(),
      creatorEmailConfigured: creatorEmailConfigured(),
      ownerCashAppCashtag: OWNER_CASHAPP_CASHTAG,
      contactEmail: CONTACT_EMAIL,
    });
  });

  router.get("/admin/payouts", requireAdmin, async (_req, res) => {
    await ensureLoaded();

    for (const creator of Object.values(store.creators)) {
      await syncProcessingStripePayoutsForCreator(creator.code);
    }

    const payouts = Object.values(store.payouts)
      .map(payoutView)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({
      ok: true,
      payoutAutomationConfigured: payoutAutomationConfigured(),
      stripeBankPayoutsConfigured: stripeGlobalPayoutsConfigured(),
      ownerCashAppCashtag: OWNER_CASHAPP_CASHTAG,
      payouts,
    });
  });

  router.post("/admin/creators", requireAdmin, async (req, res) => {
    await ensureLoaded();

    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);

    if (!name || !email || !email.includes("@")) {
      return res.status(400).json({ error: "Name and creator email are required" });
    }

    const existingCreator = Object.values(store.creators).find(
      (item) => normalizeEmail(item?.email) === email
    );
    if (existingCreator) {
      ensureCreatorShape(existingCreator);
      return res.status(409).json({
        error: "Creator already exists with this email",
        code: "CREATOR_EMAIL_EXISTS",
        creator: creatorView(existingCreator, true),
      });
    }

    const requestedCode = slugify(req.body?.code || name);
    if (!requestedCode) {
      return res.status(400).json({ error: "A valid referral code is required" });
    }

    const code = uniqueCode(requestedCode);
    const accessKey = crypto.randomBytes(12).toString("base64url");
    const timestamp = nowISO();

    const creator = ensureCreatorShape({
      code,
      name,
      email,
      status: "active",
      campaignUrl: String(req.body?.campaignUrl || "").trim() || null,
      reelFee: Math.max(0, moneyNumber(req.body?.reelFee)),
      reelCompleted: false,
      reelSubmission: null,
      reels: [],
      reelProgram: {
        goodStanding: true,
        nextRequest: null,
        activeOpportunity: null,
      },
      accountBonus: Math.max(
        0,
        moneyNumber(
          req.body?.accountBonus ??
          req.body?.downloadBonus ??
          DEFAULT_ACCOUNT_BONUS
        )
      ),
      accessKeyHash: hashSecret(accessKey),
      notes: String(req.body?.notes || "").trim(),
      cashApp: {
        cashtag: null,
        connected: false,
        provider: null,
        providerCustomerId: null,
        providerGrantId: null,
        updatedAt: null,
      },
      bankPayout: {
        provider: "stripe_global_payouts",
        recipientId: null,
        payoutMethodId: null,
        connected: false,
        status: "not_connected",
        bankName: null,
        last4: null,
        capabilityStatus: null,
        requirementsPending: 0,
        updatedAt: null,
        onboardingStartedAt: null,
      },
      metrics: {
        clicks: 0,
        uniqueClicks: 0,
        installs: 0,
        accountsCreated: 0,
        subscriptions: 0,
        revenue: 0,
        paidEarnings: 0,
      },
      invitation: {
        delivery: "not_sent",
        lastSentAt: null,
        lastMessageId: null,
        lastError: null,
      },
      recentFingerprints: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    store.creators[code] = creator;
    await persist();

    const invitationEmail = await sendCreatorInvitation(creator, accessKey);

    if (invitationEmail.sent) {
      creator.invitation.delivery = "sent";
      creator.invitation.lastSentAt = invitationEmail.sentAt || nowISO();
      creator.invitation.lastMessageId = invitationEmail.messageId || null;
      creator.invitation.lastError = null;
      creator.invitation.sendCount = Number(creator.invitation.sendCount || 0) + 1;
    } else {
      creator.invitation.delivery = invitationEmail.configured ? "failed" : "not_configured";
      creator.invitation.lastError = invitationEmail.error || null;
    }

    creator.updatedAt = nowISO();
    await persist();

    return res.status(201).json({
      ok: true,
      creator: creatorView(creator, true),
      accessKey,
      invitationEmail,
    });
  });

  router.patch("/admin/creators/:code", requireAdmin, async (req, res) => {
    await ensureLoaded();

    const code = slugify(req.params.code);
    const creator = store.creators[code];

    if (!creator) {
      return res.status(404).json({ error: "Creator not found" });
    }

    ensureCreatorShape(creator);

    if (req.body?.name !== undefined) {
      creator.name = String(req.body.name || "").trim() || creator.name;
    }

    if (req.body?.email !== undefined) {
      const email = normalizeEmail(req.body.email);
      if (!email.includes("@")) {
        return res.status(400).json({ error: "Invalid email" });
      }
      const duplicate = Object.values(store.creators).find(
        (item) =>
          item !== creator &&
          normalizeEmail(item?.email) === email
      );
      if (duplicate) {
        return res.status(409).json({
          error: "Another creator already uses this email",
          code: "CREATOR_EMAIL_EXISTS",
          creator: creatorView(duplicate, true),
        });
      }
      creator.email = email;
    }

    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!["active", "paused"].includes(status)) {
        return res.status(400).json({ error: "Status must be active or paused" });
      }
      creator.status = status;
    }

    if (req.body?.campaignUrl !== undefined) {
      creator.campaignUrl = String(req.body.campaignUrl || "").trim() || null;
    }

    if (req.body?.reelFee !== undefined) {
      creator.reelFee = Math.max(0, moneyNumber(req.body.reelFee));
    }

    if (
      req.body?.accountBonus !== undefined ||
      req.body?.downloadBonus !== undefined
    ) {
      creator.accountBonus = Math.max(
        0,
        moneyNumber(req.body?.accountBonus ?? req.body?.downloadBonus)
      );
      creator.downloadBonus = creator.accountBonus;
    }

    if (req.body?.reelCompleted !== undefined) {
      return res.status(409).json({
        error: "Reel completion is controlled by the Reel review workflow",
      });
    }

    if (req.body?.goodStanding !== undefined) {
      creator.reelProgram.goodStanding = Boolean(req.body.goodStanding);
    }

    if (req.body?.notes !== undefined) {
      creator.notes = String(req.body.notes || "").trim();
    }

    creator.updatedAt = nowISO();
    await persist();

    return res.json({
      ok: true,
      creator: creatorView(creator, true),
    });
  });

  router.post(
    "/admin/creators/:code/reels/:reelId/approve",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);
      const reel = creator.reels.find((item) => item.id === req.params.reelId);

      if (!reel || reel.status !== "pending") {
        return res.status(409).json({
          error: reel?.status === "approved"
            ? "This Reel has already been approved and credited"
            : "There is no matching pending Reel to approve",
        });
      }

      const timestamp = nowISO();
      reel.status = "approved";
      reel.approvedFee = moneyNumber(reel.plannedFee);
      reel.reviewedAt = timestamp;
      reel.approvedAt = timestamp;
      reel.rejectedAt = null;
      reel.rejectionReason = null;
      reel.reviewedBy = "Nova Prime owner";

      creator.reelCompleted = true;
      creator.reelSubmission = reel;
      creator.reelProgram.activeOpportunity = null;
      creator.reelProgram.nextRequest = null;
      creator.updatedAt = timestamp;
      await persist();

      const notification = await sendCreatorReelStatusNotification(
        creator,
        reel,
        "approved"
      );
      reel.notifications ||= {};
      if (notification.sent) {
        reel.notifications.creatorApprovedAt = notification.sentAt || nowISO();
        reel.notifications.creatorApprovedMessageId =
          notification.messageId || null;
      } else {
        reel.notifications.creatorApprovedError = notification.error || null;
      }
      await persist();

      return res.json({
        ok: true,
        credited: reel.approvedFee,
        reel: reelView(reel),
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/reels/:reelId/reject",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);
      const reel = creator.reels.find((item) => item.id === req.params.reelId);

      if (!reel || reel.status !== "pending") {
        return res.status(409).json({
          error: reel?.status === "approved"
            ? "An approved Reel cannot be rejected after it has been credited"
            : "There is no matching pending Reel to reject",
        });
      }

      const reason = String(
        req.body?.reason ||
        "The submitted video did not meet GigProfit promotional requirements."
      ).trim();

      const timestamp = nowISO();
      reel.status = "rejected";
      reel.reviewedAt = timestamp;
      reel.rejectedAt = timestamp;
      reel.approvedAt = null;
      reel.approvedFee = null;
      reel.rejectionReason = reason;
      reel.reviewedBy = "Nova Prime owner";
      creator.reelSubmission = reel;

      creator.reelProgram.activeOpportunity = {
        number: Number(reel.number),
        approvedFee: moneyNumber(reel.plannedFee),
        minimumFee: moneyNumber(reel.plannedFee),
        status: "unlocked",
        source: "rejected-resubmission",
        approvedAt: timestamp,
      };

      creator.updatedAt = timestamp;
      await persist();

      const notification = await sendCreatorReelStatusNotification(
        creator,
        reel,
        "rejected"
      );
      reel.notifications ||= {};
      if (notification.sent) {
        reel.notifications.creatorRejectedAt = notification.sentAt || nowISO();
        reel.notifications.creatorRejectedMessageId =
          notification.messageId || null;
      } else {
        reel.notifications.creatorRejectedError = notification.error || null;
      }
      await persist();

      return res.json({
        ok: true,
        reel: reelView(reel),
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/reels/request-next/approve",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];
      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);
      const request = creator.reelProgram.nextRequest;

      if (!request || request.status !== "requested") {
        return res.status(409).json({
          error: "There is no pending additional Reel request",
        });
      }

      const policy = nextReelFeePolicy(creator);
      const minimumFee = moneyNumber(
        Math.max(Number(request.minimumFee || 0), Number(policy.minimumFee || 0))
      );
      const approvedFee = moneyNumber(
        req.body?.fee ?? request.suggestedFee ?? minimumFee
      );

      if (!Number.isFinite(approvedFee) || approvedFee < minimumFee) {
        return res.status(400).json({
          error: `Reel #${request.number} fee cannot be below $${minimumFee.toFixed(2)}`,
          minimumFee,
        });
      }

      const timestamp = nowISO();
      request.status = "approved";
      request.reviewedAt = timestamp;
      request.approvedAt = timestamp;
      request.approvedFee = approvedFee;
      request.rejectionReason = null;

      creator.reelProgram.activeOpportunity = {
        requestId: request.id,
        number: Number(request.number),
        approvedFee,
        minimumFee,
        status: "unlocked",
        source: "creator-request",
        approvedAt: timestamp,
      };
      creator.updatedAt = timestamp;
      await persist();

      const notification = await sendCreatorNextReelRequestStatus(
        creator,
        request,
        "approved"
      );
      request.notifications ||= {};
      if (notification.sent) {
        request.notifications.creatorApprovedAt =
          notification.sentAt || nowISO();
        request.notifications.creatorApprovedMessageId =
          notification.messageId || null;
      } else {
        request.notifications.creatorApprovedError =
          notification.error || null;
      }
      await persist();

      return res.json({
        ok: true,
        request,
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/reels/request-next/reject",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];
      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);
      const request = creator.reelProgram.nextRequest;

      if (!request || request.status !== "requested") {
        return res.status(409).json({
          error: "There is no pending additional Reel request",
        });
      }

      const timestamp = nowISO();
      request.status = "rejected";
      request.reviewedAt = timestamp;
      request.rejectedAt = timestamp;
      request.rejectionReason = String(
        req.body?.reason || "Not approved by Nova Prime at this time."
      ).trim();
      creator.updatedAt = timestamp;
      await persist();

      const notification = await sendCreatorNextReelRequestStatus(
        creator,
        request,
        "rejected"
      );
      request.notifications ||= {};
      if (notification.sent) {
        request.notifications.creatorRejectedAt =
          notification.sentAt || nowISO();
        request.notifications.creatorRejectedMessageId =
          notification.messageId || null;
      } else {
        request.notifications.creatorRejectedError =
          notification.error || null;
      }
      await persist();

      return res.json({
        ok: true,
        request,
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/reels/unlock-next",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];
      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);

      if (pendingReelFor(creator)) {
        return res.status(409).json({ error: "A Reel is already pending review" });
      }

      if (creator.reelProgram.activeOpportunity?.status === "unlocked") {
        return res.status(409).json({ error: "A Reel opportunity is already unlocked" });
      }

      const policy = nextReelFeePolicy(creator);
      if (policy.number <= 1) {
        return res.status(409).json({ error: "The first Reel is already open by default" });
      }

      const fee = moneyNumber(req.body?.fee ?? policy.suggestedFee);
      if (!Number.isFinite(fee) || fee < policy.minimumFee) {
        return res.status(400).json({
          error: `Reel #${policy.number} fee cannot be below $${moneyNumber(policy.minimumFee).toFixed(2)}`,
          minimumFee: moneyNumber(policy.minimumFee),
        });
      }

      const timestamp = nowISO();
      const request = {
        id: `ownerunlock_${crypto.randomUUID()}`,
        number: policy.number,
        status: "approved",
        minimumFee: moneyNumber(policy.minimumFee),
        suggestedFee: moneyNumber(policy.suggestedFee),
        requestedAt: timestamp,
        reviewedAt: timestamp,
        approvedAt: timestamp,
        approvedFee: fee,
        rejectionReason: null,
        source: "owner-override",
        notifications: {},
      };

      creator.reelProgram.nextRequest = request;
      creator.reelProgram.activeOpportunity = {
        requestId: request.id,
        number: policy.number,
        approvedFee: fee,
        minimumFee: moneyNumber(policy.minimumFee),
        status: "unlocked",
        source: "owner-override",
        approvedAt: timestamp,
      };
      creator.updatedAt = timestamp;
      await persist();

      const notification = await sendCreatorNextReelRequestStatus(
        creator,
        request,
        "approved"
      );
      if (notification.sent) {
        request.notifications.creatorApprovedAt =
          notification.sentAt || nowISO();
      }
      await persist();

      return res.json({
        ok: true,
        request,
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/metrics",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);

      for (const field of ["installs", "accountsCreated", "subscriptions", "revenue"]) {
        if (req.body?.[field] !== undefined) {
          const value = Number(req.body[field]);
          if (!Number.isFinite(value) || value < 0) {
            return res.status(400).json({ error: `Invalid ${field}` });
          }
          creator.metrics[field] =
            field === "revenue" ? moneyNumber(value) : Math.floor(value);
        }
      }

      creator.updatedAt = nowISO();
      await persist();

      return res.json({
        ok: true,
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/send-login-email",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      if (!creatorEmailConfigured()) {
        return res.status(503).json({
          error: "Creator email delivery is not configured",
          requiredEnv: [
            "CREATOR_EMAIL_SMTP_USER",
            "CREATOR_EMAIL_SMTP_PASS"
          ],
        });
      }

      const accessKey = crypto.randomBytes(12).toString("base64url");
      const invitationEmail = await sendCreatorInvitation(creator, accessKey);

      if (!invitationEmail.sent) {
        creator.invitation ||= {};
        creator.invitation.delivery = "failed";
        creator.invitation.lastError = invitationEmail.error || "Email delivery failed";
        creator.updatedAt = nowISO();
        await persist();

        return res.status(502).json({
          error: "Unable to send creator login email",
          details: invitationEmail.error || null,
        });
      }

      creator.accessKeyHash = hashSecret(accessKey);
      creator.invitation ||= {};
      creator.invitation.delivery = "sent";
      creator.invitation.lastSentAt = invitationEmail.sentAt || nowISO();
      creator.invitation.lastMessageId = invitationEmail.messageId || null;
      creator.invitation.lastError = null;
      creator.invitation.sendCount = Number(creator.invitation.sendCount || 0) + 1;
      creator.updatedAt = nowISO();
      await persist();

      return res.json({
        ok: true,
        invitationEmail: {
          sent: true,
          sentAt: creator.invitation.lastSentAt,
        },
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/reset-key",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      const accessKey = crypto.randomBytes(12).toString("base64url");
      creator.accessKeyHash = hashSecret(accessKey);
      creator.updatedAt = nowISO();
      await persist();

      return res.json({
        ok: true,
        accessKey,
        creator: creatorView(creator, true),
      });
    }
  );

  router.post("/admin/payouts/:id/approve", requireAdmin, async (req, res) => {
    await ensureLoaded();

    const payout = store.payouts[req.params.id];
    if (!payout) {
      return res.status(404).json({ error: "Payout not found" });
    }

    if (payout.status !== "requested") {
      return res.status(409).json({
        error: `Payout is already ${payout.status}`,
      });
    }

    payout.status = "approved";
    payout.approvedAt = nowISO();
    payout.updatedAt = nowISO();
    await persist();

    try {
      const providerResult = await sendPayoutToProvider(payout);

      payout.provider = providerResult.provider || providerResult.mode;
      payout.providerPayoutId = providerResult.providerPayoutId || null;
      payout.providerStatus = providerResult.providerStatus || null;
      payout.expectedArrivalDate =
        providerResult.expectedArrivalDate ||
        payout.expectedArrivalDate ||
        null;

      if (providerResult.status === "paid") {
        finalizePaidPayout(payout);
      } else if (providerResult.status === "failed") {
        payout.status = "failed";
        payout.failureReason =
          providerResult.raw?.error ||
          providerResult.raw?.message ||
          "Payout provider declined the payout";
      } else if (providerResult.status === "funding") {
        payout.status = "funding";
        payout.fundingInboundTransferId =
          providerResult.fundingInboundTransferId ||
          payout.fundingInboundTransferId ||
          null;
        payout.fundingAmountCents =
          providerResult.fundingAmountCents ||
          payout.fundingAmountCents ||
          0;
        payout.fundingStartedAt = payout.fundingStartedAt || nowISO();
        payout.fundingStatus = "pending";
      } else if (providerResult.status === "processing") {
        payout.status = "processing";
      } else {
        payout.status = "approved";
      }

      payout.updatedAt = nowISO();
      await persist();

      if (payout.status === "paid") {
        await notifyPayoutOnce(payout, "paid");
      } else if (["approved", "funding", "processing"].includes(payout.status)) {
        await notifyPayoutOnce(payout, "approved");
      }
      await persist();

      return res.json({
        ok: true,
        automated: providerResult.mode === "automated",
        payout: payoutView(payout),
      });
    } catch (error) {
      // Keep the request retryable if Stripe/provider could not start the payout.
      payout.status = "requested";
      payout.approvedAt = null;
      payout.failureReason = error?.message || String(error);
      payout.updatedAt = nowISO();
      await persist();

      return res.status(502).json({
        error: "Payout approval saved, but automatic payout failed",
        details: payout.failureReason,
        payout: payoutView(payout),
      });
    }
  });

  router.post("/admin/payouts/:id/reject", requireAdmin, async (req, res) => {
    await ensureLoaded();

    const payout = store.payouts[req.params.id];
    if (!payout) {
      return res.status(404).json({ error: "Payout not found" });
    }

    if (!["requested", "approved"].includes(payout.status)) {
      return res.status(409).json({
        error: `Cannot reject a payout in ${payout.status} state`,
      });
    }

    payout.status = "rejected";
    payout.rejectedAt = nowISO();
    payout.failureReason = String(req.body?.reason || "Rejected by owner").trim();
    payout.updatedAt = nowISO();
    await persist();

    await notifyPayoutOnce(payout, "rejected");
    await persist();

    return res.json({
      ok: true,
      payout: payoutView(payout),
      creator: creatorView(store.creators[payout.creatorCode], true),
    });
  });

  router.post("/admin/payouts/:id/mark-paid", requireAdmin, async (req, res) => {
    await ensureLoaded();

    const payout = store.payouts[req.params.id];
    if (!payout) {
      return res.status(404).json({ error: "Payout not found" });
    }

    if (!["requested", "approved", "funding", "processing"].includes(payout.status)) {
      return res.status(409).json({
        error: `Cannot mark a payout in ${payout.status} state as paid`,
      });
    }

    finalizePaidPayout(payout);
    payout.provider = payout.provider || "manual";
    payout.providerStatus = "PAID_CONFIRMED_BY_OWNER";
    payout.updatedAt = nowISO();
    await persist();

    await notifyPayoutOnce(payout, "paid");
    await persist();

    return res.json({
      ok: true,
      payout: payoutView(payout),
      creator: creatorView(store.creators[payout.creatorCode], true),
    });
  });

  router.post("/payout-provider/webhook", async (req, res) => {
    await ensureLoaded();

    const configuredSecret = String(process.env.CREATOR_PAYOUT_WEBHOOK_SECRET || "");
    const providedSecret = String(req.headers["x-payout-webhook-secret"] || "");

    if (!configuredSecret || !safeEqualText(configuredSecret, providedSecret)) {
      return res.status(401).json({ error: "Invalid payout webhook secret" });
    }

    const payoutId = String(req.body?.payoutId || "");
    const payout = store.payouts[payoutId];

    if (!payout) {
      return res.status(404).json({ error: "Payout not found" });
    }

    const rawStatus = String(req.body?.status || "").toUpperCase();
    payout.provider = req.body?.provider || payout.provider || "payout-provider";
    payout.providerPayoutId =
      req.body?.providerPayoutId || payout.providerPayoutId || null;
    payout.providerStatus = rawStatus || payout.providerStatus || null;
    payout.updatedAt = nowISO();

    if (["CAPTURED", "PAID", "COMPLETED", "SUCCEEDED"].includes(rawStatus)) {
      finalizePaidPayout(payout);
    } else if (["DECLINED", "FAILED", "REJECTED"].includes(rawStatus)) {
      payout.status = "failed";
      payout.failureReason =
        String(req.body?.failureReason || "Payout provider declined the payout");
    } else {
      payout.status = "processing";
    }

    await persist();

    return res.json({
      ok: true,
      payout: payoutView(payout),
    });
  });

  return router;
}
