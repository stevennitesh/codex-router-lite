# switchyard/auto v2 certification

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `1f359654d864640e30b403d32599ce086234cc74`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- Both turns executed native `mcp__codex_app.list_projects` successfully,
  through the native functions relay. Project names and identifiers are omitted.
- First marker: `SWITCHYARD_WAIT_FIRST_OK` at 2026-09-13T01:08:22.599Z.
- Same-child follow-up marker: `SWITCHYARD_WAIT_SECOND_OK` at 2026-09-13T01:08:57.438Z.
- 4 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Child completion was observed before cleanup;
  no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-13T01:08:19.859Z | 9241 | 200 |
| 2026-09-13T01:08:22.672Z | 2765 | 200 |
| 2026-09-13T01:08:54.997Z | 5522 | 200 |
| 2026-09-13T01:08:59.478Z | 4448 | 200 |

The JSON proof binds the deployed upstream commit, canonical patch, binary,
private generated routes, and Router commit. The redacted Switchyard evidence
records one session, four successful requests, all routed to Luna High, and
zero HTTP, server, judge, parse, or fallback failures. This run certifies the
exact route and native collaboration; it is not a comparative classifier benchmark.
