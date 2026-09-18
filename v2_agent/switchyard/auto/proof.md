# switchyard/auto v2 evidence

Accepted exact-route evidence for deployed Router
`6c0d16a6033c161437a8d26ce00d56820fd49e7f` and the four-target Switchyard
policy. Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol Medium parent using codex-cli 0.155.0-alpha.9.2 spawned
`router_switchyard_auto` with `fork_turns: none` in the normal workspace-write
sandbox. It waited for each child turn and sent the second request to the same
child before cleanup.

- Window: 2026-09-18T18:28:51.175Z through 2026-09-18T18:29:17.410Z.
- Two native inter-agent handoffs: 2026-09-18T18:28:51.175Z and
  2026-09-18T18:29:10.010Z.
- One native shell tool call ran `Write-Output (19+23)` and returned `42` in the
  default sandbox, without an unsandboxed retry.
- First marker: `CERT_FIRST_OK` at 2026-09-18T18:29:04.675Z.
- Same-child follow-up marker: `CERT_SECOND_OK` at
  2026-09-18T18:29:17.366Z.
- Parent cleanup occurred only after the second child turn completed; the native
  parent exited 0.
- The three exact-route Router completions succeeded with HTTP 200. Switchyard
  selected Luna Max for this bounded synthetic task and recorded no fallback,
  judge, parse, or HTTP failure.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-18T18:29:01.630Z | 10429 | 200 |
| 2026-09-18T18:29:04.674Z | 2014 | 200 |
| 2026-09-18T18:29:17.388Z | 7363 | 200 |

Evidence was reconciled against the exact parent and child rollout records,
native tool result, inter-agent metadata, redacted Router timings, deployed
manifest, and Switchyard provenance. Only sanitized summaries are recorded;
no encrypted payloads, private conversations, or thread identifiers are kept.

The runtime binding in `proof.json` records the deployed upstream commit, patch,
binary, generated-route, and Router candidate hashes.

## Limits

This is native CLI v2 evidence, not a desktop GUI WebSocket soak or an exhaustive
provider fault test. Shared app-tool, relay, catalog, and lifecycle regressions
remain covered by the offline suite. Refresh after any bound identity or contract
changes.
