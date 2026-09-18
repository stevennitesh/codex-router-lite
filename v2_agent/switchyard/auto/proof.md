# switchyard/auto prior v2 evidence

Historical exact-route evidence for deployed Router `4189cbfc1c64886335c506df37f673dd963697a1`.
The four-target A1 candidate changes routing policy, so this application is now
draft and cannot certify the candidate. A fresh A3 run is required after deployment.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh Sol medium parent using codex-cli 0.155.0-alpha.9 spawned
`router_switchyard_auto` with no inherited conversation. Both turns used
`switchyard/auto`. This run used the native CLI collaboration path.

- Window: 2026-09-18T13:12:12.548Z through 2026-09-18T13:12:54.922Z.
- Two encrypted handoffs: 2026-09-18T13:12:18.697Z and 2026-09-18T13:12:35.183Z.
- A native tool executed PowerShell arithmetic and returned 42
  in the default sandbox, without an unsandboxed retry.
- First marker: `SWITCHYARD_4189CBFC_FIRST_OK` at 2026-09-18T13:12:31.362Z.
- Same-child follow-up: `SWITCHYARD_4189CBFC_SECOND_OK` at 2026-09-18T13:12:46.577Z.
- Parent cleanup occurred only after the second marker; the parent exited 0.
- All 3 exact-route requests completed with HTTP 200, with no cancellation.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-18T13:12:28.570Z | 9852 | 200 |
| 2026-09-18T13:12:31.363Z | 1730 | 200 |
| 2026-09-18T13:12:46.625Z | 11422 | 200 |

Evidence was reconciled against parent and child rollout events, actual tool
results, Router timings, and the deployed manifest. Only sanitized summaries
are recorded here; no encrypted payloads or private conversations are included.

Switchyard remains pinned to `a70a1fba2f975b6eb0f1066a2cd2a82bfc7d3052`; proof.json records
its verified binary, patch, generated-route hashes and deployed Router commit.

## Limits

This was native CLI v2 evidence, not a desktop GUI WebSocket soak or an
exhaustive provider fault test. App-tool contract round trips and shared lifecycle
regressions are covered separately by the offline suite. Refresh after relevant
runtime changes.
