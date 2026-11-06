import OpenAI from "openai";
import { isolatedSDK } from "./sdk.ts";
import { object, normalizeUsage } from "./compatibility.ts";
import { GatewayError, type LedgerRecord, type ObjectValue } from "./types.ts";
import { Redactor } from "./privacy.ts";
export interface CredentialSource {
  accessToken(signal?: AbortSignal): Promise<string>;
  status(): { state: string };
  close(): void;
}
/** Do not let a slow credential provider keep the FIFO occupied past its deadline. */
async function waitForToken(
  source: CredentialSource,
  signal?: AbortSignal | null,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const abort = () => reject(signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    source.accessToken(signal ?? undefined).then(
      (value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
export function captureUsage(
  record: LedgerRecord,
  raw: unknown,
  chat = false,
): void {
  if (!object(raw)) return;
  record.rawUsage = structuredClone(raw);
  try {
    const normalized = normalizeUsage(
      chat
        ? {
            input_tokens: raw.prompt_tokens,
            output_tokens: raw.completion_tokens,
            total_tokens: raw.total_tokens,
            input_tokens_details: raw.prompt_tokens_details,
            output_tokens_details: raw.completion_tokens_details,
          }
        : raw,
    );
    record.usage = normalized.usage;
    record.usageCompleteness = normalized.completeness;
  } catch {
    record.usageCompleteness = "missing";
  }
}
export async function responsesText(
  client: OpenAI,
  payload: ObjectValue,
  signal: AbortSignal,
  record: LedgerRecord,
): Promise<string> {
  let refused = false;
  let text = "",
    doneText: string | undefined,
    terminal: any;
  const stream = await client.responses.create(
    payload as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
    { signal },
  );
  record.headersAt ??= new Date().toISOString();
  for await (const event of stream) {
    if (signal.aborted)
      throw new GatewayError(
        502,
        "upstream_timeout",
        "Absolute upstream deadline exceeded",
      );
    if (event.type === "response.output_text.delta") {
      record.firstTextAt ??= new Date().toISOString();
      text += event.delta;
    } else if (
      event.type === "response.refusal.delta" ||
      event.type === "response.refusal.done"
    ) {
      refused = true;
    } else if (event.type === "response.output_text.done")
      doneText = event.text;
    else if (
      ["response.completed", "response.failed", "response.incomplete"].includes(
        event.type,
      )
    ) {
      terminal = event as any;
      record.terminalAt = new Date().toISOString();
      if (object(terminal.response?.error))
        record.upstreamError = {
          code:
            typeof terminal.response.error.code === "string" &&
            /^[a-zA-Z0-9_]{1,100}$/.test(terminal.response.error.code)
              ? terminal.response.error.code
              : "upstream_failed",
        };
      if (object(terminal.response?.incomplete_details))
        record.upstreamIncompleteDetails = structuredClone(
          terminal.response.incomplete_details,
        );
      captureUsage(record, terminal.response?.usage);
      break; // SDK iterator cleanup cancels the body; completion does not require EOF.
    } else if (event.type === "error")
      throw new GatewayError(
        502,
        "upstream_failed",
        "Explicit upstream error event",
      );
    if (text.length > 2 * 1024 * 1024)
      throw new GatewayError(
        502,
        "response_too_large",
        "Upstream text exceeds 2 MiB",
      );
  }
  if (!terminal)
    throw new GatewayError(
      502,
      signal.aborted ? "upstream_timeout" : "stream_interrupted",
      signal.aborted
        ? "Absolute upstream deadline exceeded"
        : "Stream ended without a terminal event",
    );
  if (
    terminal.type !== "response.completed" ||
    terminal.response?.status !== "completed"
  ) {
    const rawCode = terminal.response?.error?.code;
    const code =
      typeof rawCode === "string" && /^[a-zA-Z0-9_]{1,100}$/.test(rawCode)
        ? rawCode
        : terminal.type === "response.incomplete"
          ? "upstream_incomplete"
          : "upstream_failed";
    throw new GatewayError(
      code === "subscription_sharing_usage_limit_exceeded"
        ? 429
        : code === "subscription_sharing_usage_unavailable"
          ? 503
          : 502,
      code,
      "Upstream did not complete normally",
    );
  }
  if (
    refused ||
    (Array.isArray(terminal.response.output) &&
      terminal.response.output.some(
        (item: any) =>
          Array.isArray(item.content) &&
          item.content.some((part: any) => part.type === "refusal"),
      ))
  )
    throw new GatewayError(
      502,
      "upstream_refusal",
      "Upstream refused the request",
    );
  if (doneText !== undefined && text !== doneText)
    throw new GatewayError(
      502,
      "invalid_stream",
      "Text deltas disagree with done text",
    );
  if (!record.usage) normalizeUsage(record.rawUsage);
  return text;
}
/** Fixed official endpoints, explicit credentials, no SDK environment discovery or retries. */
export function officialUpstream(
  kind: "openai-api-key" | "chatgpt-subscription",
  credential: CredentialSource,
  send: typeof fetch,
  redact: Redactor,
) {
  let active: LedgerRecord | undefined;
  let dispatched = () => {};
  const path = kind === "openai-api-key" ? "/chat/completions" : "/responses";
  const client = isolatedSDK(async (input, init) => {
    if (
      String(input) !== "http://offline.invalid/v1" + path ||
      init?.method !== "POST"
    )
      throw new Error("Unexpected upstream destination");
    if (credential.status().state === "login-required")
      throw new GatewayError(
        401,
        "subscription_auth_required",
        "Subscription login required",
      );
    let token: string;
    try {
      token = await waitForToken(credential, init.signal);
    } catch {
      throw new GatewayError(
        503,
        credential.status().state === "login-required"
          ? "subscription_auth_required"
          : "subscription_refresh_failed",
        "Subscription authorization unavailable; check auth status",
      );
    }
    redact.add(token);
    if (init.signal?.aborted) throw init.signal.reason;
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + token);
    if (active) {
      active.dispatchedAt = new Date().toISOString();
      active.inferenceDispatched = true;
    }
    try {
      dispatched();
    } catch (error) {
      if (active) {
        active.inferenceDispatched = false;
        active.dispatchedAt = undefined;
      }
      throw error;
    }
    const response = await send("https://api.openai.com/v1" + path, {
      ...init,
      headers,
      redirect: "error",
    });
    if (active) {
      active.headersAt = new Date().toISOString();
      active.upstreamHttp = {
        status: response.status,
        ...(response.headers.get("x-request-id")
          ? { requestId: response.headers.get("x-request-id")! }
          : {}),
        ...(response.headers.get("retry-after")
          ? { retryAfter: response.headers.get("retry-after")! }
          : {}),
      };
    }
    return response;
  });
  return {
    credential,
    async complete(
      payload: ObjectValue,
      signal: AbortSignal,
      record: LedgerRecord,
      onDispatch: () => void,
    ): Promise<string> {
      active = record;
      dispatched = onDispatch;
      try {
        if (kind === "chatgpt-subscription")
          return await responsesText(client, payload, signal, record);
        const result = await client.chat.completions.create(
          payload as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
          { signal },
        );
        record.terminalAt = new Date().toISOString();
        captureUsage(record, result.usage, true);
        if (signal.aborted)
          throw new GatewayError(
            502,
            "upstream_timeout",
            "Absolute upstream deadline exceeded",
          );
        const choice = result.choices?.[0];
        if (
          result.choices?.length !== 1 ||
          choice?.finish_reason !== "stop" ||
          typeof choice.message.content !== "string" ||
          choice.message.refusal ||
          choice.message.tool_calls?.length
        )
          throw new GatewayError(
            502,
            "upstream_incomplete",
            "Upstream did not return one complete text answer",
          );
        if (choice.message.content.length > 2 * 1024 * 1024)
          throw new GatewayError(
            502,
            "response_too_large",
            "Upstream text exceeds 2 MiB",
          );
        if (!record.usage)
          throw new GatewayError(
            502,
            "usage_missing",
            "Core usage missing or invalid",
          );
        return choice.message.content;
      } catch (error) {
        if (signal.aborted)
          throw new GatewayError(
            502,
            "upstream_timeout",
            "Absolute upstream deadline exceeded",
          );
        if (
          error instanceof OpenAI.APIConnectionError &&
          error.cause instanceof GatewayError
        )
          throw error.cause;
        if (error instanceof OpenAI.APIConnectionError)
          throw new GatewayError(
            502,
            "stream_interrupted",
            "Upstream connection failed",
          );
        if (error instanceof OpenAI.APIError) {
          const code =
            typeof error.code === "string" &&
            /^[a-zA-Z0-9_]{1,100}$/.test(error.code)
              ? error.code
              : "upstream_http_error";
          record.upstreamError = { code }; // Provider error messages can echo prompts or credentials.
          throw new GatewayError(
            error.status && error.status >= 400 && error.status <= 599
              ? error.status
              : 502,
            code,
            "Upstream rejected the request",
          );
        }
        throw error;
      } finally {
        active = undefined;
        dispatched = () => {};
      }
    },
  };
}
