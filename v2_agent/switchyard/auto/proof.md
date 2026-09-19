# switchyard/auto v2 certification

Accepted exact-route evidence for deployed Router `096fb8704ebc83df2aecec3aa46228578b639686`.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol parent on codex-cli 0.155.0-alpha.9.2 spawned
`router_switchyard_auto` with no inherited conversation in the workspace-write
sandbox with automatic approval review. It waited for the first child turn,
sent the second request to that same child, waited again, and cleaned up only
after completion.

- Window: 2026-09-19T02:49:01.007Z through 2026-09-19T02:49:17.833Z.
- Two encrypted native handoffs were present in the same child rollout.
- The child invoked native execution for `19+23`; the sandboxed result was `42`,
  with no unsandboxed retry.
- First marker: `CERT_FIRST_OK` at 2026-09-19T02:49:07.943Z.
- Same-child follow-up: `CERT_SECOND_OK` at 2026-09-19T02:49:12.805Z.
- All three exact-route completions returned HTTP 200. Jev
  `typesafe/jev-1.13-20260917` selected Sol Medium and recorded no fallback in
  this certification window.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-19T02:49:05.342Z | 4312 | 200 |
| 2026-09-19T02:49:07.952Z | 1560 | 200 |
| 2026-09-19T02:49:12.822Z | 2056 | 200 |

The machine-readable proof binds upstream base and reviewed contribution, the
compatibility patch, binary, private generated routes, canonical template, and
the deployed Router candidate. The sanitized reviewer record is
[`docs/history/2026-09-18-switchyard-followup-release-certification.json`](../../../docs/history/2026-09-18-switchyard-followup-release-certification.json).
No encrypted payload, conversation text, or thread identifier is retained.

## Limits

This is native CLI v2 evidence, not a desktop GUI WebSocket soak or an exhaustive
provider fault test. Shared app-tool, relay, catalog, and lifecycle regressions
remain covered by the offline suite. Refresh after any bound identity or contract
change.
