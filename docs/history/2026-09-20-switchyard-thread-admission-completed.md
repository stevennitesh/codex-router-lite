# Switchyard failed-projection correction and release

Completed 2026-09-20 in Router 0.7.0. Candidate commit
`0cf7625d50b7f05822ca0eb3687dd82fea14232a` corrects current app-thread
admission when a recognized delegation projection was attempted but produced no
safe text.

## Change

The locked Switchyard patch now treats the existing projection-attempt marker
as authoritative before ordinary classifier input is chosen. A recognized
current assignment with a null or rejected projection releases old affinity and
takes the existing `non_text_state` Sol fallback without calling Jev. A valid
projection classifies only its projected text. Requests without an attempted
projection and ordinary call-linked tool continuations keep their established
behavior.

Admission remains limited to the Codex app namespace and supported app-thread
delivery functions. Source and receiver task identifiers must be valid strings,
call-linked outputs remain ordinary tool history, private projection fields are
removed before upstream delivery, and the host final-item contract establishes
currentness when item metadata is absent.

## Verification

The real Rust server regression exercised the locked decoder, affinity and
TypeSafe classifier with exact producer-shaped unpaired function outputs. The
old classifier selected the retained non-Sol model; the correction selected Sol
with zero provider calls. Valid and malformed delegation envelopes, older user
history, ordinary continuation affinity, encrypted child input and private-field
removal were covered.

Formatting, clippy, locked package tests, release build, focused Router tests,
the full Router verification suite and CI passed. The deployed binary SHA-256 is
`e68f40edb014cacd0bcdec781d41bc7bb537a65a25c08daf569a11f9833a5876`;
the canonical patch SHA-256 is
`6ddc87abe19cf709b3b548304b27b683420323a18fab0bc753bbe627c7b28bad`.

The maintained deployment transaction installed the exact candidate and kept
both runtime and Router rollback generations. A real Windows Codex task then
received successive synthetic app-thread messages. It selected Luna Max for the
simple current request, Astra XHigh for the complex request and Luna Max for the
later simple replay request. Tool work inside the complex turn stayed on Astra
without another classifier decision. This demonstrates current-message routing,
two targets on one task, call-linked affinity and resistance to old delegation
replay on the actual app surface.

The maintained live verifier passed with evidence digest
`ab5241a63fc1746f5f5f5b126d8b7ed4a95e79d934c8945422653d3c5a1d8a74`.
A fresh native parent then completed the five required v2 checks through one
`router_switchyard_auto` child and its same-child follow-up. The accepted
application is [the v2 proof](../../v2_agent/switchyard/auto/proof.md), and the
sanitized release evidence is
[recorded separately](2026-09-20-switchyard-thread-admission-release.json).

## Boundaries

The JavaScript mock tests simulate affinity and are not Rust integration. The
Rust provider is a controlled stub rather than live Jev. The app and native-child
runs supply the deployed Windows evidence. These are bounded synthetic checks,
not a desktop UI soak, broad provider evaluation or private conversation replay.
