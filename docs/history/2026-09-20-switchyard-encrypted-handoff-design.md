# Switchyard encrypted-handoff routing design

Date: 2026-09-20
Status: design recommendation; no runtime change in this review

Delivery is recorded in the [completed plan](2026-09-20-switchyard-child-routing-plan-completed.md).
This dated investigation explains the proposal; it is not a second execution contract.

## Decision

The current source supports a feasible Router-side design for making Jev classify
native v2 child handoffs, but it is not yet proved safe enough to promise as a
runtime change. Router already recognizes collaboration envelopes and, for
external answer routes, asks the native Responses backend to return the decrypted
payload through one forced local function call. Switchyard is deliberately
excluded from that normalization today because its answer is native and the full
native request is forwarded unchanged. An exact native synthetic probe must first
prove that this model-generated extraction is faithful for the task shapes Codex
actually sends.

Reuse that relay only to create a **classifier projection** for Switchyard. Keep
the answer request's `input`, including its native `encrypted_content`, unchanged.
Pass the projected text over the existing capability-protected Router ->
Switchyard hop in one reserved body extension. Switchyard must remove and
validate the extension before decoding or retaining the request for upstream
replay, keep it only as request-local classifier state, and prefer it over the
decoded `agent_message` for that decision. The selected native target still
receives the original encrypted handoff.

This is the smallest sound extension of the current ownership:

```text
native child request
        |
        +-- original encrypted request --------------------+
        |                                                   |
        +-- latest genuine encrypted handoff                |
              -> existing native relay -> bounded text      |
                                      |                     |
                                      v                     v
                              Switchyard/Jev         selected native GPT
                              classification         original request
```

## What the evidence establishes

- [`src/router.mjs`](../../src/router.mjs) lines 1019-1041 already own
  collaboration-envelope recognition, while lines 1205-1284 own the native
  forced-tool extraction and lines 1323-1384 own its cache/coalescing wrapper
  and routed-input normalization. These paths also own native
  account/header forwarding, payload-relay caching, coalescing, cancellation,
  401/429 preservation, and fail-closed behavior. `normalizeRoutedAgentInput`
  uses this path for external answer routes.
- The ordinary routing branch at `src/router.mjs` lines 2039-2104 explicitly
  runs that normalization only for `route && !switchyard`. Switchyard instead
  receives the native body and
  therefore sees an `agent_message` whose payload is still encrypted.
- The pinned Switchyard Responses decoder represents an unrecognized
  `agent_message` as an unknown user block. The maintained latest-user selector
  in `config/switchyard/patches/switchyard-codex-compat.patch` lines 667-714
  correctly treats unknown meaningful content as non-text and lines 846-869 emit
  `non_text_state`; the live child test observed that fallback once for each of
  four handoffs.
- The live plaintext protocol test proves that target affinity can release and
  reclassify later user turns. The native child test proves v2 collaboration and
  continuity, but every handoff fell back to Sol. These tests exercise different
  decision inputs; they do not conflict.
- Router also already sends plaintext `input_text` inside an `agent_message` to
  native GPT when a routed parent authored the handoff. That is useful
  compatibility evidence, but it does not justify rewriting this answer request:
  a separate classifier projection preserves the stronger native invariant.

The relay is a measured native-model behavior, not a documented public
"decrypt" API. It forces one tool call and asks the native model to reproduce the
payload exactly. Existing Router tests and live external-route behavior support
that contract, but the result is still model-generated extraction. Tests for
this change should therefore include payloads with whitespace, delimiters,
Unicode, and instruction-like text, and should fail closed if the relay omits a
payload.

The observed wire shape has one top-level `agent_message`. Its visible
`input_text` is a collaboration header ending at `Payload:`, and its native
`encrypted_content` holds the task payload. There is no separately documented
structured `task` field. A projection must therefore accept only one current
task-bearing envelope (`NEW_TASK`, `MESSAGE`, or `FOLLOWUP_TASK`) with exactly
the expected text-plus-encrypted-content shape. Mixed media, multiple encrypted
parts, `FINAL_ANSWER`, an unknown message type, or an envelope whose visible
header does not end at `Payload:` must remain `non_text_state`. Never scan older
items to find something classifiable.

## Interface and ownership

### Router

In `src/router.mjs`, add a Switchyard-only projection step before materializing
the local-hop body:

1. Remove any caller-supplied value at the reserved projection field.
2. Inspect only the latest genuine collaboration `agent_message` that represents
   the new child handoff. Do not resolve every historical encrypted handoff.
3. If it carries native ciphertext, use the existing
   `relayEncryptedAgentPayload` path under a short projection-specific deadline.
   If it already carries routed-parent plaintext, use that plaintext without a
   native call.
4. Add the result as a bounded text value in a reserved Router-owned body
   extension only when the projected UTF-8 task fits the classifier budget. Do
   not add it for ordinary plaintext turns, media, control-only continuations,
   compaction, or an unrecognized envelope.
5. The projection is optional to the native answer. On extraction timeout,
   malformed/omitted tool output, oversize text, or relay HTTP failure, omit the
   projection and let the unchanged encrypted request take the existing local
   `non_text_state` Sol fallback. A caller cancellation still cancels the whole
   operation. Do not silently classify older user text.

Keep envelope recognition and relay/cache policy in their existing Router owner;
do not add a second decryptor in Switchyard. This availability-preserving policy
is intentionally different from an external answer route: an external model
cannot answer without recovered plaintext, while Switchyard's selected native
model can still read the original encrypted handoff. Do not change the external
route's established 401/429/fail-closed behavior.

### Switchyard compatibility patch

In `crates/switchyard-server/src/lib.rs`, while resolving the authenticated
local request, remove the reserved extension **before** `decode_request` and
before the sanitized body is captured for same-format replay. Validate that it
is a string and apply an explicit byte bound. Store it as request-local internal
classifier state; it must not enter forwarded headers, preserved request JSON,
routing logs, error bodies, or response metadata.

The least invasive carrier candidate in the pinned API is a reserved entry in
`Metadata.extra_metadata`: it is host-owned, and a bounded source search found no
current production consumer that serializes it. That is not yet proof that it is
excluded from every observability or forwarding path. Before adopting it, an
end-to-end test must show the text absent from the selected target body, forwarded
headers, routing log, error response, and trace fields. If that proof fails, add
one typed request-local classifier field instead. Give either carrier a private
constant and read it only in
`crates/libsy/src/algorithms/type_safe_class.rs`. Never retain the projection in
`raw_request` or the answer model's `LlmRequest.messages`.

In the TypeSafe classifier, the selection order becomes:

1. trusted Router classifier projection, when present;
2. current latest-genuine-user selector for ordinary plaintext requests;
3. the existing `empty_state` / `non_text_state` / provider fallbacks.

Affinity remains `user_turn`: each new child handoff can reclassify, while tool
calls and tool results inside that child turn remain on the selected target.

## Trust and disclosure

This changes a real trust boundary. Today a native child handoff falls back
locally and its encrypted task is not sent to Jev. After this change, selecting
`switchyard/auto` for the child authorizes Router to recover the current task text
and send that bounded text to OpenRouter/Jev for model selection. Native account
credentials and headers must remain excluded from the Jev request and stay only
on the native relay and native answer hops.

Update `README.md`, `SECURITY.md`, and `config/switchyard/README.md` together.
State plainly that the current encrypted child task text is included in Jev
classification, while assistant output, tool results, reasoning, prior handoffs,
media bytes, account identifiers, and the encrypted answer payload are excluded.
Those exclusions describe Router-selected protocol fields; the delegated task
text itself may quote earlier conversation, tool output, file contents, or other
sensitive material supplied by the parent. Router cannot infer and remove that
meaning without changing the task. No raw task text may appear in evidence or
logs.

## Cost and latency gate

Every uncached encrypted handoff would add a native extraction call before the
Jev call and selected answer call. `nativeAgentRelayModel()` currently defaults
to Sol, so this extra call can erase Luna's expected cost advantage and add
material latency even when routing works. The relay's response reader currently
allows 4 MiB while Jev's complete serialized decision request is capped at 32
KiB; the classifier projection must impose its own deadline and small UTF-8 bound
before crossing the local hop.

Before recommending production enablement, run a bounded synthetic experiment
that records extraction tokens, extraction latency, Jev latency, total first
token latency, cache hits, selected target, and fallback reason across an opening
handoff and same-child followups. Keep the Sol relay model unchanged during this
experiment so the routing behavior and extraction-model change are not mixed.
If the overhead dominates the work being routed, retain the current Sol fallback
for native child tasks or use explicit child models instead of claiming an
economic optimization.

## Why the alternatives lose

- **Normalize the whole Switchyard answer request:** reuses existing code but
  decrypts historical handoffs, changes the native answer payload unnecessarily,
  and still requires Switchyard to understand plaintext `agent_message` items.
- **Decrypt inside Switchyard:** duplicates native-auth, caching, cancellation,
  and failure policy that Router already owns.
- **Put plaintext in an HTTP header:** header limits and routine header logging
  make this unsuitable for task text.
- **Parent-selected explicit model:** can choose an initial worker, but it does
  not provide deterministic per-followup switching in the same child and moves
  classifier policy into agent behavior.
- **Codex hooks:** the current public
  [hooks contract](https://developers.openai.com/es-419/docs/hooks) for
  `SubagentStart` exposes identity and allows
  additional context, not the readable v2 task or a durable per-followup model
  decision. `PreToolUse` can rewrite ordinary tool input, but specialized paths
  may bypass it and it does not establish same-child reclassification.
- **Wait for an upstream hook:** would provide a stronger authoritative
  plaintext source if Codex adds one, but it is not required for the current
  Router workflow. Revisit this design if such a hook becomes public.

## Acceptance

Implementation is complete only when all of these distinguish it from the
current Sol fallback and from an unsafe whole-request rewrite:

1. A mocked encrypted native handoff produces one native relay, one Jev call
   containing only the projected current task, and an unchanged encrypted
   `agent_message` at the selected native target. A native synthetic probe with
   whitespace, Unicode, delimiters, and instruction-like text must separately
   establish whether the forced-tool extraction is exact enough for use.
2. A caller-supplied reserved field is overwritten or removed and can never
   steer classification directly.
3. Earlier handoffs, assistant text, reasoning, tool results, media, account
   headers, and native ciphertext do not enter the Jev request.
4. A current media/unsupported turn still performs zero Jev calls and falls back
   to Sol. Missing, malformed, oversized, timed-out, 401, 429, or omitted
   projection results also perform zero Jev calls and continue the unchanged
   encrypted request through the Sol fallback. Caller cancellation still aborts
   the request. No case classifies stale text; external routes keep their existing
   hard-failure behavior when their required payload relay fails.
5. Tool continuations remain on the chosen target without another Jev call; a
   later encrypted `MESSAGE` or `FOLLOWUP_TASK` to the same child invokes a new
   decision and can select another target.
6. Switchyard request/response logs and certification evidence contain only
   bounded reason codes, target identities, probabilities, and timings.
7. The bounded experiment reports incremental native extraction latency/tokens
   separately from Jev and answer-model latency, so a working switch is not
   misreported as a cost optimization.
8. The real native test demonstrates at least two different targets in one child
   conversation, preserved prior facts/tool results, and same-child identity.
   Because this changes encrypted relay and selected-target behavior, rebuild,
   deploy, and renew the exact-route v2 proof after offline checks pass.

Do the synthetic and mocked tests first. The final native transition test uses
ChatGPT and Jev quota and should run only under explicit certification authority.
