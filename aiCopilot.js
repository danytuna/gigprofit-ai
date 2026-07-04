const RETRY_DELAYS_MS = [500, 1000, 2000];
const MAX_ATTEMPTS = 3;
const TEMPORARY_UNAVAILABLE_BODY = {
  error: "AI temporarily unavailable",
  message: "GigProfit AI is temporarily unavailable. Please try again.",
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(error) {
  if (typeof error?.status === "number") {
    return error.status;
  }

  if (typeof error?.statusCode === "number") {
    return error.statusCode;
  }

  return null;
}

function normalizeErrorName(error) {
  if (typeof error?.name === "string" && error.name.trim()) {
    return error.name.trim();
  }

  if (typeof error?.code === "string" && error.code.trim()) {
    return error.code.trim();
  }

  return "Error";
}

function normalizeErrorCode(error) {
  if (typeof error?.code === "string" && error.code.trim()) {
    return error.code.trim();
  }

  if (typeof error?.type === "string" && error.type.trim()) {
    return error.type.trim();
  }

  const status = normalizeStatus(error);
  if (status !== null) {
    return `HTTP_${status}`;
  }

  return "UNKNOWN";
}

function normalizeRequestId(error) {
  if (typeof error?.request_id === "string" && error.request_id.trim()) {
    return error.request_id.trim();
  }

  if (typeof error?.requestID === "string" && error.requestID.trim()) {
    return error.requestID.trim();
  }

  return null;
}

function errorMessageIncludes(error, fragment) {
  const text = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return text.includes(fragment.toLowerCase());
}

function isRetryableError(error) {
  const status = normalizeStatus(error);
  if ([400, 401, 403].includes(status)) {
    return false;
  }

  if ([429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  if (["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "ETIMEDOUT"].includes(code)) {
    return true;
  }

  return errorMessageIncludes(error, "fetch failed");
}

function logSafeError(logger, error, attempt) {
  logger.error("ASK ERROR", {
    name: normalizeErrorName(error),
    code: normalizeErrorCode(error),
    status: normalizeStatus(error),
    attempt,
    requestId: normalizeRequestId(error),
  });
}

function buildMessages({ prompt, context = "", mode = "general", conversation = [] }) {
  const systemPrompt = `
You are GigProfit AI, a smart and natural copilot for Uber and Lyft drivers using the GigProfit app.

Your job:
- help drivers make better earning decisions
- explain things clearly and naturally
- sound practical, confident, and human
- avoid robotic or overly polished language
- adapt to the user's request based on mode

Modes:
- general: answer normally
- app_help: explain how to use GigProfit features clearly
- ride_analysis: analyze rides using pay, miles, time, dollars per mile, and dollars per hour
- tax_help: help with business expense, mileage, and tax organization
- radar_help: help interpret zones, events, and move decisions

Rules:
- no markdown tables
- no academic tone
- no unnecessary disclaimers
- keep answers structured but natural
- if information is missing, say what is missing
- if comparing rides, evaluate value, efficiency, and time cost
- if helping with the app, explain step by step when useful
- if the request is unclear, ask one short clarifying question
`.trim();

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
  ];

  if (context && typeof context === "string" && context.trim()) {
    messages.push({
      role: "system",
      content: `App context:\n${context.trim()}`,
    });
  }

  if (Array.isArray(conversation)) {
    for (const item of conversation.slice(-8)) {
      if (
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim()
      ) {
        messages.push({
          role: item.role,
          content: item.content.trim(),
        });
      }
    }
  }

  messages.push({
    role: "user",
    content: `Mode: ${mode}\n\nUser request:\n${prompt}`,
  });

  return messages;
}

async function requestCopilotReply({ openaiClient, payload, logger = console }) {
  const messages = buildMessages(payload);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages,
        stream: false,
      });

      const text = response.choices?.[0]?.message?.content?.trim();
      if (!text) {
        const error = new Error("OpenAI returned empty content");
        error.code = "EMPTY_CONTENT";
        error.status = 502;
        throw error;
      }

      return {
        reply: text,
        mode: payload.mode || "general",
        source: "railway-v3-copilot",
      };
    } catch (error) {
      lastError = error;
      logSafeError(logger, error, attempt);

      if (!isRetryableError(error) || attempt >= MAX_ATTEMPTS) {
        break;
      }

      await delay(RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    }
  }

  throw lastError;
}

function createAskHandler({
  openaiClient,
  hasOpenAIKey,
  logger = console,
} = {}) {
  return async function askHandler(req, res) {
    try {
      if (!hasOpenAIKey) {
        return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
      }

      const {
        prompt,
        context = "",
        mode = "general",
        conversation = [],
      } = req.body || {};

      if (!prompt || typeof prompt !== "string") {
        return res.status(400).json({ error: "Missing prompt" });
      }

      const result = await requestCopilotReply({
        openaiClient,
        payload: {
          prompt,
          context,
          mode,
          conversation,
        },
        logger,
      });

      return res.json(result);
    } catch (error) {
      return res.status(503).json(TEMPORARY_UNAVAILABLE_BODY);
    }
  };
}

export {
  TEMPORARY_UNAVAILABLE_BODY,
  buildMessages,
  createAskHandler,
  isRetryableError,
  normalizeErrorCode,
  normalizeErrorName,
  normalizeRequestId,
  normalizeStatus,
  requestCopilotReply,
};
