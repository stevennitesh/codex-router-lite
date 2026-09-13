# openrouter/glm-5.3-flash v2 certification

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `26b4af5d86f87c00dfd45cd437d27e74dde54217`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- The first turn executed native `mcp__codex_app.list_projects` successfully,
  with the restored app namespace. Project names and identifiers are omitted.
- First marker: `NOVITA_ROOT_HINT_FIRST_OK` at 2026-09-13T22:10:04.048Z.
- Same-child follow-up marker: `NOVITA_ROOT_HINT_SECOND_OK` at 2026-09-13T22:10:34.892Z.
- 3 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Each child turn completed before cleanup.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-13T22:09:57.712Z | 11338 | 200 |
| 2026-09-13T22:10:04.042Z | 6186 | 200 |
| 2026-09-13T22:10:34.880Z | 9466 | 200 |

The exact novita endpoint remained pinned with provider fallback disabled.
This evidence does not certify other endpoints or a later runtime generation.
