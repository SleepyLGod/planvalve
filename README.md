# ChatGPT Plan Gateway

[简体中文](README.zh-CN.md)

A small local OpenAI-compatible gateway for your own ChatGPT subscription or OpenAI API key: one FIFO queue, token accounting, SQLite history, and a Chinese/English terminal dashboard. LOTUS/LiteLLM is one use case; ordinary SDKs and scripts work through the same interface.

**Prototype.** The default is an offline fixture. Offline tests cover both upstreams. Separately authorized live checks passed for subscription text/JSON, usage, authorization reuse across restart, token renewal, and one native LOTUS `sem_map`. These are small integration checks, not long-running service validation. It is an independent project implemented against public OpenAI documentation, not an OpenAI-certified product.

## Start offline

Node.js 26+ and npm are required. No Docker, database server, global tools, or LOTUS installation is needed. POSIX terminal tests additionally use Python 3.9+.

```bash
npm ci --ignore-scripts --cache .npm-cache
npm start
# In another terminal:
npm run status -- --lang en
```

The server listens only on `127.0.0.1:8787`. Chinese is the dashboard default. Arrow keys select, Enter opens details, R toggles metadata, Esc returns, left/right change pages, Tab selects history, and Q closes only the monitor.

```bash
npm run status -- --once --lang en
npm run --silent status -- --json
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"offline-model","messages":[{"role":"user","content":"Return JSON"}],"response_format":{"type":"json_object"}}'
```

The fixture always returns `{"answer":2}` and historical sample usage of 58 input / 13 output / 71 total tokens. It does not answer arbitrary prompts or count their tokens.

## Everyday local use

Initialize once, then start and monitor without manually exporting the local client key. Initialization only writes local settings: no login, model discovery or inference. Choose a model available to your account.

```bash
npm run local -- init --model gpt-6-luna
# In separate terminals:
npm run local -- start
npm run local -- status
npm run local -- status --lang en
npm run local -- status --once
npm run --silent local -- status --json
```

The ignored `data/local/gateway.json` and `data/local/client.key` use an owner-only directory (0700) and files (0600). Repeating initialization for the same model/upstream reuses them unchanged. Conflicting, partial, corrupt or insecure state fails without overwriting files or rotating keys. Edit the private config to change the model/port and preserve its permissions.

Subscription mode reuses this tool's saved authorization. On a new machine or after a terminal authorization failure, use `npm run auth -- login`; `local start` never opens a browser. Plain `npm start` remains offline. Q closes only the monitor; Ctrl-C stops the gateway. No daemon, login item or global shell configuration is installed.

API-key users can initialize with `npm run local -- init --model YOUR_MODEL --upstream openai-api-key`, then provide their own OPENAI_API_KEY in the server environment. Only the separate local client key is saved, never an upstream API key.

Examples can read the same protected connection settings without copying the key:

```bash
node examples/client.mjs --local
python3 -B examples/client.py --local
```

**These example commands send requests.** Initialization, startup and monitoring do not. `--local` and `--direct` are mutually exclusive. Other clients need the same base URL/model/local key; the examples demonstrate reading the private file without printing it.

## Choose an upstream

| Mode                   | Credentials                                 | Accounting                          |
| ---------------------- | ------------------------------------------- | ----------------------------------- |
| `offline` (default)    | None                                        | Fixed sample usage                  |
| `chatgpt-subscription` | Your independently authorized OAuth session | Eligible ChatGPT plan/credits usage |
| `openai-api-key`       | Your `OPENAI_API_KEY`                       | API Platform credits / billing      |

When using the low-level `npm start -- --config …` entry, choose an eligible model in the corresponding example config. Set a separate private `GATEWAY_LOCAL_API_KEY` of at least 16 characters in the server, client and monitor environments. It protects the local interface; it is not your upstream credential. Keep credentials out of shell history, source files and shared transcripts.

**ChatGPT subscription:**

```bash
npm run auth -- login --config gateway.subscription.example.json
npm run auth -- status --config gateway.subscription.example.json
npm start -- --config gateway.subscription.example.json
# Stop the server before signing out:
npm run auth -- logout --config gateway.subscription.example.json
```

Login prints an official browser authorization URL and sends no model requests. Your configured model must be available to your account; startup does not query a catalog or open a browser. The service renews expiring access tokens before requests. Only this tool's private authorization file is used; Codex configuration and credentials are never read. One registration is supported. Returning sign-ins reuse it; a different identity is rejected. The server owns the credential lock until it stops, so login/logout and a second subscription server must wait. No account pool is provided.

**API key:** set `OPENAI_API_KEY` in the server environment, then:

```bash
npm start -- --config gateway.api-key.example.json
```

Eligible subscription API credits and purchased credits use this same route. Free credits can run out and existing purchased credits may then be used. The gateway cannot identify the credit pool charged for an individual request or display an authoritative account balance. See [official API credits documentation](https://developers.openai.com/api/docs/guides/chatgpt-api-credits).

## Clients

The endpoint is `http://127.0.0.1:8787/v1/chat/completions`; use that `/v1` base URL and the local key in an OpenAI SDK. `/v1/models` lists the single configured model, not a verified account catalog. See [JavaScript](examples/client.mjs), [Python](examples/client.py), and [LOTUS](examples/lotus.py) examples. Python examples use your existing dependencies; the gateway does not install them.

```bash
node examples/client.mjs
python3 -B examples/client.py
```

LOTUS may send subscription-unsupported parameters by default. Explicitly select `profile: "lotus"` for that use case; omissions are recorded and do not enforce the omitted settings. The generic default is `strict`. Follow the [LOTUS local-use guide](docs/lotus.md) for saved-key access, single-worker setup, zero retries and the observed live result: `{"answer":2}`, 59 input / 12 output / 71 total tokens. Those counts are one observation, not a fixed response or forecast.

With an API key, `node examples/client.mjs --direct` or `python3 -B examples/client.py --direct` bypasses the gateway and uses the official API. Set `MODEL` to your real model. Direct requests have no gateway queue, local history or real-time TUI; use the official Usage dashboard for platform accounting.

## Behavior and limits

- Text messages, one completion, non-streaming client responses; text, JSON object and JSON schema. No tools, embeddings, image input, transparent agent runtime or general provider framework.
- Subscription requests use official Responses with `store:false` and `stream:true`; system roles become developer roles. API-key requests use official Chat Completions, preserve roles, and support `temperature`, `top_p`, `max_tokens` and `max_completion_tokens`. Unsupported fields fail explicitly.
- No added agent prompt, project files or implicit history; no JSON repair calls, deduplication, fallback billing or gateway/SDK retries. Clients must configure their own retries explicitly; our examples set them to zero.
- Concurrency is 1. Real modes default to a 3-second minimum start interval; this is a local default, not an official safe threshold. Request and observed-token budgets apply per run; the last call may exceed the token threshold. Restarting resets local budgets, not upstream limits.
- **Concurrency 1 can still hit RPM/TPM limits. Other applications may share official limits. Only traffic through this gateway is controlled; rate-limit or account-enforcement avoidance is not guaranteed.** See [official rate limits](https://developers.openai.com/api/docs/guides/rate-limits).
- Upstream failures pause dispatch. The failed call is never automatically resent. Status records the reason, HTTP metadata and `Retry-After` when supplied; that header is not a promise of quota recovery. Check the cause before restarting.
- Success requires completed output and valid usage. Responses streams stop at the terminal event rather than waiting for EOF. Missing cache/reasoning detail stays unknown; subsets are not added twice to total tokens. Balance and actual cost remain unknown.

## Data and security

Real model and monitoring routes require the local key and valid loopback Host/Origin. `/healthz` exposes only health/mode. This is a local, single-user service; do not expose it through tunnels, Tailscale sharing or public proxies without a separate access design.

`data/`, `reports/`, environment files, caches and generated output are private and ignored. OAuth credentials use owner-only files and atomic replacement; refresh/process locking uses built-in SQLite and requires no server. Ordinary history omits prompt/output bodies. Raw usage, parameter values, request hashes and provider identifiers can still be sensitive. Error diagnostics retain machine codes instead of provider messages that could echo prompts. Explicit probes store their fixed toy outputs. See [SECURITY.md](SECURITY.md).

## Checks and documentation

```bash
npm run typecheck
npm run build
npm test
# Optional: use an existing LOTUS environment, without installing or changing it:
GATEWAY_LOTUS_PYTHON=/path/to/existing/venv/bin/python npm run test:lotus
```

Tests deny non-loopback connections. CI runs these offline checks on Linux and macOS without provider secrets. CI configuration is provided; a local test pass does not mean hosted CI has run.

- [Configuration](docs/configuration.md) · [Protocol](docs/protocol.md) · [Dashboard](docs/status.md)
- [Authorization](docs/authorization.md) · [Bounded live probe](docs/live-probe.md)
- [Verification](docs/offline-verification.md) · [Troubleshooting](docs/troubleshooting.md)
- [Fixture provenance](fixtures/README.md) · [Publication review](docs/privacy-review.md)

## Official documentation and license

OpenAI documents [ChatGPT plan usage for open-source and locally hosted apps](https://developers.openai.com/siwc/token-sharing-open-source), [credential storage](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [renewal/revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), and [errors/recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery). Eligibility, region, account policy and usage limits still apply. Paid or remotely hosted offerings follow a separate official application process; publishing this source is not operating a shared subscription service.

[MIT](LICENSE). Dependencies retain their own licenses. MIT permits commercial reuse; upstream access remains governed by its own terms and policies.
