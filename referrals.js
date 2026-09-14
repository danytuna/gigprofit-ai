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

let loaded = false;
let store = {
  version: 1,
  updatedAt: null,
  creators: {},
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

async function ensureLoaded() {
  if (loaded) return;

  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);

    store = {
      version: 1,
      updatedAt: parsed?.updatedAt || null,
      creators: parsed?.creators || {},
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("REFERRAL DATA LOAD ERROR:", error);
    }
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

function calculatedCommission(creator) {
  const rate = Number(creator?.commissionPerSubscription || 0);
  const subscriptions = Number(creator?.metrics?.subscriptions || 0);
  return Number((rate * subscriptions).toFixed(2));
}

function creatorView(creator, includePrivate = false) {
  const totalCommission = calculatedCommission(creator);
  const paidCommission = Number(creator?.metrics?.paidCommission || 0);
  const pendingCommission = Math.max(
    0,
    Number((totalCommission - paidCommission).toFixed(2))
  );

  const view = {
    code: creator.code,
    name: creator.name,
    status: creator.status,
    referralUrl: `${REFERRAL_BASE_URL}/r/${encodeURIComponent(creator.code)}`,
    campaignUrl: creator.campaignUrl || null,
    commissionPerSubscription: Number(creator.commissionPerSubscription || 0),
    metrics: {
      clicks: Number(creator.metrics?.clicks || 0),
      uniqueClicks: Number(creator.metrics?.uniqueClicks || 0),
      installs: Number(creator.metrics?.installs || 0),
      subscriptions: Number(creator.metrics?.subscriptions || 0),
      revenue: Number(creator.metrics?.revenue || 0),
      totalCommission,
      paidCommission,
      pendingCommission,
    },
    createdAt: creator.createdAt,
    updatedAt: creator.updatedAt,
  };

  if (includePrivate) {
    view.email = creator.email;
    view.notes = creator.notes || "";
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

export function createReferralRouter() {
  const router = express.Router();

  router.get("/health", async (_req, res) => {
    await ensureLoaded();

    return res.json({
      ok: true,
      service: "gigprofit-referrals",
      creators: Object.keys(store.creators).length,
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

    creator.metrics ||= {};
    creator.metrics.clicks = Number(creator.metrics.clicks || 0) + 1;

    cleanupFingerprints(creator);
    const fingerprint = fingerprintFor(req, code);
    const alreadyCounted = creator.recentFingerprints.some(
      (item) => item.hash === fingerprint
    );

    if (!alreadyCounted) {
      creator.metrics.uniqueClicks =
        Number(creator.metrics.uniqueClicks || 0) + 1;

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

  router.get("/admin/creators", requireAdmin, async (_req, res) => {
    await ensureLoaded();

    const creators = Object.values(store.creators)
      .map((creator) => creatorView(creator, true))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({
      ok: true,
      creators,
      contactEmail: CONTACT_EMAIL,
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

    const creator = {
      code,
      name,
      email,
      status: "active",
      campaignUrl: String(req.body?.campaignUrl || "").trim() || null,
      commissionPerSubscription: Math.max(
        0,
        Number(req.body?.commissionPerSubscription || 0)
      ),
      accessKeyHash: hashSecret(accessKey),
      notes: String(req.body?.notes || "").trim(),
      metrics: {
        clicks: 0,
        uniqueClicks: 0,
        installs: 0,
        subscriptions: 0,
        revenue: 0,
        paidCommission: 0,
      },
      recentFingerprints: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

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

    if (req.body?.commissionPerSubscription !== undefined) {
      creator.commissionPerSubscription = Math.max(
        0,
        Number(req.body.commissionPerSubscription || 0)
      );
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

      creator.metrics ||= {};

      for (const field of [
        "installs",
        "subscriptions",
        "revenue",
        "paidCommission",
      ]) {
        if (req.body?.[field] !== undefined) {
          const value = Number(req.body[field]);
          if (!Number.isFinite(value) || value < 0) {
            return res.status(400).json({ error: `Invalid ${field}` });
          }
          creator.metrics[field] = value;
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

  return router;
}
