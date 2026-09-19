# openrouter/glm-5.3-flash-gmicloud v2 certification

Accepted exact-route evidence for deployed Router `096fb8704ebc83df2aecec3aa46228578b639686`.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol parent on codex-cli 0.155.0-alpha.9.2 spawned
`router_openrouter_glm_5_3_flash_gmicloud` with no inherited conversation. Both
child turns used the GMICloud-pinned exact route through the native CLI
collaboration path.

- Window: 2026-09-19T02:51:15.190Z through 2026-09-19T02:52:03.152Z.
- Two encrypted handoffs were present in the same child rollout.
- Native execution returned `42` for `19+23` with exit code 0 in the default
  sandbox and no unsandboxed retry.
- First marker: `CERT_FIRST_OK` at 2026-09-19T02:51:38.398Z.
- Same-child follow-up: `CERT_SECOND_OK` at 2026-09-19T02:51:58.346Z.
- The parent cleaned up after the second marker and exited successfully.
- All three exact-route requests returned HTTP 200 without cancellation.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-19T02:51:30.249Z | 15038 | 200 |
| 2026-09-19T02:51:38.362Z | 6639 | 200 |
| 2026-09-19T02:51:58.336Z | 17238 | 200 |

Evidence was reconciled against parent and child rollout events, actual tool
output, Router timings, and the deployed manifest. Only sanitized summaries are
retained. The GMICloud endpoint remained pinned with fallback disabled.

## Limits

This is native CLI v2 certification, not a desktop GUI WebSocket soak or an
exhaustive provider fault test. App-tool and lifecycle regressions are covered by
the offline suite. Refresh after relevant runtime changes.
