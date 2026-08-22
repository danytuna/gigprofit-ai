import {
  GIGPROFIT_KNOWLEDGE_CATALOG,
  searchGigProfitKnowledge,
} from "./gigProfitKnowledgeCatalog.js";

export function retrieveGigProfitKnowledge(question, state = {}, limit = 5) {
  return searchGigProfitKnowledge(question, state, limit);
}

export function gigProfitKnowledgePrompt(entries = []) {
  if (!entries.length) return "";

  const compact = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    area: entry.area,
    navigation: entry.navigation,
    description: entry.description,
    steps: entry.howToUse,
    plan: entry.plan,
    permissions: entry.permissions,
    actions: entry.actions,
    commonProblems: entry.errors,
    fixes: entry.solutions,
    limitations: entry.limitations,
    actionTarget: entry.actionTarget,
    related: entry.related,
    liveStateChecks: entry.stateChecks,
  }));

  return [
    "RELEVANT OFFICIAL GIGPROFIT GUIDE — CATALOG V2",
    JSON.stringify(compact),
    "Answer the user's exact question directly and in the user's language.",
    "For a how-to question, start with the exact in-app path, then give short numbered steps.",
    "For troubleshooting, distinguish what is confirmed from what must be checked. Never claim a toggle, permission, plan, backend, or user state was checked unless authorized live app data confirms it.",
    "Use only these retrieved sections for internal GigProfit behavior. Do not search the public web for how GigProfit works.",
    "Do not invent screens, buttons, prices, entitlements, limits, or settings. Exact current prices and access must come from StoreKit/AccessManager/paywall.",
    "When a feature has an actionTarget, you may offer the supported in-app open-screen action, but never say it opened unless the local action result reports success.",
    "When the catalog notes a limitation or uncertainty, state it plainly.",
  ].join("\n");
}

export { GIGPROFIT_KNOWLEDGE_CATALOG as GIGPROFIT_KNOWLEDGE };
