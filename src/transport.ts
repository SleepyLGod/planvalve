/** Own the body reader so SDK early-return cannot release a slot before cancellation settles. */
export function trackResponse(response: Response): {
  response: Response;
  settle: () => Promise<void>;
} {
  if (!response.body) return { response, settle: async () => {} };
  const reader = response.body.getReader();
  let ended = false;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason?: unknown): Promise<void> => {
    if (cancellation) return cancellation;
    if (ended) return Promise.resolve();
    ended = true;
    cancellation = reader.cancel(reason).finally(() => reader.releaseLock());
    // SDK may stop awaiting cancel; settle() below still propagates its actual result.
    void cancellation.catch(() => {});
    return cancellation;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (ended) return;
        if (item.done) {
          ended = true;
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(item.value);
      } catch (error) {
        if (!ended) {
          ended = true;
          reader.releaseLock();
          controller.error(error);
        }
      }
    },
    cancel(reason) {
      // Let SDK errors propagate now; settle() still owns the real cleanup and slot lifetime.
      void cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    settle: () => cancellation ?? cancel(),
  };
}
