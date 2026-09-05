# v2 agent application: `switchyard/auto`

- Status: accepted
- Endpoint: Switchyard; fallback disabled
- Router: `0.5.1`, deployed candidate `fdd056f7b06c0bc1e01bbff8c235e9d121d7968c`
- Codex: `codex-cli 0.153.4`, Windows app `26.901.5280.0`
- Execution: Windows Codex desktop native collaboration

The source, patch, binary, and routes remain at the accepted upstream update. This run refreshes the Router binding after removing unsolicited child interrupts and repairing the GLM tool surface. The exact runtime hashes are recorded in `proof.json`.

## Evidence

| Check | Result | Router completion time |
| --- | --- | --- |
| Streaming and native app tool | pass; HTTP 200 | 2026-09-05T09:31:04.557Z |
| Encrypted parent-to-child relay | pass; native child executed the app call | 2026-09-05T09:31:04.557Z |
| First marker | `SWITCHYARD_APP_FDD056F7_ONE` | 2026-09-05T09:31:06.884Z |
| Same-child follow-up | `SWITCHYARD_APP_FDD056F7_TWO` | 2026-09-05T09:31:39.831Z |

The child executed `list_projects` through the native `functions.exec` tool surface. All three Router requests returned HTTP 200. Switchyard selected `sol-medium` twice and `luna-high` once, with no classifier errors, parse failures, or fallback. The second marker came from the same child without interruption.

## Validation and limits

The retained suite passed 133 tests, including the live-shaped reasoning/message ID collision followed by app dispatch on both exact GLM routes, request-owned tool availability, native response preservation, and absence of injected interrupts. Syntax, product-boundary, dependency-lock, installed-Codex catalog parsing, and live Doctor checks passed. Installed source, patch, binary, and routes matched deployment provenance.

This bounded run proves the app tool call and native child continuation shown above. It does not execute every app action or certify every future provider response. Earlier unsupported-call probes are excluded. Repository evidence retains no project data, raw session identifiers, credentials, or decrypted relay payloads. Repeat the five native checks after changing the compatibility behavior or runtime binding.
