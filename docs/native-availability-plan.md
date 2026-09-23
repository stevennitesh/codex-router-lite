# Native catalog and availability delivery

2026-09-21. Active delivery. Comparison base: `e14a17164c9d04889581049d243c89aa5f3c96fd`.

## Purpose and boundaries

Keep native Codex work available when optional routing components fail, and make
catalog updates recoverable without unnecessary service replacement. The review
identifies two concrete catalog defects: capture freshness can suppress recovery
after failed publication, and an incompatible optional overlay can block valid
native metadata. These are the first delivery slice. Refreshable client discovery
and safer Windows replacement follow as separate, evidence-gated slices.

Current authority: [architecture](agents/architecture.md),
[native Codex](agents/native-codex.md), [installation](INSTALL.md),
[Switchyard](../config/switchyard/README.md), and [security](../SECURITY.md).
Keep native models, credentials, instructions, tools, effort, tier and history
under their existing native contracts. External routes retain only their declared
capabilities. Do not change Jev policy, model choices, provider fallback, or native
payload normalization as a side effect of this work.

Use the existing publisher, supervisor and Windows deployment owners. No new
catalog service, database, permanent proxy, fleet or general deployment framework.
Local implementation and isolated Windows tests are in scope. Installed services,
personal Codex configuration, Git publication and route certification are separate
activation work; this delivery must not replace the running installation.

## Required outcomes

### Catalog publication and ownership

- Separate native-source freshness from publication success. Every refresh derives
  the desired output from a valid native source and current local settings; an
  unchanged capture must not suppress retry after failed publication or local
  visibility, authentication or subagent-setting changes.
- Preserve publication locking, state ownership and rollback. An unchanged catalog
  is not rewritten. Generated agents must converge too, including recovery after
  an earlier failed attempt; source capture alone is not successful publication.
- Validate the native base before deriving optional routes. Invalid native input
  retains the last valid publication and surfaces failure. An incompatible optional
  route is omitted with a bounded diagnostic, including its generated agent; it
  cannot block valid native models or leave an unsafe stale facade advertised.
  Disabled providers are not projected. Preserve strict projection checks.
- Let Codex own `models_cache.json`. Retain account metadata in one Router-owned,
  protected current snapshot rather than writing a competing Codex cache schema.
  Bind freshness and conditional requests to the relevant native identity and
  client version. Never reuse a prior account's visibility as the next account's
  authority. Preserve safe unknown/signed-out behavior and explicit source adoption.

### Native client discovery

- Verify installed Codex capability before selecting a migration. A rich catalog
  endpoint is useful only if the native client can consume it while keeping its
  built-in provider, account authentication and full ModelInfo semantics.
- Keep any supported rich endpoint authenticated and explicit; preserve the generic
  model-list representation for its existing callers. Serve the validated published
  snapshot, with stable change detection, outside catalog construction/probes.
- Prove repeated discovery in the same installed app-server process, including a
  metadata change during an in-flight response and subsequent request semantics.
  A source symbol or CLI accepting an unknown key is not proof of support.
- Do not remove the managed static catalog fallback or claim desktop picker hot
  adoption without installed-client evidence. If this build cannot safely use the
  native refresh path, retain the working static setup, record the exact limitation,
  and avoid speculative configuration or unused endpoint machinery. Desktop UI
  adoption and an isolated app-server result are distinct claims.
- Metadata refresh is not hot installation of new route/profile code.

### Service lifetime and replacement

- Direct native serving starts and remains available independently of optional
  API forwarding, LiteLLM, Switchyard and watcher readiness. Optional startup or
  process failure gets bounded recovery and route-local degraded status; only core
  Router failure ends the managed serving generation. Preserve authentication and
  ownership checks. Do not silently reroute failed requests.
- Reuse existing supervisor mechanics. Optional exhaustion must not become an
  unbounded restart loop or falsely healthy dependent route. Readiness distinguishes
  the live native frontend from the selected optional providers.
- Existing update/deploy entry points distinguish no runtime change, catalog-only
  change and required runtime replacement. Documentation/tests/evidence-only updates
  must not restart serving. Use a conservative runtime classification for unknown
  changes; do not advertise child-only deployment without proving its credential
  and affinity isolation. Whole-generation runtime replacement remains acceptable.
- Before normal Windows replacement, an authenticated admission gate and the
  existing request owner jointly stop new work and allow admitted work to settle.
  A timeout defers replacement and restores admission; force replacement is an
  explicit operator choice. Keep dependent children alive throughout draining.
  A race-prone external poll for zero requests or Windows SIGTERM is insufficient.
- Preserve Switchyard selection through tool-result continuation. Establish how
  existing affinity behaves across replacement before allowing it. If safe retention
  cannot be proved, defer replacement while affected workflows remain outstanding;
  do not equate zero sockets with completed workflows. Resolve this boundary before
  implementing the drain protocol, rather than adding speculative persistence.
- Retain staged validation, identity checks and rollback. Management authorization
  must not be granted by an ordinary model request, and management metadata must
  never reach providers or logs as a secret.

## Delivery checkpoints

**C1 — Recoverable catalog publication.** Implement catalog publication, optional
overlay isolation and Router-owned account snapshot. This checkpoint establishes
the snapshot contract before exposing it to another client mechanism. Required
evidence: capture succeeds/publication fails once/same-source retry succeeds;
unchanged output is stable; local settings converge; enabled-invalid and
disabled-invalid Switchyard cannot block native updates; malformed native input
keeps the prior valid publication; generated agents follow admitted entries;
account/client changes invalidate snapshot reuse and validators; Codex-owned cache
is unchanged. Use real publication callers and existing catalog integration suites.

**C2 — Installed-client refresh capability.** Investigate the installed executable
and applicable current upstream contract, then implement only the supported native
discovery path. Return the empirical support result before changing managed config
behavior. Keep temporary homes/configurations separate from the user's app. Proof
must distinguish rich schema/authentication, same-process refresh, and desktop UI
adoption. Unsupported capabilities produce a documented compatibility decision,
not a custom provider substitution. This checkpoint prevents an unproved migration
from removing the working picker.

**C3 — Optional service isolation and Windows replacement.** First settle the drain
boundary with actual request/continuation and Windows transaction owners; raise any
unresolved affinity question before coding dependent replacement. Implement bounded
optional supervision, readiness and update classification, then authenticated drain
with timeout/resume. Prove on Windows using isolated processes and synthetic local
upstreams: missing/crashed optional components preserve native requests; dependent
routes fail clearly; active HTTP/SSE and WebSocket work completes unchanged; new
work is rejected during drain; timeout restores admission and does not terminate;
successful replacement occurs only after admission is closed and work settles;
unauthorized management is rejected; tool-loop ownership is retained or replacement
is deferred. Test ordinary entry points, not only helpers or Unix signal behavior.

**Final integrated acceptance.** Review the whole diff against the comparison base,
run `npm run verify`, affected tests on minimum Node 22.19 and current Node 24,
current installed Codex catalog compatibility, and package/product checks. Reuse
valid checkpoint evidence; do not spend live provider quota to repeat deterministic
transport fixtures. Update maintained owners and archive this delivery record only
after its accepted scope is complete. No installed migration, zero-downtime claim,
new runtime proof or desktop hot-refresh claim follows from source tests alone.

## Progress

Initial source inspection confirms the early publication skip and unconditional
optional overlay derivation. The existing supervisor already has a bounded gateway
restart pattern, and Router owns active request lifetimes; use those before adding
new machinery. The installed refresh capability and safe workflow drain boundary
remain empirical decisions for their checkpoints.

2026-09-22 C1 implementation candidate: the real catalog entrypoint now reuses a
current native capture while reconciling publication on every watcher pass,
suppresses unchanged catalog and managed-agent writes, isolates enabled optional
projection failures, and stores account metadata in an identity-bound protected
Router snapshot without writing Codex's cache. The focused publication and account
tests pass, `npm run verify` reports 325 passing tests and two platform skips, and
the installed Codex compatibility check passes through the repository resolver.
C1 review round 1 corrected 304 identity revalidation, current-client snapshot
metadata, duplicate first-entry normalization, and explicit-source isolation
from unused account state. C1 is accepted.

2026-09-22 C2 capability decision: the installed binary resolved by the repository
is `codex-cli 0.155.0-alpha.9.2`. Its generated app-server schema exposes
`model/list`, and an isolated strict-config app-server using a protected disposable
home proved that root `model_catalog_json` carries rich reasoning, modality,
multi-agent and service-tier metadata. Rewriting that catalog while the same
app-server remained alive left consecutive `model/list` results on the original
model, confirming startup-only `StaticModelsManager` behavior.

This installed build does not support the proposed rich endpoint input. A custom
provider's `model_catalog_url` fails strict configuration as an unknown field; in
non-strict mode the app-server reports that it is ignored, makes zero requests to
the synthetic authenticated endpoint, and returns bundled models. The built-in
`openai` provider is reserved and cannot be overridden to add the field. Therefore
an in-flight endpoint response and subsequent-request refresh cannot be proved on
this build, and there is no desktop picker hot-adoption evidence.

The `model_catalog_url` claim is valid only for newer upstream source inspected at
pinned `openai/codex` commit
[`639d2478`](https://github.com/openai/codex/tree/639d2478cc2e16d6ca715952d2e726a3aecc024e).
There it is a provider field using `OpenAiModelsManager`: the client sends an
authenticated GET to an absolute catalog URL with `client_version`, expects the
native `{ "models": [...] }` schema, accepts an `ETag`, rejects redirects, bounds
the response to 1 MiB and times out after five seconds. API-key discovery also
requires the `api_key_model_discovery` gate; ChatGPT and configured provider auth
use their provider identity. The ETag is retained for an `X-Models-Etag` change
trigger from a Responses stream; this is not HTTP conditional GET behavior.
Current upstream tests exercise this through a custom provider, which would replace
the built-in provider selection rather than preserve the required native provider
path.

C2 therefore retains the managed static catalog and adds no endpoint or config
migration. The smallest supported next step is to re-run these probes after an
installed update that recognizes the field and exposes an approved built-in-provider
configuration path; only then can same-process in-flight refresh and desktop picker
adoption be acceptance evidence. C3 remains unimplemented and retains its evidence
gate above.

2026-09-22 C3 design-boundary decision: Router startup currently performs every
optional preflight before the frontend exists: it requires and probes the Python
environment, requires both protected secrets, writes LiteLLM configuration, starts
the API forwarder and selected Switchyard, waits for both, starts and waits for
LiteLLM, and only then starts Router and the catalog watcher. After startup, only
LiteLLM has bounded child supervision; an API forwarder, Switchyard or watcher exit
wins the shared race and ends the whole generation. C3 will keep core secret and
catalog validation before Router, start the frontend independently, and reuse the
bounded supervisor policy for each optional child. Missing, invalid or exhausted
optional children remain unavailable with a bounded reason; they do not bypass
route validation, retry forever or silently reroute requests.

The current health model names degraded dependencies and records
`router: "ready"`, but the public `/health` response returns 503 whenever any
dependency is degraded. C3 will add a narrow frontend-liveness probe for service
startup and retain `/health` as dependency readiness for Doctor and operators.
Native serving can therefore be live while a selected optional route fails
clearly, without redefining the existing readiness response. Scheduled-task
identity, launcher/process corroboration, the existing readiness deadline and
Doctor's selected-route diagnostics remain required.

Normal replacement will use a Router-owned admission state and the existing
request execution owner. A loopback management route will require the protected
internal service credential, reject caller and native credentials, and never
forward management data. Closing admission rejects new HTTP, SSE and WebSocket
inference before body or upgrade processing. Work admitted before closure may
finish, and an admitted Switchyard outer request receives a generation-local,
request-specific callback lease so only its nested native callback remains
admissible. Optional dependencies stay alive until the owner reports drained.
WebSocket peers and their active logical requests require explicit registration;
Node's HTTP response tracker and `server.close()` do not own upgraded sockets.
A normal timeout reopens admission and returns a deferred replacement without
changing the installed generation. Explicit force means cancel active HTTP/SSE
work, close WebSockets, and accept interrupted turns before stopping the whole
generation.

Switchyard affinity is an in-memory map keyed by routing identity and capped at
4096 entries. Its tool-control tests prove same-process retention, but a process
restart discards the selected target; the client-visible replay does not carry
that target as reconstructible authority. Zero active requests or sockets is also
insufficient because a client can be executing a tool between requests. C3 will
therefore hold a process-local workflow lease from a Switchyard response that
emits an actionable tool call until the matching continuation reaches a terminal
response or is explicitly canceled. Normal replacement remains deferred while
such a lease exists, including abandoned or indeterminate workflows; force is the
operator escape. This protects planned replacement without inventing crash
recovery or a persistent workflow engine. A drain attempt with an existing lease
defers before closing admission. If an already admitted request creates a lease
while draining, admission reopens and replacement defers, allowing the later
client continuation to use the still-running generation.

Replacement classification will reuse the Windows package file list, staged
hashes, installed deploy manifest and generated catalog owners. Byte-identical
packages are no-ops; documentation, tests, evidence and license-only changes do
not restart serving even when packaged. Known generated catalog and agent metadata
changes remain with the existing refresh/settings publication owners. Route JSON,
unknown source/config drift, removals and missing identity conservatively require
whole-generation replacement because module-level dispatch or profiles may change.
There is no child-only deployment path or second manifest. The drain caller belongs
in the locked service operation used by
install, restart, deploy/update/rollback, provider and credential changes, and the
Switchyard candidate transaction. Explicit stop and uninstall use the same normal
drain by default; only an operator force option permits them to interrupt owned
work. A running old generation without the drain capability makes normal
replacement defer safely: liveness proves identity, not idleness. Its first
migration requires an explicit operator force choice after active work is settled.
Force still requires exact service ownership; a failed probe, wrong identity,
authentication failure or unknown transport is not authorization.

C3 implementation evidence must use redirected Windows service state, synthetic
local children and protected temporary credentials. Exercise the ordinary install,
restart, deploy/update/rollback and Switchyard candidate entrypoints for no-op,
catalog-only and runtime drift; missing and crashed optional children; admitted
buffered HTTP, SSE and WebSocket completion; new-work rejection; client
cancellation; nested Switchyard callback; tool-call idle gap; drain timeout/resume;
first-migration fallback; and explicit force. Tests must retain the service-manager
write guard and make no installed-service or personal-state mutation. C3 remains
unimplemented pending this checkpoint's implementation and review.
