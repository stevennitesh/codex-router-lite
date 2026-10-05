# switchyard/auto v2 certification

Accepted on 2026-10-05T20:28:21.455Z against deployed Router `2a9ca8ad72d6ae6ede4b1ee7a669f27dd8b817b5`
(version 0.7.0), codex-cli 0.160.0 and Windows app 26.930.4958.0.
The native desktop parent spawned generated role `router_switchyard_auto` with no inherited
conversation, at its exact `medium` effort. This historical proof applies
only to the recorded runtime and endpoint.

## Evidence

[Native evidence](../../../docs/history/2026-10-05-native-v2-certification.json)
records the actual parent spawn, two encrypted handoffs in one child rollout,
`Write-Output (19+23)` producing `42` in the default sandbox, and both markers:
`SWITCHYARD_2A9CA8AD_FIRST_OK`, `SWITCHYARD_2A9CA8AD_SECOND_OK`. Tool call/output identities matched. The first child turn completed
before cleanup and same-child follow-up; both cleanup calls reported completed.
No active child turn was interrupted.

All 5 requests in the accepted bounded route window returned
HTTP 200. Three primary completions establish tool selection, first marker and
same-child follow-up. Raw session identifiers and ciphertext are omitted.

| Router completion (UTC) | Duration (ms) | Kind | Status |
| --- | ---: | --- | ---: |
| 2026-10-05T20:26:30.269Z | 10166 | primary completion | 200 |
| 2026-10-05T20:27:05.184Z | 3804 | tool wait continuation | 200 |
| 2026-10-05T20:27:41.944Z | 5761 | tool wait continuation | 200 |
| 2026-10-05T20:27:53.531Z | 3989 | primary completion | 200 |
| 2026-10-05T20:28:15.456Z | 8184 | primary completion | 200 |

The executor yielded while the default-sandbox shell was pending. Two native
wait continuations were matched to the same executor cell and their own call
outputs; the final completed result was `42`. All five successful requests are
retained rather than reducing the window to its three primary completions.

[Switchyard live checks](../../../docs/history/2026-10-05-switchyard-live-certification.json)
passed the synthetic tool round trip, continuation affinity, native image control,
zero-classifier-call image fallback and native compaction bypass. Actual Jev 1.13
classification supplied the expected provider identity and four-class probability
map. The JSON proof binds the upstream, reviewed contribution and compatibility
patches, binary, generated routes, template and deployed Router source.

## Limits

Native completed items/turns and successful Router requests establish streamed
completion; raw SSE was not retained. This is bounded synthetic compatibility
proof, not a workload soak or comparative classifier evaluation. Credentials,
capabilities, private task payloads, ciphertext and raw session IDs are excluded.
Later runtime or route-contract changes require renewed proof.
