import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Config } from "./types.ts";
export const defaults: Config = {
  upstream: "offline",
  model: null,
  authPath: "data/auth/session.json",
  port: 8787,
  fixturePath: fileURLToPath(
    new URL("../fixtures/observed-json.json", import.meta.url),
  ),
  queueCapacity: 64,
  maxQueueWaitMs: 60000,
  minStartIntervalMs: 0,
  upstreamTimeoutMs: 120000,
  maxRequests: null,
  stopAfterTokens: null,
  profile: "strict",
  reportPath: "reports/latest.json",
  databasePath: "data/gateway.sqlite",
};
export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration must be an object");
  const c = { ...defaults, ...value } as Config;
  if (
    !["offline", "chatgpt-subscription", "openai-api-key"].includes(c.upstream)
  )
    throw new Error("Invalid upstream");
  if (c.model !== null && (typeof c.model !== "string" || !c.model.trim()))
    throw new Error("Invalid model");
  if (c.upstream !== "offline" && c.model === null)
    throw new Error("Real upstream requires an explicit model");
  if (!Object.hasOwn(value, "minStartIntervalMs") && c.upstream !== "offline")
    c.minStartIntervalMs = 3000;
  for (const key of Object.keys(value))
    if (!Object.hasOwn(defaults, key))
      throw new Error(`Unknown configuration field: ${key}`);
  for (const key of [
    "port",
    "queueCapacity",
    "maxQueueWaitMs",
    "minStartIntervalMs",
    "upstreamTimeoutMs",
  ] as const) {
    const n = c[key];
    if (
      !Number.isSafeInteger(n) ||
      n < (key === "port" || key === "minStartIntervalMs" ? 0 : 1)
    )
      throw new Error(`Invalid ${key}`);
  }
  for (const key of [
    "maxQueueWaitMs",
    "minStartIntervalMs",
    "upstreamTimeoutMs",
  ] as const)
    if (c[key] > 2147483647)
      throw new Error(`Timer exceeds supported range: ${key}`);
  if (c.port > 65535) throw new Error("Invalid port");
  for (const key of ["maxRequests", "stopAfterTokens"] as const)
    if (c[key] !== null && (!Number.isSafeInteger(c[key]) || c[key]! <= 0))
      throw new Error(`Invalid ${key}`);
  if (!["strict", "lotus"].includes(c.profile))
    throw new Error("Invalid profile");
  for (const key of [
    "fixturePath",
    "reportPath",
    "databasePath",
    "authPath",
  ] as const)
    if (typeof c[key] !== "string" || !c[key] || /^https?:/i.test(c[key]))
      throw new Error(`Invalid local path: ${key}`);
  return c;
}
export function loadConfig(path?: string): Config {
  const c = validateConfig(path ? JSON.parse(readFileSync(path, "utf8")) : {});
  if (path) {
    const directory = resolve(path, "..");
    c.fixturePath = resolve(directory, c.fixturePath);
    c.reportPath = resolve(directory, c.reportPath);
    if (c.databasePath !== ":memory:")
      c.databasePath = resolve(directory, c.databasePath);
    c.authPath = resolve(directory, c.authPath);
  }
  return c;
}
