import { test } from "node:test";
import assert from "node:assert/strict";
import { rateDecision, rateHeaders } from "../src/rate-limit.ts";
const now = Date.parse("Fri, 06 Nov 2026 12:00:00 GMT");

test("reliable retry hints survive missing or malformed reset, and valid later resets win", () => {
  for (const reset of [undefined, "garbage", "-2s"]) {
    const headers = {
      "retry-after": "60",
      "x-ratelimit-remaining-requests": "0",
      ...(reset ? { "x-ratelimit-reset-requests": reset } : {}),
    };
    assert.deepEqual(rateDecision(429, "rate_limit_exceeded", headers, now), {
      action: "cooldown",
      delayMs: 60000,
      reason: "rate_limit_exceeded",
      slowDown: false,
    });
  }
  assert.equal(
    (
      rateDecision(
        429,
        "slow_down",
        {
          "retry-after": "1",
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-reset-tokens": "1m2.5s",
        },
        now,
      ) as any
    ).delayMs,
    62500,
  );
});
test("HTTP dates use server time and reset durations require a complete valid value", () => {
  assert.equal(
    (
      rateDecision(
        503,
        "server_is_overloaded",
        {
          date: "Fri, 06 Nov 2026 11:00:00 GMT",
          "retry-after": "Fri, 06 Nov 2026 11:00:10 GMT",
        },
        now,
      ) as any
    ).delayMs,
    10000,
  );
  for (const [reset, want] of [
    ["250ms", 250],
    ["1h2m3s4ms", 3723004],
    ["1.1ms", 2],
  ] as const)
    assert.equal(
      (
        rateDecision(
          200,
          undefined,
          {
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-reset-requests": reset,
          },
          now,
        ) as any
      ).delayMs,
      want,
    );
  for (const reset of ["1m1m", "1s2m", "2s junk", "-1s", "NaNs", "1", ""])
    assert.equal(
      rateDecision(
        429,
        "rate_limit_exceeded",
        {
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": reset,
        },
        now,
      ).action,
      "pause",
    );
});
test("quota and permission errors override hints, absent details stay unknown", () => {
  for (const [status, code] of [
    [429, "subscription_sharing_usage_limit_exceeded"],
    [429, "insufficient_quota"],
    [429, "credit_balance_exhausted"],
    [401, "rate_limit_exceeded"],
    [403, "slow_down"],
    [503, "unknown_error"],
    [200, "subscription_sharing_usage_limit_exceeded"],
  ] as const)
    assert.equal(
      rateDecision(status, code, { "retry-after": "1" }, now).action,
      "pause",
    );
  assert.deepEqual(rateDecision(200, undefined, {}, now), { action: "none" });
  assert.equal(
    rateDecision(429, "rate_limit_exceeded", {}, now).action,
    "pause",
  );
  assert.equal(
    rateDecision(429, "slow_down", { "retry-after": "2147483648" }, now).action,
    "pause",
  );
  assert.equal(
    rateDecision(
      200,
      undefined,
      { "x-ratelimit-remaining-requests": "invalid" },
      now,
    ).action,
    "none",
  );
});
test("only bounded printable rate headers are retained", () => {
  const headers = new Headers({
    authorization: "private",
    "set-cookie": "private",
    "retry-after": "1",
    "x-ratelimit-limit-tokens": "100",
    "x-ratelimit-reset-requests": "a".repeat(300),
  });
  const kept = rateHeaders(headers);
  assert.equal(kept.authorization, undefined);
  assert.equal(kept["set-cookie"], undefined);
  assert.equal(kept["retry-after"], "1");
  assert.equal(kept["x-ratelimit-reset-requests"], "[invalid]");
});
