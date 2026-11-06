/** Execute the installed Python client with writes restricted to this project. */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGateway } from "../src/gateway.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const python = process.env.GATEWAY_LOTUS_PYTHON;
if (!python)
  throw new Error(
    "Set GATEWAY_LOTUS_PYTHON to a Python environment with LOTUS, LiteLLM and pandas installed.",
  );
mkdirSync(new URL("../reports", import.meta.url), { recursive: true });
const gateway = createGateway({
  port: 0,
  profile: "lotus",
  databasePath: ":memory:",
});
const url = await gateway.listen();
try {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      python,
      [
        "-I",
        "-B",
        fileURLToPath(new URL("./lotus-client.py", import.meta.url)),
        url,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...(process.env.GATEWAY_LOTUS_REPO
            ? { GATEWAY_LOTUS_REPO: process.env.GATEWAY_LOTUS_REPO }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      resolve(code ?? 1);
    });
  });
  writeFileSync(
    new URL("../reports/lotus-gateway.json", import.meta.url),
    JSON.stringify(gateway.report(), null, 2) + "\n",
    { mode: 0o600 },
  );
  if (code !== 0 || gateway.mock.calls !== 3) process.exitCode = 1;
} finally {
  await gateway.close();
}
