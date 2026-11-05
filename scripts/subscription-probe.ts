/** Independent interactive authorization; two serial requests at most; credentials never written. */
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  randomBytes,
  randomUUID,
  createHash,
  createPublicKey,
  verify,
  timingSafeEqual,
} from "node:crypto";
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
const auth = "https://auth.openai.com",
  api = "https://api.openai.com";
const state = randomBytes(32).toString("base64url"),
  nonce = randomBytes(32).toString("base64url"),
  verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const secrets = new Set([state, nonce, verifier]);
const sessionAbort = new AbortController();
let finished = false,
  begun = false,
  callbackUsed = false,
  attempts = 0,
  phase = "preparing";
let gateway: ReturnType<typeof createGateway> | undefined;
let server: http.Server | undefined;
let credentials: { access_token: string } | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
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
  clearTimeout(expiry);
  sessionAbort.abort();
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
function identity(token: string, clientId: string, jwks: any): any {
  const parts = token.split(".");
  if (parts.length !== 3) throw Error("Invalid identity token");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()),
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  if (header.alg !== "RS256")
    throw Error("Unsupported identity signing algorithm");
  const jwk = jwks.keys.find(
    (key: any) =>
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (!key.use || key.use === "sig"),
  );
  if (
    !jwk ||
    !verify(
      "RSA-SHA256",
      Buffer.from(parts[0] + "." + parts[1]),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2]!, "base64url"),
    )
  )
    throw Error("Invalid identity signature");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud],
    now = Date.now() / 1000;
  const actual = Buffer.from(
      typeof claims.nonce === "string" ? claims.nonce : "",
    ),
    expected = Buffer.from(nonce);
  if (
    claims.iss !== auth ||
    !audiences.includes(clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now - 60 ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    (audiences.length > 1 && claims.azp !== clientId)
  )
    throw Error("Identity issuer, audience, lifetime or nonce mismatch");
  return claims;
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
  const config = await json(auth + "/.well-known/openid-configuration");
  if (
    config.issuer !== auth ||
    new URL(config.jwks_uri).origin !== auth ||
    config.authorization_endpoint !== auth + "/api/accounts/authorize" ||
    config.token_endpoint !== auth + "/api/accounts/oauth/token"
  )
    throw Error("Unexpected official authorization metadata");
  const jwks = await json(config.jwks_uri);
  let redirectUri = "",
    oauthUrl = "";
  server = http.createServer(async (req, res) => {
    const host = "127.0.0.1:" + (server!.address() as { port: number }).port;
    if (req.headers.host !== host) {
      page(res, "<p>Invalid host.</p>", 400);
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://" + host);
    } catch {
      page(res, "<p>Invalid URL.</p>", 400);
      return;
    }
    if (req.method !== "GET") {
      page(res, "<p>Method not allowed.</p>", 405);
      return;
    }
    if (url.pathname === "/") {
      page(
        res,
        '<p>使用你选择的 ChatGPT 账号订阅额度，通过本地网关顺序发送最多两次最小请求：一次文本、一次 JSON。</p><p>失败不重试；不读写日常 Codex 配置；凭证只留在当前进程。</p><p>请确认选择当前 ChatGPT 账号，并在官方页面允许订阅额度使用。</p><p><a href="/begin">Continue with ChatGPT</a></p>',
      );
      return;
    }
    if (url.pathname === "/status") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ phase, inferenceAttempts: attempts }));
      return;
    }
    if (url.pathname === "/begin") {
      if (begun || finished) {
        page(res, "<p>授权已开始或本次测试已结束。</p>", 409);
        return;
      }
      begun = true;
      status("waiting_for_user_login");
      res.writeHead(302, {
        location: oauthUrl,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end();
      return;
    }
    if (url.pathname === "/result") {
      page(res, "<p>授权回调已收到，测试将自动继续。请返回聊天查看结果。</p>");
      return;
    }
    if (url.pathname !== "/auth/callback") {
      page(res, "<p>Not found.</p>", 404);
      return;
    }
    const actual = Buffer.from(url.searchParams.get("state") ?? ""),
      expected = Buffer.from(state);
    if (
      !begun ||
      finished ||
      callbackUsed ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      page(res, "<p>无效授权状态。</p>", 400);
      return;
    }
    callbackUsed = true;
    clearTimeout(expiry);
    res.writeHead(303, {
      location: "/result",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end();
    try {
      if (url.searchParams.has("error")) {
        await finish("authorization_declined_or_unavailable");
        return;
      }
      const code = url.searchParams.get("code"),
        callbackId = url.searchParams.get("client_id"),
        clientId = registration.client_id ?? callbackId;
      if (
        !code ||
        !clientId ||
        clientId === "dynamic_agent_client" ||
        (registration.client_id &&
          callbackId &&
          registration.client_id !== callbackId)
      )
        throw Error(
          "Issued client ID or authorization code missing/mismatched",
        );
      registration.client_id = clientId;
      saveRegistration();
      secrets.add(code);
      status("validating_independent_authorization");
      const result = await json(config.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: api + "/v1",
        }),
      });
      if (finished) return;
      for (const key of ["access_token", "refresh_token", "id_token"])
        if (typeof result[key] === "string") secrets.add(result[key]);
      if (
        typeof result.access_token !== "string" ||
        typeof result.id_token !== "string" ||
        result.token_type?.toLowerCase() !== "bearer"
      )
        throw Error("Authorization lacks verifiable token set");
      const claims = identity(result.id_token, clientId, jwks),
        hash = createHash("sha256").update(claims.sub).digest("hex");
      if (registration.identity_hash && hash !== registration.identity_hash)
        throw Error("Selected account differs from this test registration");
      registration.identity_hash = hash;
      saveRegistration();
      const scopes =
        typeof result.scope === "string" ? result.scope.split(/\s+/) : [];
      if (
        !scopes.includes("chatgpt.tokens.use.direct") ||
        !scopes.includes("resource.invoke")
      ) {
        await finish("subscription_permission_not_granted");
        return;
      }
      credentials = { access_token: result.access_token };
      await run();
    } catch (error) {
      await finish("probe_error", {
        message: safe(error instanceof Error ? error.message : String(error)),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  redirectUri =
    "http://127.0.0.1:" +
    (server.address() as { port: number }).port +
    "/auth/callback";
  const query = new URLSearchParams({
    client_id: registration.client_id ?? "dynamic_agent_client",
    ext_agent_host_id: registration.ext_agent_host_id,
    response_type: "code",
    redirect_uri: redirectUri,
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: api + "/v1",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  if (!registration.client_id)
    query.set("agent_name_hint", "ChatGPT Plan Gateway");
  oauthUrl = config.authorization_endpoint + "?" + query;
  status("ready_for_login");
  console.log(
    JSON.stringify({
      loginPage: redirectUri.replace("/auth/callback", "/"),
      resultDirectory: folder,
    }),
  );
  expiry = setTimeout(
    () => void finish("authorization_timed_out"),
    30 * 60 * 1000,
  );
  expiry.unref();
}
main().catch(async (error) => {
  await finish("setup_failed", {
    message: safe(error instanceof Error ? error.message : String(error)),
  });
  process.exitCode = 1;
});
