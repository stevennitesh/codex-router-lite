# openrouter/glm-5.3-flash-together v2 certification

Accepted observations against Router `f8bc922bd0f79ae1ad253cda77451c72dca8621d`
(version 0.7.0), codex-cli 0.162.0-alpha.17.2, Windows app 26.1007.2314.0.
Tested at 2026-10-10T17:10:45.181Z. Exact endpoint: `together`; fallback disabled.

## Evidence

[Redacted run evidence](../../../docs/history/2026-10-10-compatibility-together-certification.json) records role `router_openrouter_glm_5_3_flash_together`, effort
`max`, output 42 from a real sandboxed command, two encrypted
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

- https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints
- https://openrouter.ai/docs/guides/routing/provider-selection

## Scope and reproduction

The native CLI used session-only `windows.sandbox="mxc"`,
workspace-write, and on-request approval. The runner did not change persistent
configuration. This certifies the named CLI path; desktop sandbox behavior,
arbitrary MCP tools, exhaustive schemas and model reliability are outside the run.
Follow [certification](../../../docs/SUBAGENT-CERTIFICATION.md) for reproduction and refresh conditions.
Raw transcripts, ciphertext and session identifiers are omitted.
