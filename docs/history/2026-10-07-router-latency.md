# Router latency changes — 2026-10-07

Historical local evidence for the latency candidate based on `c35a18ee`.
This record does not establish installed-runtime performance or renew route
certification. All provider inputs and credentials were synthetic; no live
model requests were made.

## Changes

- Set LiteLLM retries to zero, retaining the forwarder's bounded retry.
- Run desktop-generation capture alongside native dispatch, coalesce scans,
  and resolve captures inside the ordered authentication-observation queue.
- Make credential refresh and Codex executable discovery asynchronous.
- Cache parsed effort metadata by catalog file identity, invalidating changed,
  missing or invalid state. Reuse unchanged native JSON and zstd bytes.
- Keep caller-owned native WebSockets persistent, forward actual prewarming
  and produced response-ID continuations, and retain bounded fallback history.
  External routes and substituted sessions keep their HTTP preparation path.
- Parse each GLM event once and scan only new fragments when finding event
  boundaries. Preserve original output bytes and lifecycle repairs.
- Separate HTTP preparation and upstream-header timings and emit first-token
  timing on HTTP and native WebSockets.

## HTTP and gateway measurements

The same baseline/candidate scripts validated 1,178 synthetic streams per
comparison: 986 through actual Router/forwarder processes and 192 through the
pinned Python gateway. Windows, Node 24.13.0, Python 3.12.12, LiteLLM 1.104.0,
FastAPI 0.141.1. Native/direct routes used 30 alternating direct/routed pairs;
GLM used 15 alternating direct-chat/gateway/Router samples per condition. Native
effort metadata used an 860,304-byte synthetic catalog. Streams checked text,
completed tool arguments, namespace restoration and terminal outcomes.

| Measurement | Before | After |
| --- | ---: | ---: |
| Cold matching-auth dispatch, four fresh processes | 272–286 ms | 21–26 ms |
| Native small request: added first content, median / p95 | 3.03 / 4.21 ms | 1.25 / 2.22 ms |
| Native 256 KiB tool result: added first content, median / p95 | 9.80 / 25.85 ms | 6.53 / 16.59 ms |
| Gateway 429 with Retry-After: 1 | 3 POSTs; 4,653 ms | 1 POST; 42 ms |
| Gateway 503 with Retry-After: 1 | 6 POSTs; 5,581 ms | 2 POSTs; 296 ms |

Both refusal statuses and error codes survived. Successful GLM tool forwarding
remained about 13–14 ms; direct Responses tool forwarding remained about 1 ms.
Large external-request medians fell, but wide overlapping distributions and
Windows scheduling noise do not establish a causal improvement for those
unchanged provider paths. StreamLake's small-request p95 increased despite a
lower median; a general gateway speedup is not established.

## Native WebSocket comparison

Thirty rotating-order runs per path compared committed `c35a18ee` Router and
adapter snapshots with candidate Router processes and a direct native WebSocket.
Dependency modules were shared with the current checkout. Each run sent a
256 KiB deterministic varied synthetic history followed by 12 tool-output
suffixes. Actual produced response and call IDs fed the next request; the
upstream independently reconstructed history and checked every call/output pair.
All 1,170 streams passed. First content here means the first function-arguments
delta; no upstream generation delay was inserted.

| Path | Warm first arguments median / p95 | Cold full baseline median | Sum of 13 response durations, median |
| --- | ---: | ---: | ---: |
| Previous Router HTTP adapter | 6.56 / 24.56 ms | 9.99 ms | 112.90 ms |
| Candidate Router native WebSocket | 0.52 / 0.82 ms | 7.07 ms | 14.92 ms |
| Direct native WebSocket | 0.10 / 0.18 ms | 2.48 ms | 4.26 ms |

Warm incremental Router overhead was about 0.42 ms by difference of medians.
The full-chain values exclude tool computation and client reconnects. Upstream
request bodies totaled 1,741,003 bytes on previous HTTP with actual zstd
compression, versus 264,987 bytes on candidate/direct WebSockets. These counts
exclude HTTP headers and WebSocket framing; the fixture did not negotiate
WebSocket compression. Logical JSON totals were 3,423,680 and 264,987 bytes.

A separate adapter-only experiment validated 780 streams and observed 1.99 ms
versus 0.28 ms warm first arguments, excluding Router preparation/compression.
These comparisons establish local transport/preparation and transfer-volume
changes for the stated fixture. They do not predict cloud generation time,
congestion, internet latency or provider prompt-cache gains.

## Additional parser opportunity

The second pass found repeated scanning and flattening of incomplete GLM SSE
events. A separate comparison used the source after the initial parse-reuse
change as its baseline, alternated warm measurements, and checked full output
byte equality on every run.

| Local transform workload | Before median | After median |
| --- | ---: | ---: |
| 2,000 ordinary deltas, 64-byte fragments | 8.65 ms | 4.07 ms |
| 2,000 ordinary deltas, 4 KiB fragments | 3.40 ms | 3.41 ms |
| 256 KiB terminal event, 64-byte fragments | 143.78 ms | 1.25 ms |
| 1 MiB terminal event, 64-byte fragments | 1,936 ms | 4.91 ms |

The parser now accumulates fragments separately, carries at most three delimiter
characters across boundaries, and joins once per complete event. Ordinary
streams used 30 samples; long events used five. These are transform CPU times
on synthetic fragmented streams, not measurements of provider inference or
production event fragmentation.

## Correctness and limits

`npm run verify:codex` passed all 481 active tests and parsed 17 current-schema
models from Codex CLI 0.162.0-alpha.2. Tests include actual Router/native
WebSocket prewarming, produced tool continuations, effort/catalog changes,
credential and session isolation, cancellation, deadline/admission release,
HTTP-only handshake fallback, and refusal passthrough. Native requests already
sent upstream are never replayed after a transport failure.

A separate reviewer found that rate-limit metadata sharing a completion packet
closed the persistent connection. The correction preserves bounded permitted
metadata and rejects trailing response output; an actual-socket regression
passed. No remaining actionable findings were reported in the reviewed paths.
The final header check also retained native routing hints and the `x-session-id`
header through the WebSocket edge; focused adapter/native checks covered it.

Internet transit, real provider queues/inference, prompt-cache benefits,
Codex tool execution and complete Switchyard classification were not measured.
Recent Switchyard timings and stub-only measurements cannot establish its total
overhead. Successful GLM conversion remains the largest measured ordinary
tool-forwarding overhead; bypassing it requires separate endpoint capability
evidence. Current exact endpoint policy and fallback prohibitions are retained.
The cold native WebSocket baseline still does more serialization than a direct
connection; its exact history-retention bounds justify keeping that work.

The maintained behavior lives in [native Codex](../agents/native-codex.md),
[GLM compatibility](../agents/openrouter-glm.md) and
[timing diagnostics](../agents/debugging.md). Source verification and local
measurements do not substitute for an authorized deployment or native route proof.
