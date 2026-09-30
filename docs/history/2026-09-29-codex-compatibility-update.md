# Codex compatibility update — 2026-09-29

Historical source and acceptance evidence; maintained guides and the exact
installed generation remain current authority.

## Reviewed changes

The installed Windows app is 26.928.1915.0, its signed CLI is 0.159.0, and
codex-app-tools is 0.1.5. Native catalog parsing passed for all retained routes.
Official release notes were reviewed at https://learn.chatgpt.com/docs/changelog.
CLI 0.159.1 adds native model catalog entries; this update does not replace the
app-managed CLI or change Switchyard's selected models or classifier policy.

All 40 original-Router commits from 9fb6440d through 84c6e1ba were dispositioned
in `maintenance/upstream-router.json`. Undici advances from 8.10.2 to 8.11.2.
Windows process-record startup uses a larger timeout and one timeout-only retry,
with absolute system PowerShell resolution. Normal ownership checks retain
their short budget; private-file ACL errors remain fatal. Homebrew runtime
selection, generic gateway compaction, Azure, unrelated providers, and UI work
were excluded from the retained Windows product.

Switchyard advances from 9cf6fadf to fbabf51c, incorporating 11 upstream commits.
Relevant fixes redact echoed provider content in request/SSE logs and preserve
streamed response and reasoning identities. Optional de-escalation remains
unused. Upstream field omission precedes default insertion; Router's recursive
overrides and final removals remain separate and keep their ordering. A wire
regression checks omission/reintroduction and final removal together.

The reviewed TypeSafe PR #762 source identity remains 92c84a0c. Both ordered
patches were rebased onto the new public base. Configuration conflicts were
resolved by retaining upstream omission fields alongside Router routing IDs,
descriptions, overrides, and removals; a test backend gained the upstream field.
Patch hashes and the exact public base are recorded in `source.lock`.

## Candidate verification

Rust 1.96.1 formatting, workspace Clippy with warnings denied, the maintained
six-package test suite, and the release build passed. The new ordering regression
also passed after its addition. The offline input-fidelity evaluator replayed
both checked-in patches cleanly and passed all eight cases (six exact-state,
two zero-call fallback), with no paid decisions.

Router `npm run check` passed; all 344 tests passed with no skips under normal
Windows user authority. The current CLI parsed 14 native catalog models and
passed the retained route checks. The candidate also accepted the installed
private routes in `--dry-run` mode. `git diff --check` passed.

The candidate binary SHA-256 is
`03d87c25e635f3b88d716af996ed7fb4d0c11db527bfb57b32796ac08578a968`.
Switchyard eligibility is v1 and its application is draft until fresh native
certification accepts the changed runtime. Deployment and live proof are
recorded separately after their actual completion.
