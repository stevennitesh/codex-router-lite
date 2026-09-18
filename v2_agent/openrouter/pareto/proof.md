# openrouter/pareto v2 certification

Accepted exact-route evidence for deployed Router `934caf23233a8ef5da8d71caf1339cc6b6f3dc05`.
Historical evidence is bound to this runtime, not a later candidate.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh Sol medium parent using codex-cli 0.155.0-alpha.2.6 spawned
`router_openrouter_pareto` with no inherited conversation. Both turns used
`openrouter/pareto`. This run used the native CLI collaboration path.

- Window: 2026-09-18T11:41:58.156Z through 2026-09-18T11:42:31.692Z.
- Two encrypted handoffs: 2026-09-18T11:42:07.162Z and 2026-09-18T11:42:19.533Z.
- One native exec_command call executed PowerShell arithmetic and returned
  42 with exit code 0 in the default sandbox, without an unsandboxed retry.
- First marker: `PARETO_934CAF_FIRST_OK` at 2026-09-18T11:42:16.518Z.
- Same-child follow-up: `PARETO_934CAF_SECOND_OK` at 2026-09-18T11:42:23.627Z.
- Parent cleanup occurred only after the second marker; the parent exited 0.
- All 3 exact-route requests completed with HTTP 200, with no cancellation.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-18T11:42:14.431Z | 7247 | 200 |
| 2026-09-18T11:42:16.495Z | 1199 | 200 |
| 2026-09-18T11:42:23.621Z | 4072 | 200 |

Evidence was reconciled against parent and child rollout events, actual tool
results, Router timings, and the deployed manifest. Only sanitized summaries
are recorded here; no encrypted payloads or private conversations are included.

The unbiased endpoint remained pinned with fallback disabled.
This proof does not apply to another endpoint or the retired Union route.

## Limits

This is native CLI v2 certification, not a desktop GUI WebSocket soak or an
exhaustive provider fault test. Shared lifecycle and redirect regressions are
covered separately by the offline suite. Refresh after relevant runtime changes.
