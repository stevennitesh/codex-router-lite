# openrouter/glm-5.3-flash v2 certification

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `69b4d0af39af9cf56d33fd5d874545be2247ce2b`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- Both turns executed native `mcp__codex_app.list_projects` successfully,
  with the restored app namespace. Project names and identifiers are omitted.
- First marker: `NOVITA_NATIVE_CONFIG_FIRST_OK` at 2026-09-13T02:15:16.908Z.
- Same-child follow-up marker: `NOVITA_NATIVE_CONFIG_SECOND_OK` at 2026-09-13T02:15:42.344Z.
- 4 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Child completion was observed before cleanup;
  no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-13T02:15:09.691Z | 12346 | 200 |
| 2026-09-13T02:15:16.899Z | 5968 | 200 |
| 2026-09-13T02:15:37.390Z | 8334 | 200 |
| 2026-09-13T02:15:42.336Z | 4885 | 200 |

The exact novita endpoint remained pinned with provider fallback disabled.
This evidence does not certify other endpoints or a later runtime generation.
