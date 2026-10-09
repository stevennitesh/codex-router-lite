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
   dispatch and the Responses lifecycle. `src/responses-websocket.mjs` uses a
   persistent native upstream WebSocket for caller-owned native sessions;
   external and substituted-session requests re-enter the HTTP handling path.
   Native `response.interrupt` controls bypass the generation queue and new-request
   admission, and target only the response identified on that connection. The
   supported mode is `discard_partial_items`. A valid `response.incomplete` with
   reason `interrupted` preserves the upstream continuation and its retained
   output; it remains an interrupted outcome and does not complete a tool workflow.
2. Router dispatches by the selected model's registered capability and the
   endpoint's native-session requirements. Native endpoints preserve native
   authorization and reach the native backend. Registered external routes use
   [request preparation](request-preparation.md) to translate tools/history and
   retain a request-local namespace map.
3. Ordinary GLM requests use `src/litellm-config.mjs` and the pinned Python gateway
   for Responses-to-chat translation. A route whose profile supports direct
   Responses, and a GLM request that qualifies for hosted search, bypasses that
   translation. Both external paths use `src/api-forwarder.mjs` for the protected
   OpenRouter credential. `src/openrouter-request.mjs` owns final payload
   validation and endpoint policy.
4. Response transforms restore native tool identities and event structure before
   Codex executes tools. Router does not execute the returned app tools itself.
5. Switchyard is a separate authenticated loopback hop: the public slug selects
   its classifier route, bounded task text goes to OpenRouter/Jev, and the chosen
   target returns through Router to the native backend. Read its
   [trust and routing contract](../../config/switchyard/README.md) only for that path.

## Boundaries and identities

| Boundary | Supported surface | Authentication and identity | Failure behavior |
| --- | --- | --- | --- |
| Public Router HTTP | `GET /v1/health`, `GET /v1/models`; `POST /v1/responses`, `/v1/responses/compact`, `/v1/embeddings`, `/v1/images/edits`, `/v1/images/generations`, `/v1/alpha/search` | Loopback caller capability in the managed path, or an accepted bearer on direct `/v1/*`; native session identity is retained only for native hops | Known local validation errors use HTTP status plus stable `error.code`; `error.type` retains its boundary-specific compatibility value. Upstream error passthrough and post-header terminal stream errors keep their existing semantics. |
| Public Responses WebSocket | Upgrade on `/v1/responses` | Same caller capability or accepted bearer as HTTP | Caller-owned native sessions retain incremental upstream continuations; external and substituted-session requests use the HTTP adapter. A rejected 404/405/426 native handshake can use HTTP before sending a generation request; a sent request is never replayed after a disconnect. |
| Private Switchyard hop | Router to the configured loopback `/v1/responses` target | Dedicated Switchyard capability; `gatewayModel` selects the Switchyard classifier route | A rejected encrypted-task extraction supplies a null projection, which invokes Switchyard's local zero-Jev fallback. |
| Private external-provider hops | Router to LiteLLM and/or `api-forwarder`; `/chat/completions` is internal-only, while direct hosted-search Responses uses the forwarder | Dedicated internal capability between local services; the forwarder alone owns the provider credential | The forwarder repeats Router-owned validation and preserves provider responses; it never receives native account headers. |

Identity terms are deliberately distinct:

| Term | Meaning |
| --- | --- |
| Public slug | The model name Codex selects and sends to Router, such as `openrouter/pareto`. |
| `gatewayModel` | The private local dispatch identity used for the external gateway or Switchyard classifier route. |
| `upstreamModel` | The provider model sent by an external route. On the Switchyard facade it is the native compaction model, not the model that serves every selected answer. |
| `routing_id` | A Switchyard-local target identity that distinguishes policy variants, including multiple efforts for the same native model. |
| `requestProfile` | The checked-in preparation and validation policy selected for a route. |
| Transport | The concrete hop shape chosen by that profile: native Responses, direct Responses, or chat translation. |

For example, public `switchyard/auto` dispatches as gateway route
`switchyard-auto`. Jev can select candidate `astra_xhigh`, whose target
`routing_id` is `switchyard/astra-xhigh`; that target sends native model
`gpt-6-astra` with `reasoning.effort = "xhigh"`. A medium Astra selection has the
same native model but a different `routing_id` and effort, so the native model ID
alone cannot identify the selected policy.

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
| Optional-child recovery and readiness | `src/gateway-supervisor.mjs`, `src/service-readiness.mjs`; [installation](../INSTALL.md#verify) |
| Admission, workflow drain, and replacement classification | `src/router-admission.mjs`, `src/service-drain.mjs`, `src/deployment-classification.mjs`; [replacement policy](../INSTALL.md#replacement-and-drain) |
| Packaged deployment acceptance | `src/deployment-acceptance.mjs`; full health and installed task/process/manifest identity for activation and rollback, without Git or Switchyard-only proof |
| Async directory-lock lifecycle | `src/directory-lock.mjs`; named catalog, overlay, caller-key, and service wrappers retain their paths and policies |
| Synchronous skill ownership lock | `src/atomic-state-lock.mjs`; complete generations have unique owner files, and recovery/release remove only their observed owner and an empty directory |
| Nested transport errors | `src/transport-error-graph.mjs`; health, diagnostics, and retry retain their own eligibility rules |
| Switchyard observation vocabulary | `src/switchyard-observation-contract.mjs`; sanitized writer and historical reader share the schema, independently of serving-policy validation |
| Agent instructions and installed skills | [Context ownership](context-ownership.md) |
| Runtime-bound subagent evidence | [Certification](../SUBAGENT-CERTIFICATION.md) |

Keep one active runtime; installed files, catalogs and state are generated output.
Use `generated/` or a disposable temporary directory for scratch work and upstream
builds. Do not keep source clones or alternate runtime trees as product files.
Runtime replacement follows the installation transaction, never a standalone stop.

## Verification

Choose the scope once for the candidate, then reuse completed checks at commit,
push, deployment and evidence publication while their inputs remain unchanged:

| Change | Local checks | Live work |
| --- | --- | --- |
| Documentation or accepted evidence only | Affected links and `npm run check` | None |
| Maintenance runner or deployment script | `npm run check` and affected maintenance tests | Exercise isolated fixtures; a live replacement is a separate effect |
| Route metadata or profile | Source checks, affected route tests, current Codex catalog | Actual Router path; native proof only for affected subagent contracts |
| Shared serving or relay behavior | `npm run verify:codex` once, including the defect regression | Guarded deployment and affected exact-route proofs |

After a correction, rerun the check that covers it; broaden only if its impact
changes. Evidence-only publication does not invalidate unchanged runtime tests.
CI's supported Node versions provide separate environment coverage and remain
required. Source correctness, installed readiness and native collaboration are
different claims; each has one owner and an appropriate observation.

For documentation and instruction edits, check affected links, commands, ownership,
and reading paths against their current sources, then run `npm run check`. Shipped
skills are runtime instructions; exercise affected existing checks and keep source
verification distinct from installed behavior. Editorial checks alone do not prove
that new wording improves agent performance.

For behavior changes, add or update a narrow regression and run `npm run check`
and the affected tests. Run `node scripts/check-codex-catalog-compat.mjs --current`
when serving, routing, catalog or Codex compatibility inputs change; maintenance-only
scripts do not require an unrelated catalog capture.
For shared impact, `npm run verify:codex` runs the source checks, full suite, and
current installed-Codex catalog check once. CI uses `npm run verify` because it
does not have an installed Codex. An explicit executable and `--catalog <path>`
remain available when checking a specific build or installed catalog.

`npm run check` syntax-checks root, source, test, script, and maintenance modules
with four bounded workers, then verifies the Python lock, independent product
boundary and literal package import dependencies, accepted applications, and
Switchyard configuration. These gates do
not run model requests. Reuse passing checks for the same source, inputs,
dependencies, and environment; rerun after a relevant change, rather than at
every workflow step. Deployment and certification keep their distinct evidence.
Deployment additionally requires installed hashes and live health/routed evidence;
passing source tests does not renew a runtime-bound proof.
