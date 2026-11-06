import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Queue } from "../src/queue.ts";

test("queue bounds 64 tasks with configurable concurrency and FIFO starts", async () => {
  for (const concurrency of [1, 2, 4]) {
    const q = new Queue({
      concurrency,
      queueCapacity: 64,
      maxQueueWaitMs: 5000,
    });
    let active = 0,
      peak = 0;
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        q.submit(async () => {
          active++;
          peak = Math.max(peak, active);
          starts.push(i);
          await delay(2);
          active--;
        }, new AbortController().signal),
      ),
    );
    assert.equal(peak, concurrency);
    assert.deepEqual(
      starts,
      Array.from({ length: 64 }, (_, i) => i),
    );
    await q.close();
  }
});
test("queue settles cancellation, capacity, expiry and close without releasing active work early", async () => {
  const q = new Queue({ concurrency: 1, queueCapacity: 1, maxQueueWaitMs: 15 });
  let release!: () => void;
  const first = q.submit(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    new AbortController().signal,
  );
  const abort = new AbortController();
  const queued = q.submit(
    async () => assert.fail("cancelled task ran"),
    abort.signal,
  );
  await assert.rejects(
    q.submit(async () => {}, new AbortController().signal),
    /full/,
  );
  abort.abort();
  await assert.rejects(queued, /disconnect/);
  await assert.rejects(
    q.submit(
      async () => assert.fail("expired task ran"),
      new AbortController().signal,
    ),
    /deadline/,
  );
  let closed = false;
  const stopping = q.close().then(() => {
    closed = true;
  });
  await delay(2);
  assert.equal(closed, false);
  release();
  await first;
  await stopping;
});
