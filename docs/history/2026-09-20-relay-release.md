# Relay hardening deployed acceptance

Historical evidence, not current instructions. Local date 2026-09-20; recorded
timestamps are UTC on 2026-09-21. Current procedure: [certification](../SUBAGENT-CERTIFICATION.md).

Deployed Router `19d1ac399f0df4851b56c9f0be64c3a8bb8de682`, version 0.7.0,
with the unchanged locked Switchyard binary and fresh service-generation capability.
The rollback-owning transaction passed health, private endpoint authentication,
installed hashes and current Codex catalog validation.

The initial d585f691 acceptance attempt exposed a real native Responses Lite
shape absent from the synthetic fixtures: a completed tool item followed by a
successful terminal response with an empty output array. Extraction rejected it.
That attempt was stopped and excluded from passing proof. The repair accepts
exactly one closed relay item only after successful terminal completion, with
identity, ambiguity, encoding and framing checks retained. Failed/incomplete
terminals and duplicate closed items still fail. A captured synthetic native
response recovered its exact known plaintext through the repaired parser.

Fresh native CLI parents each spawned one exact-route child with no inherited
conversation. All four routes passed: GLM Novita, GLM GMICloud, Pareto Unbiased,
and Switchyard Auto. Each child executed a sandboxed tool producing 42, returned
its first marker, then returned a second marker after a second encrypted handoff
in the same child. All twelve routed child requests returned HTTP 200. Actual
child tool output and logs were checked; parent PASS messages alone were not used.
Switchyard selected Luna Max for its three child requests.

[Sanitized evidence](2026-09-20-relay-release-certification.json) binds the exact
candidate and Switchyard hashes. Exact-route proof files retain the five required
checks. The repaired candidate also passed the maintained Switchyard live verifier:
tool round-trip, media fallback without Jev submission, and native compaction
bypassing the classifier. No routing policy or Rust binary change was needed.

Source verification passed 264 tests. This is synthetic native CLI evidence, not
a desktop GUI soak or proof of arbitrary language-model extraction fidelity.
Later source or runtime changes require their own relevant proof. Rollback was
retained after acceptance for operator recovery.

Completed planning history: [relay selection](2026-09-20-relay-compatibility-plan-completed.md),
[response validation](2026-09-20-relay-response-validation-plan-completed.md),
[strict decoding](2026-09-20-relay-boundary-hardening-plan-completed.md), and
[hop boundaries](2026-09-20-hop-boundary-correction-plan-completed.md).
