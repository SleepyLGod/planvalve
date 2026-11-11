import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createGateway } from "../src/gateway.ts";
async function command(args: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "./tests/network-guard.ts", "src/status-cli.ts", ...args],
    {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, NO_COLOR: "1" },
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}
test("one-shot JSON monitoring is parseable and does not call a model", async (t) => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const result = await command(["--json", "--url", url]);
  assert.equal(result.code, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.status.mode, "offline-only");
  assert.equal(snapshot.status.queue.concurrency, 1);
  assert.equal(snapshot.page.items.length, 0);
  assert.equal(gateway.mock.calls, 0);
  assert.equal(gateway.records.length, 0);
});
test("non-TTY monitor prints readable one-shot output without ANSI", async (t) => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const result = await command(["--url", url]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /离线模拟/);
  assert.match(result.stdout, /输入/);
  assert.match(result.stdout, /运行状态/);
  assert(!result.stdout.includes("\x1b"));
  assert.equal(gateway.mock.calls, 0);
});
test("monitor refuses external URLs before any fetch", async () => {
  const result = await command(["--once", "--url", "https://api.openai.com"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /loopback/i);
  assert.doesNotMatch(result.stderr, /OFFLINE_NETWORK_DENIED/);
});
test("monitor refuses even a loopback redirect without following it", async (t) => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(302, { location: "http://127.0.0.1:1/nope" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const result = await command([
    "--once",
    "--url",
    `http://127.0.0.1:${address.port}`,
  ]);
  assert.notEqual(result.code, 0);
  assert.equal(calls, 1);
});
async function terminal(url: string, disconnect = false) {
  const child = spawn(
    process.env.GATEWAY_TEST_PYTHON ?? "python3",
    [
      "-I",
      "-B",
      "tests/terminal-client.py",
      process.execPath,
      url,
      ...(disconnect ? ["--disconnect"] : []),
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr + stdout);
  assert.equal(JSON.parse(stdout).terminal_restored, true);
}
test("real pseudoterminal handles details, scrolling, history, resizing and quitting without stopping gateway", async (t) => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  await (
    await fetch(url + "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "offline-model",
        messages: [{ role: "user", content: "test" }],
      }),
    })
  ).json();
  await terminal(url);
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal(gateway.mock.calls, 1);
});
test("real monitor preserves its last timestamped snapshot after losing connection", async (t) => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  await (
    await fetch(url + "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "offline-model",
        messages: [{ role: "user", content: "test" }],
      }),
    })
  ).json();
  let statusCalls = 0;
  const relay = createServer(async (req, res) => {
    if (req.url?.startsWith("/_gateway/status") && ++statusCalls > 1) {
      res.writeHead(503);
      res.end();
      return;
    }
    const response = await fetch(url + req.url);
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => relay.close(() => resolve())));
  const address = relay.address();
  assert(address && typeof address === "object");
  await terminal("http://127.0.0.1:" + address.port, true);
  assert.equal(gateway.mock.calls, 1);
});
test("host proxy configuration cannot route monitor traffic through a proxy", async (t) => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  let proxyCalls = 0;
  const proxy = createServer((_req, res) => {
    proxyCalls++;
    res.writeHead(503);
    res.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const address = proxy.address();
  assert(address && typeof address === "object");
  const proxyUrl = "http://127.0.0.1:" + address.port;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./tests/network-guard.ts",
      "src/status-cli.ts",
      "--json",
      "--url",
      url,
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        NO_PROXY: "",
        no_proxy: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(proxyCalls, 0, "loopback traffic reached host-configured proxy");
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).status.mode, "offline-only");
});
test("status CLI accepts an explicit English locale and rejects unknown locales", async (t) => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const en = await command(["--once", "--lang", "en", "--url", url]);
  assert.equal(en.code, 0, en.stderr);
  assert.match(en.stdout, /PlanValve/);
  assert.doesNotMatch(en.stdout, /[\u3400-\u9fff]/);
  const bad = await command(["--lang", "de", "--url", url]);
  assert.notEqual(bad.code, 0);
  assert.equal(gateway.mock.calls, 0);
});
