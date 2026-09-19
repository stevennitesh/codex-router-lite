# switchyard/auto v2 certification

Accepted for deployed Router
`aad244c62549b99c3bb554c35ed29b9bcb085d67`, compatibility patch
`6902a7e93e7ac7f1b75d31f5985fe4a078a733e06270455785f8ef1a244dd9de`,
and binary
`e704c624276bd15f805353fd61d7e733790868078a1a84ce555d24d7f96476ee`.
The machine-readable proof binds the upstream source, reviewed contribution,
private generated routes, deployed template bytes, canonical template source,
and deployed Router candidate.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol parent on codex-cli 0.155.0-alpha.9.2 spawned
`router_switchyard_auto` with no inherited conversation in the workspace-write
sandbox with automatic approval review. It waited for the first child turn,
sent the second request to that same child, waited again, and cleaned up only
after completion.

- Window: 2026-09-19T15:28:01.494Z through 2026-09-19T15:28:42.847Z.
- Two encrypted native handoffs were observed, with no interrupt between markers.
- The child invoked native PowerShell execution for `19+23`; the sandboxed
  command exited zero in 40 ms and returned `42`, with no unsandboxed retry.
- First marker: `CERT_FIRST_OK` at 2026-09-19T15:28:30.340Z.
- Same-child follow-up: `CERT_SECOND_OK` at 2026-09-19T15:28:42.847Z.
- All three exact-route completions returned HTTP 200. The relay turns took the
  intended local `non_text_state` Sol Medium path, without a classifier call or
  provider failure.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-19T15:28:25.281Z | 23791 | 200 |
| 2026-09-19T15:28:30.340Z | 4426 | 200 |
| 2026-09-19T15:28:42.847Z | 6493 | 200 |

The sanitized reviewer record is
[`docs/history/2026-09-19-switchyard-call-affinity-certification.json`](../../../docs/history/2026-09-19-switchyard-call-affinity-certification.json).
The live verifier and bounded Router evidence are linked there. No encrypted
payload, conversation text, thread identifier, or credential is retained.

## Limits

This is native CLI v2 evidence, not a desktop GUI WebSocket soak or an exhaustive
provider fault test. Shared app-tool, relay, catalog, and lifecycle regressions
remain covered by the offline suite. Refresh after any bound identity or contract
change.
