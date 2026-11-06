# Troubleshooting

- **Same answer for every prompt:** default upstream is an offline fixture. It is neither a model nor a token estimator.
- **Node/SQLite/TypeScript unavailable:** use Node.js 26+ and project-local npm dependencies.
- **Model not available:** choose a model eligible for the selected upstream/account. The local /v1/models endpoint only reports configuration. Startup does not verify access.
- **401 invalid_local_key:** set the same GATEWAY_LOCAL_API_KEY in server/client/monitor. The upstream key is different.
- **403 invalid_origin:** use the exact numeric loopback URL. Public hosts and cross-origin browser calls are not supported.
- **Login required:** stop the subscription server, then run npm run auth -- login with the same config. Login does not send inference. Status reads only local state and cannot prove remote access remains valid.
- **Authorization in use:** stop the existing subscription process before login/logout or a second server. OS SQLite locks release after process exit; do not delete credential/lock files to override a running service.
- **Private directory required:** use a dedicated private subdirectory for authPath. Existing shared directories are not chmodded automatically.
- **Wrong account:** the single registration is bound to its verified identity. Account pools/switching are not implemented; do not rotate identities to evade limits.
- **Refresh temporarily fails:** credentials are retained; no model call is automatically retried. Confirmed invalid refresh tokens require fresh login.
- **Logout revocation unconfirmed:** local tokens were cleared, but remote revocation was not confirmed. Disconnect the app in ChatGPT Settings.
- **Sender cooling down:** a recognized temporary error supplied a reliable waiting hint. Unsent work may continue later; the failed call is never resent. `slow_down` increases the effective interval for this run. An individual deadline can still expire first.
- **429 dispatch_expired:** the deadline expired before sending. No inference attempt was consumed, the sender remains usable and any existing cooldown remains active. Increase the waiting/execution deadline deliberately if a batch needs to wait longer.
- **Sender paused:** quota/balance/permissions, missing reliable hints, unknown errors and storage failures require inspection. Restart only after checking the cause; it resets local budgets and pacing, not provider limits.
- **Budget overshoots:** the token stop condition uses already observed usage. It does not cap an in-flight request. Configure provider-side billing controls separately.
- **Database unavailable:** dispatch pauses; successful persistence cannot be faked and requests are not resent to repair a ledger.
- **Old running row:** this is historical last-known state, not a recovered task.
- **Slow response:** inspect headers, first-text, terminal and finish timestamps. Buffered API-key responses have no true first-token measurement. The historical 90-second request lacks this timeline; its root cause remains unconfirmed. An offline regression verifies completion no longer waits for an open transport tail.
- **Monitor prints once:** non-TTY output uses one-shot mode. Use a terminal for keyboard navigation; Q does not stop the gateway. The monitor reads no upstream credentials.
- **No Python:** only POSIX terminal tests require it. Set GATEWAY_TEST_PYTHON to an existing Python 3.9+ interpreter. LOTUS checks are optional and use GATEWAY_LOTUS_PYTHON without installing dependencies.
- **Unsupported request parameters:** ordinary API-key parameters are preserved within the supported subset. Subscription strict rejects unsupported parameters; optional lotus records omissions, which do not enforce those settings.

Unsupported: streaming clients, tools/images/audio, full provider framework, exposed-network service, task recovery and shared-account operation. Subscription serving has passed bounded live text/JSON, restart reuse, renewal, LOTUS sem_map and independent LiteLLM checks. The current scheduler also passed a separately authorized two-request check with actual concurrency 2 and a 3-second send interval. API-key serving and real-limit recovery have offline acceptance only; long-running reliability remains unverified. See the [verification record](offline-verification.md), including the earlier test-only observer failure.
