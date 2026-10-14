# openrouter/deepseek-v4.1-flash-together v2 certification

Accepted observations against Router `3bcae1da455b586a01b9ccdb15ee499dedafb8a4`
(version 0.7.0), codex-cli 0.162.0-alpha.17.2, Windows app 26.1007.9446.0.
Tested at 2026-10-14T03:51:24.732Z. Exact endpoint: `together`; fallback disabled.

## Evidence

[Redacted run evidence](../../../docs/history/2026-10-13-deployed-certification.json) records role `router_openrouter_deepseek_v4_1_flash_together`, effort
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
