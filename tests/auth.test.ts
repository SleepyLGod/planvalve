import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AuthStore,
  AuthSession,
  beginLogin,
  verifyIdentity,
} from "../src/auth.ts";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", use: "sig" }],
};
function jwt(
  nonce: string,
  sub = "test-account",
  overrides: Record<string, unknown> = {},
) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString(
    "base64url",
  );
  const p = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: "issued-test-client",
      sub,
      nonce,
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
      ...overrides,
    }),
  ).toString("base64url");
  return (
    h +
    "." +
    p +
    "." +
    sign("RSA-SHA256", Buffer.from(h + "." + p), privateKey).toString(
      "base64url",
    )
  );
}
function path() {
  mkdirSync(resolve("reports"), { recursive: true });
  return resolve(mkdtempSync(resolve("reports/auth-test-")), "auth.json");
}
function tokens(nonce: string) {
  return {
    access_token: "test-access-secret",
    refresh_token: "test-refresh-secret",
    id_token: jwt(nonce),
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
  };
}
function official(handler: (data: URLSearchParams) => unknown): typeof fetch {
  return async (url, init) => {
    assert(String(url).startsWith("https://auth.openai.com/"));
    if (String(url).endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer: "https://auth.openai.com",
        authorization_endpoint: "https://auth.openai.com/oauth/authorize",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        revocation_endpoint: "https://auth.openai.com/oauth/revoke",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
      });
    if (String(url).endsWith("/jwks.json")) return Response.json(jwks);
    return Response.json(handler(new URLSearchParams(String(init?.body))));
  };
}
async function loggedIn(file = path()) {
  const send = official(() => {
    throw Error("not yet");
  });
  const store = new AuthStore(file);
  let nonce = "";
  const login = await beginLogin(store, {
    fetch: official(() => tokens(nonce)),
  });
  nonce = new URL(login.authorizationUrl).searchParams.get("nonce")!;
  const callback = new URL(login.redirectUri);
  callback.search = new URLSearchParams({
    state: new URL(login.authorizationUrl).searchParams.get("state")!,
    code: "test-code",
    client_id: "issued-test-client",
  }).toString();
  assert.equal((await fetch(callback, { redirect: "manual" })).status, 303);
  await login.done;
  return { file, store, callback };
}
test("OAuth login is independent, verifies identity, persists private credentials, and never sends inference", async () => {
  const { file, store, callback } = await loggedIn();
  const record = store.read();
  assert.equal(record.client_id, "issued-test-client");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(resolve(file, "..")).mode & 0o777, 0o700);
  assert(!JSON.stringify(store.status()).includes("secret"));
  const session = new AuthSession(store, {
    fetch: official(() => {
      throw Error("unexpected refresh");
    }),
  });
  assert.equal(await session.accessToken(), "test-access-secret");
  session.close();
  const again = await beginLogin(store, {
    fetch: official(() => {
      throw Error("no callback expected");
    }),
  });
  assert.equal(
    new URL(again.authorizationUrl).searchParams.get("client_id"),
    "issued-test-client",
  );
  assert.equal(
    new URL(again.authorizationUrl).searchParams.get("ext_agent_host_id"),
    record.ext_agent_host_id,
  );
  again.cancel();
  await assert.rejects(again.done);
});
test("ID token signature, audience, nonce, issuer and account identity are enforced", async () => {
  assert.throws(() =>
    verifyIdentity(jwt("nonce"), "other-client", jwks, "nonce"),
  );
  assert.throws(() =>
    verifyIdentity(jwt("nonce"), "issued-test-client", jwks, "other-nonce"),
  );
  for (const overrides of [
    { iss: "https://invalid.example" },
    { exp: 0 },
    { aud: ["issued-test-client", "other"], azp: "other" },
  ]) {
    assert.throws(() =>
      verifyIdentity(
        jwt("nonce", "test-account", overrides),
        "issued-test-client",
        jwks,
        "nonce",
      ),
    );
  }
  const token = jwt("nonce");
  assert.throws(() =>
    verifyIdentity(
      token.slice(0, -4) + "AAAA",
      "issued-test-client",
      jwks,
      "nonce",
    ),
  );
  const { store } = await loggedIn();
  let nonce = "";
  const flow = await beginLogin(store, {
    fetch: official(() => ({
      ...tokens(nonce),
      id_token: jwt(nonce, "different-account"),
    })),
  });
  nonce = new URL(flow.authorizationUrl).searchParams.get("nonce")!;
  const callback = new URL(flow.redirectUri);
  callback.search = new URLSearchParams({
    state: new URL(flow.authorizationUrl).searchParams.get("state")!,
    code: "test-code",
  }).toString();
  await fetch(callback, { redirect: "manual" });
  await assert.rejects(flow.done, /identity/i);
  assert.equal(store.read().credentials!.access_token, "test-access-secret");
});
test("refresh rotates tokens once, preserves credentials on temporary failures, and rejects concurrent processes", async () => {
  const { file, store } = await loggedIn();
  const record = store.read();
  record.credentials!.expires_at = 0;
  store.save(record);
  let calls = 0;
  const session = new AuthSession(store, {
    fetch: official((data) => {
      assert.equal(data.get("grant_type"), "refresh_token");
      assert.equal(data.get("client_id"), "issued-test-client");
      assert.equal(data.get("resource"), "https://api.openai.com/v1");
      assert.equal(data.has("scope"), false);
      calls++;
      return {
        ...tokens("unused"),
        id_token: undefined,
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
      };
    }),
  });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {AuthStore,AuthSession} from './src/auth.ts';try {new AuthSession(new AuthStore(${JSON.stringify(file)}));process.exitCode=2} catch(e) {if(!String(e).includes('in use'))throw e}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(
    await Promise.all([session.accessToken(), session.accessToken()]),
    ["rotated-access", "rotated-access"],
  );
  assert.equal(calls, 1);
  assert.equal(store.read().credentials!.refresh_token, "rotated-refresh");
  session.close();
  const expired = store.read();
  expired.credentials!.expires_at = 0;
  store.save(expired);
  const before = readFileSync(file, "utf8");
  const failed = new AuthSession(store, {
    fetch: async () =>
      Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
  });
  await assert.rejects(failed.accessToken());
  assert.equal(readFileSync(file, "utf8"), before);
  failed.close();
  const revoked = new AuthSession(store, {
    fetch: async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
  });
  await assert.rejects(revoked.accessToken());
  assert.equal(store.status().state, "login-required");
  revoked.close();
});
test("callback state and replay are rejected, logout clears tokens and reports unconfirmed revocation", async () => {
  const file = path(),
    store = new AuthStore(file);
  let nonce = "";
  const flow = await beginLogin(store, {
    fetch: official(() => tokens(nonce)),
  });
  nonce = new URL(flow.authorizationUrl).searchParams.get("nonce")!;
  const url = new URL(flow.redirectUri);
  url.search = "state=wrong&code=x";
  assert.equal((await fetch(url, { redirect: "manual" })).status, 400);
  url.search = new URLSearchParams({
    state: new URL(flow.authorizationUrl).searchParams.get("state")!,
    code: "x",
    client_id: "issued-test-client",
  }).toString();
  const [a, b] = await Promise.all([
    fetch(url, { redirect: "manual" }),
    fetch(url, { redirect: "manual" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [303, 400]);
  await flow.done;
  const session = new AuthSession(store, {
    fetch: async () => new Response("", { status: 503 }),
  });
  const outcome = await session.logout();
  assert.equal(outcome.remoteRevoked, false);
  assert.equal(store.read().credentials, undefined);
  session.close();
  assert.equal(store.read().client_id, "issued-test-client");
});
test("credential storage refuses an existing shared directory instead of changing unrelated permissions", async () => {
  const { chmodSync } = await import("node:fs");
  const file = path(),
    directory = resolve(file, "..");
  chmodSync(directory, 0o755);
  const store = new AuthStore(file);
  assert.throws(() => store.save(store.read()), /private|0700/i);
  assert.equal(statSync(directory).mode & 0o777, 0o755);
});
test("denied consent and missing plan scopes never create usable credentials or inference", async () => {
  for (const denied of [true, false]) {
    const store = new AuthStore(path());
    let nonce = "";
    const flow = await beginLogin(store, {
      fetch: official(() => ({
        ...tokens(nonce),
        scope: "openid offline_access",
      })),
    });
    nonce = new URL(flow.authorizationUrl).searchParams.get("nonce")!;
    const callback = new URL(flow.redirectUri);
    callback.search = new URLSearchParams({
      state: new URL(flow.authorizationUrl).searchParams.get("state")!,
      ...(denied
        ? { error: "access_denied" }
        : { code: "x", client_id: "issued-test-client" }),
    }).toString();
    await fetch(callback, { redirect: "manual" });
    await assert.rejects(flow.done);
    assert.equal(store.status().state, "login-required");
  }
});
test("logout confirms empty-200 revocation and retains only registration metadata", async () => {
  const { store } = await loggedIn();
  let revoked = false;
  const session = new AuthSession(store, {
    fetch: async (url, init) => {
      if (String(url).endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/oauth/authorize",
          token_endpoint: "https://auth.openai.com/oauth/token",
          jwks_uri: "https://auth.openai.com/jwks.json",
          revocation_endpoint: "https://auth.openai.com/oauth/revoke",
        });
      const form = new URLSearchParams(String(init!.body));
      assert.equal(form.get("token"), "test-refresh-secret");
      assert.equal(form.get("client_id"), "issued-test-client");
      revoked = true;
      return new Response("", { status: 200 });
    },
  });
  assert.deepEqual(await session.logout(), { remoteRevoked: true });
  assert(revoked);
  assert.equal(store.status().state, "login-required");
  session.close();
});
test("request cancellation aborts token renewal and preserves stored credentials", async () => {
  const { store } = await loggedIn();
  const record = store.read();
  record.credentials!.expires_at = 0;
  store.save(record);
  const before = readFileSync(store.path, "utf8");
  let cancelled = false;
  const session = new AuthSession(store, {
    fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(init!.signal!.reason);
          },
          { once: true },
        );
      }),
  });
  try {
    await assert.rejects(session.accessToken(AbortSignal.timeout(20)));
    assert(cancelled);
    assert.equal(readFileSync(store.path, "utf8"), before);
  } finally {
    session.close();
  }
});
