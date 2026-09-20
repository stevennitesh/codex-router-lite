# Router Lite system specification

Read to understand Router Lite's supported system, invariants, and source owners.
For endpoint work continue with [model onboarding](model-onboarding.md); for a
failure use [debugging](debugging.md).

## Product and source authority

The product is Windows Codex desktop and native CLI compatibility, the explicitly
registered OpenRouter endpoints, Switchyard over native Codex models, and exact-route
subagents. `src/routed-models.mjs` and the route JSON own the supported model set.
A requested new model extends that set deliberately; it does not authorize other
clients, platforms, provider discovery, fallback fleets, Router UIs, or migration systems.

Native GPT routes and the installed Codex catalog stay native unless the task targets
them. Scope each external compatibility transform to the route that needs it.
`maintenance/windows-package.json` owns the complete installed file set;
`scripts/check-product-boundary.mjs` independently enforces the retained product.
Update explicit allowlists for an authorized addition; never disable their checks.

## System invariants

- One capability-protected loopback Router owns the client-facing catalog and
  request lifecycle. It does not expose a public or shared listener.
- Native requests retain native credentials, account headers, and catalog
  authority. External providers never receive those native secrets.
- Every external route has an explicit slug, profile, endpoint policy, and
  capability contract. A failed endpoint does not silently select another one.
- Tool identity, produced history, and response restoration remain request-local
  and reversible across ordinary turns, replay, and compaction.
- One installed generation is active at a time. Deployment is transactional;
  runtime-bound certification applies only to the exact deployed identities.
- Checked-in source and configuration remain authoritative. Generated files,
  installed hashes, and historical evidence describe a runtime but do not redefine it.

## Request flow

1. Codex reaches the capability-protected loopback Router. `src/router.mjs` owns
   dispatch and the Responses lifecycle. `src/responses-websocket.mjs` adapts the
   WebSocket edge into the same HTTP handling path.
2. Native requests preserve native authorization and reach the native backend.
   External requests use [request preparation](request-preparation.md) to translate
   tools/history and retain a request-local namespace map.
3. Ordinary GLM requests use `src/litellm-config.mjs` and the pinned Python gateway
   for Responses-to-chat translation. Direct Responses routes and GLM hosted search
   bypass that translation. Both external paths use `src/api-forwarder.mjs` for
   the protected OpenRouter credential. `src/openrouter-request.mjs` owns its
   final payload validation and endpoint policy.
4. Response transforms restore native tool identities and event structure before
   Codex executes tools. Router does not execute the returned app tools itself.
5. Switchyard is a separate authenticated loopback hop: bounded task text goes to
   OpenRouter/Jev for classification, then the selected answer target returns
   through Router to the native backend. Read its
   [trust and routing contract](../../config/switchyard/README.md) only for that path.

## Boundaries and identities

| Boundary | Supported surface | Authentication and identity | Failure behavior |
| --- | --- | --- | --- |
| Public Router HTTP | `GET /v1/health`, `GET /v1/models`; `POST /v1/responses`, `/v1/responses/compact`, `/v1/embeddings`, `/v1/images/edits`, `/v1/images/generations`, `/v1/alpha/search` | Loopback caller capability in the managed path, or an accepted bearer on direct `/v1/*`; native session identity is retained only for native hops | Known local validation errors use HTTP status plus stable `error.code`; `error.type` retains its boundary-specific compatibility value. Upstream error passthrough and post-header terminal stream errors keep their existing semantics. |
| Public Responses WebSocket | Upgrade on `/v1/responses` | Same caller capability or accepted bearer as HTTP | Each complete WebSocket request re-enters the authenticated HTTP Responses path; the adapter serializes HTTP/SSE results and terminal failures. |
| Private Switchyard hop | Router to the configured loopback `/v1/responses` target | Dedicated Switchyard capability; `gatewayModel` selects the native answer target | A rejected encrypted-task extraction supplies a null projection, which invokes Switchyard's local zero-Jev fallback. |
| Private external-provider hops | Router to LiteLLM and/or `api-forwarder`; `/chat/completions` is internal-only, while direct hosted-search Responses uses the forwarder | Dedicated internal capability between local services; the forwarder alone owns the provider credential | The forwarder repeats Router-owned validation and preserves provider responses; it never receives native account headers. |

Identity terms are deliberately distinct:

| Term | Meaning |
| --- | --- |
| Public slug | The model name Codex selects and sends to Router, such as `openrouter/pareto`. |
| `gatewayModel` | The private local dispatch identity used for the gateway or Switchyard answer route. |
| `upstreamModel` | The provider or native model identity placed on the final upstream request. |
| `requestProfile` | The checked-in preparation and validation policy selected for a route. |
| Transport | The concrete hop shape chosen by that profile: native Responses, direct Responses, or chat translation. |

Native account headers must never reach OpenRouter. For authentication, catalog,
app-tool, or encrypted-handoff changes read [native Codex](native-codex.md); for
credential storage and logging read [security](../../SECURITY.md). Proxy behavior
is owned by `src/proxy-environment.mjs` and `src/fetch-transport.mjs`.

## Other owners

| Concern | Source / conditional guide |
| --- | --- |
| Model metadata, profiles, transport | `src/routed-models.mjs`, route JSON; [onboarding](model-onboarding.md) |
| Tool identity, history and response restoration | `src/namespace-relay.mjs`; [request preparation](request-preparation.md) |
| Compaction source catalog and checkpoint format | `src/compaction-checkpoint.mjs`, callers in `src/router.mjs` |
| Catalog derivation and native authority | `src/catalog.mjs`, `src/native-catalog-source.mjs`; [native Codex](native-codex.md) |
| Paths, overrides and state locations | `src/paths.mjs`; inspect these before runtime work |
| Startup and managed generation | `src/start.mjs`, `src/service.mjs`, `src/service-windows.mjs`; [installation](../INSTALL.md) |
| Agent instructions and installed skills | [Context ownership](context-ownership.md) |
| Runtime-bound subagent evidence | [Certification](../SUBAGENT-CERTIFICATION.md) |

Keep one active runtime; installed files, catalogs and state are generated output.
Use `generated/` or a disposable temporary directory for scratch work and upstream
builds. Do not keep source clones or alternate runtime trees as product files.
Runtime replacement follows the installation transaction, never a standalone stop.

## Verification

For behavior changes, add or update a narrow regression and run `npm run check`,
the affected tests, and the current Codex catalog check. Use `npm test` for shared
impact. Resolve the current executable through `src/codex-binary.mjs`, then run
`node scripts/check-codex-catalog-compat.mjs <codex-executable>`.
Deployment additionally requires installed hashes and live health/routed evidence;
passing source tests does not renew a runtime-bound proof.
