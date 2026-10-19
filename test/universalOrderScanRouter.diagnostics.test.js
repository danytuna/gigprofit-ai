import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createUniversalOrderScanRouter } from "../universalOrderScanRouter.js";

async function runScan({ create, result = null }, verify) {
  const state = { reserved: false, refunded: false, confirmed: false, errors: [] };
  const store = {
    async reserve() { state.reserved = true; return { status: "reserved", scanCount: 1, dateKey: "2026-10-19" }; },
    async refund() { state.refunded = true; },
    async confirm() { state.confirmed = true; },
  };
  const client = { responses: { create: create || (async () => ({ output_text: JSON.stringify(result) })) } };
  const app = express();
  app.use(express.json({ limit: "3mb" }));
  app.use((req, _res, next) => { req.user = { uid: "test-user" }; next(); });
  app.use("/ai", createUniversalOrderScanRouter({
    openaiClient: client, hasOpenAIKey: true, usageStore: store,
    logger: { info() {}, error(_label, details) { state.errors.push(details); } },
  }));
  const server = app.listen(0);
  await new Promise((done) => server.once("listening", done));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/ai/order-scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageBase64: "fake-test-image", mimeType: "image/jpeg" }),
    });
    await verify({ response, state });
  } finally {
    await new Promise((done) => server.close(done));
  }
}

test("OpenAI error logs safe stage and request ID without secrets", async () => {
  const error = Object.assign(new Error("Bearer secret-image-content"), {
    status: 429, code: "rate_limit_exceeded", name: "RateLimitError", request_id: "req_123",
  });
  await runScan({ create: async () => { throw error; } }, async ({ response, state }) => {
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "order_scan_failed");
    assert.equal(state.refunded, true);
    assert.equal(state.errors[0].stage, "openai_request");
    assert.equal(state.errors[0].status, 429);
    assert.equal(state.errors[0].requestId, "req_123");
    assert.equal(JSON.stringify(state.errors).includes("secret-image-content"), false);
  });
});

test("Incomplete empty model response retains failure stage and refunds", async () => {
  await runScan({ create: async () => ({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: "",
  }) }, async ({ response, state }) => {
    assert.equal(response.status, 502);
    assert.equal(state.refunded, true);
    assert.equal(state.errors[0].stage, "parse_openai_response");
    assert.equal(state.errors[0].code, "empty_model_output");
    assert.equal(state.errors[0].modelIncompleteReason, "max_output_tokens");
  });
});

test("Null metrics stay null and do not turn into zero", async () => {
  const result = {
    foundOrder: true, platform: "Lyft",
    pay: null, totalMiles: null, totalMinutes: null,
    pickupMiles: null, pickupMinutes: null, tripMiles: null, tripMinutes: null,
    dataCompleteness: "partial", confidence: 0.5,
  };
  await runScan({ result }, async ({ response, state }) => {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.pay, null);
    assert.equal(body.totalMiles, null);
    assert.equal(body.totalMinutes, null);
    assert.equal(state.confirmed, true);
  });
});
