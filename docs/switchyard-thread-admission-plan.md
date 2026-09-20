# Switchyard failed-projection correctness

Revision 2, 2026-09-20. Planning only. Current baseline:
`60be2390680be7d202a5c2668efbaeaa85278811`. Accumulated admission work began at
`3f352ae7f08759cc03c4c80b3a636d9ffe93f28e`. Call-linked result exclusion and
source/receiver validation are implemented; source remains v1/draft.

## Outcome and diagnosis

Recognized new assignments with unsafe or unavailable projections must release
old affinity and choose Sol without sending rejected content to Jev. Ordinary
tool continuations retain the selected model. Valid projections classify only
their text; requests without an attempted projection retain normal selection.

The canonical patch currently makes the attempt marker authoritative for affinity,
but `classifier_turn` checks only projection text before falling through to
`latest_user_turn`. The review identifies an unpaired Responses function output
as a decoder path that becomes user text. Reproduce that path in the actual Rust
server before correction. A JavaScript fixture implementing null-to-Sol directly
cannot establish this invariant.

Use the existing `CODEX_ROUTER_TASK_PROJECTION_ATTEMPT_KEY`; no new sentinel,
Router workaround, cache, registry, parser framework, classifier policy or repin.
Preserve encrypted-child extraction, its bounds, native input, private projection
removal and the existing desktop-only admission scope.

## Delivery

### 1. Enforce the cross-layer contract

Reconstruct the locked Switchyard source and ordered patches. Add a failing real
server regression using the actual decoder, affinity and TypeSafe classifier
with a recording provider stub and mock answer upstream. Retain a non-Sol target,
then send an authenticated null projection with an unpaired `codex_app` function
output. Assert default/Sol and unchanged provider call count. Repeat with older
genuine user text before it, and valid versus malformed delegation text. Show
failure on the old patch before correction.

Make attempted projection without usable text bypass ordinary selection and take
the existing fallback, preferably `non_text_state`. Text projection takes precedence
when valid. No attempt preserves normal behavior. Test those controls, ordinary
continuation affinity, the existing encrypted handoff failure, and absence of private
fields/rejected content at inappropriate upstreams. Update the canonical patch
and source-lock hash; do not retain an alternate maintained fork.

Run required locked Rust suites, formatting, clippy and release build from the
maintenance guide, then focused Router regressions and `npm run verify`.
Report real Rust integration separately from simulated JavaScript affinity.

### 2. Restore public documentation boundaries

Remove the public worker handoff and maintained-spec pointers to temporary
execution documents. Keep this portable technical proposal until acceptance;
local worker instructions belong in ignored scratch space. Adjust context
ownership guidance narrowly so private paths, skill hashes, custody rules and
temporary authorization state are not published in product documentation.

Shorten README privacy disclosure to include ordinary user turns, recovered native
child assignments and recognized app-thread delegated input. Distinguish that
intentional exception from ordinary tool outputs; link SECURITY for exact limits.
Task text itself may contain sensitive material. Retain the host final-item
currentness assumption and intentional `codex_app` namespace scope.

Check directly related tracked documentation for worker-only remnants and repair
links. Do not mass-delete useful history. Removing a current file does not erase
its old public commits; history rewriting is outside this delivery.

### 3. Validate and release the exact candidate

Review code, real server tests and docs before live replacement. Keep source
v1/draft. At release readiness, prepare version `0.7.0` consistently across version
owners, validate and commit the candidate before deployment. Do not bump after
certification, which must bind the actual deployed version and source. Do not
retag `0.6.1` or infer that a release/tag is authorized by implementation.

Use the maintained rollback-owning deployment transaction. On the real Windows
app create a synthetic task and send successive app-thread messages. Verify
current-only decisions, at least two selected targets, and retained history/tools.
Ordinary call-linked results and continuation/resume history must not classify an
old delegation. Repeat native encrypted-child checks. Correlate actual turns to
classifier records; use bounded synthetic-only temporary observation if needed,
not permanent payload logging. Do not substitute an isolated app-server fixture
or model PASS text for this desktop evidence.

Run exact-route v2 certification and maintained live verification against the
deployed commit/binary/routes. Promote only after acceptance; otherwise keep v1
or restore the known-good runtime and retain rollback. Final review includes the
accumulated admission behavior and inherited assumptions from earlier commits.

On acceptance, archive a sanitized technical result under `docs/history` and
repair links. Keep runtime and proof-only commit identities explicit. Do not
archive or publish a worker-specific execution handoff.

## Acceptance and status

- Actual decoder-to-classifier regression fails before and passes after the fix.
- Failed projection makes zero Jev calls regardless of decoded text or older history.
- Valid projection, ordinary selection, affinity and native input remain correct.
- Real Windows app follow-up/replay and native child evidence pass on the deployed
  candidate; exact-route v2 proof is current.
- Product docs contain durable technical guidance, not local orchestration details.
- Required checks and final review pass; green CI alone is not live acceptance.

Revision 2 is planned, not executed. Commit, deployment and certification remain
separate release actions. Installed runtime and checked-in source are distinct.
