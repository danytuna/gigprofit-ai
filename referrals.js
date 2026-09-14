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
const DEFAULT_DOWNLOAD_BONUS = 1;
const MIN_PAYOUT = Math.max(0, Number(process.env.REFERRAL_MIN_PAYOUT || 0));

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
  version: 2,
  updatedAt: null,
  creators: {},
  payouts: {},
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
    `Reel fee: ${moneyNumber(creator.reelFee).toFixed(2)}`,
    `Verified download bonus: ${moneyNumber(creator.downloadBonus).toFixed(2)} per verified download`,
    "",
    "Use only the referral code in the Referral code field — do not paste the full referral URL.",
    "Keep your access key private. Your dashboard shows verified downloads, earnings, available balance, and Cash Out requests.",
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
          <p><strong>Reel fee:</strong> ${moneyNumber(creator.reelFee).toFixed(2)}</p>
          <p><strong>Verified download bonus:</strong> ${moneyNumber(creator.downloadBonus).toFixed(2)} per verified download</p>
        </div>

        <p style="color:#b8c0cf"><strong>Important:</strong> In the Referral code field, enter only <strong>${htmlEscape(creator.code)}</strong>, not the full referral URL.</p>
        <p style="color:#b8c0cf">Keep your access key private. Your dashboard shows verified downloads, earnings, available balance, and Cash Out requests.</p>
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

async function sendOwnerReelReviewNotification(creator) {
  const reel = creator.reelSubmission;
  if (!reel) return { sent: false, error: "Reel submission missing" };

  return sendProgramEmail({
    to: CONTACT_EMAIL,
    subject: `GigProfit Reel Review — ${creator.name}`,
    title: "New Reel Submitted",
    textLines: [
      `Creator: ${creator.name}`,
      `Platform: ${reel.platform || "Video"}`,
      `Reel fee if approved: $${moneyNumber(creator.reelFee).toFixed(2)}`,
      `Video: ${reel.url}`,
      "",
      `Review it here: ${OWNER_PORTAL_URL}`,
    ],
    htmlLines: [
      `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0">
        <p><strong>Creator:</strong> ${htmlEscape(creator.name)}</p>
        <p><strong>Platform:</strong> ${htmlEscape(reel.platform || "Video")}</p>
        <p><strong>Reel fee if approved:</strong> $${moneyNumber(creator.reelFee).toFixed(2)}</p>
      </div>`,
      `<p><a style="display:inline-block;background:#ff7a1a;color:#111;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px" href="${htmlEscape(reel.url)}">Open submitted video</a></p>`,
      `<p><a style="color:#69a3ff" href="${htmlEscape(OWNER_PORTAL_URL)}">Open Owner Center to approve or reject</a></p>`,
    ],
  });
}

async function sendCreatorReelStatusNotification(creator, type) {
  const reel = creator.reelSubmission;
  if (!creator?.email || !reel) {
    return { sent: false, error: "Creator email or Reel submission missing" };
  }

  if (type === "approved") {
    const fee = moneyNumber(reel.approvedFee ?? creator.reelFee);
    return sendProgramEmail({
      to: creator.email,
      subject: `Your GigProfit Reel was approved — $${fee.toFixed(2)} added`,
      title: "Reel Approved",
      textLines: [
        `Hi ${creator.name},`,
        "Your GigProfit promotional Reel has been approved.",
        `Reel fee credited: $${fee.toFixed(2)}`,
        `Video: ${reel.url}`,
        "",
        "The Reel fee is now included in your available GigProfit earnings, subject to any pending Cash Out requests.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your GigProfit promotional Reel has been <strong>approved</strong>.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Reel fee credited:</strong> $${fee.toFixed(2)}</div>`,
        `<p><a style="color:#69a3ff" href="${htmlEscape(CREATOR_PORTAL_URL)}">Open Creator Center</a></p>`,
      ],
    });
  }

  if (type === "rejected") {
    return sendProgramEmail({
      to: creator.email,
      subject: "Update on your GigProfit Reel submission",
      title: "Reel Needs Changes",
      textLines: [
        `Hi ${creator.name},`,
        "Your submitted Reel was not approved.",
        `Reason: ${reel.rejectionReason || "Please contact Creator Support for details."}`,
        "",
        "No Reel fee was credited. You can submit a new or corrected video from your Creator Center.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your submitted Reel was <strong>not approved</strong>.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Reason:</strong> ${htmlEscape(reel.rejectionReason || "Please contact Creator Support for details.")}</div>`,
        `<p style="color:#b8c0cf">No Reel fee was credited. You can submit a corrected video from your Creator Center.</p>`,
      ],
    });
  }

  return { sent: false, error: "Unknown Reel notification type" };
}

async function sendOwnerPayoutRequestNotification(creator, payout) {
  return sendProgramEmail({
    to: CONTACT_EMAIL,
    subject: `New GigProfit Cash Out Request — $${moneyNumber(payout.amount).toFixed(2)} — ${creator.name}`,
    title: "New Cash Out Request",
    textLines: [
      `Creator: ${creator.name}`,
      `Amount: $${moneyNumber(payout.amount).toFixed(2)}`,
      `Cash App destination: ${payout.cashtag}`,
      `Payout ID: ${payout.id}`,
      "",
      `Review and approve or reject it here: ${OWNER_PORTAL_URL}`,
      `Your payout source: ${OWNER_CASHAPP_CASHTAG}`,
    ],
    htmlLines: [
      `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0">
        <p><strong>Creator:</strong> ${htmlEscape(creator.name)}</p>
        <p><strong>Amount:</strong> $${moneyNumber(payout.amount).toFixed(2)}</p>
        <p><strong>Cash App destination:</strong> ${htmlEscape(payout.cashtag)}</p>
        <p><strong>Payout ID:</strong> ${htmlEscape(payout.id)}</p>
      </div>`,
      `<p><a style="display:inline-block;background:#ff7a1a;color:#111;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px" href="${htmlEscape(OWNER_PORTAL_URL)}">Review Cash Out</a></p>`,
      `<p style="color:#8f9aab">Payout source configured for Nova Prime: <strong>${htmlEscape(OWNER_CASHAPP_CASHTAG)}</strong></p>`,
    ],
  });
}

async function sendCreatorPayoutStatusNotification(creator, payout, type) {
  if (!creator?.email) {
    return { configured: creatorEmailConfigured(), sent: false, error: "Creator email missing" };
  }

  const amount = moneyNumber(payout.amount).toFixed(2);

  if (type === "approved") {
    return sendProgramEmail({
      to: creator.email,
      subject: `Your GigProfit payout of $${amount} was approved`,
      title: "Cash Out Approved",
      textLines: [
        `Hi ${creator.name},`,
        `Your Cash Out request for $${amount} has been approved.`,
        `Cash App destination: ${payout.cashtag}`,
        "",
        "Your payout is being processed. You will receive another confirmation when it is marked paid.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your Cash Out request for <strong>$${amount}</strong> has been approved.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Cash App destination:</strong> ${htmlEscape(payout.cashtag)}</div>`,
        `<p style="color:#b8c0cf">You will receive another confirmation when the payout is marked paid.</p>`,
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
        `Your GigProfit payout of $${amount} has been marked paid.`,
        `Cash App destination: ${payout.cashtag}`,
        "",
        "You can view the payout in your Creator Center history.",
      ],
      htmlLines: [
        `<p>Hi ${htmlEscape(creator.name)},</p>`,
        `<p>Your GigProfit payout of <strong>$${amount}</strong> has been sent.</p>`,
        `<div style="background:#0b0e14;border-radius:14px;padding:18px;margin:18px 0"><strong>Cash App destination:</strong> ${htmlEscape(payout.cashtag)}</div>`,
        `<p><a style="color:#69a3ff" href="${htmlEscape(CREATOR_PORTAL_URL)}">Open Creator Center</a></p>`,
      ],
    });
  }

  if (type === "rejected") {
    return sendProgramEmail({
      to: creator.email,
      subject: `Update on your GigProfit Cash Out request`,
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
        `<p style="color:#b8c0cf">The reserved amount has been returned to your available balance.</p>`,
      ],
    });
  }

  return { configured: creatorEmailConfigured(), sent: false, error: "Unknown payout notification type" };
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
  creator.downloadBonus = moneyNumber(
    creator.downloadBonus ??
    creator.commissionPerDownload ??
    DEFAULT_DOWNLOAD_BONUS
  );
  creator.reelCompleted = Boolean(creator.reelCompleted);
  if (creator.reelSubmission && typeof creator.reelSubmission === "object") {
    creator.reelSubmission.status =
      creator.reelSubmission.status ||
      (creator.reelCompleted ? "approved" : "pending");
    creator.reelSubmission.url = creator.reelSubmission.url || null;
    creator.reelSubmission.normalizedUrl =
      creator.reelSubmission.normalizedUrl ||
      normalizeReelUrl(creator.reelSubmission.url) ||
      creator.reelSubmission.url ||
      null;
    creator.reelSubmission.platform =
      creator.reelSubmission.platform ||
      reelPlatformFor(creator.reelSubmission.url);
    creator.reelSubmission.approvedFee =
      creator.reelSubmission.approvedFee === null ||
      creator.reelSubmission.approvedFee === undefined
        ? null
        : moneyNumber(creator.reelSubmission.approvedFee);
    creator.reelSubmission.rejectionReason =
      creator.reelSubmission.rejectionReason || null;
    creator.reelSubmission.notifications ||= {};
  } else {
    creator.reelSubmission = null;
  }
  creator.metrics.clicks = Number(creator.metrics.clicks || 0);
  creator.metrics.uniqueClicks = Number(creator.metrics.uniqueClicks || 0);
  creator.metrics.installs = Number(creator.metrics.installs || 0);
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
  creator.invitation ||= {};
  creator.invitation.lastSentAt = creator.invitation.lastSentAt || null;
  creator.invitation.lastMessageId = creator.invitation.lastMessageId || null;
  creator.invitation.lastError = creator.invitation.lastError || null;
  creator.invitation.delivery = creator.invitation.delivery || "not_sent";
  return creator;
}

function ensureStoreShape(parsed = {}) {
  const next = {
    version: 2,
    updatedAt: parsed?.updatedAt || null,
    creators: parsed?.creators || {},
    payouts: parsed?.payouts || {},
  };

  for (const creator of Object.values(next.creators)) {
    ensureCreatorShape(creator);
  }

  return next;
}

async function ensureLoaded() {
  if (loaded) return;

  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    store = ensureStoreShape(JSON.parse(raw));
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
  const reservingStatuses = new Set(["requested", "approved", "processing"]);
  return moneyNumber(
    creatorPayouts(code)
      .filter((payout) => reservingStatuses.has(payout.status))
      .reduce((sum, payout) => sum + Number(payout.amount || 0), 0)
  );
}

function earningsForCreator(creator) {
  ensureCreatorShape(creator);

  const reelEarnings = creator.reelCompleted
    ? moneyNumber(creator.reelSubmission?.approvedFee ?? creator.reelFee)
    : 0;
  const downloadEarnings =
    Number(creator.metrics.installs || 0) * Number(creator.downloadBonus || 0);
  const grossEarnings = moneyNumber(reelEarnings + downloadEarnings);
  const paidEarnings = moneyNumber(creator.metrics.paidEarnings || 0);
  const pendingPayouts = reservedAmountForCreator(creator.code);
  const availableEarnings = moneyNumber(
    Math.max(0, grossEarnings - paidEarnings - pendingPayouts)
  );

  return {
    reelEarnings: moneyNumber(reelEarnings),
    downloadEarnings: moneyNumber(downloadEarnings),
    grossEarnings,
    paidEarnings,
    pendingPayouts,
    availableEarnings,
  };
}

function reelSubmissionView(creator) {
  const reel = creator.reelSubmission;

  if (!reel) {
    return {
      status: creator.reelCompleted ? "approved" : "not_submitted",
      url: null,
      platform: null,
      submittedAt: null,
      reviewedAt: null,
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      approvedFee: creator.reelCompleted ? moneyNumber(creator.reelFee) : null,
    };
  }

  return {
    id: reel.id || null,
    status: reel.status || "pending",
    url: reel.url || null,
    platform: reel.platform || reelPlatformFor(reel.url),
    submittedAt: reel.submittedAt || null,
    reviewedAt: reel.reviewedAt || null,
    approvedAt: reel.approvedAt || null,
    rejectedAt: reel.rejectedAt || null,
    rejectionReason: reel.rejectionReason || null,
    approvedFee:
      reel.approvedFee === null || reel.approvedFee === undefined
        ? null
        : moneyNumber(reel.approvedFee),
  };
}

function payoutView(payout) {
  return {
    id: payout.id,
    creatorCode: payout.creatorCode,
    creatorName: payout.creatorName,
    amount: moneyNumber(payout.amount),
    method: payout.method,
    cashtag: payout.cashtag,
    status: payout.status,
    provider: payout.provider || null,
    providerPayoutId: payout.providerPayoutId || null,
    providerStatus: payout.providerStatus || null,
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
    downloadBonus: moneyNumber(creator.downloadBonus),
    minimumPayout: MIN_PAYOUT,
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
    };
    view.cashApp.providerCustomerId = creator.cashApp?.providerCustomerId || null;
    view.cashApp.providerGrantId = creator.cashApp?.providerGrantId || null;
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

function payoutAutomationConfigured() {
  return Boolean(
    process.env.CREATOR_PAYOUT_PROVIDER_URL &&
    process.env.CREATOR_PAYOUT_PROVIDER_TOKEN
  );
}

async function sendPayoutToProvider(payout) {
  if (!payoutAutomationConfigured()) {
    return {
      mode: "manual",
      status: "approved",
    };
  }

  const response = await fetch(process.env.CREATOR_PAYOUT_PROVIDER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CREATOR_PAYOUT_PROVIDER_TOKEN}`,
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
      method: "cash_app",
      cashtag: payout.cashtag,
      senderCashtag: OWNER_CASHAPP_CASHTAG,
      idempotencyKey: payout.id,
      purpose: "creator_services",
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error || data?.message || `Payout provider HTTP ${response.status}`;
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
    raw: data,
  };
}

function finalizePaidPayout(payout) {
  if (payout.status === "paid") return;

  const creator = store.creators[payout.creatorCode];
  if (!creator) return;

  ensureCreatorShape(creator);
  creator.metrics.paidEarnings = moneyNumber(
    Number(creator.metrics.paidEarnings || 0) + Number(payout.amount || 0)
  );

  payout.status = "paid";
  payout.paidAt = payout.paidAt || nowISO();
  creator.updatedAt = nowISO();
}

export function createReferralRouter() {
  const router = express.Router();

  router.get("/health", async (_req, res) => {
    await ensureLoaded();

    return res.json({
      ok: true,
      service: "gigprofit-referrals",
      version: 2,
      creators: Object.keys(store.creators).length,
      payouts: Object.keys(store.payouts).length,
      payoutAutomationConfigured: payoutAutomationConfigured(),
      creatorEmailConfigured: creatorEmailConfigured(),
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

    if (creator.reelCompleted || creator.reelSubmission?.status === "approved") {
      return res.status(409).json({
        error: "Your Reel has already been approved and credited",
      });
    }

    if (creator.reelSubmission?.status === "pending") {
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
      if (
        other.code !== code &&
        other.reelSubmission?.normalizedUrl === normalizedUrl &&
        ["pending", "approved"].includes(other.reelSubmission?.status)
      ) {
        return res.status(409).json({
          error: "This video link has already been submitted to GigProfit",
        });
      }
    }

    const timestamp = nowISO();
    creator.reelCompleted = false;
    creator.reelSubmission = {
      id: `reel_${crypto.randomUUID()}`,
      url: normalizedUrl,
      normalizedUrl,
      platform: reelPlatformFor(normalizedUrl),
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
    creator.updatedAt = timestamp;
    await persist();

    const ownerNotification = await sendOwnerReelReviewNotification(creator);
    if (ownerNotification.sent) {
      creator.reelSubmission.notifications.ownerSubmittedAt =
        ownerNotification.sentAt || nowISO();
      creator.reelSubmission.notifications.ownerSubmittedMessageId =
        ownerNotification.messageId || null;
    } else {
      creator.reelSubmission.notifications.ownerSubmittedError =
        ownerNotification.error || null;
    }
    await persist();

    return res.status(201).json({
      ok: true,
      reelSubmission: reelSubmissionView(creator),
      creator: creatorView(creator, false),
    });
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

    if (!creator.cashApp?.cashtag) {
      return res.status(400).json({
        error: "Add a Cash App $Cashtag before requesting a payout",
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
      method: "cash_app",
      cashtag: creator.cashApp.cashtag,
      status: "requested",
      provider: null,
      providerPayoutId: null,
      providerStatus: null,
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

    const creators = Object.values(store.creators)
      .map((creator) => creatorView(creator, true))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({
      ok: true,
      creators,
      payoutAutomationConfigured: payoutAutomationConfigured(),
      creatorEmailConfigured: creatorEmailConfigured(),
      ownerCashAppCashtag: OWNER_CASHAPP_CASHTAG,
      contactEmail: CONTACT_EMAIL,
    });
  });

  router.get("/admin/payouts", requireAdmin, async (_req, res) => {
    await ensureLoaded();

    const payouts = Object.values(store.payouts)
      .map(payoutView)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({
      ok: true,
      payoutAutomationConfigured: payoutAutomationConfigured(),
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
      downloadBonus: Math.max(
        0,
        moneyNumber(req.body?.downloadBonus ?? DEFAULT_DOWNLOAD_BONUS)
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
      metrics: {
        clicks: 0,
        uniqueClicks: 0,
        installs: 0,
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

    if (req.body?.downloadBonus !== undefined) {
      creator.downloadBonus = Math.max(0, moneyNumber(req.body.downloadBonus));
    }

    if (req.body?.reelCompleted !== undefined) {
      return res.status(409).json({
        error: "Reel completion is controlled by the Reel review workflow",
      });
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
    "/admin/creators/:code/reel/approve",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);
      const reel = creator.reelSubmission;

      if (!reel || reel.status !== "pending") {
        return res.status(409).json({
          error: reel?.status === "approved"
            ? "This Reel has already been approved and credited"
            : "There is no pending Reel to approve",
        });
      }

      const timestamp = nowISO();
      reel.status = "approved";
      reel.approvedFee = moneyNumber(creator.reelFee);
      reel.reviewedAt = timestamp;
      reel.approvedAt = timestamp;
      reel.rejectedAt = null;
      reel.rejectionReason = null;
      reel.reviewedBy = "Nova Prime owner";
      creator.reelCompleted = true;
      creator.updatedAt = timestamp;
      await persist();

      const notification = await sendCreatorReelStatusNotification(creator, "approved");
      reel.notifications ||= {};
      if (notification.sent) {
        reel.notifications.creatorApprovedAt = notification.sentAt || nowISO();
        reel.notifications.creatorApprovedMessageId = notification.messageId || null;
      } else {
        reel.notifications.creatorApprovedError = notification.error || null;
      }
      await persist();

      return res.json({
        ok: true,
        credited: reel.approvedFee,
        creator: creatorView(creator, true),
      });
    }
  );

  router.post(
    "/admin/creators/:code/reel/reject",
    requireAdmin,
    async (req, res) => {
      await ensureLoaded();

      const code = slugify(req.params.code);
      const creator = store.creators[code];

      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }

      ensureCreatorShape(creator);
      const reel = creator.reelSubmission;

      if (!reel || reel.status !== "pending") {
        return res.status(409).json({
          error: reel?.status === "approved"
            ? "An approved Reel cannot be rejected after it has been credited"
            : "There is no pending Reel to reject",
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
      creator.reelCompleted = false;
      creator.updatedAt = timestamp;
      await persist();

      const notification = await sendCreatorReelStatusNotification(creator, "rejected");
      reel.notifications ||= {};
      if (notification.sent) {
        reel.notifications.creatorRejectedAt = notification.sentAt || nowISO();
        reel.notifications.creatorRejectedMessageId = notification.messageId || null;
      } else {
        reel.notifications.creatorRejectedError = notification.error || null;
      }
      await persist();

      return res.json({
        ok: true,
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

      for (const field of ["installs", "subscriptions", "revenue"]) {
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

      if (providerResult.status === "paid") {
        finalizePaidPayout(payout);
      } else if (providerResult.status === "failed") {
        payout.status = "failed";
        payout.failureReason =
          providerResult.raw?.error ||
          providerResult.raw?.message ||
          "Payout provider declined the payout";
      } else if (providerResult.status === "processing") {
        payout.status = "processing";
      } else {
        payout.status = "approved";
      }

      payout.updatedAt = nowISO();
      await persist();

      if (payout.status === "paid") {
        await notifyPayoutOnce(payout, "paid");
      } else if (["approved", "processing"].includes(payout.status)) {
        await notifyPayoutOnce(payout, "approved");
      }
      await persist();

      return res.json({
        ok: true,
        automated: providerResult.mode === "automated",
        payout: payoutView(payout),
      });
    } catch (error) {
      payout.status = "approved";
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

    if (!["requested", "approved", "processing"].includes(payout.status)) {
      return res.status(409).json({
        error: `Cannot mark a payout in ${payout.status} state as paid`,
      });
    }

    finalizePaidPayout(payout);
    payout.provider = payout.provider || "manual-cash-app";
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
