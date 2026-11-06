import { setTimeout as delay } from "node:timers/promises";
import {
  GatewayError,
  type Config,
  type DispatchSnapshot,
  type RateDecision,
} from "./types.ts";

export interface DispatchClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
const maximumDelay = 2147483647;
const realClock: DispatchClock = {
  now: () => performance.now(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
};
/** Aborting a waiter does not cancel the shared operation it was waiting for. */
function wait<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  cancellable: () => boolean = () => true,
): Promise<T> {
  if (signal.aborted && cancellable()) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (cancellable()) reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
/** Serial admission only; the network promise is awaited outside the critical section. */
export class DispatchControl {
  private tail: Promise<unknown> = Promise.resolve();
  private lastSend = -Infinity;
  private until = -Infinity;
  private reason: string | null = null;
  private slowdown = 0;
  private paused = false;
  private closed = false;
  private stop = new AbortController();
  private config: Pick<Config, "minStartIntervalMs" | "maxRequestsPerMinute">;
  private clock: DispatchClock;
  private random: () => number;
  constructor(
    config: Pick<Config, "minStartIntervalMs" | "maxRequestsPerMinute">,
    clock: DispatchClock = realClock,
    random: () => number = Math.random,
  ) {
    this.config = config;
    this.clock = clock;
    this.random = random;
  }
  private interval(): number {
    return Math.max(
      this.config.minStartIntervalMs,
      this.config.maxRequestsPerMinute === null
        ? 0
        : Math.ceil(60000 / this.config.maxRequestsPerMinute),
      this.slowdown,
    );
  }
  snapshot(): DispatchSnapshot {
    const now = this.clock.now();
    const gap = Math.max(
      0,
      this.lastSend + this.interval() - now,
      this.until - now,
    );
    return {
      state: this.closed
        ? "closed"
        : this.paused
          ? "paused"
          : this.until > now
            ? "cooldown"
            : gap > 0
              ? "spacing"
              : "ready",
      waitMs: Math.ceil(gap),
      reason:
        this.paused || this.until > now
          ? this.reason
          : gap > 0
            ? "min_start_interval"
            : null,
      effectiveStartIntervalMs: this.interval(),
      maxRequestsPerMinute: this.config.maxRequestsPerMinute,
    };
  }
  apply(decision: RateDecision): RateDecision {
    if (decision.action === "none") return decision;
    if (this.paused || this.closed)
      return { action: "pause", reason: this.reason ?? "gateway_paused" };
    if (decision.action === "pause") {
      this.pause(decision.reason);
      return decision;
    }
    if (decision.slowDown) this.slowdown = 2 * Math.max(1000, this.interval());
    const waitMs = Math.ceil(decision.delayMs + this.random() * 250);
    if (waitMs > maximumDelay || this.interval() > maximumDelay) {
      this.pause("rate_limit_delay_unsupported");
      return { action: "pause", reason: "rate_limit_delay_unsupported" };
    }
    const deadline = this.clock.now() + waitMs;
    if (deadline > this.until) {
      this.until = deadline;
      this.reason = decision.reason;
    }
    return decision;
  }
  pause(reason: string): void {
    this.paused = true;
    this.reason = reason;
    this.stop.abort();
  }
  close(): void {
    this.closed = true;
    this.stop.abort();
  }
  async run<T, R>(
    signal: AbortSignal,
    prepare: (signal: AbortSignal) => Promise<T>,
    start: (value: T) => Promise<R>,
  ): Promise<R> {
    const waiting = AbortSignal.any([signal, this.stop.signal]);
    const check = () => {
      if (this.closed || this.paused)
        throw new GatewayError(
          503,
          "gateway_paused",
          "The local sender is paused or closed",
        );
      signal.throwIfAborted();
    };
    check();
    let started = false;
    const turn = this.tail.then(async () => {
      for (;;) {
        check();
        const ms = this.snapshot().waitMs;
        if (ms > 0) {
          await this.clock.sleep(ms, waiting);
          continue;
        }
        const prepared = await wait(prepare(waiting), waiting);
        check();
        if (this.snapshot().waitMs > 0) continue;
        // start persists/checks the budget synchronously, then immediately invokes fetch.
        started = true;
        const pending = start(prepared);
        this.lastSend = this.clock.now();
        return { pending }; // Do not await network headers with admission held.
      }
    });
    this.tail = turn.then(
      () => undefined,
      () => undefined,
    );
    const { pending } = await wait(turn, signal, () => !started).catch(
      (error: unknown) => {
        if (error instanceof GatewayError) throw error;
        check();
        throw error;
      },
    );
    return pending;
  }
}
