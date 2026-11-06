// Run against the local gateway by default. --direct explicitly uses the paid/credited API.
import OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { readLocalProfile } from "../src/local-profile.ts";
import { request } from "node:http";
const args = process.argv.slice(2);
if (args.some((arg) => !["--direct", "--local"].includes(arg)))
  throw new Error("Use --local or --direct");
const direct = args.includes("--direct"),
  local = args.includes("--local");
if (direct && local) throw new Error("Cannot combine --local and --direct");
const profile = local
  ? readLocalProfile(fileURLToPath(new URL("..", import.meta.url)))
  : undefined;
// Local calls must not send the bearer or prompt through an environment proxy.
const loopbackFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("Expected a local gateway URL");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        agent: false,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers,
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
};
const client = new OpenAI({
  baseURL: profile
    ? profile.url + "/v1"
    : direct
      ? "https://api.openai.com/v1"
      : "http://127.0.0.1:8787/v1",
  apiKey: profile
    ? profile.localKey
    : direct
      ? process.env.OPENAI_API_KEY
      : process.env.GATEWAY_LOCAL_API_KEY || "offline-test",
  maxRetries: 0,
  ...(direct ? {} : { fetch: loopbackFetch }),
});
const result = await client.chat.completions.create({
  model: profile?.config.model ?? process.env.MODEL ?? "offline-model",
  messages: [{ role: "user", content: "Return JSON with answer equal to 2." }],
  response_format: { type: "json_object" },
});
console.log(
  JSON.stringify(
    { text: result.choices[0]?.message.content, usage: result.usage },
    null,
    2,
  ),
);
