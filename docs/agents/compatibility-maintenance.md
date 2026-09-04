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

Native HTTP and WebSocket requests preserve Codex authorization, account, residency, and FedRAMP headers. External OpenRouter requests must not receive them. Switchyard receives native authorization only through its authenticated loopback hop.

`src/codex-app-tools.mjs` is the captured app-function definition set. Routed tools are flattened for the model and restored to native namespaces before app execution. When Codex changes the tool set, capture it from an ordinary Windows app turn, update the paired Codex build and snapshot, then test a routed round trip.

The scheduled-task launcher, arguments, source root, ACL, generation, and running process form one service identity. A same-named foreign task is a conflict.

## OpenRouter GLM-5.3-Flash

The only OpenRouter route is `openrouter/glm-5.3-flash`, upstream `z-ai/glm-5.3-flash`, fixed to NovitaAI with fallback disabled. Read `config/openrouter/glm-5.3-flash.json` for its current context, efforts, modalities, and provider policy.

The route uses LiteLLM to translate Codex Responses traffic. `src/zai-responses-compat.mjs` repairs the observed missing message lifecycle for this exact route. Keep repairs scoped to the owner that exhibits the defect.

For a compatibility failure, preserve a sanitized event sequence and identify the first divergence among Codex, Router, LiteLLM, OpenRouter, NovitaAI, and the model. Reproduce through an ordinary Codex caller. A direct endpoint success is not Codex compatibility proof.

Do not enable fallback or add another OpenRouter model as an outage response. A new provider or model is a separate product decision.

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

## Proof

Run:

```powershell
npm run check
npm test
node scripts/check-codex-catalog-compat.mjs <codex-executable>
```

Use the narrowest additional test that distinguishes the defect. Tests do not authorize deployment. After an authorized deployment, verify the installed source and package manifest, scheduled-task identity, Router health, selected-provider health, and one ordinary routed behavior.
