# openrouter/glm-5.3-flash v2 certification

Accepted on Windows Codex app 26.911.7940.0 with codex-cli 0.155.0-alpha.2.6
and deployed Router commit `3a8fc31ab4ece7a4c7732c789c7a789a7becbe6f`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- The first turn executed native `mcp__codex_app.list_projects` successfully,
  with the restored app namespace. Project names and identifiers are omitted.
- First marker: `NOVITA_26911_FIRST_OK` at 2026-09-17T00:33:12.548Z.
- Same-child follow-up marker: `NOVITA_26911_SECOND_OK` at 2026-09-17T00:33:28.745Z.
- 3 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Each child turn completed before cleanup.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-17T00:33:05.034Z | 17384 | 200 |
| 2026-09-17T00:33:12.548Z | 5917 | 200 |
| 2026-09-17T00:33:28.745Z | 10093 | 200 |

The exact novita endpoint remained pinned with provider fallback disabled.
This evidence does not certify other endpoints or a later runtime generation.
