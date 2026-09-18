# Compatibility maintenance

Use this guide after a Codex app/CLI update or for an upstream review. An app
update includes both native compatibility verification and review of relevant
Router and Switchyard upstream changes; a passing catalog check alone is not
completion. For adding a model use [onboarding](model-onboarding.md); for a wire
failure use [debugging](debugging.md). Load build or certification guides only
when the selected change requires them.

## Refresh current authority

From the repository root, run the diagnostic refresh first (it fetches Git refs
and writes disposable analysis evidence, but does not mutate the live runtime):

```powershell
.\maintenance\refresh-compatibility-state.ps1
```

It fetches repository heads, resolves and signature-checks the current Windows
Codex build, compares it with the checked-in app-tool snapshot, checks the
current native catalog, reads Router health, runs the retained suite, and
reports Switchyard upstream drift. It does not edit product source, consume provider
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
4. With quota authority, run an ordinary native routed tool call through the
   affected external profiles and Switchyard; include Pareto when shared relay changes.
5. Refresh affected exact-route proofs when a bound contract changed, using
   [the certification refresh conditions](../SUBAGENT-CERTIFICATION.md#when-to-refresh-proof).

Never copy a versioned Codex app path into source. Never print keys, bearer tokens, account IDs, capability values, or unredacted protected metadata.

## Ownership map

| Change | Read next |
| --- | --- |
| Native catalog, credential forwarding, app tools, namespace relay, or encrypted handoff | [Native Codex](native-codex.md) |
| GLM endpoint policy, Responses repair, hosted search, or Python dependency pins | [OpenRouter GLM](openrouter-glm.md) |
| Pareto endpoint behavior or direct Responses | [Pareto](pareto.md) |
| Switchyard source, routes, build, health, or deployment | [Switchyard integration](../../config/switchyard/README.md) |
| Exact-route subagents v2 | [Subagent certification](../SUBAGENT-CERTIFICATION.md) |
| Windows installation or update | [Installation](../INSTALL.md) |
| Service failure or rollback | [Troubleshooting](../TROUBLESHOOTING.md) |

The route and provider JSON files under `config/openrouter` and `config/switchyard` own checked-in route metadata. `maintenance/windows-package.json` owns the installed file set. Generated catalogs, installed files, logs, and proof records are evidence, not source.

## When a defect is found

Use the [debugging procedure](debugging.md) to isolate the failing owner before
applying an upstream idea. Keep additions within the [product boundary](architecture.md#product-and-source-authority).

## Original Router upstream

The `upstream` remote is research input. Never merge it into Router Lite.
`maintenance/upstream-router.json` records the last upstream commit whose
changes were dispositioned. Review only the commits after that pointer, map
useful fixes to retained Router Lite owners, and advance the pointer only after
every reported commit is accepted, rejected, or recorded for later work. An
app-update review must report native compatibility findings and both upstream
dispositions, including unchanged heads. Keep dated review evidence in
[history](../history/README.md) or the authorized tracker; maintained guides own
only the resulting durable behavior. If fetch is unavailable, report that gap
rather than declaring upstream current.

Prioritize changes involving routed Responses lifecycle, native account or
catalog handling, Windows service behavior, namespace restoration, and the
retained OpenRouter routes. Ignore providers, clients, UI code, and compatibility
families outside this repository's product boundary.

## Proof

Run:

```powershell
npm run check
npm test
node scripts/check-codex-catalog-compat.mjs <codex-executable>
```

Use the narrowest additional test that distinguishes the defect. Tests do not authorize deployment. After an authorized deployment, verify the installed source and package manifest, scheduled-task identity, Router health, selected-provider health, and one ordinary routed behavior.
