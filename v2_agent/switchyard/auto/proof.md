# switchyard/auto v2 certification

Historical proof for the exact identities below, not a claim about a later runtime.
Current procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

Accepted on Windows Codex app 26.911.7940.0 with codex-cli 0.155.0-alpha.2.6
and deployed Router commit `76739f826bc170f8a9a4076dcb1f1ac82307bf35`.

## Evidence

- One native parent spawned the exact route role. The child rollout records
  two encrypted agent-message handoffs and both markers in the same child.
- Native `exec` executed the synthetic arithmetic
  task and returned 42. No project data or real app operation was required.
- First marker: `SWITCHYARD_76739_FIRST_OK` at 2026-09-17T20:58:02.790Z.
- Same-child follow-up: `SWITCHYARD_76739_SECOND_OK` at 2026-09-17T20:58:51.509Z.
- All 3 routed Responses requests completed with HTTP 200.
  Child completion was observed before cleanup; no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-17T20:57:59.720Z | 7471 | 200 |
| 2026-09-17T20:58:02.848Z | 3116 | 200 |
| 2026-09-17T20:58:51.549Z | 7159 | 200 |

The JSON proof binds the upstream commit, canonical patch, binary, private
routes and Router commit. Live hashes matched the installed provenance and lock.
The redacted generation evidence shows one session, three successful requests,
Sol Medium throughout, and no HTTP, server, judge, parse or fallback failures.
This proves native collaboration on this route, not classifier quality.
