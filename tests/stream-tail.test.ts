import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createGateway } from "../src/gateway.ts";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/observed-json.json", import.meta.url),
    "utf8",
  ),
);
test("native HTTP completion preserves output and usage while cancelling an open tail", async (t) => {
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      fixture.events
        .map((event: unknown) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => {
        upstream.close(() => resolve());
        upstream.closeAllConnections();
      }),
  );
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const gateway = createGateway(
    {
      port: 0,
      databasePath: ":memory:",
      maxRequests: 1,
      upstreamTimeoutMs: 2000,
    },
    {
      model: "test-model",
      fetch: async (_input, init) =>
        fetch(`http://127.0.0.1:${address.port}`, init),
    },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Return JSON" }],
    }),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as any;
  assert.deepEqual(JSON.parse(result.choices[0].message.content), {
    answer: 2,
  });
  assert.equal(result.usage.total_tokens, 71);
  assert.equal(gateway.records[0]!.status, "completed");
  assert.equal(gateway.status().queue.paused, false);
  assert.equal(gateway.report().realAttempts, 1);
});
test("completed Responses event cancels an open transport tail before its deadline", async (t) => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const fake: typeof fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const event of fixture.events)
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          init!.signal!.addEventListener(
            "abort",
            () => {
              cancelled = true;
              controller.error(init!.signal!.reason);
            },
            { once: true },
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const gateway = createGateway(
    {
      port: 0,
      databasePath: ":memory:",
      maxRequests: 1,
      upstreamTimeoutMs: 1000,
    },
    { model: "test-model", fetch: fake },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "JSON" }],
    }),
  });
  assert.equal(response.status, 200);
  const record = gateway.records[0]!;
  // Measure the server's terminal-to-finish path, excluding unrelated client/loopback scheduling.
  assert(
    Date.parse(record.finishedAt!) - Date.parse(record.terminalAt!) < 600,
    "must return on completion rather than wait for the absolute deadline",
  );
  assert.equal(cancelled, true);
  assert.equal((await response.json()).usage.total_tokens, 71);
  assert.equal(gateway.records[0]!.endReason, "completed");
  assert(gateway.records[0]!.terminalAt);
  assert(gateway.records[0]!.headersAt);
  assert(gateway.records[0]!.firstTextAt);
});
