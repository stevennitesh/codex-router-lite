# Union Alpha investigation history — 2026-09-17

Historical evidence for the initial candidate, not current runtime certification.
Use [the active guide](../agents/union-alpha.md) for maintained behavior. Reuse a probe only
while its relevant code, endpoint, and environment remain applicable.

## Historical identity investigation

Synthetic probes used Chat Completions and Responses, with and without tools,
three repeats per input, plus an exact Novita GLM-5.3-Flash control. Tool-bearing
Union requests produced these stable input-token counts:

| Input | Union, with one tool | GLM control, no tool |
| --- | ---: | ---: |
| `A` | 142 | 13 |
| Thirty decimal digits | 160 | 31 |
| `a`, twenty spaces, `b` | 144 | 15 |
| Chinese, Devanagari, family emoji, combining accent | 171 | 42 |

All four deltas match with a constant 129-token offset. Plain Union requests
varied across repeats for whitespace and multilingual input. This is evidence
of GLM-like accounting on the tool path and variable accounting elsewhere;
four strings cannot establish tokenizer identity, model weights, routing versus
ensembling, or the operator. Generated text is not identity evidence.

Community investigations also disagree about the underlying weights:
[YFarmX's original measurements](https://yfarmx.com/ai/llms/model-fingerprints/)
report multiple accounting signatures, while
[Stealthprint's investigation](https://github.com/majiayu000/stealthprint/blob/main/docs/case-union-alpha.md)
argues for a Llama-family tokenizer with request-dependent accounting. These
are hypotheses, not a basis for selecting family-specific repairs. The operator
remains anonymous in OpenRouter's own listing.

## Historical upstream review and candidate validation

The focused review used Router upstream
`3ff694def9308b15959d20c477b0ce37497e02c6`. Its OpenRouter Union record confirms
automatic tool selection. Its `union-alpha-compat.mjs` instead targets OpenCode
Go's Messages endpoint and its output/image limits; those changes do not apply
to this route. Recent LiteLLM Union truncation/prefix fixes are avoided by the
direct Responses path. This focused review does not advance the repository's
whole-upstream review baseline.

Use the Union, namespace-relay, catalog, compaction-checkpoint, and
empty-completion-guard tests, then the retained suite and current native catalog
check. Live synthetic validation on Codex `0.155.0-alpha.2.6` (Windows app
`26.911.7940.0`) covered:

- Native CLI file reads, `apply_patch`, tool-result continuation, and a CSV
  parser exercise with 13 unchanged assertions. The model corrected a failing
  empty-input case and completed with 2,750 total output tokens. The host also
  reran the original tests successfully. Windows sandbox subprocess restrictions
  required the in-process Node test runner inside the CLI; the sandbox stayed on.
- Real app-server `tool_search` discovery, namespace exposure, dynamic-tool
  dispatch, and continuation using the actual desktop `list_projects` tool.
  A test client used the permitted `desktop_probe` namespace and returned only
  the real project count; private project names were withheld. This proves the
  native dispatch path and actual read-only operation, not the deployed GUI.
- GPT Luna to Union to GPT Luna with an image and actual produced histories;
  a second round trip included encrypted native reasoning and namespaced custom
  calls/results. Native omitted-default-namespace replay initially failed: five
  direct Chat probes with mismatched history names were empty; five with matching
  names returned calls. The shared identity fix then passed the routed round trip.
- A 103,089-token request retrieved markers at the start, middle, and end.
  A separate native app-server conversation reached 138,447 input tokens,
  triggered automatic compaction on the next turn at the configured 115,000
  threshold, and retained all three separate user requirements. This is bounded
  context/continuation evidence, not a claim of lossless arbitrary compaction.

Both API formats identified a generated red image. A five-token tool response
ended as `response.incomplete` with no executable call. The route retains the
existing guard's empty-success retry, but explicit `response.incomplete` and
`response.failed` events pass through once with their original status for all
routed Responses providers. Compaction source extraction accepts valid easy-input
messages that omit `type`, without treating explicitly different item types as
user authority. Compaction retains the
existing deterministic source/tail fallback when the model fails the checkpoint
format; a successful HTTP status alone does not prove a valid model summary.
Keep scratch payloads and logs under `generated/union-alpha/`, with no keys or
existing private conversations. Deployment and v2 certification remain separate
from these candidate tests.

## Follow-up root-cause investigation

Four additional defects were isolated and repaired on 2026-09-17:

- Caller cancellation after the POST body completed did not fire the request's
  aborted event, leaving the provider working before response headers arrived.
  Response-close cancellation now covers both that interval and streaming.
  The regression covers Union and GLM with no retry after cancellation.
- HTTP 200 compaction with `failed` or `incomplete` execution was incorrectly
  turned into a fallback checkpoint. Both native compaction entry points now
  preserve failure and return no replacement history.
- Discovery control items were not normalized during compaction. A synthetic
  discovered-tool history returned HTTP 400 before normalization; afterward it
  produced a checkpoint and resumed with the original marker and project count.
- An old rejected `desktop_probe.list_projects` call poisoned later replay.
  Three paired original requests failed with HTTP 400; all three differing only
  in that name's spelling succeeded. Four earlier originals also failed. Small
  synthetic dotted-name probes succeeded, so the provider's broader internal
  condition remains unknown. The causal repair aliases undeclared historical
  names reversibly at the provider boundary, retaining rejection results and
  call identity without granting a tool. Three replays through the repaired
  Router completed. These requests used the explicitly approved synthetic
  capture, not a private project conversation; returned calls were not executed.

The replay fixes do not establish the provider's model family. The historical
capture predates the tool-discovery catalog fix and is retained as a regression
input, not as evidence of the current catalog behavior. Sandbox process limits
and client-cancelled timing records were separate observations, not evidence of
additional provider failures.

## Second follow-up scan

A subsequent 2026-09-17 scan inspected all 14 session logs then present for that
date for protocol-failure markers, synthetic probe failures, the September 16–17
Router timing records, and open issues #1 and #9. No matching session-output
markers were found. Two native 502 records coincided with upstream socket
closures and one native 507 was an upstream response; later requests succeeded.
These observations do not establish a Router defect or identify the upstream
507 cause. The issue descriptions predate GMICloud and Union and are historical
scope, while deployment and fresh certification remain outstanding.

Additional boundary regressions exposed two actual Router defects:

- A plain function named `fixture__read` and namespace `fixture` / child `read`
  produced duplicate provider names. The ordinary caller had not enabled the
  existing collision-aware mapping. It now does, and forced/allowed tool choices
  use the same mapping as declarations and replay. Tests cover native identities
  restored from actual produced GLM and Union response items.
  A live Stealth request selected the intended namespaced blue-marker tool;
  replay of its produced call and synthetic result returned `BLUE_COLLISION_739`.
  An older discovery test had encoded the same identity collision as schema
  precedence; its expectation now retains both distinct native tools.
- A compaction provider body of `null`, `{}`, or `[]` became a successful fallback
  checkpoint. Non-JSON responses instead escaped as a generic parsing failure.
  Both compaction entry points now reject invalid successful envelopes with a
  specific 502 error, preserving the original history. Non-JSON HTTP rejections
  retain the upstream HTTP status with a structured error.

These were deterministic boundary reproductions, not claims that either edge
case caused the unrelated historical native transport failures.

## Final interaction pass

The final targeted pass on 2026-09-17 found no further reproducible defect:

- A fresh GPT Luna → Union → GPT Luna round trip retained actual custom-tool
  calls/results and newly generated native encrypted reasoning. Export of that
  synthetic history to Stealth had explicit user approval; no real tools ran.
- One live conversation combined deferred discovery, a colliding plain function,
  a namespaced function, a namespaced freeform echo, compaction, and continuation.
  The resumed answer retained `COMBINED_CONTEXT_739`, `COMBINED_BLUE_739`, and
  `COMBINED_CUSTOM_739` from the actual produced call/result history.
- Permanent Router integration checks now cover EOF during a partially streamed
  custom argument and provider failure after partial assistant text. Neither
  produces a fabricated completion or retry; the partial text retains its error
  without acquiring a final-answer phase.
- All 188 retained tests, package/syntax/application checks, and native catalog
  parsing passed. Shared GLM and Switchyard paths are covered by that suite;
  no new live Switchyard certification is implied.

This pass strengthened regression coverage and evidence without adding another
runtime workaround. Deployment, desktop reload validation, and fresh exact-route
v2 certification remain separate work.
