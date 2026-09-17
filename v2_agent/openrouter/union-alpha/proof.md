# Union Alpha v2 certification

Historical proof for the named runtime, not a claim about later generations.
Current procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Codex CLI parent on codex-cli 0.155.0-alpha.2.6 spawned
`router_openrouter_union_alpha`. The child rollout contains two encrypted
agent-message handoffs, successful native `exec_command` execution returning 42,
and both markers in the same child:

- `UNION_V2_FIRST_OK` at 2026-09-17T21:07:30.736Z.
- `UNION_V2_SECOND_OK` at 2026-09-17T21:07:45.555Z.

The deployed Router was `76739f826bc170f8a9a4076dcb1f1ac82307bf35`, with the
single Stealth endpoint and fallback disabled. Union's v2 catalog flag and native
role were published for the authorized proof window; the provider protocol and
runtime binary were unchanged. Parent/child testing used the native CLI, not the
desktop GUI. The installed Windows app version was 26.911.7940.0.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-17T21:07:03.986Z | 14279 | 200 |
| 2026-09-17T21:07:10.361Z | 5724 | 200 |
| 2026-09-17T21:07:12.658Z | 1845 | 200 |
| 2026-09-17T21:07:20.425Z | 7287 | 200 |
| 2026-09-17T21:07:30.704Z | 4355 | 200 |
| 2026-09-17T21:07:45.547Z | 8088 | 200 |

Three shell attempts encountered the Windows sandbox setup-refresh error. The
normal approval mechanism then allowed the same bounded arithmetic operation,
which exited successfully. Those failures are retained in the child history;
all six provider requests completed with HTTP 200. No running child was interrupted.
This proves tool execution and error/result replay, not arbitrary shell reliability.

The endpoint's model identity remains undisclosed. This proof does not establish
its underlying weights, hosted-search capability, or behavior on another endpoint.
