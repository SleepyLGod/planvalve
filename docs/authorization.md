# Authorization

Use your own account on your own machine. The gateway never reads Codex or other agents' credentials. Persistent credentials and the memory-only two-request probe are separate registrations and storage paths; no probe credential import occurs.

```bash
npm run auth -- login --config gateway.subscription.example.json
npm run auth -- status --config gateway.subscription.example.json
npm start -- --config gateway.subscription.example.json
# Stop the server, then:
npm run auth -- logout --config gateway.subscription.example.json
```

Login prints an official browser URL, starts an IPv4 loopback callback listener, and waits up to 30 minutes. No inference or model discovery is triggered. The callback uses PKCE S256, random state and nonce, one-time consumption, signed ID-token validation against published JWKS, issuer/audience/expiry/nonce checks, verified account identity and granted plan scopes. Returning logins reuse the stable host and issued client ID. One registered identity is supported; a different account cannot silently replace it.

`auth status` is local and prints only authorization state. It does not validate access remotely or reveal tokens. A valid local credential record is not a guarantee of current upstream eligibility.

The private credential record holds client/host identity and the latest access, refresh and retained ID tokens. The private directory is 0700 and files 0600, with atomic replacement. Choose a private subdirectory if a configured existing directory is shared. Tokens are not placed in SQLite, config, reports or logs. No ID-token hint is printed in authorization URLs.

The service refreshes within 60 seconds of access expiry, before inference. Token responses replace access/expiry/scopes and rotating refresh tokens together; returned ID tokens are verified. Refresh calls are serialized. A held SQLite transaction prevents a second process, login or logout racing that registration. It stores no tokens and closes with the process, avoiding stale lock-file recovery logic.

A separately authorized live check on 2026-11-06 refreshed an expired saved access token once, with zero model calls and no browser login. The new access and refresh tokens were saved at 0600; registration, verified identity and host remained the same. This confirms one real renewal, not indefinite unattended operation. Restart reuse had also been checked across two real inference requests. Local `auth status` alone does not prove either behavior remotely.

Temporary errors preserve stored credentials and stop this request. Confirmed terminal refresh failures clear tokens and require login. No inference retry follows a refresh or authorization error. Stop the service before reauthorizing or signing out.

Logout attempts refresh-token revocation and then clears local tokens while keeping registration metadata for the same account. If remote revocation cannot be confirmed, the command explicitly reports it; disconnect the app in ChatGPT Settings. No background revocation retries are started.

API Key mode reads only the explicit `OPENAI_API_KEY`. The local client key is separate. There is no organization Admin Key, auto-credit redemption, billing fallback or account pool.

Official references: [registration/storage](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [sessions/refresh/revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [token lifetimes](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).
