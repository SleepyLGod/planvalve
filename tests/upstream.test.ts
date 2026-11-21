import { chatFixture } from "./chat-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { get } from "node:http";
import { createGateway } from "../src/gateway.ts";
import { validateConfig } from "../src/config.ts";
import { History } from "../src/history.ts";
import { officialUpstream } from "../src/upstream.ts";
import { Redactor } from "../src/privacy.ts";
import { translate } from "../src/compatibility.ts";
import type { LedgerRecord } from "../src/types.ts";
test("request records and dispatch callbacks remain isolated under reversed completion", async () => {
  const calls = [0, 0];
  const records: LedgerRecord[] = [0, 1].map((n) => ({
    id: String(n),
    sequence: n,
    status: "running",
    receivedAt: new Date().toISOString(),
    requestHash: "test",
    transformations: [],
  }));
  const upstream = officialUpstream(
    "openai-api-key",
    {
      accessToken: async () => "fake",
      status: () => ({ state: "configured" }),
      close() {},
    },
    async (_url, init) => {
      const n = Number(JSON.parse(String(init?.body)).messages[0].content);
      await new Promise((resolve) => setTimeout(resolve, n === 0 ? 40 : 1));
      return chatFixture(
        {
          ...result,
          usage: { ...raw, prompt_tokens: 58 + n, total_tokens: 71 + n },
        },
        { headers: { "x-request-id": "upstream-" + n } },
      );
    },
    new Redactor(),
  );
  await Promise.all(
    records.map((record, n) =>
      upstream.complete(
        {
          model: "test-model",
          messages: [{ role: "user", content: String(n) }],
        },
        AbortSignal.timeout(2000),
        record,
        () => {
          calls[n]!++;
        },
      ),
    ),
  );
  assert.deepEqual(calls, [1, 1]);
  assert.deepEqual(
    records.map((r) => r.upstreamHttp?.requestId),
    ["upstream-0", "upstream-1"],
  );
  assert.deepEqual(
    records.map((r) => r.usage?.prompt_tokens),
    [58, 59],
  );
});
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
const tool = {
  type: "function",
  function: {
    name: "lookup",
    description: "private-description",
    parameters: { type: "object" },
  },
};
const call = {
  id: "private-call-id",
  type: "function",
  function: { name: "lookup", arguments: '{"key":"private-argument"}' },
};
const toolMessage = { role: "assistant", content: null, tool_calls: [call] };

test("Platform tool_choice must be satisfiable by the request's declared tools", () => {
  const named = (name: string) => ({ type: "function", function: { name } });
  const chat = (options: Record<string, unknown>) =>
    translate({ ...request, ...options }, "strict", request.model, "chat")
      .payload;
  for (const options of [
    { tool_choice: "required" },
    { tool_choice: named("lookup") },
    { tools: [tool], tool_choice: named("other") },
  ]) {
    assert.throws(() => chat(options), {
      status: 400,
      code: "invalid_request",
    });
  }
  for (const choice of ["required", named("lookup")]) {
    assert.deepEqual(
      chat({ tools: [tool], tool_choice: choice }).tool_choice,
      choice,
    );
  }
});

test("Platform tool results must complete the preceding call turn exactly once", () => {
  const reply = { role: "tool", tool_call_id: call.id, content: "ok" };
  const chat = (messages: unknown[]) =>
    translate({ ...request, messages }, "strict", request.model, "chat");
  for (const messages of [
    [reply],
    [toolMessage],
    [toolMessage, { ...reply, tool_call_id: "missing" }],
    [toolMessage, reply, reply],
    [toolMessage, request.messages[1], reply],
  ])
    assert.throws(() => chat(messages), {
      status: 400,
      code: "invalid_request",
    });
  const parallel = {
    ...toolMessage,
    tool_calls: [call, { ...call, id: "another" }],
  };
  const messages = [parallel, { ...reply, tool_call_id: "another" }, reply];
  assert.deepEqual(chat(messages).payload.messages, messages);
});

test("Platform tool response leaves room for the history and result in a 1 MiB follow-up", async (t) => {
  const first = { ...request, tools: [tool], stream: false };
  const turn = (padding: number) => ({
    ...toolMessage,
    tool_calls: [
      {
        ...call,
        function: {
          ...call.function,
          arguments: JSON.stringify({ value: "x".repeat(padding) }),
        },
      },
    ],
  });
  const followup = (padding: number) => ({
    ...first,
    messages: [
      ...request.messages,
      turn(padding),
      { role: "tool", tool_call_id: call.id, content: "y".repeat(1024) },
    ],
  });
  let pad = 1024 * 1024 - Buffer.byteLength(JSON.stringify(followup(0)));
  const gateway = server(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return chatFixture(
      body.messages.at(-1).role === "tool"
        ? result
        : {
            ...result,
            choices: [
              { index: 0, message: turn(pad), finish_reason: "tool_calls" },
            ],
          },
    );
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const post = (body: unknown) =>
    fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-local-secret" },
      body: JSON.stringify(body),
    });
  const response = await post(first);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).choices[0].message, turn(pad));
  assert.equal((await post(followup(pad))).status, 200);
  pad++;
  const tooLarge = await post(first);
  assert.equal(tooLarge.status, 502);
  assert.equal((await tooLarge.json()).error.code, "response_too_large");
  assert.equal(gateway.records.at(-1)?.usage?.total_tokens, raw.total_tokens);
});

test("Platform function turn round-trips through dispatch, accounting and private history", async (t) => {
  const sent: Record<string, unknown>[] = [];
  const gateway = server(
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return chatFixture(
        sent.length === 1
          ? {
              ...result,
              choices: [
                { index: 0, message: toolMessage, finish_reason: "tool_calls" },
              ],
            }
          : result,
      );
    },
    { maxRequests: 2 },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const post = (body: unknown) =>
    fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-local-secret" },
      body: JSON.stringify(body),
    });
  const first = {
    ...request,
    reasoning_effort: "none",
    tools: [tool],
    tool_choice: { type: "function", function: { name: "lookup" } },
    response_format: { type: "json_object" },
  };
  const reply = await post(first);
  assert.equal(reply.status, 200);
  const choice = (await reply.json()).choices[0];
  assert.deepEqual(choice, {
    index: 0,
    message: toolMessage,
    finish_reason: "tool_calls",
  });
  const second = {
    ...first,
    tool_choice: "none",
    messages: [
      ...request.messages,
      choice.message,
      { role: "tool", tool_call_id: call.id, content: "private-tool-result" },
    ],
  };
  const final = await post(second);
  assert.equal(final.status, 200);
  assert.deepEqual((await final.json()).choices, result.choices);
  assert.deepEqual(
    sent,
    [first, second].map((body) => ({
      ...body,
      stream: true,
      stream_options: { include_usage: true },
    })),
  );
  assert.notEqual((await post(first)).status, 200);
  assert.equal(sent.length, 2);
  assert.equal(gateway.report().totals.totalTokens, 2 * raw.total_tokens);
  const detail = await fetch(
    url + "/_gateway/requests/" + gateway.records[0]!.id,
    {
      headers: { authorization: "Bearer test-local-secret" },
    },
  );
  assert.equal(detail.status, 200);
  assert.doesNotMatch(
    (await detail.text()) + JSON.stringify(gateway.report()),
    /private-(argument|call-id|tool-result|description)/,
  );
});

test("invalid Platform tool turns fail without replay and preserve observed usage", async (t) => {
  const choice = {
    index: 0,
    message: toolMessage,
    finish_reason: "tool_calls",
  };
  const named = { type: "function", function: { name: "lookup" } };
  const other = { ...call, function: { ...call.function, name: "other" } };
  const otherTurn = {
    ...result,
    choices: [{ ...choice, message: { ...toolMessage, tool_calls: [other] } }],
  };
  for (const [body, code, options] of [
    [result, "upstream_incomplete", { tool_choice: "required" }],
    [result, "upstream_incomplete", { tool_choice: named }],
    [otherTurn, "upstream_incomplete", {}],
    [
      otherTurn,
      "upstream_incomplete",
      {
        tools: [tool, { type: "function", function: { name: "other" } }],
        tool_choice: named,
      },
    ],
    [
      { ...result, choices: [choice] },
      "upstream_incomplete",
      { tool_choice: "none" },
    ],
    [
      { ...result, choices: [{ ...choice, finish_reason: "length" }] },
      "upstream_incomplete",
    ],
    [
      {
        ...result,
        choices: [
          {
            ...choice,
            message: { ...toolMessage, tool_calls: [{ ...call, id: "" }] },
          },
        ],
      },
      "upstream_incomplete",
    ],
    [{ ...result, choices: [choice], usage: null }, "usage_missing"],
  ] as const) {
    let attempts = 0;
    const gateway = server(async () => {
      attempts++;
      return chatFixture(body);
    });
    t.after(() => gateway.close());
    const url = await gateway.listen();
    const r = await fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-local-secret" },
      body: JSON.stringify({ ...request, tools: [tool], ...options }),
    });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, code);
    assert.equal(attempts, 1);
    assert.equal(
      gateway.records[0]!.usage?.total_tokens,
      body.usage?.total_tokens,
    );
  }
});

test("Platform-only parameters are never silently accepted by the subscription", () => {
  for (const extra of [
    { tools: [tool] },
    { tool_choice: "auto" },
    { reasoning_effort: "none" },
    { messages: [toolMessage] },
    { messages: [{ role: "tool", tool_call_id: call.id, content: "x" }] },
  ]) {
    for (const profile of ["strict", "lotus"] as const)
      assert.throws(() =>
        translate(
          { ...request, ...extra },
          profile,
          request.model,
          "responses",
        ),
      );
  }
  for (const extra of [
    { stream: true },
    { tools: [{ type: "custom", name: "x" }] },
    { reasoning_effort: 1 },
    { messages: [{ role: "tool", content: "x" }] },
  ])
    assert.throws(() =>
      translate({ ...request, ...extra }, "strict", request.model, "chat"),
    );
});

test("configured HTTP concurrency reaches four while request budget cannot oversend", async (t) => {
  for (const [concurrency, maxRequests] of [
    [1, null],
    [2, null],
    [4, null],
    [4, 1],
  ] as const) {
    let active = 0,
      peak = 0,
      calls = 0;
    const expectedPeak = Math.min(concurrency, maxRequests ?? concurrency);
    let release!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the first wave until it fills; don't assume CI can start four requests in 3 ms.
    const deadline = setTimeout(release, 10_000);
    t.after(() => clearTimeout(deadline));
    const gateway = server(
      async () => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        if (active === expectedPeak) release();
        await firstWave;
        await new Promise((resolve) => setTimeout(resolve, 3));
        active--;
        return chatFixture(result);
      },
      { concurrency, maxRequests },
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
    await Promise.all(responses.map((r) => r.json()));
    assert.equal(calls, maxRequests === null ? 64 : 1);
    assert.equal(peak, expectedPeak);
  }
});
test("temporary rate failure is not retried and a later independent request continues after cooldown", async (t) => {
  let calls = 0;
  const sends: number[] = [];
  const gateway = server(async () => {
    calls++;
    sends.push(performance.now());
    return calls === 1
      ? Response.json(
          { error: { code: "rate_limit_exceeded" } },
          {
            status: 429,
            headers: {
              "retry-after": "0",
              "x-ratelimit-remaining-requests": "0",
            },
          },
        )
      : chatFixture(result);
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const post = () =>
    fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-local-secret" },
      body: JSON.stringify(request),
    });
  assert.equal((await post()).status, 429);
  assert.equal((await post()).status, 200);
  assert.equal(calls, 2);
  assert.equal(gateway.report().paused, false);
  assert.equal(gateway.records[0]!.rateLimit?.decision.action, "cooldown");
});
test("a hard pause preserves other in-flight results and cannot be cleared by their success", async (t) => {
  let calls = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = server(
    async () => {
      const n = ++calls;
      if (n === 4) release();
      await barrier;
      if (n === 1)
        return Response.json(
          { error: { code: "credit_balance_exhausted" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
      return chatFixture(result);
    },
    { concurrency: 4 },
  );
  t.after(() => {
    release();
    return gateway.close();
  });
  const url = await gateway.listen();
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(url + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer test-local-secret" },
        body: JSON.stringify(request),
      }),
    ),
  );
  await Promise.all(responses.map((r) => r.json()));
  assert.equal(calls, 4);
  assert.equal(responses.filter((r) => r.status === 200).length, 3);
  assert.equal(gateway.status().queue.paused, true);
  assert.equal(gateway.status().pauseReason, "credit_balance_exhausted");
  assert.equal(gateway.report().totals.totalTokens, 213);
});
test("unsent cooldown deadline ends only that request and retains recoverable sender state", async (t) => {
  let calls = 0;
  const gateway = server(
    async () => {
      calls++;
      return calls === 1
        ? Response.json(
            { error: { code: "rate_limit_exceeded" } },
            { status: 429, headers: { "retry-after": "1" } },
          )
        : chatFixture(result);
    },
    { upstreamTimeoutMs: 20 },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const post = () =>
    fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-local-secret" },
      body: JSON.stringify(request),
    });
  assert.equal((await post()).status, 429);
  const expired = await post();
  assert.equal(expired.status, 429);
  assert.equal((await expired.json()).error.code, "dispatch_expired");
  assert.equal(calls, 1);
  assert.equal(gateway.status().queue.paused, false);
  assert.equal(gateway.status().dispatch?.state, "cooldown");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal((await post()).status, 200);
  assert.equal(calls, 2);
});
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
    return chatFixture(result);
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
    return chatFixture(result);
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
    return chatFixture(result, { headers: { "x-request-id": "req-test" } });
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
    return chatFixture(result);
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
  for (const code of ["credit_balance_exhausted"]) {
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
      return chatFixture(response);
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
  const body = await response.json();
  assert.equal(body.error.code, "subscription_sharing_usage_limit_exceeded");
  assert.match(body.error.message, /https:\/\/chatgpt\.com\/settings\/usage/);
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
  assert.equal(r.status, 429);
  assert(Date.now() - start < 300);
  assert.equal(sends, 0);
  assert.equal(gateway.report().realAttempts, 0);
  assert.equal(gateway.records[0]!.endReason, "dispatch_expired");
  assert.equal(gateway.records[0]!.status, "expired");
  assert.equal(gateway.records[0]!.error, "dispatch_expired");
  assert.equal(gateway.status().queue.paused, false);
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
      return chatFixture(result);
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
