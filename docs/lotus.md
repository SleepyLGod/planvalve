# LOTUS on the local gateway

[简体中文](lotus.zh-CN.md)

LOTUS is a client example, not a gateway dependency. Reuse a Python environment that already contains LOTUS, LiteLLM and pandas. Run the commands below from the gateway project root; no changes to a research repository or its dependencies are required.

## Start the gateway

For a new installation, initialize once with an eligible model and authorize your own account:

```bash
npm run local -- init --model YOUR_ELIGIBLE_MODEL
npm run auth -- login
```

Skip both commands when the local profile and saved authorization already exist. In the private `data/local/gateway.json`, set `"profile": "lotus"`, preserving the other fields and owner-only permissions. Initialization defaults to `strict`; it does not silently select LOTUS compatibility.

```bash
npm run local -- start
# In another terminal, from the same project:
npm run local -- status --lang en
```

Startup and monitoring do not call a model. The saved authorization is reused and renewed before inference when needed. Ctrl-C stops the gateway; quitting the monitor does not.

## One-row semantic map

**This command sends a real model request when connected to the subscription gateway.** Replace the Python path with your existing environment. This example reads the saved base URL, model and local client key; it never reads the subscription token.

```bash
PYTHON_DOTENV_DISABLED=1 LITELLM_LOCAL_MODEL_COST_MAP=True \
NO_PROXY=127.0.0.1,::1 no_proxy=127.0.0.1,::1 \
XDG_CACHE_HOME="$PWD/.client-cache" \
/path/to/existing/venv/bin/python -B <<'PY'
import pandas as pd
import litellm
import lotus
from lotus.models import LM
from lotus.cache import InMemoryCache
from examples.client import local_connection

litellm.telemetry = False
base_url, local_key, model = local_connection()
lm = LM(
    model=f"openai/{model}",
    api_base=base_url,
    api_key=local_key,
    max_batch_size=1,
    num_retries=0,
    cache=InMemoryCache(max_size=1),
)
lotus.settings.configure(lm=lm, enable_cache=False)
frame = pd.DataFrame({"question": ["1+1"]})
mapped = frame.sem_map(
    "Compute {question}; return only a JSON object with integer field answer.",
    suffix="_answer",
    response_format={"type": "json_object"},
)
print(mapped)
print("Token usage:", lm.stats.physical_usage)
PY
```

The `openai/` prefix selects LiteLLM's OpenAI-compatible protocol. `api_base` directs traffic to this gateway; the gateway's configured upstream determines subscription versus API-key billing. It does not select LiteLLM's `chatgpt/` provider. Never substitute your OAuth access/refresh token for the local client key.

The explicit proxy exclusions keep local bearer credentials and prompts off environment-configured proxies. Apply the same exclusions to your own LOTUS process. The ordinary JavaScript/Python SDK examples already bypass environment proxies for local calls and do not follow redirects; `--direct` retains the official SDK's normal transport behavior.

LOTUS normally supplies `temperature=0` and `max_tokens=512`. The subscription compatibility profile records and omits these unsupported parameters. The requested temperature and output cap are therefore **not enforced**. The gateway's observed-token budget is also a stop condition after usage is known, not a server-side output cap. The gateway adds no agent prompt; LOTUS supplies its own task-formatting instructions, which count toward input usage.

The example uses one worker, disables LOTUS caching, and disables client retries. The gateway independently serializes requests, spaces starts, applies per-run budgets and pauses on upstream errors. Larger DataFrames still cause multiple calls; join/filter/other operators may use different call patterns or unsupported features. One successful `sem_map` is not a complete LOTUS or benchmark compatibility test. Do not treat LOTUS's estimated monetary cost as a subscription bill; inspect gateway usage and raw details in the dashboard instead.

## Observed live result, 2026-11-06

One native `sem_map`, one row, model `gpt-6-luna`, JSON object mode:

| Measurement | Observation |
| --- | --- |
| Output | `{"answer":2}` |
| Input / output / total tokens | 59 / 12 / 71 |
| Cached input / reasoning output / cache-write tokens | 0 / 0 / 0, explicitly reported |
| Model requests / retries | 1 / 0 |
| Gateway execution | 6.612 seconds |
| Terminal event to finished record | 3 milliseconds |

LOTUS's core counts matched the server's raw usage, normalized gateway usage and the single persisted SQLite record. Raw usage, including per-item attribution, was retained; cached and reasoning tokens are subsets, not added again. The test reused authorization, required no login or refresh, and stopped its temporary gateway afterward. A preceding separate renewal-only check had succeeded with one refresh and zero model calls.

The acceptance test used a temporary single-request gateway with an independent transport cap, isolated caches, disabled bytecode/dotenv discovery, and Python network/write guards. Research source/configuration hashes, Git state and dependency metadata were unchanged. It did not change the daily local profile. This guide's ordinary daily commands do not install those acceptance guards or impose a one-request lifetime budget.

Counts differ from the offline fixture's 58 / 13 / 71. Outputs, latency, account eligibility and token counts are observations, not guarantees. Long-running use and a full research workload remain unverified. Private evidence stays under ignored `reports/`; no credentials, account IDs or workstation paths are needed in published documentation.
