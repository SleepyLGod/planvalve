import OpenAI from "openai";
/** Keep SDK constructor defaults from consulting the host credential environment. */
export function offlineSDK(fetch: typeof globalThis.fetch): OpenAI {
  const environment = process.env;
  try {
    // Synchronous, before the server starts. Do not inspect or copy host variables.
    process.env = Object.create(null) as NodeJS.ProcessEnv;
    return new OpenAI({
      apiKey: "offline-fixture-not-a-credential",
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      logLevel: "off",
      baseURL: "http://offline.invalid/v1",
      maxRetries: 0,
      fetch,
    });
  } finally {
    process.env = environment;
  }
}
