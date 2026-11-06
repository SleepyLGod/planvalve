import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  initializeLocalProfile,
  readLocalProfile,
} from "../src/local-profile.ts";
function project() {
  mkdirSync("reports", { recursive: true });
  return mkdtempSync(resolve("reports/local-entry-test-"));
}
test("local init creates a private subscription profile and stable local key, with paths bound to the project", () => {
  const root = project();
  const first = initializeLocalProfile(root, { model: "test-model" });
  const profile = readLocalProfile(root);
  assert.equal(first.created, true);
  assert.equal(profile.config.upstream, "chatgpt-subscription");
  assert.equal(profile.config.model, "test-model");
  assert.equal(profile.config.port, 8787);
  assert.equal(profile.config.minStartIntervalMs, 3000);
  assert.equal(
    profile.config.authPath,
    resolve(root, "data/auth/session.json"),
  );
  assert.equal(profile.config.maxRequests, 1000);
  assert.equal(profile.config.stopAfterTokens, 100000);
  assert.equal(statSync(resolve(root, "data/local")).mode & 0o777, 0o700);
  assert.equal(statSync(profile.configPath).mode & 0o777, 0o600);
  assert.equal(
    statSync(resolve(root, "data/local/client.key")).mode & 0o777,
    0o600,
  );
  assert.match(profile.localKey, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(first).includes(profile.localKey));
  const previous = statSync(profile.configPath).mtimeMs;
  assert.equal(
    initializeLocalProfile(root, { model: "test-model" }).created,
    false,
  );
  assert.equal(readLocalProfile(root).localKey, profile.localKey);
  assert.equal(statSync(profile.configPath).mtimeMs, previous);
  assert.throws(
    () => initializeLocalProfile(root, { model: "other-model" }),
    /conflict|existing/i,
  );
  assert.equal(readLocalProfile(root).config.model, "test-model");
});
test("API-key profiles store no upstream key; missing, corrupt, permissive and symlink state is rejected without replacement", () => {
  const root = project();
  assert.throws(() => readLocalProfile(root), /init/i);
  initializeLocalProfile(root, {
    model: "test-model",
    upstream: "openai-api-key",
  });
  const profile = readLocalProfile(root);
  assert.equal(profile.config.upstream, "openai-api-key");
  assert(!readFileSync(profile.configPath, "utf8").includes("api_key"));
  const keyPath = resolve(root, "data/local/client.key"),
    key = readFileSync(keyPath, "utf8");
  writeFileSync(keyPath, "broken");
  assert.throws(
    () =>
      initializeLocalProfile(root, {
        model: "test-model",
        upstream: "openai-api-key",
      }),
    /key|profile/i,
  );
  assert.equal(readFileSync(keyPath, "utf8"), "broken");
  writeFileSync(keyPath, key);
  chmodSync(keyPath, 0o644);
  assert.throws(() => readLocalProfile(root), /private|permission/i);
  chmodSync(keyPath, 0o600);
  const file = readFileSync(profile.configPath, "utf8");
  writeFileSync(profile.configPath, "not json");
  assert.throws(() => readLocalProfile(root), /config|profile/i);
  assert.equal(readFileSync(profile.configPath, "utf8"), "not json");
  writeFileSync(profile.configPath, file);
  const other = project();
  mkdirSync(resolve(other, "data"));
  symlinkSync(resolve(root, "data/local"), resolve(other, "data/local"));
  assert.throws(
    () => initializeLocalProfile(other, { model: "test-model" }),
    /symlink/i,
  );
});

import { cpSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
const repository = fileURLToPath(new URL("..", import.meta.url));
function copiedProject() {
  const root = project();
  cpSync(resolve(repository, "src"), resolve(root, "src"), { recursive: true });
  cpSync(resolve(repository, "examples"), resolve(root, "examples"), {
    recursive: true,
  });
  cpSync(resolve(repository, "package.json"), resolve(root, "package.json"));
  symlinkSync(
    resolve(repository, "node_modules"),
    resolve(root, "node_modules"),
  );
  return root;
}
const guardedEnv = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  NODE_OPTIONS:
    "--import " + new URL("./network-guard.ts", import.meta.url).href,
  NO_COLOR: "1",
});
test("local CLI init is project-relative from any cwd and rejects conflicting options without exposing its key", () => {
  const root = copiedProject();
  const run = (args: string[]) =>
    spawnSync(process.execPath, [resolve(root, "src/local-cli.ts"), ...args], {
      cwd: repository,
      env: guardedEnv(),
      encoding: "utf8",
    });
  const first = run(["init", "--model", "test-model"]);
  assert.equal(first.status, 0, first.stderr);
  const profile = readLocalProfile(root);
  assert.equal(JSON.parse(first.stdout).created, true);
  assert(!first.stdout.includes(profile.localKey));
  const second = run(["init", "--model", "test-model"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).created, false);
  assert.equal(readLocalProfile(root).localKey, profile.localKey);
  const missingAuth = run(["start"]);
  assert.notEqual(missingAuth.status, 0);
  assert.match(missingAuth.stderr, /login required/i);
  assert.doesNotMatch(missingAuth.stderr, /OFFLINE_NETWORK_DENIED/);
  for (const args of [
    ["init", "--model", "other-model"],
    ["init", "--model", "x", "--upstream", "invalid"],
    ["start", "--unexpected"],
    ["status", "--url", "http://127.0.0.1:1"],
    ["status", "--direct"],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert(!result.stderr.includes(profile.localKey));
  }
  writeFileSync(
    resolve(root, "src/cli.ts"),
    'process.kill(process.pid,"SIGKILL");\n',
  );
  assert.equal(run(["start"]).status, 137);
});
test("local status forwards locale/JSON and its stored local key without opening subscription credentials", async (t) => {
  const root = copiedProject();
  initializeLocalProfile(root, { model: "test-model" });
  const original = readLocalProfile(root);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer " + original.localKey);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.startsWith("/_gateway/status")
          ? { runId: "test-run", mode: "chatgpt-subscription" }
          : { items: [], nextCursor: null },
      ),
    );
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = JSON.parse(readFileSync(original.configPath, "utf8"));
  config.port = (server.address() as { port: number }).port;
  writeFileSync(original.configPath, JSON.stringify(config));
  const child = spawn(
    process.execPath,
    [resolve(root, "src/local-cli.ts"), "status", "--json", "--lang", "en"],
    { cwd: repository, env: guardedEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).status.runId, "test-run");
  assert.equal(requests, 2);
  assert(!stdout.includes(original.localKey));
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function collected(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  return { code, stdout, stderr };
}
test("local start forwards signals and the JS local example uses its saved model/key through HTTP", async (t) => {
  const root = copiedProject();
  initializeLocalProfile(root, {
    model: "test-model",
    upstream: "openai-api-key",
  });
  const original = readLocalProfile(root);
  const config = JSON.parse(readFileSync(original.configPath, "utf8"));
  config.port = await freePort();
  config.minStartIntervalMs = 0;
  writeFileSync(original.configPath, JSON.stringify(config));
  const preload = resolve(root, "fake-upstream.mjs");
  writeFileSync(
    preload,
    `const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{if(String(input)==='https://api.openai.com/v1/chat/completions')return Response.json({id:'chatcmpl-fake',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:'{"answer":2}'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}});return original(input,init)};`,
  );
  const env = {
    ...guardedEnv(),
    NODE_OPTIONS:
      guardedEnv().NODE_OPTIONS +
      " --import " +
      new URL("file://" + preload).href,
    OPENAI_API_KEY: "fake-upstream-private-key",
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "",
  };
  const gateway = spawn(
    process.execPath,
    [resolve(root, "src/local-cli.ts"), "start"],
    { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  gateway.stderr.on("data", (c) => (stderr += c));
  const closed = new Promise<number | null>((resolve) =>
    gateway.once("close", resolve),
  );
  t.after(() => {
    if (gateway.exitCode === null) gateway.kill("SIGTERM");
  });
  await new Promise<void>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(Error("Local startup timeout")),
      5000,
    );
    gateway.once("exit", () => {
      clearTimeout(timer);
      reject(Error(stderr));
    });
    gateway.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const monitor = await collected(
    process.execPath,
    [resolve(root, "src/local-cli.ts"), "status", "--json"],
    repository,
    env,
  );
  assert.equal(monitor.code, 0, monitor.stderr);
  assert.equal(JSON.parse(monitor.stdout).status.budget.requests.used, 0);
  const example = await collected(
    process.execPath,
    [resolve(root, "examples/client.mjs"), "--local"],
    repository,
    env,
  );
  assert.equal(example.code, 0, example.stderr);
  assert.equal(JSON.parse(example.stdout).text, '{"answer":2}');
  assert.equal(JSON.parse(example.stdout).usage.total_tokens, 7);
  assert(!example.stdout.includes(original.localKey));
  let expectedCalls = 1;
  if (process.env.GATEWAY_LOTUS_PYTHON) {
    const python = await collected(
      process.env.GATEWAY_LOTUS_PYTHON,
      [
        "-I",
        "-B",
        resolve(repository, "tests/local-python-check.py"),
        resolve(root, "examples/client.py"),
      ],
      repository,
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PYTHON_DOTENV_DISABLED: "1",
        XDG_CACHE_HOME: resolve(root, "data/cache"),
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "",
      },
    );
    assert.equal(python.code, 0, python.stderr);
    assert.equal(JSON.parse(python.stdout).text, '{"answer":2}');
    assert.equal(JSON.parse(python.stdout).usage.total_tokens, 7);
    assert(!python.stdout.includes(original.localKey));
    expectedCalls++;
  }
  const terminal = await collected(
    process.env.GATEWAY_TEST_PYTHON ?? "python3",
    [
      "-I",
      "-B",
      resolve(repository, "tests/terminal-client.py"),
      process.execPath,
      "unused",
      "--local-root",
      root,
    ],
    repository,
    guardedEnv(),
  );
  assert.equal(terminal.code, 0, terminal.stderr + terminal.stdout);
  assert.equal(JSON.parse(terminal.stdout).terminal_restored, true);
  const after = await collected(
    process.execPath,
    [resolve(root, "src/local-cli.ts"), "status", "--json"],
    repository,
    env,
  );
  assert.equal(after.code, 0);
  assert.equal(
    JSON.parse(after.stdout).status.budget.requests.used,
    expectedCalls,
  );
  gateway.kill("SIGINT");
  assert.equal(await closed, 0, stderr);
  const report = JSON.parse(
    readFileSync(resolve(root, "reports/local.json"), "utf8"),
  );
  assert.equal(report.realAttempts, expectedCalls);
  assert.equal(report.records[0].status, "completed");
  assert(!stderr.includes(original.localKey));
  const conflicting = await collected(
    process.execPath,
    [resolve(root, "examples/client.mjs"), "--local", "--direct"],
    repository,
    env,
  );
  assert.notEqual(conflicting.code, 0);
  assert.match(conflicting.stderr, /together|combine|exclusive/i);
});
