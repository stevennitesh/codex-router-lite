# Compatibility maintenance

Use this guide for installed Codex drift, Windows Codex app behavior, OpenRouter GLM-5.3-Flash, or shared routing code. Do not load the Switchyard build guide or subagent certification unless that branch applies.

## Refresh current authority

Before editing:

1. Read `git status --short`, the active branch, `HEAD`, and `git remote -v`.
2. Fetch `origin` and each relevant upstream without merging.
3. Resolve the Codex executable used by the current Windows app or shell. Record `codex --version`.
4. Run `node scripts/check-codex-catalog-compat.mjs <codex-executable>`.
5. Read `.\model-router.ps1 codex status` and `.\model-router.ps1 codex doctor` without changing the service.
6. Confirm whether the user authorized source edits, dependency changes, deployment, restart, commit, and push. These are separate permissions.

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
