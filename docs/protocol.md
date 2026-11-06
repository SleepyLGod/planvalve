# Protocol and API

Client → validate → FIFO queue → explicit upstream → completed text/JSON + server usage → SQLite persistence → Chat Completions response.

## Upstreams

- Offline: SDK custom fetch serves the reconstructed local Responses fixture; no DNS or upstream socket.
- ChatGPT subscription: official `POST https://api.openai.com/v1/responses`, OAuth bearer, `store:false`, `stream:true`. Text messages stay ordered; system becomes developer. No additional agent instructions, files or history.
- API Key: official `POST https://api.openai.com/v1/chat/completions`, explicit server API key, `stream:false`. Roles and supported standard parameters remain intact. No Responses conversion is applied.

SDK constructors cannot inherit host credential defaults; requests use explicit transports. Destinations are fixed, redirects and retries are disabled. No browser login, model catalog request or test inference occurs during ordinary startup.

## Client contract

`GET /healthz`, `GET /v1/models`, `POST /v1/chat/completions`.

Accept a single configured model, nonempty string-content system/developer/user/assistant messages, n omitted or 1, and stream omitted or false. Output formats: text, json_object, json_schema. Validate JSON/schema locally without repair requests. Tools, images, streaming clients and unknown parameters are rejected. The model list is configured state, not an upstream eligibility result.

API Key supports temperature, top_p, max_tokens and max_completion_tokens. Subscription strict rejects unsupported parameters; the optional LOTUS profile records explicit omissions, not enforced settings. Supported fields have the same meaning regardless of client library.

Responses reads text deltas and the terminal event, captures usage, and cancels remaining stream reading. Success requires response.completed/status=completed and valid output/usage. Failed/incomplete events, explicit errors, interruption and timeout remain errors. Chat Completions requires one text choice with finish_reason=stop and valid usage. A truncated or refused response is not a successful completion.

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
