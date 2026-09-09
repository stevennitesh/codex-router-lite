# v2 agent application: openrouter/glm-5.3-flash

- Status: accepted
- Router candidate: acd5fc1b02f1c8a66b2045d71ccf60e5355c495f
- Windows app: 26.903.8094.0; CLI: 0.153.4
- Execution: Windows Codex native collaboration; exact endpoint unchanged

The deployed candidate preserves native authentication and rate-limit failures during encrypted child handoff, bounds repeated rate-limited handoffs, and isolates legacy native capability flags from GLM. Native catalog upgrade caching, Windows heartbeat stop behavior, and Undici were also updated.

## Evidence

- Native list_projects call and successful result: 2026-09-09T12:14:31.507Z
- First marker: NOVITA_ACD5FC1B_ONE at 2026-09-09T12:14:41.776Z
- Same-child follow-up: NOVITA_ACD5FC1B_TWO at 2026-09-09T12:15:08.186Z

All recorded route requests returned HTTP 200. Native child rollouts confirm app tool execution; the same child returned both markers without interruption. Switchyard selected luna-high twice and sol-medium once, with no classifier, parse, HTTP, or fallback errors in its three-request window. Its unchanged binary, patch, source and route hashes are bound in proof.json.

## Validation and limits

All 146 retained tests, product checks, installed catalog parsing (16 models), runtime health, and deployment provenance checks passed. The transaction restored the prior runtime on two rejected acceptance checks before the corrected candidate passed. This bounded run proves the stated tool and continuation paths, not every app action. No credentials, project contents, raw session IDs, or decrypted payloads are retained here.
