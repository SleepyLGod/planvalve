import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("standalone LiteLLM acceptance requires an explicit existing Python environment", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "./tests/network-guard.ts", "scripts/litellm-check.ts"],
    {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set GATEWAY_LITELLM_PYTHON/);
  assert(!result.stdout.includes('"passed":true'));
});

test("daily LiteLLM example requires --local before loading model dependencies or credentials", () => {
  for (const args of [[], ["--direct"], ["--local", "--unknown"]]) {
    const result = spawnSync(
      process.env.GATEWAY_TEST_PYTHON ?? "python3",
      ["-I", "-B", "examples/litellm_client.py", ...args],
      {
        cwd: new URL("..", import.meta.url),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:.*--local/);
  }
});
