# Compatibility maintenance

Use this guide when Codex, the Windows Codex app, OpenRouter,
GLM-5.3-Flash, or Switchyard changes. It owns the compatibility workflow and
the boundaries between those systems. Installation procedures and unrelated
provider integrations remain in [router-maintenance.md](router-maintenance.md).

Do not treat a version number, an upstream branch head, a generated proof, or
an installed file as permanent truth. Refresh the evidence below for every
maintenance task.

After the refresh, load only the relevant branch:

- native Codex catalog, headers, app tools, or Windows app: read **Native Codex
  and Windows app contract**;
- `openrouter/glm-5.3-flash`: also read **GLM-5.3-Flash through OpenRouter**;
- Switchyard: read **Switchyard**, then follow the linked Switchyard-only guide;
- `multiAgentVersion`, selection, or proof work: leave this guide and read
  [`SUBAGENT-CERTIFICATION.md`](../SUBAGENT-CERTIFICATION.md).

## Source-of-truth map

| Concern | Authority |
| --- | --- |
| Repository policy and routing to detailed instructions | [`AGENTS.md`](../../AGENTS.md) |
| Retained runtime roots, configuration inputs, and temporary retirement adapters | [`maintenance/retained-boundary.json`](../../maintenance/retained-boundary.json) and `scripts/check-retained-boundary.mjs` |
| Retained deterministic test definition and comparable baseline method | [`maintenance/retained-tests.json`](../../maintenance/retained-tests.json), `scripts/run-retained-tests.mjs`, and `scripts/capture-retained-baseline.mjs` |
| Router installation, client setup, credentials, and provider procedures | [`router-maintenance.md`](router-maintenance.md) |
| Routed model metadata and provider policy | `config/<provider>/*.json`, then `src/catalog.mjs` |
| GLM request and stream compatibility | `src/request-profiles.mjs`, `src/instruction-profiles.mjs`, `src/api-forwarder.mjs`, `src/litellm-config.mjs`, and `src/zai-responses-compat.mjs` |
| Codex catalog compatibility | `scripts/check-codex-catalog-compat.mjs` and `test/catalog.test.mjs` |
| Codex native session and header boundaries | `src/codex-native-session.mjs` and `test/routing.test.mjs` |
| Codex app tool restoration | `src/codex-app-tools.mjs` and `test/codex-app-tools.test.mjs` |
| Windows service lifecycle | `src/service-windows.mjs`, `restart-codex-router.ps1`, and the Windows operation tests |
| Switchyard source, patch, build, and deployment | [`config/switchyard/README.md`](../../config/switchyard/README.md) |
| Exact-route multi-agent claims | [`SUBAGENT-CERTIFICATION.md`](../SUBAGENT-CERTIFICATION.md) and `v2_agent/` |

Generated runtime files, live catalogs, support bundles, logs, and certification
proofs are evidence. They do not override checked-in configuration or source.

## Refresh before deciding

Record the following without changing the runtime:

1. Inspect `git status --short`, the active branch, `HEAD`, remotes, and fetched
   upstream heads. Preserve unrelated work. A fetch updates evidence; it does
   not authorize a merge, rebase, or checkout.
2. Resolve the Codex executable that the current app or shell actually uses and
   run `codex --version`. Windows app binaries live under versioned application
   directories, so never copy a previously observed path into source or docs.
3. Read the current native model catalog with the installed Codex build and run
   `node scripts/check-codex-catalog-compat.mjs <resolved-codex-executable>`.
4. Run `./model-router.ps1 codex status` and
   `./model-router.ps1 codex doctor` on Windows. Check Router health, the
   scheduled-task identity, the recorded source root, and selected-provider
   health. A sandbox may legitimately be unable to read protected task
   metadata; repeat that read-only check under the real user authority instead
   of weakening ACLs.
5. For Switchyard, compare the live runtime provenance and binary hash with
   `config/switchyard/source.lock`, the canonical patch, and the active route
   template. Also refresh the upstream repository and release evidence before
   proposing a new pin.
6. For OpenRouter, verify the exact model endpoint, provider availability,
   supported parameters, modality, and context from current primary evidence.
   A provider's generic model page is research input; the checked-in exact
   route remains the runtime contract until it is deliberately changed and
   tested.

Keep secrets, bearer tokens, account identifiers, capability values, and raw
protected metadata out of terminal output, logs, fixtures, and documentation.

## Native Codex and Windows app contract

Native GPT requests remain native. Compatibility work for a routed provider
must not alter Codex-owned native catalog entries, native request behavior, or
the user's ChatGPT session unless that surface is explicitly in scope.

- Derive routed catalog behavior from the current installed native model
  template in `src/catalog.mjs`. Preserve unfamiliar native fields generically;
  do not maintain a hand-copied allowlist that silently goes stale.
- Run the catalog compatibility check after every Codex upgrade and after any
  catalog, model, behavior-template, reasoning-level, or context change.
- Preserve Codex account, residency, and FedRAMP headers on native HTTP and
  WebSocket routes. Do not forward Codex-owned session metadata to external
  providers. Keep the corresponding negative assertions in routing tests.
- Custom models receive app tools through flattened names in the model-facing
  schema. `src/codex-app-tools.mjs` restores the native namespace so the app can
  execute the call. Preserve the full current tool schema rather than
  documenting or hard-coding one frozen tool list.
- Treat Windows Codex executable paths and versions as discovered runtime data.
  The scheduled task's launcher, arguments, source-root manifest, task ACL, and
  running state form one identity. A same-named foreign task is a conflict, not
  something an installer may adopt or overwrite.
- Keep exactly one active Router. Never issue a standalone stop during
  maintenance. If deployment is authorized, use the repository's guarded
  restart entry point; it owns readiness checks and rollback to the previous
  working runtime.

When the app gains a native field or tool, first determine its owner and wire
shape from the installed Codex build. Fix generic propagation or namespace
restoration at that owner. Do not add provider-wide special cases to imitate a
single captured request.

For an app-tool refresh, capture the current Windows Codex Desktop tool schema
from an ordinary live app turn and record the paired Codex build in
`src/codex-app-tools.mjs`. Co-update the snapshot, the installed Router skills
that refer to those tools, doctor expectations, and their tests. The checked-in
test inventory is a regression fixture, not a live-app oracle. Acceptance needs
one routed round trip in which the app executes a current namespaced tool and
returns its result to the model.

## GLM-5.3-Flash through OpenRouter

The checked-in route is `openrouter/glm-5.3-flash`, upstream model
`z-ai/glm-5.3-flash`, pinned to NovitaAI with provider fallback disabled. Its
context, compaction threshold, reasoning ladder, modalities, request profile,
behavior template, and provider policy live in
[`config/openrouter/glm-5.3-flash.json`](../../config/openrouter/glm-5.3-flash.json).
Read that file instead of copying those values into a second catalog.

OpenRouter is sent Chat Completions traffic through LiteLLM, while Codex consumes
Responses events. `src/zai-responses-compat.mjs` repairs the known translated
stream shape only for this exact Router slug. It restores the missing message
item and content-part lifecycle and corrects closing event types without
rewriting unrelated OpenRouter routes.

For a GLM failure:

1. Capture the exact selected slug, upstream model, provider, request profile,
   and sanitized wire-event order. Separate model output, OpenRouter behavior,
   LiteLLM translation, Router relay, and Codex parser ownership.
2. Reproduce through an ordinary Codex caller. A direct provider success does
   not prove Codex compatibility.
3. Add a narrow regression at the layer that owns the defect. Keep stream
   repairs exact-route scoped unless multiple independently verified routes
   share the same protocol defect.
4. Verify text streaming, reasoning, tool calls, image input where applicable,
   and the advertised `low`, `high`, and `max` effort ladder. Bind any v2
   multi-agent declaration to a fresh exact-route proof.

Do not enable OpenRouter fallback or broaden the provider set because an
endpoint is temporarily unavailable. Availability changes require current
endpoint evidence and an explicit route-policy decision.

## Switchyard

Switchyard is a separately built, locally reached native Responses routing
engine. Codex Router still owns client integration, catalog publication,
credentials, health aggregation, and service lifecycle. The Switchyard route
must not become a second owner of the native Codex catalog.

The authoritative integration inputs are the exact upstream commit in
`config/switchyard/source.lock`, the canonical patch, and the route template.
The active runtime under the Codex state directory is generated output. Build
in a disposable checkout, validate the pin and patch hash, run the upstream and
Router integration checks, and deploy only through the guarded transaction in
[`config/switchyard/README.md`](../../config/switchyard/README.md).

Preserve these boundaries:

- loopback-only access and the Router-to-Switchyard capability check;
- no replacement or logging of ChatGPT authorization and account headers;
- redacted routes, provenance, and routing history;
- explicit health and fail-closed behavior when the runtime is unavailable;
- one active runtime, with rollback responsible for restoring the previous
  binary, configuration, provenance, and running state.

An upstream release or `main` update is not an automatic upgrade. Review the
diff from the pinned commit, rebase the canonical patch deliberately, and prove
the final binary corresponds to the reviewed source.

## Root-cause rule

Do not use a workaround where the owning defect can be fixed. Before editing,
identify the first layer where expected and actual behavior diverge. Capture a
minimal sanitized reproduction and name the owner: Codex client, Router,
LiteLLM, OpenRouter, endpoint provider, model, or Switchyard.

Compatibility shims are allowed only when the upstream wire contract cannot be
changed here and the shim is the narrowest stable boundary. Every shim needs an
exact regression, a scope predicate, and an explanation of the upstream defect
it compensates for. Remove it when current evidence proves the upstream defect
is gone.

## Verification and delivery

Run `npm run check`, the affected tests, and the current Codex catalog
compatibility check for every behavior change. Add these focused checks where
applicable:

`npm run check` rejects new transitive dependencies from a retained root into
excluded clients, providers, platforms, Router UIs, process targets, or
configuration inputs. Keep each temporary retirement adapter exact and run
`node scripts/run-retained-tests.mjs` when changing a retained runtime seam.

| Change | Minimum focused evidence |
| --- | --- |
| Codex catalog or native-template propagation | catalog tests plus the installed-Codex compatibility script |
| Native sessions, headers, or WebSockets | routing tests with positive native and negative external assertions |
| App-native tools | app-tool schema and namespace-restoration tests, then an ordinary app call |
| GLM request or stream behavior | profile and routing regressions, then a live Codex stream when authorized |
| Windows service lifecycle | service rendering, identity, rollback, and Windows operation tests |
| Switchyard source or route | pinned upstream tests, Router Switchyard tests, provenance/hash check, and authorized live health |
| v2 multi-agent declaration | fresh certification bound to the exact slug, provider, model, runtime, and proof schema |

Tests do not authorize a deployment. If the user requests a live update, use
the guarded restart or deployment transaction and then prove the installed
source, hashes, task identity, Router health, selected-provider health, and one
ordinary routed behavior. Report if a restart is needed before taking down a
working service unless the user has already authorized it.

Update durable docs only with stable contracts and procedures. Put time-bound
investigation results in a dated research or proof artifact, clearly label that
artifact historical, and keep it out of the common agent path.
