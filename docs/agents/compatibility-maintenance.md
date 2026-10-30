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
catalog and namespace-relay tests. It also checks saved Web configuration and
adapter ownership: finding a new CLI does not establish that the configured Web
runtime still exists or that the app loaded a compatible adapter. Disabled Web
without an adapter needs no Web setup. `-AnalyzeUpstream` adds detail only for upstream
drift: relevant original-Router changes and a disposable Switchyard checkout to
test the ordered patches. It does not merge, rebuild, deploy, advance the review
baseline, or consume model quota. Omit that flag for diagnostics alone.
Its Web status reuses the coordinated runtime planner: a valid stale installation
reports `refresh-required` and the single apply command, while unconfirmed
anchors and actual ownership conflicts retain separate recovery instructions.

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
| ChatGPT Web browser runtime, connector, saved context or Stop adapter | [Web integration](web-integration.md); [adapter compatibility](web-integration.md#adapter-installation-and-rollback) |
| GLM endpoint policy, chat translation, hosted search, or Python dependency pins | [OpenRouter GLM](openrouter-glm.md) |
| DeepSeek endpoint policy or direct Responses compatibility | [OpenRouter DeepSeek](openrouter-deepseek.md) |
| Pareto endpoint policy or direct Responses compatibility | [Pareto](pareto.md) |
| Shared request/history preparation or Responses conversion | [Request preparation](request-preparation.md) |
| Switchyard source, routes, build, health, or deployment | [Switchyard integration](../../config/switchyard/README.md) |
| Exact-route subagents v2 | [Subagent certification](../SUBAGENT-CERTIFICATION.md) |
| Windows installation or update | [Installation](../INSTALL.md) |
| Service failure or rollback | [Troubleshooting](../TROUBLESHOOTING.md) |

For stale Web runtime anchors, `model-router.ps1 codex web refresh-runtime` plans
a coordinated refresh using the configured native runtime. Its `--apply` path
updates the adapter and saved browser settings through their existing ownership
and service-replacement gates. Use an explicit `--manifest` when current native
configuration cannot identify a unique valid candidate. See
[Web refresh](../CHATGPT-WEB.md#refresh-after-a-codex-update); live readiness still
requires verification after the reported Codex restart.

When an app update removed the configured Web files, catalog publication and
startup can reject deployment before it can repair the stale runtime. Use the
[independent Web maintenance entrypoint](../CHATGPT-WEB.md#refresh-after-a-codex-update)
from a reviewed clean source candidate to refresh the validated runtime first,
then run the existing guarded checkout deployment in-process and replan the adapter against the
installed dependencies. It applies only a changed final adapter. Prepare its
hidden independent worker while Codex is open, fully quit normally, and reopen
once after the protected result reports success. The worker revalidates source
and runtime identities around the exit wait and retains all rollback artifacts;
With `-ReopenCodexOnSuccess` it revalidates the prepared registered app identity
and asks Windows to reopen Codex only after durable accepted success and lock
release. Activation has a separate outcome and cannot undo accepted software;
the default remains manual reopen. It does not claim live Web rollback qualification.
When explicitly authorized to interrupt blocking Router requests, the direct
coordinator remains
`model-router.ps1 codex web refresh-runtime --apply --force-service-replacement`
for replacement. The override requires `--apply`. Normal refresh keeps all three
Web counters known zero. Forced maintenance can preserve uncertain Send records
only after known zero active turns and unresolved actions, settled Router
requests, and fresh positive absence proof for the full native host and both
old/current adapter and official child cohorts. Unknown process inspection or
work counters withhold mutation. Protected valid ledgers remain byte-identical,
saved unresolved native actions block every forced branch, and replay protection
stays active. Candidate binding is checked again inside refresh; the final plan
must retain the reviewed official cohort. Recovery remains strict about new active or
unknown work. Do not run a separate forced drain
before refresh: candidate validation must finish before admission closes, and
the coordinator must own admission recovery if installation fails before reload.

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
