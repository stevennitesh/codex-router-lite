# openrouter/glm-5.3-flash-gmicloud v2 certification

Historical proof for the exact identities below, not a claim about a later runtime.
Current procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

Accepted on Windows Codex app 26.911.7940.0 with codex-cli 0.155.0-alpha.2.6
and deployed Router commit `76739f826bc170f8a9a4076dcb1f1ac82307bf35`.

## Evidence

- One native parent spawned the exact route role. The child rollout records
  two encrypted agent-message handoffs and both markers in the same child.
- Native `exec_command` executed the synthetic arithmetic
  task and returned 42. No project data or real app operation was required.
- First marker: `GMI_76739_FIRST_OK` at 2026-09-17T20:58:10.692Z.
- Same-child follow-up: `GMI_76739_SECOND_OK` at 2026-09-17T20:58:49.960Z.
- All 4 routed Responses requests completed with HTTP 200.
  Child completion was observed before cleanup; no running turn was interrupted.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-17T20:57:55.472Z | 11789 | 200 |
| 2026-09-17T20:58:01.844Z | 5350 | 200 |
| 2026-09-17T20:58:10.683Z | 8088 | 200 |
| 2026-09-17T20:58:49.951Z | 9905 | 200 |

The first shell command used a JavaScript-only helper in PowerShell and exited
with code 1. The model corrected it and received 42 before returning the first
marker. This was a model command mistake with successful error/result replay,
not a Router transport failure; both tool attempts are included in the window.

The exact gmicloud endpoint remained pinned with fallback disabled.
This proof does not cover another endpoint or a later runtime generation.
