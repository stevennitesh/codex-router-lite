# Switchyard integration specification

This maintained specification and its owned files are the source of truth for
Codex Router's Switchyard integration. The active runtime under
`%CODEX_HOME%\switchyard` (or
`CODEX_ROUTER_SWITCHYARD_ROOT`) is generated output, not editable source.
Never keep a permanent upstream checkout or alternate runtime tree.

Load only the branch needed for the task:

- Native encrypted-child relay and classifier projection: the current contract is
  [Security and request flow](#security-and-request-flow). Router extraction,
  currentness and relay are owned by [`src/router.mjs`](../../src/router.mjs);
  Switchyard projection removal and consumption are owned by the locked
  [compatibility patch](patches/switchyard-codex-compat.patch). The completed
  [delivery plan](../../docs/history/2026-09-20-switchyard-child-routing-plan-completed.md)
  and [execution handoff](../../docs/history/2026-09-20-switchyard-child-routing-handoff-completed.md)
  are historical rationale only.
- Classifier behavior and routing criteria: the routing policy below and
  `routes.template.toml`. Completed delivery records live under
  [`docs/history`](../../docs/history/README.md).
- Request, catalog, WebSocket, or trust boundaries: the sections below.
- Startup, health, provider selection, or trace evidence: [runtime operations](runtime.md).
- Upstream pin or patch changes: [source maintenance](maintenance.md#update-the-pin-and-patch).
- Build or live replacement: [build and deployment](maintenance.md), selecting its applicable entry point.
- Exact-route acceptance: [v2 promotion](maintenance.md#switchyard-v2-promotion) and its certification pointer.

## Authority and installed artifacts

| Item | Authority | Rule |
| --- | --- | --- |
| Router catalog, dispatch, provider selection, health, and supervision | repository source and tests | Router remains the sole client/catalog owner. |
| Upstream source identity | `source.lock` | Use the exact repository, public base commit, ordered contribution and compatibility patches, Rust toolchain, and binary path. |
| Reviewed upstream contribution | `patches/switchyard-typesafe-pr-762.patch` | Replays the exact reviewed PR contribution onto the locked public base. |
| Router compatibility changes | `patches/switchyard-codex-compat.patch` | Apply after the reviewed upstream contribution. Do not maintain a fork checkout. |
| Routing policy | `routes.template.toml` | The template contains no generated Router capability. Its canonical source hash is line-ending independent; deployment provenance separately records the exact deployed bytes. |
| Synthetic routing regression | [`docs/switchyard-routing-corpus.json`](../../docs/switchyard-routing-corpus.json) | Authored development/holdout cases for the maintained evaluator; not independent or representative user data. |
| Optional named worker | `switchyard_worker.toml` | Install at `%CODEX_HOME%\agents\switchyard_worker.toml` only when requested. |
| Active runtime | `%CODEX_HOME%\switchyard` by default | Keep the active binary, private `routes.toml`, provenance, routing history, current logs, and at most one in-progress rollback set. |

An installed hash or proof is evidence about one deployment. It never overrides
the checked-in lock, patch, template, or current Router source.

The same corpus has a small `fidelity` section for offline classifier-input
regression. Run it through the maintained evaluator against a local Git object
store that contains the locked upstream commit:

```powershell
node scripts/evaluate-switchyard-routing.mjs --input-fidelity-source `
  <local-switchyard-git> docs/switchyard-routing-corpus.json <output-json>
```

The evaluator creates and removes a disposable checkout, verifies and applies
the two `source.lock` patches in order, and compiles a test-only integration
crate that reuses the actual patched Responses decoder, `/v1/decision` handler,
and classifier. Its recording `TypeSafeProvider` is the precise test-only
transport delta. It uses no provider credential or answer endpoint. This proves
the locked source path's exact outgoing state and zero-call fallback behavior;
it does not prove installed-binary parity because the production Decisions URL
is immutable and Windows process-local test certificates are not trusted.

The lock owns the selected public upstream revision and ordered patch identities. Changes to classifier categories
or routing policy require a routing-quality evaluation, not just a clean patch
application. The [dated pin review](../../docs/history/2026-09-12-switchyard-pin.md)
records the earlier integration decision.

The paid routing evaluator also emits descriptive quality diagnostics. The
development split gets a threshold sweep, confusion matrices, confidence
reliability buckets, exact-label Brier/ECE-style diagnostics, probability
margin, and under/over-routing distances. Holdout is reported only at the
already-frozen configured threshold. Treat Jev confidence as uncalibrated unless
deployment-specific evidence demonstrates otherwise. Candidate-order stability
is not inferred from averaged probabilities; it remains unavailable until
Switchyard exposes per-order verdict evidence.

## Security and request flow

1. Codex sends `switchyard/auto` to Codex Router. Native Sol, Terra, Luna,
   GLM-5.3-Flash, and other picker entries keep their existing routes.
2. Router sends uncompressed native Responses JSON to Switchyard on loopback.
   A fresh per-service-generation capability authenticates every Switchyard
   endpoint except `/health`; Router removes that header before any upstream
   request. For a canonical current encrypted child assignment, Router may add a
   bounded classifier-only projection after using the caller's native account to
   relay that task. A current Codex app task delivery may supply its already
   plaintext delegated input only when its exact app operation, final output
   identity, current-turn request metadata and canonical envelope all agree.
   These client-provided fields are a structural contract inside the authenticated
   local caller boundary, not a cryptographic signature. Switchyard removes the
   private field before decode and raw request preservation.
3. Switchyard sends bounded textual decision state to the exact OpenRouter Decisions
   endpoint for Jev 1.13, chooses a configured Luna, Sol, or Astra target, and
   effort, and sends the native request back through Router's capability-gated
   Responses endpoint.
   The authenticated hop always derives a one-way generation marker and carries
   it back to Router, which removes it before the native provider request. When
   native-attempt diagnostics are explicitly enabled, Router uses the marker to
   distinguish the selected native answer attempt from unrelated direct-native
   traffic. The marker has no Switchyard authentication authority.
4. `forward_auth = true` preserves the original Codex authorization and account
   envelope for the native ChatGPT backend. Switchyard must not substitute or
   log it.

The managed address must remain loopback-only. `/v1/models`, `/v1/decision`,
and serving endpoints must return 401 without the local-hop capability;
`/health` remains the unauthenticated liveness leaf. Decision output must not
expose target base URLs, credentials, account headers, or capabilities.

## Why the canonical patch exists

The locked upstream supports target reasoning effort but still identifies
targets by model ID. Router needs distinct effort variants of the same native
model and control over additional request fields. The patch adds and tests:

- `routing_id` as the local target identity while `id` remains the upstream
  model;
- recursive `body_overrides`, then `remove_body_fields`, so the chosen route
  owns effort, `store`, `stream`, and unsupported fields without erasing native
  reasoning siblings;
- raw Responses item inspection so custom, computer, shell, and tool-search
  continuations retain the selected target;
- preservation of caller `priority` on selected native answer requests;
- authenticated classifier projections that are removed before decode, raw
  preservation, observability, and upstream forwarding;
- local-hop capability enforcement and removal; and
- target-URL redaction in decision output; and
- a locked-source regression that decodes native Responses usage through both
  buffered and streaming paths and verifies the routing log keeps inclusive
  input totals while preserving cache-read, cache-write-zero, and missing-write
  distinctions before the historical log schema maps a missing write to zero.

Every target sets `store = false`, `stream = true`, and removes
`max_output_tokens` for the ChatGPT subscription Responses backend.

## Routing policy

Jev 1.13 is the sole classifier. It receives bounded text through the exact
OpenRouter Decisions endpoint from three sources: the latest genuine ordinary
user turn, a recovered current native child assignment, or the delegated input
from a recognized current Codex app task delivery. Ordinary tool outputs,
assistant answers, reasoning, provider metadata, credentials, native
authorization and earlier turns do not enter the decision request. In ordinary
plaintext history, empty and control-only pseudo-user items are skipped so the
most recent genuine user turn can still be selected; only no usable turn or a
selected turn with unsupported meaningful content takes the local fallback.
An authenticated assignment projection attempt with no usable text instead
releases affinity and takes the zero-Jev `non_text_state` Sol fallback. The full
conversation remains intact for the native answer model. See the repository
[security boundary](../../SECURITY.md) for the exact egress and currentness
limits. The classifier chooses the dominant bottleneck of the whole request with
this policy:

- `astra-xhigh`: exceptional reasoning with multiple difficult interacting
  constraints, subtle correctness, recovery after a capable attempt failed, or
  consequential state or security effects.
- `astra-medium`: planning, review, architecture, interpretation, synthesis,
  or uncertain diagnosis where judgment dominates.
- `sol-medium`: implementation or concrete debugging with a defined outcome
  and decisive verification; this is also the default when the work mode is
  unclear or classification is uncertain.
- `luna-max`: bounded retrieval, source-grounded extraction or summarization,
  and tiny fully specified mechanical work with cheap verification.

For encrypted native child handoffs, Router relays only the final canonical task
under a five-second deadline and never substitutes an earlier assignment. Failed,
ambiguous or unsupported recovery makes zero Jev calls and takes the
`non_text_state` Sol fallback. Plaintext user turns can still be reclassified
within one conversation; see the contrasting [live protocol](../../docs/history/2026-09-19-switchyard-live-model-transitions.json)
and [native child](../../docs/history/2026-09-19-switchyard-native-child-transitions.json)
tests.

The Codex app exception recognizes only the final standalone
`function_call_output` item from the `codex_app` namespace for `create_thread` or
`send_message_to_thread`. It requires a native `fco_<UUID>` identity, no non-null
`call_id`, parseable current receiver metadata, a distinct source thread and one
anchored delegation envelope, then projects only the decoded delegated input.
Known historical, self-delivered, call-linked and unrelated outputs retain
affinity as ordinary control history. Once the current app identity and operation
are recognized, missing, ambiguous, malformed or oversized required assignment
state produces a null projection attempt, releases affinity and takes the zero-Jev
Sol fallback. Optional mismatched item-turn metadata marks the item historical;
when item-turn metadata is absent, currentness relies on the host contract that
the current turn's standalone tool output is the final request item. The envelope
is not independent historical provenance or a cryptographic signature.

The exact criteria, question, threshold, fallback and transport limits live in
`routes.template.toml`. Artifact provenance binds the pinned source, ordered
patches, route template, generated routes, binary and Router commit. Historical
B2 evidence remains regression context and no longer materializes current routes.

## Codex compatibility

The public `switchyard/auto` entry keeps Sol's native behavioral instructions
with only their model-identifying first sentence neutralized. Its capabilities
are the explicit common contract of the installed Luna, Sol, and Astra entries:
optional tools and tiers are intersected, context bounds use the smallest common
value, and strict review or disabling flags win. Catalog generation reads the
checked route metadata and never parses Switchyard TOML at runtime.

The public slug, local dispatch model, selected target, and native provider model
are separate identities. Ordinary turns send `switchyard-auto` to Switchyard;
native V1/V2 compaction continues to use `gpt-5.6-sol`. Responses restore the
public `switchyard/auto` identity while routing diagnostics retain the selected
target. The authored picker effort ladder is accepted for client compatibility;
each target's configured effort overrides it.

The four-target policy advertises multi-agent v2 only with an accepted
runtime-bound application under `v2_agent/switchyard/auto`. A source change keeps
the route at v1 until the changed source is deployed and recertified. A proof
binds the deployed Router commit, upstream source, ordered patches, binary,
generated routes, exact deployed-template bytes, and the line-ending-independent
canonical template source.

Router keeps Codex compaction requests on the native public route rather than
sending them through Switchyard's auxiliary compaction endpoint. The optional
named worker must not set `model_context_window` or
`model_reasoning_summary`; omission preserves catalog-owned defaults.

Router owns the Codex WebSocket edge. It authenticates and translates each
complete WebSocket request into the canonical HTTP Responses path, so
Switchyard itself receives plain HTTP JSON. This is not a client fallback and
does not authorize a second WebSocket implementation in Switchyard.

The common `priority` tier may pass because every configured Luna, Sol and Astra
target supports it. Sol-only tiers stay hidden from the public routed entry.
