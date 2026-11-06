import { test } from "node:test";
import assert from "node:assert/strict";
import { DispatchControl } from "../src/dispatch.ts";

test("dispatch paces actual sends smoothly and releases admission before network completion", async () => {
  let now = 0;
  const control = new DispatchControl(
    { minStartIntervalMs: 0, maxRequestsPerMinute: 20 },
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    () => 0,
  );
  const starts: number[] = [];
  let finish!: () => void;
  const first = control.run(
    new AbortController().signal,
    async () => {
      now += 10;
      return "token";
    },
    () => {
      starts.push(now);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  await control.run(
    new AbortController().signal,
    async () => "token",
    async () => {
      starts.push(now);
    },
  );
  assert.deepEqual(starts, [10, 3010]);
  finish();
  await first;
  assert.equal(control.snapshot().effectiveStartIntervalMs, 3000);
});
test("failed preparation and unsent expiry do not poison admission or clear cooldown", async () => {
  const control = new DispatchControl(
    { minStartIntervalMs: 20, maxRequestsPerMinute: null },
    undefined,
    () => 0,
  );
  await assert.rejects(
    control.run(
      new AbortController().signal,
      async () => {
        throw Error("preparation");
      },
      async () => {},
    ),
    /preparation/,
  );
  control.apply({
    action: "cooldown",
    delayMs: 45,
    reason: "rate_limit_exceeded",
    slowDown: false,
  });
  let sends = 0;
  await assert.rejects(
    control.run(
      AbortSignal.timeout(5),
      async () => "token",
      async () => {
        sends++;
      },
    ),
  );
  assert.equal(sends, 0);
  assert.equal(control.snapshot().state, "cooldown");
  await control.run(
    AbortSignal.timeout(2000),
    async () => "token",
    async () => {
      sends++;
    },
  );
  assert.equal(sends, 1);
});
test("later cooldown and hard pause survive unrelated success decisions", () => {
  let now = 0;
  const control = new DispatchControl(
    { minStartIntervalMs: 0, maxRequestsPerMinute: null },
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    () => 0,
  );
  control.apply({
    action: "cooldown",
    delayMs: 100,
    reason: "rate_limit_exceeded",
    slowDown: false,
  });
  control.apply({
    action: "cooldown",
    delayMs: 10,
    reason: "rate_limit_exceeded",
    slowDown: false,
  });
  control.apply({ action: "none" });
  assert.equal(control.snapshot().waitMs, 100);
  control.pause("insufficient_quota");
  control.apply({ action: "none" });
  assert.equal(control.snapshot().state, "paused");
});
test("slow_down reduces this run's pace without changing concurrency or resetting after success", () => {
  const control = new DispatchControl(
    { minStartIntervalMs: 3000, maxRequestsPerMinute: 20 },
    undefined,
    () => 0,
  );
  control.apply({
    action: "cooldown",
    delayMs: 0,
    reason: "slow_down",
    slowDown: true,
  });
  assert.equal(control.snapshot().effectiveStartIntervalMs, 6000);
  control.apply({ action: "none" });
  assert.equal(control.snapshot().effectiveStartIntervalMs, 6000);
  control.apply({
    action: "cooldown",
    delayMs: 0,
    reason: "slow_down",
    slowDown: true,
  });
  assert.equal(control.snapshot().effectiveStartIntervalMs, 12000);
});
