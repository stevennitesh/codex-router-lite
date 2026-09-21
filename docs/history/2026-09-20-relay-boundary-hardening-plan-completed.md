Historical completed plan. The interim status and pending-release statements below
are retained as planning history, not current authority. Delivery and four-route
acceptance completed in the [release record](2026-09-20-relay-release.md).

# Relay boundary hardening

2026-09-20. Baseline: `097dea8f4afb46622e2dc01b024c224544feedae`.
Status: RB1 source candidate implemented and verified; integrated review pending.

## Contract

Finish malformed-input handling without changing routing architecture. Preserve
the accepted completion/identity validation, deterministic relay model selection,
cache isolation, bounded reads, cancellation and safe-error disclosure rules.

1. Decode bounded native relay response bytes with fatal UTF-8 validation for both
   JSON and SSE. Corrupted encoding must fail extraction, not alter task text.
2. Consume only blank-line-terminated SSE events. An unfinished completion cannot
   establish success. Reject malformed JSON-bearing data frames; allow comments
   and harmless keepalives. Reject substantive unfinished trailing data rather
   than allowing it to conceal an error after completion. Preserve LF/CRLF framing
   and ordinary successful final-output behavior; use the existing owner rather
   than adding an SSE framework.
3. Reject duplicate/ambiguous payload properties using the existing JSON ambiguity
   validator where suitable, including escaped duplicate keys. Preserve legitimate
   Unicode and escaped text. Do not build another JSON parser. Validate original
   JSON text before information is lost through JSON.parse where relevant.
4. Preserve request-size rejection as HTTP 413 with a safe fixed message and stable
   `request_body_too_large` code at the internal forwarder and ordinary Router.
   Message disclosure and status selection are separate decisions. Keep arbitrary
   exception messages private and existing bounded body-draining behavior intact.
5. Correct the architecture guide in place: endpoint dispatch is conditional on
   model capability/native-session requirements; Switchyard gatewayModel selects
   the classifier route, not the answer target. Explain routing_id and illustrate
   public slug -> gateway route -> candidate -> target routing_id -> native model
   and effort. The facade's upstreamModel is not every answer's actual model.

No new routing policies, fallback models, framework, context document hierarchy,
Rust changes, eligibility promotion or upstream repin are included.

## Delivery and evidence

One source implementation slice, followed by integrated review against the baseline
(gate RB1). Implement in existing Router/HTTP helpers and architecture guide.
Add regressions through the actual Router/forwarder paths:

- Valid completed JSON/SSE, Unicode payloads, comments, keepalives, LF and CRLF.
- Invalid UTF-8 in JSON and SSE; unterminated completion; valid completion followed
  by malformed error data; duplicate payload keys including escaped equivalents.
- Rejections do not reach the external provider or populate successful extraction
  cache; rejected Switchyard extraction remains null projection. Reuse prior
  failure/cache tests where they cover the unchanged integration.
- A bounded oversized HTTP request reaches each local boundary and returns 413
  with the stable code, without marker leakage or provider traffic; malformed JSON
  remains 400. Use small isolated fixture limits, never production changes.

Run affected tests, `npm run verify`, current catalog and application checks.
Review the complete accumulated diff; report test scope and any producer assumptions.
Use a final-only review and keep the change small.

## Remaining release acceptance

All four affected source applications remain v1/draft. Combine this candidate with
the existing relay-selection and response-validation release obligations: fresh
synthetic native extraction, tools/continuations, deployed identities and exact-route
renewals. Source tests do not prove the native producer's current wire format.
Commit/push, runtime replacement/restart and quota-consuming live certification
remain separate release actions. Retain rollback and promote only passing routes.
No new public release or tag is included.

## RB1 source evidence

Implemented against baseline `097dea8f4afb46622e2dc01b024c224544feedae`.
The native relay now decodes its bounded response once with fatal UTF-8 handling,
validates original JSON before parsing, rejects duplicate decoded property names,
and accepts only blank-line-terminated SSE events. Comments, empty keepalives,
LF/CRLF framing, Unicode and escaped payload text remain accepted; malformed JSON
data and substantive unfinished tails invalidate the complete extraction. The
existing success cache is still populated only after all validation succeeds.

`readRequestBody` retains its bounded drain behavior and now creates the fixed
safe 413 error `request_body_too_large`. Router and the authenticated internal
forwarder preserve that status and code while withholding caller bytes and
preventing provider traffic. Malformed JSON remains a distinct 400.

Source checks completed on 2026-09-20:

- Focused Router/forwarder integration tests (23 passed)
- `npm run verify` (260 tests passed)
- Current catalog compatibility (`codex-cli 0.155.0-alpha.9.2`; 13
  current-schema models; GLM, Pareto and Switchyard passed)
- `node scripts/check-v2-agent-applications.mjs` (5 applications valid)
- `git diff --check`

The checked fixtures prove the accepted JSON and SSE shapes through the actual
Router and forwarder paths. They do not prove the current native producer still
emits those shapes. The deployment-bound extraction, continuation, installed
identity and exact-route obligations below therefore remain pending.
