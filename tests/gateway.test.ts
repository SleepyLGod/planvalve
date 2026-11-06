import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway, type Fixture } from "../src/gateway.ts";
const baseline: Fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/observed-json.json", import.meta.url),
    "utf8",
  ),
);
function fixture(): Fixture {
  return structuredClone(baseline);
}
function response(f: Fixture): Record<string, any> {
  return f.events.at(-1)!.response as Record<string, any>;
}
const messages = [
  { role: "system", content: "Return JSON." },
  { role: "user", content: "Compute 1+1." },
];
const body = (extra = {}) => ({ model: "offline-model", messages, ...extra });
async function setup(options: Parameters<typeof createGateway>[0] = {}) {
  const gateway = createGateway({
    port: 0,
    databasePath: ":memory:",
    ...options,
  });
  const url = await gateway.listen();
  const post = (value: unknown, signal?: AbortSignal) =>
    fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      ...(signal ? { signal } : {}),
    });
  return { gateway, url, post };
}
test("real local HTTP returns observed JSON and preserves all usage without prompt injection", async (t) => {
  const { gateway, post, url } = await setup();
  t.after(() => gateway.close());
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal(
    (await (await fetch(url + "/v1/models")).json()).data[0].id,
    "offline-model",
  );
  const r = await post(
    body({
      response_format: {
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
    }),
  );
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.deepEqual(JSON.parse(result.choices[0].message.content), {
    answer: 2,
  });
  assert.equal(result.usage.prompt_tokens, 58);
  assert.equal(result.usage.completion_tokens, 13);
  assert.equal(result.usage.total_tokens, 71);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 0);
  assert.deepEqual(gateway.records[0]!.rawUsage, response(baseline).usage);
  assert.deepEqual(gateway.mock.lastRequest?.input, [
    { role: "developer", content: "Return JSON." },
    messages[1],
  ]);
  assert.equal(gateway.mock.calls, 1);
  assert.equal(gateway.records[0]!.status, "completed");
});
test("plain text and json_object are both supported", async (t) => {
  const f = fixture();
  let first = true;
  for (const e of f.events) {
    if (e.type === "response.output_text.delta") {
      e.delta = first ? "OK" : "";
      first = false;
    }
    if (e.type === "response.output_text.done") e.text = "OK";
  }
  const a = await setup({ fixture: f });
  t.after(() => a.gateway.close());
  assert.equal(
    (await (await a.post(body())).json()).choices[0].message.content,
    "OK",
  );
  const b = await setup();
  t.after(() => b.gateway.close());
  assert.equal(
    (await b.post(body({ response_format: { type: "json_object" } }))).status,
    200,
  );
});
test("SSE can be missing Content-Type, split into tiny chunks, and have empty final output", async (t) => {
  const { gateway, post } = await setup({ chunkSize: 1, contentType: null });
  t.after(() => gateway.close());
  assert.equal(
    (await (await post(body())).json()).choices[0].message.content,
    '{"answer":2}',
  );
  assert.deepEqual(response(baseline).output, []);
});
test("64 HTTP requests use one upstream at a time, FIFO, and do not deduplicate identical prompts", async (t) => {
  const { gateway, post } = await setup({
    mockDelayMs: 2,
    queueCapacity: 64,
    maxQueueWaitMs: 10000,
  });
  t.after(() => gateway.close());
  const requests = Array.from({ length: 64 }, () => post(body()));
  const responses = await Promise.all(requests);
  assert(responses.every((r) => r.status === 200));
  assert.equal(gateway.mock.calls, 64);
  assert.equal(gateway.mock.maxActive, 1);
  assert.deepEqual(
    gateway.records.map((r) => r.sequence),
    Array.from({ length: 64 }, (_, i) => i + 1),
  );
  assert.equal(gateway.report().totals.totalTokens, 64 * 71);
});
test("queue expiry does not send a second upstream request", async (t) => {
  const { gateway, post } = await setup({
    mockDelayMs: 80,
    maxQueueWaitMs: 10,
  });
  t.after(() => gateway.close());
  const first = post(body());
  await delay(10);
  const second = await post(body());
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "queue_expired");
  assert.equal((await first).status, 200);
  assert.equal(gateway.mock.calls, 1);
});
test("client cancellation while queued never consumes an upstream attempt", async (t) => {
  const { gateway, post } = await setup({ mockDelayMs: 100 });
  t.after(() => gateway.close());
  const first = post(body());
  await delay(15);
  const controller = new AbortController();
  const second = post(body(), controller.signal);
  await delay(15);
  controller.abort();
  await assert.rejects(second);
  await first;
  await delay(20);
  assert.equal(gateway.mock.calls, 1);
  assert(gateway.records.some((r) => r.status === "cancelled"));
});
test("request and observed-token budgets reject later calls", async (t) => {
  for (const config of [{ maxRequests: 1 }, { stopAfterTokens: 71 }]) {
    const { gateway, post } = await setup(config);
    t.after(() => gateway.close());
    assert.equal((await post(body())).status, 200);
    assert.equal((await post(body())).status, 429);
    assert.equal(gateway.mock.calls, 1);
    assert.equal(gateway.status().queue.paused, true);
  }
});
test("upstream failures, incomplete responses and disconnects pause without retry", async (t) => {
  for (const kind of ["response.failed", "response.incomplete", "disconnect"]) {
    const f = fixture();
    if (kind === "disconnect") f.events.pop();
    else {
      f.events.at(-1)!.type = kind;
      response(f).status = kind === "response.failed" ? "failed" : "incomplete";
    }
    const { gateway, post } = await setup({ fixture: f });
    t.after(() => gateway.close());
    assert.equal((await post(body())).status, 502);
    assert.equal((await post(body())).status, 503);
    assert.equal(gateway.mock.calls, 1);
    assert.equal(gateway.report().paused, true);
    assert.equal(
      gateway.records[0]!.rawUsage !== undefined,
      kind !== "disconnect",
    );
  }
});
test("missing core usage fails and pauses, missing details stays unknown rather than zero", async (t) => {
  const f = fixture();
  delete response(f).usage.total_tokens;
  const a = await setup({ fixture: f });
  t.after(() => a.gateway.close());
  assert.equal((await a.post(body())).status, 502);
  assert.equal(a.gateway.report().paused, true);
  const g = fixture();
  delete response(g).usage.input_tokens_details;
  delete response(g).usage.output_tokens_details;
  const b = await setup({ fixture: g });
  t.after(() => b.gateway.close());
  const out = await (await b.post(body())).json();
  assert.equal(out.usage.total_tokens, 71);
  assert.equal(out.usage.prompt_tokens_details, undefined);
  assert.equal(out.usage.completion_tokens_details, undefined);
  assert.equal(b.gateway.records[0]!.usageCompleteness, "partial");
});
test("invalid JSON/schema, unsupported requests, unknown models and parameters are explicit errors", async (t) => {
  const { gateway, post } = await setup();
  t.after(() => gateway.close());
  for (const extra of [
    { stream: true },
    { n: 2 },
    { model: "other" },
    { tools: [] },
    { temperature: 0 },
  ])
    assert.equal((await post(body(extra))).status, 400);
  assert.equal(gateway.mock.calls, 0);
  const r = await post(
    body({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "wrong",
          schema: { type: "object", required: ["missing"] },
        },
      },
    }),
  );
  assert.equal(r.status, 502);
  assert.equal(gateway.mock.calls, 1);
});
test("LOTUS compatibility omissions are explicit and recorded", async (t) => {
  const { gateway, post } = await setup({ profile: "lotus" });
  t.after(() => gateway.close());
  assert.equal(
    (
      await post(
        body({
          temperature: 0,
          max_tokens: 8192,
          thinking: { type: "disabled" },
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    gateway.records[0]!.transformations.map((x) => x.parameter).sort(),
    ["max_tokens", "temperature", "thinking"],
  );
  assert.equal(gateway.mock.lastRequest?.temperature, undefined);
  assert.equal(gateway.mock.lastRequest?.max_output_tokens, undefined);
});
test("start interval and absolute mock deadline are enforced", async (t) => {
  const a = await setup({ minStartIntervalMs: 30 });
  t.after(() => a.gateway.close());
  await a.post(body());
  await a.post(body());
  assert(a.gateway.mock.startTimes[1]! - a.gateway.mock.startTimes[0]! >= 25);
  const b = await setup({ mockDelayMs: 100, upstreamTimeoutMs: 10 });
  t.after(() => b.gateway.close());
  assert.equal((await b.post(body())).status, 502);
  assert.equal(b.gateway.records[0]!.status, "unknown");
  assert.equal(b.gateway.mock.calls, 1);
});
test("independent calls may reuse a JSON schema ID", async (t) => {
  const { gateway, post } = await setup();
  t.after(() => gateway.close());
  const request = body({
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "same",
        schema: {
          $id: "urn:example:answer",
          type: "object",
          properties: { answer: { type: "integer" } },
          required: ["answer"],
        },
      },
    },
  });
  assert.equal((await post(request)).status, 200);
  assert.equal((await post(request)).status, 200);
});
test("SDK construction does not read credential environment defaults", async () => {
  const old = process.env;
  const reads: string[] = [];
  let gateway: ReturnType<typeof createGateway> | undefined;
  try {
    process.env = new Proxy(
      {},
      {
        get(_target, key) {
          if (typeof key === "string" && key.startsWith("OPENAI_"))
            reads.push(key);
          return undefined;
        },
      },
    );
    gateway = createGateway({ port: 0, databasePath: ":memory:" });
  } finally {
    process.env = old;
    await gateway?.close();
  }
  assert.deepEqual(reads, []);
});
test("shutdown interrupts pacing after the last queued request is cancelled", async () => {
  const { gateway, post } = await setup({ minStartIntervalMs: 1000 });
  try {
    await (await post(body())).json();
    const c = new AbortController();
    const waiting = post(body(), c.signal);
    await delay(15);
    c.abort();
    await assert.rejects(waiting);
    await delay(10);
    const start = performance.now();
    await gateway.close();
    assert(
      performance.now() - start < 300,
      "shutdown waited for an empty pacing timer",
    );
  } finally {
    await gateway.close();
  }
});
test("oversized request returns 413 without sending upstream", async (t) => {
  const { gateway, post } = await setup();
  t.after(() => gateway.close());
  assert.equal(
    (
      await post(
        body({ messages: [{ role: "user", content: "a".repeat(1048576) }] }),
      )
    ).status,
    413,
  );
  assert.equal(gateway.mock.calls, 0);
});
test("sanitized observed fixture retains attribution totals and unique item identities", () => {
  const usage = response(baseline).usage;
  const parts = [
    ...Object.values(usage.attribution.items),
    ...Object.values(usage.attribution.request_fields),
  ] as Record<string, number>[];
  assert.equal(
    parts.reduce((sum, part) => sum + part.input_tokens!, 0),
    58,
  );
  assert.equal(
    parts.reduce((sum, part) => sum + part.output_tokens!, 0),
    13,
  );
  assert.equal(Object.keys(usage.attribution.items).length, 3);
});
