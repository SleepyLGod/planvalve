import { rateHeaders } from "./rate-limit.ts";
import { trackResponse } from "./transport.ts";
import { DispatchControl } from "./dispatch.ts";
import OpenAI from "openai";
import { isolatedSDK } from "./sdk.ts";
import { object, normalizeUsage } from "./compatibility.ts";
import { GatewayError, type LedgerRecord, type ObjectValue } from "./types.ts";
import { Redactor } from "./privacy.ts";
export interface CredentialSource {
  accessToken(signal?: AbortSignal): Promise<string>;
  status(): { state: string };
  close(): void | Promise<void>;
}
/** Sanitize before putting observations in the shared in-flight ledger. */
export function captureResponse(
  record: LedgerRecord,
  response: Response,
  redact: Redactor,
): void {
  const headers = redact.value(rateHeaders(response.headers));
  const requestId = response.headers.get("x-request-id");
  record.headersAt = new Date().toISOString();
  record.rateLimit = {
    observedAt: record.headersAt,
    headers,
    decision: { action: "none" },
  };
  record.upstreamHttp = redact.value({
    status: response.status,
    ...(requestId
      ? {
          requestId: /^[\x20-\x7e]{1,256}$/.test(requestId)
            ? requestId
            : "[invalid]",
        }
      : {}),
    ...(headers["retry-after"] ? { retryAfter: headers["retry-after"] } : {}),
  });
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
  redact: Redactor,
  chat = false,
): void {
  if (!object(raw)) return;
  const observed = redact.value(raw);
  record.rawUsage = observed;
  try {
    const normalized = normalizeUsage(
      chat
        ? {
            input_tokens: observed.prompt_tokens,
            output_tokens: observed.completion_tokens,
            total_tokens: observed.total_tokens,
            input_tokens_details: observed.prompt_tokens_details,
            output_tokens_details: observed.completion_tokens_details,
          }
        : observed,
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
  redact: Redactor,
  onFailure: (error: GatewayError) => void = () => {},
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
        record.upstreamError = redact.value({
          code:
            typeof terminal.response.error.code === "string" &&
            /^[a-zA-Z0-9_]{1,100}$/.test(terminal.response.error.code)
              ? terminal.response.error.code
              : "upstream_failed",
        });
      if (object(terminal.response?.incomplete_details))
        record.upstreamIncompleteDetails = redact.value(
          terminal.response.incomplete_details,
        );
      captureUsage(record, terminal.response?.usage, redact);
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
        const failure = new GatewayError(
          code === "subscription_sharing_usage_limit_exceeded"
            ? 429
            : code === "subscription_sharing_usage_unavailable"
              ? 503
              : 502,
          redact.text(code),
          "Upstream did not complete normally",
        );
        onFailure(failure);
        throw failure;
      }
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
  dispatch = new DispatchControl({
    minStartIntervalMs: 0,
    maxRequestsPerMinute: null,
  }),
  observe: (record: LedgerRecord, failure?: GatewayError) => void = () => {},
) {
  const path = kind === "openai-api-key" ? "/chat/completions" : "/responses";
  return {
    credential,
    async complete(
      payload: ObjectValue,
      signal: AbortSignal,
      record: LedgerRecord,
      onDispatch: () => void,
    ): Promise<string> {
      const active = record;
      const dispatched = onDispatch;
      let settle = async () => {};
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
        const response = await dispatch.run(
          signal,
          async (waiting) => {
            try {
              return await waitForToken(credential, waiting);
            } catch {
              throw new GatewayError(
                503,
                credential.status().state === "login-required"
                  ? "subscription_auth_required"
                  : "subscription_refresh_failed",
                "Subscription authorization unavailable; check auth status",
              );
            }
          },
          (token) => {
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
            const response = send("https://api.openai.com/v1" + path, {
              ...init,
              headers,
              redirect: "error",
            });
            return response;
          },
        );
        const tracked = trackResponse(response);
        settle = tracked.settle;
        captureResponse(record, response, redact);
        observe(record);
        return tracked.response;
      });
      try {
        if (kind === "chatgpt-subscription")
          return await responsesText(
            client,
            payload,
            signal,
            record,
            redact,
            (failure) => observe(record, failure),
          );
        const result = await client.chat.completions.create(
          payload as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
          { signal },
        );
        record.terminalAt = new Date().toISOString();
        captureUsage(record, result.usage, redact, true);
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
          record.upstreamError = redact.value({ code }); // Never expose provider diagnostics or reflected secrets.
          throw new GatewayError(
            error.status && error.status >= 400 && error.status <= 599
              ? error.status
              : 502,
            redact.text(code),
            "Upstream rejected the request",
          );
        }
        throw error;
      } finally {
        await settle();
      }
    },
  };
}
