import type { RateDecision } from "./types.ts";
const maximumDelay = 2147483647;
const buckets = ["requests", "tokens", "project-tokens"];
const names = [
  "date",
  "retry-after",
  ...buckets.flatMap((bucket) =>
    ["limit", "remaining", "reset"].map(
      (field) => `x-ratelimit-${field}-${bucket}`,
    ),
  ),
];

/** Never retain arbitrary upstream headers (cookies or authorization). */
export function rateHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = headers.get(name);
      return value === null
        ? []
        : [[name, /^[\x20-\x7e]{1,256}$/.test(value) ? value : "[invalid]"]];
    }),
  );
}
function duration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const units = ["d", "h", "m", "s", "ms"];
  const factors = [86400000, 3600000, 60000, 1000, 1];
  let end = 0,
    previous = -1,
    total = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)) {
    const index = units.indexOf(match[2]!);
    if (match.index !== end || index <= previous) return undefined;
    previous = index;
    end += match[0].length;
    total += Number(match[1]) * factors[index]!;
  }
  return end === value.length && Number.isFinite(total)
    ? Math.ceil(total)
    : undefined;
}
function httpDate(value: string | undefined): number | undefined {
  if (
    !value ||
    !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toUTCString() === value
    ? n
    : undefined;
}
/** Classify errors before interpreting timing; a hint cannot make quota recoverable. */
export function rateDecision(
  status: number,
  code: string | undefined,
  headers: Record<string, string>,
  nowWallMs: number,
): RateDecision {
  const rateCode = code === "rate_limit_exceeded" || code === "slow_down";
  const unavailableCode =
    code === "server_is_overloaded" ||
    code === "subscription_sharing_usage_unavailable";
  const temporary =
    (rateCode && (status === 429 || status === 200)) ||
    (unavailableCode && (status === 503 || status === 200));
  const failed = status >= 400 || code !== undefined;
  if (status === 401 || status === 403 || (failed && !temporary))
    return { action: "pause", reason: code ?? `upstream_http_${status}` };
  const delays: number[] = [];
  const exhausted = buckets.some((bucket) =>
    /^0+$/.test(headers[`x-ratelimit-remaining-${bucket}`] ?? ""),
  );
  if (!failed && !exhausted) return { action: "none" };
  const retry = headers["retry-after"];
  if (retry !== undefined) {
    if (/^\d+$/.test(retry)) delays.push(Number(retry) * 1000);
    else {
      const date = httpDate(retry);
      if (date !== undefined)
        delays.push(Math.max(0, date - (httpDate(headers.date) ?? nowWallMs)));
    }
  }
  for (const bucket of buckets) {
    const remaining = headers[`x-ratelimit-remaining-${bucket}`];
    if (remaining === undefined || !/^0+$/.test(remaining)) continue;
    const ms = duration(headers[`x-ratelimit-reset-${bucket}`]);
    if (ms !== undefined) delays.push(ms);
  }
  if (delays.some((ms) => !Number.isFinite(ms) || ms > maximumDelay))
    return { action: "pause", reason: "rate_limit_delay_unsupported" };
  if (delays.length)
    return {
      action: "cooldown",
      delayMs: Math.max(...delays),
      reason: code ?? "upstream_rate_limit",
      slowDown: code === "slow_down",
    };
  if (failed || exhausted)
    return { action: "pause", reason: code ?? "rate_limit_hint_missing" };
  return { action: "none" };
}
