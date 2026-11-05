/** Fail tests on any attempted non-loopback socket or fetch. */
import net from "node:net";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
let violations = 0;
function allowed(host: unknown): boolean {
  return (
    typeof host === "string" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)
  );
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (
  this: net.Socket,
  ...args: any[]
): any {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const second = Array.isArray(args[0]) ? args[0][1] : args[1];
  const host =
    typeof first === "object" && first !== null
      ? (first.host ?? "localhost")
      : typeof second === "string"
        ? second
        : "localhost";
  if (!allowed(host)) {
    violations++;
    throw new Error(`OFFLINE_NETWORK_DENIED: ${host}`);
  }
  return Reflect.apply(originalConnect, this, args);
} as typeof originalConnect;
// Numeric loopback lookup is local. Explicit DNS resolvers are always denied.
for (const target of [
  dns,
  dnsPromises,
  dns.Resolver.prototype,
  dnsPromises.Resolver.prototype,
] as unknown as Record<string, unknown>[]) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (
      key === "lookup" ||
      key.startsWith("resolve") ||
      key === "reverse" ||
      key === "lookupService"
    ) {
      const original = target[key];
      if (typeof original !== "function") continue;
      target[key] = function (host: unknown, ...args: unknown[]) {
        if (key !== "lookup" || !allowed(host) || host === "localhost") {
          violations++;
          throw new Error(`OFFLINE_NETWORK_DENIED: DNS ${host}`);
        }
        return Reflect.apply(original, target, [host, ...args]);
      };
    }
  }
}
dgram.Socket.prototype.send = function () {
  violations++;
  throw new Error("OFFLINE_NETWORK_DENIED: UDP disabled");
} as typeof dgram.Socket.prototype.send;
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowed(url.hostname)) {
    violations++;
    throw new Error(`OFFLINE_NETWORK_DENIED: ${url.hostname}`);
  }
  return originalFetch(input, init);
}) as typeof fetch;
process.once("exit", () =>
  assert.equal(violations, 0, "A non-loopback connection was attempted"),
);
