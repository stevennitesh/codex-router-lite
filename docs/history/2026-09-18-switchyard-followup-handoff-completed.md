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
[`2026-09-19-switchyard-live-release-evidence.json`](2026-09-19-switchyard-live-release-evidence.json),
and the sanitized four-route native certification record is
[`docs/history/2026-09-18-switchyard-followup-release-certification.json`](2026-09-18-switchyard-followup-release-certification.json).
Authoritative scope: [completed follow-up plan revision 6](2026-09-18-switchyard-followup-plan-completed.md).
The earlier [upgrade handoff](2026-09-18-switchyard-upgrade-handoff.md) is a completed
delivery record, not authorization to execute this new plan.

## Historical execution note

A single Sol Medium implementer completed the staged C1 and C2 work under the
accepted follow-up plan. The lead retained review, release, paid-traffic, and
deployment decisions. Detailed temporary custody, retry, and worker-path
instructions were removed after completion because they are not current operating
guidance. The plan and evidence linked above preserve the durable scope, gates,
results, and limitations.
