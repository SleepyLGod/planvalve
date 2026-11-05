# Publication privacy review

The intended destination is a private repository under the maintainer's personal account. Organization repositories and organization authorization are outside this task. The broad GitHub CLI browser authorization was cancelled; any upload must use the explicitly selected personal destination.

## Changes before the first commit

- Removed workstation-specific home paths from source, scripts, tests and README instructions.
- The default tests use an available Python interpreter rather than a separate private repository's environment. The optional LOTUS environment and source checkout are explicitly configured by the caller.
- Kept runtime registration identifiers, identity hashes, SQLite databases, raw response/usage reports, caches, terminal captures and implementation notes local and ignored.
- Added environment/key/database ignore rules. Staging uses an explicit source/documentation list, not a bulk force-add.
- Replaced local-report documentation links with standalone verification descriptions, and added bilingual quick starts, data-handling notes and troubleshooting.
- Kept the project private and unlicensed rather than granting an unsolicited open-source license.

## What was checked

The initial staging review inspected the exact Git index, checked that local data/report/credential paths are ignored, and scanned for private home paths, common OpenAI/GitHub token shapes, JWTs, private-key blocks and concrete runtime registration identifiers. No matching credential or personal home path was found in the candidate source/documentation files. Local audit details stay in ignored reports.

The published fixture contains replaced response/message identifiers and a minimal arithmetic output; it is derived from parsed events, not an original network capture. Runtime metadata is not needed to reproduce the offline checks.

This is a scoped publication review, not proof that every possible secret format can be detected. Review future diffs and never force-add private runtime state. Registration metadata, parameter values and provider diagnostics can still be sensitive even when bearer credentials are absent. See [SECURITY.md](../SECURITY.md).
