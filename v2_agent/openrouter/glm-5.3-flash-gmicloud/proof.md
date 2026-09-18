# openrouter/glm-5.3-flash-gmicloud v2 certification

Accepted exact-route evidence for deployed Router `934caf23233a8ef5da8d71caf1339cc6b6f3dc05`.
Historical evidence is bound to this runtime, not a later candidate.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh Sol medium parent using codex-cli 0.155.0-alpha.2.6 spawned
`router_openrouter_glm_5_3_flash_gmicloud` with no inherited conversation. Both turns used
`openrouter/glm-5.3-flash-gmicloud`. This run used the native CLI collaboration path.

- Window: 2026-09-18T11:41:08.904Z through 2026-09-18T11:41:58.155Z.
- Two encrypted handoffs: 2026-09-18T11:41:14.649Z and 2026-09-18T11:41:43.221Z.
- One native exec_command call executed PowerShell arithmetic and returned
  42 with exit code 0 in the default sandbox, without an unsandboxed retry.
- First marker: `GMI_934CAF_FIRST_OK` at 2026-09-18T11:41:39.360Z.
- Same-child follow-up: `GMI_934CAF_SECOND_OK` at 2026-09-18T11:41:51.580Z.
- Parent cleanup occurred only after the second marker; the parent exited 0.
- All 3 exact-route requests completed with HTTP 200, with no cancellation.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-18T11:41:29.138Z | 14467 | 200 |
| 2026-09-18T11:41:39.336Z | 9238 | 200 |
| 2026-09-18T11:41:51.574Z | 8336 | 200 |

Evidence was reconciled against parent and child rollout events, actual tool
results, Router timings, and the deployed manifest. Only sanitized summaries
are recorded here; no encrypted payloads or private conversations are included.

The gmicloud endpoint remained pinned with fallback disabled.
This proof does not apply to another endpoint or the retired Union route.

## Limits

This is native CLI v2 certification, not a desktop GUI WebSocket soak or an
exhaustive provider fault test. Shared lifecycle and redirect regressions are
covered separately by the offline suite. Refresh after relevant runtime changes.
