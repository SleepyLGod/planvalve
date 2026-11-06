import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createGateway } from "../src/gateway.ts";
import { DispatchControl } from "../src/dispatch.ts";
import { rateDecision } from "../src/rate-limit.ts";
import { captureUsage } from "../src/upstream.ts";
import { Redactor } from "../src/privacy.ts";
import type { LedgerRecord } from "../src/types.ts";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/observed-json.json", import.meta.url),
    "utf8",
  ),
);
const bytes = new TextEncoder().encode(
  fixture.events.map((e: unknown) => `data: ${JSON.stringify(e)}\n\n`).join(""),
);
const answer = {
  id: "test",
  object: "chat.completion",
  created: 1,
  model: "test-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "OK" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};
const localKey = "review-local-secret";
const apiKey = "review-upstream-private-secret";
function keyGateway(send: typeof fetch, options = {}) {
  return createGateway(
    {
      upstream: "openai-api-key",
      model: "test-model",
      port: 0,
      minStartIntervalMs: 0,
      databasePath: ":memory:",
      ...options,
    },
    undefined,
    { fetch: send, localKey, apiKey },
  );
}
const post = (url: string, content = "JSON", signal?: AbortSignal) =>
  fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + localKey },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content }],
    }),
    signal,
  });
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("condition did not become true");
}

for (const kind of ["response.failed", "error", "named-error"] as const) {
  test(`${kind} quota feedback blocks sends before subscription or probe cleanup`, async (t) => {
    const code = "subscription_sharing_usage_limit_exceeded";
    const tape = structuredClone(fixture);
    const terminal = tape.events.at(-1);
    terminal.type = "response.failed";
    terminal.response.status = "failed";
    terminal.response.error = { code };
    const errorEvent = {
      type: "error",
      code,
      message: apiKey,
      param: null,
      sequence_number: 1,
    };
    const failed = new TextEncoder().encode(
      kind === "response.failed"
        ? tape.events
            .map((event: unknown) => `data: ${JSON.stringify(event)}\n\n`)
            .join("")
        : `${kind === "named-error" ? "event: error\n" : ""}data: ${JSON.stringify(errorEvent)}\n\n`,
    );
    for (const probe of [false, true]) {
      let calls = 0,
        cancelling = false,
        returned = false,
        release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const send: typeof fetch = async () => {
        const n = ++calls;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(n === 1 ? failed : bytes);
              if (n > 1) c.close();
            },
            async cancel() {
              cancelling = true;
              await barrier;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const options = {
        port: 0,
        databasePath: ":memory:",
        maxRequests: 2,
        concurrency: 2,
        minStartIntervalMs: 3000,
        upstreamTimeoutMs: 10000,
      };
      const gateway = probe
        ? createGateway(options, { model: "test-model", fetch: send })
        : createGateway(
            {
              ...options,
              upstream: "chatgpt-subscription",
              model: "test-model",
            },
            undefined,
            {
              localKey,
              fetch: send,
              subscription: {
                accessToken: async () => apiKey,
                status: () => ({ state: "authorized" }),
                close() {},
              },
            },
          );
      const url = await gateway.listen();
      const first = post(url).then((response) => {
        returned = true;
        return response;
      });
      t.after(async () => {
        release();
        await first;
        await gateway.close();
      });
      await until(() => cancelling);
      const second = await post(url);
      await second.arrayBuffer();
      assert.equal(second.status, 503);
      assert.equal(
        calls,
        1,
        "a known quota failure must block the next send even at the 3-second interval",
      );
      assert.equal(
        gateway.status().queue.running,
        1,
        "cleanup retains its execution slot",
      );
      assert.equal(
        returned,
        false,
        "client response still waits for real cleanup",
      );
      assert.equal(gateway.status().pauseReason, code);
      assert.equal(gateway.records[0]!.upstreamError!.code, code);
      assert(!JSON.stringify(gateway.report()).includes(apiKey));
      release();
      const response = await first;
      assert.equal(response.status, 429);
      assert.equal(((await response.json()) as any).error.code, code);
      assert.equal(calls, 1, "failed calls are never resent");
    }
  });
}

for (const named of [false, true]) {
  test(`native HTTP ${named ? "named" : "unnamed"} SSE quota errors preserve code and pause`, async (t) => {
    let calls = 0;
    const upstream = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `${named ? "event: error\n" : ""}data: ${JSON.stringify({ type: "error", code: "subscription_sharing_usage_limit_exceeded", message: apiKey, param: null, sequence_number: 1 })}\n\n`,
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
        upstream: "chatgpt-subscription",
        model: "test-model",
        port: 0,
        databasePath: ":memory:",
        concurrency: 2,
        minStartIntervalMs: 3000,
      },
      undefined,
      {
        localKey,
        subscription: {
          accessToken: async () => apiKey,
          status: () => ({ state: "authorized" }),
          close() {},
        },
        fetch: async (_input, init) => {
          calls++;
          return fetch(`http://127.0.0.1:${address.port}`, init);
        },
      },
    );
    t.after(() => gateway.close());
    const url = await gateway.listen();
    const first = await post(url);
    const result = (await first.json()) as any;
    assert.equal(first.status, 429);
    assert.equal(
      result.error.code,
      "subscription_sharing_usage_limit_exceeded",
    );
    assert.equal(gateway.status().queue.paused, true);
    assert.equal(gateway.records[0]!.upstreamError!.code, result.error.code);
    assert(gateway.records[0]!.terminalAt);
    assert(!JSON.stringify(gateway.report()).includes(apiKey));
    const second = await post(url);
    await second.arrayBuffer();
    assert.equal(second.status, 503);
    assert.equal(calls, 1);
  });
}

test("completed output cannot become success when transport cleanup fails", async (t) => {
  let calls = 0,
    cancelling = false,
    returned = false,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
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
      localKey,
      subscription: {
        accessToken: async () => apiKey,
        status: () => ({ state: "authorized" }),
        close() {},
      },
      fetch: async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes);
            },
            async cancel() {
              cancelling = true;
              await barrier;
              throw new Error("fake cleanup failure");
            },
          }),
        );
      },
    },
  );
  const url = await gateway.listen();
  const first = post(url).then((response) => {
    returned = true;
    return response;
  });
  t.after(async () => {
    release();
    await first;
    await gateway.close();
  });
  await until(() => cancelling);
  assert.equal(returned, false);
  assert.equal(gateway.status().queue.running, 1);
  assert.equal(gateway.records[0]!.usage!.total_tokens, 71);
  release();
  const response = await first;
  assert.equal(response.status, 502);
  await response.arrayBuffer();
  assert.equal(gateway.records[0]!.status, "unknown");
  assert.equal(gateway.records[0]!.usage!.total_tokens, 71);
  assert.equal(gateway.status().queue.paused, true);
  const next = await post(url);
  await next.arrayBuffer();
  assert.equal(next.status, 503);
  assert.equal(calls, 1);
});

test("raw usage and incomplete details are redacted while stream cleanup is still pending", async (t) => {
  for (const incomplete of [false, true]) {
    const tape = structuredClone(fixture);
    const terminal = tape.events.at(-1);
    terminal.response.usage.debug = { nested: apiKey, access_token: apiKey };
    if (incomplete) {
      terminal.type = "response.incomplete";
      terminal.response.status = "incomplete";
      terminal.response.incomplete_details = {
        reason: "max_output_tokens",
        diagnostic: apiKey,
      };
    }
    const payload = new TextEncoder().encode(
      tape.events
        .map((event: unknown) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
    let cancelling = false,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
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
        localKey,
        subscription: {
          accessToken: async () => apiKey,
          status: () => ({ state: "authorized" }),
          close() {},
        },
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(payload);
              },
              async cancel() {
                cancelling = true;
                await barrier;
              },
            }),
          ),
      },
    );
    const url = await gateway.listen();
    const first = post(url);
    t.after(async () => {
      release();
      await first;
      await gateway.close();
    });
    await until(() => cancelling);
    assert(!JSON.stringify(gateway.report()).includes(apiKey));
    assert(!JSON.stringify(gateway.records[0]).includes(apiKey));
    assert.equal(gateway.records[0]!.rawUsage!.input_tokens, 58);
    assert.equal(gateway.records[0]!.usage!.total_tokens, 71);
    if (incomplete)
      assert.equal(
        gateway.records[0]!.upstreamIncompleteDetails!.reason,
        "max_output_tokens",
      );
    release();
    assert.equal((await first).status, incomplete ? 502 : 200);
  }
});

test("Chat Completions usage is sanitized at capture without changing token accounting", () => {
  const redact = new Redactor();
  redact.add(apiKey);
  const record: LedgerRecord = {
    id: "test",
    sequence: 1,
    status: "running",
    receivedAt: new Date().toISOString(),
    requestHash: "test",
    transformations: [],
  };
  captureUsage(record, { ...answer.usage, details: apiKey }, redact, true);
  assert(!JSON.stringify(record).includes(apiKey));
  assert.equal(record.rawUsage!.total_tokens, 3);
  assert.equal(record.usage!.prompt_tokens, 2);
  assert.equal(record.usage!.completion_tokens, 1);
});

test("subscription and probe slots wait for actual SSE cancellation settlement", async (t) => {
  for (const probe of [false, true]) {
    let calls = 0,
      cancelStarted = false,
      cleaned = false,
      replacementTooEarly = false;
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send: typeof fetch = async () => {
      const n = ++calls;
      if (n > 1) replacementTooEarly = !cleaned;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            if (n > 1) c.close();
          },
          async cancel() {
            cancelStarted = true;
            await cleanup;
            cleaned = true;
          },
        }),
      );
    };
    const gateway = probe
      ? createGateway(
          { port: 0, databasePath: ":memory:", maxRequests: 2 },
          { model: "test-model", fetch: send },
        )
      : createGateway(
          {
            upstream: "chatgpt-subscription",
            model: "test-model",
            port: 0,
            minStartIntervalMs: 0,
            databasePath: ":memory:",
          },
          undefined,
          {
            localKey,
            fetch: send,
            subscription: {
              accessToken: async () => "fake",
              status: () => ({ state: "authorized" }),
              close() {},
            },
          },
        );
    t.after(async () => {
      release();
      await gateway.close();
    });
    const url = await gateway.listen();
    const first = post(url);
    const second = post(url);
    await until(() => cancelStarted);
    await delay(15);
    const premature = replacementTooEarly;
    release();
    assert.deepEqual(
      (await Promise.all([first, second])).map((r) => r.status),
      [200, 200],
    );
    assert.equal(premature, false);
    assert.equal(cleaned, true);
  }
});
test("exhausted response headers constrain dispatch before a body completes", async (t) => {
  let release!: () => void,
    calls = 0;
  const gateway = keyGateway(
    async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(c) {
            release = () => {
              c.enqueue(new TextEncoder().encode(JSON.stringify(answer)));
              c.close();
            };
          },
        }),
        {
          headers: {
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-reset-requests": "5s",
          },
        },
      );
    },
    { concurrency: 2 },
  );
  const url = await gateway.listen();
  const first = post(url);
  t.after(async () => {
    release?.();
    await first;
    await gateway.close();
  });
  await until(() => !!gateway.records[0]?.headersAt);
  assert.equal(gateway.status().dispatch?.state, "cooldown");
  assert.equal(calls, 1);
});
test("in-flight status and report never expose reflected credential headers", async (t) => {
  let release!: () => void;
  const gateway = keyGateway(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            release = () => {
              c.enqueue(new TextEncoder().encode(JSON.stringify(answer)));
              c.close();
            };
          },
        }),
        {
          headers: {
            "x-ratelimit-limit-tokens": apiKey,
            "x-request-id": apiKey,
            "retry-after": apiKey,
          },
        },
      ),
  );
  const url = await gateway.listen();
  const first = post(url);
  t.after(async () => {
    release?.();
    await first;
    await gateway.close();
  });
  await until(() => !!gateway.records[0]?.headersAt);
  assert(
    !JSON.stringify({
      status: gateway.status(),
      report: gateway.report(),
    }).includes(apiKey),
  );
});
test("dispatch retains a transport promise when abort occurs immediately after start", async () => {
  const control = new DispatchControl({
    minStartIntervalMs: 0,
    maxRequestsPerMinute: null,
  });
  const abort = new AbortController();
  let cleaned = false;
  const operation = new Promise<void>((_resolve, reject) =>
    setTimeout(() => {
      cleaned = true;
      reject(Error("late transport rejection"));
    }, 20),
  );
  // Observe this promise independently so the RED case does not leak an unhandled rejection into unrelated tests.
  void operation.catch(() => {});
  await assert.rejects(
    control.run(
      abort.signal,
      async () => undefined,
      () => {
        queueMicrotask(() => abort.abort(Error("cancelled admission")));
        return operation;
      },
    ),
    /late transport rejection/,
  );
  assert.equal(cleaned, true);
});
test("client cancellation during admission never sends or pauses the sender", async (t) => {
  let calls = 0;
  const gateway = keyGateway(
    async () => {
      calls++;
      return Response.json(answer);
    },
    { minStartIntervalMs: 100 },
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  await post(url);
  const abort = new AbortController();
  const second = post(url, "cancel", abort.signal);
  await until(() => gateway.status().queue.preparing === 1);
  abort.abort();
  await assert.rejects(second);
  await until(() => gateway.records[1]?.finishedAt !== undefined);
  assert.equal(calls, 1);
  assert.equal(gateway.records[1]!.status, "cancelled");
  assert.equal(gateway.status().queue.paused, false);
});
test("rate control overflow is reflected consistently by queue, root reason and ledger", async (t) => {
  t.mock.method(Math, "random", () => 0.5);
  const gateway = keyGateway(async () =>
    Response.json(answer, {
      headers: {
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "2147483647ms",
      },
    }),
  );
  t.after(() => gateway.close());
  const url = await gateway.listen();
  await post(url);
  assert.equal(gateway.status().dispatch?.state, "paused");
  assert.equal(gateway.status().queue.paused, true);
  assert.equal(gateway.status().pauseReason, "rate_limit_delay_unsupported");
  assert.equal(gateway.records[0]!.rateLimit?.decision.action, "pause");
});
test("latest rate observation follows header arrival rather than request arrival", async (t) => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = keyGateway(
    async (_url, init) => {
      const n = JSON.parse(String(init?.body)).messages[0].content;
      if (n === "1") await barrier;
      return Response.json(answer, {
        headers: { "x-ratelimit-limit-requests": n },
      });
    },
    { concurrency: 2 },
  );
  t.after(() => {
    release();
    return gateway.close();
  });
  const url = await gateway.listen();
  const first = post(url, "1");
  await until(() => gateway.records[0]?.inferenceDispatched === true);
  await post(url, "2");
  release();
  await first;
  assert.equal(
    gateway.status().upstreamLimits?.headers["x-ratelimit-limit-requests"],
    "1",
  );
});
test("temporary codes require matching statuses and success-only Retry-After does not throttle", () => {
  assert.equal(
    rateDecision(400, "rate_limit_exceeded", { "retry-after": "1" }, 0).action,
    "pause",
  );
  assert.equal(
    rateDecision(200, undefined, { "retry-after": "1" }, 0).action,
    "none",
  );
  assert.equal(
    rateDecision(200, "rate_limit_exceeded", { "retry-after": "1" }, 0).action,
    "cooldown",
  );
});
