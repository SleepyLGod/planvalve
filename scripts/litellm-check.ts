/** Direct installed LiteLLM acceptance; all upstreams are synthetic and local. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../src/gateway.ts";
import type { Fixture, ObjectValue } from "../src/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const python = process.env.GATEWAY_LITELLM_PYTHON;
if (!python)
  throw new Error(
    "Set GATEWAY_LITELLM_PYTHON to an existing Python environment with LiteLLM installed; nothing is installed automatically.",
  );
mkdirSync(resolve(root, "reports"), { recursive: true });
const directory = mkdtempSync(resolve(root, "reports/litellm-"));
function save(name: string, value: unknown): void {
  writeFileSync(
    resolve(directory, name),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
}
const baseUsage = {
  input_tokens: 58,
  output_tokens: 13,
  total_tokens: 71,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
  fixture_metadata: { source: "synthetic-offline-acceptance" },
};
function tape(
  text: string,
  usage: ObjectValue | null = baseUsage,
  terminal = "completed",
  code?: string,
): Fixture {
  const events: ObjectValue[] = [
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_text.done", text },
  ];
  if (terminal !== "interrupted")
    events.push({
      type: "response." + terminal,
      response: {
        status: terminal,
        output: [],
        usage,
        ...(code ? { error: { code } } : {}),
      },
    });
  return { name: "synthetic-litellm", events };
}
const schema = {
  type: "json_schema",
  json_schema: {
    name: "answer",
    strict: true,
    schema: {
      type: "object",
      properties: { answer: { type: "integer", const: 2 } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
};
interface Case {
  name: string;
  fixture: Fixture;
  parameters: ObjectValue;
  error: boolean;
  expected: { text: string; cached: number | null; reasoning: number | null };
  errorCode?: string;
  rejected?: boolean;
}
function example(
  name: string,
  fixture: Fixture = tape('{"answer":2}'),
  parameters: ObjectValue = { response_format: { type: "json_object" } },
): Case {
  return {
    name,
    fixture,
    parameters,
    error: false,
    expected: { text: '{"answer":2}', cached: 0, reasoning: 0 },
  };
}
const cases: Case[] = [
  {
    ...example("text", tape("OK"), {}),
    expected: { text: "OK", cached: 0, reasoning: 0 },
  },
  example("json-object"),
  example("json-schema", tape('{"answer":2}'), { response_format: schema }),
  {
    ...example(
      "nonzero-details",
      tape('{"answer":2}', {
        ...baseUsage,
        input_tokens_details: { cached_tokens: 7, cache_write_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 3 },
      }),
    ),
    expected: { text: '{"answer":2}', cached: 7, reasoning: 3 },
  },
  {
    ...example(
      "missing-details",
      tape('{"answer":2}', {
        input_tokens: 58,
        output_tokens: 13,
        total_tokens: 71,
      }),
    ),
    expected: { text: '{"answer":2}', cached: null, reasoning: null },
  },
  {
    ...example("invalid-json", tape("not JSON")),
    error: true,
    errorCode: "invalid_json",
  },
  {
    ...example("schema-mismatch", tape('{"answer":3}'), {
      response_format: schema,
    }),
    error: true,
    errorCode: "schema_mismatch",
  },
  {
    ...example("interrupted", tape('{"answer":2}', baseUsage, "interrupted")),
    error: true,
    errorCode: "stream_interrupted",
  },
  {
    ...example(
      "upstream-failed",
      tape('{"answer":2}', baseUsage, "failed", "fixture_failure"),
    ),
    error: true,
    errorCode: "fixture_failure",
  },
  {
    ...example("usage-missing", tape('{"answer":2}', null)),
    error: true,
    errorCode: "usage_missing",
  },
  {
    ...example(
      "rate-limit",
      tape(
        '{"answer":2}',
        baseUsage,
        "failed",
        "subscription_sharing_usage_limit_exceeded",
      ),
    ),
    error: true,
    errorCode: "subscription_sharing_usage_limit_exceeded",
  },
  {
    ...example("unsupported-parameter", tape('{"answer":2}'), {
      temperature: 0,
    }),
    error: true,
    rejected: true,
  },
];
const gateways: {
  test: Case;
  gateway: ReturnType<typeof createGateway>;
  clientRequests: number;
  url: string;
}[] = [];
let proxyRequests = 0;
const proxy = createServer((_req, res) => {
  proxyRequests++;
  res.writeHead(503);
  res.end("Unexpected proxy request");
});
let failed: unknown;
let passedCases = 0;
let caseFrameworkImportsVerified = false;
try {
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  for (const test of cases) {
    const gateway = createGateway({
      fixture: test.fixture,
      profile: "strict",
      port: 0,
      maxRequests: 1,
      upstreamTimeoutMs: 2000,
      databasePath: ":memory:",
    });
    const entry = {
      test,
      gateway,
      clientRequests: 0,
      url: await gateway.listen(),
    };
    gateways.push(entry);
    gateway.server.on("request", (req) => {
      if (req.method === "POST") entry.clientRequests++;
    });
  }
  const manifest = resolve(directory, "manifest.json");
  save("manifest.json", {
    clientReport: resolve(directory, "client.json"),
    cases: gateways.map(({ test, url }) => ({
      ...test,
      fixture: undefined,
      url,
    })),
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(
      python,
      [
        "-I",
        "-B",
        resolve(root, "tests/local-python-check.py"),
        resolve(root, "scripts/litellm-client.py"),
        manifest,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ALL_PROXY: proxyUrl,
          NO_PROXY: "127.0.0.1,::1",
          no_proxy: "127.0.0.1,::1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      writeFileSync(resolve(directory, "client.stdout.txt"), stdout, {
        mode: 0o600,
      });
      writeFileSync(resolve(directory, "client.stderr.txt"), stderr, {
        mode: 0o600,
      });
      resolveExit(code);
    });
  });
  assert.equal(
    exitCode,
    0,
    "Guarded LiteLLM client failed; inspect " + directory,
  );
  const client = JSON.parse(
    readFileSync(resolve(directory, "client.json"), "utf8"),
  );
  assert.equal(client.passed, true);
  assert.equal(client.cases.length, cases.length);
  assert.equal(client.lotus_imported, false);
  assert.equal(client.agent_memory_imported, false);
  passedCases = client.cases.filter(
    (entry: { passed: boolean }) => entry.passed,
  ).length;
  caseFrameworkImportsVerified = true;
  assert.equal(
    proxyRequests,
    0,
    "A loopback request reached the environment proxy",
  );
  for (const { test, gateway, clientRequests } of gateways) {
    assert.equal(clientRequests, 1, test.name + " retried the HTTP request");
    assert.equal(
      gateway.mock.calls,
      test.rejected ? 0 : 1,
      test.name + " retried the upstream",
    );
    assert.equal(gateway.records.length, test.rejected ? 0 : 1, test.name);
    if (test.rejected) continue;
    const record = gateway.records[0]!;
    if (test.error) {
      assert.equal(record.endReason, test.errorCode, test.name);
      assert.equal(gateway.status().queue.paused, true, test.name);
    } else {
      assert.equal(record.status, "completed", test.name);
      assert.equal(record.usage!.total_tokens, 71, test.name);
      const raw = (test.fixture.events.at(-1)!.response as ObjectValue).usage;
      assert.deepEqual(
        record.rawUsage,
        raw,
        test.name + " lost raw usage fields",
      );
    }
    if (test.name === "nonzero-details") {
      assert.equal(gateway.status().usage.totalTokens, 71);
      assert.equal(gateway.status().usage.cached.knownTokens, 7);
      assert.equal(gateway.status().usage.reasoning.knownTokens, 3);
      assert.equal(gateway.status().usage.cacheWrite.knownTokens, 2);
    }
    if (test.name === "missing-details") {
      assert.equal(record.usageCompleteness, "partial");
      assert.equal(gateway.status().usage.cached.unknownRequests, 1);
      assert.equal(gateway.status().usage.reasoning.unknownRequests, 1);
      assert.equal(gateway.status().usage.cacheWrite.unknownRequests, 1);
    }
  }
} catch (error) {
  failed = error;
} finally {
  save(
    "gateways.json",
    gateways.map(({ test, gateway, clientRequests }) => ({
      name: test.name,
      clientRequests,
      ...gateway.report(),
    })),
  );
  await Promise.all(gateways.map(({ gateway }) => gateway.close()));
  await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
}
const summary = {
  passed: !failed,
  cases: cases.length,
  passedCases,
  clientRequests: gateways.reduce(
    (sum, entry) => sum + entry.clientRequests,
    0,
  ),
  mockAttempts: gateways.reduce(
    (sum, entry) => sum + entry.gateway.mock.calls,
    0,
  ),
  proxyRequests,
  upstream: "synthetic-offline",
  caseFrameworkImportsVerified,
  reportDirectory: directory,
};
save("result.json", summary);
console.log(JSON.stringify(summary));
if (failed) throw failed;
