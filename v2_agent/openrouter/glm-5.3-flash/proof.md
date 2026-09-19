# openrouter/glm-5.3-flash v2 certification

Accepted exact-route evidence for deployed Router `096fb8704ebc83df2aecec3aa46228578b639686`.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol parent on codex-cli 0.155.0-alpha.9.2 spawned
`router_openrouter_glm_5_3_flash` with no inherited conversation. Both child
turns used the Novita-pinned `openrouter/glm-5.3-flash` route through the native
CLI collaboration path.

- Window: 2026-09-19T02:49:52.631Z through 2026-09-19T02:50:38.790Z.
- Two encrypted handoffs were present in the same child rollout.
- Native execution returned `42` for `19+23` with exit code 0 in the default
  sandbox and no unsandboxed retry.
- First marker: `CERT_FIRST_OK` at 2026-09-19T02:50:23.407Z.
- Same-child follow-up: `CERT_SECOND_OK` at 2026-09-19T02:50:33.618Z.
- The parent cleaned up after the second marker and exited successfully.
- All three exact-route requests returned HTTP 200 without cancellation.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-19T02:50:16.415Z | 23761 | 200 |
| 2026-09-19T02:50:23.370Z | 5867 | 200 |
| 2026-09-19T02:50:33.612Z | 7387 | 200 |

Evidence was reconciled against parent and child rollout events, actual tool
output, Router timings, and the deployed manifest. Only sanitized summaries are
retained. The Novita endpoint remained pinned with fallback disabled.

## Limits

This is native CLI v2 certification, not a desktop GUI WebSocket soak or an
exhaustive provider fault test. App-tool and lifecycle regressions are covered by
the offline suite. Refresh after relevant runtime changes.
