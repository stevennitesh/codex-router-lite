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

## Update

`maintenance/windows-package.json` is the complete installed file list. `deploy-codex-router.ps1` copies only those files and removes only files recorded by the previous deployment manifest.

Use the guarded update transaction:

```powershell
.\deploy-codex-router.ps1 -InstallDir <installed-router-directory>
```

or, within the installed tree:

```powershell
.\restart-codex-router.ps1 -InstallDir <installed-router-directory>
```

Do not run a standalone stop. The transaction stages one generation, checks readiness, and restores the prior generation on failure.

A source edit, deployment, restart, commit, and push each require their own authority.
