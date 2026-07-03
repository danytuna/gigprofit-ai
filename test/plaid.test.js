import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptSecret,
  encryptSecret,
  resolveEncryptionKey,
} from "../plaidCrypto.js";
import { createPlaidRouter } from "../plaidRouter.js";
import { createRequireFirebaseAuth } from "../requireFirebaseAuth.js";

function makeBase64Key() {
  return Buffer.from("12345678901234567890123456789012", "utf8").toString("base64");
}

function makeMemoryStore(seed = {}) {
  const records = new Map(
    Object.entries(seed).map(([uid, items]) => [uid, items.map((item) => ({ ...item }))])
  );

  return {
    async saveItem(uid, item) {
      const items = records.get(uid) || [];
      const nextItems = items.filter((existing) => existing.itemId !== item.itemId);
      nextItems.push({
        ...item,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null,
      });
      records.set(uid, nextItems);
    },

    async getItems(uid) {
      return (records.get(uid) || []).map((item) => ({ ...item }));
    },

    async getItem(uid, itemId) {
      return (records.get(uid) || []).find((item) => item.itemId === itemId) || null;
    },

    async deleteItem(uid, itemId) {
      records.set(
        uid,
        (records.get(uid) || []).filter((item) => item.itemId !== itemId)
      );
    },

    async findItemOwner(itemId) {
      for (const [uid, items] of records.entries()) {
        const item = items.find((entry) => entry.itemId === itemId);
        if (item) {
          return {
            uid,
            item: { ...item },
          };
        }
      }

      return null;
    },

    async updateItemState(uid, itemId, updates) {
      const items = records.get(uid) || [];
      const index = items.findIndex((item) => item.itemId === itemId);

      if (index === -1) {
        return false;
      }

      items[index] = {
        ...items[index],
        ...updates,
      };
      records.set(uid, items);
      return true;
    },
  };
}

function createTestRouter({ store, plaidClient }) {
  const requireFirebaseAuth = createRequireFirebaseAuth({
    async verifyIdToken(token) {
      if (token === "valid-user-a") {
        return { uid: "user-a", email: "a@example.com" };
      }

      if (token === "valid-user-b") {
        return { uid: "user-b", email: "b@example.com" };
      }

      throw new Error("invalid");
    },
  });

  return createPlaidRouter({
    plaidClient,
    hasPlaidKeys: true,
    plaidEnvironment: "production",
    requireFirebaseAuth,
    store,
    encryptionKey: resolveEncryptionKey({
      envValue: makeBase64Key(),
      nodeEnv: "test",
    }),
    encryptSecret,
    decryptSecret,
    nodeEnv: "test",
    plaidWebhookUrl: "https://gigprofit-ai-production.up.railway.app/plaid/webhook",
    admin: {
      firestore: {
        FieldValue: {
          serverTimestamp() {
            return "SERVER_TIMESTAMP";
          },
        },
      },
    },
  });
}

async function invokeRouter(router, { method, url, headers = {}, body = {} }) {
  return await new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      originalUrl: url,
      path: url,
      headers,
      body,
      query: {},
      get(name) {
        return this.headers[String(name).toLowerCase()];
      },
    };

    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({
          statusCode: this.statusCode,
          body: payload,
        });
        return this;
      },
      setHeader() {},
    };

    router.handle(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        statusCode: res.statusCode,
        body: null,
      });
    });
  });
}

test("plaidCrypto encrypts and decrypts with AES-256-GCM", () => {
  const key = resolveEncryptionKey({
    envValue: makeBase64Key(),
    nodeEnv: "test",
  });

  const payload = encryptSecret("secret-token", key);
  assert.ok(payload.encryptedAccessToken);
  assert.ok(payload.iv);
  assert.ok(payload.authTag);
  assert.equal(decryptSecret(payload, key), "secret-token");
});

test("plaid routes require Firebase auth", async () => {
  const store = makeMemoryStore();
  const plaidClient = {
    async itemPublicTokenExchange() {
      throw new Error("should not reach");
    },
  };

  const router = createTestRouter({ store, plaidClient });

  const response = await invokeRouter(router, {
    method: "GET",
    url: "/status",
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    ok: false,
    error: "Unauthorized",
  });
});

test("exchange_public_token stores encrypted access token and never returns it", async () => {
  const store = makeMemoryStore();
  const plaidClient = {
    async itemPublicTokenExchange() {
      return {
        data: {
          access_token: "plaid-access-token-1",
          item_id: "item-1",
        },
      };
    },
    async itemGet() {
      return {
        data: {
          item: {
            institution_id: "ins_1",
          },
        },
      };
    },
    async accountsGet() {
      return {
        data: {
          accounts: [
            {
              account_id: "acc-1",
              name: "Checking",
              mask: "1234",
              subtype: "checking",
              type: "depository",
            },
          ],
        },
      };
    },
    async institutionsGetById() {
      return {
        data: {
          institution: {
            name: "GigProfit Test Bank",
          },
        },
      };
    },
  };

  const router = createTestRouter({ store, plaidClient });

  const response = await invokeRouter(router, {
    method: "POST",
    url: "/exchange_public_token",
    headers: {
      authorization: "Bearer valid-user-a",
    },
    body: {
      public_token: "public-sandbox-token",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.connected, true);
  assert.equal(response.body.item_id, "item-1");
  assert.equal("access_token" in response.body, false);

  const saved = await store.getItem("user-a", "item-1");
  assert.ok(saved);
  assert.notEqual(saved.encryptedAccessToken, "plaid-access-token-1");
  assert.equal(saved.itemId, "item-1");
  assert.equal(saved.institutionName, "GigProfit Test Bank");
});

test("transactions reject client-sent access_token and filter by authenticated user + item_id", async () => {
  const key = resolveEncryptionKey({
    envValue: makeBase64Key(),
    nodeEnv: "test",
  });

  const store = makeMemoryStore({
    "user-a": [
      {
        ...encryptSecret("token-a1", key),
        itemId: "item-a1",
        institutionName: "Alpha Bank",
        accounts: [{ account_id: "acc-a1", name: "Main", mask: "1111" }],
      },
      {
        ...encryptSecret("token-a2", key),
        itemId: "item-a2",
        institutionName: "Bravo Bank",
        accounts: [{ account_id: "acc-a2", name: "Reserve", mask: "2222" }],
      },
    ],
    "user-b": [
      {
        ...encryptSecret("token-b1", key),
        itemId: "item-b1",
        institutionName: "Other User Bank",
        accounts: [{ account_id: "acc-b1", name: "Private", mask: "3333" }],
      },
    ],
  });

  const plaidClient = {
    async transactionsGet({ access_token }) {
      if (access_token === "token-a1") {
        return {
          data: {
            transactions: [
              {
                transaction_id: "tx-a1",
                account_id: "acc-a1",
                name: "Fuel Stop",
                merchant_name: "Fuel Stop",
                amount: 18.75,
                date: "2026-06-20",
                category: ["Travel", "Gas"],
                pending: false,
                iso_currency_code: "USD",
              },
            ],
          },
        };
      }

      if (access_token === "token-a2") {
        return {
          data: {
            transactions: [
              {
                transaction_id: "tx-a2",
                account_id: "acc-a2",
                name: "Parking Deck",
                merchant_name: "Parking Deck",
                amount: 12,
                date: "2026-06-19",
                category: ["Travel", "Parking"],
                pending: false,
                iso_currency_code: "USD",
              },
            ],
          },
        };
      }

      return {
        data: {
          transactions: [],
        },
      };
    },
  };

  const router = createTestRouter({ store, plaidClient });

  const rejected = await invokeRouter(router, {
    method: "POST",
    url: "/transactions",
    headers: {
      authorization: "Bearer valid-user-a",
    },
    body: {
      access_token: "should-never-be-accepted",
      start_date: "2026-01-01",
      end_date: "2026-06-30",
    },
  });

  assert.equal(rejected.statusCode, 400);

  const filtered = await invokeRouter(router, {
    method: "POST",
    url: "/transactions",
    headers: {
      authorization: "Bearer valid-user-a",
    },
    body: {
      item_id: "item-a2",
      start_date: "2026-01-01",
      end_date: "2026-06-30",
    },
  });

  assert.equal(filtered.statusCode, 200);
  assert.equal(filtered.body.transactions.length, 1);
  assert.equal(filtered.body.transactions[0].transaction_id, "tx-a2");
  assert.equal(filtered.body.transactions[0].item_id, "item-a2");
  assert.equal(filtered.body.transactions[0].institution_name, "Bravo Bank");
});

test("webhook updates item state for required Plaid update mode events", async () => {
  const store = makeMemoryStore({
    "user-a": [
      {
        itemId: "item-a1",
        institutionName: "Alpha Bank",
        connectionStatus: "connected",
        needsUpdate: false,
        newAccountsAvailable: false,
        needsAccountSelectionUpdate: false,
      },
    ],
  });

  const router = createTestRouter({ store, plaidClient: {} });

  const loginRequired = await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "ITEM_LOGIN_REQUIRED",
      item_id: "item-a1",
    },
  });

  assert.equal(loginRequired.statusCode, 200);
  assert.equal((await store.getItem("user-a", "item-a1")).needsUpdate, true);
  assert.equal((await store.getItem("user-a", "item-a1")).updateReason, "item_login_required");

  await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "PENDING_EXPIRATION",
      item_id: "item-a1",
    },
  });
  assert.equal((await store.getItem("user-a", "item-a1")).connectionStatus, "pending_expiration");

  await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "PENDING_DISCONNECT",
      item_id: "item-a1",
    },
  });
  assert.equal((await store.getItem("user-a", "item-a1")).connectionStatus, "pending_disconnect");

  await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "NEW_ACCOUNTS_AVAILABLE",
      item_id: "item-a1",
    },
  });
  assert.equal((await store.getItem("user-a", "item-a1")).newAccountsAvailable, true);
  assert.equal((await store.getItem("user-a", "item-a1")).needsAccountSelectionUpdate, true);

  await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "LOGIN_REPAIRED",
      item_id: "item-a1",
    },
  });

  const repaired = await store.getItem("user-a", "item-a1");
  assert.equal(repaired.connectionStatus, "connected");
  assert.equal(repaired.needsUpdate, false);
  assert.equal(repaired.updateReason, null);
  assert.equal(repaired.newAccountsAvailable, false);
  assert.equal(repaired.needsAccountSelectionUpdate, false);
});

test("webhook safely ignores duplicates and unknown items", async () => {
  const store = makeMemoryStore({
    "user-a": [{ itemId: "item-a1", connectionStatus: "connected" }],
  });
  const router = createTestRouter({ store, plaidClient: {} });

  const first = await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "ITEM_LOGIN_REQUIRED",
      item_id: "item-a1",
    },
  });
  const second = await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "ITEM_LOGIN_REQUIRED",
      item_id: "item-a1",
    },
  });
  const missing = await invokeRouter(router, {
    method: "POST",
    url: "/webhook",
    body: {
      webhook_type: "ITEM",
      webhook_code: "ITEM_LOGIN_REQUIRED",
      item_id: "missing-item",
    },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(missing.statusCode, 200);
  assert.equal((await store.getItem("user-a", "item-a1")).needsUpdate, true);
});

test("update-link-token requires auth, enforces ownership, validates boolean flag, and hides access_token", async () => {
  const key = resolveEncryptionKey({
    envValue: makeBase64Key(),
    nodeEnv: "test",
  });

  const store = makeMemoryStore({
    "user-a": [
      {
        ...encryptSecret("token-a1", key),
        itemId: "item-a1",
        institutionName: "Alpha Bank",
      },
    ],
  });

  let receivedAccessToken = null;
  let receivedUpdate = null;
  const router = createTestRouter({
    store,
    plaidClient: {
      async linkTokenCreate(payload) {
        receivedAccessToken = payload.access_token;
        receivedUpdate = payload.update || null;
        return {
          data: {
            link_token: "update-link-token",
            expiration: "2026-07-03T00:00:00Z",
            request_id: "req-123",
          },
        };
      },
    },
  });

  const unauthorized = await invokeRouter(router, {
    method: "POST",
    url: "/items/item-a1/update-link-token",
  });
  assert.equal(unauthorized.statusCode, 401);

  const forbidden = await invokeRouter(router, {
    method: "POST",
    url: "/items/item-a1/update-link-token",
    headers: {
      authorization: "Bearer valid-user-b",
    },
  });
  assert.equal(forbidden.statusCode, 404);

  const invalidFlag = await invokeRouter(router, {
    method: "POST",
    url: "/items/item-a1/update-link-token",
    headers: {
      authorization: "Bearer valid-user-a",
    },
    body: {
      account_selection_enabled: "yes",
    },
  });
  assert.equal(invalidFlag.statusCode, 400);

  const success = await invokeRouter(router, {
    method: "POST",
    url: "/items/item-a1/update-link-token",
    headers: {
      authorization: "Bearer valid-user-a",
    },
    body: {
      account_selection_enabled: true,
    },
  });

  assert.equal(success.statusCode, 200);
  assert.equal(success.body.link_token, "update-link-token");
  assert.equal(success.body.request_id, "req-123");
  assert.equal("access_token" in success.body, false);
  assert.equal(receivedAccessToken, "token-a1");
  assert.deepEqual(receivedUpdate, { account_selection_enabled: true });
});

test("status includes update mode flags", async () => {
  const store = makeMemoryStore({
    "user-a": [
      {
        itemId: "item-a1",
        institutionName: "Alpha Bank",
        connectionStatus: "needs_reauth",
        needsUpdate: true,
        updateReason: "item_login_required",
        newAccountsAvailable: true,
        needsAccountSelectionUpdate: true,
        accounts: [],
      },
    ],
  });

  const router = createTestRouter({ store, plaidClient: {} });
  const response = await invokeRouter(router, {
    method: "GET",
    url: "/status",
    headers: {
      authorization: "Bearer valid-user-a",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.connections[0].connection_status, "needs_reauth");
  assert.equal(response.body.connections[0].needs_update, true);
  assert.equal(response.body.connections[0].update_reason, "item_login_required");
  assert.equal(response.body.connections[0].new_accounts_available, true);
  assert.equal(response.body.connections[0].needs_account_selection_update, true);
});
