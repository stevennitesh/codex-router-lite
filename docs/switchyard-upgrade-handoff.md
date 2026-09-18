# Switchyard upgrade execution record

Status: final lead review accepted the completed A1-A3 and B1-B3 delivery.
Checkpoints A1 and A2 were accepted after their review-repair rounds. A3 deployed Router commit
`6c0d16a6033c161437a8d26ce00d56820fd49e7f`, verified the end-to-end Router and
native compaction paths, and accepted a fresh runtime-bound v2 proof. The
accepted pre-candidate runtime rollback and detached rollback checkout were
removed after final review. B1 was authorized to resolve the still-open,
conflicting upstream PR 762 in an isolated checkout, review and test the combined
candidate, and prepare a reproducible repin without waiting for upstream merge.
B1 and B2 were accepted. B3 deployed Router candidate
`7f707bb773aa083144904fa027ef331bd9a1c524` with the authorized
managed OpenRouter credential and synthetic-only evaluation. Its final frozen
24-case holdout passed every holdout gate after the generic role criteria were
clarified. Lead review accepted Astra Medium or XHigh for X03 based on the
predeclared R3 outcome rubric while retaining XHigh as the original label. B3
authorization covered the Router commit, transactional production deployment,
and fresh certification. Those steps passed and Switchyard v2 is published.
Push and private task-data egress remain outside scope. One validated Phase A
rollback generation remains retained only pending explicit approval for its
irreversible cleanup.

B1 uses public upstream base `ee3715d10ad3e43a2d6f2efc6c4c7a0964b00877`,
the exact PR head contribution `92c84a0ca6dddcad1ee2a894f61642b42093b0b8`,
and a separate rebased compatibility patch. B2 adapts the decision client to
OpenRouter's exact Decisions endpoint and protected credential, adds a
caller-aware deadline and state budget, and implements the planned zero-call
fallback for non-text user state. Direct TypeSafe credential setup is no longer
a prerequisite.
The B1 source candidate temporarily returned to v1 with the prior A3 proof marked
draft because its runtime binding named the Phase A source. B3 replaced that
historical binding with fresh accepted proof for the deployed Phase B generation.

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

For B2, the implementation used OpenRouter's Decisions endpoint rather than direct TypeSafe access.
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
The former Luna High classifier is retained only in the rollback generation.

The final B3 public base plus ordered PR and compatibility patches reproduce Git
tree `47c3957e490febfa896f5f3d48f166eef6dd9d67`. The compatibility patch SHA-256
is `0967efb93e970f0f9c2bc4f375acb3d77443e85c26c5ed7f597d460ded876d70`.
The B2 R2 patch hash was
`868887c2af34e7d3327727966008aef9d163f9fb25df33c3bb92ada9ffec8f2f`;
the only Rust source change leading to the final patch emits its existing bounded
four-label probability map into the sanitized operator trace. It does not alter
classification, policy, transport, or answer forwarding, so B2 evaluation remains
applicable. Because observability is compiled Rust, B3 rebuilt and deployed a new
binary and bound its fresh smoke, live, and certification evidence to that binary.
The deployment binary SHA-256 is
`72940ab3ec44c2d7071f2fcbdf3d815ee40c9b16cc9a57ee866eb623022bd5bb`.
The final predeployment smoke passed all four identities, affinity, non-text and error
fallbacks, cancellation health, and the real sanitized operator trace, which
reported provider version `typesafe/jev-1.13-20260917`, the frozen policy hash,
and bounded probability maps. Its artifact SHA-256 is
`655011f50e4650bba2af7f4f2afbb8fa3fbbcdb5dff8830fe4bb7640893a8857`.

The deployed live record passed public identity, a native tool-result round trip
with same-target affinity, native V2 compaction bypass, and the observed non-text
zero-call fallback. The former one-pixel fixture was rejected because its data
did not represent a valid image. Its replacement is a programmatically generated
128x128 red PNG: direct native Sol and deployed automatic routing both completed
and answered `red`, while the routed request recorded the Sol fallback with no
Jev provider call. Fresh native v2 certification used one no-history
Switchyard child, returned both markers from that same child, and completed the
sandboxed arithmetic tool call with result 42. The bounded records are
[`docs/history/2026-09-18-switchyard-b3-invalid-media-fixture.json`](history/2026-09-18-switchyard-b3-invalid-media-fixture.json),
[`docs/history/2026-09-18-switchyard-b3-live.json`](history/2026-09-18-switchyard-b3-live.json)
and
[`docs/history/2026-09-18-switchyard-b3-certification.json`](history/2026-09-18-switchyard-b3-certification.json).
The corrected live artifact SHA-256 is
`d42618a885888c787e8f2f4f96dcd98bb5237e42b8561bdefa6d0569c19a464c`;
the retained invalid-fixture record SHA-256 is
`74dc023928eb02c54a333b5b2ab1df23df1811d06298a73fc8c48a16dcb8fa8f`.

## Final disposition

Revision 3 remains the outcome authority, and the runtime guides own current
operation. The user authorized implementation checkpoint by checkpoint, then
accepted the final B3 deployment and corrected media verification through final
lead review. The historical milestone records above preserve the reviewed
source, policy, deployment, and certification identities.

The bounded synthetic calibration and holdout support this exact policy and
promotion decision. They do not establish general routing accuracy on private,
future, or materially different workloads. No private task payloads were used.
The deployed OpenRouter Decisions transport uses the existing protected managed
credential; direct TypeSafe key setup and waiting for upstream PR 762 are not
current prerequisites.

Automatic approval review blocked irreversible deletion of the retained Phase A
runtime rollback, its clean detached checkout, and the dated disposable B1-B3
integration/build directories pending explicit user confirmation. They remain
only for that cleanup decision. The managed B3 service remains the sole live
Switchyard authority. No push was performed.
