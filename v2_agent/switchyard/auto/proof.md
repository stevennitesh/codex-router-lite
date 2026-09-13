# switchyard/auto v2 certification

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `69b4d0af39af9cf56d33fd5d874545be2247ce2b`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- Both turns executed native `mcp__codex_app.list_projects` successfully,
  through the native functions relay. Project names and identifiers are omitted.
- First marker: `SWITCHYARD_NATIVE_CONFIG_FIRST_OK` at 2026-09-13T02:15:18.699Z.
- Same-child follow-up marker: `SWITCHYARD_NATIVE_CONFIG_SECOND_OK` at 2026-09-13T02:15:47.592Z.
- 4 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Child completion was observed before cleanup;
  no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-13T02:15:16.329Z | 8829 | 200 |
| 2026-09-13T02:15:18.784Z | 2340 | 200 |
| 2026-09-13T02:15:45.234Z | 6498 | 200 |
| 2026-09-13T02:15:47.668Z | 2401 | 200 |

The JSON proof binds the deployed upstream commit, canonical patch, binary,
private generated routes, and Router commit. The redacted Switchyard evidence
records one session, four successful requests, all routed to Sol Medium, and
zero HTTP, server, judge, parse, or fallback failures. This run certifies the
exact route and native collaboration; it is not a comparative classifier benchmark.
