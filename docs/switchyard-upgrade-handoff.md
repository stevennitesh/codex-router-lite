# Future Switchyard implementation handoff

Status: Phase A completed. Checkpoints A1 and A2 were accepted after their
review-repair rounds. A3 deployed Router commit
`6c0d16a6033c161437a8d26ce00d56820fd49e7f`, verified the end-to-end Router and
native compaction paths, and accepted a fresh runtime-bound v2 proof. The
accepted pre-candidate runtime rollback and detached rollback checkout were
removed after final review. B1 is now authorized: resolve the still-open,
conflicting upstream PR 762 in an isolated checkout, review and test the combined
candidate, and prepare a reproducible repin without waiting for upstream merge.
B1 was accepted. B2 has an accepted candidate using the authorized
managed OpenRouter credential and synthetic-only evaluation. Its final frozen
24-case holdout passed every holdout gate after the generic role criteria were
clarified. Lead review accepted Astra Medium or XHigh for X03 based on the
predeclared R3 outcome rubric while retaining XHigh as the original label. B3 is
authorized for a Router commit, transactional production deployment, and fresh
certification; push and private task-data egress remain outside scope.

B1 uses public upstream base `ee3715d10ad3e43a2d6f2efc6c4c7a0964b00877`,
the exact PR head contribution `92c84a0ca6dddcad1ee2a894f61642b42093b0b8`,
and a separate rebased compatibility patch. B2 adapts the decision client to
OpenRouter's exact Decisions endpoint and protected credential, adds a
caller-aware deadline and state budget, and implements the planned zero-call
fallback for non-text user state. Direct TypeSafe credential setup is no longer
a prerequisite.
The B1 source candidate is v1 with the prior A3 proof marked draft because its
runtime binding names the Phase A source; the unchanged deployed Phase A
generation remains healthy and v2 until a later reviewed deployment.

The reproducible candidate uses public base
`ee3715d10ad3e43a2d6f2efc6c4c7a0964b00877`, PR-head patch SHA-256
`c5e4328c2b305d769b5f8776cf666ec6c61ec34c65ea29ac7202b27587e10e7a`,
compatibility patch SHA-256
`5372a70b201d6213e85ba9efc021e6f80030e13950d3fd74f24c0fcfe8d3ef22`,
candidate tree `10ec27aad5cd83aff8809675efb9285571fcac8c`, and release binary SHA-256
`6759212e53f4b3c5604b83c8da082eca7318b6f5cccc9a95128536d35ffea7e4`.
The candidate passed its full B1 offline check set, including actual route
dry-run and installed-Codex catalog compatibility; see
[`docs/history/2026-09-18-switchyard-b1-evidence.json`](history/2026-09-18-switchyard-b1-evidence.json).

R1 restored a one-message list for the Luna classifier's native Responses input
after the new binary's first isolated smoke received HTTP 400 for upstream's
scalar form. The repaired binary then selected all four roles, completed one
answer through each exact routed identity, preserved affinity across a tool
result, and forwarded native authentication through the unchanged installed
Router. The bounded record is
[`docs/history/2026-09-18-switchyard-b1-r1-smoke.json`](history/2026-09-18-switchyard-b1-r1-smoke.json).

For B2, use OpenRouter's Decisions endpoint rather than direct TypeSafe access.
The official schema and live synthetic probe verified
`https://openrouter.ai/api/alpha/decisions`, requested model
`typesafe/jev-1.13`, observed provider resolution
`typesafe/jev-1.13-20260917`, complete probability maps, multi-question ordered
scores, usage, and structured errors. The B2 candidate adapts the existing decision client at its
transport boundary with the protected OpenRouter credential and redirects
disabled; do not route Jev through chat completions or use `typesafe/jev-latest`.

The final B2 evaluation selected threshold 0.35 on the 100-case training/sanity
set, froze policy hash
`5fd25e076c6997fe4e997ba313206766e896bcf082ac83e29e57ba54f989748f`,
then observed 24/24 acceptable targets and zero critical underroutes on one new
24-case mixed, route-steering, multi-turn holdout with benign payment/log
controls. Full-body p95 was 375 ms. The earlier failed H17 holdout is preserved
as a development regression rather than overwritten; its bounded probe showed
both route-name steering and an unclear generic boundary, without establishing
a provider defect. The retained training/sanity set is 97% acceptable with zero
critical underroutes after the reviewed X03 acceptable-set revision; the small
synthetic result remains a readiness gate rather than a production-quality claim. A user-authorized R3
comparison froze two concrete key-rotation fixtures and six semantic criteria
before four native calls. Astra Medium and Astra XHigh both passed every
criterion in both fixtures. This supports the accepted
`{astra_medium, astra_xhigh}` set for the tested work and is not a general claim
about cryptographic capability. The original XHigh label is retained.
The bounded record is
[`docs/history/2026-09-18-switchyard-b2-r3-x03-counterfactual.json`](history/2026-09-18-switchyard-b2-r3-x03-counterfactual.json).
The R3 artifact SHA-256 is
`888b4f9efb48d1b99436a8697300763b5db4d528b82b34a298d4c5bd82c40e0f`.
Luna remains live until the B3 deployment transaction.

The final B3 public base plus ordered PR and compatibility patches reproduce Git
tree `47c3957e490febfa896f5f3d48f166eef6dd9d67`. The compatibility patch SHA-256
is `0967efb93e970f0f9c2bc4f375acb3d77443e85c26c5ed7f597d460ded876d70`.
The deployment binary SHA-256 is
`72940ab3ec44c2d7071f2fcbdf3d815ee40c9b16cc9a57ee866eb623022bd5bb`.
The final predeployment smoke passed all four identities, affinity, non-text and error
fallbacks, cancellation health, and the real sanitized operator trace, which
reported provider version `typesafe/jev-1.13-20260917`, the frozen policy hash,
and bounded probability maps. Its artifact SHA-256 is
`655011f50e4650bba2af7f4f2afbb8fa3fbbcdb5dff8830fe4bb7640893a8857`.

Revision 3 remains the outcome authority. The later execution authorization
supersedes this document's original plan-only boundary for assigned checkpoints;
it does not authorize deployment, provider calls, certification, commit, or push
during A1. The later A2 assignment explicitly authorized its bounded synthetic
native quota validation; it did not authorize deployment, certification,
commit, push, private task-data egress, or TypeSafe work.

Outcome authority: [Switchyard upgrade plan](switchyard-upgrade-plan.md).
Read applicable `AGENTS.md` and the plan's conditional owner documents. The
plan is a proposal; runtime guides remain authoritative for existing behavior.

## Execution pair and custody

Use the requested cost-aware-coding workflow: Astra Medium leads/reviews, and
one reusable native **Sol Medium** worker implements coherent checkpoints. Do
not start a worker until the user authorizes execution. Do not assume older
commit/push/deployment authority authorizes this new upgrade or TypeSafe egress.

At dispatch, give the worker a clean, bounded assignment with `fork_turns=none`:
repository path, verified base HEAD/status, the plan and this handoff, current
checkpoint, permitted effects, and required completion evidence. Do not pass the
entire conversation. The planning baseline was
`363032953c22ac6b7839c79231e57f35d88d5ba6`; refresh it at dispatch.

Worker owns implementation, tests, and resulting operating-document changes
within the checkpoint. It is not alone in the codebase: preserve others' edits
and stop for overlapping changes. Lead yields exclusive write custody and does
not edit or run competing diagnostics while the worker is active.

The worker must verify and read its execution skill itself:

- Path: `C:\Users\steve\.agents\skills\ponytail-implementer\SKILL.md`
- Planning-time SHA-256:
  `ADC416210EF7F062EF0B302A519267D3B188FA01155B44D475F9789677D5CCFF`

If the path is absent or its hash changed, rediscover the current sibling skill
in the same managed pack, verify path/hash, and refresh the assignment before
dispatch. This is a recoverable prerequisite, not failure of technical delivery.
Do not silently substitute another method or install without authority. If the
selection cannot be resolved, pause dispatch and report the prerequisite. A
worker detecting drift returns with stopped processes and explicit custody
release; no repair attempt is consumed. The lead need not load worker-only
instructions; the worker verifies and reads the refreshed selection.
Re-read the cost-aware-coding assignment and planned-delivery references at
dispatch if their requirements or this environment have changed.

## Gates and reporting

Use plan checkpoints A1–A3, then conditional B1–B3. Do not silently authorize all
phases by assigning A1. The same worker handles execution and subsequent repairs.
Once whole-plan delivery is authorized, advance through passing checkpoints
without repeated approval; only unresolved scope or effect boundaries pause
dependent work. Carry actual current authorization into every assignment.
Each checkpoint report identifies the candidate, changed owners, behavior
proven, tests actually run, remaining uncertainty, and required next authority.

Lead reviews the returned candidate against the plan and actual diff. Use
change-review for final candidate review. Allow at most two repair rounds per
checkpoint and two separate final-review rounds; unresolved findings then return
to the user with evidence and options. Clarifications or missing prerequisites
are not repair attempts. No unilateral escalation of model/reasoning effort.

During exclusive worker custody use event-driven waits, normally 180 seconds,
without elapsed-time commentary. Report only meaningful changes or requested
status. When a child finishes, mark it done through the available interrupt
operation; use the same child for subsequent authorized assignments. During a
native certification sequence, do not interrupt between its two marker turns.

No implementation, test-provider calls, certification, commit, push, deployment,
or runtime edits were authorized or performed by preparation of this handoff.
