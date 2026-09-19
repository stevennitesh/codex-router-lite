# switchyard/auto v2 certification

Accepted for Router 0.6.1 deployed from
`849941ac4834e45b90820f7f06d84ca954962492`.
The machine-readable proof binds the exact Switchyard source, ordered patches,
binary, private generated routes, template and deployed Router commit.
Procedure: [certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Sol parent on codex-cli 0.155.0-alpha.9.2 spawned
`router_switchyard_auto` without inherited conversation. The child used the
workspace-write sandbox and native PowerShell to compute `19+23`, returning
`42` with exit code zero. No unsandboxed retry was used.

- Two encrypted native handoffs: 2026-09-19T21:21:08.597Z and 21:21:23.508Z.
- First marker: `CERT_FIRST_OK` at 21:21:16.807Z.
- Same-child follow-up marker: `CERT_SECOND_OK` at 21:21:25.275Z.
- All three Router completions returned HTTP 200, taking 4611, 2337 and 1790 ms.
- All three native child requests selected Sol Medium.
- Native lifecycle instructions triggered cleanup after the first completed
  turn. Its result confirmed completion before the same child was resumed;
  there was no active-turn cancellation. Final cleanup followed the second turn.

The live verifier also passed its ordinary tool round trip, media fallback,
priority and compaction checks against the installed release. See the
[sanitized historical record](../../../docs/history/2026-09-19-switchyard-v061-certification.json).
No encrypted payload, private conversation, thread identifier or credential is
retained in the checked-in evidence.

## Limits

This is native CLI v2 evidence, not a desktop GUI WebSocket soak or exhaustive
provider fault testing. Other routes were not recertified by this run. Refresh
after any bound identity or collaboration contract changes.
