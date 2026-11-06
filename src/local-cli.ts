import { constants } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  initializeLocalProfile,
  readLocalProfile,
  type LocalUpstream,
} from "./local-profile.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const usage =
  "Usage: npm run local -- init --model MODEL [--upstream chatgpt-subscription|openai-api-key] | start | status [--lang zh|en] [--once|--json]";
async function delegate(
  entry: string,
  args: string[],
  key: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [resolve(root, "src", entry), ...args],
    {
      cwd: root,
      env: { ...process.env, GATEWAY_LOCAL_API_KEY: key },
      stdio: "inherit",
    },
  );
  const interrupt = () => {
    child.kill("SIGINT");
  };
  const terminate = () => {
    child.kill("SIGTERM");
  };
  const resize = () => {
    child.kill("SIGWINCH");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGWINCH", resize);
  try {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("Unable to start local gateway command")),
      );
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.exitCode =
      result.code ??
      (result.signal ? 128 + constants.signals[result.signal] : 1);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("SIGWINCH", resize);
  }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "init") {
    let model: string | undefined, upstream: LocalUpstream | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i],
        value = args[i + 1];
      if (
        !["--model", "--upstream"].includes(flag ?? "") ||
        !value ||
        value.startsWith("--") ||
        seen.has(flag!)
      )
        throw new Error(usage);
      seen.add(flag!);
      if (flag === "--model") model = value;
      else upstream = value as LocalUpstream;
    }
    if (!model) throw new Error(usage);
    console.log(
      JSON.stringify(initializeLocalProfile(root, { model, upstream })),
    );
    return;
  }
  if (command !== "start" && command !== "status") throw new Error(usage);
  if (command === "start" && args.length) throw new Error(usage);
  if (command === "status")
    for (let i = 0; i < args.length; i++) {
      if (["--once", "--json"].includes(args[i]!)) continue;
      if (args[i] === "--lang" && ["zh", "en"].includes(args[i + 1] ?? "")) {
        i++;
        continue;
      }
      throw new Error(usage);
    }
  const profile = readLocalProfile(root);
  await delegate(
    command === "start" ? "cli.ts" : "status-cli.ts",
    command === "start"
      ? ["--config", profile.configPath]
      : ["--url", profile.url, ...args],
    profile.localKey,
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Local command failed",
  );
  process.exitCode = 1;
});
