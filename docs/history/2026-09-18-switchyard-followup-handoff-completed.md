# Switchyard feedback execution handoff

Status: release completed and exact-runtime proof renewed, 2026-09-18. C1 and
C2 were each accepted after correction round 1 of 2. Candidate
`096fb8704ebc83df2aecec3aa46228578b639686` was committed, pushed and deployed
through the rollback-owning transaction. Switchyard and the three affected exact
OpenRouter routes passed native v2 certification with tool use, two encrypted
handoffs and same-child follow-up. The retained rollback set remains available.
Final review and release checks have no remaining actionable findings: 248
automated tests and repository/native catalog/Rust checks passed; the lead also
reran the 21 focused evaluator/runtime tests.
The frozen corpus SHA-256 is
`af12fc94161a419b7eafb689e7c0fcfd083763b909ddc78decc4b2646a5d8165`;
the review-candidate evidence SHA-256 is
`c5b7516c2ed9fa246206bb721f72d3a34e419324f92ae0bc36955fd7ad1a06fd`.
The original stopped evidence remains immutable at SHA-256
`895a2b8d2c9715b0af1561520350c276bc0db8bcb21a2f03bf388a94b250306e`;
its two unretained reason codes remain unknown. A separately authorized D01
diagnostic identified the current result as a valid `low_confidence` measurement,
then the authorized fresh run retained all reasons. The fresh run used 80 decision
requests with no retries: 78 direct classifier measurements and two valid
low-confidence measurements. The generic criteria with Policy A scored 20/20 on
development and holdout against C1's 18/20 on each, with zero severe under-routes,
zero paired regressions, stable provider build, actual-runtime parity and no
consequential development change requiring answer-model calls. Policy A/B had no
development disagreements, so A remains selected.
The final canonical template SHA-256 is
`fb15cc65a9aa4956103b493e2406d05b4b7ec547e7a6d058f0dbba939acd3ecd`.
The deployed binary SHA-256 is
`06950a63e244e54c22b7cc43eb69afd5ab89ff4cd3caa1a06b5d6343386fd709`;
the generated private route SHA-256 is
`502ee051a66562c858dbc277d482f5f1265d7ce323f976a2dd8646164a7b68e2`.
Its evaluator-style materialization SHA-256 is
`b8ac56e4912caa49371acf9c526afcb840f26679e886d3e1f552cbcc726bbe0b`,
exactly matching the accepted C2 candidate config. The exact evaluated harness is
preserved at
[`docs/history/2026-09-18-switchyard-c2-evaluator.mjs`](2026-09-18-switchyard-c2-evaluator.mjs);
ongoing checks use the smaller maintained routing evaluator and the existing live
verification entry point.
The release live-smoke record is
[`docs/switchyard-live-release-evidence.json`](../switchyard-live-release-evidence.json),
and the sanitized four-route native certification record is
[`docs/history/2026-09-18-switchyard-followup-release-certification.json`](2026-09-18-switchyard-followup-release-certification.json).
Authoritative scope: [completed follow-up plan revision 6](2026-09-18-switchyard-followup-plan-completed.md).
The earlier [upgrade handoff](2026-09-18-switchyard-upgrade-handoff.md) is a completed
delivery record, not authorization to execute this new plan.

## Assignment when execution is authorized

Use one fresh reusable native GPT-5.6 Sol agent at Medium for this coherent plan;
lead owns shaping, decisions, change-review and acceptance. Start with C1 only,
then reuse the same implementer for C2, final integration and any corrections.
Do not fork the long conversation. Supply this handoff and the plan as the brief.
The assigned Sol implementer completed the C1 candidate without delegation.

Worker-only guidance:

- Path: `C:\Users\steve\.agents\skills\ponytail-implementer\SKILL.md`
- SHA-256: `ADC416210EF7F062EF0B302A519267D3B188FA01155B44D475F9789677D5CCFF`
- Presence/hash verified during planning; contents intentionally not loaded by lead.
  Recheck before dispatch. Missing or changed selection is a prerequisite-only
  return, not permission to substitute another implementation method.

Checkout: `E:\GitHub\code\codex-router`, branch `main`, whole-plan comparison
`e8d285b85fa1ba27e62460776bbe3074a255f102`. It was clean before creation of the
two follow-up documents, most recently committed in `9db3c960`. Revision 6 and
its accompanying documentation/context updates are in scope. Preserve the comparison
through intermediate commits; recheck HEAD/status before mutation. Unexpected
competing work requires reconciliation, not reset or overwrite.

Initial assignment ID: `SY-FOLLOWUP-C1`. Purpose: correct verified defects and
simplify policy ownership without changing the four-target contract blindly.
Own implementation investigation, code, tests and routine decisions across the
plan's affected Router, Switchyard patch, packaging and documentation files.
Work directly without delegation. You are not alone in the codebase; preserve
others' edits and stop on unexpected concurrent changes.

Read AGENTS.md and the engineering contract, then the task-specific Switchyard
maintenance and architecture pointers needed for the slice. Do not load all
history or instructions. Current scope excludes implementation of C2 policy
experiments until the lead accepts C1 and grants the next assignment.
Work C1a runtime correctness and C1b simplification as internal slices under one
C1 gate, as defined in the plan; they do not create extra repair allowances.
Record the accepted C1 candidate as C2's experimental baseline. The original
whole-change review baseline remains unchanged.

Revision 6 retains the smaller scope: C1 implements Jev-only latest-user state and
explicit known-field catalog projection, omitting unknown fields without a new
publication-blocking framework. Health is configuration readiness only; transient
failures stay in traces and do not need recovery state. Provider build is trace/
evaluation metadata, not runtime drift tracking. Migrate hash consumers
to existing provenance. No assistant-context selectors, Policy C, runtime
evaluation-status subsystem or generic benchmark platform. A material selector
failure comes back to the lead; do not build a more elaborate substitute silently.
Do not change shared `task_messages()` semantics for other classifiers. Catalog
unknown-field omission applies at the top level; preserve explicitly donor-owned
instruction structures and their nested metadata. Add warnings to the existing
update check, not a new runtime monitor. C1 acceptance proves selection/transport
mechanics; C2 owns semantic routing checks, including when A remains unchanged.
An unacceptable latest-user-only result cannot pass just because C1 routes the
same way; return it before promotion. Keep a dormant confidence gate unchanged.
Follow the plan's documentation acceptance: update the front-page trust boundary
and maintained guides to verified behavior when C1 lands. Do not promote proposed
behavior into current instructions early. Return a brief simplification accounting
with the candidate; justify new abstractions against complexity actually removed.

Reserved lead decisions: altered uncertainty fallback, classifier context/egress
expansion, provider privacy enforcement limits, changes to known catalog safety rules,
evaluation promotion, extra paid runs and any loss of a provenance guarantee.
Routine internal design remains the implementer's responsibility.

## Authority and custody

This file grants no execution, paid traffic, private-data export, commit, push,
deployment or deletion permission. Reconcile the user's execution instruction
when received and carry its actual scope into the assignment. Existing private
conversations must not be used as provider test data without specific authorization.
Do not delete retained rollback/build artifacts: the prior cleanup question is
separate and remains unresolved by this planning request.

Once dispatched, Sol receives exclusive checkout custody. Lead remains silent in
180-second event-driven waits while Sol works, responding only to substantive
events. Lead does not inspect or edit until explicit release. Use the applicable
cost-aware-coding skill for custody, recovery and model routing.

For blocking questions return assignment ID, exact decision, stopped-process
state and custody status. Questions and prerequisite-only returns consume no
attempt. A candidate return must include checkout/base, changed scope, tests and
results, unresolved limitations, consequential deviations, stopped writers and
subprocesses, and explicit custody release. Ready for review is not completion.
After a child's final return, lead interrupts it per runtime cleanup instructions;
that cleanup is not a substitute for custody release.

## Review and evidence

Gate coverage is defined once in the plan. C1, C2 and FINAL each start with zero
of two review-repair rounds consumed. Implementation recovery and correction
limits follow cost-aware-coding; naming a new assignment does not reset a finding's
allowance. Use the same Sol for repair; do not take over implementation locally.
Record candidate identity and decisive evidence at each accepted gate.
The first C1 review-repair round corrected persistent SSE identity restoration,
body-read timeout classification, native catalog default projection, and
candidate-versus-installed documentation wording. One C1 review-repair round
remains before escalation to the user under the review protocol.
The accepted C1 experimental control is diff SHA-256
`8b55ddec0621a0b439eaa871548683d426cbae08734a31fadedf4373407a74a5`,
binary SHA-256
`06950a63e244e54c22b7cc43eb69afd5ab89ff4cd3caa1a06b5d6343386fd709`,
source-lock SHA-256
`69994a42b850dfacb3e8d32ac8cc26c201be4e6d24c6153d40fafe0383776cf9`,
compatibility-patch SHA-256
`745556b814fee78c898482c38b1b672e95e3eddcc4ff6a1e1a9b4eebd6bdeccb`,
route-template SHA-256
`235c36109e88d44b0c974de6682d8c56972798aecd3ebd4e505c0c6dfe2daabe`,
and materialized C1 evaluation-config SHA-256
`ebf81ada3aadfa000f29ec751d59f57afb6daad67510202bed41ebca9344413d`.
Before C2's first paid run, verify that its baseline identity, 20/20 split,
predeclared A/B rules, boundary cases, retry limit and count-based
promotion gates are frozen. Compare criteria and A/B only on development
cases, then freeze exactly one candidate. Holdout evaluates only C1 versus that
candidate; never calculate unchosen-policy results or A/B disagreement there.
Keep criteria and policy comparisons distinguishable;
do not substitute the earlier production candidate for the C1 control. Uncertainty
without enough naturally differing development decisions is inconclusive, not permission to
manufacture a passing evaluation. A small adjacent-model probe cannot redefine roles.
There is no mandatory answer-model study: run only justified changed-selection
probes, initially at most two cases/eight answer calls as defined in the plan.
Return further evidence needs instead of expanding the study automatically.

Review the whole accumulated diff against the original baseline at FINAL using
change-review. Test expectations must be independent of the projection/policy
helper being tested. Do not reuse synthetic B2 success as proof of general route
quality, Decisions privacy enforcement, or changed state normalization.

Final feedback leaves plan revision 6 unchanged. During C1 review, check two
implementation risks explicitly:

- Catalog projection includes only fields the routed entry publishes or depends
  on, plus intentional donor-owned structures; it must not become a local mirror
  of the complete Codex model schema.
- Removing semantic policy hashing must preserve existing artifact provenance.
  Review the affected consumers and negative mismatch tests against the plan's
  source/patch/binary/template/routes/Router identities, not merely the absence
  of the old hash code.

Report release-ready code separately from live release. Deployment, once
authorized, requires a clean candidate and exact runtime certification; changed
source/patch/routes invalidate old proof applicability. Keep current live runtime
untouched until that transaction is explicitly within the user's requested scope.
