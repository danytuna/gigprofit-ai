import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createTaxStore } from "../taxStore.js";
import { createTaxRouter } from "../taxRouter.js";

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

function makePlaidStore(itemsByUser) {
  return {
    async getItems(uid) {
      return itemsByUser[uid] || [];
    },
  };
}

function makePlaidClient(transactionsByAccessToken) {
  return {
    async transactionsGet({ access_token }) {
      return {
        data: {
          total_transactions: (transactionsByAccessToken[access_token] || []).length,
          transactions: transactionsByAccessToken[access_token] || [],
        },
      };
    },
  };
}

async function startServer(router) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { uid: req.headers["x-user-id"] || "user-a" };
    next();
  });
  app.use("/tax", router);
  app.get("/health", (_req, res) => res.json({ ok: true }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });

  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function makeItem(itemId, accessToken, overrides = {}) {
  return {
    itemId,
    accessToken,
    institutionName: "Test Bank",
    accounts: [
      {
        account_id: overrides.accountId || `${itemId}-acct`,
        name: overrides.accountName || "Checking",
        mask: overrides.mask || "1234",
        subtype: "checking",
        type: "depository",
      },
    ],
  };
}

function makeTransaction({
  id,
  accountId = "acct-1",
  merchantName,
  name,
  amount,
  date = "2026-06-15",
  pending = false,
  pendingTransactionId = null,
  primaryCategory = "GENERAL_MERCHANDISE",
  detailedCategory = "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
}) {
  return {
    transaction_id: id,
    account_id: accountId,
    merchant_name: merchantName || name,
    name: name || merchantName,
    amount,
    date,
    pending,
    pending_transaction_id: pendingTransactionId,
    iso_currency_code: "USD",
    authorized_date: date,
    personal_finance_category: {
      primary: primaryCategory,
      detailed: detailedCategory,
    },
  };
}

function createRouterFixture({
  itemsByUser,
  transactionsByAccessToken,
  openaiHandler,
  config = {},
} = {}) {
  const taxStore = createTaxStore({ mode: "memory" });
  const logger = makeLogger();
  const openaiCalls = [];
  const router = createTaxRouter({
    taxStore,
    plaidStore: makePlaidStore(itemsByUser),
    plaidClient: makePlaidClient(transactionsByAccessToken),
    decryptSecret(item) {
      return item.accessToken;
    },
    encryptionKey: Buffer.alloc(32, 1),
    openaiClient: {
      responses: {
        create: async (payload) => {
          openaiCalls.push(payload);
          if (openaiHandler) {
            return openaiHandler(payload);
          }
          return {
            output_text: JSON.stringify({
              results: [],
            }),
            output: [],
          };
        },
      },
    },
    logger,
    config: {
      enabled: true,
      batchSize: 2,
      maxTransactionsPerRun: 100,
      highConfidenceThreshold: 0.92,
      autoApplyEnabled: false,
      dailyRunLimit: 3,
      model: "gpt-4.1-mini",
      ...config,
    },
  });

  return {
    router,
    taxStore,
    logger,
    openaiCalls,
  };
}

test("user A cannot access user B tax transactions", async () => {
  const fixture = createRouterFixture({
    itemsByUser: {
      "user-a": [makeItem("item-a", "token-a", { accountId: "acct-a" })],
      "user-b": [makeItem("item-b", "token-b", { accountId: "acct-b" })],
    },
    transactionsByAccessToken: {
      "token-a": [makeTransaction({ id: "tx-a", accountId: "acct-a", name: "Shell", amount: 45.2 })],
      "token-b": [makeTransaction({ id: "tx-b", accountId: "acct-b", name: "Target", amount: 20.0 })],
    },
  });
  const { server, url } = await startServer(fixture.router);

  try {
    const responseA = await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const bodyA = await responseA.json();
    assert.equal(bodyA.transactions.length, 1);
    assert.equal(bodyA.transactions[0].plaidTransactionId, "tx-a");

    const responseB = await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-b" } });
    const bodyB = await responseB.json();
    assert.equal(bodyB.transactions.length, 1);
    assert.equal(bodyB.transactions[0].plaidTransactionId, "tx-b");
  } finally {
    await stopServer(server);
  }
});

test("manual classification persists on patch", async () => {
  const fixture = createRouterFixture({
    itemsByUser: {
      "user-a": [makeItem("item-a", "token-a")],
    },
    transactionsByAccessToken: {
      "token-a": [makeTransaction({ id: "tx-1", name: "Shell", amount: 55 })],
    },
  });
  const { server, url } = await startServer(fixture.router);

  try {
    await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const response = await fetch(`${url}/tax/transactions/tx-1`, {
      method: "PATCH",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        classification: "business",
        deductibility: "partially_deductible",
        taxCategory: "Gas and charging",
        businessUsePercentage: 0.7,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.transaction.classification, "business");
    assert.equal(body.transaction.userConfirmed, true);
    assert.equal(body.transaction.classificationSource, "manual");
  } finally {
    await stopServer(server);
  }
});

test("bulk classification requires confirmation", async () => {
  const fixture = createRouterFixture({
    itemsByUser: {
      "user-a": [makeItem("item-a", "token-a")],
    },
    transactionsByAccessToken: {
      "token-a": [
        makeTransaction({ id: "tx-1", name: "Shell", amount: 55 }),
        makeTransaction({ id: "tx-2", name: "Chevron", amount: 30 }),
      ],
    },
  });
  const { server, url } = await startServer(fixture.router);
  try {
    await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const denied = await fetch(`${url}/tax/transactions/bulk-classify`, {
      method: "POST",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactionIds: ["tx-1", "tx-2"],
        classification: "personal",
      }),
    });
    assert.equal(denied.status, 400);

    const applied = await fetch(`${url}/tax/transactions/bulk-classify`, {
      method: "POST",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactionIds: ["tx-1", "tx-2"],
        classification: "personal",
        deductibility: "not_deductible",
        confirm: true,
      }),
    });
    const body = await applied.json();
    assert.equal(applied.status, 200);
    assert.equal(body.updated, 2);
  } finally {
    await stopServer(server);
  }
});

test("deterministic transfer detection excludes internal payments", async () => {
  const fixture = createRouterFixture({
    itemsByUser: { "user-a": [makeItem("item-a", "token-a")] },
    transactionsByAccessToken: {
      "token-a": [makeTransaction({
        id: "tx-transfer",
        name: "Credit Card Payment Thank You",
        amount: 120,
      })],
    },
  });
  const { server, url } = await startServer(fixture.router);
  try {
    const response = await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const body = await response.json();
    assert.equal(body.transactions[0].classification, "excluded");
    assert.equal(body.transactions[0].taxCategory, "Transfer");
  } finally {
    await stopServer(server);
  }
});

test("pending classification carries over to posted transaction and pending duplicate is suppressed", async () => {
  const fixture = createRouterFixture({
    itemsByUser: { "user-a": [makeItem("item-a", "token-a")] },
    transactionsByAccessToken: {
      "token-a": [
        makeTransaction({ id: "tx-pending", name: "Shell", amount: 44, pending: true }),
        makeTransaction({ id: "tx-posted", name: "Shell", amount: 44, pending: false, pendingTransactionId: "tx-pending" }),
      ],
    },
  });
  await fixture.taxStore.upsertTransaction("user-a", {
    id: "tx-pending",
    plaidTransactionId: "tx-pending",
    date: "2026-06-15",
    amount: 44,
    classification: "business",
    deductibility: "partially_deductible",
    classificationSource: "manual",
    userConfirmed: true,
  });

  const { server, url } = await startServer(fixture.router);
  try {
    const response = await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const body = await response.json();
    assert.equal(body.transactions.length, 1);
    assert.equal(body.transactions[0].plaidTransactionId, "tx-posted");
    assert.equal(body.transactions[0].classification, "business");
  } finally {
    await stopServer(server);
  }
});

test("user rules override AI and disabled rules do not apply", async () => {
  const fixture = createRouterFixture({
    itemsByUser: { "user-a": [makeItem("item-a", "token-a")] },
    transactionsByAccessToken: {
      "token-a": [
        makeTransaction({ id: "tx-1", name: "Shell", amount: 50 }),
        makeTransaction({ id: "tx-2", name: "Netflix", amount: 19 }),
      ],
    },
  });
  await fixture.taxStore.upsertRule("user-a", {
    id: "rule-shell",
    merchantPattern: "shell",
    classification: "business",
    deductibility: "deductible",
    taxCategory: "Gas and charging",
    enabled: true,
    priority: 1,
  });
  await fixture.taxStore.upsertRule("user-a", {
    id: "rule-netflix",
    merchantPattern: "netflix",
    classification: "personal",
    deductibility: "not_deductible",
    taxCategory: "Personal",
    enabled: false,
    priority: 1,
  });

  const { server, url } = await startServer(fixture.router);
  try {
    const response = await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const body = await response.json();
    const shell = body.transactions.find((item) => item.plaidTransactionId === "tx-1");
    const netflix = body.transactions.find((item) => item.plaidTransactionId === "tx-2");
    assert.equal(shell.classificationSource, "user_rule");
    assert.equal(shell.userConfirmed, true);
    assert.notEqual(netflix.classificationSource, "user_rule");
  } finally {
    await stopServer(server);
  }
});

test("AI review stores suggestions as unconfirmed and apply requires authorization", async () => {
  const fixture = createRouterFixture({
    itemsByUser: { "user-a": [makeItem("item-a", "token-a")] },
    transactionsByAccessToken: {
      "token-a": [makeTransaction({ id: "tx-ambiguous", name: "Acme Services", amount: 120 })],
    },
    openaiHandler: async () => ({
      output_text: JSON.stringify({
        results: [
          {
            transactionId: "tx-ambiguous",
            classification: "business",
            deductibility: "needs_review",
            taxCategory: "Other business expense",
            confidence: 0.83,
            reason: "Merchant pattern suggests a work expense.",
            requiresUserReview: true,
            flags: ["mixed_use_possible"],
          },
        ],
      }),
      output: [],
    }),
  });
  const { server, url } = await startServer(fixture.router);
  try {
    await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const reviewResponse = await fetch(`${url}/tax/ai/review`, {
      method: "POST",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ year: 2026, mode: "all" }),
    });
    const reviewBody = await reviewResponse.json();
    assert.equal(reviewResponse.status, 201);
    assert.equal(reviewBody.review.suggestions.length, 1);

    const transaction = await fixture.taxStore.getTransaction("user-a", "tx-ambiguous");
    assert.equal(transaction.userConfirmed, false);
    assert.equal(transaction.classificationSource, "ai_suggestion");

    const denied = await fetch(`${url}/tax/ai/reviews/${reviewBody.review.id}/apply`, {
      method: "POST",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "all" }),
    });
    assert.equal(denied.status, 400);

    const applied = await fetch(`${url}/tax/ai/reviews/${reviewBody.review.id}/apply`, {
      method: "POST",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "all", confirm: true }),
    });
    const appliedBody = await applied.json();
    assert.equal(applied.status, 200);
    assert.equal(appliedBody.updated, 1);
    const updated = await fixture.taxStore.getTransaction("user-a", "tx-ambiguous");
    assert.equal(updated.userConfirmed, true);
    assert.equal(updated.classificationSource, "ai_approved");
  } finally {
    await stopServer(server);
  }
});

test("AI payload excludes access tokens and account numbers", async () => {
  const fixture = createRouterFixture({
    itemsByUser: { "user-a": [makeItem("item-a", "super-secret-access-token", { accountId: "account-7777", mask: "7777" })] },
    transactionsByAccessToken: {
      "super-secret-access-token": [makeTransaction({ id: "tx-safe", name: "Acme Services", amount: 88 })],
    },
    openaiHandler: async () => ({
      output_text: JSON.stringify({
        results: [{
          transactionId: "tx-safe",
          classification: "needs_review",
          deductibility: "needs_review",
          taxCategory: "Needs professional review",
          confidence: 0.5,
          reason: "Needs review.",
          requiresUserReview: true,
          flags: [],
        }],
      }),
      output: [],
    }),
  });
  const { server, url } = await startServer(fixture.router);
  try {
    await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    await fetch(`${url}/tax/ai/review`, {
      method: "POST",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ year: 2026, mode: "all" }),
    });

    const serialized = JSON.stringify(fixture.openaiCalls);
    assert.doesNotMatch(serialized, /super-secret-access-token|account-7777|7777/);
  } finally {
    await stopServer(server);
  }
});

test("review deletion clears AI suggestions and /health stays working", async () => {
  const fixture = createRouterFixture({
    itemsByUser: { "user-a": [makeItem("item-a", "token-a")] },
    transactionsByAccessToken: {
      "token-a": [makeTransaction({ id: "tx-1", name: "Acme Services", amount: 88 })],
    },
    openaiHandler: async () => ({
      output_text: JSON.stringify({
        results: [{
          transactionId: "tx-1",
          classification: "needs_review",
          deductibility: "needs_review",
          taxCategory: "Needs professional review",
          confidence: 0.51,
          reason: "Needs review.",
          requiresUserReview: true,
          flags: [],
        }],
      }),
      output: [],
    }),
  });
  const { server, url } = await startServer(fixture.router);
  try {
    await fetch(`${url}/tax/transactions?year=2026`, { headers: { "x-user-id": "user-a" } });
    const reviewResponse = await fetch(`${url}/tax/ai/review`, {
      method: "POST",
      headers: {
        "x-user-id": "user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ year: 2026, mode: "all" }),
    });
    const reviewBody = await reviewResponse.json();
    const deleted = await fetch(`${url}/tax/ai/reviews/${reviewBody.review.id}`, {
      method: "DELETE",
      headers: { "x-user-id": "user-a" },
    });
    assert.equal(deleted.status, 200);

    const transaction = await fixture.taxStore.getTransaction("user-a", "tx-1");
    assert.equal(transaction, null);

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
  } finally {
    await stopServer(server);
  }
});
