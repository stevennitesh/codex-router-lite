# openrouter/glm-5.3-flash-streamlake v2 certification

Historical acceptance on 2026-10-07T17:14:08.382Z against deployed Router
`dedd5cf9baa112f7eabd8aeacdb0ae95ea48905d` (version 0.7.0),
codex-cli 0.162.0-alpha.2, Windows app 26.1002.7124.0.

The execution surface was a fresh native Codex CLI parent. Its session-only
`windows.sandbox="mxc"` override retained workspace-write and on-request approval.
The persistent app setting remained elevated, and the signed helper was unchanged.

Endpoint: `streamlake/fp8`; fallback remained disabled.

## Evidence

[Bounded native evidence](../../../docs/history/2026-10-07-mxc-native-v2-certification.json) records one passing window.
The exact generated role was spawned with its pinned max effort and
an isolated conversation. The child ran `Write-Output (19+23)` with default
sandbox permissions and received output `42` with exit code 0. Two encrypted
handoffs reached that same child, which returned both requested markers.
All three Router requests completed with HTTP 200. Both cleanup calls observed
already-completed turns; no active turn was cancelled.

| Check | Result |
| --- | --- |
| Streamed Responses completion | pass |
| Actual native tool call and output | pass; 42 |
| Encrypted parent-to-child relay | pass; two handoffs |
| First requested marker | pass |
| Same-child follow-up marker | pass |

## Limits

This proves synthetic native CLI collaboration with MXC. It does not certify
the desktop's elevated sandbox, MCP server tools, exhaustive provider schema
support, or long-running workload reliability. The elevated helper's loaded-Node
ACL conflict remains an upstream issue. Raw SSE was not retained; successful
Router requests and native tool/text completions establish streamed completion.
Acceptance applies to the named candidate and route policy. No ciphertext,
private task payload, or raw session identifier is published.
