# Switchyard child routing execution handoff

Plan: [revision 3](2026-09-20-switchyard-child-routing-plan-completed.md). Status: completed. G1 and
G2 are accepted; the reviewed candidate was committed, deployed and recertified
for exact-route v2 publication.
This document owns temporary execution state; the plan owns product acceptance.

## G2 source candidate

Steps 1-4 are deployed and accepted. Router derives a classifier-only
projection from only the final canonical task-bearing `agent_message`, using the
existing account-scoped native relay/cache/coalescing path and a 5-second waiter
deadline. Switchyard accepts the reserved field only behind its configured local
hop capability, removes it before decode/raw preservation, and prefers it in the
TypeSafe selector. A trusted projection releases `user_turn` affinity; tool
continuations carry none and remain pinned.

The deployed compatibility patch SHA-256 is
`73e28f54a4bcd780d602390e6aebf2f8979ab05c03d5b1511ecaab959605385d`.
The deployed release binary has SHA-256
`097c3e405a74bdd623e01a02a48f41a621eb5109a0ffa458fe1a8c679bd48cc8`.
The deployed Router commit is
`594cf484a863033a1f0f11c61a52fe3d1abf6e52`. The exact application is accepted
and the source registry publishes v2.

The isolated native proof used one app-server parent and one explicitly selected
synthetic child role against disposable loopback Router and Switchyard processes.
Four exact current-task projections selected Luna Max, Sol Medium, Astra Medium
and Sol Medium in order. Four encrypted answer handoffs were unchanged, five
tool continuations carried no repeated projection, and the final tool-produced
artifact preserved the original facts and review result. Sanitized evidence is
in [the G2 isolated record](2026-09-20-switchyard-child-routing-g2-isolated-evidence.json).
The run also found that synthesized native relay requests under Responses Lite
must explicitly set `reasoning.context = all_turns` and
`parallel_tool_calls = false`; Router now does so with focused coverage.

An integrated Rust server test covers the failure transition omitted by the
first candidate: after a non-Sol assignment and retained tool continuation, a
new assignment with a failed projection releases affinity, selects Sol Medium,
and makes zero additional Jev calls. Existing Switchyard observability tests
exclude `extra_metadata`, and the selected-client path constructs fresh metadata
without forwarding it.

The deployed native acceptance reused one child for four new assignments and
selected Luna Max, Sol Medium, Astra Medium and Sol Medium. Native tools,
original synthetic facts and tool-produced state were preserved. The maintained
live verifier also passed ordinary tool affinity, media fallback with zero
provider calls and compaction bypass. Deployed projection relay latency and
tokens were not separately measurable in the sanitized telemetry; no values
were inferred from G1. See the
[deployed evidence](2026-09-20-switchyard-child-routing-g2-deployed-evidence.json).
The pre-candidate runtime rollback and detached Router checkout remain retained:
automatic approval review rejected deleting the sole production rollback
generation without more explicit authorization.

## Route and custody

Astra leads shaping and change-review. One reusable native GPT-5.6 Sol Medium
subagent owns implementation, routine investigation and verification across G1
and G2. Request `model="gpt-5.6-sol"`, `reasoning_effort="medium"`,
`fork_turns="none"`; do not spawn additional workers or reviewers by default.
Verify effective settings from exposed metadata when available; otherwise report
the settings as requested. No worker holds custody between assignments.

Worker-only Ponytail method (verify hash before reading):

- Path: `C:\Users\steve\.agents\skills\ponytail-implementer\SKILL.md`
- SHA-256: `adc416210ef7f062ef0b302a519267d3b188fa01155b44d475f9789677d5ccff`

If the skill is absent or changed, return a prerequisite gap. Do not substitute
another method. Follow the active cost-aware-coding receiver, waiting and repair
rules; this handoff does not copy or override the worker skill.

## Starting comparison

Checkout: `E:\GitHub\code\codex-router`, branch `main`.
Whole-plan source baseline: `eaef9c8338c923b49476eaad1b6647222bcc617a`.
Deployed Router: `849941ac4834e45b90820f7f06d84ca954962492` (0.6.1).

Pre-existing, uncommitted in-scope work to preserve and include in final review:

- `config/switchyard/README.md`: native encrypted-child routing limitation.
- `docs/history/README.md`: pointers to transition evidence and investigation.
- `docs/history/2026-09-19-switchyard-live-model-transitions.json`.
- `docs/history/2026-09-19-switchyard-native-child-transitions.json`.
- `docs/history/2026-09-20-switchyard-encrypted-handoff-design.md`.

This plan/handoff and their maintained entry pointer are additional planning
changes. Refresh status and identities before execution; newer unrelated work
must not be reverted. `generated/` is disposable, not product authority. Do not
commit raw session logs, ciphertext, credentials, account data or private paths.

## Completed first assignment

Assignment `CHILD-ROUTING-G1` executed only G1 of plan revision 1. Its purpose was to determine
whether existing native extraction can safely and economically enable Jev to
classify current encrypted child assignments without changing native answer
history. Read the plan, engineering contract and its relevant owner links.
Do not reconstruct the full conversation or load unrelated historical evidence.

You are not alone: preserve others' edits and stop on unexpected competing work.
Work directly without delegation. You receive exclusive checkout custody only
when the lead explicitly dispatches an assignment. During custody the lead
does not inspect, edit or run commands; it waits using 180-second event-driven
agent waits without routine progress requests.

G1 allowed only the authorized bounded synthetic probe and its local evidence.
No runtime deployment, production routing change, upstream repin, commit, push,
or external publication is included. Before spending quota verify the execution
request covers the probe. Unknown task-envelope meaning, new plaintext egress,
and material cost/latency tradeoffs are lead decisions, not routine coding choices.
For a question, report assignment and custody state; do not broaden the experiment.

Return `ready-for-review` or `blocked` with assignment, candidate identity,
changed files, exactness/latency/token observations, limitations, and the proposed
bounded projection deadline. Stop writers/subprocesses and explicitly release
custody before the lead reviews. A question-only return retains custody unless
release is explicitly requested. Idle status is not a custody transfer.

G1 completed against source baseline
`eaef9c8338c923b49476eaad1b6647222bcc617a` and received independent review with
no blocking mechanical finding. Its
[sanitized evidence](2026-09-20-switchyard-child-routing-g1-evidence.json)
contains six independent exact uncached extractions and six exact cache replays,
not twelve independent extractions. The user accepted automatic routing, the
measured bounded overhead, and the proposed 5-second extraction fallback.

The fixture diagnosis corrected earlier blocker reports. `task_name` labeled a
thread but did not select the custom role; the working call explicitly used
`agent_type`. A provider-only control showed the role's `switchyard/auto` model
applied while the child inherited its parent's provider. The isolated parent
therefore used the observation provider so the child inherited the capture path.
This was a test-harness mechanism. It is not a production requirement and does
not imply G2 needs a Codex platform change. The app-server did not expose the
actual spawn/follow-up plaintext arguments, so exact comparison kept the
independently authored constants as the acceptance oracle and would not have
attributed a mismatch solely to extraction.

The measured uncached relay range was 2.231–2.962 seconds, with 1,511 aggregate
native relay tokens. Cache replays took 2–4 ms (2.5 ms median). The bounded Jev
decision took 266 ms. The corpus contained six short 124–249-byte synthetic
assignments; these observations do not statistically guarantee the 5-second
deadline, prove arbitrary-payload fidelity, or establish dollar cost.

## Progression and accounting

The lead completed G1 change-review and recorded acceptance. It may now grant
the same Sol custody for `CHILD-ROUTING-G2`, with the accepted 5-second deadline
and all remaining effect authorizations explicit. After a successful intermediate gate,
continue under existing execution authority without a redundant approval question.
Do not treat this planning request as execution authority.

G2 owns the complete remaining implementation and final acceptance in the plan.
Its final candidate releases custody for whole-plan review against the original
comparison, including preserved in-scope untracked work. Findings go back to the
same implementer; Astra does not take over coding. Apply cost-aware-coding repair
allowances: two review-repair rounds at G1 and two at final G2. G1 used no
review-repair round; both final G2 rounds remain available. Prerequisite gaps
and unanswered questions consume none.

Only report delivery complete after the integrated checks, native switching and
v2 proof pass. A feasibility pass or reviewable code candidate alone is incomplete.
