/** Explicit one-shot probe only. Default server configuration never constructs this transport. */
export function subscriptionFetch(
  token: string,
  beforeSend: (attempt: number, body: string) => void,
  afterResponse: (attempt: number, response: Response) => void | Promise<void>,
  send: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  let attempts = 0;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.href !== "http://offline.invalid/v1/responses" ||
      init?.method !== "POST"
    )
      throw new Error("Unexpected probe SDK request");
    if (attempts >= 2)
      throw new Error("Two-request probe cap reached; no retry allowed");
    const serialized = String(init.body),
      body = JSON.parse(serialized);
    if (
      body.store !== false ||
      body.stream !== true ||
      typeof body.model !== "string"
    )
      throw new Error("Probe requires stateless streaming Responses");
    const attempt = ++attempts;
    beforeSend(attempt, serialized);
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + token);
    const response = await send("https://api.openai.com/v1/responses", {
      ...init,
      headers,
      redirect: "error",
    });
    await afterResponse(attempt, response);
    return response;
  };
}
