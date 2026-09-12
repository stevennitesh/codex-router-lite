# openrouter/glm-5.3-flash v2 certification

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `24b0653b0beda9ec2f0cad4f555b3adb6a6f8bcd`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- Both turns executed native `mcp__codex_app.list_projects` successfully,
  with the restored app namespace. Project names and identifiers are omitted.
- First marker: `NOVITA_0912_FIRST_OK` at 2026-09-12T16:16:54.994Z.
- Same-child follow-up marker: `NOVITA_0912_SECOND_OK` at 2026-09-12T16:17:39.318Z.
- 4 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Child completion was observed before cleanup;
  no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-12T16:16:46.546Z | 10415 | 200 |
| 2026-09-12T16:16:54.988Z | 7246 | 200 |
| 2026-09-12T16:17:33.844Z | 8945 | 200 |
| 2026-09-12T16:17:39.311Z | 5437 | 200 |

The exact novita endpoint remained pinned with provider fallback disabled.
This evidence does not certify other endpoints or a later runtime generation.
