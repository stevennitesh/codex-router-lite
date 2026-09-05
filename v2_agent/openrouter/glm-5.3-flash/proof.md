# v2 agent application: `openrouter/glm-5.3-flash`

- Status: accepted
- Endpoint: Novita; fallback disabled
- Router: `0.5.1`, deployed candidate `fdd056f7b06c0bc1e01bbff8c235e9d121d7968c`
- Codex: `codex-cli 0.153.4`, Windows app `26.901.5280.0`
- Execution: Windows Codex desktop native collaboration

The endpoint and request policy remain unchanged. The deployed repair gives messages a distinct ID when LiteLLM reuses a reasoning ID, allowing strict namespace restoration to continue. GLM receives only caller-supplied tools and native discoveries; the reference snapshot no longer adds an obsolete app namespace. Router no longer injects child interrupts.

## Evidence

| Check | Result | Router completion time |
| --- | --- | --- |
| Streaming and native app tool | pass; HTTP 200 | 2026-09-05T09:30:56.278Z |
| Encrypted parent-to-child relay | pass; native child executed the app call | 2026-09-05T09:30:56.278Z |
| First marker | `NOVITA_APP_FDD056F7_ONE` | 2026-09-05T09:31:08.029Z |
| Same-child follow-up | `NOVITA_APP_FDD056F7_TWO` | 2026-09-05T09:31:33.737Z |

The child rollout records `name: list_projects`, `namespace: mcp__codex_app`, and a successful tool result. This verifies execution inside the app, beyond a successful provider HTTP response. The second turn used the same native child with no interrupt between markers.

## Validation and limits

The retained suite passed 133 tests, including the live-shaped reasoning/message ID collision followed by app dispatch on both exact GLM routes, request-owned tool availability, native response preservation, and absence of injected interrupts. Syntax, product-boundary, dependency-lock, installed-Codex catalog parsing, and live Doctor checks passed. Installed source, patch, binary, and routes matched deployment provenance.

This bounded run proves the app tool call and native child continuation shown above. It does not execute every app action or certify every future provider response. Earlier unsupported-call probes are excluded. Repository evidence retains no project data, raw session identifiers, credentials, or decrypted relay payloads. Repeat the five native checks after changing the compatibility behavior or runtime binding.
