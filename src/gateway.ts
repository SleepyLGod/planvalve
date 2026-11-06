import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import {
  officialUpstream,
  responsesText,
  type CredentialSource,
} from "./upstream.ts";
import { Redactor } from "./privacy.ts";
import { History } from "./history.ts";
import { summarizeUsage } from "./usage.ts";
import type { StatusSnapshot } from "./types.ts";
import { isolatedSDK } from "./sdk.ts";
import { validateConfig } from "./config.ts";
import { translate, normalizeUsage, object } from "./compatibility.ts";
import { MockTransport, type MockOptions } from "./mock.ts";
import { Queue } from "./queue.ts";
import {
  GatewayError,
  type Config,
  type Fixture,
  type LedgerRecord,
  type ObjectValue,
} from "./types.ts";
export type { Fixture } from "./types.ts";
export function createGateway(
  options: Partial<Config> & MockOptions & { fixture?: Fixture } = {},
  probe?: { model: string; fetch: typeof globalThis.fetch },
  runtime: {
    fetch?: typeof fetch;
    apiKey?: string;
    localKey?: string;
    subscription?: CredentialSource;
  } = {},
) {
  const { fixture, chunkSize, contentType, mockDelayMs, ...configuration } =
    options;
  const config = validateConfig(configuration);
  if (probe && (config.maxRequests === null || config.maxRequests > 2))
    throw new Error("A live probe requires maxRequests of 1 or 2");
  if (probe && config.upstream !== "offline")
    throw new Error("Probe cannot select a persistent upstream");
  const real = config.upstream !== "offline";
  const redact = new Redactor();
  const localKey = real
    ? (runtime.localKey ?? process.env.GATEWAY_LOCAL_API_KEY)
    : undefined;
  if (
    real &&
    (!localKey ||
      localKey.length < 16 ||
      /[\s\u0000-\u001f\u007f]/.test(localKey))
  )
    throw new Error(
      "Set GATEWAY_LOCAL_API_KEY to a private value of at least 16 characters",
    );
  redact.add(localKey);
  const apiKey =
    config.upstream === "openai-api-key"
      ? (runtime.apiKey ?? process.env.OPENAI_API_KEY)
      : undefined;
  if (config.upstream === "openai-api-key" && !apiKey)
    throw new Error("Set OPENAI_API_KEY explicitly");
  redact.add(apiKey);
  if (config.upstream === "chatgpt-subscription" && !runtime.subscription)
    throw new Error("Initialize subscription authorization before serving");
  const credential: CredentialSource | undefined =
    config.upstream === "openai-api-key"
      ? {
          accessToken: async () => apiKey!,
          status: () => ({ state: "configured" }),
          close() {},
        }
      : runtime.subscription;
  const upstream = real
    ? officialUpstream(
        config.upstream as "openai-api-key" | "chatgpt-subscription",
        credential!,
        runtime.fetch ?? globalThis.fetch,
        redact,
      )
    : undefined;
  const mode = probe
    ? ("subscription-probe" as const)
    : real
      ? (config.upstream as "chatgpt-subscription" | "openai-api-key")
      : ("offline-only" as const);
  const model = probe?.model ?? config.model ?? "offline-model";
  const tape: Fixture =
    fixture ??
    (real
      ? { events: [] }
      : JSON.parse(readFileSync(config.fixturePath, "utf8")));
  if (!Array.isArray(tape.events))
    throw new Error("Fixture must contain parsed events");
  const mock = new MockTransport(tape, { chunkSize, contentType, mockDelayMs });
  // The default transport is a fixture. A capped probe supplies its own explicit fetch; host credentials are never read.
  const client = real ? undefined : isolatedSDK(probe?.fetch ?? mock.fetch);
  const queue = new Queue(
    config.queueCapacity,
    config.maxQueueWaitMs,
    config.minStartIntervalMs,
  );
  const records: LedgerRecord[] = [];
  let attempts = 0;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const history = new History(config.databasePath);
  try {
    history.start(runId, startedAt, {
      mode,
      model,
      profile: config.profile,
    });
  } catch (error) {
    history.close();
    throw error;
  }
  let storageError: string | undefined;
  let pauseReason: string | undefined;
  const persist = (record: LedgerRecord) => {
    try {
      Object.assign(record, redact.value(record));
      history.save(runId, record);
    } catch {
      storageError = "SQLite write failed";
      pauseReason = "storage_unavailable";
      queue.pause();
      throw new GatewayError(
        503,
        "storage_unavailable",
        "SQLite write failed; sender paused",
      );
    }
    server.emit("ledgerChanged");
  };
  const status = (): StatusSnapshot => {
    const usage = summarizeUsage(records);
    const budget = (used: number, limit: number | null) => ({
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
    });
    return {
      mode,
      upstream: config.upstream,
      authorization: credential?.status() ?? {
        state: probe ? "memory-only-probe" : "not-required",
      },
      pauseReason,
      accountBalance: "unknown",
      actualCost: "unknown",
      asOf: new Date().toISOString(),
      runId,
      startedAt,
      queue: {
        concurrency: 1,
        running: records.filter((r) => r.status === "running").length,
        waiting: records.filter((r) => r.status === "queued").length,
        capacity: config.queueCapacity,
        paused: queue.paused,
        closed: queue.closed,
        minStartIntervalMs: config.minStartIntervalMs,
        maxQueueWaitMs: config.maxQueueWaitMs,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
      },
      budget: {
        requests: budget(attempts, config.maxRequests),
        tokens: budget(usage.totalTokens, config.stopAfterTokens),
      },
      usage,
      storage: {
        healthy: !storageError,
        path: config.databasePath,
        ...(storageError ? { error: storageError } : {}),
      },
    };
  };
  const report = () => ({
    mode,
    transport: probe
      ? "official-responses-probe"
      : real
        ? config.upstream
        : "in-process-fixture",
    realApiSupported: !!probe || real,
    paused: queue.paused,
    pauseReason,
    mockAttempts: probe || real ? 0 : attempts,
    realAttempts: probe || real ? attempts : 0,
    upstreamMaxActive: probe || real ? undefined : mock.maxActive,
    runId,
    totals: summarizeUsage(records),
    records,
  });
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("x-should-retry", "false");
    const reply = (status: number, value: unknown) => {
      if (!res.destroyed) {
        res.writeHead(status);
        res.end(JSON.stringify(value));
      }
    };
    let endpoint: URL;
    try {
      endpoint = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      reply(400, {
        error: { code: "invalid_target", message: "Invalid request target" },
      });
      return;
    }
    if (real) {
      const expectedHost = `127.0.0.1:${(server.address() as { port: number } | null)?.port}`;
      if (
        req.headers.host !== expectedHost ||
        (req.headers.origin !== undefined &&
          req.headers.origin !== `http://${expectedHost}`)
      ) {
        reply(403, {
          error: {
            code: "invalid_origin",
            message: "Only the local gateway origin is accepted",
          },
        });
        return;
      }
      if (endpoint.pathname !== "/healthz") {
        const actual = Buffer.from(req.headers.authorization ?? "");
        const expected = Buffer.from("Bearer " + localKey);
        if (
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) {
          reply(401, {
            error: {
              code: "invalid_local_key",
              message: "Local gateway authorization required",
            },
          });
          return;
        }
      }
    }
    if (endpoint.pathname.startsWith("/_gateway/") && req.method === "GET") {
      res.setHeader("cache-control", "no-store");
      try {
        if (endpoint.pathname === "/_gateway/status") reply(200, status());
        else if (endpoint.pathname === "/_gateway/requests") {
          const query = endpoint.searchParams;
          for (const key of query.keys())
            if (!["run_id", "before", "limit"].includes(key))
              throw new GatewayError(
                400,
                "invalid_query",
                "Unknown query parameter",
              );
          const integer = (name: string, defaultValue?: number) => {
            const raw = query.get(name);
            if (raw === null) return defaultValue;
            if (
              !/^[1-9][0-9]*$/.test(raw) ||
              !Number.isSafeInteger(Number(raw))
            )
              throw new GatewayError(400, "invalid_query", "Invalid " + name);
            return Number(raw);
          };
          const limit = integer("limit", 50)!;
          if (limit > 200)
            throw new GatewayError(
              400,
              "invalid_query",
              "limit must be at most 200",
            );
          reply(
            200,
            history.list(runId, {
              limit,
              before: integer("before"),
              runId: query.get("run_id") ?? undefined,
            }),
          );
        } else if (endpoint.pathname.startsWith("/_gateway/requests/")) {
          const record = history.get(
            runId,
            decodeURIComponent(
              endpoint.pathname.slice("/_gateway/requests/".length),
            ),
          );
          if (!record)
            throw new GatewayError(404, "not_found", "Request not found");
          reply(200, record);
        } else
          throw new GatewayError(404, "not_found", "Route not implemented");
      } catch (error) {
        const e =
          error instanceof GatewayError
            ? error
            : new GatewayError(
                503,
                "storage_unavailable",
                "History query failed",
              );
        reply(e.status, { error: { code: e.code, message: e.message } });
      }
      return;
    }
    if (req.url === "/healthz" && req.method === "GET") {
      reply(200, { status: "ok", mode });
      return;
    }
    if (req.url === "/v1/models" && req.method === "GET") {
      reply(200, {
        object: "list",
        data: [
          {
            id: model,
            object: "model",
            owned_by: real
              ? config.upstream
              : probe
                ? "chatgpt-subscription"
                : "local-fixture",
          },
        ],
      });
      return;
    }
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      reply(404, {
        error: { code: "not_found", message: "Route not implemented" },
      });
      return;
    }
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    let record: LedgerRecord | undefined;
    try {
      if (storageError)
        throw new GatewayError(
          503,
          "storage_unavailable",
          "SQLite unavailable; sender paused",
        );
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 1048576)
          throw new GatewayError(
            413,
            "body_too_large",
            "Request body exceeds 1 MiB",
          );
        chunks.push(chunk);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new GatewayError(
          400,
          "invalid_json",
          "Request is not valid JSON",
        );
      }
      const translated = translate(
        body,
        config.profile,
        model,
        config.upstream === "openai-api-key" ? "chat" : "responses",
      );
      record = {
        id: randomUUID(),
        sequence: records.length + 1,
        status: "queued",
        inferenceDispatched: false,
        receivedAt: new Date().toISOString(),
        requestHash: createHash("sha256")
          .update(JSON.stringify(body))
          .digest("hex"),
        transformations: translated.transformations,
        model,
        outputFormat:
          object(body) && object(body.response_format)
            ? String(body.response_format.type)
            : "text",
      };
      records.push(record);
      persist(record);
      const current = record;
      const result = await queue.submit(async () => {
        if (
          (config.maxRequests !== null && attempts >= config.maxRequests) ||
          (config.stopAfterTokens !== null &&
            report().totals.totalTokens >= config.stopAfterTokens)
        )
          throw new GatewayError(
            429,
            "budget_exhausted",
            "Request or observed-token budget exhausted",
          );
        current.status = "running";
        current.startedAt = new Date().toISOString();
        try {
          persist(current);
        } catch (error) {
          current.status = "rejected";
          current.startedAt = undefined;
          throw error;
        }
        if (!upstream) {
          attempts++;
          current.dispatchedAt = new Date().toISOString();
          current.inferenceDispatched = true;
        }
        const signal = AbortSignal.timeout(config.upstreamTimeoutMs);
        try {
          const text = upstream
            ? await upstream.complete(
                translated.payload,
                signal,
                current,
                () => {
                  persist(current);
                  attempts++;
                  queue.lastStart = Date.now();
                },
              )
            : await responsesText(client!, translated.payload, signal, current);
          translated.validateText(text);
          current.status = "completed";
          current.endReason = "completed";
          return {
            id: "chatcmpl-" + current.id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: current.usage,
          };
        } catch (error) {
          current.endReason = signal.aborted
            ? "timeout"
            : error instanceof GatewayError
              ? error.code
              : "stream_interrupted";
          pauseReason = current.endReason;
          queue.pause();
          current.status =
            current.inferenceDispatched === false
              ? "failed"
              : signal.aborted ||
                  !(error instanceof GatewayError) ||
                  error.code === "stream_interrupted"
                ? "unknown"
                : "failed";
          throw error instanceof GatewayError
            ? error
            : new GatewayError(
                502,
                "stream_interrupted",
                signal.aborted
                  ? "Absolute upstream deadline exceeded"
                  : "Upstream stream failed",
              );
        } finally {
          current.finishedAt = new Date().toISOString();
          persist(current);
        }
      }, abort.signal);
      reply(200, result);
    } catch (error) {
      if (!req.complete) req.resume();
      const e =
        error instanceof GatewayError
          ? error
          : new GatewayError(500, "internal_error", "Local gateway error");
      if (record) {
        record.error = e.code;
        record.finishedAt ??= new Date().toISOString();
        if (record.status === "queued")
          record.status =
            e.code === "cancelled"
              ? "cancelled"
              : e.code === "queue_expired"
                ? "expired"
                : "rejected";
      }
      if (record && !storageError) {
        try {
          persist(record);
        } catch {
          reply(503, {
            error: {
              code: "storage_unavailable",
              message: "SQLite write failed; sender paused",
            },
          });
          return;
        }
      }
      if (storageError && record) {
        record.error = "storage_unavailable";
        if (record.status === "completed") record.status = "unknown";
      }
      if (
        record?.upstreamHttp?.retryAfter &&
        /^[\x20-\x7e]{1,200}$/.test(record.upstreamHttp.retryAfter)
      )
        res.setHeader("retry-after", record.upstreamHttp.retryAfter);
      reply(e.status, {
        error: {
          type: "gateway_error",
          code: e.code,
          message: e.message,
          ...(record ? { request_id: record.id } : {}),
        },
      });
    }
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    records,
    mock,
    report,
    status,
    listen: () =>
      new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Invalid listen address"));
            return;
          }
          resolve(`http://127.0.0.1:${address.port}`);
        });
      }),
    close: () =>
      (closing ??= (async () => {
        await queue.close();
        try {
          if (server.listening)
            await new Promise<void>((resolve, reject) => {
              server.close((e) => (e ? reject(e) : resolve()));
              server.closeIdleConnections();
            });
          if (!storageError) history.finish(runId);
        } finally {
          history.close();
          credential?.close();
        }
      })()),
  };
}
