# openrouter/glm-5.3-flash v2 certification

Accepted on 2026-10-05T20:32:02.300Z against deployed Router `2a9ca8ad72d6ae6ede4b1ee7a669f27dd8b817b5`
(version 0.7.0), codex-cli 0.160.0 and Windows app 26.930.4958.0.
The native desktop parent spawned generated role `router_openrouter_glm_5_3_flash` with no inherited
conversation, at its exact `max` effort. This historical proof applies
only to the recorded runtime and endpoint.

## Evidence

[Native evidence](../../../docs/history/2026-10-05-native-v2-certification.json)
records the actual parent spawn, two encrypted handoffs in one child rollout,
`Write-Output (19+23)` producing `42` in the default sandbox, and both markers:
`NOVITA_2A9CA8AD_R2_FIRST_OK`, `NOVITA_2A9CA8AD_R2_SECOND_OK`. Tool call/output identities matched. The first child turn completed
before cleanup and same-child follow-up; both cleanup calls reported completed.
No active child turn was interrupted.

All 3 requests in the accepted bounded route window returned
HTTP 200. Three primary completions establish tool selection, first marker and
same-child follow-up. Raw session identifiers and ciphertext are omitted.

| Router completion (UTC) | Duration (ms) | Kind | Status |
| --- | ---: | --- | ---: |
| 2026-10-05T20:30:35.231Z | 26841 | primary completion | 200 |
| 2026-10-05T20:30:54.248Z | 5486 | primary completion | 200 |
| 2026-10-05T20:31:49.318Z | 16172 | primary completion | 200 |

The exact `novita` endpoint remained pinned with fallback disabled.

The [earlier Novita capacity attempt](../../../docs/history/2026-10-05-novita-capacity-attempt.json)
hit 429 on its second turn and remains failed evidence. This accepted proof uses
a fresh child and a clean successful window; no failed request contributes to it.

## Limits

Native completed items/turns and successful Router requests establish streamed
completion; raw SSE was not retained. This is bounded synthetic compatibility
proof, not a workload soak or comparative classifier evaluation. Credentials,
capabilities, private task payloads, ciphertext and raw session IDs are excluded.
Later runtime or route-contract changes require renewed proof.
