import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createGateway } from "../src/gateway.ts";
import { RequestTiming } from "../src/timing.ts";
import type { LedgerRecord } from "../src/types.ts";
import { chatEvents } from "./chat-fixture.ts";

test("timing uses monotonic elapsed time and estimates only eligible text output", (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => 1700000000000 - now);
  const record: LedgerRecord = {
    id: "test",
    sequence: 1,
    status: "completed",
    receivedAt: new Date(Date.now()).toISOString(),
    transformations: [],
    requestHash: "test",
    usage: {
      completion_tokens: 11,
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  };
  const timing = new RequestTiming(() => now);
  now = 20;
  timing.sent(record);
  now = 120;
  timing.text();
  timing.completedUpstream();
  timing.finish(record);
  assert.equal(record.timing?.tpotUnavailable, "single_chunk");
  now = 200;
  timing.text();
  now = 240;
  timing.completedUpstream();
  now = 250;
  timing.finish(record);
  assert.deepEqual(
    { ...record.timing },
    { preSendMs: 20, ttftMs: 100, upstreamMs: 220, gatewayMs: 250, tpotMs: 10 },
  );
  assert.equal(
    Date.parse(record.lastTextAt!) - Date.parse(record.firstTextAt!),
    80,
  );

  delete record.usage!.completion_tokens_details;
  timing.finish(record);
  assert.equal(record.timing?.tpotUnavailable, "usage_detail_missing");
  record.usage!.completion_tokens_details = { reasoning_tokens: 10 };
  timing.finish(record);
  assert.equal(record.timing?.tpotUnavailable, "too_few_tokens");
  timing.markToolTurn();
  timing.finish(record);
  assert.equal(record.timing?.tpotUnavailable, "tool_turn");
  record.status = "failed";
  timing.finish(record);
  assert.equal(record.timing?.upstreamMs, undefined);
  assert.equal(record.timing?.ttftMs, 100);
  assert.equal(record.timing?.tpotMs, undefined);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const usage = {
  prompt_tokens: 2,
  completion_tokens: 5,
  total_tokens: 7,
  completion_tokens_details: { reasoning_tokens: 0 },
};
const textChoice = (delta: object, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});
const send = (url: string, options: object = {}) =>
  fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-local-timing-key" },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Test" }],
      ...options,
    }),
  });
function platform(fetch: typeof globalThis.fetch) {
  return createGateway(
    {
      upstream: "openai-api-key",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
      minStartIntervalMs: 0,
      upstreamTimeoutMs: 2500,
    },
    undefined,
    { apiKey: "test-key", localKey: "test-local-timing-key", fetch },
  );
}

test("Platform waits for delayed usage and retains the slot until cancellation settles", async (t) => {
  const encoder = new TextEncoder();
  const { promise: streamStarted, resolve: notifyStart } = deferred();
  const { promise: cancelStarted, resolve: notifyCancel } = deferred();
  const { promise: cleanup, resolve: releaseCleanup } = deferred();
  let writer: ReadableStreamDefaultController<Uint8Array>;
  const emit = (event: object) =>
    writer.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\n\n"));
  const gateway = platform(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            writer = controller;
            emit(textChoice({ role: "assistant", content: "" }));
            emit(textChoice({ content: '{"answer":' }));
            emit(textChoice({ content: "2}" }));
            emit(textChoice({}, "stop"));
            notifyStart();
          },
          cancel() {
            notifyCancel();
            return cleanup;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  t.after(() => {
    releaseCleanup();
    return gateway.close();
  });
  const url = await gateway.listen();
  const response = send(url, { response_format: { type: "json_object" } });
  await streamStarted;
  await setImmediate();
  assert.equal(gateway.status().queue.inFlight, 1);
  assert.equal(gateway.records[0]?.usage, undefined);
  emit({ choices: [], usage });
  await cancelStarted;
  assert.equal(gateway.status().queue.inFlight, 1);
  releaseCleanup();
  const reply = await response;
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).choices[0].message.content, '{"answer":2}');
  const timing = gateway.records[0]?.timing;
  assert(
    timing &&
      timing.ttftMs !== undefined &&
      timing.tpotMs !== undefined &&
      timing.upstreamMs !== undefined,
  );
  assert(timing.upstreamMs >= timing.ttftMs);
  assert(timing.gatewayMs >= timing.upstreamMs + timing.preSendMs!);
});

test("Platform merges interleaved tool fragments and estimates no mixed-output TPOT", async (t) => {
  const tool = (index: number, fragment: object) =>
    textChoice({ tool_calls: [{ index, ...fragment }] });
  const gateway = platform(async () =>
    chatEvents([
      textChoice({ role: "assistant", content: "Checking" }),
      tool(0, {
        id: "call_a",
        type: "function",
        function: { name: "lookup", arguments: '{"a":' },
      }),
      tool(1, {
        id: "call_b",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      }),
      tool(0, { function: { arguments: "1}" } }),
      textChoice({ content: " now" }),
      textChoice({}, "tool_calls"),
      { choices: [], usage },
    ]),
  );
  t.after(() => gateway.close());
  const reply = await send(await gateway.listen(), {
    tools: [{ type: "function", function: { name: "lookup" } }],
  });
  assert.equal(reply.status, 200);
  const body = await reply.json();
  assert.equal(body.choices[0].message.content, "Checking now");
  assert.deepEqual(
    body.choices[0].message.tool_calls.map(
      (call: { id: string; function: { arguments: string } }) => [
        call.id,
        call.function.arguments,
      ],
    ),
    [
      ["call_a", '{"a":1}'],
      ["call_b", "{}"],
    ],
  );
  const timing = gateway.records[0]?.timing;
  assert(
    timing &&
      timing.ttftMs !== undefined &&
      timing.firstToolArgumentsMs !== undefined,
  );
  assert.equal(timing.tpotMs, undefined);
  assert.equal(timing.tpotUnavailable, "tool_turn");
});

test("Platform preserves first text on an interrupted stream and leaves completion timing unknown", async (t) => {
  let attempts = 0;
  const gateway = platform(async () => {
    attempts++;
    return chatEvents([textChoice({ role: "assistant", content: "partial" })]);
  });
  t.after(() => gateway.close());
  const response = await send(await gateway.listen());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "stream_interrupted");
  assert.equal(attempts, 1);
  const timing = gateway.records[0]?.timing;
  assert(timing && timing.ttftMs !== undefined);
  assert.equal(timing.upstreamMs, undefined);
  assert.equal(timing.tpotUnavailable, "request_failed");
});

test("Responses records elapsed timing and persists it for monitoring", async (t) => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const response = await send(url, { model: "offline-model" });
  assert.equal(response.status, 200);
  await response.json();
  const record = gateway.records[0]!;
  const detail = await (
    await fetch(url + "/_gateway/requests/" + record.id)
  ).json();
  assert.equal(record.status, "completed");
  assert(record.timing?.upstreamMs !== undefined);
  assert(record.timing.ttftMs !== undefined);
  assert(record.timing.upstreamMs >= record.timing.ttftMs);
  assert.deepEqual(detail.timing, record.timing);
  assert.equal(detail.lastTextAt, record.lastTextAt);
});

test("Platform timing completes through native loopback HTTP with an open SSE tail", async (t) => {
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      textChoice({ role: "assistant", content: "{}" }),
      textChoice({}, "stop"),
      { choices: [], usage },
    ])
      res.write("data: " + JSON.stringify(event) + "\n\n");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => {
    upstream.closeAllConnections();
    return new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const gateway = platform(async (_url, init) =>
    fetch(`http://127.0.0.1:${address.port}`, init),
  );
  t.after(() => gateway.close());
  const response = await send(await gateway.listen());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).usage.total_tokens, 7);
  assert.equal(gateway.records[0]?.timing?.tpotUnavailable, "single_chunk");
  assert.equal(gateway.status().queue.paused, false);
});
