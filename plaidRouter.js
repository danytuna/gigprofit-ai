import express from "express";

function isISODate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function parseDate(value) {
  if (!isISODate(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampDateRange(startDate, endDate) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);

  if (!start || !end || start > end) {
    return null;
  }

  const ms = end.getTime() - start.getTime();
  const days = ms / (1000 * 60 * 60 * 24);

  if (days > 366) {
    return null;
  }

  return {
    startDate,
    endDate,
  };
}

function safeErrorLog(error) {
  return {
    status: error?.response?.status || null,
    requestId: error?.response?.data?.request_id || null,
    errorCode: error?.response?.data?.error_code || null,
    errorType: error?.response?.data?.error_type || null,
    message: error?.message || "Unknown error",
  };
}

function clientErrorMessage(defaultMessage, nodeEnv, error) {
  if (nodeEnv === "production") {
    return defaultMessage;
  }

  const requestId = error?.response?.data?.request_id;
  const code = error?.response?.data?.error_code;
  const message = error?.response?.data?.error_message || error?.message;
  return [code, message, requestId ? `request_id=${requestId}` : null]
    .filter(Boolean)
    .join(" | ");
}

async function fetchInstitutionName(plaidClient, itemResponse, accountsResponse) {
  try {
    const institutionId = itemResponse?.data?.item?.institution_id;

    if (!institutionId) {
      return accountsResponse?.data?.accounts?.[0]?.official_name || "Connected Bank";
    }

    const institutionResponse = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: ["US"],
    });

    return (
      institutionResponse?.data?.institution?.name ||
      accountsResponse?.data?.accounts?.[0]?.official_name ||
      "Connected Bank"
    );
  } catch {
    return accountsResponse?.data?.accounts?.[0]?.official_name || "Connected Bank";
  }
}

function mapStoredAccount(account) {
  return {
    account_id: account.account_id || "",
    name: account.name || "Account",
    mask: account.mask || "",
    subtype: account.subtype || "",
    type: account.type || "",
  };
}

function mapTransaction(transaction, item) {
  return {
    transaction_id: transaction.transaction_id,
    account_id: transaction.account_id,
    item_id: item.itemId,
    name: transaction.name || "",
    merchant_name: transaction.merchant_name || "",
    amount: transaction.amount,
    date: transaction.date,
    category: Array.isArray(transaction.category) ? transaction.category : [],
    pending: Boolean(transaction.pending),
    iso_currency_code: transaction.iso_currency_code || "USD",
    institution_name: item.institutionName || "Connected Bank",
  };
}

function maskItemId(itemId) {
  const value = String(itemId || "").trim();
  if (value.length <= 8) {
    return value || "unknown";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function mapConnection(item) {
  return {
    item_id: item.itemId,
    institution_name: item.institutionName || "Connected Bank",
    connection_status: item.connectionStatus || "connected",
    needs_update: Boolean(item.needsUpdate),
    update_reason: item.updateReason || null,
    new_accounts_available: Boolean(item.newAccountsAvailable),
    needs_account_selection_update: Boolean(item.needsAccountSelectionUpdate),
    updated_at: item.updatedAt?.toDate?.()?.toISOString?.() || null,
    accounts: Array.isArray(item.accounts) ? item.accounts : [],
  };
}

function statusPayload(items) {
  const latestItem = items
    .filter((item) => item.updatedAt)
    .sort((a, b) => {
      const aMillis = a.updatedAt?.toMillis?.() || 0;
      const bMillis = b.updatedAt?.toMillis?.() || 0;
      return bMillis - aMillis;
    })[0];

  return {
    connected: items.length > 0,
    item_id: items.length === 1 ? items[0].itemId : undefined,
    updated_at: latestItem?.updatedAt?.toDate?.()?.toISOString?.(),
    connections: items.map(mapConnection),
  };
}

function mapWebhookUpdate(webhookCode) {
  switch (String(webhookCode || "").trim()) {
    case "ITEM_LOGIN_REQUIRED":
      return {
        connectionStatus: "needs_reauth",
        needsUpdate: true,
        updateReason: "item_login_required",
      };
    case "PENDING_EXPIRATION":
      return {
        connectionStatus: "pending_expiration",
        needsUpdate: true,
        updateReason: "pending_expiration",
      };
    case "PENDING_DISCONNECT":
      return {
        connectionStatus: "pending_disconnect",
        needsUpdate: true,
        updateReason: "pending_disconnect",
      };
    case "LOGIN_REPAIRED":
      return {
        connectionStatus: "connected",
        needsUpdate: false,
        updateReason: null,
        repairedAt: "SERVER_TIMESTAMP",
      };
    case "NEW_ACCOUNTS_AVAILABLE":
      return {
        newAccountsAvailable: true,
        needsAccountSelectionUpdate: true,
      };
    default:
      return null;
  }
}

function ensurePlaidSecretsReady(hasPlaidKeys, encryptionKey, res) {
  if (!hasPlaidKeys) {
    res.status(500).json({
      ok: false,
      error: "Plaid is not configured on the server.",
    });
    return false;
  }

  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
    res.status(500).json({
      ok: false,
      error: "Plaid secure storage is not configured on the server.",
    });
    return false;
  }

  return true;
}

export function createPlaidRouter({
  plaidClient,
  hasPlaidKeys,
  plaidEnvironment,
  requireFirebaseAuth,
  store,
  encryptionKey,
  encryptSecret,
  decryptSecret,
  nodeEnv,
  plaidWebhookUrl,
  admin,
}) {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    const webhookType = String(req.body?.webhook_type || "").trim();
    const webhookCode = String(req.body?.webhook_code || "").trim();
    const itemId = String(req.body?.item_id || "").trim();
    const maskedItemId = maskItemId(itemId);

    if (webhookType !== "ITEM" || !webhookCode || !itemId) {
      console.info("PLAID WEBHOOK IGNORED", {
        webhook_type: webhookType || null,
        webhook_code: webhookCode || null,
        item_id: maskedItemId,
        result: "ignored",
      });
      return res.status(200).json({ ok: true });
    }

    const mapped = mapWebhookUpdate(webhookCode);
    if (!mapped) {
      console.info("PLAID WEBHOOK IGNORED", {
        webhook_type: webhookType,
        webhook_code: webhookCode,
        item_id: maskedItemId,
        result: "unsupported_code",
      });
      return res.status(200).json({ ok: true });
    }

    try {
      const owner = await store.findItemOwner(itemId);

      if (!owner) {
        console.info("PLAID WEBHOOK PROCESSED", {
          webhook_type: webhookType,
          webhook_code: webhookCode,
          item_id: maskedItemId,
          result: "item_not_found",
        });
        return res.status(200).json({ ok: true });
      }

      const webhookState = {
        lastWebhookType: webhookType,
        lastWebhookCode: webhookCode,
        lastWebhookAt: admin.firestore.FieldValue.serverTimestamp(),
        ...mapped,
      };

      if (webhookCode === "LOGIN_REPAIRED") {
        webhookState.newAccountsAvailable = false;
        webhookState.needsAccountSelectionUpdate = false;
        webhookState.repairedAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await store.updateItemState(owner.uid, itemId, webhookState);

      console.info("PLAID WEBHOOK PROCESSED", {
        webhook_type: webhookType,
        webhook_code: webhookCode,
        item_id: maskedItemId,
        result: "updated",
      });
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("PLAID WEBHOOK ERROR", {
        webhook_type: webhookType,
        webhook_code: webhookCode,
        item_id: maskedItemId,
        result: "failed",
        message: error?.message || "Unknown error",
      });
      return res.status(200).json({ ok: true });
    }
  });

  router.use(requireFirebaseAuth);

  router.post("/create_link_token", async (req, res) => {
    try {
      if (!hasPlaidKeys) {
        return res.status(500).json({
          ok: false,
          error: "Plaid is not configured on the server.",
        });
      }

      const response = await plaidClient.linkTokenCreate({
        user: {
          client_user_id: `gigprofit:${req.auth.uid}`,
        },
        client_name: "GigProfit",
        products: ["transactions"],
        country_codes: ["US"],
        language: "en",
      });

      return res.json({
        link_token: response.data.link_token,
        expiration: response.data.expiration,
      });
    } catch (error) {
      console.error("PLAID LINK TOKEN ERROR", safeErrorLog(error));
      return res.status(500).json({
        ok: false,
        error: clientErrorMessage(
          "Failed to create Plaid link token.",
          nodeEnv,
          error
        ),
      });
    }
  });

  router.post("/exchange_public_token", async (req, res) => {
    try {
      if (!ensurePlaidSecretsReady(hasPlaidKeys, encryptionKey, res)) {
        return;
      }

      const publicToken = String(req.body?.public_token || "").trim();

      if (!publicToken) {
        return res.status(400).json({
          ok: false,
          error: "Missing public_token",
        });
      }

      const exchangeResponse = await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
      });

      const accessToken = exchangeResponse.data.access_token;
      const itemId = exchangeResponse.data.item_id;

      const [itemResponse, accountsResponse] = await Promise.all([
        plaidClient.itemGet({ access_token: accessToken }),
        plaidClient.accountsGet({ access_token: accessToken }),
      ]);

      const institutionName = await fetchInstitutionName(
        plaidClient,
        itemResponse,
        accountsResponse
      );

      const encrypted = encryptSecret(accessToken, encryptionKey);

      await store.saveItem(req.auth.uid, {
        ...encrypted,
        itemId,
        environment: plaidEnvironment,
        connectionStatus: "connected",
        needsUpdate: false,
        updateReason: null,
        newAccountsAvailable: false,
        needsAccountSelectionUpdate: false,
        institutionName,
        accounts: (accountsResponse.data.accounts || []).map(mapStoredAccount),
      });

      return res.json({
        ok: true,
        connected: true,
        item_id: itemId,
      });
    } catch (error) {
      console.error("PLAID EXCHANGE ERROR", safeErrorLog(error));
      return res.status(500).json({
        ok: false,
        error: clientErrorMessage(
          "Failed to connect your bank.",
          nodeEnv,
          error
        ),
      });
    }
  });

  router.post("/transactions", async (req, res) => {
    try {
      if (!ensurePlaidSecretsReady(hasPlaidKeys, encryptionKey, res)) {
        return;
      }

      if ("access_token" in (req.body || {})) {
        return res.status(400).json({
          ok: false,
          error: "access_token must not be sent by the client.",
        });
      }

      const requestedItemId = String(req.body?.item_id || "").trim();

      const now = new Date();
      const defaultStartDate = `${now.getUTCFullYear()}-01-01`;
      const defaultEndDate = now.toISOString().slice(0, 10);
      const startDate = req.body?.start_date || defaultStartDate;
      const endDate = req.body?.end_date || defaultEndDate;

      const range = clampDateRange(startDate, endDate);
      if (!range) {
        return res.status(400).json({
          ok: false,
          error: "Invalid start_date/end_date range.",
        });
      }

      const allItems = await store.getItems(req.auth.uid);
      if (!allItems.length) {
        return res.status(404).json({
          ok: false,
          error: "No bank is connected.",
        });
      }

      const items = requestedItemId
        ? allItems.filter((item) => item.itemId === requestedItemId)
        : allItems;

      if (!items.length) {
        return res.status(404).json({
          ok: false,
          error: "The requested Plaid connection was not found.",
        });
      }

      const results = await Promise.all(
        items.map(async (item) => {
          const accessToken = decryptSecret(item, encryptionKey);
          const response = await plaidClient.transactionsGet({
            access_token: accessToken,
            start_date: range.startDate,
            end_date: range.endDate,
          });

          return {
            item,
            transactions: response.data.transactions || [],
          };
        })
      );

      const transactions = results
        .flatMap(({ item, transactions }) =>
          transactions.map((transaction) => mapTransaction(transaction, item))
        )
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));

      const accounts = items.flatMap((item) =>
        (item.accounts || []).map((account) => ({
          ...account,
          item_id: item.itemId,
          institution_name: item.institutionName || "Connected Bank",
        }))
      );

      return res.json({
        ok: true,
        accounts,
        transactions,
      });
    } catch (error) {
      console.error("PLAID TRANSACTIONS ERROR", safeErrorLog(error));
      return res.status(500).json({
        ok: false,
        error: clientErrorMessage(
          "Failed to fetch bank transactions.",
          nodeEnv,
          error
        ),
      });
    }
  });

  router.get("/status", async (req, res) => {
    try {
      const items = await store.getItems(req.auth.uid);
      return res.json(statusPayload(items));
    } catch (error) {
      console.error("PLAID STATUS ERROR", safeErrorLog(error));
      return res.status(500).json({
        ok: false,
        error: clientErrorMessage(
          "Failed to read bank connection status.",
          nodeEnv,
          error
        ),
      });
    }
  });

  router.post("/items/:itemId/update-link-token", async (req, res) => {
    try {
      if (!ensurePlaidSecretsReady(hasPlaidKeys, encryptionKey, res)) {
        return;
      }

      if ("access_token" in (req.body || {})) {
        return res.status(400).json({
          ok: false,
          error: "access_token must not be sent by the client.",
        });
      }

      const itemId = String(req.params?.itemId || "").trim();
      const item = await store.getItem(req.auth.uid, itemId);

      if (!item) {
        return res.status(404).json({
          ok: false,
          error: "The requested Plaid connection was not found.",
        });
      }

      const requestedAccountSelection = req.body?.account_selection_enabled;
      const hasAccountSelectionFlag =
        Object.prototype.hasOwnProperty.call(req.body || {}, "account_selection_enabled");

      if (
        hasAccountSelectionFlag &&
        typeof requestedAccountSelection !== "boolean"
      ) {
        return res.status(400).json({
          ok: false,
          error: "account_selection_enabled must be a boolean.",
        });
      }

      const accountSelectionEnabled = Boolean(requestedAccountSelection);
      const accessToken = decryptSecret(item, encryptionKey);
      const request = {
        user: {
          client_user_id: `gigprofit:${req.auth.uid}`,
        },
        client_name: "GigProfit",
        country_codes: ["US"],
        language: "en",
        access_token: accessToken,
      };

      if (plaidWebhookUrl) {
        request.webhook = plaidWebhookUrl;
      }

      if (accountSelectionEnabled) {
        request.update = {
          account_selection_enabled: true,
        };
      }

      const response = await plaidClient.linkTokenCreate(request);

      return res.json({
        link_token: response.data.link_token,
        expiration: response.data.expiration,
        request_id: response.data.request_id,
      });
    } catch (error) {
      console.error("PLAID UPDATE LINK TOKEN ERROR", safeErrorLog(error));
      return res.status(500).json({
        ok: false,
        error: clientErrorMessage(
          "Failed to prepare the bank update flow.",
          nodeEnv,
          error
        ),
      });
    }
  });

  router.post("/disconnect", async (req, res) => {
    try {
      if (!ensurePlaidSecretsReady(hasPlaidKeys, encryptionKey, res)) {
        return;
      }

      const requestedItemId = String(req.body?.item_id || "").trim();
      const items = requestedItemId
        ? [await store.getItem(req.auth.uid, requestedItemId)].filter(Boolean)
        : await store.getItems(req.auth.uid);

      if (!items.length) {
        return res.json({
          ok: true,
          disconnected: true,
          removed: 0,
        });
      }

      await Promise.all(
        items.map(async (item) => {
          try {
            const accessToken = decryptSecret(item, encryptionKey);
            await plaidClient.itemRemove({
              access_token: accessToken,
            });
          } catch (error) {
            const code = error?.response?.data?.error_code;
            if (code !== "ITEM_NOT_FOUND") {
              throw error;
            }
          }

          await store.deleteItem(req.auth.uid, item.itemId);
        })
      );

      return res.json({
        ok: true,
        disconnected: true,
        removed: items.length,
      });
    } catch (error) {
      console.error("PLAID DISCONNECT ERROR", safeErrorLog(error));
      return res.status(500).json({
        ok: false,
        error: clientErrorMessage(
          "Failed to disconnect bank.",
          nodeEnv,
          error
        ),
      });
    }
  });

  return router;
}
