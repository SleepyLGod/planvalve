import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.ts";
import type { Config } from "./types.ts";
export type LocalUpstream = "chatgpt-subscription" | "openai-api-key";
/** Validate only this tool's private storage; never chmod shared existing directories. */
function directory(path: string, create: boolean, privateOnly: boolean): void {
  if (!existsSync(path)) {
    if (!create)
      throw new Error(
        "Local profile missing; run npm run local -- init --model MODEL",
      );
    mkdirSync(path, { mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    throw new Error("Local profile directory must not be a symlink");
  if (!stat.isDirectory())
    throw new Error("Local profile path is not a directory");
  if (
    privateOnly &&
    ((stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()))
  )
    throw new Error(
      "Local profile directory requires private owner-only permissions",
    );
}
function storage(root: string, create: boolean): string {
  directory(root, false, false);
  directory(resolve(root, "data"), create, false);
  const path = resolve(root, "data/local");
  directory(path, create, true);
  return path;
}
function privateFile(path: string): void {
  if (!existsSync(path))
    throw new Error("Local profile incomplete; config and key must both exist");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error("Local profile file must not be a symlink or special file");
  if (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error(
      "Local profile file requires private owner-only permissions",
    );
}
export interface LocalProfile {
  config: Config;
  configPath: string;
  localKey: string;
  url: string;
}
/** Load a profile without consulting environment variables or subscription credentials. */
export function readLocalProfile(root: string): LocalProfile {
  const path = storage(resolve(root), false),
    configPath = resolve(path, "gateway.json"),
    keyPath = resolve(path, "client.key");
  privateFile(configPath);
  privateFile(keyPath);
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch {
    throw new Error(
      "Invalid local profile configuration; existing files were not changed",
    );
  }
  if (
    !["chatgpt-subscription", "openai-api-key"].includes(config.upstream) ||
    config.port === 0
  )
    throw new Error(
      "Local profile requires a real upstream and a fixed loopback port",
    );
  const localKey = readFileSync(keyPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(localKey))
    throw new Error("Invalid local key; existing files were not changed");
  return {
    config,
    configPath,
    localKey,
    url: `http://127.0.0.1:${config.port}`,
  };
}
/** Create once, reuse unchanged, and never replace credentials or conflicting profiles. */
export function initializeLocalProfile(
  root: string,
  options: { model: string; upstream?: LocalUpstream },
) {
  if (typeof options.model !== "string" || !options.model.trim())
    throw new Error("Specify a nonempty model");
  const upstream = options.upstream ?? "chatgpt-subscription";
  if (!["chatgpt-subscription", "openai-api-key"].includes(upstream))
    throw new Error("Invalid local upstream");
  const path = storage(resolve(root), true),
    configPath = resolve(path, "gateway.json"),
    keyPath = resolve(path, "client.key");
  let created = false;
  if (existsSync(configPath) || existsSync(keyPath)) {
    const existing = readLocalProfile(root);
    if (
      existing.config.model !== options.model ||
      existing.config.upstream !== upstream
    )
      throw new Error(
        "Existing local profile conflicts with requested model/upstream; no files changed",
      );
  } else {
    const config = {
      upstream,
      model: options.model,
      port: 8787,
      profile: "strict",
      minStartIntervalMs: 3000,
      maxRequests: 1000,
      stopAfterTokens: 100000,
      authPath: "../auth/session.json",
      databasePath: "../gateway.sqlite",
      reportPath: "../../reports/local.json",
    };
    // Exclusive creates cannot overwrite another initializer's key. A partial failure stays explicit.
    writeFileSync(keyPath, randomBytes(32).toString("hex") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    created = true;
  }
  const profile = readLocalProfile(root);
  return {
    created,
    upstream: profile.config.upstream,
    model: profile.config.model,
    url: profile.url,
    configPath: profile.configPath,
  };
}
