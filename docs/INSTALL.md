# Windows installation and updates

Codex Router Lite supports the Windows Codex desktop app and native Codex CLI.

## Requirements

- Windows 10 or Windows 11
- Windows PowerShell 5.1 or PowerShell 7
- Node.js 22.19 or newer
- Python 3.10 or newer, or `uv`
- an installed Codex build

Clone and install:

```powershell
git clone https://github.com/stevennitesh/codex-router-lite.git
Set-Location codex-router-lite
.\install.ps1 -Target codex
```

The installer preserves the current Codex login and user-owned settings. It refuses to replace an unmarked base URL, foreign scheduled task, or unrecognized source root.

The Router starts in native-only mode without an OpenRouter credential. Provider
health reports OpenRouter as unavailable until the optional key is configured;
native Codex requests remain available during that setup interval.
The frontend starts before the optional API forwarder, LiteLLM, Switchyard, and
catalog watcher become ready. Their bounded supervision keeps native serving
available during an optional-child failure. The installer still prepares Python
dependencies; a missing or unhealthy gateway prevents GLM service, not frontend
liveness.

To use OpenRouter routes, set the credential with the protected prompt:

```powershell
.\model-router.ps1 codex provider-key openrouter set
```

Switchyard installation is maintainer work. Read its
[integration boundaries](../config/switchyard/README.md), then
[build and deployment](../config/switchyard/maintenance.md) only when that task applies.

## Verify

```powershell
.\model-router.ps1 codex status
.\model-router.ps1 codex doctor
```

The scheduled task and process must agree on launcher path, arguments, source root, and generation. A task-name match alone is not proof.

Initial process-record creation allows cold Windows PowerShell probes 45 seconds
and retries a timeout once. Ordinary ownership and stop probes retain their
five-second budget. A completed negative probe is not retried, and private-state
ACL failures still prevent publication.

`/live` proves frontend liveness and service identity. `/health` and Doctor check
dependency readiness; a live frontend can still report degraded optional routes.
The service wrapper uses `/live` during launch. Verify full `/health` and Doctor
for deployment acceptance; frontend liveness alone does not establish that the
selected providers are ready.

The model picker lists Novita and GMICloud as separate GLM routes. Selecting
one changes only that request. Router never falls back from one endpoint to the
other.

Pareto is pinned to the exact Unbiased endpoint. It has automatic tool selection
and provider-controlled reasoning. See its [endpoint contract](agents/pareto.md)
for measured capabilities and the authoritative [application index](../v2_agent/README.md)
for current exact-route subagent eligibility.

The running service checks every five minutes for an installed Codex binary or
native account-catalog change. When signed in, it refreshes account visibility
from Codex's fixed ChatGPT model endpoint into a protected Router snapshot;
Codex retains sole ownership of `models_cache.json`. It republishes current
local picker, provider, authentication, and subagent settings even when the
native capture is unchanged, while leaving unchanged output untouched. A
failed publication retries on the next pass. A successful automatic refresh
does not restart Router. Fully quit
and reopen the Codex app to reload its picker. Use `model-router.ps1 codex
refresh-catalog` only for an immediate manual check.

## Update

Check for or apply a published Router Lite update from `origin/main`:

```powershell
.\model-router.ps1 codex update check
.\model-router.ps1 codex update
```

The updater accepts this Router Lite repository as `origin`, fast-forwards only
when the remote is ahead, and runs the installer. It refuses diverged history
and restores the previous revision if installation fails. The read-only
`upstream` remote is research input and is never an update target.

After a Codex app, Codex CLI, Router upstream, or Switchyard upstream change,
run the compatibility refresh from the source repository:

```powershell
.\maintenance\refresh-compatibility-state.ps1
```

If it reports upstream or app-version drift, follow the conditional branch in
`docs/agents/compatibility-maintenance.md`. Use `-AnalyzeUpstream` only when an
upstream head moved. The original Router remote is reviewed selectively and is
never an installation or merge source.

`maintenance/windows-package.json` is the complete installed file list.
`deploy-codex-router.ps1` compares the managed files before activation, stages and
hash-checks the candidate, and removes only files recorded by the prior deployment
manifest. Identical files and recognized documentation/test/evidence-only changes
skip runtime installation; source/configuration changes use the guarded replacement
path. If runtime install or Doctor fails, it restores, reinstalls, and checks the
previous generation before returning the candidate failure.

For a separate installed directory, deploy edited source from the current checkout with:

```powershell
.\deploy-codex-router.ps1 -InstallDir <installed-router-directory>
```

When the active service runs directly from this checkout with Switchyard, use
the [checkout deployment transaction](../config/switchyard/maintenance.md#deploy-and-roll-back).
It retains an unchanged Switchyard binary when supplied as the candidate and
restores Router through an exact previous checkout on failure. The separate-directory
deployer above rejects overlapping source and destination paths.

Restart the existing installed files only when a configuration or provider
selection change requires it:

```powershell
.\restart-codex-router.ps1 -InstallDir <installed-router-directory>
```

Do not run a standalone stop. The transaction stages one generation, checks readiness, and restores the prior generation on failure.

### Replacement and drain

`src/service.mjs` serializes service mutations and asks the running Router to drain
before install, stop, restart, or uninstall. The drain endpoint accepts only the
internal service capability. It rejects new inference while admitted requests
settle, including nested Switchyard callbacks. An outstanding Switchyard tool
workflow also defers normal replacement between requests; zero active sockets
does not prove that the workflow finished.

A timeout or workflow conflict restores admission and leaves the running generation
unchanged. A live older generation without drain support also defers normal
replacement. Settle the active work before retrying. Only an explicit operator
choice to interrupt it permits the force option: `-ForceServiceReplacement` on
the install, separate-directory deploy, or restart PowerShell entrypoint, or
`--force-service-replacement` on update/service commands. Force never bypasses
service identity or credential checks. The updater's separate `--force` flag can
discard tracked checkout edits; it is not the service-interruption option.

Catalog publication uses its existing refresh owner and does not hot-install
route code. The separate-directory deployer classifies file changes through
`src/deployment-classification.mjs`; other entrypoints retain their own guarded
transactions. Do not infer that every update is restart-free from its Git diff.

Apply source edits, deployment, restart, commit, and push only within the effects
authorized by the user. Authorization for one does not imply the others.
