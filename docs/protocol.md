# Protocol and API

Client → validate → FIFO queue → explicit upstream → completion + server usage → SQLite persistence → Chat Completions response.

## Upstreams

- Offline: SDK custom fetch serves the reconstructed local Responses fixture; no DNS or upstream socket.
- ChatGPT subscription: official `POST https://api.openai.com/v1/responses`, OAuth bearer, `store:false`, `stream:true`. Text messages stay ordered; system becomes developer. No additional agent instructions, files or history.
- API Key: official `POST https://api.openai.com/v1/chat/completions`, explicit server API key, `stream:true`, `stream_options.include_usage:true`. Roles and supported standard parameters remain intact. No Responses conversion is applied.

SDK constructors cannot inherit host credential defaults; requests use explicit transports. Destinations are fixed, redirects and retries are disabled. No browser login, model catalog request or test inference occurs during ordinary startup.

## Client contract

`GET /healthz`, `GET /v1/models`, `POST /v1/chat/completions`.

Accept a single configured model, a nonempty message list, n omitted or 1, and stream omitted or false. Ordinary system/developer/user/assistant messages have string content. Output formats: text, json_object, json_schema. Validate final JSON/schema locally without repair requests. Images, streaming clients and unknown parameters are rejected. The model list is configured state, not an upstream eligibility result.

API Key supports temperature, top_p, max_tokens and max_completion_tokens. Subscription strict rejects unsupported parameters; the optional LOTUS profile records explicit omissions, not enforced settings. Supported fields have the same meaning regardless of client library.

**Platform API key only: function calls.** PlanValve forwards `tools`, `tool_choice` (auto, none, required, or a named function) and an explicit `reasoning_effort`. Returned function calls must be declared for this request and respect its tool choice: `none` disallows a call, `required` requires a call, and a named choice requires that function. The gateway never executes tools. The client must validate arguments and check permissions before execution.

The client sends the assistant call and its string-content `role: "tool"` result back with the same `tool_call_id`. This is a second, independently queued and metered request; PlanValve does not retain the conversation for it. `response_format` applies to the final text answer, not the tool arguments.

Each assistant tool call requires exactly one result before the next non-tool message or the end of the request. Parallel results can arrive in any order. Before returning a tool turn, Platform checks that the compact request can carry its existing history/options, the assistant turn, and a result envelope plus 1 KiB of encoded content per call within the 1 MiB request limit. Larger tool outputs or additional messages may still exceed that limit.

**ChatGPT subscription:** this gateway translates text/JSON requests to Responses. It rejects these tool messages, tool controls and `reasoning_effort` before dispatch, including in the LOTUS profile. It does not retry them against the Platform API.

Responses reads text deltas and the terminal event, captures usage, and cancels remaining stream reading. Success requires response.completed/status=completed and valid output/usage. Failed/incomplete events, explicit errors, interruption and timeout remain errors. Chat Completions requires one complete text choice (`stop`) or function turn (`tool_calls`), with valid usage in either case. A truncated or refused response is not a successful completion.

Both upstreams stream into the gateway. Chat Completions requests receive a separate final usage chunk after the choice finish reason. The gateway assembles one complete response before replying.

Request history includes optional `timing` in milliseconds. Pre-send wait starts when a validated request is recorded. TTFT starts at dispatch and ends at the first nonempty text delta. Estimated TPOT divides the time between first and last text deltas by visible output tokens minus one. Visible tokens are output tokens less reasoning tokens. An estimate requires a completed text-only turn, two or more text deltas and a known positive denominator. Tool turns report first tool arguments separately. Upstream latency ends when the successful finish and usage are observed. Gateway duration ends after cleanup and validation, immediately before the final ledger write. API latency, TTFT and TPOT reflect gateway observations, which include network buffering.

Core input/output/total must be nonnegative integers with consistent sums. Chat Completions usage is preserved raw and normalized for the common ledger. Raw usage and provider diagnostics are redacted before entering the shared in-flight ledger, not only before persistence. Optional cache/reasoning fields remain unknown when absent; they are subsets, not extra total tokens. A failure may still have observed usage. Missing usage stops dispatch rather than creating a misleading zero.

## Dispatch and failures

Configurable concurrency (default 1), FIFO, bounded queue/wait deadline and actual-send spacing. Optional maxRequestsPerMinute is a smooth upper bound: interval = max(configured interval, ceil(60000 / RPM), run slowdown). This does not offer window-boundary bursts or estimate official TPM. Request budgets are checked atomically before fetch; observed tokens stop future sends but already dispatched calls can overshoot. No deduplication, retries, repair calls or billing fallback.

Recognized temporary rate/overload errors with a reliable Retry-After or exhausted-bucket reset hold unsent work. Later independent calls can continue; the failed call is never requeued. Valid longer hints extend cooldown; malformed or missing reset fields do not invalidate another reliable hint. slow_down doubles the run effective interval. Quota, balance, identity/permission, unknown errors and storage failures pause new dispatch; in-flight calls still settle. Subscription streamed usage-limit errors retain their code even with HTTP 200. Waiting is not a promise of recovery; restarting does not reset official quota.

Terminal stream-error feedback, including explicit `error` events and SDK-thrown SSE errors, takes effect before awaiting body cancellation. Valid error codes are preserved and redacted before observation. A quota failure therefore blocks new sends immediately, while a request still cleaning its transport retains its concurrency slot until cleanup settles.

Queue wait ends when execution starts; the execution deadline includes preparation, dispatch waiting and transfer. Before-send expiry returns 429 dispatch_expired and consumes no inference attempt; it neither clears cooldown nor pauses the sender. After-send timeout remains unknown and pauses. Cancellation of a queued client does not abandon already sent work. Shared OAuth refresh has its own bounded lifetime, and shutdown waits for its atomic credential update before releasing the process lock.

SQLite completion must persist before HTTP success. Storage failure pauses dispatch. Old unfinished records are last-known history, never current execution or resumable work.

## Monitoring and access

- `GET /_gateway/status`: mode/upstream, redacted authorization state, pause reason, queue preparing/inFlight counts, dispatch state/countdown/effective interval, last observed upstream rate headers, limits, budgets, usage completeness, unknown accountBalance/actualCost and storage health.
- `GET /_gateway/requests`: newest first, optional run_id and before cursor, default limit 50 / maximum 200.
- `GET /_gateway/requests/:id`: detail, original usage, parameter changes, upstream metadata, inferenceDispatched/dispatchedAt, headersAt/firstTextAt/terminalAt/finishedAt and endReason. The first text time is unknown for buffered non-streaming API responses.

Monitoring does not dispatch, charge budgets or rewrite JSON exports. Real model/history/status routes require the independent local bearer key and matching loopback Host/Origin. Health exposes only mode/health. All listeners bind to 127.0.0.1. Local monitoring never follows redirects or uses a host proxy.

Timestamp fields are optional for older history. There is no migration that rewrites old records or invents missing timestamps. SQLite's existing run/request JSON format is retained.
