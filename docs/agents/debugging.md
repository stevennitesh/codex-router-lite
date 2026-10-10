# Debugging Router behavior

Read [architecture](architecture.md) if the request path is unfamiliar. For service
startup, health, permissions or rollback begin with [troubleshooting](../TROUBLESHOOTING.md).
For installed app/CLI or upstream drift use [compatibility maintenance](compatibility-maintenance.md).
Routine wire diagnosis does not require an upstream refresh or deployment.

## Locate the first divergence

Identify the exact slug/endpoint, current source and installed generation, caller
(desktop, CLI, child), transport, and whether this is an ordinary turn, replay,
compaction or cancellation. Read configured paths from `src/paths.mjs`; source
checkout success is not proof about a different installed generation.

Start with redacted `model-router.ps1 codex doctor` once (`status` is its alias). Inspect only the
relevant time window in Router timings or a user-authorized conversation log.
Distinguish provider failure, client cancellation, sandbox restrictions and app
hydration from Router defects. Do not export an existing conversation merely to
reproduce an error; prefer a minimal synthetic reproduction.

Compare the native input, prepared provider payload, provider event order and
restored native output. Preserve call IDs, namespace/name pairs, terminal status
and HTTP status in sanitized evidence. Locate the earliest violated contract:

| Symptom | First source and next guide |
| --- | --- |
| Missing model, effort or deferred tools | `src/catalog.mjs`, route JSON; [native Codex](native-codex.md) |
| HTTP 400, tool choice or replay rejected | `src/routed-request.mjs`, `src/openrouter-request.mjs`; [preparation](request-preparation.md), then the endpoint guide |
| Wrong/missing tool or custom arguments | `src/namespace-relay.mjs`; compare declaration, produced call and replay identity together |
| Missing/duplicate stream events | `src/zai-responses-compat.mjs` for GLM; `src/sse-framing.mjs` for shared CR/LF boundaries; generic relay, `src/message-phase.mjs`, `src/empty-completion-guard.mjs` for consumer policy |
| Lost context or false compaction success | `src/compaction-checkpoint.mjs` and compaction callers in `src/router.mjs` |
| Native handoff/auth failure | `src/router.mjs` owns encrypted handoff extraction/relay; `src/codex-native-session.mjs` owns session credentials; [native Codex](native-codex.md) |
| Disconnect, retry or proxy anomaly | `src/api-forwarder.mjs`, `src/upstream-retry.mjs`, `src/fetch-transport.mjs`, `src/proxy-environment.mjs` |
| Wrong Switchyard target/classifier output | [Switchyard runtime diagnostics](../../config/switchyard/runtime.md) |
| Missing or duplicate agent instructions | [Instruction ownership](context-ownership.md#runtime-instructions) |

## Use historical evidence conditionally

Start from current source, configuration, installed identity, and the smallest
relevant log window. Search the [history index](../history/README.md) only when
the symptom matches a dated incident, a retired provider behavior, a prior
reproduction, or a rejected hypothesis. History can supply useful probes and
causal clues, but revalidate them against the current route, dependency pins,
Codex build, and installed generation before applying a conclusion.

Do not copy historical deployment status, proof acceptance, model availability,
or test counts into a current diagnosis. When a repair changes durable behavior,
update the maintained owner named above and keep dated investigation evidence in
history with its historical status explicit.

## Repair and close

An invalid Responses WebSocket message type produces
`invalid_websocket_message_type` and a `websocket-protocol` warning. The warning
retains only JSON message/type shape categories and a timestamp, without the
payload, arbitrary type value or conversation identity. A missing type and an
unsupported string are distinct observations; neither justifies treating the
message as `response.create`. Inspect both the caller's ordinary serializer and
manual control sends, then use a synthetic probe to establish the protocol.
Codex's instant-interrupt path sends `response.interrupt` during generation when
new user input arrives. Router forwards this control immediately to the matching
native response, including while admission is draining. Malformed controls return
`invalid_response_interrupt`; an ID outside the connection's native response
returns `response_not_in_progress`. External routes do not advertise Responses
Lite and keep their HTTP adapter path. See the
[2026-10-08 steering investigation](../history/2026-10-08-websocket-interrupt.md)
for the original missing-control defect and its installed-client reproduction.

For empty ordinary function calls, `tool-protocol` warnings record only source,
restored, streamed-delta and arguments-done character counts. Zero source and
restored counts locate an empty provider close; nonzero delta/done counts expose
a contradictory stream. Missing counters mean the corresponding events were not
observed. These diagnostics do not retain arguments or repair calls. Pair them
with request timing and the authorized local rollout before attributing a failure.

Response timing records preserve provider-reported cache reads and cache writes
as separate optional counters. Missing, null, and invalid values remain unknown;
an explicit zero remains observed zero. When an empty-completion retry has only
partial usage or cache-counter coverage, the timing record marks the affected
aggregate as incomplete rather than treating the missing attempt as zero.

HTTP timing separates `preparation_ms` (arrival to upstream dispatch) from
`upstream_headers_ms` (dispatch through any retries/gateway to response headers).
The existing `upstream_ms` remains arrival to headers. `first_token_ms` measures
the first observed content, reasoning or tool delta; absent progress is unknown.
Native WebSocket records identify `transport=websocket` and retain preparation,
first-token and total durations. Compare equivalent workloads before attributing
a timing difference to a provider or Router change.

`src/response-usage.mjs` uses bounded shared SSE frames and complete field
assembly for usage, terminal state and tool-output observations. Observation
forwards original chunks immediately; substitution holds the current event or
JSON body. Both require valid UTF-8 and unambiguous JSON before interpreting
trusted metadata or rewriting. An unfinished EOF event cannot prove completion.
First-token timing can inspect a complete progress line before event dispatch;
it does not grant terminal or usage evidence. Phase inference uses the same
terminal type/status meaning and preserves explicit provider phases.

Input estimation excludes only known opaque reasoning fields in prepared input;
schema values and arbitrary data named `encrypted_content` remain counted.
Compaction retains ambiguous serialized tool returns as excerpts without
assigning definite exit/status outcomes. Existing stored checkpoints remain
readable; the fix cannot retrospectively recover erased source evidence.

Routed 429 guidance uses `src/rate-limit-headers.mjs` to interpret `Retry-After`.
Resets outside JavaScript's Date range, including overflow during unit conversion
or addition, leave the estimated delay unknown. The provider's status and original
header still pass through; invalid telemetry does not become a numeric wait hint.

Responses stream failures retain their diagnosed cause through
`src/responses-stream-failure.mjs`. The observer runs after the final response
rewrites and records bounded identity, timestamp and sequence metadata without
holding client bytes. Local failures use `response.failed` when that metadata is
trustworthy; ambiguous or absent metadata retains the generic error. An already
delivered terminal is never followed by another local terminal.

Fix the first owner that violates its contract. A compatibility transform is
justified when the upstream wire behavior cannot be changed here; give it an exact
scope predicate and a regression that fails without it. Remove unused transforms.
Do not hide a rejection with fallback, repeated retries, invented tool calls or
prose parsing. Use a paired case differing in the suspected cause to test a hypothesis.

Retest the actual produced history through the next turn and, when affected,
compaction or native/model switching. Include the relevant negative path and an
unaffected route for shared changes. Follow [verification](architecture.md#verification).
State what was reproduced, the repaired owner, and remaining uncertainty. Store
dated investigation evidence separately from the maintained behavior guide.

## Git reads in a partial clone

In a partial clone, `git log`, `git show`, and `git diff` can fetch missing
promisor objects and write `.git/objects` even though the requested operation
looks read-only. A denied `tmp_pack` write or failed `index-pack` can identify
that hidden write; it does not establish an ownership or authentication problem.
Inspect the clone's promisor/partial-clone configuration and the failing command.
When retrieval is authorized, rerun only the needed object retrieval through the
supported sandbox escalation, then return to ordinary sandbox reads once those
objects are present. Check Git's exit status before interpreting its output.
Shallow ancestry and partial-clone object hydration are separate conditions.

## Bounded stress checks

Run `npm run test:stress` for the deterministic offline Router stress suite. It
uses isolated loopback fixtures, synthetic prompts and credentials, and consumes
no provider quota. The suite covers representative native, OpenRouter, and
Switchyard boundaries plus shared stream, retry, history, compaction,
concurrency, and cancellation behavior. It is intentionally not a live-provider
certification or a full Cartesian product of models and faults.

For a manual live soak, follow the [common verification scope](architecture.md#verification)
first. Full verification already includes this offline stress suite; reuse its
passing result. Then use the installed Router with a new synthetic conversation and send
at most six requests over at most ten minutes: one short ordinary request through
each configured OpenRouter GLM route, one short direct-Responses request, one
Switchyard request, and one tool-call continuation plus compaction on a currently
available route. Use no private history, files, credentials in prompts, or
destructive tools. Stop immediately on an unexpected retry, duplicate tool call,
lost call identity, false successful completion, credential/header disclosure,
or failure to cancel. Accept only when every request has one terminal outcome,
history and tool identity survive the continuation/compaction, and Router health
returns to zero in-flight requests. Close the synthetic conversation afterward;
do not retain provider responses as repository fixtures or modify the installed
runtime during the soak.
