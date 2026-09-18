# switchyard/auto v2 evidence

Status: accepted for the deployed Phase B Jev generation at Router commit
`7f707bb773aa083144904fa027ef331bd9a1c524`.

Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol Medium parent on codex-cli 0.155.0-alpha.9.2 spawned
`router_switchyard_auto` with `fork_turns: none` in the workspace-write sandbox
with automatic approval review. It waited for the first child turn to finish,
sent the second request to that same child, waited again, and cleaned up only
after the second turn had completed.

- Window: 2026-09-18T22:49:42.415Z through 2026-09-18T22:50:04.569Z.
- Two encrypted native handoffs were recorded in the child rollout.
- The child invoked the native execution tool for the synthetic calculation
  `19+23`; the sandboxed result was `42`, with no unsandboxed retry.
- First marker: `CERT_FIRST_OK` at 2026-09-18T22:49:54.438Z.
- Same-child follow-up marker: `CERT_SECOND_OK` at
  2026-09-18T22:50:02.190Z.
- Four exact-route Router completions succeeded with HTTP 200. Switchyard used
  Jev provider version `typesafe/jev-1.13-20260917`, selected Luna Max for this
  bounded task, and recorded no fallback in the certification window.

| Router completion (UTC) | Duration (ms) | Status |
| --- | ---: | ---: |
| 2026-09-18T22:49:47.468Z | 4596 | 200 |
| 2026-09-18T22:49:51.887Z | 3043 | 200 |
| 2026-09-18T22:49:54.452Z | 2540 | 200 |
| 2026-09-18T22:50:02.230Z | 2869 | 200 |

The machine-readable proof binds public upstream base `ee3715d1`, reviewed PR
head `92c84a0c`, both ordered patch hashes, binary hash, private generated-route
hash, frozen policy hash, and deployed Router candidate. The bounded reviewer
record is
[`docs/history/2026-09-18-switchyard-b3-certification.json`](../../../docs/history/2026-09-18-switchyard-b3-certification.json).
Only sanitized summaries and rollout hashes are retained; no encrypted payloads,
private conversations, or thread identifiers are copied into the repository.

## Limits

This is native CLI v2 evidence, not a desktop GUI WebSocket soak or an exhaustive
provider fault test. Shared app-tool, relay, catalog, and lifecycle regressions
remain covered by the offline suite. Refresh after any bound identity or contract
changes.
