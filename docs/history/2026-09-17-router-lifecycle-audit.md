# Router lifecycle audit, 2026-09-17

> Historical investigation evidence. This record does not describe the current
> installed runtime or renew any exact-route certification.

This offline audit examined shared Router protocol and lifecycle boundaries at
source commit `8f66a64c38e816fb4a60218943d98dfd8587ee3e`. It used synthetic loopback
providers and credentials. It made no live provider calls, deployment, commit,
conversation export, or certification attempt.

## Confirmed defects

### WebSocket terminal lifecycle

The Responses WebSocket adapter could expose more than one terminal outcome.
A malformed `response.completed` was forwarded before its continuation identity
was validated, then followed by a local error. A valid completion followed by a
transport failure or malformed SSE trailer also produced a second error and lost
the accepted continuation because state was committed only after the body ended.
Finally, a valid terminal whose upstream never closed blocked the serialized next
request indefinitely.

The repair validates completed JSON and SSE responses consistently, commits a
usable continuation at the accepted terminal, ignores later event semantics,
cancels the remaining body to release the queue, and treats a routed client close
after an observed completion as successful accounting. Public upgrade-handler
regressions cover invalid completion, failed/incomplete/error terminals,
transport and malformed trailers, a never-ending body, continuation replay,
authentication projection, redirect policy, and caller cancellation.

### Routed POST redirects

Fixed routed destinations followed HTTP 307/308 responses. A loopback provider
therefore received the full POST a second time at the redirect target while the
caller observed false success. The repair rejects redirects at ordinary routed
and Switchyard sends, routed compaction, the OpenRouter forwarder, and the
WebSocket loopback. Synthetic checks cover relative and cross-origin 307/308
destinations. Native direct requests retain their prior redirect behavior because
this audit found no evidence supporting a native compatibility change.

## Negative findings

Targeted checks did not reproduce loss or cross-request contamination in
namespace aliases, produced custom-tool replay, repeated compaction and model
switching, retry cancellation, concurrent ordinary requests, route/auth
isolation, catalog eligibility, or subagent policy. The existing Pareto
integration exercises produced plain and namespaced custom calls through
`responses/compact`. A new concurrency check demonstrated that two encrypted
handoff waiters share one native relay and canceling one leaves the survivor
usable.

The bounded runtime evidence for the retired Union empty calls located an empty
provider close: source, restored, and done argument lengths were zero and no
delta was observed. The Router neither erased nor invented arguments in that
evidence window.

## Verification and limits

The repository check, full offline test suite, deterministic stress tests, and
current-Codex catalog compatibility check passed after repair. The catalog check
parsed 13 models from Codex `0.155.0-alpha.2.6`.

These source changes were not installed or exercised against paid providers.
They affect shared routed and WebSocket behavior, so checked-in exact-route v2
proofs do not certify the changed candidate. The authorized live certification
workflow remains required before a release claim.
