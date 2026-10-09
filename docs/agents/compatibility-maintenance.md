# Compatibility maintenance

Use this guide after a Codex app/CLI update or for an upstream review. An app
update includes both native compatibility verification and review of relevant
Router and Switchyard upstream changes; a passing catalog check alone is not
completion. For adding a model use [onboarding](model-onboarding.md); for a wire
failure use [debugging](debugging.md). Load build or certification guides only
when the selected change requires them.

## Refresh current authority

From the repository root, refresh diagnostics and inspect changed upstream heads
in one invocation:

```powershell
.\maintenance\refresh-compatibility-state.ps1 -AnalyzeUpstream
```

It fetches repository heads, resolves and signature-checks the current Windows
Codex build, records the bundled app-tools plugin identity when available,
checks the current native catalog, reads Router health, and runs source checks plus
catalog and namespace-relay tests. `-AnalyzeUpstream` adds detail only for upstream
drift: relevant original-Router changes and a disposable Switchyard checkout to
test the ordered patches. It does not merge, rebuild, deploy, advance the review
baseline, or consume model quota. Omit that flag for diagnostics alone.

Choose source-test scope using the [common verification rules](architecture.md#verification).
Use `-FullTests` when shared changes or an unresolved regression need the full
suite. Use `-SkipTests` when existing source checks still cover unchanged inputs;
the current binary, catalog and health are still inspected. Skipped checks remain
unperformed in this report; the command does not certify model execution or
Desktop app tools.

`-SkipFetch` suppresses all upstream network requests, including Switchyard
discovery and cloning. It can inspect locally available Router refs, but leaves
current upstream heads unconfirmed. Do not declare upstream current from an
offline report.

Before editing, confirm the report accounts for:

1. The working tree, active branch, `HEAD`, `origin/main`, and `upstream/main`.
2. The Windows package, resolved executable, signature, and `codex --version`.
3. Native catalog parsing and the installed bundled app-tools plugin identity when available.
4. Router health and the selected source checks, including any valid reused result.
5. The locked and current Switchyard upstream commits when that route applies.
6. Which effects the user authorized: source edits, dependency changes, deployment,
   restart, commit and push. Existing authorization covers those effects; request
   only missing authority at the relevant step.

Router Lite does not ship a static Desktop app-tool schema snapshot.
Desktop-only tools are private host capabilities and can change independently of
the CLI. Runtime authority is always the caller's request-local tool definitions,
tool-search discoveries, and namespace metadata. Compatibility tests use
synthetic namespace fixtures so a Desktop patch cannot silently turn historical
schemas into product authority.

For a changed Windows app or CLI build:

1. Record the Windows app, CLI, and bundled `codex-app-tools` plugin versions
   when the current CLI exposes them.
2. Use the refresh's current catalog check and scoped tests; do not repeat them
   unless their inputs changed. Publish a refreshed catalog only when needed.
3. Inspect the official Codex release notes/source for changes to model metadata,
   tool exposure, namespace behavior, or app-server transport. Capture the live
   Desktop registry only when investigating an actual app-tool failure; do not
   copy private Desktop schemas into Router source.
4. If encrypted assignment or readable-child handling changed, or current evidence
   leaves compatibility unresolved, use quota authority for a fresh native child
   and a synthetic encrypted assignment. Verify the representation is recognized and the exact
   plaintext is recovered, then verify a readable routed-child assignment stays
   readable. Record the tested app/CLI identity in sanitized compatibility
   evidence without retaining ciphertext or private task text. A new
   representation requires investigation and withholds acceptance for the
   affected path; catalog success alone is insufficient.
5. If tool exposure, namespaces or transport changed, or a regression is suspected,
   use quota authority for an ordinary routed tool call through affected profiles.
   Include Switchyard and Pareto only when their path is affected.
6. Refresh affected exact-route proofs when a bound contract changed, using
   [the certification refresh conditions](../SUBAGENT-CERTIFICATION.md#when-to-refresh-proof).

An app version alone does not require paid probes. Collect each needed observation
once for the same installed candidate and exact route. A certification sequence
can supply its tool, handoff and continuation observations; retain a separate
probe only for behavior it does not establish, such as Desktop-only app tools or
the recovered classifier assignment.

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

Follow the [common verification scope](architecture.md#verification) for any repair.
Reuse the refresh's passing checks until relevant inputs change, then run the
narrowest check that distinguishes the defect. After authorized deployment, use
its [acceptance result](../INSTALL.md#update). Add a routed observation only for
changed or unresolved serving behavior, reusing certification when it covers
that claim. Source tests do not establish live readiness.
