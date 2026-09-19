# switchyard/auto v2 certification draft

The installed runtime remains certified for deployed Router
`e37672c4f544e5b8ebc29e473c5564e78db5bd9b` and compatibility patch
`411a109fd5ec302fbec91ce13272155e76b44b540ac7cdcb0ac9654731ab3bcd`.
The checked source now uses compatibility patch
`6902a7e93e7ac7f1b75d31f5985fe4a078a733e06270455785f8ef1a244dd9de`,
so the source route is v1 and this application remains draft until that exact
candidate is deployed and certified. The prior runtime evidence remains in
[`docs/history`](../../../docs/history/2026-09-18-switchyard-review-cleanup-certification.json).
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol parent on codex-cli 0.155.0-alpha.9.2 spawned
`router_switchyard_auto` with no inherited conversation in the workspace-write
sandbox with automatic approval review. It waited for the first child turn,
sent the second request to that same child, waited again, and cleaned up only
after completion.

- Window: 2026-09-19T04:10:53.541Z through 2026-09-19T04:11:10.740Z.
- Two encrypted native handoffs were present in the same child rollout.
- The child invoked native execution for `19+23`; the sandboxed result was `42`,
  with no unsandboxed retry.
- First marker: `CERT_FIRST_OK` at 2026-09-19T04:11:00.039Z.
- Same-child follow-up: `CERT_SECOND_OK` at 2026-09-19T04:11:06.949Z.
- All three exact-route completions returned HTTP 200. The relay turns took the
  intended local `non_text_state` Sol Medium path, without a classifier call or
  provider failure.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-19T04:10:57.467Z | 3383 | 200 |
| 2026-09-19T04:11:00.043Z | 1677 | 200 |
| 2026-09-19T04:11:06.972Z | 3627 | 200 |

The machine-readable proof binds upstream base and reviewed contribution, the
compatibility patch, binary, private generated routes, canonical template, and
the deployed Router candidate. The sanitized reviewer record is
[`docs/history/2026-09-18-switchyard-review-cleanup-certification.json`](../../../docs/history/2026-09-18-switchyard-review-cleanup-certification.json).
No encrypted payload, conversation text, or thread identifier is retained.

## Limits

This is native CLI v2 evidence, not a desktop GUI WebSocket soak or an exhaustive
provider fault test. Shared app-tool, relay, catalog, and lifecycle regressions
remain covered by the offline suite. Refresh after any bound identity or contract
change.
