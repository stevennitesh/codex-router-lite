# switchyard/auto v2 certification

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `26b4af5d86f87c00dfd45cd437d27e74dde54217`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- The first turn executed native `mcp__codex_app.list_projects` successfully,
  through the native functions relay. Project names and identifiers are omitted.
- First marker: `SWITCHYARD_ROOT_HINT_FIRST_OK` at 2026-09-13T22:10:14.012Z.
- Same-child follow-up marker: `SWITCHYARD_ROOT_HINT_SECOND_OK` at 2026-09-13T22:10:38.018Z.
- 4 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Each child turn completed before cleanup.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-13T22:10:08.522Z | 12553 | 200 |
| 2026-09-13T22:10:11.473Z | 2485 | 200 |
| 2026-09-13T22:10:14.088Z | 2512 | 200 |
| 2026-09-13T22:10:38.095Z | 5994 | 200 |

The JSON proof binds the deployed upstream commit, canonical patch, binary,
private generated routes, and Router commit. The redacted Switchyard evidence
records one session, four successful requests, Sol Medium then Luna High, and
zero HTTP, server, judge, parse, or fallback failures. This run certifies the
exact route and native collaboration; it is not a comparative classifier benchmark.
