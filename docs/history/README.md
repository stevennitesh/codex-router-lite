# Historical evidence

This directory contains dated investigations and review records, not current
instructions or live status. Read it only for provenance or a specific past failure.
Current work starts at [the repository entry](../../AGENTS.md).

- [Codex compatibility review, 2026-09-18](2026-09-18-codex-compatibility.md)
- [Union Alpha investigation, 2026-09-17](2026-09-17-union-alpha.md)
- [Pareto investigation, 2026-09-17](2026-09-17-pareto.md)
- [Router lifecycle audit, 2026-09-17](2026-09-17-router-lifecycle-audit.md)
- [Switchyard pin review, 2026-09-12](2026-09-12-switchyard-pin.md)
- [Switchyard upgrade plan, 2026-09-18](2026-09-18-switchyard-upgrade-plan.md)
- [Switchyard upgrade handoff, 2026-09-18](2026-09-18-switchyard-upgrade-handoff.md)
- [Switchyard follow-up evaluator snapshot, 2026-09-18](2026-09-18-switchyard-c2-evaluator.mjs)
- [Switchyard follow-up plan, completed 2026-09-18](2026-09-18-switchyard-followup-plan-completed.md)
- [Switchyard follow-up handoff, completed 2026-09-18](2026-09-18-switchyard-followup-handoff-completed.md)
- [Switchyard C2 frozen corpus, 2026-09-18](2026-09-18-switchyard-c2-corpus-frozen.json)
- [Switchyard C2 R0 failed evidence, 2026-09-18](2026-09-18-switchyard-c2-r0-failed-evidence.json)
- [Switchyard C2 R1 diagnostic, 2026-09-18](2026-09-18-switchyard-c2-r1-diagnostic.json)
- [Switchyard C2 R1 accepted evidence, 2026-09-18](2026-09-18-switchyard-c2-r1-accepted-evidence.json)
- [Switchyard follow-up release certification, 2026-09-18](2026-09-18-switchyard-followup-release-certification.json)
- [Switchyard follow-up accepted runtime proof, 2026-09-18](2026-09-18-switchyard-followup-runtime-proof-accepted.json)
- [Switchyard review cleanup live evidence, 2026-09-18](2026-09-18-switchyard-review-cleanup-live-evidence.json)
- [Switchyard review cleanup certification, 2026-09-18](2026-09-18-switchyard-review-cleanup-certification.json)

The immutable evaluator snapshot and evidence retain their original
`docs/switchyard-c2-*.json` path strings because those strings describe the
historical run before archival. Current consumers use the dated paths above.

Exact-route proof records remain in [v2_agent](../../v2_agent/README.md) because
the application checker consumes those paths. Each proof applies only to its
recorded runtime. Historical success never renews proof for a changed candidate.
