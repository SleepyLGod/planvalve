import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { AuthStore, AuthSession } from "./auth.ts";
import { createGateway } from "./gateway.ts";
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--config")) {
  console.error("Usage: npm start -- [--config path/to/config.json]");
  process.exitCode = 1;
} else {
  let subscription: AuthSession | undefined;
  let closeOnError: (() => Promise<void>) | undefined;
  try {
    const config = loadConfig(args[1]);
    if (config.upstream === "chatgpt-subscription") {
      subscription = new AuthSession(new AuthStore(config.authPath));
      if (subscription.status().state === "login-required")
        throw new Error(
          "Subscription login required; run npm run auth -- login with the same config",
        );
    }
    const gateway = createGateway(config, undefined, { subscription });
    closeOnError = gateway.close;
    const save = () => {
      const file = resolve(config.reportPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(gateway.report(), null, 2) + "\n", {
        mode: 0o600,
      });
    };
    gateway.server.on("ledgerChanged", () => {
      try {
        save();
      } catch (error) {
        console.error(
          "Report write failed:",
          error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
        void gateway
          .close()
          .catch((error) => console.error("Close failed:", String(error)));
      }
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await gateway.close();
        save();
      } catch (error) {
        console.error(
          "Shutdown failed:",
          error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    const url = await gateway.listen();
    save();
    console.log(
      JSON.stringify({
        mode: gateway.status().mode,
        upstream: config.upstream,
        url,
        model: config.model ?? "offline-model",
        report: resolve(config.reportPath),
        database:
          config.databasePath === ":memory:"
            ? ":memory:"
            : resolve(config.databasePath),
      }),
    );
  } catch (error) {
    subscription?.close();
    await closeOnError?.().catch((cleanupError) =>
      console.error("Cleanup failed:", String(cleanupError)),
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
