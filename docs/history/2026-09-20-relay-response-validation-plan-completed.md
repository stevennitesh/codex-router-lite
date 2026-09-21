Historical completed plan. The interim status and pending-release statements below
are retained as planning history, not current authority. Delivery and four-route
acceptance completed in the [release record](2026-09-20-relay-release.md).

# Relay response validation and safe local errors

Delivery plan, 2026-09-20. Status: RV1 source candidate implemented and verified;
deployment acceptance remains pending.
Comparison baseline: `e598bbbc4b1ad18c193b2ffea61f7a07e2540f37`.

## Outcome and scope

Only successfully completed, unambiguously identified native relay output may
become task text or enter the extraction cache. Malformed request text must not
reach Router logs or error responses. Known local validation failures should
expose stable, safe diagnostic codes at the existing HTTP boundaries.

Source inspection confirms early acceptance of relay arguments without terminal
success, permissive unbound argument matching, and JSON parser messages embedded
in logged errors. These are existing validation defects, not reasons to revert
deterministic Sol selection or change Jev policy.

Keep the existing relay, HTTP utilities, request preparation and forwarder owners.
Do not add retries, models, parser frameworks, exception hierarchies, new public
endpoints, classifier changes or a general provider-error normalization layer.
Preserve extraction bounds, deadlines, account isolation, cancellation, cache
limits and successful continuation behavior.

## Required behavior

### Relay acceptance

- JSON responses require completed response status and exactly one unambiguous
  expected `relay_external_agent_payload` function call with valid payload arguments.
- SSE extraction requires successful terminal completion. Failed, incomplete,
  error-terminated or truncated responses cannot contribute successful task text,
  even when earlier arguments were parseable. Inspect the entire buffered response;
  do not return on argument completion alone.
- Prefer final output from the completed response. Reject ambiguous relay calls,
  conflicting identities and unrelated arguments. Do not require earlier item
  events when the successful terminal output itself establishes the expected call.
- Keep delta reconstruction only if a supported producer demonstrably needs it;
  it must bind to an established expected call and still require terminal success.
  Never concatenate arguments across calls. Existing permissive fixtures alone
  are not evidence that an alternate producer format must be supported.
- Failed extraction never enters the success cache. A repeated identical request
  after failure must be able to extract successfully from a fresh relay response.
- Preserve caller behavior: Switchyard uses null projection and zero-Jev fallback;
  external normalization returns a controlled error and does not send partial
  extracted text to the provider.

### Safe local errors

- Invalid JSON produces a fixed safe message, HTTP 400 and
  `invalid_request_json`; do not preserve the parser exception as a cause.
- Keep non-object JSON validation explicit and safe; do not expose input values.
- Use existing HTTP utilities for known Router-owned validation errors, including
  unsupported tool choice, unsupported response format and unsupported search.
  `code` is the stable discriminator. Preserve existing `type` values where
  changing them could break callers; document the compatibility convention.
- Only explicitly safe local validation messages may be returned. An arbitrary
  thrown error having a code is not permission to expose its message.
- Preserve upstream error passthrough and existing post-header SSE/WebSocket
  terminal-failure semantics. Do not change global diagnostic logging merely to
  hide the parsing-boundary defect.

### Maintained reference corrections

- Replace README's active-v2 claim with a durable pointer to current route
  configuration and matching accepted/draft applications. Keep all four currently
  provisional routes provisional until deployed evidence is renewed.
- Add a compact boundary table to `docs/agents/architecture.md`: supported public
  methods/paths, authentication and identities; private Switchyard and forwarder
  hops; WebSocket re-entry and local error semantics. Confirm paths from dispatch,
  including the distinction between public Responses and internal chat translation.
- Add the identity glossary there: public slug, gatewayModel, upstreamModel,
  requestProfile and transport. Avoid duplicating it in other guides.
- Add one short, source-accurate request-preparation example showing the returned
  bundle and preservation of its namespace context for response restoration.
  Add concise JSDoc only where it clarifies that existing interface.

## Delivery approach and acceptance

One implementation slice and one final integrated review are sufficient. No
intermediate design gate is needed for these existing-owner fixes.

1. Reproduce the reported failures through repository tests and trace the ordinary
   callers. The feedback's external reproduction links are unavailable; rebuild
   the cases against the actual Router rather than copying extracted functions.
2. Correct relay acceptance and malformed-body handling, then reconcile known
   validation-error codes at the front Router and internal forwarder.
3. Update the existing references and focused regressions.
4. Final gate **RV1**: review the full diff against the baseline and run
   `npm run verify`, current catalog compatibility and application validation.

RV1 evidence must cover:

- Successful JSON and SSE extraction, plus arguments followed by failed/incomplete
  terminal responses, EOF without success, unbound/wrong-tool arguments, multiple
  expected calls, identity conflicts, and malformed arguments.
- Failure then success for the same encrypted input proves failures are not cached;
  subsequent success reuse still works. Assert native/provider call counts and
  observable caller results, not only isolated parser output.
- Switchyard rejected extraction reaches null projection without Jev submission;
  reuse unchanged real classifier null-projection evidence where valid. External
  rejection does not forward partial task text.
- A real malformed HTTP request containing a synthetic private marker returns 400
  with the stable code; neither response nor captured Router logs contains the
  marker or an input excerpt. Include non-object JSON controls.
- Equivalent known validation failures retain status and stable codes through
  front Router and internal forwarder. Existing streamed-error and native tests
  remain green. Do not reinterpret provider errors as local validation failures.

Source tests cannot prove the stricter parser accepts the current native producer.
Before deployment acceptance, run a fresh synthetic encrypted-child extraction
against the candidate, then tool/continuation checks and exact-route renewals for
all four affected routes. Preserve the previous relay-selection plan's outstanding
release obligations; validate both changes together on one deployed candidate.
No Rust rebuild is needed unless the Switchyard lock or patches change.

Commit, push, installed replacement/restart and live quota-consuming certification
remain separate release actions. Retain rollback and bind proofs to the actual
candidate. Do not restore v2 flags from source tests or create a new public release.

## RV1 source evidence

Implemented against baseline `e598bbbc4b1ad18c193b2ffea61f7a07e2540f37`.
Repository integration tests cover completed JSON and SSE relay output; failed,
incomplete, truncated, unbound, wrong-tool, ambiguous, identity-conflicting and
malformed relay results, including missing identities and independent `id` / `call_id`
binding; failure-then-success cache behavior; external forwarding suppression;
Switchyard null projection after parseable arguments followed by failed or incomplete
terminals; safe malformed JSON and non-object bodies;
and equivalent front-Router/internal-forwarder validation codes. Existing streamed
failure, cancellation and native routing tests remain green.

Source checks completed on 2026-09-20:

- `npm run verify` (259 tests passed)
- `node scripts/check-codex-catalog-compat.mjs <current-codex>` (`codex-cli
  0.155.0-alpha.9.2`; 13 current-schema models; GLM, Pareto and Switchyard passed)
- `node scripts/check-v2-agent-applications.mjs` (5 applications valid)
- `git diff --check`

These checks do not prove that the current native producer emits the stricter
accepted shape. Fresh encrypted-child extraction, continuation/tool checks,
exact-route renewal for all four provisional routes, installed hashes, health and
rollback evidence remain required on the actual deployed candidate. No commit,
push, deployment, paid live test or certification promotion was performed in RV1.
