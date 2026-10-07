# switchyard/auto v2 certification

Accepted on 2026-10-07T03:13:08.169Z against deployed Router
`c8fea77e8d84e666fe4efd3d3921f380b019be50` (version 0.7.0),
codex-cli 0.160.1, Windows app 26.930.7945.0.
The execution surface was native desktop parent-to-child collaboration.

The three Switchyard requests used Sol Medium, Sol Medium, then Luna Max in
one observed session, with no classifier fallback or failed Router request.
The exact deployed identities are bound in proof.json.

## Evidence

[Bounded deployment evidence](../../../docs/history/2026-10-06-tool-union-native-v2-certification.json) records one passing window.
The child made a native sandboxed tool call computing 19+23 and received exit
code 0 with output 42. It returned the first marker and then the requested
second marker after a second encrypted handoff to that same child.
All three Router requests completed with HTTP 200. Both cleanup calls observed
already-completed turns; no active turn was cancelled.

| Check | Result |
| --- | --- |
| Streaming Responses completion | pass |
| Actual native tool call and output | pass; 42 |
| Encrypted parent-to-child relay | pass; two handoffs |
| First requested marker | pass |
| Same-child follow-up marker | pass |

## Limits

This synthetic native desktop window establishes exact-route collaboration.
It is not a workload soak or exhaustive provider support for every JSON Schema
keyword. Raw SSE was not retained; successful Router requests and native
tool and text completions establish streamed completion. The separate offline
checks establish preservation of union contracts through current request
preparation and the pinned LiteLLM adapter. Acceptance does not certify later
runtime changes. No ciphertext or private task payloads are published.
