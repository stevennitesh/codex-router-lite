# Compatibility maintenance

Use this guide for installed Codex drift, Windows Codex app behavior, OpenRouter GLM-5.3-Flash, or shared routing code. Do not load the Switchyard build guide or subagent certification unless that branch applies.

## Refresh current authority

From the repository root, run the read-only refresh first:

```powershell
.\maintenance\refresh-compatibility-state.ps1
```

It fetches repository heads, resolves and signature-checks the current Windows
Codex build, compares it with the checked-in app-tool snapshot, checks the
current native catalog, reads Router health, runs the retained suite, and
reports Switchyard upstream drift. It does not edit files, consume provider
quota, or restart the service. Use `-SkipFetch` only when offline and
`-SkipTests` only for a quick diagnostic that will not support a compatibility
claim.

The default run reports how many original Router commits remain unreviewed
since `maintenance/upstream-router.json`. When either upstream moved, request
the conditional detail only then:

```powershell
.\maintenance\refresh-compatibility-state.ps1 -AnalyzeUpstream
```

This groups relevant original-Router changes and, for a changed Switchyard
head, uses a disposable checkout to list commits and test whether the canonical
patch still applies. It does not merge, rebuild, deploy, or advance the review
baseline.

Before editing, confirm the report accounts for:

1. The working tree, active branch, `HEAD`, `origin/main`, and `upstream/main`.
2. The Windows package, resolved executable, signature, and `codex --version`.
3. Native catalog parsing and the app-tool snapshot's paired build.
4. Router health and the retained product checks.
5. The locked and current Switchyard upstream commits when that route applies.
6. Whether the user authorized source edits, dependency changes, deployment,
   restart, commit, and push. These are separate permissions.

An app-tool snapshot version mismatch is a required manual branch, not an
automatic failure. Inspect the official Codex release notes and diff, capture
the live tool registry from an ordinary Windows app turn, then update the
snapshot and its narrow relay regression only when the contract changed.

For a changed Windows app or CLI build:

1. Capture the native app namespace, tool names, and JSON schemas from an ordinary
   Windows app turn.
2. Compare that inventory with `src/codex-app-tools.mjs`; a version change alone
   does not prove a tool change.
3. Refresh the native catalog and run the catalog, app-tool, and
   namespace-relay tests.
4. Run one native routed tool call through GLM and Switchyard.
5. Refresh both exact-route v2 proofs only when tool relay or child continuation
   changed.

Never copy a versioned Codex app path into source. Never print keys, bearer tokens, account IDs, capability values, or unredacted protected metadata.

## Ownership map

| Change | Read next |
| --- | --- |
| Native catalog, headers, app functions, namespace relay, or GLM | The matching section below |
| Switchyard source, routes, build, health, or deployment | `config/switchyard/README.md` |
| Exact-route subagents v2 | `docs/SUBAGENT-CERTIFICATION.md` |
| Windows installation or update | `docs/INSTALL.md` |
| Service failure or rollback | `docs/TROUBLESHOOTING.md` |

The four routed JSON files under `config/openrouter` and `config/switchyard` own checked-in route metadata. `maintenance/windows-package.json` owns the installed file set. Generated catalogs, installed files, logs, and proof records are evidence, not source.

## Native Codex and the Windows app

Native GPT entries come from the installed Codex catalog. Preserve unfamiliar fields generically. Never replace the native catalog with a copied list.

The managed service runs `catalog.mjs --refresh-if-stale` every five minutes in
a separate watcher process. The freshness identity is the resolved Codex
binary path, file identity, reported version, and the content fingerprint of
the current account or explicitly adopted native catalog. While signed in, the
locked refresh may update Codex's own `models_cache.json` only from the fixed
ChatGPT account-model endpoint. It bounds the response, rechecks account
identity before writing, never stores credentials, and preserves the prior
cache on every network, schema, or account-switch failure. Cache validators
belong to one CLI version: upgrades fetch unconditionally and older clients
cannot overwrite newer caches. Publication uses
the normal state-ownership guard, catalog lock, and rollback path. A failed
refresh leaves Router serving and retries on the next interval. The watcher
does not override native `visibility` or manufacture account entitlements.

Native HTTP and WebSocket requests preserve Codex authorization, account, residency, and FedRAMP headers. External OpenRouter requests must not receive them. Switchyard receives native authorization only through its authenticated loopback hop.

`src/codex-app-tools.mjs` is a reference snapshot for drift inspection. Runtime
relay uses the caller's definitions and native tool-search discoveries, without
adding snapshot tools. Current app tools use `mcp__codex_app`; legacy namespaces
remain supported when explicitly supplied. Routed tools are flattened for the
model and restored to those request-local identities before app execution.
When Codex changes the tool set, capture it from an ordinary Windows app turn,
update the paired build and snapshot, then test a routed round trip.

Child completion and cancellation belong to Codex and the caller. Relay only
model-authored collaboration calls; injecting an interrupt after a prior final
answer can cancel a newly resumed child.

Encrypted child handoffs preserve native 401 and 429 failures. A 429 suppresses
repeat handoffs for the same account-scoped payload for 60 seconds, with at most
128 failure entries. Native compaction metadata may be absent, null, or numeric;
compatibility checks must compare against the current native model contract.

The scheduled-task launcher, arguments, source root, ACL, generation, and running process form one service identity. A same-named foreign task is a conflict.

## OpenRouter GLM-5.3-Flash

Both OpenRouter routes use upstream `z-ai/glm-5.3-flash`. The canonical
`openrouter/glm-5.3-flash` route is pinned to Novita. The explicit
`openrouter/glm-5.3-flash-gmicloud` route is pinned to GMICloud. Each route
selects one endpoint with fallback disabled and owns its endpoint compatibility
flags and v2 proof. Do not turn the two records into an ordered fallback list.
To add or replace an endpoint, create or update one exact route, then refresh
that route's proof before publishing v2.

Ordinary GLM traffic uses LiteLLM to translate Codex Responses traffic.
`src/zai-responses-compat.mjs` repairs missing message envelopes, separates
message IDs reused from reasoning items, and closes assistant text before an
overlapping tool-call lifecycle on the two exact GLM routes. Test these repairs
through the namespace relay: a duplicate identity can disable restoration of
a later app call. Keep the generic relay's identity checks intact.

Fresh hosted-search turns bypass the Chat Completions translation and use the internal OpenRouter forwarder's direct Responses path. `src/openrouter-hosted-search.mjs` maps only native `web_search` and `web_search_preview` tools to the bounded `openrouter:web_search` server tool, restores returned items to `web_search_call`, preserves citations and sources, and reverses completed search history on another direct-search turn. A plain function named `web_search` is unrelated and must remain unchanged. Keep the checked-in Exa engine, result and call limits, exact endpoint policy, and fallback prohibition together. OpenRouter reports live search usage under `server_tool_use_details`; tolerate the documented `server_tool_use` spelling in diagnostics, but never infer zero from an absent field.

After a hosted-search change, test non-streaming output, split SSE item and terminal events, exact completed-history replay, citation/source preservation, mixed ordinary tools, and the internal forwarder's fail-closed bounds. A direct OpenRouter success is still not Windows Codex compatibility proof; deployment acceptance requires one ordinary app search turn and must treat a provider 429 as capacity rather than a schema failure.

For a compatibility failure, preserve a sanitized event sequence and identify the first divergence among Codex, Router, LiteLLM, OpenRouter, the selected endpoint, and the model. Reproduce through an ordinary Codex caller. A direct endpoint success is not Codex compatibility proof.

Do not enable fallback or select an unproved endpoint as an outage response. A new endpoint or model is a separate product decision.

### Python dependency lock

Load this branch only when changing the LiteLLM or FastAPI pins. Update
`PYTHON_REQUIREMENTS` in `src/install-plan.mjs` and `requirements/python.in`
together, then regenerate the compiled lock from the repository root:

```powershell
uv pip compile --python-platform windows --generate-hashes --python-version 3.10 --output-file requirements/python.txt requirements/python.in
```

Run `npm run check` afterward. It rejects mismatched direct pins, a lock without
the required compile flags or hashes, and installer commands that bypass the
lock. Booting the gateway remains required before accepting a dependency
upgrade; a successful resolution alone does not prove runtime compatibility.

## Root-cause rule

Fix the first owner that violates its contract. A compatibility transform is justified only when the upstream wire behavior cannot be changed here. It needs an exact scope predicate and a regression that fails without it. Delete transforms that current retained routes do not use.

Do not retain adapters, aliases, migration journals, discovery code, or generic registries for hypothetical future products.

## Original Router upstream

The `upstream` remote is research input. Never merge it into Router Lite.
`maintenance/upstream-router.json` records the last upstream commit whose
changes were dispositioned. Review only the commits after that pointer, map
useful fixes to retained Router Lite owners, and advance the pointer only after
every reported commit is accepted, rejected, or recorded for later work.

Prioritize changes involving routed Responses lifecycle, native account or
catalog handling, Windows service behavior, namespace restoration, and the
OpenRouter GLM route. Ignore providers, clients, UI code, and compatibility
families outside this repository's product boundary.

## Proof

Run:

```powershell
npm run check
npm test
node scripts/check-codex-catalog-compat.mjs <codex-executable>
```

Use the narrowest additional test that distinguishes the defect. Tests do not authorize deployment. After an authorized deployment, verify the installed source and package manifest, scheduled-task identity, Router health, selected-provider health, and one ordinary routed behavior.
