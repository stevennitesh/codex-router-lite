# Switchyard feedback follow-up delivery plan

Status: proposed, revision 1, 2026-09-18. Planning only; implementation has not
started. Baseline: `e8d285b85fa1ba27e62460776bbe3074a255f102` on `main`.

## Purpose and boundary

Keep the four-target Jev architecture while correcting demonstrated integration
defects, reducing maintenance burden, and making routing-quality claims match
their evidence. Router Lite should remain a small personal-workflow router.
This is a follow-up to the completed [upgrade record](switchyard-upgrade-plan.md),
not a reopening of its implementation or an automatic rejection of its transport
and v2 evidence. The [execution handoff](switchyard-followup-handoff.md) owns
worker selection, custody, authorization and checkpoint accounting.

Preserve public identity, fixed answer efforts, Sol transport-error fallback,
continuation affinity, native compaction, capability authentication, cancellation,
media forwarding and all other endpoint behavior. No new classifier, stage router,
telemetry service, online learning system or broad Switchyard repin is proposed.
Do not alter live configuration, run paid evaluations, commit, push or deploy as
part of this planning request.

## Assessment of the supplied feedback

The feedback reviews the resulting implementation, not just the closeout commit.
The following dispositions distinguish observed code from hypotheses. The original
B2 files remain historical evidence and must not be rewritten to improve results.

| Finding | Assessment and recommended disposition |
| --- | --- |
| Global confidence threshold | Confirmed evidence limitation. Recalculation from B2 results gives minimum confidence 0.373333 for 100 training cases and 0.644444 for 24 fresh-holdout cases. None exercised the 0.35 fallback. Describe it as a heuristic selected on synthetic development data, not validated uncertainty calibration. Keep it as the baseline until the policy gate; do not set it to zero by intuition. |
| Uncertain Astra falls to Sol | Confirmed rule; the quoted probability example would fall back. That is consistent with the earlier explicit Sol-default contract, although it may conflict with the desired asymmetric loss. Compare alternatives before changing that accepted meaning. |
| Synthetic holdout and taxonomy | Agree with limited generalization. The later holdout was newly authored after development feedback; this does not prove direct reuse of the old holdout, but neither does it establish independent or real-world validation. Evaluate routing labels and model outcomes separately. |
| XHigh definition | Current criteria emphasize consequential state/security effects. Broaden the proposed definition to exceptional reasoning and interacting constraints; preserve security/irreversible effects as examples. Evaluate before promotion. |
| Referential follow-ups | Confirmed state omits assistant answers. Misrouting is plausible, not yet reproduced. Add realistic conversational fixtures before choosing whether assistant context is necessary. |
| Historical media | Confirmed: `has_user_non_text` inspects all user messages before state selection. Restricting it to opening plus latest alone is insufficient when the opening turn contains media. Resolve this with the state-selection contract below. |
| Timeout | Confirmed 30000 ms whole-request deadline. Recommend 3000 ms, preserving caller cancellation and measuring timeout/fallback rate. This is a latency tradeoff, not a claim that historical p99 predicts future outages. |
| Provider build drift | Family-prefix acceptance permits new builds. Record expected versus observed build and invalidate the evaluation-applicability claim on mismatch; recommend visible degradation rather than automatically disabling usable routing on every build update. Wrong model families remain rejected. |
| Classifier health and error reasons | Startup-unavailable provider fails open; aggregate `provider_error` obscures causes. Expose minimal sanitized classifier status and distinct actionable failure categories while retaining serving liveness. |
| Privacy controls | General OpenRouter docs support ZDR and data-collection controls; support/enforcement by the exact alpha Decisions endpoint remains unverified. Do not send unsupported fields and claim enforcement. Resolve at C1 before any proposed privacy-contract change. |
| 32768-byte cap | Deliberate serialized-byte budget, not 32K tokens. Keep it initially, expose `request_too_large`, and measure rejection rate. Do not silently truncate task meaning or raise it to the advertised context size. |
| Dated materializer dependency | Confirmed in `scripts/materialize-switchyard-routes.mjs` and tests. The deployment transaction accepts a prepared file rather than directly reading B2 JSON. Remove the preparation dependency; production running does not itself require history JSON. |
| Hash duplication | Rust reconstructs Router-specific policy semantics. Simplify only after mapping every evaluation, trace and certification consumer. Generated-route hashes alone include environment-specific material and do not replace a portable classifier-policy identity. |
| Catalog donor spread | Confirmed `{ ...donor }`. Add independent unknown-field drift cases; do not use the same projection function as the expected-value oracle. |
| Response identity ownership | Identity rewriting shares namespace-transform bypass paths. Reproduce valid-envelope/unsupported-tool cases; decouple only the demonstrated coupling. Malformed or ambiguous envelopes must not be rewritten speculatively. |
| Patch packaging | Confirmed manifest includes the lock and compatibility patch but omits its contribution patch. Include both declared patches and test lock-to-package closure. |
| One-off scripts | Consolidate maintained evaluation paths, then remove unused checkpoint scripts after a consumer audit. Keep historical JSON and provenance. Do not remove unique certification coverage simply to reduce line count. |
| Stale documentation | Confirmed A3 reference and Luna/Sol-only priority wording. Point maintained guidance at current exact-route proof, include Astra, and mark older delivery records as historical. |
| Large local patch | Real maintenance cost, not evidence of a bug by size alone. Shrink displaced hashing/evaluation code now; defer another repin until a concrete upstream change replaces local behavior. |

## Proposed behavior and design decisions

These are recommendations for execution, not changes to the current runtime.
Existing guarantees above remain binding unless explicitly revised at a gate.

### Routing state and uncertainty

First reproduce complete native conversation trajectories: plan then “do it”,
option selection, “continue”, review then implementation, failed implementation
then diagnosis, and media followed by an independent text task. Test the real
Responses decoder and ordinary routing path, not only fabricated Message objects.

Prefer one bounded state selector that owns both selected text and modality
status. Current user media causes zero-call Sol fallback. Irrelevant historical
media must not veto a self-contained text task. An unresolved request referring
to an image must not be presented as a fully understood text-only request.
At C1, settle how the selector represents omitted historical media and unresolved
referents; do not introduce an unreliable “do it” keyword detector as the fix.

Candidate context is opening task text, latest completed assistant answer, and
latest genuine user request, with explicit role delimiters and deterministic
byte bounds. Assistant text is untrusted task evidence, never classifier
instructions; exclude reasoning, encrypted content, tool outputs and metadata.
Use decoded final-answer/channel metadata where actually available, not a guess
that every assistant message is a final answer. If assistant text is unnecessary
or cannot be reliably identified, prefer the smaller state and document what it
cannot resolve. Missing/oversize context must be visible, not silently concealed.
The classifier context must never replace or mutate the native answer payload.

Adding assistant answers expands the external data surface: they can quote
private tool results even if raw tool messages are excluded. Synthetic testing
does not authorize exporting existing conversations. Resolve and record that
change before promotion; retain the existing text-only egress policy until then.

For now keep Sol on transport failures and the existing 0.35 rule as the measured
baseline. In offline evaluation compare that baseline with target-aware uncertainty
and expected-loss selection. Expected-loss use of Jev probabilities is a hypothesis,
not evidence that they represent calibrated correctness probabilities. Any adoption
requires a documented change to the Sol-on-uncertainty contract at C2. No policy
change merely because one counterfactual improves the original training loss.

### Configuration, provenance and observability

`routes.template.toml` remains the authored authority. Materialization validates
that source and substitutes the private Router URL; it does not import historical
evaluation results. Tests must materialize without `docs/history` present.

Keep two distinct identities: portable evaluation inputs (criteria, state schema,
ordering, fallback rule, transport/privacy settings, expected provider build), and
the exact generated routes/binary/source used for deployment certification. Derive
the former once using an existing suitable owner; do not store duplicate authored
policy objects. Remove Rust reconstruction only after equivalent drift detection
is demonstrated at candidate creation and deployment, including normalization-code
changes. A trace label alone is not integrity verification. Never publish a digest
input containing the private local-hop URL or credentials.

Expose startup unavailable, timeout, HTTP failure, malformed response, oversize,
non-text and provider-build drift distinctly where useful. Serving can be live
while routing is degraded. No raw error body, task content or secret in health
or traces, and no paid health probes. Report unknown when no provider result exists;
document recovery after a successful call or service restart. Do not treat a
historical fallback log line as proof of current health.

For catalog projection, retain explicit donor-owned instruction/identity fields
and current intersection/strict-safety rules. Unknown fields differing across
members, including absent values, cannot leak from Sol into the public route.
Unknown review/safety semantics must cause actionable compatibility failure rather
than guessing whether dropping a flag is safe. Avoid a generalized metadata algebra.

### Evaluation that can support a decision

Reuse one small runner against the candidate's real decision path. Keep the old
corpus as regression/development data. Prepare about 40 new realistic synthetic
conversation cases across the boundary scenarios above, compound work, broad
verifiable exploration, ambiguous diagnosis and difficult non-security reasoning.
Record authorship and synthetic limitations; do not call these real user traffic.

Freeze splits, acceptable target sets, severity, outcome rubrics and comparison
rules before classifier output. Reserve an unseen evaluation subset after the
development policy is frozen. Once inspected it is spent; a failed case becomes
development evidence and cannot be relabeled into a passing held-out score.
Prefer independently authored evaluation cases; if unavailable, disclose that
limitation rather than claiming independence.

Evaluate adjacent-model outcomes on a bounded initial sample: two meaningful
boundary tasks per pair, two runs per model (24 answer runs across three pairs).
Use executable checks or predeclared semantic criteria, not model self-grading.
Report quality, latency and available usage separately; unknown quota/cost is
unknown. Expand only to resolve a specific contradictory result, with lead review.

Predeclare C2 promotion criteria before live evaluation: no new severe under-route
on the held-out subset, no material regression against the baseline on the same
tasks, and measured uncertainty behavior rather than a threshold that affected
zero cases. Use small-sample counts and paired outcomes, not a generalized accuracy
claim. If these criteria are unmet, retain the baseline policy and ship eligible
engineering fixes separately; do not keep tuning until a holdout passes.

## Delivery approach and checkpoints

| Gate | Work boundary and evidence | Why this checkpoint exists |
| --- | --- | --- |
| C1 — contracts and concrete defects | Reproduce state/media and response-identity cases; settle state/egress design and Decisions privacy support; reduce timeout and improve error/health behavior; fix package closure and catalog drift; remove history from materialization and simplify policy identity with negative drift tests. Return candidate tests, decision records and any unresolved external contract. Preserve routing labels/threshold except isolated experiments. | State and provenance decisions affect all later evaluation; avoid evaluating a different request or shipping unenforced privacy claims. |
| C2 — routing evidence | Implement accepted state selection and generalized criteria in an isolated candidate; run the bounded frozen corpus and adjacent-target comparisons; recommend retaining or changing uncertainty policy with explicit limitations. Return policy identity, exact state examples, split hashes, build identity, results and rejected alternatives. | A policy choice and external data expansion need evidence before becoming production authority. |
| FINAL — integration and release readiness | Reconcile maintained docs; remove superseded evaluation scripts after coverage/consumer checks; run integrated Router/Rust/package checks and full accumulated change-review against the original baseline. Produce a reproducible release candidate and migration/rollback instructions. | Earlier gates do not establish all-endpoint compatibility or exact deployed v2 eligibility. |

Implementer may reorder routine work inside these boundaries. C1 can return a
prerequisite decision before dependent implementation; unsupported Decisions
privacy semantics must remain an explicit limitation, not a fabricated pass.
The lead resolves consequential decisions and records approved plan revisions.

## Release acceptance and non-goals

Run repository-required checks, nearest regression suites, Rust tests/fmt/clippy,
ordered-patch reproduction and package validation. Prove timeout plus cancellation
with a stalled provider; prove zero paid calls on local fallback; prove original
media/payload preservation; test missing credentials and recovery; test differing
and missing future catalog fields; test materialization without history artifacts.
Reuse unchanged evidence only when inputs and runtime identity remain applicable.

Exercise all affected HTTP/WS identity paths, tool continuations, native compaction,
Luna/Sol/Astra effort affinity and existing non-Switchyard endpoint regressions.
Do not introduce a second streaming parser unless a reproduced ownership problem
requires one. Preserve byte/pass-through safety for malformed input.

After later authorization, commit the clean candidate, deploy transactionally and
renew exact-route Switchyard v2 proof under the existing maintenance procedure.
Do not advertise the old proof for changed source, binary or routing state. Preserve
rollback until live checks pass. Native parent/child continuation, switching,
tool results, compaction, media and health evidence must bind the deployed candidate.
Report offline readiness separately from deployment/certification completion.

The general OpenRouter privacy documentation supports the proposed controls but
does not by itself establish alpha Decisions support:
[ZDR documentation](https://openrouter.ai/blog/insights/zero-data-retention/) and
[provider controls](https://openrouter.ai/docs/guides/get-started/sovereign-ai).
The exact endpoint documentation was inaccessible during this planning pass;
C1 must verify endpoint-specific behavior before making an enforcement claim.
