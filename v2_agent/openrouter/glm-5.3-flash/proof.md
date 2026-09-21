# openrouter/glm-5.3-flash v2 certification

Accepted on 2026-09-21T01:45:57.376Z against deployed Router `19d1ac399f0df4851b56c9f0be64c3a8bb8de682`
(version 0.7.0), codex-cli 0.155.0-alpha.9.2, native CLI parent and exact-route child.
Endpoint: novita; no endpoint substitution.

## Evidence

[Bounded release evidence](../../../docs/history/2026-09-20-relay-release-certification.json) records the passing window.
All three child requests completed with HTTP 200. The child made a native
sandboxed tool call computing 19+23 and received 42, returned the first marker,
then returned the second marker after a second encrypted handoff to the same child.
The parent waited for completion before cleanup; failed earlier windows are excluded.

| Check | Result |
| --- | --- |
| Streaming Responses completion | pass |
| Actual native tool call/output | pass |
| Encrypted parent-to-child relay | pass; two handoffs |
| First marker | pass |
| Same-child follow-up marker | pass |

## Limits

This is synthetic native CLI collaboration evidence, not a GUI soak or proof of
arbitrary extraction fidelity. The deployed parser also passed a native Responses
Lite probe with exact synthetic plaintext. Current acceptance does not certify
later runtime changes. Switchyard's additional deployed identities, where
applicable, are recorded in proof.json.
