# Offline verification

## Private scheduling closeout — 2026-11-07

This closeout adds no feature, model request, login or renewal. It updates the bilingual READMEs, LiteLLM guide, TODO and historical design notes to reflect the separately authorized checks below, including the failed test-harness run. Saved daily configuration, client key and authorization content/metadata remained unchanged. Source and private evidence are reviewed separately; runtime reports are not committed.

Fresh checks passed independently: type checking, build and **113 offline tests, 0 failed / 0 skipped**, with the optional installed Python SDK/LiteLLM branches enabled. Independent LiteLLM acceptance passed **12/12 cases**, with 12 client POSTs, 11 mocked upstream attempts and 0 proxy requests. Installed LOTUS LM, native one-row `sem_map` and the official Python SDK passed with three mocked calls and usage 58/13/71 each; protected research source/dependency fingerprints stayed unchanged and external network attempts were empty. LOTUS's existing cost warning remains: token validation is not price validation.

The candidate review covers 82 files and all 95 reachable history blobs across four reachable commits. Exact private credential/registration matching, common credential/private-key patterns, personal paths, runtime exclusions, local Markdown links and Python/JSON syntax passed. This is a bounded scan, not proof against every possible sensitive format. Exact staged content is checked again before commit. Existing author email is retained. The authorized destination is the personal private `feat/local-upstreams` branch; main, visibility and releases are unchanged. Hosted CI/billing remains a separate deferred item, not a claimed pass.

## Separately authorized live scheduling checks — 2026-11-06

These manual checks were separate from implementation, offline tests and CI. Each run had its own two-model-request authorization, a transport cap of two and zero retries. The configured model was gpt-6-luna; daily settings and the local client key were unchanged. The default concurrency remains 1.

The **first run failed client acceptance**: both official Responses requests returned HTTP 200 with terminal events and complete usage, but both local clients received 502 / stream_interrupted. Its extra test-only body observer mishandled SDK cancellation after completion. A loopback HTTP control reproduced AbortError with the observer and succeeded without it. The observer was removed from the test harness; production gateway code was unchanged. The failed results remain failed and are retained separately. Saved authorization renewed once without browser login during that run.

A **new, separately authorized run** then passed using the corrected harness, which observes the existing ledger without wrapping the upstream response body:

| Request | Client output | Client elapsed, including waiting | Input tokens | Output tokens | Total |
| --- | --- | ---: | ---: | ---: | ---: |
| Text | `OK` | 3.383 s | 10 | 5 | 15 |
| JSON schema | `{"answer":2}` | 6.340 s | 45 | 12 | 57 |

- Exactly two client POSTs and two official Responses POSTs, all HTTP 200; no retry, model-catalog request, browser login or authorization-network request. The saved session was reused without renewal in this second run.
- Maximum observed in-flight count was 2. Actual sends were 3003 ms apart; the second started before the first terminal event, overlapping by about 356 ms. This proves a small real overlap, not real concurrency 4 or a large batch.
- Terminal-event-to-finished intervals were 2 ms and 1 ms. No 90-second wait occurred; the root cause of the old untimed 90-second request remains unconfirmed.
- Client, normalized, raw and SQLite usage matched in an independent read-only check. Cached input, reasoning output and cache-write were explicitly 0. Total observed tokens were 72; these are usage counts, not a cost or account balance.
- Monitoring caused no inference, request-record growth or budget change. Both persisted requests were completed, the SQLite run was closed, and the temporary service stopped. Source/configuration fingerprints were unchanged; authorization retained 0700/0600 storage permissions and the same registration/identity.

Private evidence stays under ignored `reports/live-scheduling-two-*/` and `reports/live-scheduling-retest-*/`. Neither raw runtime data nor credentials are publication content. Real official limit responses, automatic cooldown recovery against a real account, API-key billing, larger batches and long-running reliability remain unverified.

## Terminal feedback and in-flight redaction follow-up — 2026-11-06

Three new regressions failed before the fixes and passed afterward. Subscription and independent probe streams now apply terminal error feedback before awaiting stream cancellation: a quota failure prevents new sends immediately, while the cleaning request retains its concurrency slot. Raw usage, incomplete details and error codes are sanitized before entering the shared ledger; Responses and Chat Completions retain their numeric token accounting. These changes reuse the existing observer, scheduler and redactor, with no new dependencies.

Type checking and build passed. The targeted stream/upstream suite passed **30/30**. The first full run passed 112/113: an existing CLI startup-failure test hit its 1.5-second watchdog while the independent Python checks were running alongside it. That CLI suite then passed **12/12** alone, and the full suite rerun passed **113/113**, 0 failed and 0 skipped, with the optional installed Python SDK/LiteLLM branches enabled. The watchdog was not changed; the initial timing failure remains in the evidence rather than being counted as a pass.

Independent LiteLLM acceptance passed **12/12 cases** (12 client calls, 11 mocked upstream attempts, 0 proxy calls). Installed LOTUS LM, native `sem_map` and the official Python SDK passed with three mocked calls, `{"answer":2}` and usage 58/13/71; protected source/dependencies were unchanged and external network attempts were empty. LOTUS's existing cost-estimation warning remains; these checks verify tokens, not billing.

No real model, login or renewal requests were made. Saved local configuration/key/authorization metadata remained unchanged. Evidence stays in ignored `reports/terminal-observation-fix/`; no commit or push is included. Real-account rate limits and higher-concurrency operation remain unverified.

## Configurable scheduling — 2026-11-06

This round used only synthetic upstreams and fake OAuth. No real model, login or renewal request was made. Defaults remain offline, concurrency 1, real-mode spacing 3000ms, no RPM cap and zero automatic retries; saved everyday settings, local key and authorization metadata were unchanged.

- Typecheck: passed. Build: passed. Full suite: **110 passed, 0 failed, 0 skipped**, with the existing Python SDK/LiteLLM client checks enabled.
- 64 loopback client requests were exercised at concurrency 1, 2 and 4. Maximum active sends matched the configured ceiling; a one-request budget dispatched exactly one call despite concurrent clients.
- Temporary limits with reliable hints defer unsent work; failed requests are never resent. Missing/malformed reset fields do not invalidate another reliable hint. Unsent expiry returns `dispatch_expired` without global pause or budget consumption; hard limits preserve in-flight results.
- A fresh read-only review found eight issues not covered by the initial 102 checks. All eight regressions were observed failing, then passing: delayed SSE cancellation retaining slots in subscription/probe; early exhausted-header feedback; in-flight credential-header redaction; cancellation racing actual start; client disconnect during admission; consistent overflow pause/ledger; header-arrival ordering; correct status/code combinations.
- The existing completion-tail timing test previously measured client/loopback delay and failed under the Python-enabled load. It now measures the recorded terminal-to-finish path; a separate barrier-based test proves actual cancellation settlement, without relying on client wall-clock latency.
- Independent LiteLLM acceptance: **12/12 cases**, 12 client calls, 11 mocked upstream attempts, 0 proxy calls; no LOTUS/agent-memory imports.
- Installed LOTUS LM, native one-row `sem_map`, and official Python SDK: **3 mocked calls**, output `{"answer":2}`, input 58 / output 13 / total 71 each. Protected research source/dependencies stayed unchanged; external network attempts were empty.
- LOTUS still warns that it cannot calculate completion cost for this configured model. Token usage passed; cost remains unknown and is not inferred from these fixtures.

`p-queue@10.0.0` is the only added runtime dependency. The task queue is replaced rather than layered; actual-send admission and a small body-cleanup adapter cover gateway-specific semantics. SQLite format and existing history remain compatible. Local evidence is retained in ignored `reports/scheduling-work/`; tests and fixtures are part of the project.

This verifies offline behavior, not real-account throttling, long-running availability or protection from enforcement. Earlier bounded live results below remain separate evidence; hosted CI was not invoked this round.

## Current implementation acceptance

This revision implements persistent ChatGPT-plan authorization, an API-key upstream and shared local controls. Offline acceptance uses fake credentials, reconstructed Responses events and SDK custom fetch. **The implementation's offline checks made no real login or model calls.** Later, separately authorized live checks are recorded below and in the bilingual LOTUS guides. Daily Codex configuration/credentials are not read and external repositories are not changed.

```bash
npm ci --ignore-scripts --cache .npm-cache
npm run typecheck
npm run build
npm test
```

Type checking, compilation and tests are separate checks. The implementation baseline passed all three with 51 tests; the expanded suite covers the changes below. Per-run logs, machine-specific evidence and publication scans remain in ignored reports/local-upstreams/, not required to clone the project.

Default tests deny non-loopback fetch/socket/DNS/UDP, including attempts whose exceptions are caught. Provider and OAuth operations in tests use local fake fetches; no real tokens are needed. CI runs offline checks on Linux and macOS with Node 26 and Python 3.12; a configured workflow is not proof of a hosted CI run.

## Recorded local results, 2026-11-06

| Check                                                          | Result                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Clean source-only export and offline locked dependency install | Passed; 59 source/documentation files, no runtime credentials copied |
| Type checking                                                  | Passed                                                               |
| Build                                                          | Passed                                                               |
| Expanded default suite                                         | 73 passed, 0 failed, 0 skipped                                       |
| Existing LOTUS LM / sem_map plus official Python SDK           | Passed; 3 local fixture requests, 0 external attempts                |
| Original Python repository/source/dependency fingerprints      | Unchanged                                                            |
| Candidate source and published-history pattern scan            | No common credentials or private home-path matches; limited audit    |

The first clean-export test exposed a missing test-directory initialization; a subsequent run exposed a timing-sensitive monitoring assertion. Both test issues were corrected, the latter using a controlled upstream gate, then the fresh export passed all checks. At that checkpoint hosted CI had not been run and no new live test was included.

## Cases covered

- Text/JSON object/JSON schema through real local HTTP and the official JavaScript SDK; API-key requests retain standard parameters/roles while subscription requests convert only required protocol fields. Raw/normalized usage agree.
- Missing Content-Type, final output=[], fragmented SSE, completed event followed by an unclosed transport tail. The tail case failed before the change by waiting until the deadline and now returns on completion and cancels the body.
- Failure/incomplete/refusal/interruption/timeout and missing usage remain explicit errors with zero inference retries. Completed refusal output cannot become an empty successful answer; observed usage is still retained.
- Credential acquisition is bounded by the request deadline and its underlying refresh is cancelled. An undispatched request consumes no inference attempt, creates no upstream HTTP error, and is excluded from unknown model-usage totals. Old records without the new dispatch flag retain their prior meaning.
- Fake OAuth first/returning login, signed identity/nonce/issuer/audience/expiry checks, callback state/replay, missing scopes/declined consent, restart reuse, rotating refresh serialization and separate-process lock contention, temporary-error preservation, confirmed invalid refresh tokens, confirmed/unconfirmed revocation, and private file permissions. Shared directories are not chmodded.
- 64 simultaneous clients through both the Responses fixture path and API-key path keep one upstream request in flight. FIFO, pacing, queue cancellation/expiry, count/token stops and upstream-limit pause are checked. Other programs' traffic and official RPM/TPM enforcement are not simulated guarantees.
- Local bearer key, Host/Origin, metadata/credential redaction, SQLite persistence/write failures, cross-run history and pagination, and monitoring without dispatch/budget/export mutations.
- Chinese/English layout, display-width alignment, control-character escaping, details, history, resizing, disconnect snapshots, one-shot JSON and terminal restoration. Quitting the monitor does not stop the service.
- Auth status and missing-key startup are checked in independent offline CLI processes.

## Optional installed Python clients

```bash
GATEWAY_LOTUS_PYTHON=/path/to/existing/venv/bin/python npm run test:lotus
```

An isolated Python process disables bytecode and dotenv discovery, redirects caches into this project, blocks external networking and performs an installed LOTUS LM call, native sem_map and a separate ordinary official OpenAI Python SDK call. No dependencies are installed or changed. The sample is 58/13/71 per call: LOTUS contributes 142 total and the separate SDK contributes 71, three local fixture calls overall.

Set GATEWAY_LOTUS_REPO=/path/to/source to compare source/config hashes, Git state and dependency metadata before and after. The local implementation acceptance used this fingerprint option and passed without changing the source repository or dependencies. Without that option the script does not claim source-fingerprint verification. LOTUS may warn that the fictional fixture model cannot be priced; token counts remain meaningful, monetary estimates do not.

## Historical real evidence

A previous, separately authorized two-request probe returned:

| Case        | Output       | Input tokens | Output tokens | Total |
| ----------- | ------------ | -----------: | ------------: | ----: |
| Text        | OK           |           10 |             5 |    15 |
| JSON schema | {"answer":2} |           44 |            12 |    56 |

Exactly two attempts, zero retries. Raw usage and attribution matched SQLite; cache/reasoning/cache-write were explicitly zero. Model: gpt-6-luna. The JSON gateway response lasted about 90 seconds; its root cause remains unconfirmed because that run lacks event-arrival timestamps. The new offline tail regression proves a code defect and its correction, not the historical timing explanation.

These observations do not establish real account eligibility for others, general model availability, safety at higher concurrency, current cost, full LOTUS benchmark compatibility or long-running real-service reliability. New online validation needs separate explicit authorization.

## Daily local entry acceptance, 2026-11-06

The default offline entry is unchanged. The optional local init/start/status commands were checked in isolated project copies, including private file creation, unchanged reuse, conflict/corruption/permissions/symlinks, project-relative startup from another working directory, missing authorization, child exit status and signals, saved-key monitoring, and TUI resize/exit/terminal restoration. JavaScript --local completed through real loopback HTTP with an SDK fake upstream; the existing installed official Python SDK also completed --local under an independent network/write guard. The Python branch is enabled for this optional check by GATEWAY_LOTUS_PYTHON and is not claimed as default CI coverage.

A fresh source-only export of 63 files passed offline lockfile installation, type checking, build and all 78 default tests (0 failed, 0 skipped). The local entry adds no dependencies. A fresh-context read-only review found no concrete important issue.

This machine was initialized for gpt-6-luna using the existing subscription authorization. Guarded startup, health and JSON monitoring passed with zero inference records/requests, zero external authorization requests, unchanged authorization file, and 0700/0600 local storage permissions. The service was stopped cleanly. At that stage its access token was marked refresh-required and renewal was deliberately not exercised. A subsequent, separately authorized renewal-only check succeeded; see below.

Local evidence stays in ignored reports/local-entry/. No extra real model requests, browser authorization, commits, pushes or repository visibility changes were performed.

## Subsequent separately authorized live checks, 2026-11-06

These were manual, bounded online checks, not part of the offline suite or CI:

- Persistent service text and JSON-schema requests returned `OK` and `{"answer":2}` in 3.626 and 4.111 seconds through local HTTP. The gateway was restarted between them and reused saved authorization without a second login. Their usages were 10/5/15 and 44/12/56; raw fields and SQLite agreed. The JSON completion-to-finished interval was 4 ms. This does not establish the root cause of the earlier 90-second observation.
- One renewal-only operation replaced expired access and rotating refresh tokens, preserved account/registration/host identity, and saved at 0600. It made zero model calls and required no browser login. It does not prove indefinite unattended renewal.
- One native LOTUS `sem_map` with one row returned `{"answer":2}` in JSON object mode: 59 input, 12 output, 71 total tokens; cached input, reasoning output and cache-write tokens were explicitly zero. LOTUS core counts, raw usage, normalized usage and the single SQLite record matched. Execution took 6.612 seconds; completion-to-finished took 3 ms. Exactly one model request and one client request, zero retries, no login or refresh. Source/configuration hashes, Git state and dependency metadata in the existing Python repository were unchanged. The temporary gateway stopped cleanly and the daily profile was unchanged.

The LOTUS run temporarily selected `profile: "lotus"`, recorded omission of default `temperature=0` and `max_tokens=512`, and imposed a one-request budget plus a transport cap. Python networking was loopback-only, caches were isolated, dotenv discovery and bytecode writes were disabled, and no dependencies were installed. The Node upstream guard allowed only the single official Responses POST and, if needed, bounded OAuth renewal; it made no extra model discovery call.

Private evidence remains under ignored reports/live-restart-*/, reports/token-refresh-*/ and reports/live-lotus-*/. No extra inference was sent to validate documentation. See [LOTUS guide](lotus.md) / [中文指南](lotus.zh-CN.md) for usage and scope. These checks do not validate API-key billing, a full LOTUS benchmark, higher concurrency, other accounts or long-running reliability.

## Private development-branch closeout, 2026-11-06

Fresh type checking and build passed. The expanded offline suite passed 81 tests, 0 failed and 0 skipped; this local run also enabled the optional installed Python SDK example. The installed LOTUS LM / sem_map and ordinary Python SDK check passed with three fixture requests, zero external attempts and unchanged research-source/dependency fingerprints. No new model or OAuth requests were sent during closeout.

The final review found three issues, reproduced before fixing and verified afterward: local JavaScript/Python SDK examples now bypass environment proxies; a slow credential refresh no longer compresses actual inference-send spacing; and the dispatch transition is persisted before sending, so running history no longer incorrectly reports “not sent.” A dispatch-persistence failure prevents the send, consumes no inference attempt and pauses the gateway. The LOTUS guides explicitly exempt loopback addresses from proxies. The test fixtures use fake credentials and loopback-only or in-memory transports.

Candidate and staged-source review covers 65 project files and reachable history. Secret/registration exact-match checks, credential-pattern checks, Markdown links and example syntax are checked without printing sensitive values. Local configuration, client key and subscription authorization remain unchanged; runtime data and closeout evidence stay ignored. The repository remains private and only the development branch is selected for normal push; hosted CI is verified separately from these local results. Account eligibility, actual billing and long-running reliability remain outside this closeout acceptance.

## Independent LiteLLM acceptance, 2026-11-06

This check treats LiteLLM as an ordinary OpenAI-compatible client. It imports neither LOTUS nor agent-memory, uses the gateway's default `strict` strategy, and requires an explicitly selected existing Python environment. It does not install Python packages or add them as gateway dependencies:

```bash
GATEWAY_LITELLM_PYTHON=/path/to/existing/venv/bin/python npm run test:litellm
```

The installed LiteLLM 1.82.6 completed 12 offline scenarios through real loopback HTTP: plain text, JSON object, JSON schema, nonzero cached/reasoning details, missing details, invalid JSON, schema mismatch, interrupted stream, upstream failure, missing usage, rate limit and unsupported parameters. There were 12 client POSTs and 11 fixture calls; unsupported parameters were rejected before dispatch. Each case made exactly one client POST, including 429/502 failures, with no repair or resend. A configured loopback proxy received zero requests while both `NO_PROXY` variants explicitly exempted loopback addresses.

Synthetic core usage was 58 input / 13 output / 71 total. The nonzero-detail sample reported 7 cached input, 3 reasoning output and 2 cache-write tokens; client counts and gateway records agreed, the gateway retained raw fields, and its total remained 71. Missing details remained absent/unknown rather than becoming zero. These are synthetic fixtures, not new account usage measurements, and they do not validate a research repository's final reports.

Node's network guard denies non-loopback fetch/socket/DNS/UDP. The guarded Python subprocess also denies external networking, protected credential/configuration reads, and writes outside this project; bytecode and dotenv discovery are disabled and caches are redirected here. Attempted LOTUS/agent-memory imports fail the acceptance even if caught. The Python SDK-example guard was reused with argument forwarding; its existing `--local` behavior remains covered by the default tests.

Fresh type checking and build passed. The full offline suite passed 82 tests, 0 failed and 0 skipped, with the optional installed Python SDK branch enabled locally. The new default CLI test checks that an unspecified Python environment fails explicitly instead of discovering environments or installing dependencies; the 12-scenario installed-LiteLLM check is a separate optional command and is not claimed as default hosted CI coverage. Private case manifests, client results, gateway ledgers and logs stay under ignored `reports/litellm-*/`.

No real model requests, OAuth operations or remote-network configuration occurred. Research source/configuration/Git-state and dependency fingerprints, plus the gateway's saved local configuration/key/authorization metadata, were compared separately. Documentation now separates the general gateway and LiteLLM guide from optional LOTUS/agent-memory examples and proposed remote deployment. Long-running real service, remote use and the full research workflow remain unverified; this work does not commit or push changes.

## Daily LiteLLM --local example, 2026-11-06

The optional `examples/litellm_client.py --local` reuses the existing Python protected-profile reader instead of introducing another configuration format. It reads only this project's local model/base URL/client key, not subscription credentials. Missing `--local` or unsupported arguments fail before importing model dependencies or reading the key. No login, model discovery, dependency installation or direct paid-API mode is added.

The example passes an explicitly configured official SDK client to LiteLLM, with environment proxies/redirects disabled and retries zero at both layers. The isolated project-copy test deliberately supplies unusable proxy variables and empty proxy exclusions; the example still reaches the loopback gateway, returns `{"answer":2}`, and prints synthetic usage of 4 input / 3 output / 7 total, including 1 cached input and 1 reasoning output token. Its failure case receives one synthetic HTTP 429, exits nonzero and sends exactly one request. Neither output stream contains the generated test key. Earlier targeted runs reproduced the missing example before implementation, then passed after it was added.

Fresh type checking and build passed. All 83 default tests passed, 0 failed and 0 skipped, in a local run enabling the optional installed Python SDK and LiteLLM branches:

```bash
GATEWAY_LITELLM_PYTHON=/path/to/existing/venv/bin/python \
GATEWAY_LOTUS_PYTHON=/path/to/existing/venv/bin/python npm test
```

The ordinary default suite does not require LiteLLM installation; without the explicit Python variable it checks CLI argument handling but does not claim to execute the installed-LiteLLM branch. Python is invoked with bytecode disabled and the existing network/write guard, including protected authorization-file reads. Normal script-directory import resolution is preserved so the example can reuse its sibling configuration helper.

Evidence stays in ignored reports/litellm-local-work/ and isolated local-entry test copies. At that implementation checkpoint the example had not yet been run against a real subscription; production gateway code and other repositories were unchanged, and no real model/OAuth request, commit or push was included.

A subsequently authorized one-request live run passed: `examples/litellm_client.py --local` returned `{"answer":2}` with 15 input / 12 output / 27 total tokens, explicit zero cached/reasoning/cache-write details, and matching client/raw/normalized/SQLite records. There was one client POST, one inference POST, zero retries and one automatic renewal using the saved session, without browser login. Private evidence remains under ignored `reports/live-litellm-local-*/`. This predates the scheduling changes; the newer two-request scheduler check is recorded separately above.
