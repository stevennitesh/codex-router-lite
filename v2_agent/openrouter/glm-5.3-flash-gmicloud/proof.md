# openrouter/glm-5.3-flash-gmicloud v2 certification

Accepted on 2026-09-26T14:39:01.929Z against deployed Router `60cbefd571b5a87357bb0e0f0697728484afbbd5`
(version 0.7.0), codex-cli 0.158.0-alpha.2.1, using a fresh native desktop parent
and the generated `router_openrouter_glm_5_3_flash_gmicloud` role. Endpoint: gmicloud.
This historical proof applies only to the recorded runtime.

## Evidence

[Bounded native desktop evidence](../../../docs/history/2026-09-26-native-v2-certification.json) records
the window 2026-09-26T14:38:22.869Z through 2026-09-26T14:39:01.929Z.
The parent contains actual native spawn, wait, completed-child cleanup, and
same-child follow-up calls. The one child rollout contains two encrypted
`agent_message` handoffs, the native tool call and matching output, both final
markers, and two `task_complete` events. Neither cleanup interrupted an active
turn: each returned a previous status of completed, and the first cleanup
preceded the same-child follow-up.

| Check | Observed result |
| --- | --- |
| Streaming Responses completion | Three HTTP 200 requests; native tool/text items and two completed turns |
| Actual native tool call/output | Default sandbox, `Write-Output (19+23)`, output `42` |
| Encrypted relay | Two encrypted handoffs in the same child rollout |
| First marker | `GMI_60CBEFD5_FIRST_OK` |
| Same-child follow-up marker | `GMI_60CBEFD5_SECOND_OK` |

Router request durations were 11329 ms, 7775 ms, 8750 ms.

## Limits

This is a synthetic exact-route native desktop check, not a general workload or
GUI soak. Raw SSE was not captured; successful Router Responses timings and
native completed items/turns establish the streamed completion result. Earlier
CLI attempts are excluded. No raw session identifiers, ciphertext, credentials,
or private request payloads are retained. Later runtime changes require renewal.
