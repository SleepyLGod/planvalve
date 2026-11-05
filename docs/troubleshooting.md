# Troubleshooting and known limits

- **Missing `node:sqlite` or TypeScript execution support:** use Node.js 26+ from the project requirements. All dependencies are project-local; no global TypeScript installation is needed.
- **Address already in use:** choose a free `port` in a copied configuration file, then point the monitor at that exact loopback origin with `--url`.
- **Dashboard exits after printing:** non-interactive stdin/stdout intentionally use one-shot mode. Run in a real terminal for TUI interaction.
- **No `python3`:** set `GATEWAY_TEST_PYTHON` to an available Python 3.9+ executable for the POSIX terminal tests. The gateway itself does not require Python. PTY tests target macOS/Linux, not Windows.
- **LOTUS is unavailable:** `test:lotus` is optional. Set `GATEWAY_LOTUS_PYTHON` to an existing environment containing LOTUS, LiteLLM and pandas. No repository-specific virtualenv is required or installed automatically.
- **Unknown mock-model price:** LOTUS may warn that it cannot price `offline-model`; token assertions remain meaningful, monetary estimates do not.
- **Same answer for different prompts:** the default server uses a fixture, so this is expected. It is not a real model or a token estimator.
- **Probe sign-in expires or lacks plan permission:** no inference is sent. A later explicitly requested probe can start a fresh authorization. Do not repeatedly retry a rejected request or switch billing silently.
- **Probe selected-account mismatch:** the single local registration is bound to its verified account. Multi-account management is not implemented.
- **Sender paused:** inspect the recorded error. Offline state resets with a process restart; a real probe ends rather than auto-retrying.
- **Token budget overshoots:** `stopAfterTokens` is checked from observed usage before the next dispatch. It is not a hard token ceiling for a request already running.
- **Database cannot be written:** new dispatch pauses and the response cannot pretend persistence succeeded. Check the configured local path, permissions and other writers.
- **Old running record after restart:** historical state is only the last recorded state. Tasks are not resumed or resent.
- **Slow real response:** the two-call observation included a JSON gateway response of about 90 seconds. Its latency cause is unresolved; no performance claim is made.

Current compatibility is text messages, non-streaming client responses, text/JSON output and the documented parameter profiles. No embeddings, audio/images, tool execution, full provider framework, crash recovery, remote access or persistent real serving is claimed.
