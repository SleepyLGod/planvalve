# Independent two-request subscription probe

The default `npm start` remains offline. Explicitly start the separate interactive probe with:

```bash
npm run probe:live
```

Open its loopback login page and choose your ChatGPT account on the official authorization page. No model call is made before authorization. The login callback must arrive within 30 minutes; a valid callback clears that waiting timer. Individual network requests retain their own deadlines.

OAuth access, refresh and ID tokens remain in process memory and are never saved. The probe never reads Codex credentials or Platform API keys. `data/subscription-probe-registration.json` retains only the stable host ID, issued client ID and an identity hash for checking the same registration on a later sign-in. It contains no bearer credentials.

After authorization the probe discovers the account's available models, preferring the previously observed gpt-6-luna when still available, then another small text model in that catalog. The actual selected model is recorded. It sequentially tests:

1. Text: `Reply exactly: OK`.
2. Strict JSON schema: 1+1, requiring `{"answer":2}`.

Both requests pass through local Chat Completions HTTP, the existing gateway conversion/accounting/SQLite, the official SDK, and `https://api.openai.com/v1/responses`. No agent prompt or project files are added. Each request sets store=false and stream=true. Concurrency is 1, minimum start interval 3 seconds, SDK retries 0. Both the gateway and explicit transport cap attempts at two. Any failure or unexpected output stops the run without retry or billing fallback. The 3000-token stop threshold applies after observed usage; it is not a server output cap.

Evidence is saved under a new `reports/subscription-probe-TIMESTAMP/` directory: attempt markers, model, cases, raw usage, redacted HTTP errors, terminal-event errors, gateway ledger and separate SQLite. The bilingual snapshots are status-zh.txt and status-en.txt. The gateway and authorization listener close when the probe finishes.

This is a bounded integration check, not a persistent authenticated service or a full LOTUS benchmark. Offline tests cannot establish live success; read that run's result.json for the actual outcome.

Official references: [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
