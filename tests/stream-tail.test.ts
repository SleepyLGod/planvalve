import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGateway } from "../src/gateway.ts";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/observed-json.json", import.meta.url),
    "utf8",
  ),
);
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
  const started = Date.now();
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "JSON" }],
    }),
  });
  assert.equal(response.status, 200);
  assert(
    Date.now() - started < 600,
    "must return on completion rather than wait for the absolute deadline",
  );
  assert.equal(cancelled, true);
  assert.equal((await response.json()).usage.total_tokens, 71);
  assert.equal(gateway.records[0]!.endReason, "completed");
  assert(gateway.records[0]!.terminalAt);
  assert(gateway.records[0]!.headersAt);
  assert(gateway.records[0]!.firstTextAt);
});
