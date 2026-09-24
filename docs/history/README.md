# Historical evidence

This directory contains dated investigations and review records, not current
instructions or live status. Read it only for provenance or a specific past failure.
Current work starts at [the repository entry](../../AGENTS.md).

## Compatibility and retired routes

- [LiteLLM 1.102.1 shim retirement audit, 2026-09-23](2026-09-23-litellm-shim-retirement.md)
- [LiteLLM 1.102.1 compatibility refresh, 2026-09-23](2026-09-23-litellm-1.102.1.md)
- [Native discovery capability decision, 2026-09-22](2026-09-22-native-discovery-capability.md)
- [Pre-public history and repository audit, 2026-09-19](2026-09-19-public-release-audit.md)
- [Codex compatibility review, 2026-09-18](2026-09-18-codex-compatibility.md)
- [Pareto investigation, 2026-09-17](2026-09-17-pareto.md)
- [Union Alpha investigation](2026-09-17-union-alpha.md) and [retired contract](2026-09-17-union-alpha-retired-contract.md), 2026-09-17
- [Router lifecycle audit, 2026-09-17](2026-09-17-router-lifecycle-audit.md)
- [Router stress-test delivery, 2026-09-17](2026-09-17-router-stress-test-delivery.md)

## Switchyard delivery and evidence

- [Switchyard pin refresh, 2026-09-23](2026-09-23-switchyard-pin-refresh.md)
- [Bounded synthetic native cache-transition experiment, 2026-09-21](2026-09-21-switchyard-cache-transition-experiment.json)
- [Safe cache experiment reproduction procedure, 2026-09-21](2026-09-21-switchyard-cache-experiment-procedure.md)
- [Completed cache-correctness and native-attempt observation delivery, 2026-09-21](2026-09-21-switchyard-cache-correctness-completed.md)
- [Completed measurement and classifier-input fidelity delivery, 2026-09-21](2026-09-21-switchyard-measurement-completed.md)
- [Startup/stream and retry release, 2026-09-20](2026-09-20-startup-stream-release.md), [four-route certification](2026-09-20-startup-stream-release-certification.json), and [completed delivery record](2026-09-20-startup-stream-boundaries-completed.md)
- [Relay hardening deployed acceptance, 2026-09-20](2026-09-20-relay-release.md) and [four-route certification evidence](2026-09-20-relay-release-certification.json)
- [Thread-admission correction and release, 2026-09-20](2026-09-20-switchyard-thread-admission-completed.md) and [release evidence](2026-09-20-switchyard-thread-admission-release.json)
- [Native child automatic-routing G2 deployed acceptance, 2026-09-20](2026-09-20-switchyard-child-routing-g2-deployed-evidence.json), [live verifier](2026-09-20-switchyard-g2-live-verification.json), and [isolated candidate evidence](2026-09-20-switchyard-child-routing-g2-isolated-evidence.json)
- [Completed native child routing plan](2026-09-20-switchyard-child-routing-plan-completed.md) and [handoff](2026-09-20-switchyard-child-routing-handoff-completed.md), 2026-09-20
- [Native child encrypted-handoff G1 accepted evidence, 2026-09-20](2026-09-20-switchyard-child-routing-g1-evidence.json)
- [Encrypted-handoff routing design review, 2026-09-20](2026-09-20-switchyard-encrypted-handoff-design.md) (proposal; not implemented)
- [Native child transition limitation, 2026-09-19](2026-09-19-switchyard-native-child-transitions.json)
- [Live same-conversation model transitions, 2026-09-19](2026-09-19-switchyard-live-model-transitions.json)
- [Version 0.6.1 certification, 2026-09-19](2026-09-19-switchyard-v061-certification.json)
- [Pin review, 2026-09-12](2026-09-12-switchyard-pin.md)
- [Upgrade plan](2026-09-18-switchyard-upgrade-plan.md) and [handoff](2026-09-18-switchyard-upgrade-handoff.md), 2026-09-18
- [Completed follow-up plan](2026-09-18-switchyard-followup-plan-completed.md) and [handoff](2026-09-18-switchyard-followup-handoff-completed.md), 2026-09-18
- [C2 evaluator snapshot](2026-09-18-switchyard-c2-evaluator.mjs), [frozen corpus](2026-09-18-switchyard-c2-corpus-frozen.json), [R0 failed evidence](2026-09-18-switchyard-c2-r0-failed-evidence.json), [R1 diagnostic](2026-09-18-switchyard-c2-r1-diagnostic.json), and [R1 accepted evidence](2026-09-18-switchyard-c2-r1-accepted-evidence.json)
- [Follow-up release certification](2026-09-18-switchyard-followup-release-certification.json) and [accepted runtime proof snapshot](2026-09-18-switchyard-followup-runtime-proof-accepted.json)
- [Review cleanup live evidence](2026-09-18-switchyard-review-cleanup-live-evidence.json) and [certification](2026-09-18-switchyard-review-cleanup-certification.json)
- [Affinity cleanup, completed 2026-09-19](2026-09-19-switchyard-affinity-cleanup-completed.md)
- [Live release evidence, 2026-09-19](2026-09-19-switchyard-live-release-evidence.json)

Historical evidence may retain its original pre-archive path strings because
those strings describe the recorded run. Current readers and consumers use the
dated paths above.

Exact-route proof records remain in [v2_agent](../../v2_agent/README.md) because
the application checker consumes those paths. Each proof applies only to its
recorded runtime. Historical success never renews proof for a changed candidate.
