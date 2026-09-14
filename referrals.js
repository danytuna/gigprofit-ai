import express from "express";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

const APP_STORE_URL =
  process.env.GIGPROFIT_APP_STORE_URL ||
  "https://apps.apple.com/us/app/gigprofit/id6765807887";

const REFERRAL_BASE_URL =
  process.env.REFERRAL_BASE_URL ||
  "https://gigprofitapp.com";

const CONTACT_EMAIL = "danny.novaprime@gmail.com";

const DATA_PATH =
  process.env.REFERRAL_DATA_PATH ||
  path.join(process.cwd(), "data", "gigprofit-referrals.json");

const MAX_RECENT_FINGERPRINTS = 1500;
const UNIQUE_WINDOW_DAYS = 14;
const DEFAULT_DOWNLOAD_BONUS = 1;
const MIN_PAYOUT = Math.max(0, Number(process.env.REFERRAL_MIN_PAYOUT || 0));

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

  const reelEarnings = creator.reelCompleted ? creator.reelFee : 0;
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
      createdAt: timestamp,
      approvedAt: null,
      paidAt: null,
      rejectedAt: null,
      updatedAt: timestamp,
    };

    store.payouts[payoutId] = payout;
    creator.updatedAt = timestamp;
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
      reelCompleted: Boolean(req.body?.reelCompleted),
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
      recentFingerprints: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    store.creators[code] = creator;
    await persist();

    return res.status(201).json({
      ok: true,
      creator: creatorView(creator, true),
      accessKey,
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
      creator.reelCompleted = Boolean(req.body.reelCompleted);
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
