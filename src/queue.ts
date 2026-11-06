import PQueue from "p-queue";
import { GatewayError, type Config } from "./types.ts";
/** One task queue. Its slots stay occupied until execution and persistence settle. */
export class Queue {
  private queue: PQueue;
  paused = false;
  closed = false;
  private config: Pick<
    Config,
    "concurrency" | "queueCapacity" | "maxQueueWaitMs"
  >;
  constructor(
    config: Pick<Config, "concurrency" | "queueCapacity" | "maxQueueWaitMs">,
  ) {
    this.config = config;
    this.queue = new PQueue({ concurrency: config.concurrency });
  }
  stats() {
    return {
      running: this.queue.pending,
      waiting: this.queue.size,
      paused: this.paused,
      closed: this.closed,
    };
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
    if (this.queue.size >= this.config.queueCapacity)
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
    const waiting = new AbortController();
    const onAbort = () =>
      waiting.abort(
        new GatewayError(499, "cancelled", "Client disconnected while queued"),
      );
    const timer = setTimeout(
      () =>
        waiting.abort(
          new GatewayError(
            429,
            "queue_expired",
            "Queue wait deadline exceeded",
          ),
        ),
      this.config.maxQueueWaitMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return this.queue
      .add(
        async () => {
          cleanup(); // Never let the library release a running slot on a client's abort.
          return execute();
        },
        { signal: waiting.signal },
      )
      .catch((error: unknown) => {
        if (waiting.signal.aborted) throw waiting.signal.reason;
        if (
          error instanceof DOMException &&
          error.name === "AbortError" &&
          (this.paused || this.closed)
        )
          throw new GatewayError(
            503,
            "gateway_paused",
            "The local sender is paused or closed",
          );
        throw error;
      })
      .finally(cleanup);
  }
  pause(): void {
    this.paused = true;
    this.queue.pause();
    this.queue.clear();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.pause();
    await this.queue.onIdle();
  }
}
