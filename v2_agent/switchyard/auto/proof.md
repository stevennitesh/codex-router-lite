# switchyard/auto v2 certification

Accepted on Windows Codex app 26.911.7940.0 with codex-cli 0.155.0-alpha.2.6
and deployed Router commit `3a8fc31ab4ece7a4c7732c789c7a789a7becbe6f`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- The first turn executed native `mcp__codex_app.list_projects` successfully,
  through the native functions relay. Project names and identifiers are omitted.
- First marker: `SWITCHYARD_26911_FIRST_OK` at 2026-09-17T00:33:12.437Z.
- Same-child follow-up marker: `SWITCHYARD_26911_SECOND_OK` at 2026-09-17T00:33:22.950Z.
- 4 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Each child turn completed before cleanup.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-17T00:33:04.986Z | 6996 | 200 |
| 2026-09-17T00:33:10.013Z | 5024 | 200 |
| 2026-09-17T00:33:12.437Z | 2341 | 200 |
| 2026-09-17T00:33:22.950Z | 7322 | 200 |

The JSON proof binds the deployed upstream commit, canonical patch, binary,
private generated routes, and Router commit. The redacted Switchyard evidence
records one session, four successful requests, Sol Medium throughout, and
zero HTTP, server, judge, parse, or fallback failures. This run certifies the
exact route and native collaboration; it is not a comparative classifier benchmark.
