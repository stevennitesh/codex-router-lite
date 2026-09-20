# Switchyard native child routing delivery plan

Revision 3, completed 2026-09-20. G1 and G2 are accepted. The reviewed candidate
was deployed, passed the native four-turn acceptance sequence and was promoted
to v2.
Execution ownership and checkout state: [implementer handoff](2026-09-20-switchyard-child-routing-handoff-completed.md).

## Outcome and boundary

Make `switchyard/auto` classify a native child's opening assignment and later
assignments in that same child, so different work can select different native
models while preserving conversation, tools and v2 collaboration. Today encrypted
handoffs fall back to Sol. The plaintext transition test already demonstrated
working model transitions; it did not demonstrate encrypted-child classification.

Keep the native answer request encrypted and otherwise unchanged. Only a bounded
copy of the current assignment may go to Jev. Reuse Router's existing native
payload relay; do not build a decryptor, context summarizer, hook service, new
classifier, persistent task store, or routing framework. No model-policy tuning,
upstream repin, unrelated endpoint changes, or broad refactor belongs here.

The [design investigation](2026-09-20-switchyard-encrypted-handoff-design.md)
is supporting evidence, not an implemented contract. This plan owns delivery.
The [Switchyard specification](../../config/switchyard/README.md),
[security contract](../../SECURITY.md), and
[engineering contract](../agents/engineering-contract.md) remain current authority.

## Required behavior

- Classify only the current recognized task-bearing handoff. Never search older
  handoffs for substitute text. Plaintext user turns keep their existing path.
- Reuse existing account-scoped extraction, caching, coalescing and cancellation.
  Readable routed-parent assignments need no extraction request.
- Provide recovered text solely as request-local classifier input. The native
  answer receives its original encrypted input; projection fields never reach
  that upstream or appear in responses, logs or retained evidence.
- Accept no caller-authored classifier override. Router strips any reserved
  field before deriving its own value; Switchyard consumes it only over the
  authenticated local hop and removes it before preserving/decoding the answer.
- New assignments may change target. Tools and tool results inside an assignment
  retain its target without repeated extraction/classification. Compaction keeps
  its existing native bypass.
- Unrecognized or mixed-media envelopes, missing/malformed/oversized extraction,
  and projection-only errors retain the unchanged encrypted Sol fallback with
  no Jev request. Never manufacture partial task text or truncate it to fit.
  Caller cancellation aborts work. Existing external-route relay errors and
  native answer authentication/error handling remain unchanged.
- Projection is bounded by bytes and a finite deadline. The complete serialized
  Jev request must still fit its existing 32 KiB limit, including criteria and
  JSON overhead. Reuse that limit rather than introduce a second independent
  policy. Select the extraction deadline from the first checkpoint's evidence.
- Disclose that current delegated task text will reach OpenRouter/Jev. It can
  itself quote private files or prior context; exclusions of protocol history
  fields do not guarantee the assignment contains no sensitive information.
  Native credentials stay on native hops. No real private task is test material.

## Delivery approach

Use two checkpoints. The first can invalidate the mechanism before Rust patch
and deployment work; the second accepts the complete integrated outcome.
No extra dashboard, durable experiment runner, generalized metrics layer, or
large corpus is needed.

### G1 — Prove extraction before integration

Work in disposable `generated/` fixtures against the existing relay. Do not
deploy a candidate or change production routing. Use one fresh native parent and
child to obtain real synthetic encrypted opening and follow-up handoffs, rather
than invent ciphertext or scrape existing private conversations.

Use at most six authored assignments, two extraction observations per assignment:
ordinary bounded work; implementation; design review; Unicode/multiline text;
literal `Payload:` delimiters/quotes; and instruction-like text asking the relay
to change or ignore content. Retain expected plaintext independently of what the
parent/model says it sent. Compare extraction against that fixture, including
the native handoff boundary; a plaintext prompt to a mocked relay is insufficient.
Also exercise one repeat of the same encrypted item to observe cache reuse.

Record exact-match results, missing/altered fields, extraction latency and native
token usage. Time a small existing Jev decision on recovered synthetic text and
compare the added work with the previous direct/plaintext and Sol-fallback paths.
Do not infer dollars from token totals across different models or claim a savings
result without applicable pricing. No repeated prompt tuning to rescue failures.

Return a short sanitized result with source/runtime identities and a recommendation.
G1 passes only if tested extraction is faithful, the task boundary is unambiguous,
and the lead accepts a concrete bounded deadline and measured overhead for the
intended workflow. No numerical cost-saving promise is currently established.
Raise a material latency/cost tradeoff to the user; do not invent their tolerance.
If extraction is unreliable or not worthwhile, stop integration, retain current
Sol fallback, and report the supported parent-selected-model alternative. A
negative feasibility result completes the experiment, not the switching feature.

G1 is now mechanically demonstrated and independently reviewed. The
[sanitized evidence](2026-09-20-switchyard-child-routing-g1-evidence.json)
records six independent uncached extractions, all exact, plus six exact cache
replays. Uncached relay latency was 2.231–2.962 seconds (2.645-second median),
aggregate native relay usage was 1,511 tokens, and cached replay latency was
2–4 ms (2.5 ms median). The bounded plaintext Jev decision took 266 ms. The
user accepted automatic routing, this measured overhead, and a 5-second
extraction fallback deadline. These six short synthetic assignments were
124–249 UTF-8 bytes; the result is bounded evidence, not a statistical latency
guarantee or proof for arbitrary payloads, and it establishes no dollar cost.

The working fixture required `agent_type` to select the named role;
`task_name` only labels the child. In this Codex build, a child inherited the
parent provider even when its role named another provider, so the isolated test
parent used the observation provider and the child inherited it. That provider
arrangement is test instrumentation only. G2 works at Router's existing request
boundary and does not require a production parent-provider change or a Codex
platform change to capture encrypted child requests.

### G2 — Small integration and live acceptance

G1 has passed and its bounded overhead is accepted. After the separate G2
implementation dispatch:

1. In `src/router.mjs`, select the current task envelope and derive a bounded
   classifier-only projection using the existing relay. Avoid normalizing the
   entire input. Add only the helpers that isolate this actual responsibility.
2. Extend the canonical Switchyard compatibility patch at the authenticated
   request boundary and TypeSafe selector. Prefer one reserved local body field
   and request-local state. A private metadata entry is an implementation option,
   not a requirement: prove it cannot be logged/forwarded, or use one typed field.
   Do not retain it in raw request replay. Keep the existing upstream pin.
3. Add focused Router and Rust tests for the full produced handoff: current task
   only, spoofed field stripped, unchanged encrypted answer, zero-call fallback,
   deadline/cancellation, account separation, tool affinity and later reclassification.
   Cover recognized readable handoffs and reject ambiguous/media/control cases.
   Reuse existing relay tests for unchanged cache behavior rather than duplicate them.
4. Update README, SECURITY and the Switchyard specification at their owners.
   Build the locked source with the revised patch, update patch provenance, and
   run the maintenance guide's required Rust, Router and installed-catalog checks.
5. With commit/deployment/quota authority, commit the clean candidate and use the
   existing rollback-owning deployment transaction. Invalidate old v2 eligibility
   for the changed contract; use only the authorized provisional proof window
   described in the certification guide. No accepted proof may claim this binary
   before the new native run passes.
6. Repeat the four-turn native same-child test: extraction, implementation, review,
   implementation. Read actual selected targets and Jev decision records, not
   parent PASS text. Verify original facts and prior tool outputs, native sandbox
   execution, public model identity and successful streamed completions. Require
   at least two distinct targets and reclassification on new handoffs; keep the
   intended Luna/Sol/Astra/Sol sequence visible, but do not force it or tune the
   classifier to make the test pass. Explain any selection disagreement.
7. Run the full exact-route v2 checks, write sanitized proof bound to the deployed
   candidate, and run `npm run verify` plus current catalog validation. On failure
   restore a known-good generation or keep the candidate v1; never claim v2 from
   mocks or the earlier plaintext test. Retain rollback until acceptance passes.

G2 is the final whole-plan review, including G1 assumptions still relevant to
the final code. Include projection latency/tokens in the live result so switching
success cannot hide uneconomic overhead. Commit/push/deploy are separate effects;
the plan alone grants none of them. On completion, archive this plan/handoff as
history and retain only durable behavior in maintained guides.

## Final status

- G1: accepted. Six independent uncached extractions were exact; six cache
  replays were exact; the accepted extraction fallback deadline is 5 seconds.
- G2: accepted and deployed from Router commit
  `594cf484a863033a1f0f11c61a52fe3d1abf6e52`. The accepted native four-turn
  sequence selected Luna Max, Sol Medium, Astra Medium and Sol Medium; tool
  continuations retained affinity and each new assignment reclassified. The
  exact route passed all five v2 checks and the maintained live verifier.
- Projection relay latency and tokens could not be isolated from current
  sanitized deployed telemetry. The code enforces the accepted five-second
  wait; G1 remains a bounded observation and establishes no future token or
  latency guarantee.
