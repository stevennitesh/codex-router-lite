# Switchyard app-thread admission hardening

Revision 1, 2026-09-20. Active delivery; implementation authorized after planning.
Baseline: `3f352ae7f08759cc03c4c80b3a636d9ffe93f28e`, main, initially clean.
Execution: [Sol handoff](switchyard-thread-admission-handoff.md).

## Accepted outcome

App-thread assignments should trigger Jev for their current delegated input;
ordinary call-linked tool results must retain the selected model and never send
their output to Jev. Harden the existing adapter, not the routing architecture.
Source remains v1/draft until deployment-bound evidence accepts this behavior.
The currently installed accepted generation is a separate runtime authority.

The supplied review identifies two concrete source omissions: no `call_id`
exclusion and discarded source-thread identity. Its upstream interpretation is
supporting evidence to verify against an exact source revision and the installed
app-server contract; do not assume every upstream field survives serialization.

Required behavior:

- A non-null `call_id` means ordinary tool continuation: no projection, no Jev,
  no affinity release, even with an otherwise valid delegation envelope. Absent
  or null call identity may qualify under the remaining existing checks.
- Preserve source UUID from the parser and obtain receiver thread identity from
  actual current-turn metadata. Reject self-delivery, comparing UUID identity
  rather than incidental letter case. Verify receiver-field presence on the real
  producer before relying on it. A recognized assignment with absent, ambiguous,
  or invalid required identity uses the existing null/Sol fallback; a proven
  self-delivery is not delegation and retains affinity with no projection.
- Retain bounded strict named-entity decoding, original native answer input,
  caller projection stripping, local-hop removal, and existing privacy limits.
- Currentness without item metadata depends on the host's current-turn/final-item
  contract. Document that assumption explicitly; do not claim cryptographic or
  independent historical provenance. Confirm real continuation/replay behavior.
- Keep this exception `codex_app` only. Explicitly test `codex_tui` exclusion and
  preserve the separate encrypted native-agent path. Do not imply all TUI thread
  messaging uses encrypted agent messages or is supported without evidence.

No seen-message cache, registry, persistent state, general XML parser, new
classifier, upstream repin, policy tuning, or Switchyard redesign is in scope.
If currentness cannot be demonstrated, leave v1 and report the concrete gap.

## Delivery approach

One coherent implementation, with final review and a release evidence boundary.

1. Verify sender-admission semantics in pinned inspected Codex source and actual
   installed wire shape. Reuse sanitized synthetic evidence; do not scrape private
   tasks. Resolve routine field handling locally, escalate contradictory semantics.
2. Add call-identity exclusion, source/receiver validation, and focused tests at
   existing owners (`src/router.mjs`, `test/routing.test.mjs`). Reconcile security
   and Switchyard documentation; do not widen supported namespaces.
3. Prove current delivery and later follow-up produce the expected projection;
   call-linked lookalike, self-delivery, historical items and ordinary continuations
   cannot produce new Jev input. Check missing/duplicate metadata, case-normalized
   self identity, unchanged native input, null fallback, and namespace exclusion.
   Include a retained non-Sol affinity assertion through the existing local
   integration harness; a Router output-field assertion alone is not end-to-end.
   Run focused tests then `npm run verify`; reuse unaffected locked Rust evidence.
4. Return candidate with explicit custody release for lead change-review against
   the whole baseline. This is readiness for live release validation, not v2 proof.
5. Once commit/deploy authority is present, use the maintained rollback-owning
   transaction. On the actual Windows app create a synthetic task, send follow-up
   assignments on that same task, and verify at least two actual selected targets,
   current-only decision state, history/tool continuity and no classification on
   ordinary call-linked results. Exercise resume/history replay without promoting
   the old delivery. Use the same app surface, not only reconstructed requests.
   Correlate actual turns to classifier records. If private-text telemetry is
   insufficient, use bounded synthetic-only temporary observation, not permanent
   payload logging. User typing may be required where UI automation is unavailable.
6. Run exact-route native v2 certification and maintained live checks against the
   deployed commit, refresh proof only on success, and final-review the accumulated
   change. On failure retain rollback and v1 or restore the known-good generation.
   Archive this plan/handoff only after the full outcome is accepted.

## Review and authority

Final gate `THREAD-ADMISSION`: correct admission boundaries plus real Windows app
delivery/replay evidence and deployed exact-route v2 acceptance. Code readiness may
be reviewed before release; missing deployment proof remains explicitly pending.
Two review-repair rounds total; prerequisite-only returns do not consume them.
The user authorized planning and execution, including synthetic tests. This request
does not newly authorize commit, push or production deployment; request those only
when the concrete reviewed candidate is ready. Do not re-ask once authorized.

Status: steps 1-4 candidate implemented and verified; lead review, deployment,
real desktop delivery/replay evidence and certification remain pending.
