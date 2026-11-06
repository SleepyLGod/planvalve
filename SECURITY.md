# Privacy and security

Local, single-user prototype. Do not expose its port through public proxies, tunnels or shared networks without a separate access design. Both supported real upstreams have fixed official HTTPS destinations, redirect rejection and zero automatic inference retries.

## Credentials and access

Real modes require a separate GATEWAY_LOCAL_API_KEY on model and monitoring routes and validate loopback Host/Origin. Health reveals only health/mode. Caller-supplied authorization never becomes an upstream key. API mode reads only explicit OPENAI_API_KEY. Offline serving does not inspect upstream credential variables. This is not an isolation boundary against a compromised operating-system account.

Subscription credentials belong exclusively to this tool, under data/auth/ by default; no Codex credentials or configuration are consulted. Directory 0700, files 0600, atomic credential replacement, one process holding the registration's SQLite lock. The lock contains no tokens. Temporary failures preserve credentials; terminal refresh failures require login. Logout distinguishes local clearing from confirmed remote revocation. See [authorization](docs/authorization.md).

The explicit two-request probe uses the same OAuth validation with an in-memory credential store, retains only non-bearer registration metadata, and never imports persistent authorization.

## Private local data

- data/: credential records, non-secret but private client/host registration information, authorization-lock databases and request history.
- reports/: fixture/live probe results, raw usage/attribution, fixed probe outputs, test databases and terminal captures.
- .client-cache/, .npm-cache/, node_modules/, dist/: private caches, dependencies or generated output.

Ordinary history omits prompt/output bodies. Provider error messages are omitted from the gateway ledger; safe machine codes and HTTP metadata remain. Known credentials are redacted before persistence. Parameter values, raw usage, hashes and identifiers can still reveal information. Explicit probes save their fixed toy outputs and may include provider diagnostics; do not assume these reports are anonymous.

Keep all runtime data, environment files and unsanitized screenshots out of Git. Ignore rules are only a second layer: inspect exact changes, since force-add and already-tracked files bypass them. Never paste tokens into issues or support transcripts. Revoke an exposed credential through the provider and stop sharing affected material.

## Limits and verification

Concurrency 1 does not guarantee compliance with RPM/TPM, account policy or other applications' shared limits. Local budgets reset per process and are not billing controls or account balances. API credits may fall through to existing purchased credits under platform billing rules.

Offline tests deny external connections and simulate authorization/provider responses. They do not certify production security, real account eligibility or long-term live reliability. CI contains no provider secrets and no live probe.

## Saved local connection profile

The optional local entry stores its config and randomly generated local client key under ignored data/local/, with directory 0700 and files 0600. It rejects symlinks, insecure permissions, corrupt/partial state and conflicting reinitialization; it never automatically overwrites or rotates keys. Status reads only this profile and local client key, not subscription credentials. The key is passed to child processes through their environment, never through command arguments or normal output. --local client examples read the same private settings; invoking those examples performs inference. No upstream API key, global shell profile or background startup service is installed.
