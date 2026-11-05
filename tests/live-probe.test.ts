import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGateway } from "../src/gateway.ts";
import { MockTransport } from "../src/mock.ts";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/observed-json.json", import.meta.url),
    "utf8",
  ),
);
test("explicit capped probe transport uses gateway accounting and actual model metadata", async (t) => {
  const transport = new MockTransport(fixture, {});
  const gateway = (createGateway as any)(
    { port: 0, databasePath: ":memory:", maxRequests: 1 },
    { model: "test-subscription-model", fetch: transport.fetch },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const post = () =>
    fetch(url + "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "test-subscription-model",
        messages: [{ role: "user", content: "JSON please" }],
        response_format: { type: "json_object" },
      }),
    });
  const response = await post();
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.model, "test-subscription-model");
  assert.equal(value.usage.total_tokens, 71);
  const status = await (await fetch(url + "/_gateway/status")).json();
  assert.equal(status.mode, "subscription-probe");
  assert.equal(status.budget.requests.used, 1);
  assert.equal(gateway.report().realAttempts, 1);
  assert.equal(gateway.mock.calls, 0);
  assert.equal((await post()).status, 429);
  assert.equal(transport.calls, 1);
  const page = await (await fetch(url + "/_gateway/requests")).json();
  assert.equal(
    page.items.find((r: any) => r.status === "completed").model,
    "test-subscription-model",
  );
});
test("live probe entry requires an explicit maximum of one or two model calls", () => {
  for (const maxRequests of [null, 3, 1000])
    assert.throws(() =>
      (createGateway as any)(
        { databasePath: ":memory:", maxRequests },
        {
          model: "test-model",
          fetch: async () => {
            throw Error("must not call");
          },
        },
      ),
    );
});
test("subscription fetch enforces the public endpoint, in-memory bearer and a hard two-call cap", async () => {
  const { subscriptionFetch } = await import("../src/probe-transport.ts");
  let sent = 0;
  const headers: Headers[] = [];
  const fake: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    assert.equal(init?.redirect, "error");
    headers.push(new Headers(init?.headers));
    sent++;
    return new Response("ok");
  };
  const send = subscriptionFetch(
    "test-token",
    () => {},
    () => {},
    fake,
  );
  for (let i = 0; i < 2; i++)
    await send("http://offline.invalid/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "test-model",
        input: [],
        store: false,
        stream: true,
      }),
    });
  assert.equal(headers[0]!.get("authorization"), "Bearer test-token");
  await assert.rejects(() =>
    send("http://offline.invalid/v1/responses", { method: "POST", body: "{}" }),
  );
  assert.equal(sent, 2);
  await assert.rejects(() =>
    send("https://example.com/steal", { method: "POST", body: "{}" }),
  );
  assert.equal(sent, 2);
});
test("HTTP error diagnostics are consumed before returning the original response to SDK", async () => {
  const { subscriptionFetch } = await import("../src/probe-transport.ts");
  let saved = "";
  const send = subscriptionFetch(
    "fake",
    () => {},
    async (_attempt, response) => {
      saved = await response.clone().text();
    },
    async () =>
      new Response(
        '{"error":{"code":"subscription_sharing_user_not_eligible"}}',
        { status: 403 },
      ),
  );
  const response = await send("http://offline.invalid/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "test", store: false, stream: true }),
  });
  assert.match(saved, /subscription_sharing_user_not_eligible/);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /subscription_sharing_user_not_eligible/);
});
test("terminal failure retains the upstream error alongside usage", async (t) => {
  const f = structuredClone(fixture);
  f.events.at(-1).type = "response.failed";
  f.events.at(-1).response.status = "failed";
  f.events.at(-1).response.error = {
    code: "rate_limit_exceeded",
    message: "Test limit",
  };
  const transport = new MockTransport(f, {});
  const gateway = createGateway(
    { port: 0, databasePath: ":memory:", maxRequests: 1 },
    { model: "test-model", fetch: transport.fetch },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const r = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
    }),
  });
  assert.equal(r.status, 502);
  assert.equal(
    (gateway.records[0] as any).upstreamError.code,
    "rate_limit_exceeded",
  );
  assert.equal(gateway.records[0]!.rawUsage!.total_tokens, 71);
});
