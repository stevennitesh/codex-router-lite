# openrouter/glm-5.3-flash v2 certification

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `1f359654d864640e30b403d32599ce086234cc74`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- Both turns executed native `mcp__codex_app.list_projects` successfully,
  with the restored app namespace. Project names and identifiers are omitted.
- First marker: `NOVITA_WAIT_FIRST_OK` at 2026-09-13T01:08:19.984Z.
- Same-child follow-up marker: `NOVITA_WAIT_SECOND_OK` at 2026-09-13T01:08:41.028Z.
- 4 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Child completion was observed before cleanup;
  no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-13T01:08:12.309Z | 11606 | 200 |
| 2026-09-13T01:08:19.977Z | 6023 | 200 |
| 2026-09-13T01:08:35.000Z | 9132 | 200 |
| 2026-09-13T01:08:41.020Z | 5966 | 200 |

The exact novita endpoint remained pinned with provider fallback disabled.
This evidence does not certify other endpoints or a later runtime generation.
