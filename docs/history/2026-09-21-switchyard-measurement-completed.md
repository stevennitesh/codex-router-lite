# Switchyard measurement and classifier input fidelity, completed

2026-09-21. Revision 3. Source comparison: `cc6122d9`. Status: completed.

## Purpose and decisions

Make routing evidence useful for deciding whether Switchyard improves completed
work, while preserving the four configured model/effort pairs, task affinity,
Sol fallback, confidence gate, caller speed, pinned Jev and existing privacy
boundaries. The first delivery is read-only measurement plus offline input tests.
It makes observable facts and missing evidence explicit; it does not claim savings.

The comparison project at
[`76a1dc5c`](https://github.com/0xNatoshi/jev-codex-router/tree/76a1dc5c)
usefully separates policy, reporting, and replay. Its `BACKTEST.md` explicitly
limits the roughly 60% figure to an older policy and fixed-token repricing.
Its replay still prepares state differently from live requests. Borrow the
measurement questions, not that routing implementation or its price table.

Current local authority remains [Switchyard](../../config/switchyard/README.md),
[runtime diagnostics](../../config/switchyard/runtime.md), and
[security](../../SECURITY.md). No new routing service, database, dashboard, online
shadow process, prompt logging, model labels in answers, generic classifier API,
or hidden provider fallback is needed.

## Evidence limits that determine this delivery

The pinned `switchyard-server` routing log records selected routing identity and
session-level usage records. Its usage normalizer substitutes zero for missing
fields; failed streaming attempts may have no routing record. The Router timing
log does not link every native attempt or extraction call to these records.
Thus an HTTP 200, a routing record, a session and a completed user task are four
different facts. Do not join records by timestamp proximity or assume a session
contains one task. Blank routing-log `tier` is not proof of standard service tier.

This slice cannot establish complete per-attempt accounting, actual subscription
debits, task success, corrections or savings against all-Sol/all-Astra. It will
show these coverage gaps, not build a telemetry framework to fill them. Even a
fully specified price table would not fix missing observations. Fixed-token
repricing and counterfactual quality claims are deferred until input provenance
and task boundaries support them.

## Deliverable 1: read-only routing usage report

Extend the existing trace/reporting entry point, reusing its parsers where their
semantics are appropriate. Avoid creating a parallel reporting service.

- Offer session summaries and an explicitly selected session/time window for
  examining a user-defined task segment. Label the grouping accurately; report
  no automatically inferred task boundaries or task outcomes.
- Count serving records using `routing.jsonl` alone. Map known routing IDs to
  native model and fixed effort through existing config authority. Keep unknown
  targets unknown. Do not count outer Router and inner native timings as extra
  bills. Report observed record distribution, not complete billed attempts.
- Keep logged input/cache/output counters, missing/invalid/zero-ambiguous usage
  coverage and finite numeric validation. Never add reasoning tokens to output.
  Do not silently interpret omitted counters as zero. Explain that even explicit
  zero can mean missing in this log version. Distinguish partial recorded totals
  from task totals and disclose unrecorded failed attempts.
- Show classifier distributions/fallback reasons, latency and available policy
  provenance in their actual scope. Keep unassociated generation-wide data
  separate from session/task-window accounting. Retries, extraction overhead,
  service tier and completion/correction outcomes remain unknown when unlinked.
- Keep raw session/agent/correlation IDs, paths, tasks, payloads, tokens/credentials
  and arbitrary log strings out of report output. Group internally using IDs,
  expose local ordinal labels, and accept explicit private selection locally.
  Bound report detail; retain existing trace and certification command behavior.
- Do not label today's source template hash as the policy of old log records.
  Runtime provenance may describe a generation only when that binding is known;
  otherwise the policy identity is unavailable.

## Deliverable 2: actual classifier-state regression

Extend the existing routing evaluator with a clearly offline input-fidelity mode.
The installed binary correctly restricts the classifier URL to the production
OpenRouter Decisions endpoint, and its Windows platform verifier has no
process-local trust override. The original loopback-binary assumption was
therefore invalid. The accepted correction materializes the exact locked source,
applies both hash-bound patches in order, and runs the actual Rust Responses
decoder, `/v1/decision` handler and classifier against an in-process recording
provider. This small test-only transport delta is recorded explicitly. It does
not patch production source, alter the active runtime, contact a live provider,
or claim installed-binary parity.

Add a small authored synthetic fixture section alongside the maintained corpus
without silently changing its frozen development/holdout labels or gates. Cover:
latest genuine user versus developer/system harness wrappers; a decisive middle
constraint in a long bounded task; a short follow-up; quoted wrapper-looking text;
old assistant/tool material; current media/unknown content zero-call fallback;
and supported delegated assignment projection versus old/control history.
Assert exact captured state or explicit zero-call fallback, not selected labels
alone. Do not strip user-authored markup or truncate to a tiny head/tail excerpt.

Keep production/replay state construction at the actual Switchyard owner. Record
locked source, ordered patch, corpus, evaluator and test-only delta identities
with fidelity results, separating
configured/provided identities from verified ones. Use only synthetic fixtures;
the offline mode must not resolve real credentials or contact external services.
Retain the existing paid evaluator's explicit invocation and synthetic boundary.

## Delivery approach and acceptance

One coherent implementation, final gate M1; no intermediate gate is warranted.
First implement the report, then fidelity fixtures/mode and maintained usage
documentation. Routine file organization and CLI spelling remain implementation
choices; update package/product allowlists only for necessary new owned files.

Required proof:

1. Mixed synthetic logs with interleaved sessions/native calls, missing and
   invalid usage, zeros, retries/failures without attribution, unknown targets,
   and hostile metadata produce honest bounded summaries without leakage or
   double-counting. Independently assert numeric sums and coverage semantics.
2. The ordinary command reaches the report on a private local log snapshot
   without changing runtime state. Inspect only the redacted result; no private
   session content may enter fixtures or checked-in evidence.
3. Offline fidelity mode passes against the exact locked and patched source,
   with the in-process recording provider proving exact state/zero-call
   expectations through the real decoder and handler. All spawned processes and
   temporary files are cleaned up, and no provider credential or endpoint is
   available. Installed-binary parity remains unproved and is stated as such.
4. Relevant tests, `npm run verify`, product/package checks and final whole-diff
   review pass. Existing runtime policy/patch/template and source eligibility
   are unchanged. The already-pending data-only terminal deployment is separate.

No commit, push, deployment, live policy changes, paid classification, private
replay or new classifier egress is part of this execution. At acceptance, move
this completed record to history and leave operating instructions at existing
maintained owners.

## Completion evidence

- The maintained mixed-log regression covers interleaved sessions, known and
  unknown targets, malformed lines, missing and invalid counters, ambiguous
  zeros, bounded detail, time filtering, noncanonical parseable dates, and
  hostile model metadata without identifier or arbitrary-string leakage.
- The ordinary `switchyard-trace --usage --limit 5` command read the installed
  467-record snapshot successfully and emitted only aggregate route, token,
  session-ordinal, coverage and separate generation-scope data. No raw log or
  identifier was copied into the repository.
- The exact-source fidelity run passed eight authored cases: six exact-state
  captures and two zero-call `non_text_state` fallbacks. It verified upstream
  commit `ee3715d10ad3e43a2d6f2efc6c4c7a0964b00877`, contribution patch SHA-256
  `c5e4328c2b305d769b5f8776cf666ec6c61ec34c65ea29ac7202b27587e10e7a`,
  compatibility patch SHA-256
  `6ddc87abe19cf709b3b548304b27b683420323a18fab0bc753bbe627c7b28bad`,
  test-only delta SHA-256
  `4b2f6bb35d2c2c891c8a6890282c9dfbaebc761fbb4f333c96334cc8d937ab25`,
  corpus SHA-256
  `98301f214e98ac1a4b259efcce979e7cd5f2c0858f2f7caa402d5937f2f5307b`,
  evaluator SHA-256
  `8a07045a210b7309c8b46540811f58eafdd760349766c504ba186e532bfdf8c1`,
  and Cargo 1.96.1. The long-state case is 2,192 characters with its decisive
  constraint at offset 1,030, outside both 500-character ends; the wrapper case
  preserves literal `<environment_context>` text. The proof used no credentials,
  paid calls or live endpoint. It proves the exact locked and patched source path,
  not installed-binary parity.
- Ordinary paid evaluation continues to accept valid schema-v1 development and
  holdout corpora without a `fidelity` section, and its request model, input,
  storage and streaming fields remain evaluator-owned.

## Later experiments, not implementation scope

After trustworthy measurements identify a recurring gap, compare exactly one
challenger objective against the current four-choice question. Use an explicit
Sol Medium baseline and fixed service tier for paired verified whole tasks.
Record outcomes and corrections, not just decision disagreements. Private replay
requires explicit dataset selection and egress authorization. Sampled live shadow
and per-tool routing would require a separate opt-in privacy/product decision
and evidence on cache effects, quality and total work. Neither is implied by this
plan. Do not expand to fifteen choices, remove the confidence gate, replace
Switchyard, or change fallback policy without that evidence.
