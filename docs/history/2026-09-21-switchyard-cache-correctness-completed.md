# Switchyard cache correctness and transition measurement

2026-09-21. Revision 1. Delivery completed and accepted after one C2 repair
round; comparison base
`64ee4b8658eeb3f42e80d14f7cfd1baa9eed706e`, initially clean `main`.

## Purpose and decisions

Make valid native tool discovery survive Router's response guards, preserve
provider-reported cache counters, and measure model transitions without mistaking
lower model prices for lower completed-task cost. This delivery repairs demonstrated
correctness gaps and adds a bounded observation path; it does not change serving
policy in response to hypothetical savings.

Current authority remains [architecture](../agents/architecture.md),
[Switchyard](../../config/switchyard/README.md), [runtime diagnostics](../../config/switchyard/runtime.md),
and [security](../../SECURITY.md). The supplied review identifies a real
`tool_search_call` guard gap, missing cache-write normalization, and an exact-HEAD
Node 24 failure at a diagnostic assertion. Its price arithmetic is illustrative,
not observed subscription consumption or proof of a useful switching threshold.

Keep four choices, user-turn classification, tool-loop affinity, Sol fallback,
the confidence gate, caller service tier, explicit providers, and existing
authentication/compaction contracts. Defer a switching-cost rule, prewarming,
configuration-update injection, new candidate pairs, live shadow routing, and
agent pools. The existing input-fidelity test proves extraction through its test
route, not production affinity, cache reuse, or economic outcomes.

## Required behavior

1. Recognize explicitly supported actionable native tool output, including restored
   client-side `tool_search_call`, without a broad `*_call` escape. Prove the ordinary
   declaration, provider call, namespace restoration, completion guard, and
   tool-result continuation chain. Preserve rejection of genuinely empty output.
2. Wait for the exact expected structured stress-test diagnostic within the existing
   bounded deadline. Keep the identity/content assertions and privacy checks. If
   the diagnostic still fails, investigate its producer rather than adding sleeps.
3. Preserve optional provider-reported cache writes alongside reads in Node usage
   normalization, observation and retry aggregation. Absent/null/invalid values
   must not become observed zero. Do not infer writes from uncached input, add
   reasoning to output, or mix compaction estimates into reported economics.
   Aggregates over partly missing attempts must disclose incomplete coverage.
4. Verify actual native Responses decoding through patched Switchyard usage and
   its routing logger, using input=12000, reads=8000, writes=4000, output=100.
   Total input must remain 12000 and total usage 12100. Include zero and absent
   writes and the streaming path. Correct a proven mapping defect at its owner;
   if the canonical patch changes, update its lock hash and affected source tests.
   Preserve historical log semantics rather than reinterpreting old zeros.
5. Add attributable observations at the actual native send/attempt boundary using
   existing request state and log/report entry points. Observe native answering
   requests once; outer Switchyard facades are not additional answer attempts.
   Keep extraction/classifier/unassociated observations separate. Report selected
   native model and effort, requested/returned tier when available, reported
   input/reads/writes/output, outcome and elapsed time. Unknown metadata stays
   unknown; sent model is not proof of a returned provider model.
6. Associate related observations by an explicit local identity, never timestamp
   proximity. Use opt-in diagnostics, bounded process-local association state and
   generation-local ordinals; no raw session/account/request IDs, prompt/tool
   content, credentials or reusable content fingerprints in emitted records.
   Missing or ambiguous conversation identity (including overlapping turns) must
   not produce a falsely ordered transition. Restarts/eviction end association.
   No database, persistent prompt store, new service or dashboard.
7. Extend existing reporting with transition counts and observed usage for the
   explicitly attributable records. Keep historical partial `routing.jsonl`
   reporting separate. Compute read share from sums over records with both
   counters, report that cohort/coverage, and never substitute zero for missing
   denominators. Transitions describe observations, not causal cost or task success.
8. Regression-check prefix stability at existing request-preparation owners:
   earlier messages, tool declarations/order and IDs, intentional cache keys,
   and supported cache options survive repeated requests. No prompt rewriting,
   forced speed, stored-response references or global explicit-cache mode is added.

## Delivery and review gates

**C1 — Correctness and counter semantics.** Implement items 1–4, inspect the exact
CI failure, and prove the cross-layer numeric contract. This checkpoint prevents
building transition reports on misunderstood normalized token categories. Return
the candidate with focused Node tests, real locked-source Rust mapping evidence,
and the Node 24 stress test repeated after correcting its synchronization. If a
Switchyard patch change is necessary, include canonical patch/hash consistency
and relevant Rust checks. Do not implement an unrelated upstream repin.

**C2 — Observation and bounded cache experiment, then final integration.** After
C1 review, implement items 5–8, extend maintained owner documentation, and run
the controlled experiment below. Reuse existing report/evaluation machinery;
add a small native-boundary helper only where ownership warrants it. Required
offline tests distinguish interleaved sessions, retries, failed/cancelled/incomplete
attempts, absent writes, tier/effort differences, compaction presence versus
unknown state, resets, and hostile metadata. Keep all response transport intact.
Run `npm run verify`, the relevant Node 22.19/24 checks, package/product checks,
and final whole-diff review against the starting base. Archive this completed
delivery under `docs/history/` only after acceptance, retaining limitations and
leaving operational instructions with maintained owners.

## Controlled experiment

Use only newly authored synthetic content and the existing native account. No
private session replay or additional Jev egress. Temporary candidate processes
and loopback fixtures may run with protected ephemeral state; do not replace or
restart installed services. Native requests consume quota: cap this experiment
at 28 answer requests (two repetitions of the six sequences below), with a stable
bounded synthetic prefix, small deterministic requested answers, explicit standard
tier, identical tool/instruction/history bytes except each deliberate change,
and per-request timeouts. A request failure counts toward the cap; no unbounded
retry. Keep all payloads/credentials out of tracked evidence and clean up processes.

- Sol -> Sol; Astra Medium -> Astra Medium.
- Astra Medium -> Astra XHigh.
- Astra -> Sol -> Sol; Astra -> Sol -> Astra.
- Same model with one controlled tool/instruction change.

Use the actual Router/native send path; verify Switchyard forwarding and usage
mapping through the actual candidate path with deterministic fixtures, and use
an isolated Switchyard candidate for live sequences if fixed target selection
can be achieved without changing production contracts. Explicitly name which
paths each proof exercises; do not call direct-native evidence full-stack Jev
policy validation. Capture reported counters, latency, outcome, returned model/
tier where present, and whether the expected answer was produced. Cache writes
or diagnostics absent on the subscription backend remain unavailable.

The existing public API documentation supports inclusive input accounting and
cache diagnostics, but does not establish native-backend support. An optional
comparison-response diagnostic may be tried only within the synthetic budget;
do not ship automatic injection or treat missing diagnostics as a miss. Do not
run `configuration_update` or change cache modes in this delivery.

This experiment establishes transport observations under controlled conditions,
not general task-quality equivalence or account-dollar savings. An unknown or
inconclusive cache result is valid evidence, not grounds to fabricate a warm/cold
label or continue spending. A serving-policy change requires a subsequent bounded
whole-task comparison with verification, corrections and complete usage coverage.

## Publication and runtime boundary

No commit, push, installed deployment or certification is part of this request.
Source eligibility is already draft/v1 from the pending terminal fix; do not
promote it based on these tests. Update durable docs for actual delivered behavior.
Do not add a cost engine, pricing registry or production switching gate.

## Progress

C1 passed lead review on 2026-09-21. Tool discovery survives both response shapes
and the continuation fixture; optional writes and incomplete retry coverage are
preserved. Full verification: 308 passed, two intentional skips. The diagnostic
race repair passed ten local Node 24.13 stress runs; the failed hosted job used
24.20. The actual locked-source Rust regression proved inclusive input and both
zero/absent writes through buffered/streaming decoding and the routing logger.
Rust production mapping required no change; the canonical patch gains that
regression plus the C2 one-way native-attempt marker (final SHA-256
`dc6550f08a2c6ca4996bb4347f1f36a8b1d28416b608bcc1d18a6841aefcba83`).
Historical logger zeros remain ambiguous. No C1 correction round was needed.

C2 passed lead review after one repair round; the final integrated code review
reported no remaining findings. Opt-in native-attempt
records now originate at the selected native send boundary. A one-way marker
derived from the ephemeral Switchyard generation capability identifies that
callback; Router consumes it before OpenAI. Bounded process-local association
uses explicit session identity internally and emits only generation-local
ordinals. Missing/conflicting identity, overlap, restart and eviction break
ordering. Direct native traffic, compaction, classification and the outer
Switchyard facade are excluded. Provider counters retain field presence and
stay separate from compaction estimates; retries are individual attempts.

The existing usage report now keeps these latest-generation observations apart
from historical `routing.jsonl`, counts explicit model/effort/tier transitions,
and reports destination-attempt usage, read-share and latency coverage for each
transition. Cached input above input is invalid ratio coverage; returned-tier
availability and known/unknown compaction-item metadata remain explicit. Missing
request or attempt ordinals cannot bridge transitions, and a write failure
disables the optional observer for that process. Offline coverage includes the
actual Router boundary, repeated prefix
and tool identity, missing/invalid counters, explicit zero, incomplete,
cancellation, transport/retry outcomes, hostile metadata, interleaving,
overlap resets and generation resets. The fresh exact-source ordered patch
replay passed formatting, the marker-forwarding server regression and the C1
inclusive-usage streaming/buffered regression.

An independent read-only attribution fixture interleaved two associations with
a destination retry. It derived exactly `Sol -> Astra` and `Astra -> Sol`; the
destination buckets contained two attempts and one attempt respectively, with
no cross-association attribution.

The bounded live experiment used isolated fixed-target Switchyard passthrough
routes, the candidate Router/native path, no Jev calls, no retries and exactly
28 answer requests. All 28 completed with the exact requested answer and all 28
had attributable observations. The provider reported 109,376 input tokens,
30,720 cached input tokens, 168 output tokens and explicit zero cache-write
tokens on every attempt; the complete 28-record read-share cohort was
0.280866003510825. Both Sol-to-Sol repetitions read 3,840 cached tokens on the
second request. Astra Medium-to-Astra Medium read zero then 3,840 across the two
repetitions. Astra Medium-to-Astra XHigh read zero in both repetitions, returning
to Astra after Sol read 3,840 in both repetitions, and the controlled
instruction/tool-description change read zero in both repetitions. The shared
synthetic prefix permits reuse across sequence boundaries, so other cross-model
observations are inconclusive and no causal cache, task-cost or serving-policy
claim follows. Each request repeated the same fixed history rather than appending
conversation turns, so this does not establish growing-conversation cache
behavior. The controlled-change sequence changed both instructions and the tool
description, so it does not isolate either field. Sanitized per-request evidence
is archived beside this record. The one-off live runner was removed after review;
the safe reproduction contract is archived beside the evidence.

Final checks after correction round 1: Node 24.13 `npm run verify` passed 317
tests with two intentional skips; the affected Node 22.19 suite passed all 39
tests. The production dependency audit and current Codex 0.155.0-alpha.9.2
catalog compatibility passed. No installed runtime, service, configuration,
trust store, policy, deployment, certification, commit or remote was changed.

References: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).
