# Switchyard integration

This directory is the source of truth for Codex Router's Switchyard
integration. The active runtime under `%CODEX_HOME%\switchyard` (or
`CODEX_ROUTER_SWITCHYARD_ROOT`) is generated output, not editable source.
Never keep a permanent upstream checkout or alternate runtime tree.

Load only the branch needed for the task:

- Request, catalog, WebSocket, or trust boundaries: the sections below.
- Startup, health, provider selection, or trace evidence: [runtime operations](runtime.md).
- Upstream pin or patch changes: [source maintenance](maintenance.md#update-the-pin-and-patch).
- Build or live replacement: [build and deployment](maintenance.md), selecting its applicable entry point.
- Exact-route acceptance: [v2 promotion](maintenance.md#switchyard-v2-promotion) and its certification pointer.

## Authority and installed artifacts

| Item | Authority | Rule |
| --- | --- | --- |
| Router catalog, dispatch, provider selection, health, and supervision | repository source and tests | Router remains the sole client/catalog owner. |
| Upstream source identity | `source.lock` | Use the exact repository, commit, Rust toolchain, binary path, patch path, and patch SHA-256. |
| Switchyard changes | `patches/switchyard-codex-compat.patch` | Apply only to the locked commit. Do not maintain a fork checkout. |
| Routing policy | `routes.template.toml` | The template contains no generated Router capability. |
| Optional named worker | `switchyard_worker.toml` | Install at `%CODEX_HOME%\agents\switchyard_worker.toml` only when requested. |
| Active runtime | `%CODEX_HOME%\switchyard` by default | Keep the active binary, private `routes.toml`, provenance, routing history, current logs, and at most one in-progress rollback set. |

An installed hash or proof is evidence about one deployment. It never overrides
the checked-in lock, patch, template, or current Router source.

The lock owns the selected upstream revision. Changes to classifier categories
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
3. Switchyard classifies the turn, chooses a configured Luna or Sol target and
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

- `luna-high`: closed, low-risk work with cheap verification.
- `luna-max`: difficult but tightly specified and strongly verifiable work.
- `sol-medium`: ambiguity, weak verification, or judgment.
- `sol-high`: hard diagnosis, architecture, large refactors, security, and
  consequential review.
- `sol-xhigh`: exceptional quality-first or recovery work.

The classifier prompt and schema live only in `routes.template.toml`.

## Codex compatibility

The public `switchyard/auto` entry derives its context, compaction behavior,
instructions, model messages, modalities, tools, service tiers, and other
native capabilities from the current installed Sol behavior template. Its
authored picker effort ladder remains Switchyard-owned. Do not freeze a copied
native field list here or in the route fragment.

Router keeps Codex compaction requests on the native public route rather than
sending them through Switchyard's auxiliary compaction endpoint. The optional
named worker must not set `model_context_window` or
`model_reasoning_summary`; omission preserves catalog-owned defaults.

Router owns the Codex WebSocket edge. It authenticates and translates each
complete WebSocket request into the canonical HTTP Responses path, so
Switchyard itself receives plain HTTP JSON. This is not a client fallback and
does not authorize a second WebSocket implementation in Switchyard.

The common `priority` tier may pass because every configured Luna and Sol
target supports it. Sol-only tiers stay hidden from the public routed entry.
