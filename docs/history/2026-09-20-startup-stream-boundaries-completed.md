> Historical completed delivery record. Source behavior is maintained in the
> installation and architecture guides. Accepted runtime: `75ddd5d58c85f392f7b0c9c9f8ea8b1f4acc2f8f`.
> See [release evidence](2026-09-20-startup-stream-release-certification.json).

# Optional-provider startup and stream boundaries

2026-09-20. Comparison baseline: local `d64dd75b` (accepted deployment is
`19d1ac399f0df4851b56c9f0be64c3a8bb8de682`). Status: source candidate
implemented; integrated review complete.

## Outcome and reconciled feedback

Credential-free installation/native-only operation must reach a healthy local
Router without requiring an optional OpenRouter key. Provider readiness stays
truthful. Retained provider stream buffers must be bounded, and an unfinished
SSE event must never establish WebSocket completion or continuation state.

The feedback reviewed d585f691. Its draft/v1 status claim predates the accepted
four-route renewal in d64dd75b; do not undo that evidence as a documentation fix.
The independent startup and streaming findings remain applicable. Subsequent
runtime changes require affected source eligibility/proof to be made provisional
under the existing certification procedure; installed acceptance remains historical
evidence for its exact unchanged runtime.

## Required behavior

1. Separate local service liveness from optional provider credential readiness
   using existing health/startup owners. Missing OpenRouter credentials must not
   block native-only startup or the documented install-then-set-key sequence.
   Do not treat arbitrary 503 responses as healthy, extend timeouts, disable
   authentication, or falsely report an unconfigured provider as ready. Preserve
   genuine dependency-start failure detection and selected-provider readiness.
2. Bound pending SSE text/bytes in hosted-search conversion and both usage
   observation and rewriting modes. Limits apply to retained pending units, not
   cumulative valid stream length or arbitrary receive-chunk sizes. On overflow,
   optional usage parsing/rewriting releases retained memory and preserves raw
   bytes where its contract permits; hosted-search semantic conversion fails
   explicitly rather than emitting an apparent unconverted success. Preserve
   cancellation/backpressure and existing post-header failure propagation.
3. In the WebSocket SSE reader, dispatch only upon a real blank-line delimiter.
   Discard pending EOF data and use the existing missing-completion failure path.
   Never create a continuation baseline from the unfinished response. Apply
   size checks to pending lines/events as they are consumed so valid streams
   behave identically regardless of network chunk partitioning.
4. Keep install documentation accurate about native-only setup and credential
   readiness. Replace its hard-coded Pareto v2 claim with the authoritative
   application pointer so later changes do not create another stale status list.

Keep implementations in existing owners. No generic health policy, shared SSE
framework, provider-discovery changes, model policy, Jev changes or file splitting
for size. Do not rework the corrected relay extraction parser.

## Delivery and evidence

One source implementation slice and final integrated review, gate SS1. Trace
ordinary callers and startup admission before choosing the smallest mechanism.

- Isolated managed-startup regression: no persistent or environment provider key,
  empty provider selection, startup completes, native request succeeds and external
  readiness/admission remains unavailable. Exercise install-before-key readiness
  for selected-but-unconfigured OpenRouter too. Preserve test isolation, native
  synthetic backend, separate ports/state and cleanup. If a third-party startup
  dependency is substituted, state exactly what the test does and does not prove;
  a helper-only 200/503 test is insufficient.
- Incrementally feed unterminated lines beyond each retained buffer limit. Verify
  bounded failure for semantic conversion; exact raw output and released capture
  for optional usage work, including later chunks and flush. Successful long
  streams containing many individually bounded events must still work.
- Real WebSocket adapter tests: LF/CRLF complete events succeed; one newline or
  no delimiter at EOF fails without publishing completion or retaining a new
  continuation baseline. Same valid bytes in one chunk or many chunks have the
  same result under a small isolated test limit; oversized individual units fail.
- Run affected tests, npm run verify, current catalog and application checks.
  Review the entire diff against this baseline and preserve unrelated changes.

## Release boundary

No installed runtime changes or paid provider calls are part of this source slice.
After review, deployment and exact-route renewal are separate release actions.
Make affected source applications provisional if the changed response/namespace
contract requires it; do not weaken checker rules or claim existing live proof
certifies changed code. Preserve previous accepted evidence in Git/history.
Do not commit, push, restart services or change user configuration in this slice.

## SS1 candidate evidence

The source candidate separates API-forwarder liveness from OpenRouter credential
readiness, permits an explicitly selected API-key provider before its key is set,
bounds pending hosted-search and optional usage lines, and requires a real SSE
blank-line delimiter before the WebSocket adapter publishes an event. The four
active source routes and applications are provisional (`v1` / `draft`) pending
deployment and exact-route renewal; their accepted `19d1ac39` evidence remains
in the application records and release history.

SSE line limits measure line content before parsing, rewriting, or ignoring it.
They exclude the LF or CRLF terminator, including when CRLF arrives across chunk
boundaries. Oversized complete and unfinished lines therefore have the same
outcome for coalesced and split delivery, while streams containing many bounded
lines may exceed the per-line limit in aggregate.

The isolated Windows managed-startup regression passed twice without an
environment or persistent OpenRouter key: once with an empty provider selection
and once with OpenRouter selected. Both runs reached healthy `start.mjs`, served
a synthetic native request through the real Router/native dispatch path, and
kept external admission unavailable. The selected run reported the real API
forwarder reachable with `ready: false`. The test substitutes only LiteLLM with
a health-only local process, so it does not prove Python dependency startup or
LiteLLM request translation.

Focused startup, routing, hosted-search, usage, and WebSocket checks passed (74
tests across the sandboxed focused run plus the two isolated managed-startup
cases). `npm run verify` passed 291 tests with the two managed-startup cases
skipped only because the workspace sandbox denies the process-command-line probe;
the same cases passed outside that restriction. The current Codex catalog check
parsed 13 models and passed GLM, Pareto, and Switchyard compatibility. The v2
application checker and `git diff --check` passed. No installed runtime, paid
provider, service, user configuration, commit, or remote was changed.

Integrated review caught and resolved a chunk-partition discrepancy in complete
line size checks. Final review found no remaining blocking findings within SS1.
Deployment and exact-route certification remain separate release gates.

## Release acceptance

The startup/stream candidate and subsequent retry redirect-policy correction were
deployed as `75ddd5d58c85f392f7b0c9c9f8ea8b1f4acc2f8f`. All four exact routes passed fresh native
CLI collaboration, actual sandboxed tool output, and same-child follow-up.
Installed Switchyard live checks passed tools, media fallback, and compaction.
Earlier provisional statuses above describe the pre-release phase only.
