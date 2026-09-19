# Switchyard feedback follow-up delivery plan

Status: proposed revision 6, 2026-09-18. Planning only; not executing.
Whole-change review baseline: `e8d285b85fa1ba27e62460776bbe3074a255f102`.
Revision 6 retains the simplified scope, narrows health to configuration readiness,
and adds explicit documentation/context acceptance. It supersedes the
earlier assistant-context experiment,
Policy C, unknown-field publication blocking and mandatory 24 answer runs.
The [handoff](switchyard-followup-handoff.md) owns execution arrangements.

## Purpose and scope

Make Switchyard Auto fast, understandable and smaller to maintain. Keep Jev,
four answer roles, three-order averaging, user-turn affinity and Sol failure
fallback. Preserve native/external endpoints, public/session identity, fixed
efforts, capability security, media forwarding, cancellation, compaction and
exact-runtime v2 certification. This is a personal router cleanup, not a routing
research platform. This request authorizes planning only: no implementation,
paid calls, private-conversation export, commits, push or live deployment.
The [completed upgrade record](switchyard-upgrade-plan.md) remains historical.

## Recommended reconciliation

| Feedback | Decision |
| --- | --- |
| Latest user only | Adopt as the initial candidate; fix the historical-media veto without building conversation compression. |
| Assistant context | Defer unless realistic tests demonstrate a material failure. Do not build future selector variants or expand external data exposure now. |
| A/B/C research | Compare A and simple target-aware B only. Defer expected-loss C: Choice probabilities are not established model-success probabilities. |
| Adjacent-model study | Test consequential changed selections only; no mandatory 24-call study. |
| Catalog governance | Explicitly project known fields; omit unknown fields without a dynamic comparison/blocking framework. Preserve known safety rules and app-update review. |
| Health/evaluation subsystem | Minimal classifier health and existing traces; no runtime evaluation-status or calibration state machine. |
| Semantic policy hash | Migrate consumers to existing source/config/build identities and remove Router-specific Rust reconstruction. Preserve deployment verification. |
| History-dependent materialization | Remove B2 JSON from preparation and tests. History explains configuration; it does not produce it. |
| One-off scripts | One small routing evaluator and one maintained live smoke/certification entry point, reusing helpers. Retire unused checkpoint scripts after consumer checks. |
| Patch size | No speculative repin. Keep protocol/security code; remove portions when reviewed upstream actually replaces them. |

## Runtime behavior

### Classifier state

Jev receives only the latest genuine user turn's text. Use actual decoder/item
semantics: tool results may have user roles and must not become the selected turn.
Preserve text belonging to that turn in order. No opening task, assistant answer,
reasoning, encrypted history, tool outputs or summarizer. Do not mutate the native
answer request.

Own this selector in the TypeSafe/Jev path. The patched `task_messages()` helper
is shared with other classifier/judge paths: do not change its semantics globally
to implement this policy. Use one small Jev-specific selector returning selected
text and a same-turn non-text indicator, reusing decoder semantics. Scan backward
past tool-result pseudo-user messages; a media-only genuine user turn must still
be selected rather than falling back to older text. Test that other classifier
paths retain their existing behavior. Do not add a general state-selection API.

Inspect media only in the selected user turn: image/audio/video/file content
causes zero-call Sol fallback with the original payload preserved. Old media
must not veto later text. Continuation affinity remains ahead of classification:
tool-result continuations stay on the chosen target. No phrase detectors.

Classify current work mode, not whether every referent is understood. Criteria
should prefer Sol for ambiguous work mode, and tests must check that behavior;
do not assume vague text always produces low confidence. The answer model still
receives the full conversation. Perfect routing for context-dependent requests
is not promised. A material regression requires a focused decision, not silent
addition of assistant context or broader egress.

Keep the 32768-byte cap on the complete serialized decision request, including
criteria/order overhead. Never silently truncate user text. Oversize causes
zero-call `state_too_large` fallback. This is a local network budget, not Jev's
token context limit.

### Correctness, health and compatibility

Use a 3000 ms whole-request deadline and preserve caller cancellation. Keep Sol
on transport failures. Use a small sanitized reason set: `classifier_unavailable`,
`classifier_timeout`, `provider_http_error`, `malformed_response`,
`state_too_large`, `non_text_state`, plus existing low-confidence fallback.
Retain useful HTTP status without raw provider error bodies.

Expose classifier configuration/readiness through existing health plumbing:
`ready` or `unavailable + reason`, with unknown before initialization is known.
Missing credentials or client-construction failure must be visible while serving
remains live. Ready means configured/initialized, not provider availability.
Per-request timeout, 429 and other failures go to existing traces/counters and Sol
fallback; they do not mutate health. No transient-health recovery policy, rolling
failure state, paid probes or persistent classifier-health database.

Retain trace target, confidence, probability map, latency, fallback reason and
observed provider build. Continue serving a new dated build within the accepted
family. Wrong families/malformed responses remain errors. Compare observed versus
evaluated builds in the evaluator or existing update check, not in runtime drift
state. No runtime change detector or special persistent warning is required.

Build the mixed catalog from known top-level capability/configuration projection
rules and explicitly donor-owned instruction/descriptive structures. Preserve
common capabilities, strict safety flags and neutral instructions. In particular,
preserve donor-owned `base_instructions` and `model_messages`, including nested
prompt metadata, subject to existing identity neutralization and explicit overrides.
Never spread the complete donor or recursively sanitize all instruction metadata.
Unknown top-level fields are omitted without blocking publication. Add a bounded
field-name-only warning to the existing development/Codex-update check when native
fields are outside both explicit sets; no new runtime monitor. Test unknown
top-level fields with scalar/object values and preservation of new nested metadata
inside donor-owned structures. Omission does not prove future compatibility:
update review must inspect required/protocol/safety semantics and add rules when
needed. Do not assume a catalog check catches every semantic change.

Reproduce response identity loss on valid-envelope/unsupported-tool paths.
Decouple identity only if the reproduction demonstrates namespace bypass loses it.
Preserve malformed/ambiguous-input safety; do not introduce a second streaming
parser merely to separate ownership.

Investigate privacy enforcement on the exact Decisions endpoint. General request
documentation does not prove endpoint enforcement. A dedicated key/guardrail is
a contingent option, not permission to change account settings. Successful request
acceptance is not proof of enforcement. Report unresolved limitations; do not
claim enforced ZDR or expand egress on an unverified assumption.

## Configuration and repository size

Template, source lock and its two ordered patches remain authoritative. Materialize
with validation and private URL substitution, without importing B2 history.
Test preparation without history files. Package both patches referenced by the lock.

Use existing provenance: Router commit, Switchyard base/patch identities, binary
SHA, template SHA, generated-route SHA, requested Jev model and observed build.
Evaluation adds corpus identity. Dirty experiments need exact diff/build identity;
HEAD alone is insufficient. Migrate consumers, then remove Router-specific Rust
policy reconstruction. No replacement registry, manifest or cross-language hash
scheme. Verify source/config/build changes remain detectable in evidence and
deployment. Keep private URLs and credentials out of reports.

Keep historical JSON unchanged. Consolidate evaluation/smoke entry points without
building a benchmark framework or deleting unique compatibility coverage. After
completion, archive completed plans/handoffs as history and repair links; keep
durable guidance at existing runtime owners. Do not archive active recovery state.

Keep the active plan discoverable through the Switchyard integration guide and
keep scope, custody and methods in this plan/handoff rather than duplicating them
in AGENTS.md. Maintained docs describe implemented behavior; proposals stay here.
At implementation acceptance, reconcile README, SECURITY.md and Switchyard guides
with verified classifier egress, selected-turn/media behavior, readiness and traces.
The front page must clearly distinguish OpenRouter/Jev classification from native
Luna/Sol/Astra answers. Until C1 lands, document today's opening-plus-latest state
and history-wide media fallback, not the proposed latest-turn-only behavior.

Aim for net simplification of the existing hash/materializer/evaluation machinery.
Every new abstraction must remove a demonstrated source of complexity; no generic
state manager, capability engine or evaluation registry. Report removed/added
production code and retained helpers with a short rationale at review. Line count
is a warning signal, not grounds to delete necessary safety or tests. Large growth
requires a concrete scope justification before acceptance.

## Bounded routing check

Use 40 realistic synthetic conversations once as a regression/promotion check:
short follow-ups, topic switches, media history, compound requests, bounded
exploration, uncertain debugging and hard non-security reasoning. Broaden XHigh
to exceptional reasoning/interacting constraints; security/irreversible effects
are examples. Do not claim optimal roles or general routing accuracy.

Freeze 20 development / 20 held-out cases, acceptable targets and severe failures
before output. Old B2 cases remain development/regression evidence. C2's baseline
is accepted C1, including latest-user-only state, with existing role descriptions,
0.35 threshold and Sol uncertainty fallback. C1 proves mechanical properties:
genuine-turn selection, historical/current-media distinction, unchanged answer
payload and continuation affinity. It does not claim semantic routing quality.
C2 checks acceptable choices for short follow-ups such as “do it”, “continue”,
“review that” and “fix this”, together with topic switches. Their acceptable sets
must be declared before output. Even if A is retained unchanged, evaluate these
behaviors: matching a C1 control cannot hide a bad latest-user-only choice.
A material semantic failure blocks promotion of that selector; unrelated fixes
can proceed with the existing selector, or the lead can propose a focused revision.

On development data compare only:
- A: current argmax; confidence below 0.35 falls back to Sol.
- B: same argmax/confidence; below 0.35 Luna/Sol go to Sol, Astra Medium stays
  Astra Medium, XHigh goes to Astra Medium.

Preserve argmax tie behavior. Score A/B on the same recorded vectors without
duplicate paid calls. Separate criteria changes from fallback changes.
Predeclare six development boundary cases; require A/B disagreement on at least
three before recommending B. Otherwise retain A; do not manufacture qualifying
cases. Handcrafted vectors prove mechanics, not natural classifier behavior.
If the confidence gate never fires, record it as dormant in observed cases and
retain A. Do not start another calibration study or remove the gate in this scope.

Select one candidate on development evidence and freeze it. Holdout compares only
C1 against that candidate, never unchosen alternatives. Require zero severe
under-routes, at most one non-critical paired regression, and acceptable-target
count at least C1's. Failed/inconclusive gates retain baseline; no relabeling or
repeated holdout tuning. Use matched tasks/transport and record builds; provider
build changes confound comparisons. Report provider failures and fallback outcomes
separately without dropping cases. Allow at most one predeclared transient retry,
retaining both attempts; incomplete pairs cannot establish a promotion pass.

Run answer-model counterfactuals only for a consequential changed selection with
a concrete sufficiency concern. During development choose up to two such cases
initially, two runs per affected target (at most eight answer calls). Use checks
or a rubric fixed before answers; report quality, latency and available usage.
A proposed target failing where baseline passes blocks that change pending
investigation. Small samples cannot redefine model roles. Return evidence gaps
instead of expanding the study automatically. Concerning holdout results reject/
defer the candidate, not trigger new tuning. No answer calls for unaffected
boundaries or when no changed selection needs proof.

## Delivery and acceptance

| Gate | Scope and evidence |
| --- | --- |
| C1 — engineering fixes | C1a: Jev-only selection mechanics, timeout, configuration readiness, per-request errors/build metadata, identity reproduction and privacy investigation. C1b: history-free materialization, hash removal, top-level projection and package closure. One review covers both; preserve criteria and A. Show real-decoder mechanical regressions, unchanged other classifiers and negative provenance tests; no semantic routing-quality claim. |
| C2 — bounded routing check | Check semantic acceptability of latest-user-only state, clarify criteria and compare A/B in an isolated candidate using frozen cases. Run only justified outcome probes. Recommend promotion or retain existing behavior with limitations. No assistant context, Policy C or new framework. |
| FINAL — integration | Consolidate scripts/docs, review the complete change against the original baseline, and produce a reproducible release candidate. Earlier gates do not replace final integration review. |

Run required Router checks, relevant integration tests, Rust tests/fmt/clippy,
ordered-patch reproduction and package validation. Test stalled-provider timeout/
cancellation, zero-call local fallback, configuration readiness (unchanged by
transient failures), actual decoder
turn selection, original media preservation, known catalog safety and unknown
field omission. Reuse valid evidence rather than repeat unrelated expensive checks.

Cover affected HTTP/WS identity, tools, affinity, native compaction, effort
distinctions and other endpoint regressions. After authorized release, commit the
clean candidate, deploy transactionally and renew exact-route Switchyard v2 proof
under existing maintenance procedures. Never reuse old proof for changed runtime
identities. Keep rollback until live checks pass. Report code readiness separately
from deployment/certification completion.
