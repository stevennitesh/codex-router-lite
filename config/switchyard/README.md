# Switchyard integration

This directory is the source of truth for Codex Router's Switchyard
integration. The active runtime under `%CODEX_HOME%\switchyard` (or
`CODEX_ROUTER_SWITCHYARD_ROOT`) is generated output, not editable source.
Never keep a permanent upstream checkout or alternate runtime tree.

Load only the branch needed for the task:

- Implement or review the planned simplicity/correctness follow-up: read the
  [active plan](../../docs/switchyard-followup-plan.md) and its
  [handoff](../../docs/switchyard-followup-handoff.md). The accepted source
  candidate was deployed and exact-runtime certification was renewed on
  2026-09-18; those records bind the installed candidate named in the handoff.
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
| Routing policy | `routes.template.toml` | The template contains no generated Router capability. |
| Synthetic routing regression | [`docs/switchyard-routing-corpus.json`](../../docs/switchyard-routing-corpus.json) | Authored development/holdout cases for the maintained evaluator; not independent or representative user data. |
| Optional named worker | `switchyard_worker.toml` | Install at `%CODEX_HOME%\agents\switchyard_worker.toml` only when requested. |
| Active runtime | `%CODEX_HOME%\switchyard` by default | Keep the active binary, private `routes.toml`, provenance, routing history, current logs, and at most one in-progress rollback set. |

An installed hash or proof is evidence about one deployment. It never overrides
the checked-in lock, patch, template, or current Router source.

The lock owns the selected public upstream revision and ordered patch identities. Changes to classifier categories
or routing policy require a routing-quality evaluation, not just a clean patch
application. The [dated pin review](../../docs/history/2026-09-12-switchyard-pin.md)
records the earlier integration decision.

## Security and request flow

1. Codex sends `switchyard/auto` to Codex Router. Native Sol, Terra, Luna,
   GLM-5.3-Flash, and other picker entries keep their existing routes.
2. Router sends uncompressed native Responses JSON to Switchyard on loopback.
   A fresh per-service-generation capability authenticates every Switchyard
   endpoint except `/health`; Router removes that header before any upstream
   request.
3. Switchyard sends bounded textual decision state to the exact OpenRouter Decisions
   endpoint for Jev 1.13, chooses a configured Luna, Sol, or Astra target, and
   effort, and sends the native request back through Router's capability-gated
   Responses endpoint.
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
- `priority` propagation to classifier and serving requests;
- local-hop capability enforcement and removal; and
- target-URL redaction in decision output.

Every target sets `store = false`, `stream = true`, and removes
`max_output_tokens` for the ChatGPT subscription Responses backend.

## Routing policy

In the final source candidate, Jev 1.13 is the sole classifier. It receives only
the latest genuine user turn's
ordered text blocks through the exact OpenRouter Decisions endpoint. Pure
tool-result pseudo-user messages are skipped. Media in the selected turn skips
the classifier and falls back to Sol; older media does not veto a later text-only
classification. Earlier turns, tool results, reasoning, provider metadata,
credentials, and native authorization never enter the decision request. The
full conversation remains intact for the native answer model. The classifier
chooses the dominant bottleneck of the whole request with this policy:

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
runtime-bound application under `v2_agent/switchyard/auto`. The final source
candidate changes bound runtime identities, so its prior proof is retained as
history and the candidate
stays v1 until deployment and recertification. A proof binds the deployed Router
commit, upstream source, patch, binary, generated routes and current template.

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
