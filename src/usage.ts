import type { LedgerRecord } from "./types.ts";
import { object } from "./compatibility.ts";
/** Sum only observed counts; detail counters are subsets, never added to total. */
export function summarizeUsage(records: LedgerRecord[]) {
  const result = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    unknownUsageRequests: 0,
    cached: { knownTokens: 0, unknownRequests: 0 },
    reasoning: { knownTokens: 0, unknownRequests: 0 },
    cacheWrite: { knownTokens: 0, unknownRequests: 0 },
  };
  for (const r of records) {
    if (!r.startedAt) continue;
    if (r.usage) {
      result.inputTokens += Number(r.usage.prompt_tokens);
      result.outputTokens += Number(r.usage.completion_tokens);
      result.totalTokens += Number(r.usage.total_tokens);
    } else if (!["queued", "running"].includes(r.status))
      result.unknownUsageRequests++;
    if (["queued", "running"].includes(r.status) && !r.usage) continue;
    const details = [
      ["cached", r.usage?.prompt_tokens_details, "cached_tokens"],
      ["reasoning", r.usage?.completion_tokens_details, "reasoning_tokens"],
      ["cacheWrite", r.rawUsage?.input_tokens_details, "cache_write_tokens"],
    ] as const;
    for (const [name, detail, key] of details) {
      const n = object(detail) ? detail[key] : undefined;
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
        result[name].knownTokens += n;
      else result[name].unknownRequests++;
    }
  }
  return result;
}
