# Verification scope

The project has separate offline checks and a tightly bounded live probe. Run results and machine-specific evidence remain in ignored local `reports/`; they are not prerequisites for reading this document or cloning the repository.

## Reproduce the default checks

```bash
npm ci --ignore-scripts --cache .npm-cache
npm run typecheck
npm run build
npm test
```

Default tests use local Responses fixtures and a non-loopback network guard. Coverage includes text/JSON/schema, missing Content-Type, empty final output arrays, SSE chunk boundaries, 64 simultaneous HTTP clients with one upstream request in flight, FIFO/cancellation/deadlines/budgets, unknown usage, no retries, SQLite persistence and write failures, monitoring without model calls, proxy/redirect rejection, terminal restoration, disconnection snapshots and Chinese/English numeric alignment.

The terminal interaction checks use Python 3.9+ and POSIX pseudoterminals. `GATEWAY_TEST_PYTHON` can select the interpreter. Unit-test fixtures are reconstructed parsed events, not original network byte captures.

## Optional installed LOTUS check

```bash
GATEWAY_LOTUS_PYTHON=/path/to/existing/venv/bin/python npm run test:lotus
```

This launches a separate isolated Python process with bytecode, dotenv discovery and external networking disabled. It imports the existing LOTUS/LiteLLM environment, redirects caches to this project, and executes an LM call and native `sem_map` through the local fixture gateway. It does not install or change external dependencies.

Optionally set `GATEWAY_LOTUS_REPO=/path/to/source` for before/after source hashes, Git status and dependency metadata. Without that option, the report does not claim repository-fingerprint verification. The observed sample returns 58/13/71 tokens per fixture call and 142 total. No full benchmark or every semantic operator is covered.

## Observed real probe

A separately authorized two-call run through the official public Responses endpoint returned:

| Case        | Output         | Input | Output tokens | Total |
| ----------- | -------------- | ----: | ------------: | ----: |
| Text        | `OK`           |    10 |             5 |    15 |
| JSON schema | `{"answer":2}` |    44 |            12 |    56 |

There were exactly two model attempts and zero retries. Cached, cache-write and reasoning counts were explicitly zero. Original usage, attribution sums, gateway normalization and read-only SQLite records matched. The model was gpt-6-luna. One gateway response took about 90 seconds; its latency cause is unverified.

These are limited observations. The result does not establish general account eligibility, safety at higher concurrency, uptime, price, full benchmark compatibility or persistent authenticated serving. New live runs require explicit authorization and should be evaluated from their own local report, not inferred from fixture success.
