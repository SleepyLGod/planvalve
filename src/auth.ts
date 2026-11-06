import http from "node:http";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CredentialSource } from "./upstream.ts";
const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const requiredScopes = ["resource.invoke", "chatgpt.tokens.use.direct"];
interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_at: number;
  scopes: string[];
}
export interface AuthRecord {
  version: 1;
  ext_agent_host_id: string;
  client_id?: string;
  subject?: string;
  credentials?: Tokens;
}
/** Only this tool's private file is read. A SQLite transaction supplies an OS-released process lock. */
export class AuthStore {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private prepare(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("Authorization directory must not be a symlink");
    if (lstatSync(directory).mode & 0o077)
      throw new Error(
        "Authorization requires a private 0700 directory; choose a dedicated subdirectory",
      );
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink())
      throw new Error("Authorization file must not be a symlink");
  }
  read(): AuthRecord {
    if (!existsSync(this.path))
      return { version: 1, ext_agent_host_id: "urn:uuid:" + randomUUID() };
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.mode & 0o077)
      throw new Error("Authorization file requires owner-only permissions");
    let record: AuthRecord;
    try {
      record = JSON.parse(readFileSync(this.path, "utf8")) as AuthRecord;
    } catch {
      throw new Error("Invalid authorization record");
    }
    if (
      record.version !== 1 ||
      typeof record.ext_agent_host_id !== "string" ||
      !record.ext_agent_host_id
    )
      throw new Error("Invalid authorization record");
    if (
      record.credentials &&
      (!record.client_id || !record.subject || !validTokens(record.credentials))
    )
      throw new Error("Invalid stored credentials");
    return record;
  }
  save(record: AuthRecord): void {
    this.prepare();
    const temporary = this.path + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }
  acquire(): () => void {
    this.prepare();
    const path = this.path + ".lock.sqlite";
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Authorization lock must not be a symlink");
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      chmodSync(path, 0o600);
      db.exec("BEGIN EXCLUSIVE");
    } catch {
      db.close();
      throw new Error(
        "Subscription authorization is in use by another process; stop it before login/logout",
      );
    }
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    };
  }
  status(): { state: string } {
    const record = this.read();
    return {
      state: !record.credentials
        ? "login-required"
        : record.credentials.expires_at <= Date.now()
          ? "refresh-required"
          : "authorized",
    };
  }
}
function validTokens(value: Tokens): boolean {
  return (
    [value.access_token, value.refresh_token, value.id_token].every(
      (v) => typeof v === "string" && !!v,
    ) &&
    Number.isFinite(value.expires_at) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((s) => typeof s === "string")
  );
}
/** Validate the signed identity, never treating an unverified payload as account identity. */
export function verifyIdentity(
  token: string,
  clientId: string,
  jwks: any,
  nonce?: string,
): { sub: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid identity token");
  let header: any, claims: any;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  } catch {
    throw new Error("Invalid identity token encoding");
  }
  if (header.alg !== "RS256")
    throw new Error("Unsupported identity signing algorithm");
  const jwk = jwks.keys?.find(
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
    throw new Error("Invalid identity signature");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud],
    now = Date.now() / 1000;
  if (
    claims.iss !== issuer ||
    !audiences.includes(clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    (audiences.length > 1 && claims.azp !== clientId)
  )
    throw new Error("Identity issuer, audience or lifetime mismatch");
  if (nonce !== undefined) {
    const actual = Buffer.from(
        typeof claims.nonce === "string" ? claims.nonce : "",
      ),
      expected = Buffer.from(nonce);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Identity nonce mismatch");
  }
  return { sub: claims.sub };
}
class OAuthError extends Error {
  code: string;
  constructor(code: string) {
    super("OAuth request failed: " + code);
    this.code = code;
  }
}
interface AuthOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
async function json(
  url: string,
  init: RequestInit,
  options: AuthOptions,
): Promise<any> {
  const target = new URL(url);
  if (target.origin !== issuer || target.username || target.password)
    throw new Error("Unexpected authorization destination");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000);
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    ...init,
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    let code = "http_" + response.status;
    try {
      const body = (await response.json()) as any;
      const candidate =
        typeof body.error === "string" ? body.error : body.error?.code;
      if (
        typeof candidate === "string" &&
        /^[a-zA-Z0-9_]{1,100}$/.test(candidate)
      )
        code = candidate;
    } catch {
      /* A non-JSON error is represented by its HTTP status. */
    }
    throw new OAuthError(code);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Malformed authorization response");
  }
}
async function discovery(options: AuthOptions): Promise<any> {
  const config = await json(
    issuer + "/.well-known/openid-configuration",
    {},
    options,
  );
  if (config.issuer !== issuer)
    throw new Error("Unexpected authorization issuer");
  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "revocation_endpoint",
  ]) {
    if (
      typeof config[field] !== "string" ||
      new URL(config[field]).origin !== issuer
    )
      throw new Error("Unexpected authorization endpoint");
  }
  return config;
}
function tokenSet(result: any, previous?: Tokens): Tokens {
  const scopes =
    typeof result.scope === "string"
      ? result.scope.split(/\s+/)
      : (previous?.scopes ?? []);
  if (!requiredScopes.every((scope) => scopes.includes(scope)))
    throw new Error("ChatGPT plan permission not granted");
  const next = {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    id_token: result.id_token ?? previous?.id_token,
    scopes,
    expires_at: Date.now() + result.expires_in * 1000,
  };
  if (
    result.token_type?.toLowerCase() !== "bearer" ||
    typeof result.expires_in !== "number" ||
    result.expires_in <= 0 ||
    !validTokens(next)
  )
    throw new Error("Invalid OAuth token response");
  return next;
}
export class AuthSession implements CredentialSource {
  private release: () => void;
  private closed = false;
  private closing?: Promise<void>;
  private refreshing?: Promise<string>;
  private abort = new AbortController();
  private store: AuthStore;
  private options: AuthOptions;
  constructor(store: AuthStore, options: AuthOptions = {}) {
    this.store = store;
    this.options = options;
    this.release = store.acquire();
    try {
      store.read();
    } catch (error) {
      this.release();
      throw error;
    }
  }
  status(): { state: string } {
    return this.closed || this.closing
      ? { state: "closed" }
      : this.store.status();
  }
  async accessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.closed || this.closing)
      throw new Error("Authorization session is closed");
    const record = this.store.read(),
      tokens = record.credentials;
    if (!tokens || !requiredScopes.every((s) => tokens.scopes.includes(s)))
      throw new Error("Subscription login required; run npm run auth -- login");
    if (tokens.expires_at - Date.now() > 60000) return tokens.access_token;
    const shared = (this.refreshing ??= this.refresh(record).finally(() => {
      this.refreshing = undefined;
    }));
    if (!signal) return shared;
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      shared
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private async refresh(record: AuthRecord): Promise<string> {
    const options = {
      ...this.options,
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(60000),
        ...(this.options.signal ? [this.options.signal] : []),
      ]),
    };
    try {
      const config = await discovery(options);
      const result = await json(
        config.token_endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: record.client_id!,
            refresh_token: record.credentials!.refresh_token,
            resource,
          }),
        },
        options,
      );
      const next = tokenSet(result, record.credentials);
      if (result.id_token) {
        const jwks = await json(config.jwks_uri, {}, options);
        if (
          verifyIdentity(result.id_token, record.client_id!, jwks).sub !==
          record.subject
        )
          throw new Error("Refreshed identity mismatch");
      }
      if (this.closed) throw new Error("Authorization session is closed");
      record.credentials = next;
      this.store.save(record);
      return next.access_token;
    } catch (error) {
      if (
        !this.closed &&
        error instanceof OAuthError &&
        [
          "invalid_grant",
          "invalid_refresh_token",
          "token_expired",
          "refresh_token_expired",
          "refresh_token_invalidated",
          "refresh_token_reused",
        ].includes(error.code)
      ) {
        record.credentials = undefined;
        this.store.save(record);
      }
      throw error;
    }
  }
  async logout(): Promise<{ remoteRevoked: boolean }> {
    if (this.closed) throw new Error("Authorization session is closed");
    const record = this.store.read();
    let remoteRevoked = !record.credentials;
    try {
      if (record.credentials) {
        const options = { ...this.options, signal: this.abort.signal },
          config = await discovery(options);
        const response = await (this.options.fetch ?? globalThis.fetch)(
          config.revocation_endpoint,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: record.credentials.refresh_token,
              token_type_hint: "refresh_token",
              client_id: record.client_id!,
            }),
            redirect: "error",
            signal: AbortSignal.any([
              this.abort.signal,
              AbortSignal.timeout(20000),
            ]),
          },
        );
        remoteRevoked = response.status === 200;
        await response.body?.cancel();
      }
    } catch {
      remoteRevoked = false;
    } // Report local sign-out and remote revocation separately.
    record.credentials = undefined;
    this.store.save(record);
    return { remoteRevoked };
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      try {
        await this.refreshing;
      } catch {
        throw new Error("Authorization refresh failed during shutdown");
      } finally {
        this.closed = true;
        this.abort.abort();
        this.release();
      }
    })());
  }
}
export async function beginLogin(
  store: Pick<AuthStore, "read" | "save" | "acquire">,
  options: AuthOptions = {},
): Promise<{
  authorizationUrl: string;
  redirectUri: string;
  done: Promise<void>;
  cancel: () => void;
}> {
  const release = store.acquire();
  let server: http.Server | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    finished = false,
    used = false;
  const abort = new AbortController();
  let resolveDone!: () => void, rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Install a handler immediately; the caller still receives the original rejecting promise.
  void done.catch(() => {});
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    abort.abort();
    release();
    const closing = server;
    setTimeout(() => {
      closing?.close();
      closing?.closeIdleConnections();
    }, 25).unref();
    if (error) rejectDone(error);
    else resolveDone();
  };
  try {
    const requestOptions = { ...options, signal: abort.signal };
    const config = await discovery(requestOptions),
      jwks = await json(config.jwks_uri, {}, requestOptions);
    const record = store.read();
    store.save(record);
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    let redirectUri = "";
    server = http.createServer(async (req, res) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      const host = `127.0.0.1:${(server!.address() as { port: number }).port}`;
      if (
        req.headers.host !== host ||
        (req.headers.origin !== undefined &&
          req.headers.origin !== `http://${host}`)
      ) {
        res.writeHead(403);
        res.end("Invalid origin");
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400);
        res.end("Invalid request");
        return;
      }
      if (req.method === "GET" && url.pathname === "/done") {
        res.end(
          "Authorization callback received. Return to your terminal for the result.",
        );
        return;
      }
      if (req.method !== "GET" || url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const actual = Buffer.from(url.searchParams.get("state") ?? ""),
        expected = Buffer.from(state);
      if (
        finished ||
        used ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        res.writeHead(400);
        res.end("Invalid or already used authorization state");
        return;
      }
      used = true;
      clearTimeout(timer);
      res.writeHead(303, { location: "/done" });
      res.end();
      try {
        if (url.searchParams.has("error"))
          throw new Error("Authorization declined or unavailable");
        const clientId = record.client_id ?? url.searchParams.get("client_id"),
          code = url.searchParams.get("code");
        if (
          !clientId ||
          clientId === "dynamic_agent_client" ||
          !code ||
          (record.client_id &&
            url.searchParams.get("client_id") &&
            url.searchParams.get("client_id") !== record.client_id)
        )
          throw new Error("Missing or mismatched issued client ID");
        record.client_id = clientId;
        store.save(record);
        const result = await json(
          config.token_endpoint,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              code,
              code_verifier: verifier,
              redirect_uri: redirectUri,
              resource,
            }),
          },
          requestOptions,
        );
        const credentials = tokenSet(result);
        const identity = verifyIdentity(
          credentials.id_token,
          clientId,
          jwks,
          nonce,
        );
        if (record.subject && record.subject !== identity.sub)
          throw new Error("Selected identity differs from this registration");
        if (finished) return;
        record.subject = identity.sub;
        record.credentials = credentials;
        store.save(record);
        finish();
      } catch (error) {
        finish(
          error instanceof Error ? error : new Error("Authorization failed"),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/auth/callback`;
    const query = new URLSearchParams({
      client_id: record.client_id ?? "dynamic_agent_client",
      ext_agent_host_id: record.ext_agent_host_id,
      response_type: "code",
      redirect_uri: redirectUri,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    if (!record.client_id) query.set("agent_name_hint", "ChatGPT Plan Gateway");
    // Do not include ID tokens in URLs printed by the CLI. Returning clients reuse their registration.
    timer = setTimeout(
      () => finish(new Error("Authorization timed out")),
      options.timeoutMs ?? 30 * 60 * 1000,
    );
    return {
      authorizationUrl: config.authorization_endpoint + "?" + query,
      redirectUri,
      done,
      cancel: () => finish(new Error("Authorization cancelled")),
    };
  } catch (error) {
    finish(
      error instanceof Error ? error : new Error("Authorization setup failed"),
    );
    throw error;
  }
}
