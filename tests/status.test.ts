import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "../src/gateway.ts";
const body = {
  model: "offline-model",
  messages: [{ role: "user", content: "private prompt" }],
};
async function setup(
  options: any = {},
  runtime?: Parameters<typeof createGateway>[2],
) {
  const gateway = createGateway(
    {
      port: 0,
      databasePath: ":memory:",
      ...options,
    },
    undefined,
    runtime,
  );
  const url = await gateway.listen();
  const post = () =>
    fetch(url + "/v1/chat/completions", {
      method: "POST",
      ...(runtime?.localKey
        ? { headers: { authorization: "Bearer " + runtime.localKey } }
        : {}),
      body: JSON.stringify(body),
    });
  const get = async (path: string) => {
    const response = await fetch(
      url + path,
      runtime?.localKey
        ? { headers: { authorization: "Bearer " + runtime.localKey } }
        : {},
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  return { gateway, url, post, get };
}
function databasePath(): string {
  mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
  return (
    mkdtempSync(
      fileURLToPath(new URL("../reports/db-test-", import.meta.url)),
    ) + "/history.sqlite"
  );
}

test("read-only status reports real queue state without consuming attempts", async (t) => {
  let release!: () => void,
    started!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { gateway, post, get } = await setup(
    {
      upstream: "openai-api-key",
      model: "offline-model",
      minStartIntervalMs: 0,
    },
    {
      localKey: "test-local-key-private",
      apiKey: "test-api-key-private",
      fetch: async () => {
        calls++;
        if (calls === 1) {
          started();
          await gate;
        }
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: "offline-model",
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "JSON" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 58,
            completion_tokens: 13,
            total_tokens: 71,
            prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        });
      },
    },
  );
  t.after(() => {
    release();
    return gateway.close();
  });
  const first = post();
  await sent;
  const queued = new Promise<void>((resolve) =>
    gateway.server.once("ledgerChanged", () => resolve()),
  );
  const second = post();
  await queued;
  const snapshot = await get("/_gateway/status");
  assert.equal(snapshot.mode, "openai-api-key");
  assert.equal(snapshot.queue.concurrency, 1);
  assert.equal(snapshot.queue.running, 1);
  assert.equal(snapshot.queue.waiting, 1);
  assert.equal(snapshot.usage.totalTokens, 0);
  for (let i = 0; i < 3; i++) await get("/_gateway/status");
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  const done = await get("/_gateway/status");
  assert.equal(done.usage.inputTokens, 116);
  assert.equal(done.usage.outputTokens, 26);
  assert.equal(done.usage.totalTokens, 142);
  assert.deepEqual(done.usage.cached, { knownTokens: 0, unknownRequests: 0 });
  assert.equal(done.queue.running, 0);
  assert.equal(done.queue.waiting, 0);
  assert.equal(done.budget.requests.used, 2);
  const list = await get("/_gateway/requests");
  assert.equal(list.items.length, 2);
  assert.equal(gateway.records.length, 2);
});

test("SQLite retains previous runs and preserves raw usage without prompt bodies", async () => {
  const path = databasePath();
  const first = await setup({ databasePath: path, maxRequests: 1 });
  await first.post();
  const old = await first.get("/_gateway/status");
  await first.gateway.close();
  const second = await setup({ databasePath: path, maxRequests: 1 });
  try {
    const current = await second.get("/_gateway/status");
    assert.notEqual(current.runId, old.runId);
    assert.equal(current.budget.requests.used, 0);
    assert.equal(
      (await second.get("/_gateway/requests?run_id=" + current.runId)).items
        .length,
      0,
    );
    const history = await second.get("/_gateway/requests");
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].historical, true);
    const detail = await second.get(
      "/_gateway/requests/" + history.items[0].id,
    );
    assert.equal(detail.rawUsage.total_tokens, 71);
    assert.equal(detail.model, "offline-model");
    assert.equal(detail.outputFormat, "text");
    assert.equal(detail.status, "completed");
    assert(!JSON.stringify(detail).includes("private prompt"));
    assert(!readFileSync(path).includes(Buffer.from("private prompt")));
    assert.equal((await second.post()).status, 200);
  } finally {
    await second.gateway.close();
  }
});

test("request history pages newest first with a stable cursor", async (t) => {
  const s = await setup();
  t.after(() => s.gateway.close());
  for (let i = 0; i < 3; i++) await s.post();
  const a = await s.get("/_gateway/requests?limit=2");
  assert.deepEqual(
    a.items.map((x: any) => x.sequence),
    [3, 2],
  );
  assert(a.nextCursor);
  const b = await s.get("/_gateway/requests?limit=2&before=" + a.nextCursor);
  assert.deepEqual(
    b.items.map((x: any) => x.sequence),
    [1],
  );
  assert.equal(b.nextCursor, null);
  for (const query of ["limit=201", "limit=0", "before=invalid"])
    assert.equal(
      (await fetch(s.url + "/_gateway/requests?" + query)).status,
      400,
    );
  assert.equal((await fetch(s.url + "/_gateway/requests/absent")).status, 404);
});

test("missing token details remain unknown in monitoring aggregates", async (t) => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/observed-json.json", import.meta.url),
      "utf8",
    ),
  );
  const usage = fixture.events.at(-1).response.usage;
  delete usage.input_tokens_details;
  delete usage.output_tokens_details;
  const s = await setup({ fixture });
  t.after(() => s.gateway.close());
  await s.post();
  const status = await s.get("/_gateway/status");
  assert.equal(status.usage.totalTokens, 71);
  assert.deepEqual(status.usage.cached, { knownTokens: 0, unknownRequests: 1 });
  assert.deepEqual(status.usage.reasoning, {
    knownTokens: 0,
    unknownRequests: 1,
  });
});

test("SQLite failure before dispatch pauses sender without a model attempt", async (t) => {
  const path = databasePath();
  const s = await setup({ databasePath: path });
  t.after(() => s.gateway.close());
  const blocker = new DatabaseSync(path);
  blocker.exec("BEGIN EXCLUSIVE");
  try {
    const response = await s.post();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "storage_unavailable");
    assert.equal(s.gateway.mock.calls, 0);
    assert.equal((await s.get("/_gateway/status")).storage.healthy, false);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  assert.equal((await s.post()).status, 503);
  assert.equal(s.gateway.mock.calls, 0);
});

test("SQLite final-write failure never returns success and never resends", async (t) => {
  const path = databasePath();
  const s = await setup({ databasePath: path });
  t.after(() => s.gateway.close());
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TRIGGER block_completion BEFORE UPDATE ON requests WHEN json_extract(NEW.record_json,'$.status')='completed' BEGIN SELECT RAISE(FAIL,'disk failure'); END`,
  );
  try {
    const r = await s.post();
    assert.equal(r.status, 503);
    assert.equal(s.gateway.mock.calls, 1);
    assert.equal((await s.post()).status, 503);
    assert.equal(s.gateway.mock.calls, 1);
    assert.equal((await s.get("/_gateway/status")).queue.running, 0);
  } finally {
    db.close();
  }
});

test("failed running-state persistence does not leave a phantom active request", async (t) => {
  const path = databasePath();
  const s = await setup({ databasePath: path });
  t.after(() => s.gateway.close());
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TRIGGER block_running BEFORE UPDATE ON requests WHEN json_extract(NEW.record_json,'$.status')='running' BEGIN SELECT RAISE(FAIL,'disk failure'); END`,
  );
  try {
    assert.equal((await s.post()).status, 503);
    const status = await s.get("/_gateway/status");
    assert.equal(status.queue.running, 0);
    assert.equal(status.queue.waiting, 0);
    assert.equal(s.gateway.mock.calls, 0);
  } finally {
    db.close();
  }
});
