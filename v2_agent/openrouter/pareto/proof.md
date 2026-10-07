# openrouter/pareto v2 certification

Accepted observations on 2026-10-07T20:42:13.018Z against deployed Router
`4ca8bfa6012b6ba3a2057df23361761ce48bbdba` (version 0.7.0),
codex-cli 0.162.0-alpha.2, Windows app 26.1002.7124.0.

Endpoint: `unbiased`; fallback remains disabled.

## Evidence

[Redacted run evidence](../../../docs/history/2026-10-07-maintenance-overhaul-certification.json) records the exact generated
role `router_openrouter_pareto` with its pinned `none` effort and isolated
conversation. The native child ran `Write-Output (19+23)` with default sandbox
permissions and returned `42` with exit code 0. Two encrypted handoffs reached
the same child, which returned both requested markers. All 3 child Router requests
completed with HTTP 200. Both cleanup calls observed completed turns; no active
turn was cancelled.

| Check | Result |
| --- | --- |
| Streamed Responses text and completion | pass; separately observed text deltas and response.completed |
| Actual native tool call and output | pass; 42 |
| Encrypted parent-to-child relay | pass; two handoffs |
| First requested marker | pass |
| Same-child follow-up marker | pass |

## Scope and reproduction

The fresh native CLI parent used a session-only `windows.sandbox="mxc"`
override with workspace-write and on-request approval. The persistent app
setting remains elevated, and the original signed helper was retained.
This run does not certify desktop elevated sandbox behavior, all MCP tools,
exhaustive provider schemas, or long-running model reliability.

For reproduction, use the exact role and two-turn procedure in
[certification](../../../docs/SUBAGENT-CERTIFICATION.md), with a fresh native CLI
parent and the scoped backend shown above. Streaming is observed separately on
the same installed generation. Raw payloads, ciphertext and session identifiers
are omitted from the published evidence.
