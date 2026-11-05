# Privacy and security

The service is intended for local, single-user use. It binds to loopback, has no network-exposure option or application authentication, and must not be exposed through a public tunnel or reverse proxy without additional design.

## Local data

- `data/`: SQLite history and the probe's host/client registration identifiers and identity hash. These identifiers are not access tokens but remain private local metadata.
- `reports/`: probe results, raw usage and attribution, chosen outputs, provider diagnostics, test databases and terminal captures. Do not assume every diagnostic is anonymous.
- `.client-cache/`, `.npm-cache/`, `node_modules/`, `dist/`: local caches, dependencies and generated artifacts.
- Environment files, private keys and database files are ignored as a second layer of protection.

The ordinary ledger omits message and output bodies. Parameter transformation values, errors and hashes can still disclose information. The explicit probe stores its fixed toy outputs for verification.

OAuth access/refresh/ID tokens exist only in the probe process. The probe does not read Codex credentials or Platform keys and does not implement persistent token storage, refresh or account switching. Its registration metadata stays local. The probe is limited to two model attempts and has no inference retry or billing fallback.

## Before pushing

Inspect the exact Git index/diff. Never force-add runtime data, real registrations, environment files, credential material or unsanitized screenshots. Ignore rules do not protect files already tracked. The shipped fixture has replaced response/message identifiers and contains no account identity or credentials; its provenance is documented separately.

For a suspected credential exposure, stop sharing the affected material and revoke the relevant credential through its provider. Do not paste credentials into an issue. This document describes the current local prototype, not a comprehensive security certification.
