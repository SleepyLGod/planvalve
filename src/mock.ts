import { setTimeout as delay } from "node:timers/promises";
import type { Fixture, ObjectValue } from "./types.ts";
export interface MockOptions {
  chunkSize?: number;
  contentType?: string | null;
  mockDelayMs?: number;
}
export class MockTransport {
  calls = 0;
  active = 0;
  maxActive = 0;
  startTimes: number[] = [];
  lastRequest?: ObjectValue;
  fixture: Fixture;
  options: MockOptions;
  constructor(fixture: Fixture, options: MockOptions = {}) {
    this.fixture = fixture;
    this.options = options;
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "http://offline.invalid" ||
      url.pathname !== "/v1/responses" ||
      init?.method !== "POST"
    )
      throw new Error("Unexpected mock SDK request");
    this.calls++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.startTimes.push(Date.now());
    this.lastRequest = JSON.parse(String(init.body));
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        this.active--;
      }
    };
    const signal = init.signal ?? undefined;
    try {
      if (this.options.mockDelayMs)
        await delay(this.options.mockDelayMs, undefined, {
          ...(signal ? { signal } : {}),
        });
    } catch (e) {
      finish();
      throw e;
    }
    const bytes = new TextEncoder().encode(
      this.fixture.events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
    let offset = 0;
    const size = this.options.chunkSize ?? 4096;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          finish();
          controller.error(signal.reason);
          return;
        }
        if (offset >= bytes.length) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
      cancel() {
        finish();
      },
    });
    const headers = new Headers();
    if (this.options.contentType)
      headers.set("content-type", this.options.contentType);
    return new Response(stream, { status: 200, headers });
  };
}
