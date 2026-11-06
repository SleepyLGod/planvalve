import { beginLogin, type AuthRecord } from "../src/auth.ts";
/** Independent interactive authorization; two serial requests at most; credentials never written. */
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { createGateway } from "../src/gateway.ts";
import { subscriptionFetch } from "../src/probe-transport.ts";
import { render, initialView } from "../src/view.ts";
import { readMonitor } from "../src/monitor.ts";
process.umask(0o077);
const root = fileURLToPath(new URL("..", import.meta.url));
const folder = resolve(
  root,
  "reports",
  "subscription-probe-" + new Date().toISOString().replace(/[:.]/g, "-"),
);
mkdirSync(folder, { recursive: true });
mkdirSync(resolve(root, "data"), { recursive: true });
const registrationPath = resolve(
  root,
  "data",
  "subscription-probe-registration.json",
);
const registration: {
  ext_agent_host_id: string;
  client_id?: string;
  identity_hash?: string;
} = existsSync(registrationPath)
  ? JSON.parse(readFileSync(registrationPath, "utf8"))
  : { ext_agent_host_id: "urn:uuid:" + randomUUID() };
const saveRegistration = () =>
  writeFileSync(
    registrationPath,
    JSON.stringify(registration, null, 2) + "\n",
    { mode: 0o600 },
  );
saveRegistration();
const api = "https://api.openai.com";
const secrets = new Set<string>();
let authRecord: AuthRecord = {
  version: 1,
  ext_agent_host_id: registration.ext_agent_host_id,
  client_id: registration.client_id,
};
let login: Awaited<ReturnType<typeof beginLogin>> | undefined;
const sessionAbort = new AbortController();
let finished = false,
  attempts = 0,
  phase = "preparing";
let gateway: ReturnType<typeof createGateway> | undefined;
let server: http.Server | undefined;
let credentials: { access_token: string } | undefined;
const cases: Record<string, unknown>[] = [],
  upstream: Record<string, unknown>[] = [];
function safe(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets)
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[REDACTED_JWT]",
  );
}
function save(name: string, value: unknown, exclusive = false): void {
  writeFileSync(resolve(folder, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: exclusive ? "wx" : "w",
  });
}
function status(next: string): void {
  phase = next;
  const data = {
    phase,
    inferenceAttempts: attempts,
    maximumInferenceAttempts: 2,
    automaticRetries: 0,
  };
  save("status.json", data);
  console.log(JSON.stringify(data));
}
async function finish(outcome: string, detail?: unknown): Promise<void> {
  if (finished) return;
  finished = true;
  sessionAbort.abort();
  login?.cancel();
  authRecord.credentials = undefined;
  const report = gateway?.report();
  if (gateway)
    await gateway
      .close()
      .catch((error) =>
        console.error("Probe shutdown failed:", safe(String(error))),
      );
  save("result.json", {
    outcome,
    detail: detail === undefined ? undefined : JSON.parse(safe(detail)),
    inferenceAttempts: attempts,
    maximumInferenceAttempts: 2,
    automaticRetries: 0,
    endpoint: api + "/v1/responses",
    credentialsPersisted: false,
    codexCredentialsRead: false,
    codexConfigurationModified: false,
    platformApiKeyUsed: false,
    cases,
    upstream,
    gateway: report,
  });
  credentials = undefined;
  secrets.clear();
  status(outcome);
  console.log(JSON.stringify({ resultFile: resolve(folder, "result.json") }));
  setTimeout(() => server?.close(), 1500).unref();
}
async function json(url: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.any([sessionAbort.signal, AbortSignal.timeout(20000)]),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${safe(text).slice(0, 2000)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw Error("Malformed official JSON response");
  }
}
function page(
  res: http.ServerResponse,
  message: string,
  statusCode = 200,
): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(
    '<!doctype html><html lang="zh"><meta charset="utf-8"><title>ChatGPT Plan Gateway · 独立测试</title><body style="max-width:720px;margin:60px auto;padding:24px;font:18px/1.7 system-ui"><h1>网关真实小测试</h1>' +
      message +
      "</body></html>",
  );
}
async function complete(
  url: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL("/v1/chat/completions", url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(125000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}
async function run(): Promise<void> {
  if (finished) return;
  status("discovering_authorized_models");
  const catalog = await json(api + "/v1/models", {
    headers: { Authorization: "Bearer " + credentials!.access_token },
  });
  if (finished) return;
  const entries = Array.isArray(catalog.models)
    ? catalog.models
    : Array.isArray(catalog.data)
      ? catalog.data
      : [];
  const models = entries
    .filter((x: any) => !x.visibility || x.visibility === "list")
    .map((x: any) => x.slug ?? x.id)
    .filter(
      (id: any) =>
        typeof id === "string" &&
        /^(gpt|o[0-9])/i.test(id) &&
        !/image|audio|realtime|embedding|moderation|search|pro($|-)/i.test(id),
    ) as string[];
  const model =
    models.find((x) => x === "gpt-6-luna") ??
    models.find((x) => /nano|mini|luna/i.test(x)) ??
    models[0];
  if (!model) throw Error("No suitable model in selected account");
  const live = subscriptionFetch(
    credentials!.access_token,
    (attempt, body) => {
      if (finished) throw Error("Probe ended; model request blocked");
      save(
        "inference-attempt-" + attempt + ".json",
        {
          attempt,
          maximumInferenceAttempts: 2,
          model,
          requestSha256: createHash("sha256").update(body).digest("hex"),
        },
        true,
      );
      attempts = attempt;
      status("sending_model_request_" + attempt);
    },
    async (attempt, response) => {
      const metadata: Record<string, unknown> = {
        attempt,
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        contentType: response.headers.get("content-type"),
      };
      upstream.push(metadata);
      if (!response.ok) {
        try {
          metadata.serverError = safe(await response.clone().text()).slice(
            0,
            8000,
          );
        } catch {
          metadata.serverError = "Error body could not be read";
        }
      }
    },
  );
  gateway = createGateway(
    {
      port: 0,
      databasePath: resolve(folder, "history.sqlite"),
      maxRequests: 2,
      stopAfterTokens: 3000,
      minStartIntervalMs: 3000,
      upstreamTimeoutMs: 90000,
    },
    { model, fetch: live },
  );
  const url = await gateway.listen();
  console.log(
    JSON.stringify({ gatewayUrl: url, model, mode: "subscription-probe" }),
  );
  const requests = [
    {
      name: "text",
      request: {
        model,
        messages: [{ role: "user", content: "Reply exactly: OK" }],
      },
    },
    {
      name: "json_schema",
      request: {
        model,
        messages: [
          { role: "user", content: "What is 1+1? Return JSON with answer." },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer",
            strict: true,
            schema: {
              type: "object",
              properties: { answer: { type: "integer", enum: [2] } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      },
    },
  ];
  for (const item of requests) {
    if (finished) return;
    const response = await complete(url, item.request);
    const content = response.body.choices?.[0]?.message?.content;
    const passed =
      response.status === 200 &&
      (item.name === "text"
        ? String(content).trim() === "OK"
        : JSON.stringify(JSON.parse(content)) === '{"answer":2}');
    cases.push({
      name: item.name,
      httpStatus: response.status,
      output: content,
      usage: response.body.usage,
      error: response.body.error,
      passed,
    });
    const data = await readMonitor(url, "current");
    for (const lang of ["zh", "en"] as const)
      writeFileSync(
        resolve(folder, "status-" + lang + ".txt"),
        render(data, initialView(), { width: 109, color: false, lang }) + "\n",
        { mode: 0o600 },
      );
    save("gateway.json", gateway.report());
    if (!passed) {
      await finish("stopped_after_failure");
      return;
    }
  }
  await finish("completed");
}
async function main(): Promise<void> {
  login = await beginLogin({
    read: () => structuredClone(authRecord),
    save: (record) => {
      if (record.subject) {
        const hash = createHash("sha256").update(record.subject).digest("hex");
        if (registration.identity_hash && registration.identity_hash !== hash)
          throw new Error(
            "Selected identity differs from this test registration",
          );
        registration.identity_hash = hash;
      }
      registration.client_id = record.client_id;
      saveRegistration();
      authRecord = structuredClone(record); // Full tokens stay in memory only.
    },
    acquire: () => () => {},
  });
  server = http.createServer((req, res) => {
    const target = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET") {
      page(res, "<p>Method not allowed.</p>", 405);
      return;
    }
    if (target.pathname === "/") {
      page(
        res,
        '<p>Use your own ChatGPT plan for at most two serial requests: text, then JSON. No retries. Credentials remain in memory.</p><p><a href="/begin">Continue with ChatGPT</a></p>',
      );
      return;
    }
    if (target.pathname === "/begin" && !finished) {
      res.writeHead(302, {
        location: login!.authorizationUrl,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end();
      return;
    }
    if (target.pathname === "/status") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ phase, inferenceAttempts: attempts }));
      return;
    }
    page(res, "<p>Not found.</p>", 404);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  status("ready_for_login");
  console.log(
    JSON.stringify({
      loginPage: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
      resultDirectory: folder,
    }),
  );
  const cancel = () => {
    void finish("authorization_cancelled");
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  void login.done
    .then(async () => {
      if (finished) return;
      const tokens = authRecord.credentials!;
      for (const token of [
        tokens.access_token,
        tokens.refresh_token,
        tokens.id_token,
      ])
        secrets.add(token);
      credentials = { access_token: tokens.access_token };
      await run();
    })
    .catch(async (error) => {
      if (!finished)
        await finish("probe_failed", {
          message: safe(error instanceof Error ? error.message : String(error)),
        });
    });
}
main().catch(async (error) => {
  await finish("setup_failed", {
    message: safe(error instanceof Error ? error.message : String(error)),
  });
  process.exitCode = 1;
});
