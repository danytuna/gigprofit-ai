import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENAI_TRANSPORT_NAME,
  TEMPORARY_UNAVAILABLE_BODY,
  createOpenAIClient,
  createOpenAINativeFetch,
  createAskHandler,
  isRetryableError,
  requestCopilotReply,
} from "../aiCopilot.js";

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

function makeLogger() {
  const entries = [];
  return {
    entries,
    error(message, payload) {
      entries.push({ level: "error", message, payload });
    },
    info(message) {
      entries.push({ level: "info", message });
    },
  };
}

function makeRequest(body = {}) {
  return { body };
}

test("OpenAI transport uses native fetch and logs the transport name", async () => {
  const logger = makeLogger();
  const calls = [];
  const nativeFetch = async (input, init) => {
    calls.push({
      input,
      init,
    });

    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "ok",
    };
  };

  const transport = createOpenAINativeFetch(nativeFetch);
  await transport("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.get("Accept-Encoding"), "identity");
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");

  const client = createOpenAIClient({
    apiKey: "test-key",
    logger,
    nativeFetch,
  });

  assert.equal(typeof client.fetch, "function");
  await client.fetch("https://api.openai.com/v1/models", {
    method: "GET",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.get("Accept-Encoding"), "identity");
  assert.deepEqual(logger.entries, [
    {
      level: "info",
      message: `OpenAI transport: ${OPENAI_TRANSPORT_NAME}`,
    },
  ]);
});

test("AI copilot succeeds on first attempt", async () => {
  const logger = makeLogger();
  let calls = 0;
  const openaiClient = {
    chat: {
      completions: {
        async create(payload) {
          calls += 1;
          assert.equal(payload.stream, false);
          return {
            choices: [
              {
                message: {
                  content: "All good",
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await requestCopilotReply({
    openaiClient,
    payload: {
      prompt: "Help me",
      mode: "general",
    },
    logger,
  });

  assert.equal(calls, 1);
  assert.equal(result.reply, "All good");
  assert.deepEqual(logger.entries, []);
  assert.deepEqual(result, {
    reply: "All good",
    mode: "general",
    source: "railway-v3-copilot",
  });
});

test("ERR_STREAM_PREMATURE_CLOSE remains retryable", () => {
  const error = new Error("Premature close");
  error.code = "ERR_STREAM_PREMATURE_CLOSE";

  assert.equal(isRetryableError(error), true);
});

test("AI copilot succeeds after ERR_STREAM_PREMATURE_CLOSE", async () => {
  const logger = makeLogger();
  let calls = 0;
  const openaiClient = {
    chat: {
      completions: {
        async create() {
          calls += 1;
          if (calls === 1) {
            const error = new Error("Premature close");
            error.code = "ERR_STREAM_PREMATURE_CLOSE";
            throw error;
          }

          return {
            choices: [
              {
                message: {
                  content: "Recovered reply",
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await requestCopilotReply({
    openaiClient,
    payload: {
      prompt: "Help me",
      mode: "general",
    },
    logger,
  });

  assert.equal(calls, 2);
  assert.equal(result.reply, "Recovered reply");
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].payload.code, "ERR_STREAM_PREMATURE_CLOSE");
  assert.equal(logger.entries[0].payload.attempt, 1);
});

test("AI copilot fails after 3 retryable attempts", async () => {
  const logger = makeLogger();
  let calls = 0;
  const openaiClient = {
    chat: {
      completions: {
        async create() {
          calls += 1;
          const error = new Error("fetch failed");
          error.code = "ECONNRESET";
          throw error;
        },
      },
    },
  };

  await assert.rejects(
    requestCopilotReply({
      openaiClient,
      payload: {
        prompt: "Help me",
        mode: "general",
      },
      logger,
    }),
    {
      code: "ECONNRESET",
    }
  );

  assert.equal(calls, 3);
  assert.equal(logger.entries.length, 3);
  assert.deepEqual(
    logger.entries.map((entry) => entry.payload.attempt),
    [1, 2, 3]
  );
});

test("AI copilot does not retry 401 errors", async () => {
  const logger = makeLogger();
  let calls = 0;
  const openaiClient = {
    chat: {
      completions: {
        async create() {
          calls += 1;
          const error = new Error("Unauthorized");
          error.status = 401;
          error.request_id = "req_401";
          throw error;
        },
      },
    },
  };

  await assert.rejects(
    requestCopilotReply({
      openaiClient,
      payload: {
        prompt: "Help me",
        mode: "general",
      },
      logger,
    }),
    {
      status: 401,
    }
  );

  assert.equal(calls, 1);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].payload.status, 401);
  assert.equal(logger.entries[0].payload.requestId, "req_401");
});

test("AI copilot handler never exposes prompt or technical error details", async () => {
  const logger = makeLogger();
  const openaiClient = {
    chat: {
      completions: {
        async create() {
          const error = new Error("Premature close while handling user prompt top secret");
          error.code = "ERR_STREAM_PREMATURE_CLOSE";
          throw error;
        },
      },
    },
  };

  const handler = createAskHandler({
    openaiClient,
    hasOpenAIKey: true,
    logger,
  });

  const req = makeRequest({
    prompt: "top secret prompt body",
    mode: "general",
    context: "sensitive context",
  });
  const res = makeResponseRecorder();

  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, TEMPORARY_UNAVAILABLE_BODY);
  assert.doesNotMatch(JSON.stringify(res.body), /Premature close|top secret|context/i);
  assert.equal(logger.entries.length, 3);
  for (const entry of logger.entries) {
    assert.doesNotMatch(JSON.stringify(entry), /top secret prompt body|sensitive context/i);
  }
});
