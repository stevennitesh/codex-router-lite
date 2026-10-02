# openrouter/glm-5.3-flash v2 certification

Accepted on 2026-10-02T10:39:25.959Z against deployed Router `04a971fc98d3d19c5818e8492a92c0e53fe9a596`
(version 0.7.0), codex-cli 0.159.0-alpha.12.1 and Windows app 26.930.2377.0.
The native desktop parent used the generated `router_openrouter_glm_5_3_flash` role with no
inherited conversation. This historical proof applies only to the recorded runtime.

## Evidence

[Bounded native evidence](../../../docs/history/2026-10-02-native-v2-certification.json) records actual spawn and follow-up
events, two encrypted handoffs in one child rollout, a default-sandbox command
`Write-Output (19+23)` returning `42`, and both final markers:
`NOVITA_04A971FC_R2_FIRST_OK` and `NOVITA_04A971FC_R2_SECOND_OK`.
Tool call/output identities matched. Both cleanup calls reported the child
already completed; no running turn was interrupted.

All three Router requests returned HTTP 200, with durations
18859, 8700, 6827 ms. This fresh window follows the operator's protected credential
refresh and managed restart; the earlier expired-key attempt is separate evidence.

## Limits

Native completed items and turns establish streamed completion; raw SSE was not
retained. No ciphertext, raw session identifiers, credentials or private task
payloads are included. This is a synthetic certification, not a workload soak.
Later runtime or route-contract changes require renewed proof.
