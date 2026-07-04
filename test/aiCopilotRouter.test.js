import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIClient } from "../aiCopilot.js";
import {
  buildConfigFromEnv,
  createLegacyAskHandler,
  detectExplicitMemoryCommand,
  evaluateOfferTool,
  extractMemoryCandidates,
  filterAutoMemories,
  generateConversationTitle,
  inferLanguage,
  processConversationAsk,
  sanitizeGigProfitContext,
  shouldUseWebSearch,
  summarizeConversation,
} from "../aiCopilotRouter.js";
import { createAICopilotStore, createDefaultProfile } from "../aiCopilotStore.js";

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(message, payload) {
      entries.push({ level: "info", message, payload });
    },
    error(message, payload) {
      entries.push({ level: "error", message, payload });
    },
  };
}

function makeResponseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeConfig(overrides = {}) {
  return {
    ...buildConfigFromEnv({}),
    ...overrides,
  };
}

function makeStore(config = makeConfig()) {
  return createAICopilotStore({
    mode: "memory",
    config,
  });
}

function makeOpenAIClient(handler) {
  return {
    responses: {
      create: handler,
    },
  };
}

test("conversation storage is isolated by UID", async () => {
  const store = makeStore();
  const one = await store.createConversation("user-a", { title: "Alpha" });
  await store.createConversation("user-b", { title: "Beta" });

  const listA = await store.listConversations("user-a", {});
  const listB = await store.listConversations("user-b", {});

  assert.equal(listA.conversations.length, 1);
  assert.equal(listB.conversations.length, 1);
  assert.equal(listA.conversations[0].id, one.id);
  assert.equal(await store.getConversation("user-b", one.id), null);
});

test("message pagination returns nextCursor", async () => {
  const store = makeStore();
  const conversation = await store.createConversation("user-a", { title: "Alpha" });

  for (let index = 0; index < 15; index += 1) {
    await store.addMessage("user-a", conversation.id, {
      role: "user",
      content: `message ${index}`,
      createdAt: new Date(Date.now() + index * 1000).toISOString(),
    });
  }

  const firstPage = await store.listMessages("user-a", conversation.id, { limit: 10 });
  assert.equal(firstPage.messages.length, 10);
  assert.ok(firstPage.nextCursor);

  const secondPage = await store.listMessages("user-a", conversation.id, {
    limit: 10,
    before: firstPage.nextCursor,
  });
  assert.equal(secondPage.messages.length, 5);
});

test("processConversationAsk keeps success response shape compatible", async () => {
  const config = makeConfig();
  const store = makeStore(config);
  const logger = makeLogger();
  const conversation = await store.createConversation("user-a", {});
  const openaiClient = makeOpenAIClient(async () => ({
    id: "resp_123",
    output_text: "Hello there",
    output: [],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
  }));

  const result = await processConversationAsk({
    store,
    openaiClient,
    logger,
    uid: "user-a",
    conversationId: conversation.id,
    question: "Hello there",
    appContext: {},
    plan: "free",
    config,
    persist: true,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, "Hello there");
  assert.equal(result.body.mode, "general");
  assert.equal(result.body.source, "railway-v3-copilot");
  assert.equal(result.body.usedWebSearch, false);
  assert.equal(result.body.usedGigProfitContext, false);
  assert.deepEqual(result.body.toolNames, []);
  assert.deepEqual(result.body.metadata, {
    memoryUpdated: false,
    usedWebSearch: false,
    usedGigProfitContext: false,
    toolNames: [],
  });
});

test("processConversationAsk preserves tool names across Responses API tool turns", async () => {
  const config = makeConfig();
  const store = makeStore(config);
  const logger = makeLogger();
  const conversation = await store.createConversation("user-a", {});
  let callCount = 0;
  const openaiClient = makeOpenAIClient(async () => {
    callCount += 1;

    if (callCount === 1) {
      return {
        id: "resp_tools_1",
        output_text: "",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_recent_orders_summary",
            arguments: "{}",
          },
        ],
      };
    }

    return {
      id: "resp_tools_2",
      output_text: "Use the stronger recent-order window.",
      output: [],
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        total_tokens: 18,
      },
    };
  });

  const result = await processConversationAsk({
    store,
    openaiClient,
    logger,
    uid: "user-a",
    conversationId: conversation.id,
    question: "What do my recent orders say?",
    appContext: {
      orders: [{ pay: 14, miles: 5, minutes: 18 }],
    },
    plan: "free",
    config,
    persist: true,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.toolNames, ["get_recent_orders_summary"]);
  assert.deepEqual(result.body.metadata.toolNames, ["get_recent_orders_summary"]);
});

test("legacy ask handler does not return technical errors to the client", async () => {
  const config = makeConfig();
  const store = makeStore(config);
  const logger = makeLogger();
  const openaiClient = makeOpenAIClient(async () => {
    const error = new Error("transport stack top secret");
    error.code = "ERR_STREAM_PREMATURE_CLOSE";
    throw error;
  });

  const handler = createLegacyAskHandler({
    store,
    openaiClient,
    hasOpenAIKey: true,
    logger,
    config,
  });

  const req = {
    body: {
      prompt: "top secret",
    },
    auth: null,
  };
  const res = makeResponseRecorder();

  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    error: "AI temporarily unavailable",
    message: "GigProfit AI is temporarily unavailable. Please try again.",
  });
  assert.doesNotMatch(JSON.stringify(res.body), /top secret|transport/i);
});

test("memory commands perform real memory operations", async () => {
  const config = makeConfig();
  const store = makeStore(config);
  await store.updateProfile("user-a", { personalizedMemory: true });
  const conversation = await store.createConversation("user-a", {});
  const logger = makeLogger();
  const openaiClient = makeOpenAIClient(async () => ({
    id: "resp_unused",
    output_text: "unused",
    output: [],
  }));

  await processConversationAsk({
    store,
    openaiClient,
    logger,
    uid: "user-a",
    conversationId: conversation.id,
    question: "Remember that I drive in Charlotte",
    appContext: {},
    config,
    persist: true,
  });

  const memoriesAfterCreate = await store.listMemories("user-a");
  assert.equal(memoriesAfterCreate.length, 1);

  const recall = await processConversationAsk({
    store,
    openaiClient,
    logger,
    uid: "user-a",
    conversationId: conversation.id,
    question: "What do you remember about me?",
    appContext: {},
    config,
    persist: true,
  });
  assert.equal(recall.status, 200);
  assert.match(recall.body.reply, /remember|recuerdo/i);

  await processConversationAsk({
    store,
    openaiClient,
    logger,
    uid: "user-a",
    conversationId: conversation.id,
    question: "Forget that Charlotte",
    appContext: {},
    config,
    persist: true,
  });

  const memoriesAfterDelete = await store.listMemories("user-a");
  assert.equal(memoriesAfterDelete.length, 0);
});

test("history-disabled profiles do not persist new conversation messages", async () => {
  const config = makeConfig();
  const store = makeStore(config);
  const logger = makeLogger();
  await store.updateProfile("user-a", {
    saveChatHistory: false,
  });
  const conversation = await store.createConversation("user-a", {});
  const openaiClient = makeOpenAIClient(async () => ({
    id: "resp_history_off",
    output_text: "Short answer",
    output: [],
    usage: {
      input_tokens: 9,
      output_tokens: 4,
      total_tokens: 13,
    },
  }));

  const result = await processConversationAsk({
    store,
    openaiClient,
    logger,
    uid: "user-a",
    conversationId: conversation.id,
    question: "How should I work tonight?",
    appContext: {},
    plan: "free",
    config,
    persist: true,
  });

  assert.equal(result.status, 200);

  const messagesPage = await store.listMessages("user-a", conversation.id, { limit: 20 });
  assert.equal(messagesPage.messages.length, 0);
});

test("deleteAllAIData removes conversations, messages, memories, and profile", async () => {
  const config = makeConfig();
  const store = makeStore(config);

  await store.updateProfile("user-a", {
    personalizedMemory: true,
  });

  const conversation = await store.createConversation("user-a", { title: "Airport plan" });
  await store.addMessage("user-a", conversation.id, {
    role: "user",
    content: "How should I work the airport tonight?",
  });
  await store.upsertMemory("user-a", {
    category: "home_city",
    value: "Charlotte",
    normalizedValue: "charlotte",
    confidence: 0.95,
    userConfirmed: true,
    active: true,
    sensitivity: "low",
  });

  const deleted = await store.deleteAllAIData("user-a");

  assert.equal(deleted.conversations, 1);
  assert.equal(deleted.memories, 1);
  assert.equal(await store.getConversation("user-a", conversation.id), null);
  assert.equal((await store.listMemories("user-a")).length, 0);
  assert.deepEqual(await store.getProfile("user-a"), createDefaultProfile(config));
});

test("trivial and sensitive memory candidates are not auto-stored", async () => {
  const candidates = extractMemoryCandidates("hello");
  assert.equal(candidates.length, 0);

  const accepted = filterAutoMemories([
    {
      should_store: true,
      category: "other_non_sensitive",
      value: "My bank account is 1234567890",
      normalizedValue: "my bank account is 1234567890",
      confidence: 0.9,
      sensitivity: "low",
    },
  ], []);

  assert.equal(accepted.length, 0);
});

test("title generation produces a compact title instead of raw prompt dump", () => {
  const title = generateConversationTitle([
    {
      role: "user",
      content: "What are the best zones in Charlotte tonight for Uber and Lyft?",
    },
  ]);

  assert.ok(title.length <= 120);
  assert.notEqual(title, "What are the best zones in Charlotte tonight for Uber and Lyft?");
});

test("web search activates only when enabled and question is current", () => {
  assert.equal(shouldUseWebSearch({
    question: "What events are happening tonight in Miami?",
    config: makeConfig({ webSearchEnabled: true }),
  }), true);

  assert.equal(shouldUseWebSearch({
    question: "Explain what pay per mile means",
    config: makeConfig({ webSearchEnabled: true }),
  }), false);

  assert.equal(shouldUseWebSearch({
    question: "What events are happening tonight in Miami?",
    config: makeConfig({ webSearchEnabled: false }),
  }), false);
});

test("responses API tool path can evaluate offers deterministically", () => {
  const result = evaluateOfferTool({
    pay: 12,
    miles: 7,
    minutes: 20,
    pickupMiles: 2,
    returnTripRisk: 0.25,
    costPerMile: 0.35,
    minimumDollarsPerMile: 1.5,
    minimumHourlyRate: 20,
  });

  assert.equal(result.dollarsPerMile, 1.33);
  assert.equal(result.dollarsPerHour, 36);
  assert.ok(result.recommendationScore >= 0);
});

test("conversation summary stays compact", () => {
  const messages = [];
  for (let index = 0; index < 14; index += 1) {
    messages.push({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index % 2 === 0
        ? `User topic ${index}: I drive in Charlotte and want better airport runs.`
        : `Assistant guidance ${index}: Focus on airport windows and track return-trip quality.`,
    });
  }

  const summary = summarizeConversation(messages);

  assert.match(summary, /User topics|Assistant guidance/);
});

test("native fetch transport remains available for OpenAI client setup", () => {
  const logger = makeLogger();
  const calls = [];
  const nativeFetch = async (input, init) => {
    calls.push({ input, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "ok",
    };
  };

  const client = createOpenAIClient({
    apiKey: "test-key",
    logger,
    nativeFetch,
  });

  assert.equal(typeof client.fetch, "function");
});

test("language inference and context sanitization keep city-level context only", () => {
  assert.equal(inferLanguage("Hola, necesito ayuda", "en"), "es");

  const context = sanitizeGigProfitContext({
    city: "Charlotte",
    location: {
      city: "Charlotte",
      state: "NC",
      address: "123 Main Street",
      coordinates: { lat: 35, lng: -80 },
    },
    orders: [{ pay: 10, miles: 5, minutes: 15 }],
  });

  assert.equal(context.location.city, "Charlotte");
  assert.equal(context.location.state, "NC");
  assert.equal(context.location.address, undefined);
  assert.equal(context.ordersSummary.count, 1);
});

test("explicit memory command detection recognizes supported phrases", () => {
  assert.equal(detectExplicitMemoryCommand("Remember that I drive in Charlotte"), true);
  assert.equal(detectExplicitMemoryCommand("Forget everything"), true);
  assert.equal(detectExplicitMemoryCommand("Hello there"), false);
});
