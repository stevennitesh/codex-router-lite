# openrouter/deepseek-v4.1-flash-together v2 certification

Accepted observations against Router `75172c2c002b2a6485ca6ae9ae7eb448339033bb`
(version 0.7.0), codex-cli 0.162.0-alpha.2, Windows app 26.1002.7124.0.
Tested at 2026-10-09T00:08:11.153Z. Exact endpoint: `together`; fallback disabled.

## Evidence

[Redacted run evidence](../../../docs/history/2026-10-08-windows-service-certification.json) records role `router_openrouter_deepseek_v4_1_flash_together`, effort
`high`, output 42 from a real sandboxed command, two encrypted
handoffs, and both markers from the same child. 3 Router requests
completed successfully. 2 cleanup calls observed
already-completed turns; no active turn was cancelled.

| Check | Result |
| --- | --- |
| Streamed text and completion | pass |
| Actual native tool and output | pass |
| Encrypted parent-to-child relay | pass |
| First marker | pass |
| Same-child follow-up | pass |

## Official sources

- https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
- https://openrouter.ai/docs/guides/routing/provider-selection

## Scope and reproduction

The native CLI used session-only `windows.sandbox="mxc"`,
workspace-write, and on-request approval. The runner did not change persistent
configuration. This certifies the named CLI path; desktop sandbox behavior,
arbitrary MCP tools, exhaustive schemas and model reliability are outside the run.
Follow [certification](../../../docs/SUBAGENT-CERTIFICATION.md) for reproduction and refresh conditions.
Raw transcripts, ciphertext and session identifiers are omitted.
