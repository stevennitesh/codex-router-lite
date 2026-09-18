# Future Switchyard implementation handoff

Status: prepared, not dispatched. User requested planning only on 2026-09-18.

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

If the hash changes, inspect the skill change and refresh the handoff before
using it. The lead need not load worker-only instructions into its own context.
Re-read the cost-aware-coding assignment and planned-delivery references at
dispatch if their requirements or this environment have changed.

## Gates and reporting

Use plan checkpoints A1–A3, then conditional B1–B3. Do not silently authorize all
phases by assigning A1. The same worker handles execution and subsequent repairs.
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
