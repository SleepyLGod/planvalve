import { setTimeout as delay } from "node:timers/promises";
import { GatewayError } from "./types.ts";
interface Job {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
/** One FIFO sender; cancellations only remove work that has not started. */
export class Queue {
  jobs: Job[] = [];
  busy = false;
  paused = false;
  closed = false;
  lastStart = 0;
  capacity: number;
  waitMs: number;
  intervalMs: number;
  private pacing?: AbortController;
  private idleWaiters: (() => void)[] = [];
  constructor(capacity: number, waitMs: number, intervalMs: number) {
    this.capacity = capacity;
    this.waitMs = waitMs;
    this.intervalMs = intervalMs;
  }
  submit<T>(execute: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.paused || this.closed)
      return Promise.reject(
        new GatewayError(
          503,
          "gateway_paused",
          "The local sender is paused or closed",
        ),
      );
    if (this.jobs.length >= this.capacity)
      return Promise.reject(
        new GatewayError(429, "queue_full", "Local queue is full"),
      );
    if (signal.aborted)
      return Promise.reject(
        new GatewayError(
          499,
          "cancelled",
          "Client disconnected before execution",
        ),
      );
    return new Promise<T>((resolve, reject) => {
      const remove = (error: GatewayError) => {
        const index = this.jobs.indexOf(job);
        if (index < 0) return;
        this.jobs.splice(index, 1);
        job.cleanup();
        if (!this.jobs.length) this.pacing?.abort();
        reject(error);
      };
      const onAbort = () =>
        remove(
          new GatewayError(
            499,
            "cancelled",
            "Client disconnected while queued",
          ),
        );
      const timer = setTimeout(
        () =>
          remove(
            new GatewayError(
              429,
              "queue_expired",
              "Queue wait deadline exceeded",
            ),
          ),
        this.waitMs,
      );
      const job: Job = {
        execute,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.jobs.push(job);
      void this.pump();
    });
  }
  pause(): void {
    this.paused = true;
    this.pacing?.abort();
    for (const j of this.jobs.splice(0)) {
      j.cleanup();
      j.reject(
        new GatewayError(
          503,
          "gateway_paused",
          "Sender paused after an upstream failure",
        ),
      );
    }
  }
  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.jobs.length && !this.paused && !this.closed) {
        const gap = this.intervalMs - (Date.now() - this.lastStart);
        if (gap > 0) {
          this.pacing = new AbortController();
          try {
            await delay(gap, undefined, { signal: this.pacing.signal });
          } catch (error) {
            if (!this.pacing.signal.aborted) throw error;
          } finally {
            this.pacing = undefined;
          }
        }
        if (this.paused || this.closed) break;
        const job = this.jobs.shift();
        if (!job) continue;
        job.cleanup();
        this.lastStart = Date.now();
        try {
          job.resolve(await job.execute());
        } catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.busy = false;
      if (!this.jobs.length)
        for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.pause();
    if (this.busy)
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}
