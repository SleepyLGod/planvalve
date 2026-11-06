# Offline verification

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
