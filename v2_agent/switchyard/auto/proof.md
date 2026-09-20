# switchyard/auto v2 certification

Accepted exact-route evidence for deployed Router
`0cf7625d50b7f05822ca0eb3687dd82fea14232a` and Router 0.7.0. Procedure:
[certification](../../../docs/SUBAGENT-CERTIFICATION.md).

## Evidence

A fresh native Windows Codex task running Sol Medium spawned one isolated
`router_switchyard_auto` child and reused that child for the second assignment.
The first child turn used native PowerShell to compute `19+23`, returned `42`
with exit code 0, then returned `CERT_FIRST_OK`. The same child returned
`CERT_SECOND_OK` without tools on its next turn. The parent cleaned up only
after the completed second turn.

The accepted window was 2026-09-20T21:17:58.966Z through
2026-09-20T21:18:15.228Z. It contained two classifier decisions, three
successful Router completions, two encrypted handoffs, both requested markers,
and one successful native tool call. The three `switchyard/auto` completions
took 7,701 ms, 1,808 ms and 5,623 ms and all returned HTTP 200. Both assignments
selected Luna Max; the tool continuation retained the selected target without a
new classification.

The maintained live verifier separately passed ordinary tool affinity, non-text
fallback with zero Jev calls, media handling and compaction bypass.
Its sanitized evidence digest is
`ab5241a63fc1746f5f5b126d8b7ed4a95e79d934c8945422653d3c5a1d8a74`.
The real app-thread exercise used the actual `create_thread` and
`send_message_to_thread` surface and observed exact unpaired `codex_app`
function outputs. On one task, current messages selected Luna Max, Astra XHigh
and then Luna Max; the complex turn's call-linked tool work stayed on Astra
without reclassification.

The proof binds the locked Switchyard source, reviewed contribution, ordered
compatibility patch, deployed binary, private generated routes, templates and
the candidate Router commit. Checked-in evidence contains no payload text,
credential or task identifier.

## Limits

This is one synthetic Windows desktop-native certification run, not a manual UI
soak, statistical routing study or provider fault campaign. The app-thread test
and native collaboration proof used separate fresh tasks. Other v2 routes were
not recertified. Refresh this proof after any bound identity or collaboration
contract changes.
