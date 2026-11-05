# ChatGPT Plan Gateway

[简体中文](README.zh-CN.md)

A small TypeScript gateway with an OpenAI-compatible Chat Completions endpoint, a serial request queue, token accounting, SQLite history, and a Chinese/English terminal dashboard.

**Current status:** the normal server uses an offline fixture. A separate, explicitly authorized probe has completed two real ChatGPT-plan requests through the gateway. Persistent authenticated serving, token refresh and account switching are not implemented.

## Requirements and quick start

- Node.js 26 or later and npm; no Docker or database service.
- Python 3.9+ for the optional POSIX terminal checks included in `npm test`. An existing LOTUS installation is required only for `test:lotus`.
- macOS is the original tested platform. The core server uses Node built-ins; portability beyond the test results is not implied.

From a checkout:

```bash
npm ci --ignore-scripts --cache .npm-cache
npm start -- --config gateway.example.json
```

The server binds only to `127.0.0.1:8787`. In another terminal:

```bash
npm run status -- --lang en
# Chinese is the default:
npm run status
```

Arrow keys select a request, Enter opens a summary, R toggles raw metadata, Esc returns, left/right change pages, Tab switches current/history, and Q exits the monitor without stopping the gateway. Stop the gateway itself with Ctrl-C.

```bash
npm run status -- --once --lang en
npm run --silent status -- --json
```

## API example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"offline-model","messages":[{"role":"user","content":"Return JSON"}],"response_format":{"type":"json_object"}}'
```

Routes: `GET /healthz`, `GET /v1/models`, `POST /v1/chat/completions`. Set SDK base URL to `http://127.0.0.1:8787/v1`; an SDK that requires a key may use the non-secret placeholder `offline-test`. LiteLLM can use `openai/offline-model`, but LiteLLM is not required.

The default fixture always returns `{"answer":2}` and historical sample usage of 58 input / 13 output / 71 total tokens. It does not answer arbitrary prompts or measure their token lengths. The local model list is not an account eligibility check.

## Behavior and limits

- Text messages and non-streaming client responses; text, JSON object and JSON schema output. Unsupported parameters are explicit errors.
- Concurrency 1, FIFO queue, configurable wait/start interval, request and observed-token stop thresholds, no gateway/SDK retries or hidden deduplication.
- Messages stay in order; system roles become developer roles. No agent instructions, project files or conversation history are added.
- Core usage comes from the upstream event. Missing detail remains unknown. Cached/reasoning tokens are subsets of input/output, not extra total tokens. JSON is validated without repair calls.
- SQLite stores request state, times, hashes, parameter changes, errors and original usage. Current-run budgets restart with the process; history does not replay unfinished work.
- Local-only access. No exposed-network authentication, remote access, crash recovery, embeddings or tool execution.

## Real subscription probe

```bash
npm run probe:live
```

This creates an independent loopback login page. After you choose a ChatGPT account and authorize plan usage, it discovers an available text model and sends **at most two serial model requests**: `OK`, then a strict JSON answer for 1+1. Any failure stops the run. Credentials remain in process memory; the default server is not changed. See [probe details and official references](docs/live-probe.md).

The observed real run returned `OK` with 10/5/15 tokens and `{"answer":2}` with 44/12/56. Original usage matched that run's SQLite records. The second gateway response took about 90 seconds; its latency cause remains unverified. This is a small integration result, not a production or performance guarantee.

## Checks

```bash
npm run typecheck
npm run build
npm test
```

These use local fixtures and reject non-loopback test connections. No real model request is part of the default checks. The POSIX terminal checks use `python3`; override the executable with `GATEWAY_TEST_PYTHON` if needed.

An optional existing LOTUS environment can be checked without installing or changing its packages:

```bash
GATEWAY_LOTUS_PYTHON=/path/to/existing/venv/bin/python npm run test:lotus
```

Set `GATEWAY_LOTUS_REPO=/path/to/source` as well if you want before/after source and dependency metadata checks. That source repository is never required by the gateway itself. See [verification scope](docs/offline-verification.md).

## Data and documentation

Treat `data/`, `reports/` and `.client-cache/` as private local state. Registration identifiers are not bearer tokens but still should not be uploaded. Reports may contain outputs, provider errors, usage attribution and local paths. Parameter values and hashes can reveal information even though ordinary ledger rows omit message/output bodies.

These directories, environment files, database files and local implementation notes are ignored by Git. Ignore rules do not override an explicit force-add; review changes before pushing. See [privacy and security](SECURITY.md).

- [Configuration](docs/configuration.md) · [Protocol and API](docs/protocol.md)
- [Terminal dashboard](docs/status.md) · [Real probe](docs/live-probe.md)
- [Fixture provenance](fixtures/README.md) · [Verification](docs/offline-verification.md)
- [Troubleshooting and limitations](docs/troubleshooting.md) · [Publication review](docs/privacy-review.md)

This private project currently has no open-source license grant (`UNLICENSED`). Dependencies retain their own licenses.
