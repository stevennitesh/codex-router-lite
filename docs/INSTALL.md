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

An absent multi-agent block end marker can be repaired when its single feature
line exactly matches Router's emitted setting. Modified or ambiguous blocks
still fail preflight; following user settings are preserved.

Managed config editing recognizes quoted TOML keys and marker comments outside
string values. Marker examples inside user instructions are preserved. An
unmarked `model_providers.codex-router` table is refused rather than duplicated.
Disable preserves a user-owned catalog assignment and restores only an explicitly
adopted source; invalid or inaccessible source records stop the edit.

Managed skill publication skips an already owned tree only when bounded content
comparison and source provenance both match. Ownership still requires its
protected token record. Changed skills use the existing recovery transaction;
external content and abandoned-operation recovery retain their own checks.

The Router starts in native-only mode without an OpenRouter credential. Provider
health reports OpenRouter as unavailable until the optional key is configured;
native Codex requests remain available during that setup interval.
The frontend starts before the optional API forwarder, LiteLLM, Switchyard, and
catalog watcher become ready. Their bounded supervision keeps native serving
available during an optional-child failure. The installer still prepares Python
dependencies; a missing or unhealthy gateway prevents GLM service, not frontend
liveness.

Asynchronous launch failures are handled by the child supervisor;
startup retries wait for child closure. A configured Windows batch gateway is
terminated as a tree before retry, so its descendants cannot overlap the next
attempt. A failed cleanup stops retries and is reported in the service log.

To use OpenRouter routes, set the credential with the protected prompt:

```powershell
.\model-router.ps1 codex provider-key openrouter set
```

Switchyard installation is maintainer work. Read its
[integration boundaries](../config/switchyard/README.md), then
[build and deployment](../config/switchyard/maintenance.md) only when that task applies.

## Verify

```powershell
.\model-router.ps1 codex doctor
```

`status` is a compatibility alias for `doctor`; run either once. Doctor is a
diagnostic, not deployment acceptance: warnings can leave its exit status zero.
The deployment transaction separately enforces full health and installed identity.
The scheduled task and process must agree on launcher path, arguments, source root, and generation. A task-name match alone is not proof.

Service operations keep their lock heartbeat active while Windows helpers run.
An unreadable task or process record cannot establish absence. Failed stop
verification retains the process record and refuses replacement; task removal
must be verified before its launchers are removed. Resolve the reported
observation error and retry the operation.

For foreground debugging, run `model-router.ps1 codex start --foreground` after
the managed service has released the listeners. The foreground supervisor holds
the service-operation lock for its lifetime and leaves the managed process record
untouched. Service operations wait and then fail while that lock is held; exit
the foreground supervisor before using managed start, stop, or restart.

Initial process-record creation allows cold Windows PowerShell probes 45 seconds
and retries a timeout once. Ordinary ownership and stop probes retain their
five-second budget. A completed negative probe is not retried, and private-state
ACL failures still prevent publication.

`/live` proves frontend liveness and service identity. `/health` and Doctor check
dependency readiness; a live frontend can still report degraded optional routes.
The service wrapper uses `/live` during launch. Verify full `/health` and Doctor
for deployment acceptance; frontend liveness alone does not establish that the
selected providers are ready.

Readiness owns cancellation of its health fetches and waits when health succeeds,
the task is definitively dead, or the deadline expires. Inconclusive task queries
keep waiting. A health result or deadline can cancel a pending task query;
readiness waits for that helper to close before returning. Health and drain
share the same bounded refusal check; unknown or
mixed transport failures cannot establish that Router is offline.

The model picker labels StreamLake and Together as separate GLM routes, and
Together and DeepInfra as separate DeepSeek routes. Selecting one changes only
that request. Router never falls back to another endpoint.

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
The source checks validate its literal local JavaScript import dependencies, so adding a
runtime helper without packaging it fails before deployment.
`deploy-codex-router.ps1` compares the managed files before activation, stages and
hash-checks the candidate, and removes only files recorded by the prior deployment
manifest. Identical files and recognized documentation/test/evidence-only changes
skip runtime installation; source/configuration changes use the guarded replacement
path. Candidate and restored generations must pass Doctor plus a bounded,
capability-protected full-health check, running owned task and process checks,
and matching install-manifest source root and target. Packaged installations do
not require Git metadata. A diagnostic warning alone does not fail acceptance;
an offline or degraded runtime does. If runtime installation or acceptance fails,
the deployer restores, reinstalls, and accepts the previous generation before
returning the candidate failure. Failed recovery retains its backup and reports
the recovery path without claiming a healthy restoration.

An identical managed file set returns before staging, backup, copying, or
manifest writes. The deployer still validates managed paths and package
membership before taking that path. Source verification is owned by the
[common checks](agents/architecture.md#verification); unchanged results can be
reused through the deployment workflow. Live acceptance still requires health
and installed identity checks.

For a separate installed directory, deploy edited source from the current checkout with:

```powershell
.\deploy-codex-router.ps1 -InstallDir <installed-router-directory>
```

Without `-InstallDir`, the deploy and restart helpers resolve the current source
root from the protected install manifest. They do not assume the bootstrap's
default installation directory. A missing manifest requires an explicit directory.

When the active service runs directly from this checkout with Switchyard, use
the [checkout deployment transaction](../config/switchyard/maintenance.md#deploy-and-roll-back).
It retains an unchanged Switchyard binary when supplied as the candidate and
restores Router through an exact previous checkout on failure. The separate-directory
deployer above rejects overlapping source and destination paths.
The checkout transaction runs in an independent hidden Windows worker and returns
private result and log paths. A completed successful result includes the worker's
`acceptance`: checked identities, installed hashes, full health, catalog and
protected endpoints. Use that result to report deployment acceptance; do not
repeat its entire diagnostic stack. Before releasing a rollback retained through
later live certification, recheck current process ownership and full health.
Its rollback continues if the calling app or tool exits.

Rollback preparation uses `install.ps1 -CheckoutInstall -DependenciesOnly` for
installers that support it. This phase prepares Node and Python dependencies
without provisioning keys, generating catalogs, editing Codex configuration,
or touching service state. Older retained checkouts use their isolated
`-PrepareOnly` procedure. Keep that compatibility path until those older
generations retire from recovery use.

Python environment creation and locked installation share one installer phase;
candidate relocation and activation remain inside the recovery transaction.
Activation begins only after the service stop owner verifies stoppage. Recovery
also requires a successful stop before moving either environment. A refused
recovery stop leaves the active candidate and previous environment in place;
the error reports both failures and the retained paths. A failed restoration or
previous-service install retains remaining recovery environments for repair.
Service installation owns frontend readiness, so the installer does not repeat
its liveness poll. Full provider health and Doctor remain deployment checks.

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

Completed tool results retire the matching workflow even when the caller switches
to a native GPT or another external model, through HTTP or native WebSocket.
New tool calls keep that workflow pending. Current per-request thread/session
metadata identifies the conversation before compatibility headers; a changing
cache-affinity header does not create a different workflow. Failed, partial,
unidentified or unrelated continuations cannot clear outstanding work.
Closing an HTTP body after a verified completed response, as the WebSocket
adapter does, still records that completed workflow. A close before the terminal
or an execution deadline remains a failed or indeterminate continuation.

A timeout or workflow conflict restores admission and leaves the running generation
unchanged. A live older generation without drain support also defers normal
replacement. Settle the active work before retrying. Only an explicit operator
choice to interrupt it permits the force option: `-ForceServiceReplacement` on
the install, separate-directory deploy, checkout deployment transaction, or restart PowerShell entrypoint, or
`--force-service-replacement` on update/service commands. Force never bypasses
service identity or credential checks. The updater's separate `--force` flag can
discard tracked checkout edits; it is not the service-interruption option.

Catalog publication uses its existing refresh owner and does not hot-install
route code. The separate-directory deployer classifies file changes through
`src/deployment-classification.mjs`; other entrypoints retain their own guarded
transactions. Do not infer that every update is restart-free from its Git diff.

Apply source edits, deployment, restart, commit, and push only within the effects
authorized by the user. Authorization for one does not imply the others.
