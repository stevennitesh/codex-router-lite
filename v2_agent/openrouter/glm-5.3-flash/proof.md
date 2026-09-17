# openrouter/glm-5.3-flash v2 certification

Historical proof for the exact identities below, not a claim about a later runtime.
Current procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

Accepted on Windows Codex app 26.911.7940.0 with codex-cli 0.155.0-alpha.2.6
and deployed Router commit `76739f826bc170f8a9a4076dcb1f1ac82307bf35`.

## Evidence

- One native parent spawned the exact route role. The child rollout records
  two encrypted agent-message handoffs and both markers in the same child.
- Native `exec_command` executed the synthetic arithmetic
  task and returned 42. No project data or real app operation was required.
- First marker: `NOVITA_76739_FIRST_OK` at 2026-09-17T20:58:00.989Z.
- Same-child follow-up: `NOVITA_76739_SECOND_OK` at 2026-09-17T20:58:41.052Z.
- All 3 routed Responses requests completed with HTTP 200.
  Child completion was observed before cleanup; no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-17T20:57:52.874Z | 17976 | 200 |
| 2026-09-17T20:58:00.978Z | 7386 | 200 |
| 2026-09-17T20:58:41.045Z | 9831 | 200 |

The exact novita endpoint remained pinned with fallback disabled.
This proof does not cover another endpoint or a later runtime generation.
