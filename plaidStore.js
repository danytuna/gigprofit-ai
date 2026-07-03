function itemDocRef(firestore, uid, itemId) {
  return firestore
    .collection("users")
    .doc(uid)
    .collection("privateIntegrations")
    .doc("plaid")
    .collection("items")
    .doc(itemId);
}

function mapSnapshot(doc) {
  const data = doc.data() || {};

  return {
    itemId: doc.id,
    encryptedAccessToken: data.encryptedAccessToken || "",
    iv: data.iv || "",
    authTag: data.authTag || "",
    environment: data.environment || "",
    connectionStatus: data.connectionStatus || "connected",
    needsUpdate: Boolean(data.needsUpdate),
    updateReason: data.updateReason || null,
    newAccountsAvailable: Boolean(data.newAccountsAvailable),
    needsAccountSelectionUpdate: Boolean(data.needsAccountSelectionUpdate),
    lastWebhookType: data.lastWebhookType || null,
    lastWebhookCode: data.lastWebhookCode || null,
    lastWebhookAt: data.lastWebhookAt || null,
    repairedAt: data.repairedAt || null,
    institutionName: data.institutionName || null,
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  };
}

export function createPlaidStore(firestore, admin) {
  return {
    async saveItem(uid, item) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const ref = itemDocRef(firestore, uid, item.itemId);
      const existing = await ref.get();

      await ref.set(
        {
          encryptedAccessToken: item.encryptedAccessToken,
          iv: item.iv,
          authTag: item.authTag,
          itemId: item.itemId,
          environment: item.environment,
          connectionStatus: item.connectionStatus || "connected",
          needsUpdate: Boolean(item.needsUpdate),
          updateReason: item.updateReason || null,
          newAccountsAvailable: Boolean(item.newAccountsAvailable),
          needsAccountSelectionUpdate: Boolean(item.needsAccountSelectionUpdate),
          lastWebhookType: item.lastWebhookType || null,
          lastWebhookCode: item.lastWebhookCode || null,
          lastWebhookAt: item.lastWebhookAt || null,
          repairedAt: item.repairedAt || null,
          institutionName: item.institutionName || null,
          accounts: Array.isArray(item.accounts) ? item.accounts : [],
          createdAt: existing.exists ? existing.data()?.createdAt || now : now,
          updatedAt: now,
        },
        { merge: true }
      );

      return ref;
    },

    async getItems(uid) {
      const snapshot = await firestore
        .collection("users")
        .doc(uid)
        .collection("privateIntegrations")
        .doc("plaid")
        .collection("items")
        .get();

      return snapshot.docs.map(mapSnapshot);
    },

    async getItem(uid, itemId) {
      const snapshot = await itemDocRef(firestore, uid, itemId).get();
      return snapshot.exists ? mapSnapshot(snapshot) : null;
    },

    async deleteItem(uid, itemId) {
      await itemDocRef(firestore, uid, itemId).delete();
    },

    async deleteAllItems(uid) {
      const items = await this.getItems(uid);
      await Promise.all(items.map((item) => this.deleteItem(uid, item.itemId)));
      return items.length;
    },

    async findItemOwner(itemId) {
      const cleanItemId = String(itemId || "").trim();
      if (!cleanItemId) {
        return null;
      }

      const snapshot = await firestore
        .collectionGroup("items")
        .where("itemId", "==", cleanItemId)
        .limit(2)
        .get();

      if (snapshot.empty) {
        return null;
      }

      const [doc] = snapshot.docs;
      const uid = doc.ref.parent?.parent?.parent?.parent?.id || null;

      if (!uid) {
        return null;
      }

      return {
        uid,
        item: mapSnapshot(doc),
      };
    },

    async updateItemState(uid, itemId, updates) {
      const cleanItemId = String(itemId || "").trim();
      if (!cleanItemId) {
        return false;
      }

      const ref = itemDocRef(firestore, uid, cleanItemId);
      const snapshot = await ref.get();

      if (!snapshot.exists) {
        return false;
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(
        {
          ...updates,
          updatedAt: now,
        },
        { merge: true }
      );

      return true;
    },
  };
}
