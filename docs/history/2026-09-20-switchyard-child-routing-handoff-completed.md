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

## Historical execution note

A single Sol Medium implementer completed G1 and G2 while the lead retained
change review and release decisions. Temporary worker paths, skill identities,
custody rules and live coordination were removed after completion because they
are not current operating guidance. The linked plan and evidence preserve the
durable scope, gates, results and limitations.

## Starting comparison

Execution used the repository's `main` branch.
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

Assignment `CHILD-ROUTING-G1` executed only G1 of plan revision 1. It determined
whether existing native extraction could safely and economically enable Jev to
classify current encrypted child assignments without changing native answer
history. Its scope was the authorized bounded synthetic probe and local evidence;
it made no runtime deployment, production routing change, upstream repin, commit,
push or external publication.

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

## Completion accounting

The lead accepted G1 before G2 implemented the remaining plan. Delivery was
complete only after the integrated checks, native switching and v2 proof passed;
the source candidate and deployed evidence linked above record those results.
