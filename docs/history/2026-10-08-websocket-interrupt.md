# Responses WebSocket interrupt repair, 2026-10-08

## Observation and cause

An operator reported another `Responses WebSocket messages must have type
response.create.` error during a native GPT 6.1 Sol conversation. A second user
message arrived while the first request was running. Router recorded
`invalid_websocket_message_type` at `2026-10-08T20:51:14.867Z`, with an object
message and string type. The authorized conversation recorded the same failure
after commentary and tool output. The diagnostic retained no rejected type value
or payload, so that individual frame cannot be identified directly.

The installed executable was Codex `0.162.0-alpha.2`, fingerprint
`38a286de6bb5968c2e7f9aba7de17e5f748fec67e9245869f93f6090f57cf3ce`.
Its corresponding official source revision is
`08a287137b1e11bf3566d53d6820b82177019f29`. In that revision:

- `codex-rs/codex-api/src/endpoint/responses_websocket.rs` manually sends
  `response.interrupt`, a response ID, and mode `discard_partial_items` when its
  response-owned interrupt fires after `response.created`.
- `codex-rs/core/src/session/turn.rs` fires that interrupt when new user input
  preempts a Responses Lite request. `features.instant_interrupt` enables the
  input watcher. The client drains the response before continuing.
- `codex-rs/codex-api/src/sse/responses.rs` accepts `response.incomplete` with
  reason `interrupted` as a response boundary with `end_turn = false`.

The ordinary tagged request serializer contains only `response.create`; the
interrupt is a separate manual send. The
[earlier diagnostic investigation](2026-10-08-audit-release.md#websocket-rejection-reported-before-activation)
examined the ordinary serializer and did not establish a repair.

Router accepted only `response.create` and queued every text message behind the
active generation. The native interrupt was therefore both delayed and rejected.
An offline regression reproduced a blocked interrupt through the transport edge
and an actual Router process. Both cases timed out before the repair, because
the synthetic native backend awaited its interrupt. This mechanism matches the
reported ordering and error; the missing rejected payload remains a limit on
attributing the specific historical frame.

## Repair

Recognize and validate the native interrupt at the incoming message boundary,
outside the serialized generation queue and new-request admission. Forward only
the supported mode to the connection's active response ID. Duplicate interrupts
send once; a just-completed response ID is a harmless completion race and cannot
interrupt its successor. Wrong IDs and malformed controls remain explicit errors
without echoing arbitrary values.

A valid interrupted terminal retains its upstream response ID and bounded local
fallback history. Its terminal output is authoritative for retained items, so
discarded partial stream items are not reconstructed into a later model switch.
The outcome remains `interrupted`, separately from successful completion. It does
not retire an outstanding Switchyard tool workflow. Other incomplete and failed
terminals retain their failure behavior.

## Verification and scope

Socket regressions exercise immediate interruption while admission is draining,
duplicate controls, malformed controls, foreign IDs, completion races, malformed
interrupted terminals, incremental continuation, model-switch reconstruction and
pending workflow preservation. The actual Router fixture reaches native request
preparation and the real socket boundary with synthetic credentials and content.

An additional offline probe ran the installed signed Codex app-server executable
against an isolated candidate Router and loopback synthetic backend. Its temporary
configuration enabled `instant_interrupt` and loaded that executable's complete
bundled native catalog. A real `turn/steer` call produced the native interrupt,
followed by an incremental request referencing the interrupted response ID. The
turn completed with one upstream WebSocket handshake and zero HTTP generation
requests. Probe processes and temporary homes were removed; persistent Codex
configuration and binaries were not changed. No external model quota was used.

`npm run verify:codex` passed source checks, all 591 tests with no skips or
failures, and installed-Codex parsing of 17 current-schema models. The full suite
ran in the normal Windows user context after sandbox restrictions prevented its
temporary Git and configuration fixtures from running correctly. The focused
socket regressions also passed inside the active sandbox.

## Deployment and live verification

The operator approved commit, push, guarded deployment and a bounded native GPT
steering check. Candidate `66cae2f5a0ff15c7e709aebd845582088fb94cff` was
committed and pushed. The independent deployment worker accepted that candidate
at `2026-10-08T21:34:40.6863019Z`, with all eleven checks passing: full Router and
Switchyard health, Doctor, task/process identity, manifest, installed hashes,
catalog, provenance, protected endpoints and clean candidate identity. It reused
the original retained recovery set. The Switchyard binary and routes were
unchanged; normal drain completed without forced replacement.

The candidate's Windows Node 22.19.0, Windows Node 24.x and Python audit jobs
passed in [CI run 37847553338](https://github.com/stevennitesh/codex-router-lite/actions/runs/37847553338).

The first live WebSocket probe omitted Codex's per-request Responses Lite hint
and completed normally after its interrupt. A corrected hint then exposed a
request-format refusal before generation: the generic API shape did not match
Responses Lite. The final probe used the installed client's request contract:
per-request Lite metadata, tools and instructions in input items,
`parallel_tool_calls = false`, and reasoning context `all_turns`. No runtime
change or provider fallback was needed to correct those probe inputs.

At `2026-10-08T21:40:15.522Z`, the final live check selected GPT 6.1 Sol Medium
through the deployed Router. On one connection it sent two generation requests,
interrupted the first after `response.created`, received `response.incomplete`
with reason `interrupted`, and continued using that response ID. The continuation
completed with exactly `ROUTER_STEER_OK` by `2026-10-08T21:40:19.334Z`.
The installed manifest identified the candidate before and after the check.
The live probe used a WebSocket test client; the separate offline proof above
used the real installed signed Codex app-server client. Credentials, raw frames
and session identities were not exported into this record.

After the live check, current process ownership matched the expected checkout
and full Router health had no degraded dependencies.

This verifies the native steering repair. It does not renew the six exact-route
subagent applications. The original recovery set remains retained while those
separate acceptance requirements remain outstanding, including the earlier
GLM Together provider refusal and Switchyard's changed Router-commit binding.
