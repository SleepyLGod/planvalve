import { AuthStore, AuthSession, beginLogin } from "./auth.ts";
import { loadConfig } from "./config.ts";
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (
    !["login", "status", "logout"].includes(command ?? "") ||
    (args.length !== 0 && !(args.length === 2 && args[0] === "--config"))
  )
    throw new Error(
      "Usage: npm run auth -- login|status|logout [--config file]",
    );
  const store = new AuthStore(loadConfig(args[1]).authPath);
  if (command === "status") {
    console.log(JSON.stringify(store.status()));
    return;
  }
  if (command === "logout") {
    const session = new AuthSession(store);
    try {
      const result = await session.logout();
      console.log(
        JSON.stringify({
          ...result,
          state: "signed-out",
          ...(!result.remoteRevoked
            ? {
                message:
                  "Local credentials cleared; remote revocation not confirmed. Disconnect this app in ChatGPT settings.",
              }
            : {}),
        }),
      );
    } finally {
      session.close();
    }
    return;
  }
  const login = await beginLogin(store);
  const cancel = () => login.cancel();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    console.log(
      "Open the official authorization page below. Login does not send any model requests.",
    );
    console.log(login.authorizationUrl);
    await login.done;
    console.log(
      JSON.stringify({
        state: "authorized",
        inferenceAttempts: 0,
        manageUsage: "https://chatgpt.com/#settings/Usage",
      }),
    );
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Authorization failed",
  );
  process.exitCode = 1;
});
