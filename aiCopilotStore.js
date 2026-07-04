import crypto from "node:crypto";

function nowISO() {
  return new Date().toISOString();
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(value, maxLength = 5000) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function compareISODesc(left, right) {
  return String(right || "").localeCompare(String(left || ""));
}

function encodeCursor(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function partialId(value) {
  const text = String(value || "");
  if (text.length <= 8) {
    return text;
  }

  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function sanitizeConversationTitle(title) {
  return normalizeText(title, 120)
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s.,'?!:-]/gu, "")
    .trim();
}

function createDefaultProfile(config = {}) {
  return {
    saveChatHistory: true,
    personalizedMemory: false,
    useGigProfitActivityForAIContext: true,
    useLocationContext: false,
    useFinancialSummariesForAIContext: false,
    dailyMessageCount: 0,
    dailyMessageDate: new Date().toISOString().slice(0, 10),
    retentionDays: config.retentionDays,
    memoryMaxItems: config.memoryMaxItems,
    schemaVersion: 1,
  };
}

function mapPlanToDailyLimit(plan, config) {
  switch (String(plan || "free").toLowerCase()) {
    case "pro":
      return config.dailyProLimit;
    case "standard":
      return config.dailyStandardLimit;
    default:
      return config.dailyFreeLimit;
  }
}

function filterConversationForList(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
    summary: conversation.summary,
    summaryUpdatedAt: conversation.summaryUpdatedAt,
    archived: conversation.archived,
    deletedAt: conversation.deletedAt,
    model: conversation.model,
    language: conversation.language,
    source: conversation.source,
    lastResponseId: conversation.lastResponseId || null,
    schemaVersion: conversation.schemaVersion || 1,
  };
}

function filterMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
    model: message.model || null,
    source: message.source || null,
    toolNames: Array.isArray(message.toolNames) ? message.toolNames : [],
    errorCode: message.errorCode || null,
    tokenUsage: message.tokenUsage || null,
    schemaVersion: message.schemaVersion || 1,
  };
}

function filterMemory(memory) {
  return {
    id: memory.id,
    category: memory.category,
    value: memory.value,
    normalizedValue: memory.normalizedValue,
    confidence: memory.confidence,
    sourceConversationId: memory.sourceConversationId || null,
    sourceMessageId: memory.sourceMessageId || null,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastUsedAt: memory.lastUsedAt || null,
    userConfirmed: Boolean(memory.userConfirmed),
    active: Boolean(memory.active),
    sensitivity: memory.sensitivity,
    expiresAt: memory.expiresAt || null,
  };
}

class InMemoryAICopilotStore {
  constructor(config = {}) {
    this.config = config;
    this.users = new Map();
  }

  ensureUser(uid) {
    if (!this.users.has(uid)) {
      this.users.set(uid, {
        profile: createDefaultProfile(this.config),
        conversations: new Map(),
        messages: new Map(),
        memories: new Map(),
      });
    }

    return this.users.get(uid);
  }

  async getProfile(uid) {
    return this.ensureUser(uid).profile;
  }

  async updateProfile(uid, patch) {
    const user = this.ensureUser(uid);
    user.profile = {
      ...user.profile,
      ...patch,
      updatedAt: nowISO(),
    };
    return user.profile;
  }

  async incrementDailyUsage(uid, plan = "free") {
    const user = this.ensureUser(uid);
    const today = new Date().toISOString().slice(0, 10);

    if (user.profile.dailyMessageDate !== today) {
      user.profile.dailyMessageDate = today;
      user.profile.dailyMessageCount = 0;
    }

    const limit = mapPlanToDailyLimit(plan, this.config);

    if (user.profile.dailyMessageCount >= limit) {
      return {
        allowed: false,
        limit,
        used: user.profile.dailyMessageCount,
      };
    }

    user.profile.dailyMessageCount += 1;
    return {
      allowed: true,
      limit,
      used: user.profile.dailyMessageCount,
    };
  }

  async createConversation(uid, data = {}) {
    const user = this.ensureUser(uid);
    const id = crypto.randomUUID();
    const timestamp = nowISO();
    const conversation = {
      id,
      title: sanitizeConversationTitle(data.title) || "New chat",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 0,
      summary: "",
      summaryUpdatedAt: null,
      archived: false,
      deletedAt: null,
      model: data.model || null,
      language: data.language || "en",
      source: data.source || "gigprofit-ios",
      lastResponseId: null,
      schemaVersion: 1,
    };

    user.conversations.set(id, conversation);
    user.messages.set(id, []);
    return filterConversationForList(conversation);
  }

  async listConversations(uid, options = {}) {
    const user = this.ensureUser(uid);
    const limit = clampInteger(options.limit, 1, 50, 20);
    const before = decodeCursor(options.before);

    const sorted = Array.from(user.conversations.values())
      .filter((item) => !item.deletedAt)
      .sort((a, b) => compareISODesc(a.lastMessageAt, b.lastMessageAt));

    const filtered = before
      ? sorted.filter((item) => String(item.lastMessageAt) < before)
      : sorted;

    const page = filtered.slice(0, limit);
    const nextCursor = filtered.length > limit
      ? encodeCursor(page[page.length - 1]?.lastMessageAt)
      : null;

    return {
      conversations: page.map(filterConversationForList),
      nextCursor,
    };
  }

  async getConversation(uid, conversationId) {
    const user = this.ensureUser(uid);
    const conversation = user.conversations.get(conversationId);
    if (!conversation || conversation.deletedAt) {
      return null;
    }

    return filterConversationForList(conversation);
  }

  async updateConversation(uid, conversationId, patch = {}) {
    const user = this.ensureUser(uid);
    const current = user.conversations.get(conversationId);
    if (!current || current.deletedAt) {
      return null;
    }

    const updated = {
      ...current,
      ...patch,
      title: patch.title !== undefined ? sanitizeConversationTitle(patch.title) || current.title : current.title,
      updatedAt: nowISO(),
    };

    user.conversations.set(conversationId, updated);
    return filterConversationForList(updated);
  }

  async deleteConversation(uid, conversationId) {
    const user = this.ensureUser(uid);
    const current = user.conversations.get(conversationId);
    if (!current || current.deletedAt) {
      return false;
    }

    current.deletedAt = nowISO();
    current.updatedAt = current.deletedAt;
    user.messages.delete(conversationId);
    return true;
  }

  async clearConversation(uid, conversationId) {
    const user = this.ensureUser(uid);
    const current = user.conversations.get(conversationId);
    if (!current || current.deletedAt) {
      return false;
    }

    user.messages.set(conversationId, []);
    current.messageCount = 0;
    current.summary = "";
    current.summaryUpdatedAt = nowISO();
    current.updatedAt = current.summaryUpdatedAt;
    current.lastMessageAt = current.updatedAt;
    return true;
  }

  async listMessages(uid, conversationId, options = {}) {
    const user = this.ensureUser(uid);
    const current = user.conversations.get(conversationId);
    if (!current || current.deletedAt) {
      return null;
    }

    const limit = clampInteger(options.limit, 1, 100, 20);
    const before = decodeCursor(options.before);
    const messages = [...(user.messages.get(conversationId) || [])]
      .sort((a, b) => compareISODesc(a.createdAt, b.createdAt));

    const filtered = before
      ? messages.filter((item) => String(item.createdAt) < before)
      : messages;

    const page = filtered.slice(0, limit);
    const nextCursor = filtered.length > limit
      ? encodeCursor(page[page.length - 1]?.createdAt)
      : null;

    return {
      messages: page.map(filterMessage),
      nextCursor,
    };
  }

  async addMessage(uid, conversationId, message) {
    const user = this.ensureUser(uid);
    const current = user.conversations.get(conversationId);
    if (!current || current.deletedAt) {
      return null;
    }

    const timestamp = message.createdAt || nowISO();
    const stored = {
      id: message.id || crypto.randomUUID(),
      role: message.role,
      content: normalizeText(message.content, 12000),
      createdAt: timestamp,
      status: message.status || "completed",
      model: message.model || null,
      source: message.source || "gigprofit-ai",
      toolNames: Array.isArray(message.toolNames) ? message.toolNames.slice(0, 20) : [],
      errorCode: message.errorCode || null,
      tokenUsage: message.tokenUsage || null,
      schemaVersion: 1,
    };

    const currentMessages = user.messages.get(conversationId) || [];
    currentMessages.push(stored);
    user.messages.set(conversationId, currentMessages);

    current.messageCount = currentMessages.length;
    current.updatedAt = timestamp;
    current.lastMessageAt = timestamp;
    current.model = stored.model || current.model;

    return filterMessage(stored);
  }

  async replaceConversationSummary(uid, conversationId, summary) {
    const user = this.ensureUser(uid);
    const current = user.conversations.get(conversationId);
    if (!current || current.deletedAt) {
      return null;
    }

    current.summary = normalizeText(summary, 4000);
    current.summaryUpdatedAt = nowISO();
    current.updatedAt = current.summaryUpdatedAt;
    return filterConversationForList(current);
  }

  async listMemories(uid) {
    const user = this.ensureUser(uid);
    return Array.from(user.memories.values())
      .filter((item) => item.active !== false)
      .sort((a, b) => compareISODesc(a.updatedAt, b.updatedAt))
      .map(filterMemory);
  }

  async upsertMemory(uid, memory) {
    const user = this.ensureUser(uid);
    const id = memory.id || crypto.randomUUID();
    const timestamp = nowISO();
    const stored = {
      id,
      category: memory.category,
      value: normalizeText(memory.value, 500),
      normalizedValue: normalizeText(memory.normalizedValue, 500),
      confidence: Number(memory.confidence || 0),
      sourceConversationId: memory.sourceConversationId || null,
      sourceMessageId: memory.sourceMessageId || null,
      createdAt: memory.createdAt || timestamp,
      updatedAt: timestamp,
      lastUsedAt: memory.lastUsedAt || null,
      userConfirmed: Boolean(memory.userConfirmed),
      active: memory.active !== false,
      sensitivity: memory.sensitivity || "low",
      expiresAt: memory.expiresAt || null,
    };

    user.memories.set(id, stored);
    return filterMemory(stored);
  }

  async updateMemory(uid, memoryId, patch = {}) {
    const user = this.ensureUser(uid);
    const current = user.memories.get(memoryId);
    if (!current) {
      return null;
    }

    const updated = {
      ...current,
      ...patch,
      updatedAt: nowISO(),
    };

    user.memories.set(memoryId, updated);
    return filterMemory(updated);
  }

  async deleteMemory(uid, memoryId) {
    const user = this.ensureUser(uid);
    return user.memories.delete(memoryId);
  }

  async deleteAllMemories(uid) {
    const user = this.ensureUser(uid);
    const deleted = user.memories.size;
    user.memories.clear();
    return deleted;
  }

  async deleteAllConversations(uid) {
    const user = this.ensureUser(uid);
    const deleted = user.conversations.size;
    user.conversations.clear();
    user.messages.clear();
    return deleted;
  }

  async deleteAllAIData(uid) {
    const conversations = await this.deleteAllConversations(uid);
    const memories = await this.deleteAllMemories(uid);
    const user = this.ensureUser(uid);
    user.profile = createDefaultProfile(this.config);

    return { conversations, memories };
  }
}

class FirestoreAICopilotStore {
  constructor({ firestore, admin, config = {} }) {
    this.firestore = firestore;
    this.admin = admin;
    this.config = config;
  }

  userRef(uid) {
    return this.firestore.collection("users").doc(uid);
  }

  profileRef(uid) {
    return this.userRef(uid).collection("aiProfile").doc("profile");
  }

  conversationsRef(uid) {
    return this.userRef(uid).collection("aiConversations");
  }

  conversationRef(uid, conversationId) {
    return this.conversationsRef(uid).doc(conversationId);
  }

  messagesRef(uid, conversationId) {
    return this.conversationRef(uid, conversationId).collection("messages");
  }

  memoriesRef(uid) {
    return this.userRef(uid).collection("aiMemories");
  }

  async getProfile(uid) {
    const snapshot = await this.profileRef(uid).get();
    if (!snapshot.exists) {
      const profile = createDefaultProfile(this.config);
      await this.profileRef(uid).set({
        ...profile,
        createdAt: this.admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return profile;
    }

    return {
      ...createDefaultProfile(this.config),
      ...snapshot.data(),
    };
  }

  async updateProfile(uid, patch) {
    await this.profileRef(uid).set({
      ...patch,
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return this.getProfile(uid);
  }

  async incrementDailyUsage(uid, plan = "free") {
    const profile = await this.getProfile(uid);
    const today = new Date().toISOString().slice(0, 10);
    const limit = mapPlanToDailyLimit(plan, this.config);
    const current = profile.dailyMessageDate === today
      ? Number(profile.dailyMessageCount || 0)
      : 0;

    if (current >= limit) {
      return { allowed: false, limit, used: current };
    }

    await this.updateProfile(uid, {
      dailyMessageDate: today,
      dailyMessageCount: current + 1,
    });

    return { allowed: true, limit, used: current + 1 };
  }

  async createConversation(uid, data = {}) {
    const ref = this.conversationsRef(uid).doc();
    const payload = {
      title: sanitizeConversationTitle(data.title) || "New chat",
      createdAt: this.admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
      lastMessageAt: this.admin.firestore.FieldValue.serverTimestamp(),
      messageCount: 0,
      summary: "",
      summaryUpdatedAt: null,
      archived: false,
      deletedAt: null,
      model: data.model || null,
      language: data.language || "en",
      source: data.source || "gigprofit-ios",
      lastResponseId: null,
      schemaVersion: 1,
    };

    await ref.set(payload);
    const snapshot = await ref.get();
    return filterConversationForList({
      id: ref.id,
      ...snapshot.data(),
    });
  }

  async listConversations(uid, options = {}) {
    const limit = clampInteger(options.limit, 1, 50, 20);
    const before = decodeCursor(options.before);
    let query = this.conversationsRef(uid)
      .where("deletedAt", "==", null)
      .orderBy("lastMessageAt", "desc")
      .limit(limit + 1);

    if (before) {
      query = query.where("lastMessageAt", "<", before);
    }

    const snapshot = await query.get();
    const docs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const page = docs.slice(0, limit).map(filterConversationForList);
    const nextCursor = docs.length > limit
      ? encodeCursor(String(docs[limit - 1]?.lastMessageAt || ""))
      : null;

    return { conversations: page, nextCursor };
  }

  async getConversation(uid, conversationId) {
    const snapshot = await this.conversationRef(uid, conversationId).get();
    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data();
    if (data.deletedAt) {
      return null;
    }

    return filterConversationForList({
      id: snapshot.id,
      ...data,
    });
  }

  async updateConversation(uid, conversationId, patch = {}) {
    const current = await this.getConversation(uid, conversationId);
    if (!current) {
      return null;
    }

    await this.conversationRef(uid, conversationId).set({
      ...patch,
      title: patch.title !== undefined ? sanitizeConversationTitle(patch.title) || current.title : current.title,
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return this.getConversation(uid, conversationId);
  }

  async deleteConversation(uid, conversationId) {
    const current = await this.getConversation(uid, conversationId);
    if (!current) {
      return false;
    }

    const deletedAt = nowISO();
    const conversationRef = this.conversationRef(uid, conversationId);
    const messages = await this.messagesRef(uid, conversationId).get();
    const batch = this.firestore.batch();
    batch.set(conversationRef, {
      deletedAt,
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    for (const doc of messages.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    return true;
  }

  async clearConversation(uid, conversationId) {
    const current = await this.getConversation(uid, conversationId);
    if (!current) {
      return false;
    }

    const messages = await this.messagesRef(uid, conversationId).get();
    const batch = this.firestore.batch();
    for (const doc of messages.docs) {
      batch.delete(doc.ref);
    }
    batch.set(this.conversationRef(uid, conversationId), {
      messageCount: 0,
      summary: "",
      summaryUpdatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
      lastMessageAt: this.admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await batch.commit();
    return true;
  }

  async listMessages(uid, conversationId, options = {}) {
    const conversation = await this.getConversation(uid, conversationId);
    if (!conversation) {
      return null;
    }

    const limit = clampInteger(options.limit, 1, 100, 20);
    const before = decodeCursor(options.before);

    let query = this.messagesRef(uid, conversationId)
      .orderBy("createdAt", "desc")
      .limit(limit + 1);

    if (before) {
      query = query.where("createdAt", "<", before);
    }

    const snapshot = await query.get();
    const docs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    const page = docs.slice(0, limit).map(filterMessage);
    const nextCursor = docs.length > limit
      ? encodeCursor(String(docs[limit - 1]?.createdAt || ""))
      : null;

    return { messages: page, nextCursor };
  }

  async addMessage(uid, conversationId, message) {
    const conversation = await this.getConversation(uid, conversationId);
    if (!conversation) {
      return null;
    }

    const ref = this.messagesRef(uid, conversationId).doc();
    const createdAt = message.createdAt || nowISO();
    const payload = {
      role: message.role,
      content: normalizeText(message.content, 12000),
      createdAt,
      status: message.status || "completed",
      model: message.model || null,
      source: message.source || "gigprofit-ai",
      toolNames: Array.isArray(message.toolNames) ? message.toolNames.slice(0, 20) : [],
      errorCode: message.errorCode || null,
      tokenUsage: message.tokenUsage || null,
      schemaVersion: 1,
    };

    const batch = this.firestore.batch();
    batch.set(ref, payload);
    batch.set(this.conversationRef(uid, conversationId), {
      messageCount: Number(conversation.messageCount || 0) + 1,
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
      lastMessageAt: createdAt,
      model: payload.model || conversation.model || null,
    }, { merge: true });
    await batch.commit();

    return filterMessage({
      id: ref.id,
      ...payload,
    });
  }

  async replaceConversationSummary(uid, conversationId, summary) {
    const current = await this.getConversation(uid, conversationId);
    if (!current) {
      return null;
    }

    await this.conversationRef(uid, conversationId).set({
      summary: normalizeText(summary, 4000),
      summaryUpdatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return this.getConversation(uid, conversationId);
  }

  async listMemories(uid) {
    const snapshot = await this.memoriesRef(uid)
      .where("active", "==", true)
      .orderBy("updatedAt", "desc")
      .get();

    return snapshot.docs.map((doc) => filterMemory({
      id: doc.id,
      ...doc.data(),
    }));
  }

  async upsertMemory(uid, memory) {
    const ref = memory.id
      ? this.memoriesRef(uid).doc(memory.id)
      : this.memoriesRef(uid).doc();

    const payload = {
      category: memory.category,
      value: normalizeText(memory.value, 500),
      normalizedValue: normalizeText(memory.normalizedValue, 500),
      confidence: Number(memory.confidence || 0),
      sourceConversationId: memory.sourceConversationId || null,
      sourceMessageId: memory.sourceMessageId || null,
      createdAt: memory.createdAt || nowISO(),
      updatedAt: nowISO(),
      lastUsedAt: memory.lastUsedAt || null,
      userConfirmed: Boolean(memory.userConfirmed),
      active: memory.active !== false,
      sensitivity: memory.sensitivity || "low",
      expiresAt: memory.expiresAt || null,
    };

    await ref.set(payload, { merge: true });
    return filterMemory({
      id: ref.id,
      ...payload,
    });
  }

  async updateMemory(uid, memoryId, patch = {}) {
    const ref = this.memoriesRef(uid).doc(memoryId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return null;
    }

    const payload = {
      ...patch,
      updatedAt: nowISO(),
    };
    await ref.set(payload, { merge: true });
    const updated = await ref.get();
    return filterMemory({
      id: updated.id,
      ...updated.data(),
    });
  }

  async deleteMemory(uid, memoryId) {
    const ref = this.memoriesRef(uid).doc(memoryId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return false;
    }

    await ref.delete();
    return true;
  }

  async deleteAllMemories(uid) {
    const snapshot = await this.memoriesRef(uid).get();
    const batch = this.firestore.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    return snapshot.size;
  }

  async deleteAllConversations(uid) {
    const snapshot = await this.conversationsRef(uid).get();
    let deleted = 0;

    for (const doc of snapshot.docs) {
      const success = await this.deleteConversation(uid, doc.id);
      if (success) {
        deleted += 1;
      }
    }

    return deleted;
  }

  async deleteAllAIData(uid) {
    const conversations = await this.deleteAllConversations(uid);
    const memories = await this.deleteAllMemories(uid);
    await this.profileRef(uid).delete().catch(() => {});
    return { conversations, memories };
  }
}

function createAICopilotStore({
  firestore,
  admin,
  config = {},
  mode = "firestore",
} = {}) {
  if (mode === "memory" || !firestore || !admin) {
    return new InMemoryAICopilotStore(config);
  }

  return new FirestoreAICopilotStore({
    firestore,
    admin,
    config,
  });
}

export {
  createAICopilotStore,
  createDefaultProfile,
  decodeCursor,
  encodeCursor,
  filterConversationForList,
  filterMemory,
  filterMessage,
  mapPlanToDailyLimit,
  partialId,
  sanitizeConversationTitle,
};
