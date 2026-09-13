# openrouter/glm-5.3-flash-gmicloud v2 certification

Status: draft. The evidence below predates the managed native root-agent hint
and remains historical until the current candidate passes all five checks.

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `69b4d0af39af9cf56d33fd5d874545be2247ce2b`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- Both turns executed native `mcp__codex_app.list_projects` successfully,
  with the restored app namespace. Project names and identifiers are omitted.
- First marker: `GMI_NATIVE_CONFIG_FIRST_OK` at 2026-09-13T02:15:30.320Z.
- Same-child follow-up marker: `GMI_NATIVE_CONFIG_SECOND_OK` at 2026-09-13T02:16:05.480Z.
- 5 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Child completion was observed before cleanup;
  no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-13T02:15:16.799Z | 14255 | 200 |
| 2026-09-13T02:15:22.710Z | 5422 | 200 |
| 2026-09-13T02:15:30.312Z | 7449 | 200 |
| 2026-09-13T02:15:58.458Z | 11128 | 200 |
| 2026-09-13T02:16:05.468Z | 6971 | 200 |

The exact gmicloud endpoint remained pinned with provider fallback disabled.
This evidence does not certify other endpoints or a later runtime generation.
