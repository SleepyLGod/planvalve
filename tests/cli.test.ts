import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { loadConfig, validateConfig } from "../src/config.ts";
const root = new URL("..", import.meta.url);
test("config refuses arbitrary network endpoints and invalid limits", () => {
  for (const c of [
    { upstreamUrl: "https://api.openai.com" },
    { fixturePath: "https://example.com/tape" },
    { port: 65536 },
    { queueCapacity: 0 },
    { maxRequests: 0 },
    { profile: "live" },
  ])
    assert.throws(() => validateConfig(c));
});
test("network guard catches an attempted external request before a socket connects", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/network-guard.ts",
      "--input-type=module",
      "-e",
      "await fetch('https://api.openai.com/v1/responses')",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /OFFLINE_NETWORK_DENIED/);
});
test("CLI starts only offline on loopback and writes a useful report", async () => {
  await mkdir(new URL("../reports", import.meta.url), { recursive: true });
  const config = new URL("../reports/cli-test-config.json", import.meta.url);
  await writeFile(
    config,
    JSON.stringify({
      port: 0,
      databasePath: ":memory:",
      fixturePath: "../fixtures/observed-json.json",
      reportPath: "cli-smoke.json",
    }),
  );
  assert.equal(loadConfig(config.pathname).port, 0);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./tests/network-guard.ts",
      "src/cli.ts",
      "--config",
      config.pathname,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  try {
    const startup = await new Promise<{ url: string; mode: string }>(
      (resolve, reject) => {
        let text = "";
        child.stdout.on("data", (data) => {
          text += data;
          if (text.includes("\n"))
            try {
              resolve(JSON.parse(text.split("\n")[0]!));
            } catch (e) {
              reject(e);
            }
        });
        child.once("exit", () =>
          reject(new Error("CLI exited before startup: " + stderr)),
        );
        setTimeout(
          () => reject(new Error("CLI startup timeout")),
          5000,
        ).unref();
      },
    );
    assert.equal(startup.mode, "offline-only");
    assert(new URL(startup.url).hostname === "127.0.0.1");
    const response = await fetch(startup.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "offline-model",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
    const reportFile = new URL("../reports/cli-smoke.json", import.meta.url);
    const before = (await stat(reportFile)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await (await fetch(startup.url + "/_gateway/status")).json();
    assert.equal(
      (await stat(reportFile)).mtimeMs,
      before,
      "monitoring must not rewrite the JSON report",
    );
  } finally {
    child.kill("SIGTERM");
  }
  assert.equal(await closed, 0, stderr);
  const report = JSON.parse(
    await readFile(
      new URL("../reports/cli-smoke.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(report.mockAttempts, 1);
  assert.equal(report.totals.totalTokens, 71);
  assert.equal(report.realApiSupported, false);
});
test("timer values cannot overflow Node timers and inherited field names are rejected", () => {
  for (const c of [
    { upstreamTimeoutMs: 4294967296 },
    { maxQueueWaitMs: 2147483648 },
    { minStartIntervalMs: 2147483648 },
    JSON.parse('{"constructor":1}'),
  ])
    assert.throws(() => validateConfig(c));
});
test("DNS and UDP bypasses are denied before any real resolver or sender runs", () => {
  for (const kind of ["dns", "dns-loopback", "udp"]) {
    const code = `import dns from 'node:dns';import dgram from 'node:dgram';
 dns.resolve4=()=>{throw new Error('UNGUARDED_DNS')};
 dgram.Socket.prototype.send=()=>{throw new Error('UNGUARDED_UDP')};
 await import('./tests/network-guard.ts');
 ${kind === "dns" ? "dns.resolve4('api.openai.com')" : kind === "dns-loopback" ? "dns.resolve4('127.0.0.1')" : "dgram.Socket.prototype.send.call({},new Uint8Array([1]),53,'api.openai.com')"};`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OFFLINE_NETWORK_DENIED/);
    assert.doesNotMatch(r.stderr, /Error: UNGUARDED/);
  }
});

test("Python client guard rejects every independent DNS audit event", () => {
  const code = `import ast, os, sys
from pathlib import Path
source = Path('scripts/lotus-client.py').read_text()
function = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'audit')
scope = {'Path':Path,'os':os,'ROOT':Path.cwd(),'denials':[],'connections':[]}
exec(compile(ast.Module(body=[function],type_ignores=[]),'<client-audit>','exec'),scope)
sys.addaudithook(scope['audit'])
for event,args in [('socket.getaddrinfo',('api.openai.com',443)),('socket.gethostbyname',('api.openai.com',)),('socket.gethostbyaddr',('8.8.8.8',)),('socket.getnameinfo',(('8.8.8.8',53),0))]:
    try:
        sys.audit(event,*args)
    except PermissionError:
        continue
    raise AssertionError('Unblocked resolver event: '+event)
print('all DNS audit paths blocked')`;
  const result = spawnSync(
    process.env.GATEWAY_TEST_PYTHON ?? "python3",
    ["-I", "-B", "-c", code],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all DNS audit paths blocked/);
});

test("network guard still fails if a forbidden connection error is caught", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/network-guard.ts",
      "--input-type=module",
      "-e",
      "try {await fetch('https://api.openai.com')} catch {}",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-loopback connection/);
});
test("startup report-write failure closes the already opened server", async () => {
  const config = new URL("../reports/startup-failure.json", import.meta.url);
  await writeFile(
    config,
    JSON.stringify({ port: 0, databasePath: ":memory:", reportPath: "." }),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./tests/network-guard.ts",
      "src/cli.ts",
      "--config",
      config.pathname,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "",
    timedOut = false;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.resume();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 1500);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timer);
  assert.equal(
    timedOut,
    false,
    "startup failure left a listening server behind",
  );
  assert.equal(code, 1, stderr);
});
test("malformed request target returns 400 without an unhandled rejection", async () => {
  const code = `import {createGateway} from './src/gateway.ts';import net from 'node:net';
  const gateway=createGateway({port:0,databasePath:':memory:'});const url=new URL(await gateway.listen());
  process.on('unhandledRejection',()=>console.error('UNHANDLED_URL'));
  const response=await new Promise(resolve=>{let text='';const socket=net.connect(Number(url.port),'127.0.0.1',()=>socket.write('GET //[ HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'));socket.on('data',chunk=>text+=chunk);socket.setTimeout(300,()=>socket.destroy());socket.once('close',()=>resolve(text));});
  await gateway.close();console.log(response);`;
  const child = spawn(
    process.execPath,
    ["--import", "./tests/network-guard.ts", "--input-type=module", "-e", code],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const result = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(result, 0, stderr);
  assert.match(stdout, /HTTP\/1.1 400/);
  assert.doesNotMatch(stderr, /UNHANDLED_URL/);
});
test("auth status CLI is local, redacted, and does not create credentials", async () => {
  const { existsSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const folder = new URL(
    "../reports/auth-cli-" + randomUUID() + "/",
    import.meta.url,
  );
  await mkdir(folder, { recursive: true });
  const config = new URL("config.json", folder);
  await writeFile(config, JSON.stringify({ authPath: "private/session.json" }));
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/network-guard.ts",
      "src/auth-cli.ts",
      "status",
      "--config",
      config.pathname,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { state: "login-required" });
  assert.equal(existsSync(new URL("private/session.json", folder)), false);
});
test("API-key CLI refuses missing server credentials without discovering models or logging in", async () => {
  const { randomUUID } = await import("node:crypto");
  const config = new URL(
    "../reports/api-cli-" + randomUUID() + ".json",
    import.meta.url,
  );
  await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      upstream: "openai-api-key",
      model: "test-model",
      port: 0,
      databasePath: ":memory:",
    }),
  );
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/network-guard.ts",
      "src/cli.ts",
      "--config",
      config.pathname,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GATEWAY_LOCAL_API_KEY: "test-local-key-private",
      },
    },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /OPENAI_API_KEY/);
  assert.doesNotMatch(child.stderr, /OFFLINE_NETWORK_DENIED/);
});
