# Switchyard four-target upgrade delivery plan

Status: Phase A completed. Checkpoints A1 and A2 were accepted, and A3 deployed
the clean candidate and restored exact-route v2 eligibility with fresh native
proof. B1 and B2 were accepted. B3 has the frozen Jev policy, canonical routes,
reproducible source chain, and bounded predeployment smoke ready for the
transactional deployment and fresh exact-route proof. The installed Phase A
runtime remains unchanged until that transaction.

Revision 3 reconciled follow-up feedback against the committed plan at `d81269ae`
before execution began. The A1 status notes below record the later authorized
implementation without changing the remaining checkpoint contracts.

The user subsequently authorized execution through the cost-aware, ponytail
implementation workflow defined in the
[execution handoff](switchyard-upgrade-handoff.md). Runtime remains unchanged
until a later checkpoint authorizes and performs deployment.

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
contract. The deployed Phase A Switchyard pin is
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
`/v1/systemone` API, while the selected B2 transport is OpenRouter's Decisions
API rather than chat completions. The PR's mutable `jev-latest` default must be
replaced by the verified OpenRouter model ID `typesafe/jev-1.13`.

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
| `config/switchyard/routes.template.toml` | Four answer targets, sole Jev classifier, role policy, enum, Sol fallback, user-turn trigger |
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
| Phase B: runtime/managed environment owners | Protected OpenRouter credential availability at service start, bounded request/cancellation behavior |
| Phase B: `src/switchyard-trace.mjs`, `src/switchyard-certification-evidence.mjs` | Classifier-neutral, redacted decision evidence and version/latency/fallback reporting |

If a new installed source file is actually needed, update the existing Windows
package allowlist. Do not add files merely to mirror this ownership table.

## Delivery checkpoints

The order below is adaptable within a checkpoint; the outcome and evidence are
the contract. Each checkpoint ends with a reviewer decision, not self-approval.

### A1 — Four-target candidate and common native contract

Status: accepted after two review-repair rounds on 2026-09-18. No runtime
publication, provider calls, certification, commit, or push were performed in
A1. The candidate is explicitly v1; the earlier runtime-bound Switchyard proof
is draft historical evidence until A3 performs fresh certification.

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

Status: bounded synthetic evaluation and its first review repair completed in an
isolated local runtime on 2026-09-18; awaiting lead review. The installed service
and catalog were not changed. This is candidate Switchyard configuration against
the already-installed Router, not end-to-end proof of the new Router candidate;
candidate Router source and instruction hashes were captured for A3. The
protected decision path selected an acceptable role for 27 of 28
adversarial sanity cases and exercised every role. Four forced-target and four
ordinary automatic-route answers returned output with the intended selected
identity in the initial A2 run; those unrelated rows were retained without a
quota rerun during this repair.
The seven-step user-turn sequence covered every adjacent role transition, and
function, custom, computer, local-shell, and tool-search output continuations
retained affinity. Five Astra Medium donor pairs and one XHigh pair completed on
both direct and routed legs with successful terminal events and passed all
predeclared factual checks for retry duplication, authorization isolation,
compatibility parsing, idempotent redelivery, rollback safety, and credential/
cancellation concurrency. The redelivery fixture also completed a real function
call and result round trip on both legs with the same tool schema. Bounded
synthetic answer excerpts and structured judgments are retained for review. See
the redacted
[A2 evidence](history/2026-09-18-switchyard-a2-evidence.json) and its
[reproducible harness](../scripts/evaluate-switchyard-a2.mjs). One strict-label
miss (`S04`, Luna Max instead of Sol Medium) is a low-risk boundary disagreement
for a tiny fully specified CLI edit and is informational rather than a required
case failure. The harness now exits nonzero for failed required cases. This is
sanity evidence, not a statistical accuracy or general semantic-equivalence claim.

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

Status: completed on 2026-09-18. Router commit
`6c0d16a6033c161437a8d26ce00d56820fd49e7f` is deployed with the four-target
routes, fresh native two-turn certification passed, and the accepted proof is
bound to the exact runtime identities. The accepted pre-candidate runtime
rollback and detached rollback checkout were removed after final review.

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

Status: reviewable candidate prepared. On 2026-09-18 the user authorized resolving upstream PR 762
in an isolated checkout and reviewing a reproducible repin candidate without
waiting for upstream merge. The refreshed PR remains OPEN and CONFLICTING at
head `92c84a0ca6dddcad1ee2a894f61642b42093b0b8`, with recorded base
`082e68ea145667b7d25ac4bc59b7b06a2f20cf87`; upstream `main` advanced during
the B1 refresh to `ee3715d10ad3e43a2d6f2efc6c4c7a0964b00877`. B1 remains subject to review before
any Router commit, deployment, or certification.

The exact public base plus the reviewed PR contribution and local compatibility
patch reproduce candidate tree `10ec27aad5cd83aff8809675efb9285571fcac8c`.
The PR patch SHA-256 is
`c5e4328c2b305d769b5f8776cf666ec6c61ec34c65ea29ac7202b27587e10e7a`;
the compatibility patch SHA-256 is
`5372a70b201d6213e85ba9efc021e6f80030e13950d3fd74f24c0fcfe8d3ef22`;
and the reproducible release binary SHA-256 is
`6759212e53f4b3c5604b83c8da082eca7318b6f5cccc9a95128536d35ffea7e4`.
The candidate passed format, the affected Rust suite, workspace Clippy with
warnings denied, release build, an actual dry run of the Luna-judged four-answer
route, all 234 Router tests, and the installed Codex catalog check. Detailed
redacted evidence is in
[`docs/history/2026-09-18-switchyard-b1-evidence.json`](history/2026-09-18-switchyard-b1-evidence.json).

The first isolated native smoke exposed an upstream compatibility regression:
the refreshed translator emitted a scalar Responses `input`, while the current
native endpoint requires a top-level list. The compatibility patch now restores
the one-message list with scalar text content. The repaired candidate passed four
Luna decisions, one per answer role, four completed answers with exact routed
identities, and a same-session tool-result affinity continuation. The installed
Router stayed unchanged. See
[`docs/history/2026-09-18-switchyard-b1-r1-smoke.json`](history/2026-09-18-switchyard-b1-r1-smoke.json).

The B1 source candidate declares `switchyard/auto` v1 and marks the prior proof
draft because the repin changes its bound upstream and patch identities. The
currently deployed Phase A generation remains v2; no runtime files change in B1.
Fresh promotion is required before a Phase B candidate may publish v2.

Integrate the exact PR contribution onto the refreshed public upstream base in
the disposable checkout. Preserve that public base and the PR/local changes as
separate reproducible patch inputs rather than making an unreachable synthetic
integration commit the sole `source.lock` fetch target.

Rebase the canonical patch by behavior, not merely by resolving textual
conflicts. Check category/target identity, recursive overrides, task-only judge
state, raw Responses affinity, priority forwarding, protected loopback URLs,
authentication, translation, and cancellation. Remove local implementations now
provided upstream only after equivalent behavior is proven.

Evidence: upstream Rust checks for affected crates, Router integration checks,
four-target parity with Luna still judging, reproducible build and source/patch/
binary hashes. Reassess certification before any deployment of the new binary.

Reason: separate upstream engine migration from classifier replacement.

B1 review must carry these PR semantics into B2 rather than treating the engine
as production-ready: the client defaults to mutable `jev-latest`, owns a fixed
30-second HTTP timeout rather than the caller's remaining deadline, and has no
explicit state-size budget. Provider errors and timeouts fall open to the
configured default target. Non-text content is currently summarized or removed
before the TypeSafe call instead of skipping that call, so B2 must add the
planned zero-call non-text policy before Jev receives routing authority.

### B2 — Bounded Jev evaluation and calibration

Status: accepted. The repaired candidate passed its frozen holdout gate. The classifier
selected Astra Medium for a case predeclared to require XHigh. The user granted
one additional validation round. Before any model call, R3 froze two concrete
synthetic key-rotation fixtures and a six-part semantic rubric covering epoch
monotonicity, tenant binding, compromised material, rollback conditions, atomic
activation, and adversarial tests. Astra Medium and Astra XHigh both satisfied
every criterion on both fixtures under identical task, tool, and transport
conditions. Lead review accepted `{astra_medium, astra_xhigh}` for X03 based on
those outcomes while preserving its original XHigh label. This is a bounded
revision for the tested work, not a general cryptographic capability claim. The
R3 artifact SHA-256 is
`888b4f9efb48d1b99436a8697300763b5db4d528b82b34a298d4c5bd82c40e0f`.
The first B2 evidence used a direct evaluator whose state shape
differed from runtime and is superseded. R1 sent all cases through the isolated
candidate `/v1/decision` path but its first fresh holdout failed H17. That failed
record is preserved as a development regression. A bounded three-case probe
found that H17's route-name phrase pulled the raw choice toward Sol; removing it
produced a low-confidence raw XHigh choice, while a generic paraphrase preserving
the ambiguous irreversible outcome strongly selected XHigh. This did not relabel
H17 or establish a provider defect.

R2 clarified the generic criteria: Sol covers a known failure whose correction
can be verified, and excludes unresolved completion of an irreversible effect;
XHigh covers an ambiguous completed irreversible effect where an incorrect retry
or rollback can duplicate or corrupt the outcome. Threshold 0.35 was selected
again on the retained 100-case training/sanity set. After policy freeze, one new
24-case mixed, steering, multi-turn holdout with benign payment/log controls was
evaluated once. It reached 24/24 acceptable targets, zero asymmetric loss, zero
critical underroutes, no provider failures, exact runtime parity, and 375 ms
full-body p95. No holdout label or policy was changed after observation. The
training/sanity set is 97% acceptable with zero critical underroutes after the
reviewed X03 acceptable-set revision. The S17
and X21 outcome-based acceptable-set changes remain explicitly training-only and
preserve their original labels.
See
[`docs/history/2026-09-18-switchyard-b2-evidence.json`](history/2026-09-18-switchyard-b2-evidence.json),
[`docs/history/2026-09-18-switchyard-b2-r1-failed-evidence.json`](history/2026-09-18-switchyard-b2-r1-failed-evidence.json),
[`docs/history/2026-09-18-switchyard-b2-r2-root-cause.json`](history/2026-09-18-switchyard-b2-r2-root-cause.json),
[`docs/history/2026-09-18-switchyard-b2-r3-x03-counterfactual.json`](history/2026-09-18-switchyard-b2-r3-x03-counterfactual.json),
[`docs/history/2026-09-18-switchyard-b2-counterfactuals.json`](history/2026-09-18-switchyard-b2-counterfactuals.json),
and [`docs/history/2026-09-18-switchyard-b2-smoke.json`](history/2026-09-18-switchyard-b2-smoke.json).
The final B3 ordered source chain reproduces tree
`47c3957e490febfa896f5f3d48f166eef6dd9d67`; its compatibility patch SHA-256
is `0967efb93e970f0f9c2bc4f375acb3d77443e85c26c5ed7f597d460ded876d70`.
The deployment binary SHA-256 is
`72940ab3ec44c2d7071f2fcbdf3d815ee40c9b16cc9a57ee866eb623022bd5bb`;
path-dependent Rust binary hashes are expected.
The frozen policy hash is
`5fd25e076c6997fe4e997ba313206766e896bcf082ac83e29e57ba54f989748f`;
the runner recomputes it from the effective runtime policy and rejects drift.
The final isolated B3 smoke verified all four roles, affinity, modality and provider
fallbacks, cancellation health, and the real sanitized trace. The trace reported
the pinned provider version `typesafe/jev-1.13-20260917`, the exact policy hash,
and bounded full probability maps without raw state. Its artifact SHA-256 is
`655011f50e4650bba2af7f4f2afbb8fa3fbbcdb5dff8830fe4bb7640893a8857`.

Use OpenRouter as the selected Jev transport. Reuse protected managed environment
conventions and verify Windows service restarts receive the existing OpenRouter
credential. Never put it in TOML, logs, commits, or model instructions. Limit
credential propagation to its actual consumer where the existing launcher
supports that boundary.

An
official-schema and harmless live compatibility probe confirmed
`POST https://openrouter.ai/api/alpha/decisions` with model
`typesafe/jev-1.13`; OpenRouter resolved it to
`typesafe/jev-1.13-20260917` and returned complete choice probability maps,
multiple questions including an ordered score, usage, and the documented error
shape. B2 should make the existing decision client accept one exact validated
HTTPS endpoint and use the existing protected OpenRouter credential, fixed model
`typesafe/jev-1.13`, redirects disabled, and no chat-completions translation.
Keep the three ordered choice questions and probability averaging already owned
by the client. Do not use the mutable `typesafe/jev-latest` alias.

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

Phase A is deployed and B1/B2 are accepted. B3 source and predeployment evidence
are ready. Production repin, Jev promotion, fresh certification, and the B3
commits remain in progress. Push is outside this checkpoint.

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
