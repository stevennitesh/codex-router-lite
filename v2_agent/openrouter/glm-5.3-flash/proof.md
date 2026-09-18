# openrouter/glm-5.3-flash v2 certification

Accepted exact-route evidence for deployed Router `4189cbfc1c64886335c506df37f673dd963697a1`.
Historical evidence is bound to this runtime, not a later candidate.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh Sol medium parent using codex-cli 0.155.0-alpha.9 spawned
`router_openrouter_glm_5_3_flash` with no inherited conversation. Both turns used
`openrouter/glm-5.3-flash`. This run used the native CLI collaboration path.

- Window: 2026-09-18T13:08:42.787Z through 2026-09-18T13:09:34.442Z.
- Two encrypted handoffs: 2026-09-18T13:08:48.860Z and 2026-09-18T13:09:15.669Z.
- A native tool executed PowerShell arithmetic and returned 42
  in the default sandbox, without an unsandboxed retry.
- First marker: `NOVITA_4189CBFC_FIRST_OK` at 2026-09-18T13:09:12.238Z.
- Same-child follow-up: `NOVITA_4189CBFC_SECOND_OK` at 2026-09-18T13:09:27.074Z.
- Parent cleanup occurred only after the second marker; the parent exited 0.
- All 3 exact-route requests completed with HTTP 200, with no cancellation.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-18T13:09:04.022Z | 15139 | 200 |
| 2026-09-18T13:09:12.209Z | 7256 | 200 |
| 2026-09-18T13:09:27.065Z | 11381 | 200 |

Evidence was reconciled against parent and child rollout events, actual tool
results, Router timings, and the deployed manifest. Only sanitized summaries
are recorded here; no encrypted payloads or private conversations are included.

The novita endpoint remained pinned with fallback disabled.
This proof does not apply to another endpoint or the retired Union route.

## Limits

This is native CLI v2 certification, not a desktop GUI WebSocket soak or an
exhaustive provider fault test. App-tool contract round trips and shared lifecycle
regressions are covered separately by the offline suite. Refresh after relevant
runtime changes.
