import express from "express";
import crypto from "node:crypto";
import { resolveStoredSubscriptionPlan } from "./subscriptionPlanResolver.js";

const MAX_IMAGE_BASE64_LENGTH = 2_400_000;
const MODEL = process.env.AUTO_SCAN_VISION_MODEL || "gpt-4.1-mini";
const FREE_DAILY_LIMIT = 5;

function cleanText(value, max = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function normalizeExtraction(value = {}) {
  const completeness = [
    "complete",
    "pickup_only",
    "partial",
    "not_order",
    "invalid",
  ].includes(value.dataCompleteness)
    ? value.dataCompleteness
    : "partial";

  const platform = cleanText(value.platform || "Unknown", 80);
  const pay = clampNumber(value.pay, 0, 1000);
  const pickupMiles = clampNumber(value.pickupMiles, 0, 300);
  const pickupMinutes = clampNumber(value.pickupMinutes, 0, 600);
  const tripMiles = clampNumber(value.tripMiles, 0, 500);
  const tripMinutes = clampNumber(value.tripMinutes, 0, 1440);
  let totalMiles = clampNumber(value.totalMiles, 0, 500);
  let totalMinutes = clampNumber(value.totalMinutes, 0, 1440);

  // Lyft often exposes pickup and ride legs separately. Add them exactly once
  // only when the screenshot does not already provide an explicit total.
  if (totalMiles == null && pickupMiles != null && tripMiles != null) {
    totalMiles = pickupMiles + tripMiles;
  }
  if (totalMinutes == null && pickupMinutes != null && tripMinutes != null) {
    totalMinutes = pickupMinutes + tripMinutes;
  }

  return {
    foundOrder: Boolean(value.foundOrder),
    platform,
    pay,
    totalMiles,
    totalMinutes,
    pickupMiles,
    pickupMinutes,
    tripMiles,
    tripMinutes,
    pickupAddress: cleanText(value.pickupAddress, 250) || null,
    dropoffAddress: cleanText(value.dropoffAddress, 250) || null,
    dataCompleteness: completeness,
    confidence: clampNumber(value.confidence, 0, 1) ?? 0,
    explanation: cleanText(value.explanation, 500),
    rawVisibleOfferText: cleanText(value.rawVisibleOfferText, 2000),
  };
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  const pieces = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") {
        pieces.push(content.text);
      }
    }
  }
  return pieces.join("\n");
}

export function dateKeyForTimezone(date, timezoneIdentifier) {
  const timeZone = cleanText(timezoneIdentifier || "UTC", 80);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function createOrderScanUsageStore({ firestore, admin, now = () => new Date() }) {
  return {
    async reserve({ uid, screenshotHash, timezoneIdentifier }) {
      const userRef = firestore.collection("users").doc(uid);
      const userData = (await userRef.get()).data() || {};
      const plan = resolveStoredSubscriptionPlan(userData, now());
      const limit = plan === "pro" ? Number.POSITIVE_INFINITY : FREE_DAILY_LIMIT;
      const dateKey = dateKeyForTimezone(now(), timezoneIdentifier);
      const usageRef = userRef.collection("dailyUsage").doc(dateKey);
      const screenshotRef = usageRef.collection("processedScreenshots").doc(screenshotHash);
      return firestore.runTransaction(async (transaction) => {
        const usageSnapshot = await transaction.get(usageRef);
        const screenshotSnapshot = await transaction.get(screenshotRef);
        const scanCount = Number(usageSnapshot.data()?.scanCount || 0);
        if (screenshotSnapshot.exists) return { status: "duplicate", scanCount, dateKey, limit };
        if (scanCount >= limit) return { status: "limit", scanCount, dateKey, limit };
        const nextCount = scanCount + 1;
        transaction.set(usageRef, { scanCount: nextCount, dateKey, timezoneIdentifier, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        transaction.create(screenshotRef, { state: "reserved", createdAt: admin.firestore.FieldValue.serverTimestamp() });
        return { status: "reserved", scanCount: nextCount, dateKey, limit };
      });
    },
    async confirm({ uid, screenshotHash, dateKey }) {
      const ref = firestore.collection("users").doc(uid).collection("dailyUsage").doc(dateKey).collection("processedScreenshots").doc(screenshotHash);
      await ref.set({ state: "confirmed", confirmedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    },
    async refund({ uid, screenshotHash, dateKey }) {
      const usageRef = firestore.collection("users").doc(uid).collection("dailyUsage").doc(dateKey);
      const screenshotRef = usageRef.collection("processedScreenshots").doc(screenshotHash);
      await firestore.runTransaction(async (transaction) => {
        const usageSnapshot = await transaction.get(usageRef);
        const screenshotSnapshot = await transaction.get(screenshotRef);
        if (!screenshotSnapshot.exists || screenshotSnapshot.data()?.state !== "reserved") return;
        const scanCount = Math.max(0, Number(usageSnapshot.data()?.scanCount || 0) - 1);
        transaction.set(usageRef, { scanCount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        transaction.delete(screenshotRef);
      });
    },
  };
}

export function createUniversalOrderScanRouter({
  openaiClient,
  hasOpenAIKey,
  usageStore,
  logger = console,
}) {
  const router = express.Router();

  router.post("/order-scan", async (req, res) => {
    let reservation = null;
    let screenshotHash = "";
    let uid = "";
    try {
      if (!hasOpenAIKey || !openaiClient) {
        return res.status(503).json({
          error: "AI Auto Scan is temporarily unavailable.",
        });
      }

      const imageBase64 = cleanText(
        req.body?.imageBase64,
        MAX_IMAGE_BASE64_LENGTH + 1
      );
      const mimeType = cleanText(req.body?.mimeType || "image/jpeg", 40);

      if (!imageBase64 || imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
        return res.status(400).json({
          error: "Screenshot payload is missing or too large.",
        });
      }

      if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
        return res.status(400).json({
          error: "Unsupported screenshot format.",
        });
      }

      screenshotHash = crypto.createHash("sha256").update(imageBase64).digest("hex");
      uid = String(req.user?.uid || "");
      const timezoneIdentifier = cleanText(req.body?.timezoneIdentifier || "UTC", 80);
      reservation = await usageStore.reserve({ uid, screenshotHash, timezoneIdentifier });
      if (reservation.status === "duplicate") {
        return res.status(409).json({ code: "duplicate_screenshot", error: "This screenshot was already analyzed today.", scanCount: reservation.scanCount, dateKey: reservation.dateKey });
      }
      if (reservation.status === "limit") {
        return res.status(429).json({ code: "free_limit_reached", error: "Daily Auto Scan limit reached.", scanCount: reservation.scanCount, dateKey: reservation.dateKey });
      }

      const prompt = `
Analyze the entire screenshot as a universal gig-work offer detector.

Find the single currently active offer, order card, ride request, delivery request,
batch, block, or order notification from any platform, including Uber, Lyft,
DoorDash, Spark, Instacart, Grubhub, Amazon Flex, Roadie, Shipt, or an unknown
gig platform.

Important rules:
- Inspect the whole image, including notification banners at the top.
- Ignore navigation ETA, map route distance, phone status bar, prior GigProfit
  results, earnings summaries, advertisements, and unrelated prices.
- Never invent missing values.
- For Lyft, PAY is the main offer amount only. Do not add bonus text twice and do
  not use an estimated $/hr rate as pay.
- For Lyft, if pickup and ride legs are both visible, totalMiles and totalMinutes
  equal pickup + ride exactly once. If an explicit “total trip” value is visible,
  use it directly and do not add the legs again.
- Do not interpret clock times, battery percentage, ratings, passenger counts,
  or map ETA values as offer minutes, miles, or pay.
- Distinguish pickup-only distance/time from full trip totals.
- A banner such as "5 min (2.8 mi) away" is pickup-only unless the image clearly
  labels it as total trip information.
- Mark dataCompleteness as "complete" only when pay, TOTAL miles, and TOTAL
  minutes for the active offer are all visible or safely derivable.
- Use "pickup_only" when only pickup distance/time is visible.
- Use "partial" for an order with other missing totals.
- Use "not_order" when no active offer exists.
- Return only JSON matching the schema.
`;

      const response = await openaiClient.responses.create({
        model: MODEL,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: prompt,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Detect and extract the active gig offer from this screenshot.",
              },
              {
                type: "input_image",
                image_url: `data:${mimeType};base64,${imageBase64}`,
                detail: "high",
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "gig_order_extraction",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                foundOrder: { type: "boolean" },
                platform: { type: "string" },
                pay: { type: ["number", "null"] },
                totalMiles: { type: ["number", "null"] },
                totalMinutes: { type: ["number", "null"] },
                pickupMiles: { type: ["number", "null"] },
                pickupMinutes: { type: ["number", "null"] },
                tripMiles: { type: ["number", "null"] },
                tripMinutes: { type: ["number", "null"] },
                pickupAddress: { type: ["string", "null"] },
                dropoffAddress: { type: ["string", "null"] },
                dataCompleteness: {
                  type: "string",
                  enum: ["complete", "pickup_only", "partial", "not_order", "invalid"],
                },
                confidence: { type: "number" },
                explanation: { type: "string" },
                rawVisibleOfferText: { type: "string" },
              },
              required: [
                "foundOrder",
                "platform",
                "pay",
                "totalMiles",
                "totalMinutes",
                "pickupMiles",
                "pickupMinutes",
                "tripMiles",
                "tripMinutes",
                "pickupAddress",
                "dropoffAddress",
                "dataCompleteness",
                "confidence",
                "explanation",
                "rawVisibleOfferText",
              ],
            },
          },
        },
        max_output_tokens: 700,
      });

      const raw = extractResponseText(response);
      const parsed = JSON.parse(raw);
      const result = normalizeExtraction(parsed);

      if (!result.foundOrder || ["pickup_only", "not_order", "invalid"].includes(result.dataCompleteness)) {
        await usageStore.refund({ uid, screenshotHash, dateKey: reservation.dateKey });
        reservation = null;
      } else {
        await usageStore.confirm({ uid, screenshotHash, dateKey: reservation.dateKey });
      }

      logger.info("UNIVERSAL AI ORDER SCAN", {
        uid: String(req.user?.uid || "").slice(0, 8),
        foundOrder: result.foundOrder,
        platform: result.platform,
        completeness: result.dataCompleteness,
        confidence: result.confidence,
      });

      return res.json({ ...result, scanCount: reservation?.scanCount ?? null, dateKey: reservation?.dateKey ?? dateKeyForTimezone(new Date(), timezoneIdentifier) });
    } catch (error) {
      if (reservation?.status === "reserved") {
        await usageStore.refund({ uid, screenshotHash, dateKey: reservation.dateKey }).catch(() => {});
      }
      logger.error("UNIVERSAL AI ORDER SCAN ERROR", {
        name: error?.name || "Error",
        code: error?.code || null,
        status: error?.status || null,
      });

      return res.status(502).json({
        error: "AI could not analyze this screenshot.",
      });
    }
  });

  return router;
}
