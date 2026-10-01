# openrouter/glm-5.3-flash-gmicloud v2 certification

Accepted on 2026-10-01T18:17:36.505Z against deployed Router `3ed405b5ba1973aed72c7fdca797ac7c9ce11c8f`
(version 0.7.0), codex-cli 0.159.2 and Windows app 26.928.3736.0.
The native desktop parent used the generated `router_openrouter_glm_5_3_flash_gmicloud` role with no
inherited conversation. This historical proof applies only to the recorded runtime.

## Evidence

[Bounded native evidence](../../../docs/history/2026-10-01-native-v2-certification.json) records actual spawn and follow-up
events, two encrypted handoffs in one child rollout, a default-sandbox command
`Write-Output (19+23)` returning `42`, and both final markers:
`GMICLOUD_3ED405B5_FIRST_OK` and `GMICLOUD_3ED405B5_SECOND_OK`.
Tool call/output identities matched. Both cleanup calls reported the child
already completed; no running turn was interrupted.

All three Router requests returned HTTP 200, with durations
15475, 8618, 10106 ms.

## Limits

Native completed items and turns establish streamed completion; raw SSE was not
retained. No ciphertext, raw session identifiers, credentials or private task
payloads are included. This is a synthetic certification, not a workload soak.
Later runtime or route-contract changes require renewed proof.
