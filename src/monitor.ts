import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { StatusSnapshot, RequestPage } from "./types.ts";
export interface MonitorData {
  status: StatusSnapshot;
  page: RequestPage;
}
/** Monitoring is restricted to numeric loopback origins, including across redirects. */
export function localOrigin(input: string): string {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Monitor URL must be a numeric loopback origin, e.g. http://127.0.0.1:8787",
    );
  return url.origin;
}
export async function readMonitor(
  origin: string,
  scope: "current" | "all",
  before?: number,
  signal?: AbortSignal,
): Promise<MonitorData> {
  const base = localOrigin(origin);
  const get = async <T>(path: string): Promise<T> => {
    const timeout = AbortSignal.timeout(2000);
    const url = new URL(base + path);
    return new Promise<T>((resolve, reject) => {
      // Native direct requests ignore host/global fetch proxy configuration. Never follow redirects.
      const request = (url.protocol === "https:" ? httpsGet : httpGet)(
        url,
        {
          agent: false,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
        (response) => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            response.resume();
            reject(
              new Error(`Status query failed (HTTP ${response.statusCode})`),
            );
            return;
          }
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("error", reject);
          response.once("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once("error", reject);
    });
  };
  const status = await get<StatusSnapshot>("/_gateway/status");
  const query = new URLSearchParams({ limit: "50" });
  if (scope === "current") query.set("run_id", status.runId);
  if (before !== undefined) query.set("before", String(before));
  const page = await get<RequestPage>("/_gateway/requests?" + query);
  return { status, page };
}
