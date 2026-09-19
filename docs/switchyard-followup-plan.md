# Switchyard feedback follow-up delivery plan

Status: proposed, revision 3, 2026-09-18. Planning only; implementation has not
started. Baseline: `e8d285b85fa1ba27e62460776bbe3074a255f102` on `main`.
Revision 3 reconciles feedback on planning commits `fee2a848` and `74d67695`; neither
does not replace the whole-change review baseline or the C2 experimental baseline.

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
| Provider build drift | Family-prefix acceptance permits new builds. Record expected versus observed build and mark evaluation applicability as drifted. A valid new build can remain operationally healthy; wrong model families remain rejected. |
| Classifier health and error reasons | Startup-unavailable provider fails open; aggregate `provider_error` obscures causes. Expose minimal sanitized classifier status and distinct actionable failure categories while retaining serving liveness. |
| Privacy controls | General OpenRouter docs support ZDR and data-collection controls; support/enforcement by the exact alpha Decisions endpoint remains unverified. Do not send unsupported fields and claim enforcement. Resolve at C1 before any proposed privacy-contract change. |
| 32768-byte cap | Deliberate serialized-byte budget, not 32K tokens. Keep it initially, expose local `state_too_large` separately from provider HTTP rejection, and measure rejection rate. The measured size includes the entire serialized decision request, including repeated criteria, not only user text. Do not silently truncate task meaning or raise it to the advertised context size. |
| Dated materializer dependency | Confirmed in `scripts/materialize-switchyard-routes.mjs` and tests. The deployment transaction accepts a prepared file rather than directly reading B2 JSON. Remove the preparation dependency; production running does not itself require history JSON. |
| Hash duplication | Rust reconstructs Router-specific policy semantics. Map consumers, then replace this with existing source/config/build identities recorded in evaluation evidence. Preserve exact deployment provenance without creating another runtime policy-identity system. |
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
then diagnosis, media followed by an independent text task, and an explicit topic
switch after a long unrelated task. Test the real
Responses decoder and ordinary routing path, not only fabricated Message objects.

Prefer one bounded state selector that owns both selected text and modality
status. Current user media causes zero-call Sol fallback. Irrelevant historical
media must not veto a self-contained text task. An unresolved request referring
to an image must not be presented as a fully understood text-only request.
At C1, settle how the selector represents omitted historical media and unresolved
referents; do not introduce an unreliable “do it” keyword detector as the fix.

The primary candidate context is the latest completed assistant answer preceding
the latest genuine user request, followed by that user request. The current user
request defines the work; assistant context only resolves references and must not
override an explicit topic change. On an initial turn, use the user request alone.
Do not retain the opening task by default. Compare latest-user-only and
opening-plus-assistant-plus-latest variants during development only; retain extra
context only if it demonstrates value without topic-switch regressions.
Use explicit role delimiters and deterministic byte bounds. Assistant text is
untrusted task evidence, never classifier
instructions; exclude reasoning, encrypted content, tool outputs and metadata.
Use decoded final-answer/channel metadata where actually available, not a guess
that every assistant message is a final answer. If assistant text is unnecessary
or cannot be reliably identified, prefer the smaller state and document what it
cannot resolve. Missing/oversize context must be visible, not silently concealed.
The classifier context must never replace or mutate the native answer payload.

Within the 32768-byte serialized-request budget, reserve fixed request overhead
and the complete current user request before assistant context. Bound or omit
assistant context first, preserving valid UTF-8 and recording that reduction in
evaluation evidence. Never silently truncate the authoritative user request: if
it and required overhead do not fit, use zero-call `state_too_large` fallback.
Reduced assistant context must be marked as incomplete; an unresolved referent
must not be treated as understood. Test near-limit states with and without a
required assistant referent. Do not log the omitted text.

Adding assistant answers expands the external data surface: they can quote
private tool results even if raw tool messages are excluded. Synthetic testing
does not authorize exporting existing conversations. Resolve and record that
change before promotion; retain the existing text-only egress policy until then.

For now keep Sol on transport failures. Freeze these three uncertainty policies
before viewing C2 results, using the existing confidence transform and four targets:

- A: argmax; confidence below 0.35 routes to Sol Medium.
- B: argmax at or above 0.35; below it, Luna and Sol route to Sol Medium,
  Astra Medium remains Astra Medium, and Astra XHigh routes to Astra Medium.
- C: choose the action minimizing the sum of probability times routing loss,
  using the existing B2 predeclared loss matrix copied into the evaluation fixture
  before execution. No confidence cutoff. For exact expected-loss ties, prefer
  Sol Medium when tied as the designated neutral default; otherwise use the
  declared resource-preference order Luna Max, Astra Medium, Astra XHigh. This
  is a deterministic preference, not a claim of measured per-task cost. Do not
  treat near-equal losses as ties. A/B preserve C1's raw
  argmax tie behavior; record it before testing rather than changing the control.

Use the same recorded probability vector to score A/B/C offline; do not pay for
three identical classifier calls. Validate candidate runtime parity for whichever
policy is proposed for promotion. Expected-loss use of Jev probabilities is a hypothesis,
not evidence that they represent calibrated correctness probabilities. Any adoption
requires a documented change to the Sol-on-uncertainty contract at C2. No policy
change merely because one counterfactual improves the original training loss.

### Configuration, provenance and observability

`routes.template.toml` remains the authored authority. Materialization validates
that source and substitutes the private Router URL; it does not import historical
evaluation results. Tests must materialize without `docs/history` present.

Separate evaluation applicability from exact deployment certification using
existing identities. Evaluation evidence records Router commit, route-template
SHA-256, requested Jev model, observed provider build, corpus SHA-256 and the
existing locked Switchyard source/patch and candidate-binary identities. The latter
matter because normalization lives in the patched Switchyard binary, not just
Router JS. Uncommitted experiments need an exact source-diff/build identity;
a HEAD value alone must not imply that dirty code was evaluated.

Remove Router-specific Rust policy-SHA reconstruction after migrating consumers
and proving applicability checks detect config, normalization and build changes.
Do not replace it with a runtime registry, new manifest/schema or cross-language
reserialization. If a short policy label is useful, derive it only in the evidence
generator from the recorded tuple; it is not a runtime rejection rule. Retain
existing generated-route/binary/source verification at deployment and certification.
Never publish private local-hop URLs or credentials as digest inputs.

Expose startup unavailable, timeout, `provider_http_error`, malformed response,
local `state_too_large`, and non-text fallback distinctly where useful. Oversize
must cause zero network calls; an external HTTP 413 remains a provider HTTP error.
Serving can be live while routing is degraded. Keep classifier operational status
separate from evaluation applicability: a valid new family build can report
`classifier_health=healthy` and `evaluation_status=drifted` at the same time.
No raw error body, task content or secret in health
or traces, and no paid health probes. Report unknown when no provider result exists;
document recovery after a successful call or service restart. Do not treat a
historical fallback log line as proof of current health.

For catalog projection, known routing-sensitive fields retain explicit projection
rules and known descriptive/instruction fields retain explicit donor ownership.
Never automatically publish an unknown field, including one identical across all
native members: native agreement does not establish routed-path support. Build the
mixed entry from explicitly owned fields rather than unrestricted donor spread.
Unknown fields block publication of the mixed entry pending compatibility review;
review decides whether to add an explicit rule or explicitly ignore the field.
Do not infer safety semantics from field names or silently disable other native
entries. Test identical, differing, missing and nested unknown fields independently
of the projector.
Avoid a generalized metadata algebra.

If the Decisions endpoint lacks per-request privacy controls, investigate whether
a dedicated OpenRouter key with a guardrail can enforce the needed restrictions
on this exact endpoint. Treat this as a contingent option, not verified capability
or permission to create a key/change account settings. Verify enforcement, not
merely successful request acceptance. If neither mechanism is established, report
the limitation; do not claim ZDR enforcement or expand egress on that assumption.

### Evaluation that can support a decision

C2 is a conservative regression/promotion gate for this personal router, not a
study establishing optimal model selection or general routing accuracy. The small
synthetic corpus and adjacent-model probes can expose regressions and clear
boundary failures. They cannot settle the best model for all real tasks. No new
long-term telemetry infrastructure is part of this plan.

Reuse one small runner against the candidate's real decision path. Keep the old
corpus as regression/development data. Prepare about 40 new realistic synthetic
conversation cases across the boundary scenarios above, compound work, broad
verifiable exploration, ambiguous diagnosis, difficult non-security reasoning and
topic switches from a long architecture task to a trivial self-contained request.
Record authorship and synthetic limitations; do not call these real user traffic.

The C2 experimental baseline is the accepted C1 candidate with existing four
role descriptions, threshold 0.35 and Sol uncertainty fallback. Record its exact
identity; `e8d285b8` remains the review comparison, not the experimental control.
On the 20 development cases only, compare state variants with criteria/policy/transport fixed, then criteria with
state fixed, then A/B/C on the same vectors. Use the same frozen source conversations
and identical transport conditions; only the state-comparison step may vary the
rendered state. Select exactly one combined candidate on development evidence,
then freeze its state selector, criteria and uncertainty rule. The 20 held-out
cases compare only C1 against that frozen candidate. Do not compute alternative
A/B/C routes, winners or disagreement statistics on the holdout. Record provider
build and interleave paired calls where possible; a build change confounds the
comparison and cannot be silently pooled into a pass.

Freeze a 20-case development / 20-case held-out split, acceptable target sets,
severity, outcome rubrics and comparison rules before classifier output. Keep
held-out results unseen until the development candidate is frozen. Once inspected
the holdout is spent; a failed case becomes
development evidence and cannot be relabeled into a passing held-out score.
Prefer independently authored evaluation cases; if unavailable, disclose that
limitation rather than claiming independence.

Evaluate adjacent-model outcomes on a bounded initial sample: two meaningful
boundary tasks per pair, two runs per model (24 answer runs across three pairs).
Use executable checks or predeclared semantic criteria, not model self-grading.
Report quality, latency and available usage separately; unknown quota/cost is
unknown. Expand only to resolve a specific contradictory result, with lead review.
A two-versus-two stochastic outcome is a diagnostic probe, not sufficient evidence
to redefine a model's role. A cheaper candidate failing a required task that its
baseline target passes blocks that promotion pending investigation.

Freeze these count-based gates before the first paid C2 run:

- Zero severe under-routes by the proposed candidate on the 20 held-out cases.
- At most one non-critical paired regression (C1 acceptable, candidate unacceptable),
  and total acceptable-target count at least C1's on that same held-out subset.
- Predeclare at least six boundary cases among the 20 development cases.
  For uncertainty-policy promotion, require observed A/B/C disagreement on at
  least three of those development cases. This is a development-only gate;
  holdout results cannot rescue insufficient evidence for changing uncertainty.
  Insufficient disagreement is inconclusive, not a reason to tune or replace cases.
  Handcrafted probability fixtures test policy mechanics separately and do not
  count as evidence of natural classifier uncertainty.
- Provider failures are reported separately from conditional classifier quality,
  including end-to-end fallback outcomes. Missing paired results block a promotion
  verdict; do not drop failed cases or silently retry until success. Predeclare
  at most one retry per transient failure and retain both attempts.
- No unresolved adjacent-model outcome contradiction of the kind above.

Use small-sample counts, not a generalized accuracy claim. Final holdout is used
once for C1 versus the candidate selected on development data; do not evaluate
unchosen alternatives or pick a different winner after inspecting those results.
If a gate fails or is inconclusive,
retain the applicable baseline policy and ship eligible engineering fixes separately.
Any further policy revision needs a new evaluation proposal, not repeated tuning
until a holdout passes. Criteria/state-only changes do not require uncertainty
disagreement when A is retained, but must meet the other gates.

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

Execute C1 internally as two coherent slices, without additional review gates:
C1a covers runtime correctness (state/media and identity reproduction, timeout,
errors/health, drift and privacy investigation); C1b covers simplification and
reproducibility (materialization, evidence identity, package closure and catalog
drift). One C1 review covers both. Keep assistant-context/criteria experiments in
C2; C1's media fix must preserve a documented baseline selector.

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
