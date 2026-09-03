# Codex Router Lite

Codex Router Lite is a Windows-only compatibility layer for the Codex desktop app and native Codex CLI. It adds two routed model choices while leaving native Codex models under the installed Codex build's control:

- `openrouter/glm-5.3-flash`, fixed to GLM-5.3-Flash on NovitaAI through OpenRouter
- `switchyard/auto`, which selects native Codex models through the pinned local Switchyard runtime

The router also restores current Codex app function namespaces and supports exact-route subagents v2. It does not support other clients, platforms, provider catalogs, local-model managers, fallback models, a Router UI, or provider discovery.

## Requirements

- Windows 10 or Windows 11
- Windows PowerShell 5.1 or PowerShell 7
- Node.js 22.19 or newer
- Python 3.10 or newer, or `uv`
- Codex desktop or Codex CLI

Switchyard has a separate Rust build procedure. You do not need Rust for OpenRouter-only use.

## Install

Clone the repository, review it, and run:

```powershell
git clone https://github.com/stevennitesh/codex-router-lite.git
Set-Location codex-router-lite
.\install.ps1 -Target codex
```

The installer preserves the Codex login and user-owned settings. It writes a marked local routing block, installs the Windows scheduled task, and stores generated state under the Codex home directory.

Set or replace the OpenRouter key through the protected prompt:

```powershell
.\model-router.ps1 codex provider-key openrouter set
```

Do not put keys in chat, command arguments, repository files, or logs.

Check the installation:

```powershell
.\model-router.ps1 codex status
.\model-router.ps1 codex doctor
```

A maintenance update must use the guarded transaction:

```powershell
.\restart-codex-router.ps1 -InstallDir <installed-router-directory>
```

Do not stop the service separately. The restart command owns the stop/start and
readiness boundary for the files already installed. Deployment owns file
replacement and rollback.

## How it works

Native GPT requests keep their Codex authentication and go to the native backend. OpenRouter requests replace caller credentials with the one protected OpenRouter key and strip Codex account metadata. Switchyard is loopback-only, requires a per-generation capability, and preserves native authorization for the native model it selects.

Routed models see flattened app-function names. The response path restores the native namespace before the Codex app executes a call. The checked-in app-tool snapshot tracks the installed Codex contract.

Configuration lives in four JSON files:

- `config/openrouter/openrouter.json`
- `config/openrouter/glm-5.3-flash.json`
- `config/switchyard/switchyard.json`
- `config/switchyard/auto.json`

The Windows package file list is explicit in `maintenance/windows-package.json`.

## Development

```powershell
npm ci
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

`npm test` is the normal retained-product suite. It directly covers native Codex, GLM, Switchyard, app functions, namespace restoration, encrypted subagent relay, v2 promotion, and Windows lifecycle behavior.

Load maintenance context only when it applies:

- Codex, Windows app, OpenRouter, or GLM work: `docs/agents/compatibility-maintenance.md`
- Switchyard source, build, or deployment: `config/switchyard/README.md`
- Subagents v2 evidence: `docs/SUBAGENT-CERTIFICATION.md`
- Installation details: `docs/INSTALL.md`
- Failures and recovery: `docs/TROUBLESHOOTING.md`

## Security

All listeners bind to loopback. External routes never receive the caller's Codex authorization, account ID, installation ID, or residency headers. The full managed loopback URL contains a local capability and should be redacted before sharing logs or screenshots.

Report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/stevennitesh/codex-router-lite/security/advisories/new).

## License and attribution

Codex Router Lite is distributed under the MIT License in [LICENSE](LICENSE). It is derived from `duolahypercho/codex-router`; [NOTICE.md](NOTICE.md) preserves upstream attribution.
