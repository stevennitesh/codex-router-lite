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

Set the OpenRouter credential with the protected prompt:

```powershell
.\model-router.ps1 codex provider-key openrouter set
```

Switchyard installation is maintainer work. Follow `config/switchyard/README.md` only when building or deploying that runtime.

## Verify

```powershell
.\model-router.ps1 codex status
.\model-router.ps1 codex doctor
```

The scheduled task and process must agree on launcher path, arguments, source root, and generation. A task-name match alone is not proof.

The model picker lists Novita and GMICloud as separate GLM routes. Selecting
one changes only that request. Router never falls back from one endpoint to the
other.

The running service checks every five minutes for an installed Codex binary
change or an adopted native catalog change. A successful automatic refresh
does not restart Router. Fully quit and reopen the Codex app to reload its
picker. Use `model-router.ps1 codex refresh-catalog` only for an immediate
manual check.

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
`deploy-codex-router.ps1` stages and hash-checks exactly those files, snapshots
the previous managed generation, and removes only files recorded by the prior
deployment manifest. If install or Doctor fails, it restores, reinstalls, and
checks the previous generation before returning the candidate failure.

Deploy edited source from the current checkout with:

```powershell
.\deploy-codex-router.ps1 -InstallDir <installed-router-directory>
```

Restart the existing installed files only when a configuration or provider
selection change requires it:

```powershell
.\restart-codex-router.ps1 -InstallDir <installed-router-directory>
```

Do not run a standalone stop. The transaction stages one generation, checks readiness, and restores the prior generation on failure.

A source edit, deployment, restart, commit, and push each require their own authority.
