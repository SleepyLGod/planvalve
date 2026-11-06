import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { get } from "node:http";
import { createGateway } from "../src/gateway.ts";
import { validateConfig } from "../src/config.ts";
import { History } from "../src/history.ts";
const raw = {
  prompt_tokens: 58,
  completion_tokens: 13,
  total_tokens: 71,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
};
const request = {
  model: "test-model",
  messages: [
    { role: "system", content: "Return JSON." },
    { role: "user", content: "1+1" },
  ],
};
const result = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "test-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: '{"answer":2}' },
      finish_reason: "stop",
    },
  ],
  usage: raw,
};
function server(send: typeof fetch, extra = {}) {
  return createGateway(
    {
      upstream: "openai-api-key",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
      minStartIntervalMs: 0,
      ...extra,
    },
    undefined,
    {
      fetch: send,
      apiKey: "test-upstream-secret",
      localKey: "test-local-secret",
    },
  );
}
test("subscription spacing measures actual sends after a slow credential refresh", async (t) => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/observed-json.json", import.meta.url),
      "utf8",
    ),
  );
  const sends: number[] = [];
  let acquisitions = 0;
  const gateway = createGateway(
    {
      upstream: "chatgpt-subscription",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
      minStartIntervalMs: 160,
    },
    undefined,
    {
      localKey: "test-local-secret",
      subscription: {
        accessToken: async () => {
          if (++acquisitions === 1)
            await new Promise((resolve) => setTimeout(resolve, 190));
          return "fake-subscription-secret";
        },
        status: () => ({ state: "authorized" }),
        close() {},
      },
      fetch: async () => {
        sends.push(Date.now());
        return new Response(
          fixture.events
            .map((event: unknown) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      },
    },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      fetch(url + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer test-local-secret" },
        body: JSON.stringify(request),
      }),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  await Promise.all(responses.map((response) => response.json()));
  assert.equal(sends.length, 2);
  assert(
    sends[1]! - sends[0]! >= 155,
    `Actual sends were only ${sends[1]! - sends[0]!} ms apart`,
  );
});
test("history marks an in-flight inference as dispatched before completion", async (t) => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = server(async () => {
    enter();
    await gate;
    return Response.json(result);
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const pending = fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-local-secret" },
    body: JSON.stringify(request),
  });
  await entered;
  try {
    const page = await (
      await fetch(url + "/_gateway/requests", {
        headers: { authorization: "Bearer test-local-secret" },
      })
    ).json();
    const running = page.items[0];
    assert.equal(running.status, "running");
    assert.equal(running.inferenceDispatched, true);
    assert(running.dispatchedAt);
    const detail = await (
      await fetch(url + "/_gateway/requests/" + running.id, {
        headers: { authorization: "Bearer test-local-secret" },
      })
    ).json();
    assert.equal(detail.inferenceDispatched, true);
    assert.equal(detail.dispatchedAt, running.dispatchedAt);
  } finally {
    release();
    await (await pending).json();
  }
});
test("failure to persist the dispatch transition stops the send and pauses", async (t) => {
  const original = History.prototype.save;
  t.mock.method(
    History.prototype,
    "save",
    function (
      this: History,
      runId: string,
      record: Parameters<History["save"]>[1],
    ) {
      if (record.inferenceDispatched)
        throw new Error("Injected dispatch write failure");
      return original.call(this, runId, record);
    },
  );
  let calls = 0;
  const gateway = server(async () => {
    calls++;
    return Response.json(result);
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-local-secret" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 503);
  await response.json();
  assert.equal(calls, 0);
  assert.equal(gateway.report().realAttempts, 0);
  assert.equal(gateway.records[0]!.inferenceDispatched, false);
  assert.equal(gateway.status().pauseReason, "storage_unavailable");
  assert.equal(gateway.status().usage.unknownUsageRequests, 0);
});
test("explicit upstream config defaults offline and paces real modes without accepting custom destinations", () => {
  assert.equal(validateConfig({}).upstream, "offline");
  assert.equal(
    validateConfig({ upstream: "openai-api-key", model: "test-model" })
      .minStartIntervalMs,
    3000,
  );
  assert.throws(() => validateConfig({ upstream: "custom", model: "x" }));
  assert.throws(() => validateConfig({ upstream: "openai-api-key" }));
});
test("official JS client works with API-key gateway, preserves standard parameters and records metadata", async (t) => {
  let attempts = 0;
  let received: any;
  const gateway = server(async (url, init) => {
    attempts++;
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    assert.equal(
      new Headers(init!.headers).get("authorization"),
      "Bearer test-upstream-secret",
    );
    received = JSON.parse(String(init!.body));
    return Response.json(result, { headers: { "x-request-id": "req-test" } });
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const client = new OpenAI({
    apiKey: "test-local-secret",
    baseURL: url + "/v1",
    maxRetries: 0,
  });
  for (const response_format of [
    { type: "text" },
    { type: "json_object" },
    {
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "integer" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
  ] as any[]) {
    const response = await client.chat.completions.create({
      ...request,
      response_format,
      temperature: 0,
      top_p: 1,
      max_completion_tokens: 20,
    } as any);
    assert.equal(response.choices[0]!.message.content, '{"answer":2}');
    assert.equal(response.usage!.total_tokens, 71);
  }
  assert.deepEqual(received.messages, request.messages);
  assert.equal(received.temperature, 0);
  assert.equal(received.max_completion_tokens, 20);
  assert.equal(attempts, 3);
  assert.deepEqual(gateway.records[0]!.rawUsage, raw);
  assert.equal(gateway.records[0]!.upstreamHttp!.requestId, "req-test");
  assert.equal(gateway.status().upstream, "openai-api-key");
  assert.equal(gateway.status().accountBalance, "unknown");
  const before = JSON.stringify(gateway.report());
  await client.models.list();
  const { readMonitor } = await import("../src/monitor.ts");
  await readMonitor(url, "current", undefined, undefined, "test-local-secret");
  assert.equal(JSON.stringify(gateway.report()), before);
  assert.equal(attempts, 3);
});
test("real-mode model and status routes require local key, reject cross-origin and invalid Host without dispatch", async (t) => {
  let calls = 0;
  const gateway = server(async () => {
    calls++;
    return Response.json(result);
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  for (const route of ["/v1/models", "/_gateway/status", "/_gateway/requests"])
    assert.equal((await fetch(url + route)).status, 401);
  assert.equal(
    (
      await fetch(url + "/v1/models", {
        headers: { authorization: "Bearer test-upstream-secret" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(url + "/v1/models", {
        headers: {
          authorization: "Bearer test-local-secret",
          origin: "https://evil.example",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      get(
        url + "/v1/models",
        {
          headers: {
            authorization: "Bearer test-local-secret",
            host: "evil.example",
          },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode);
        },
      ).on("error", reject);
    }),
    403,
  );
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal(calls, 0);
  assert.equal(gateway.records.length, 0);
});
test("upstream rate limit pauses once, distinguishes exhausted balance and redacts reflected credentials", async (t) => {
  for (const code of ["rate_limit_exceeded", "credit_balance_exhausted"]) {
    let calls = 0;
    const gateway = server(async () => {
      calls++;
      return Response.json(
        { error: { code, message: "test-upstream-secret test-local-secret" } },
        {
          status: 429,
          headers: { "retry-after": "7", "x-request-id": "req-limit" },
        },
      );
    });
    t.after(() => gateway.close());
    const url = await gateway.listen();
    const post = () =>
      fetch(url + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer test-local-secret" },
        body: JSON.stringify(request),
      });
    const r = await post();
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "7");
    assert.equal((await post()).status, 503);
    assert.equal(calls, 1);
    assert.equal(gateway.status().pauseReason, code);
    assert.equal(gateway.records[0]!.upstreamHttp!.retryAfter, "7");
    const report = JSON.stringify(gateway.report());
    assert(!report.includes("test-upstream-secret"));
    assert(!report.includes("test-local-secret"));
  }
});
test("API key incomplete output and missing usage fail explicitly without resend", async (t) => {
  for (const response of [
    { ...result, usage: undefined },
    { ...result, choices: [{ ...result.choices[0], finish_reason: "length" }] },
  ]) {
    let calls = 0;
    const gateway = server(async () => {
      calls++;
      return Response.json(response);
    });
    t.after(() => gateway.close());
    const url = await gateway.listen();
    const r = await fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-local-secret" },
      body: JSON.stringify(request),
    });
    assert.equal(r.status, 502);
    assert.equal(calls, 1);
    assert(gateway.status().queue.paused);
  }
});
test("subscription channel converts roles, preserves raw Responses usage, and shares the local monitor", async (t) => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/observed-json.json", import.meta.url),
      "utf8",
    ),
  );
  let calls = 0;
  const gateway = createGateway(
    {
      upstream: "chatgpt-subscription",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
      minStartIntervalMs: 0,
    },
    undefined,
    {
      localKey: "test-local-secret",
      subscription: {
        accessToken: async () => "test-subscription-secret",
        status: () => ({ state: "authorized" }),
        close() {},
      },
      fetch: async (url, init) => {
        calls++;
        assert.equal(String(url), "https://api.openai.com/v1/responses");
        assert.equal(
          new Headers(init!.headers).get("authorization"),
          "Bearer test-subscription-secret",
        );
        const body = JSON.parse(String(init!.body));
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.equal(body.input[0].role, "developer");
        return new Response(
          fixture.events
            .map((e: any) => `data: ${JSON.stringify(e)}\n\n`)
            .join(""),
        );
      },
    },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  for (const response_format of [
    { type: "text" },
    { type: "json_object" },
    {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "integer" } },
        },
      },
    },
  ]) {
    const r = await fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-local-secret" },
      body: JSON.stringify({ ...request, response_format }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).usage.total_tokens, 71);
  }
  assert.equal(calls, 3);
  assert.equal(gateway.status().authorization!.state, "authorized");
});
test("subscription streaming limit errors retain their specific code and observed usage", async (t) => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/observed-json.json", import.meta.url),
      "utf8",
    ),
  );
  fixture.events.at(-1).type = "response.failed";
  fixture.events.at(-1).response.status = "failed";
  fixture.events.at(-1).response.error = {
    code: "subscription_sharing_usage_limit_exceeded",
    message: "Limit reached",
  };
  const gateway = createGateway(
    {
      upstream: "chatgpt-subscription",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
    },
    undefined,
    {
      localKey: "test-local-secret",
      subscription: {
        accessToken: async () => "test-secret",
        status: () => ({ state: "authorized" }),
        close() {},
      },
      fetch: async () =>
        new Response(
          fixture.events
            .map((e: any) => `data: ${JSON.stringify(e)}\n\n`)
            .join(""),
        ),
    },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-local-secret" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 429);
  assert.equal(
    gateway.status().pauseReason,
    "subscription_sharing_usage_limit_exceeded",
  );
  assert.equal(gateway.records[0]!.usage!.total_tokens, 71);
});
test("subscription refusal is an explicit error with usage rather than successful empty text", async (t) => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/observed-json.json", import.meta.url),
      "utf8",
    ),
  );
  const terminal = fixture.events.at(-1);
  terminal.response.output = [
    {
      type: "message",
      content: [
        { type: "refusal", refusal: "Refused text must never be stored" },
      ],
    },
  ];
  const gateway = createGateway(
    {
      upstream: "chatgpt-subscription",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
    },
    undefined,
    {
      localKey: "test-local-secret",
      subscription: {
        accessToken: async () => "test-secret",
        status: () => ({ state: "authorized" }),
        close() {},
      },
      fetch: async () =>
        new Response(
          [
            `data: ${JSON.stringify({ type: "response.refusal.delta", delta: "refusal" })}\n\n`,
            `data: ${JSON.stringify(terminal)}\n\n`,
          ].join(""),
        ),
    },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const r = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-local-secret" },
    body: JSON.stringify(request),
  });
  assert.equal(r.status, 502);
  assert.equal(gateway.records[0]!.error, "upstream_refusal");
  assert.equal(gateway.records[0]!.usage!.total_tokens, 71);
  assert(!JSON.stringify(gateway.report()).includes("Refused text"));
});
test("absolute request deadline bounds credential acquisition and does not count it as inference", async (t) => {
  let sends = 0;
  const gateway = createGateway(
    {
      upstream: "chatgpt-subscription",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
      upstreamTimeoutMs: 30,
    },
    undefined,
    {
      localKey: "test-local-secret",
      subscription: {
        accessToken: async () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("test-secret"), 500),
          ),
        status: () => ({ state: "refresh-required" }),
        close() {},
      },
      fetch: async () => {
        sends++;
        throw Error("must not send");
      },
    },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const start = Date.now();
  const r = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-local-secret" },
    body: JSON.stringify(request),
  });
  assert.equal(r.status, 502);
  assert(Date.now() - start < 300);
  assert.equal(sends, 0);
  assert.equal(gateway.report().realAttempts, 0);
  assert.equal(gateway.records[0]!.endReason, "timeout");
  assert.equal(gateway.records[0]!.status, "failed");
  assert.equal(gateway.records[0]!.error, "upstream_timeout");
  assert.equal(gateway.records[0]!.upstreamError, undefined);
  assert.equal(gateway.report().totals.unknownUsageRequests, 0);
  assert.equal(gateway.report().totals.reasoning.unknownRequests, 0);
});
test("64 API-key requests keep one upstream in flight through the same FIFO", async (t) => {
  let active = 0,
    max = 0,
    calls = 0;
  const gateway = server(
    async () => {
      calls++;
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return Response.json(result);
    },
    { queueCapacity: 64, maxQueueWaitMs: 10000 },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const responses = await Promise.all(
    Array.from({ length: 64 }, () =>
      fetch(url + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer test-local-secret" },
        body: JSON.stringify(request),
      }),
    ),
  );
  assert(responses.every((r) => r.status === 200));
  assert.equal(calls, 64);
  assert.equal(max, 1);
});
