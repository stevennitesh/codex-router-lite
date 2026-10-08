# Audit fixes: deployment and certification, 2026-10-08

Historical release evidence, not current runtime authority.

## Initial deployment

Router commit `475b3a79ae52fd219499f17e2925ba7527f7d009` was pushed and
deployed through the independent checkout transaction. Acceptance completed at
`2026-10-08T19:47:38.0754547Z`. The worker verified full Router and Switchyard
health, scheduled-task and process ownership, the install manifest, runtime
provenance and hashes, installed catalog parsing, Doctor and protected endpoints.

The transaction reused the recovery set retained from the preceding rollout.
Its original Router revision was `4ca8bfa6012b6ba3a2057df23361761ce48bbdba`.
The installed Switchyard binary and private routes were unchanged. No Codex
binary or persistent Windows sandbox setting was replaced.

The source candidate passed `npm run verify:codex`: 577 tests, no failures or
skips, and parsing of 17 models by Codex CLI `0.162.0-alpha.2`. These checks used
synthetic fixtures and did not make provider calls.

## First native renewal

The [reviewed OpenRouter batch](2026-10-08-audit-openrouter-certification.json)
renewed StreamLake, GLM Together, both DeepSeek routes and Pareto against
`475b3a79ae52fd219499f17e2925ba7527f7d009`. Each passed streamed text and
completion, real sandboxed command output `42`, two encrypted handoffs and both
markers from the same child. All 15 native child requests and five separate
streaming requests returned HTTP 200. No active turn was cancelled.

The initial batch's Switchyard child also returned both markers and completed
three requests with HTTP 200, but the extractor rejected its trace attribution.
No accepted Switchyard application was produced from that batch.

Completed-request traces contain a session ID without an agent ID. The reader
kept agent-attributed classifier traces but discarded these completed-request
traces, losing the selected-model observations. The correction includes them
through the child's observed, unshared session. Explicit foreign identities and
ambiguous sessions remain excluded. The regression failed before the correction;
all 34 affected certification tests passed afterward. Re-reading the original
observations recovered two Sol Medium requests and one Luna Max request, with
one session and no observed failures. That diagnostic replay was not published
as a new native run.

## Workflow completion and CI corrections

Repair deployment attempts deferred before changing the service. Inspection
found zero active requests, zero tracked workflow calls and a latched
`indeterminateWorkflow` flag. Normal replacement correctly refuses that state.

The WebSocket adapter cancels its HTTP body after receiving a valid
`response.completed`, so an upstream trailer cannot stall the serialized queue.
Router already recognized this as successful response delivery, but workflow
recording unconditionally rejected an aborted controller. A completed turn could
therefore latch unknown workflow state. An actual Router/WebSocket regression
reproduced the defect with a completed SSE response whose upstream body remained
open. The correction accepts the verified completed client close when no
execution deadline expired. Unfinished or failed turns still block drain;
completed tool calls remain pending until matching results arrive.

The checkout transaction now exposes the existing explicit
`-ForceServiceReplacement` policy. It passes that choice to authenticated drain
and retains process identity, runtime acceptance and recovery checks. Default
deployment never forces. A preactivation failure restores admission after a
forced drain, verified by the isolated PowerShell transaction fixture.

Windows CI also exposed two fixture assumptions. One test compared an unchanged
CRLF proof with a newly serialized LF string; it now checks the original bytes
and explicitly exercises CRLF on every host. Another stopped the Router after
client completion before the final timing reached stderr; it now waits for the
two expected observations with a bounded deadline before stopping the fixture.

The repair candidate `d9251ba2dba3d71d3be0a91b1ac80fd08058c78a` was committed
and pushed. `npm run verify:codex` passed all 581 tests with no failures or skips,
plus source checks and installed-Codex catalog parsing. Raw synthetic captures,
transcripts, session identities, capabilities and private run paths stay local.

## WebSocket rejection reported before activation

The operator reported `Responses WebSocket messages must have type
response.create.` The local diagnostic log records that rejection at
`2026-10-08T20:14:38Z`. The message originates in Router's incoming message-type
validation, before dispatch. The retained logs do not contain the rejected
frame, so they cannot establish whether its type was missing or unsupported.
The installed Codex source's normal Responses serializer produces
`response.create`; no protocol compatibility exception was justified by the
available evidence. Bounded shape-only diagnostics and a stable error code now
distinguish a missing type from an unsupported value without recording private
request content. A regression verifies rejection, privacy and successful use of
the same connection afterward. This is diagnostic coverage, not a proven repair
of the reported incident.

The diagnostic candidate passed `npm run verify:codex`: 582 tests, no failures
or skips, and installed-Codex parsing of all 17 models. The preceding repair's
Windows Node 22.19.0, Windows Node 24.x and Python audit CI jobs also passed.

## Remaining acceptance

At this record's preparation, the healthy installed generation remains
`475b3a79ae52fd219499f17e2925ba7527f7d009`. The old in-memory unknown-workflow
flag cannot be safely cleared by normal replacement. Explicit operator approval
for one controlled forced replacement was obtained, as required by
[installation](../INSTALL.md#replacement-and-drain). The original recovery set
remains retained. The repaired generation and its fresh native proofs are not
yet accepted.
