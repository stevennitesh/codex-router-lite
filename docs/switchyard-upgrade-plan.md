# Switchyard four-target upgrade delivery plan

Status: proposed, implementation not started. Prepared 2026-09-18 against Router
`363032953c22ac6b7839c79231e57f35d88d5ba6`.

Revision 3 reconciles follow-up feedback against the committed plan at `d81269ae`.
This revision changes planning documents only; it does not start execution.

This is a delivery proposal, not current runtime documentation or authorization
to execute. The user requested analysis and planning only. Revalidate mutable
facts before execution. The [execution handoff](switchyard-upgrade-handoff.md)
defines the requested cost-aware, ponytail implementation workflow.

## Outcome and boundary

Deliver four answer targets with distinct jobs:

| Target | Native model / fixed effort | Selection rule |
| --- | --- | --- |
| `luna_max` | `gpt-5.6-luna` / max | Clearly bounded exploration, source-grounded extraction/summarization, or tiny fully specified mechanical work |
| `sol_medium` | `gpt-5.6-sol` / medium | Implementation, bounded debugging with concrete failure and verification, routine local decisions; default when uncertain |
| `astra_medium` | `gpt-6-astra` / medium | Planning, review, architecture, interpretation, synthesis, and uncertain root-cause analysis where judgment dominates |
| `astra_xhigh` | `gpt-6-astra` / xhigh | Exceptional difficulty, consequential subtle correctness, or recovery requiring deeper reasoning |

Classify the dominant bottleneck of the complete user request. A request that
starts with exploration but also requires substantial implementation is not a
cheap exploration task. Length alone is not exceptional difficulty. Model names
inside task text are evidence about the task, not routing commands.

Express precedence in the criteria: exceptional reasoning when positively
justified; otherwise judgment/design/review as the bottleneck; otherwise
implementation/bounded debugging; otherwise clearly bounded extraction/mechanical
work. Uncertainty falls back to Sol. This is role policy, not a keyword ladder.

Sol Medium is the fallback. Preserve one selected target and effort throughout
the user turn, including tool continuations. A later user turn may select another
target. Keep direct native model entries unchanged.

Deliver in two independently validated phases:

1. Four answer targets and a correct mixed-model public contract, retaining the
   existing Luna High classifier and current Switchyard pin.
2. A reviewed Switchyard repin and calibrated Jev classifier, after its external
   prerequisites are satisfied.

Do not build stage-based routing, a generalized capability framework, a new
provider framework, a model-based summarizer, a permanent evaluation service, or
automatic escalation/retries that duplicate user actions.

## Evidence and corrections to the proposal

The inspected installed catalog is from Windows Codex `26.915.4065.0` and CLI
`0.155.0-alpha.9.2`. It is account/environment evidence, not a universal API
contract. The current Switchyard pin is
`a70a1fba2f975b6eb0f1066a2cd2a82bfc7d3052`.

| Observation | Delivery consequence |
| --- | --- |
| Current answer candidates include Luna High as well as Luna Max and three Sol efforts | Remove Luna High from answer candidates, but retain its classifier target; remove Sol High/XHigh |
| Switchyard spreads Sol's native catalog metadata | Resolve all answer families before publishing the mixed route |
| Astra requires `node_repl_auto_review_required=true`; Luna/Sol use false | Publish true for the mixed route |
| Astra exposes `send_user_message_async`, `clock`, and a native child-effort override | Do not inherit those into a route that can select Luna or Sol |
| All three currently have 272,000 default / 872,000 maximum context, 95% effective context, and null auto-compaction limit | No context expansion is justified by this change; preserve native null semantics |
| All three currently expose Fast; Sol does not expose `ultrafast` in this snapshot | Intersect actual metadata, do not hard-code claims from another catalog |
| Fast descriptions differ by model | Remove the route's `1.5x` claim |
| Both native instruction representations can carry model identity | Neutralize only the identity sentence without replacing the native prompt |

[Switchyard PR #762](https://github.com/NVIDIA-NeMo/Switchyard/pull/762) was open
and conflicted at inspected head
`92c84a0ca6dddcad1ee2a894f61642b42093b0b8` (base
`082e68ea145667b7d25ac4bc59b7b06a2f20cf87`). It is candidate evidence, not an
approved production dependency. Its client uses TypeSafe's native
`/v1/systemone` API, not OpenRouter's chat endpoint. The native default is
`jev-latest`; a pinned native version identifier still needs verification.

The PR averages distributions from up to three option orders in one request.
Its confidence is `(maximum_probability - 1/N) / (1 - 1/N)`, clamped to [0,1].
For four options, confidence 0.6 means maximum probability 0.7. Confidence is
not the probability that a route is correct. Recheck this formula after repinning.

The inspected implementation does not provide the proposed complete shadow
workflow or seven auxiliary task questions. Those would be additional work.
Its HTTP client also falls back from a timeout-configured builder to a default
client if construction fails; verify and resolve this deadline-loss path before
using that revision. Do not reproduce it locally without checking the selected
upstream implementation.

External reference boundaries:

- [TypeSafe introduction](https://docs.typesafe.ai/introduction) explains independent
  questions over shared state; [confidence guidance](https://docs.typesafe.ai/confidence)
  calls for application-specific calibration.
- [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart) documents
  its native API. An [OpenRouter Jev 1.13 listing](https://openrouter.ai/typesafe/jev-1.13)
  does not establish the same identifier, billing, or payload contract there.
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  informs migration, but the installed Codex catalog governs this subscription
  route. Public API dollar prices are not measured ChatGPT quota costs.

The proposal's benchmark counts and historical upstream commit count are not
acceptance evidence. Use a fresh upstream diff and local routing evaluation.

## Phase A design decisions

### Separate instructions from capability authority

Keep `behaviorTemplate: gpt-5.6-sol`. Add `compatibilityModels` containing the
three native answer families to the Switchyard route metadata. Validate its shape
in `routed-models.mjs`; runtime catalog generation consumes this authority without
parsing Switchyard TOML. Repository checks/tests compare it with the unique native
IDs of configured answer targets. Deployment also binds generated routes to the
checked candidate, rather than trusting a stale installed file.
Verify each target's fixed effort against its
native model. The classifier's model and effort also need validation; it is not
an answer destination.

Implement a small Switchyard-specific projection in the existing catalog owner.
Do not silently substitute donor metadata when a compatibility member is missing.
Block activation of an incompatible candidate with a useful diagnostic. Preserve
unrelated native and external entries; do not silently delete Astra from routing
to make catalog generation pass. Reuse the existing catalog validation and
publication boundary rather than introducing a second registry.

| Metadata | Rule |
| --- | --- |
| Modalities, optional tools, service/speed tiers | Intersection of actual members |
| Positive capability flags | Require support from every member; absence does not grant support |
| Apply-patch format and tool mode | Require compatible agreement; reject unsupported combinations |
| Node REPL review requirement and disabling flags | Strictest requirement wins; any true wins |
| Context bounds and effective percentage | Smallest compatible supported value; validate missing/invalid values explicitly |
| Auto-compaction limit | Preserve all-null native semantics; reconcile explicit limits within common context without treating null as zero or infinity |
| Experimental features and tools | Require common support; currently exclude Astra-only tools |
| Native child reasoning override | Do not inherit Astra's override; route-owned child settings and fixed target effort govern |
| Public reasoning picker | Retain existing compatibility values and clarify that routing selects actual effort |
| Multi-agent version | Exact Switchyard proof owns eligibility, not a native donor |
| Instructions | Sol donor with neutral model identity; retain all other behavior |

Use an explicit list of compatibility-sensitive fields, not recursive arbitrary
metadata intersection. Review drift in that list and newly recognized capability
fields; unrelated unknown descriptive fields are not automatic blockers. Avoid
advertising unreviewed donor capabilities through broad object spreading.

Neutralize the model-identifying first sentence in both `base_instructions` and
the native `model_messages` representation where present. Preserve remaining
text, variables, and structure; do not mutate the original native entry. If the
expected identity structure changes, report it rather than broadly rewriting
every occurrence of a model name.

Priority may remain only where all answer models support it. Since the current
path also forwards it to the hidden classifier, validate that hop too. No speed
multiplier claim and no `ultrafast` or new Astra-only reasoning option.

### Preserve the native request boundary

Separate public identity (`switchyard/auto`), local dispatch identity
(`switchyard-auto`), selected target identity (`switchyard/astra-medium`), and
provider identity (`gpt-6-astra`). Investigate replacing the Sol-shaped local
dispatch ID in A1, including route matching and response metadata. Retain a
legacy value only with a demonstrated dependency and an explicit explanation.

**Do not simply rename `auto.json.upstreamModel`.** In `src/router.mjs` that
field currently sets `native.model` before both ordinary routing and native V1/V2
compaction; compaction bypasses Switchyard. Preserve a valid native compaction
model, initially Sol, while selecting a separate dispatch identity only for
Switchyard-bound requests. Prefer existing `gatewayModel` if its semantics fit,
rather than adding an equivalent field. The current native Switchyard branch
does not use `gatewayModel`; A1 must wire that behavior deliberately if selected.
Trace other consumers first.

Verify streamed/non-streamed response and resumed-session identity: backend
`response.model` must not silently change the user's selected `switchyard/auto`
session into a direct native model. Preserve actual provider identity in bounded
diagnostics. Test client behavior before introducing broad response rewriting.

Resolve `context_window = 1050000` in both auto and smoke routes. Trace its meaning
and consumers in the pinned revision: advertised capacity, admission limits,
classifier budgets, and native compaction are different contracts. Align the
relevant value with the common contract, or document and test a justified
difference. Do not blindly substitute 872000 or retain 1050000 on historical
authority. Smoke needs its own applicable native-model bound if independent.

Retain unique `routing_id` values for both Astra effort variants. Verify model
identity, target maps, recursive reasoning overrides, and affinity using actual
produced requests. Do not assume the existing Luna regression proves the new
configuration is correct.

The fixed target effort must survive public picker values and any supported
configuration-update path. Inspect how native updates are normalized; do not
invent a new payload transform unless a failing test establishes the need.
Keep native compaction ownership, encrypted history, custom tools, and the
existing WebSocket-to-HTTP path intact. Test entering the route after direct
Astra use as well as transitions entirely within Switchyard: incoming history
can contain capabilities the mixed route does not advertise.

## Implementation ownership

| Owner | Required work |
| --- | --- |
| `config/switchyard/routes.template.toml` | Four answer targets, hidden Luna High judge, role policy, enum, Sol fallback, user-turn trigger |
| `config/switchyard/auto.json` | Target description, compatibility families, neutral Fast description, compatibility revision, controlled v1/v2 state |
| `src/routed-models.mjs` | Validate new route metadata at its existing registration boundary |
| `src/catalog.mjs` | Mixed-model projection, missing-member validation, neutral identity |
| `src/router.mjs` and existing identity helpers | Separate local dispatch from native compaction; verify public response/session identity |
| `scripts/check-codex-catalog-compat.mjs` | Replace Sol-equality assumptions with independent common-contract expectations using the installed catalog |
| `test/catalog.test.mjs`, `test/switchyard-runtime.test.mjs` | Mixed fixtures, absent/null metadata, strict review flags, target identity and configuration drift |
| Existing native relay, transport, stress-test fixtures | Add only missing transition, affinity, cancellation, and replay coverage |
| `maintenance/deploy-switchyard-candidate.ps1` | Reuse candidate route staging and hash checks; modify only for an established deployment gap |
| `v2_agent/switchyard/auto/` | New proof at canonical paths; Git preserves superseded evidence without duplicate archival files |
| `config/switchyard/README.md`, relevant README descriptions | Update operating truth after implementation; avoid copying this plan into always-loaded context |
| Phase B: `source.lock`, canonical compatibility patch, build metadata | Reviewed repin, semantic rebase, remove upstream-supplied patch sections |
| Phase B: runtime/managed environment owners | TypeSafe credentials, reliable service-start availability, bounded request/cancellation behavior |
| Phase B: `src/switchyard-trace.mjs`, `src/switchyard-certification-evidence.mjs` | Classifier-neutral, redacted decision evidence and version/latency/fallback reporting |

If a new installed source file is actually needed, update the existing Windows
package allowlist. Do not add files merely to mirror this ownership table.

## Delivery checkpoints

The order below is adaptable within a checkpoint; the outcome and evidence are
the contract. Each checkpoint ends with a reviewer decision, not self-approval.

### A1 — Four-target candidate and common native contract

Boundary: configuration, catalog, nearest tests, and candidate documentation.

Implement the target policy and catalog projection together before publishing.
Keep the current Switchyard pin and Luna classifier. Reuse the existing binary
if source and patch remain unchanged; a canonical patch change, even to Rust
tests, requires the normal rebuild and hash binding.

Include dispatch/compaction identity separation and the explicit route-context
decision above. Cross-owner target checks belong in repository checks, not runtime
TOML parsing inside catalog generation.

Evidence: deterministic fixtures distinguish Sol inheritance from intersection
and strict review behavior; missing Astra/unsupported effort and mismatched
target declarations fail clearly. Both Astra variants retain distinct identity.
Run the affected tests and installed-Codex catalog check. No live publication.

Reason: correct the client-visible contract before any request can reach Astra.

### A2 — Integrated behavior and classifier evaluation

Boundary: existing stress/transport harness and bounded synthetic live tests,
only after execution and quota authorization.

Exercise every answer target deliberately in a test fixture, then exercise the
ordinary automatic route separately. Forced-target success does not prove the
classifier selects it. Use a small labeled set (approximately 24–40 cases),
covering the four roles, ambiguous/mixed requests, route-name steering, long
mechanical work, subtle review, and failed-attempt recovery. These are adversarial
acceptance/sanity cases, not a statistical accuracy estimate or the Jev calibration
corpus. Labels may allow more than one reasonable answer; review
consequential under-routing and costly over-routing separately.

Prefer the protected `/v1/decision` path for classification-only cases after
verifying it exercises the same state and policy as ordinary requests. Confirm
the endpoint for the pinned version; never expose its capability URL. These
probes consume classifier quota but must not execute answer models. Ordinary
routed requests remain necessary for transition and outcome evidence.

Check the Sol-donor assumption with approximately 5–10 synthetic planning,
architecture, review, and synthesis tasks comparing direct Astra Medium with
Switchyard-selected Astra Medium, plus 1–2 XHigh cases. Keep task, tool surface,
and effort comparable; inspect quality, instruction following, tools, and
completion. This is a bounded regression check, not general equivalence proof.
Retain Sol as donor absent meaningful degradation; diagnose any failure before
proposing a new custom instruction profile.

Evidence: the transition matrix below passes; automatic routing is explainable
against the declared roles, and failures fall back to Sol. Record baseline
latency and selected targets without raw task logs. Do not enforce artificial
target-share quotas or treat the old classifier as ground truth.

Reason: separate target compatibility from routing quality.

### A3 — Deploy Phase A and restore subagent eligibility

Boundary: a reviewed clean candidate, generated private routes, live publication,
exact-route proof, rollback, and final integrated review.

Follow the existing maintenance and certification procedures. Begin with v1 and
a draft application for the changed contract. Commit only coherent green states.
Deploy the clean candidate using explicitly staged new routes and their expected
hash: the deployment helper otherwise can reuse the old installed route file.
Do not mistake a Router restart for a policy deployment.

Use the documented temporary v2 proof window without committing its intermediate
unaccepted claim. Bind observations to the deployed binary, source, patch,
generated routes, and Router candidate. Accept the application and v2 claim
together only after all five native certification requirements pass. Reconcile
the final evidence-only commit with the deployed code identity using the existing
binding rules; do not fabricate proof for an untested revision. If the existing
publication path cannot support this sequence, resolve that gap before deployment.

Evidence: `npm run check`, `npm test`, installed-Codex catalog compatibility,
runtime health, actual four-target configuration hashes, encrypted child relay,
same-child follow-up, and bounded successful timing evidence. Recheck unrelated
routes where shared catalog/relay code changed. Restore the complete prior
runtime/catalog/routes generation if deployment fails; never leave a stale v2
claim as the rollback mechanism.

Reason: old Switchyard certification does not cover the new answer policy.

Separate the ordinary-use v1 deployment gate from v2 promotion. Interim v2 may
be deferred only if the user explicitly accepts temporary loss of Switchyard
subagent eligibility until B3. Default to restoring existing v2 functionality;
an unmerged Phase B must not silently leave it unavailable. If deferral is chosen,
record it, retain v1, skip the interim child proof, and require final v2 at B3.

### B1 — Reviewed upstream repin with the Luna classifier retained

Start only after choosing a reviewed usable upstream revision. Do not backport
an open conflicted PR into the old pin or merge the original Router repository.

Rebase the canonical patch by behavior, not merely by resolving textual
conflicts. Check category/target identity, recursive overrides, task-only judge
state, raw Responses affinity, priority forwarding, protected loopback URLs,
authentication, translation, and cancellation. Remove local implementations now
provided upstream only after equivalent behavior is proven.

Evidence: upstream Rust checks for affected crates, Router integration checks,
four-target parity with Luna still judging, reproducible build and source/patch/
binary hashes. Reassess certification before any deployment of the new binary.

Reason: separate upstream engine migration from classifier replacement.

### B2 — Bounded Jev evaluation and calibration

Verify the native TypeSafe model ID and credentials; pin the exact supported
version. Reuse protected managed environment conventions and verify Windows
service restarts receive the key. Never put it in TOML, logs, commits, or model
instructions. Limit credential propagation to its actual consumer where the
existing launcher supports that boundary.

Keep opening task plus latest distinct user update as decision state. Add a
deterministic total request budget covering criteria and all option orders,
including Unicode. Do not assume a character/token ratio is a guaranteed bound.
Use a documented conservative bound or supported tokenizer. On oversize input,
fall back to Sol with a bounded reason instead of silently dropping decisive
task content. Exclude reasoning, encrypted content, raw tool results, transport
envelopes, and provider metadata.

Use a deterministic non-text policy initially: if normalized decision state
contains user images or attachments whose contents Jev cannot inspect, skip the
TypeSafe request entirely and choose Sol with a `non_text_state` reason. Verify
zero classifier calls, not a call whose result is discarded. Record this as a
local policy fallback, not a successful Jev verdict or provider latency sample.
Preserve original media for the answer model;
do not send its bytes or private file contents to TypeSafe. A placeholder or high
text-only confidence cannot establish the difficulty of unseen content. This
avoids inventing another classifier to decide whether text is sufficient. Test
caption-only, screenshot-only, and mixed text/image cases. Later allowing textual
intent to select another role requires outcome evidence, not a second multimodal
classifier in this delivery.

Detect attachment presence before text normalization discards it and preserve a
bounded presence flag in classifier state. Apply this fallback only when a new
user turn needs a decision; existing continuation affinity takes precedence.

One bounded deadline must cover classifier work and any retry; cancellation must
stop it. Test timeout, 429/5xx, malformed response, missing labels, invalid
probabilities, unavailable credentials, and confidence below threshold. Preserve
Sol fallback and continuation affinity. Do not return apparently successful
classifier evidence for a fallback.

Start with a disposable/offline evaluation mode over authorized synthetic or
explicitly selected tasks; avoid a permanent duplicate production classifier.
TypeSafe receives task text: permission to use the existing native route does
not itself authorize sending private historical conversations to this new party.

Collect full probability distributions, transformed confidence, selected and
final target, model/version, latency, fallback reason, and bounded outcome
evidence. Correlate without exposing raw task text or private session IDs.

The seven proposed work-mode/scope/ambiguity/verification/consequence/recovery/
exceptional-reasoning questions are optional diagnostic experiments in this
evaluation phase. They have no routing authority. Implement them only if they
resolve observed calibration failures; use the same native request if supported.
Do not make their infrastructure a prerequisite to shipping a good four-way
Choice classifier.

Bind calibration to the exact Jev version, state normalization and modality/size
rules, question/criteria wording, candidate labels/descriptions and mapping,
order-averaging strategy, confidence transform, threshold, and fallback policy.
Record a deterministic policy digest with evaluation evidence, reusing existing
route/source hashes where sufficient; do not add a second runtime registry.
A bound input change invalidates the prior calibration claim and requires review
and affected reevaluation, not merely reuse of its threshold.

Use an intentionally diverse B2 corpus, initially around 100–200 authorized
synthetic/labeled examples subject to the quota budget, with a frozen holdout.
This is a starting size, not a statistical guarantee. Most cases should use
classification-only decision probes. Execute a bounded informative subset of
answer-model comparisons where outcome labels are uncertain; expand only when
concrete ambiguity justifies the cost.

Before tuning, assign acceptable target sets and simple asymmetric penalties:

| Result | Treatment |
| --- | --- |
| Acceptable target | No routing error |
| Unnecessary more expensive target | Resource penalty, larger for unnecessary XHigh |
| Insufficient target for required behavior | Correctness penalty larger than routine resource waste |
| Luna on demonstrated Astra-class judgment | Severe under-routing failure |
| Predeclared critical case fails after under-routing | Promotion blocker |

Roles are not a single ordinal ladder. Allow `{sol_medium, astra_medium}` where
both are adequate. Set weights and blocking cases before tuning, grounded in
outcomes rather than declaring XHigh inherently necessary. Model names and public
API prices alone do not establish realized savings.

Label-bias probes are optional and non-blocking unless ordinary calibration or
order results reveal a material concern that they can help diagnose. When practical,
compare ordinary labels with consistently mapped opaque or role aliases on a
subset, holding descriptions and cases constant. Do not build alias infrastructure
solely for this experiment when normal evaluation is satisfactory. Record a skipped
probe as unmeasured, not evidence of no bias. Do not change production names
preemptively; demonstrated bias may justify a reviewed role-to-target mapping
followed by fresh calibration.

Evidence: choose the threshold on training cases and freeze it before holdout;
evaluate outcomes, route labels, order stability, any performed label-bias probes,
asymmetric loss, fallback
frequency (including non-text cases), and latency. Predeclare acceptable
regressions and latency budget from Phase A measurements. If the simple classifier
fails, report evidence before proposing a composed policy.

### B3 — Jev promotion and final review

Replace the judge only after B2 passes. Keep the same four answer targets and
Sol fallback, explicitly set `user_turn` rather than the upstream default, then
remove the classifier-only Luna target and obsolete judge-specific assumptions.
Retain a reproducible previous generation for rollback; do not leave two live
authorities deciding a request.

Repeat the affected integrated tests, exact-route certification, deployment
binding, and final change review. Failure to meet calibration or provider
readiness leaves Phase A as the delivered system, with Phase B explicitly pending.

## Required behavior matrix

| Area | Observable acceptance evidence |
| --- | --- |
| Target changes | Luna ↔ Sol, Sol ↔ Astra, Astra Medium ↔ XHigh at user boundaries; upstream ID and fixed effort captured |
| Identity separation | Session selection stays `switchyard/auto`; local dispatch, selected target, and provider identity remain distinct; V1/V2 compaction receives a valid native model |
| Context ownership | Auto and smoke context values have verified semantics and applicable bounds; no stale 1.05M assumption |
| Affinity | Text, function/custom tools, tool search, shell/computer results and encrypted continuation stay on the selected variant within a turn |
| Resumed history | Compaction/resume and direct-native-Astra → auto history remain valid, or an unsupported boundary fails explicitly without corrupting history |
| Transport | Ordinary HTTP and routed WebSocket path agree; disconnect/cancel does not launch a second answer or leave classifier work running |
| Catalog | Common features only, strict review flag, neutral identity, unchanged native entries, no fabricated null/default semantics |
| Effort and speed | Public picker cannot defeat fixed target effort; supported update paths and Fast reach the intended backend contract |
| Failure | Invalid/unavailable classifier falls back to Sol; unavailable answer model does not masquerade as successful completion |
| Jev modalities | Unavailable user non-text state triggers explicit Sol fallback with zero TypeSafe calls; original media reaches the answer model; continuation affinity remains intact |
| Security/privacy | Native credentials remain on native hops; TypeSafe receives only authorized bounded task state; redacted evidence contains no secrets/raw payloads |
| Certification | For v2 promotion, stream, tool call, encrypted relay, first marker and same-child second marker pass for the exact candidate; explicitly deferred interim deployments remain v1 |

Use existing harnesses for reproducible faults. Native provider/account behavior
requires bounded live evidence and cannot be certified by mocks alone.

## Outstanding prerequisites and stopping points

Phase A has a concrete implementation path, but execution is not authorized by
this planning request. Before Phase B execution, settle the reviewed upstream
revision, native Jev version ID, secret installation path, permitted task-data
egress, deadline budget, and measured calibration criteria. These are explicit
gates, not reasons to expand the router architecture now.

This plan does not claim the proposed changes or live tests have been executed.

## Feedback disposition

Accepted identity/context investigations, source-check ownership, Astra donor
comparison, modality policy, calibration binding, label-bias probes, separate
sanity/calibration corpora, asymmetric loss, decision-only evaluation, Git-only
proof history, and client identity coverage. Kept projection explicit and small;
corpus sizes are starting budgets, not mandatory benchmark infrastructure.

Qualified three recommendations: a neutral local ID cannot replace the native
compaction model; unseen attachments use conservative deterministic fallback
rather than an unimplemented semantic-dependence test; optional interim v2
requires an explicit temporary capability tradeoff. Skill drift is a recoverable
dispatch prerequisite, not permission to silently abandon the requested method.

Follow-up review clarified that non-text fallback skips TypeSafe entirely and
made opaque-label experiments conditional rather than a reason to build another
harness. The original code baseline remains unchanged; refresh checkout identity
at dispatch. No further architecture changes are justified by this feedback.
