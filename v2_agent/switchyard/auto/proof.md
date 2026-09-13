# switchyard/auto v2 certification

Status: draft. The evidence below belongs to the previous Router instruction
policy and remains historical until the current candidate passes all five checks.

Accepted on Windows Codex app 26.908.4834.0 with codex-cli 0.154.0-alpha.6.2
and deployed Router commit `24b0653b0beda9ec2f0cad4f555b3adb6a6f8bcd`.

## Evidence

- A native Codex parent spawned the exact generated route role. The child
  rollout records two encrypted `agent_message` handoffs in one child thread.
- Both turns executed native `mcp__codex_app.list_projects` successfully,
  through the native functions relay. Project names and identifiers are omitted.
- First marker: `SWITCHYARD_0912_FIRST_OK` at 2026-09-12T16:17:11.738Z.
- Same-child follow-up marker: `SWITCHYARD_0912_SECOND_OK` at 2026-09-12T16:17:45.992Z.
- 6 routed Responses requests completed with HTTP 200 in this window.
  No canceled request is counted. Child completion was observed before cleanup;
  no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-12T16:17:01.362Z | 9497 | 200 |
| 2026-09-12T16:17:06.472Z | 4270 | 200 |
| 2026-09-12T16:17:09.835Z | 2608 | 200 |
| 2026-09-12T16:17:11.827Z | 1870 | 200 |
| 2026-09-12T16:17:42.261Z | 7632 | 200 |
| 2026-09-12T16:17:46.209Z | 3909 | 200 |

The JSON proof binds the deployed upstream commit, canonical patch, binary,
private generated routes, and Router commit. The redacted Switchyard evidence
records one session, six successful requests, Sol Medium then Luna High, and
zero HTTP, server, judge, parse, or fallback failures. This run certifies the
exact route and native collaboration; it is not a comparative classifier benchmark.
