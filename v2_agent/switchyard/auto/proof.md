# switchyard/auto v2 certification

Accepted on 2026-09-30T01:29:26.154Z against deployed Router `36fd7c787c76b58412d5bdafd41c16d6d727b060`
(version 0.7.0), codex-cli 0.159.0 and Windows app 26.928.1915.0.
The native desktop parent used the generated `router_switchyard_auto` role with no
inherited conversation. This historical proof applies only to the recorded runtime.

## Evidence

[Bounded evidence](../../../docs/history/2026-09-29-native-v2-certification.json) records actual spawn and follow-up
events, two encrypted handoffs in one child rollout, a default-sandbox command
`Write-Output (19+23)` returning `42`, and both final markers:
`SWITCHYARD_36FD7C78_FIRST_OK` and `SWITCHYARD_36FD7C78_SECOND_OK`.
Tool call/output identities matched. Both cleanup calls reported the child
already completed; no running turn was interrupted.

All three Router requests returned HTTP 200, with durations
9918, 4381, 5893 ms.
## Limits

Native completed items and turns establish streamed completion; raw SSE was not
retained. No ciphertext, raw session identifiers, credentials or private task
payloads are included. This is a synthetic certification, not a workload soak.
Later runtime or route-contract changes require renewed proof.
