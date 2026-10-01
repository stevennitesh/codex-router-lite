# Windows compatibility and rate-limit reset fix — 2026-10-01

Historical review and source integration; this is not deployed runtime acceptance.

The updated Windows Appx package is `26.928.3736.0`; its signed bundled CLI
remains `0.159.2`, and codex-app-tools remains `0.1.5`. The current catalog,
Router health and all 344 pre-change tests passed. No required app protocol
adaptation was identified. No fresh quota-consuming certification was run.

All ten original-Router commits after `84c6e1ba` through `1e209887` were
dispositioned in `maintenance/upstream-router.json`. Periodic catalog refresh
was already covered. macOS discovery, ClinePass envelopes and UI dependency
updates were excluded. The upstream reset-bound fix `753a18de` was adapted to
the retained `retryAfterSeconds` owner, without importing upstream quota state.

Before the fix, synthetic `Retry-After: 1e20` produced a routed HTTP 429 message
requesting an approximately 100 quadrillion second wait. Reset parsing now checks
the resulting timestamp against Date's range after numeric conversion and
duration addition. Invalid values produce ordinary unknown-delay guidance;
valid headers retain their existing meaning. The provider's original header
and HTTP 429 status remain unchanged.

Regression cases cover seconds, durations, epoch seconds/milliseconds, HTTP
dates, missing/invalid headers, numeric/component overflow and the exact Date
boundary. A local Router/gateway test verifies the produced 429 response for
ordinary and impossible values. The invalid-value, Date-boundary and Router
response tests failed on the previous implementation before the guard was added.

## Source verification

- `npm run check`: dependency lock, product boundary, v2 applications and syntax passed.
- Narrow regression: all four new tests passed after the fix.
- Full `npm test`: 346 passed, zero failures; two Windows managed-startup tests
  skipped because the sandbox could not inspect process command lines.
- Those two startup tests passed in a separate supported escalated run using
  isolated fixture services. All 348 tests were therefore exercised successfully.
- Current signed CLI `0.159.2` catalog: 15 models parsed; GLM, Pareto and
  Switchyard compatibility passed.
- `git diff --check` passed; reviewed upstream head has no pending commits beyond
  the new recorded baseline at the time of integration.

## Switchyard disposition and scope

Switchyard's four new commits through `47bba06c` concern Anthropic thinking,
new decision protocol types, advisor error redaction and escalation evidence.
The configured TypeSafe/native Responses routes do not require these changes.
Both ordered patches applied to the new upstream head, but no rebuild or pin
advance was warranted. The existing `fbabf51c` pin is retained.

This integration does not deploy, restart, consume provider quota, or renew
runtime-bound certification evidence.
