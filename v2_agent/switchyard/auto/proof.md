# switchyard/auto v2 certification

Accepted observations against Router `3aa818e771b1e644cf891752787f5ea9acbf04b7`
(version 0.7.0), codex-cli 0.162.0-alpha.2, Windows app 26.1002.7124.0.
Tested at 2026-10-09T06:47:27.406Z. Switchyard runtime identities are recorded in proof.json.

## Evidence

[Redacted run evidence](../../../docs/history/2026-10-09-runtime-primitives-certification.json) records role `router_switchyard_auto`, effort
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

- https://github.com/NVIDIA-NeMo/Switchyard/blob/fbabf51c62793ed0f6af042b60e92ce1cfba083b/README.md

## Scope and reproduction

The native CLI used session-only `windows.sandbox="mxc"`,
workspace-write, and on-request approval. The runner did not change persistent
configuration. This certifies the named CLI path; desktop sandbox behavior,
arbitrary MCP tools, exhaustive schemas and model reliability are outside the run.
Follow [certification](../../../docs/SUBAGENT-CERTIFICATION.md) for reproduction and refresh conditions.
Raw transcripts, ciphertext and session identifiers are omitted.
