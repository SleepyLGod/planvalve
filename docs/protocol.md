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

Core input/output/total must be nonnegative integers with consistent sums. Chat Completions usage is preserved raw and normalized for the common ledger. Optional cache/reasoning fields remain unknown when absent; they are subsets, not extra total tokens. A failure may still have observed usage. Missing usage stops dispatch rather than creating a misleading zero.

## Dispatch and failures

Concurrency 1; FIFO, queue capacity/wait deadline, minimum start interval, per-run attempt/observed-token stop conditions. Tokens are checked before the next dispatch and may overshoot by the last call. No deduplication, retries, repair calls or billing fallback.

Upstream errors pause dispatch and reject waiting work. Preserve safe machine codes, HTTP status, request ID and Retry-After; omit provider messages that could echo text or credentials. Subscription streamed usage-limit errors preserve their code even if the HTTP stream opened with 200. Retry-After is a diagnostic, not automatic rescheduling or a reset-time promise. Restarting resets local state, not official quota.

SQLite completion must persist before HTTP success. Storage failure pauses dispatch. Old unfinished records are last-known history, never current execution or resumable work.

## Monitoring and access

- `GET /_gateway/status`: mode/upstream, redacted authorization state, pause reason, limits, budgets, usage completeness, unknown accountBalance/actualCost and storage health.
- `GET /_gateway/requests`: newest first, optional run_id and before cursor, default limit 50 / maximum 200.
- `GET /_gateway/requests/:id`: detail, original usage, parameter changes, upstream metadata, inferenceDispatched/dispatchedAt, headersAt/firstTextAt/terminalAt/finishedAt and endReason. The first text time is unknown for buffered non-streaming API responses.

Monitoring does not dispatch, charge budgets or rewrite JSON exports. Real model/history/status routes require the independent local bearer key and matching loopback Host/Origin. Health exposes only mode/health. All listeners bind to 127.0.0.1. Local monitoring never follows redirects or uses a host proxy.

Timestamp fields are optional for older history. There is no migration that rewrites old records or invents missing timestamps. SQLite's existing run/request JSON format is retained.
