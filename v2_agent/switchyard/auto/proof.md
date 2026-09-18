# switchyard/auto v2 certification

Accepted exact-route evidence for deployed Router `934caf23233a8ef5da8d71caf1339cc6b6f3dc05`.
Historical evidence is bound to this runtime, not a later candidate.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh Sol medium parent using codex-cli 0.155.0-alpha.2.6 spawned
`router_switchyard_auto` with no inherited conversation. Both turns used
`switchyard/auto`. This run used the native CLI collaboration path.

- Window: 2026-09-18T11:42:31.693Z through 2026-09-18T11:43:32.179Z.
- Two encrypted handoffs: 2026-09-18T11:42:42.178Z and 2026-09-18T11:43:12.129Z.
- One native exec call executed PowerShell arithmetic and returned
  42 with exit code 0 in the default sandbox, without an unsandboxed retry.
- First marker: `SWITCHYARD_934CAF_FIRST_OK` at 2026-09-18T11:43:06.282Z.
- Same-child follow-up: `SWITCHYARD_934CAF_SECOND_OK` at 2026-09-18T11:43:19.802Z.
- Parent cleanup occurred only after the second marker; the parent exited 0.
- All 3 exact-route requests completed with HTTP 200, with no cancellation.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-18T11:42:59.297Z | 17093 | 200 |
| 2026-09-18T11:43:06.371Z | 6209 | 200 |
| 2026-09-18T11:43:19.821Z | 7677 | 200 |

Evidence was reconciled against parent and child rollout events, actual tool
results, Router timings, and the deployed manifest. Only sanitized summaries
are recorded here; no encrypted payloads or private conversations are included.

## Runtime binding

The JSON proof binds the deployed upstream commit, canonical patch, binary,
private routes file, and Router commit. Their hashes matched live provenance
and the source lock. Redacted Switchyard evidence records one session, three
successful requests, Sol Medium throughout, and no HTTP, server, judge, parse,
or fallback failures. This does not measure classifier quality across tasks.

## Limits

This is native CLI v2 certification, not a desktop GUI WebSocket soak or an
exhaustive provider fault test. Shared lifecycle and redirect regressions are
covered separately by the offline suite. Refresh after relevant runtime changes.
