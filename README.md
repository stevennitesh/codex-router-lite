# Codex Router Lite

Codex Router Lite is a Windows-only compatibility layer for the Codex desktop app and native Codex CLI. It adds four routed model choices while leaving native Codex models under the installed Codex build's control:

- `openrouter/glm-5.3-flash`, pinned to the Novita endpoint
- `openrouter/glm-5.3-flash-gmicloud`, pinned to the GMICloud endpoint
- `openrouter/union-alpha`, pinned to the anonymous Stealth endpoint (preview; not v2 certified)
- `switchyard/auto`, which selects native Codex models through the pinned local Switchyard runtime

The router also restores current Codex app function namespaces and supports exact-route subagents v2. It does not support other clients, platforms, provider catalogs, local-model managers, fallback models, a Router UI, or provider discovery.

The managed service checks every five minutes for an installed Codex binary or
native account-catalog change. When signed in, it refreshes account visibility
from Codex's fixed ChatGPT model endpoint and preserves the previous cache if
that read fails. It republishes the generated catalog when its authority changes.
Fully quit and reopen Codex after an automatic refresh message to reload the
model picker.

## Requirements

- Windows 10 or Windows 11
- Windows PowerShell 5.1 or PowerShell 7
- Node.js 22.19 or newer
- Python 3.10 or newer, or `uv`
- Codex desktop or Codex CLI

Switchyard requires a separately built and deployed runtime; follow its
[build and deployment guide](config/switchyard/maintenance.md). You do not need
Rust for OpenRouter-only use.

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

A source checkout update from the Router Lite repository uses the guarded
self-update and installer transaction:

```powershell
.\model-router.ps1 codex update check
.\model-router.ps1 codex update
```

For edited source deployment, choose the separate-directory or active-checkout
transaction in [installation and updates](docs/INSTALL.md#update). Use
`.\restart-codex-router.ps1 -InstallDir <installed-router-directory>` only to
restart the files already installed. Do not stop the service separately.
Deployment owns file replacement and rollback.

## How it works

Native GPT requests keep their Codex authentication and go to the native backend. OpenRouter requests replace caller credentials with the one protected OpenRouter key and strip Codex account metadata. Switchyard is loopback-only, requires a per-generation capability, and preserves native authorization for the native model it selects.

Each GLM route selects one OpenRouter endpoint with fallback disabled. Choose
the Novita or GMICloud entry directly in the Codex model picker. Their endpoint
policies and v2 proofs stay separate, so one route cannot silently change the
other's provider. Fresh Codex web-search turns use OpenRouter's bounded
`openrouter:web_search` server tool over the direct Responses path; ordinary
GLM turns continue through the LiteLLM compatibility path. No user
`config.toml` customization is required.

Union Alpha uses OpenRouter's direct Responses API with the same credential
isolation. Router translates native tools and removes unsupported reasoning,
verbosity, and parallel-tool controls. Tool selection is automatic; forced tool
choices fail locally. The underlying model or models are undisclosed, so its
[compatibility contract](docs/agents/union-alpha.md) follows measured endpoint
behavior. It supports text and images, with no hosted-search or v2 claim.

GLM tools use flattened names that Router restores to the caller's native app
or harness namespace before execution. Runtime relay uses the client's actual
tool declarations; the [app-tool snapshot](src/codex-app-tools.mjs) is a dated
reference for drift inspection. Router also repairs GLM custom-tool streams,
supplies missing commentary/final-answer phases, and removes optional foreign
item IDs when replaying routed history to native Codex. Unknown provider-prefixed
model names fail locally instead of reaching the native backend.

Router configures Codex's native root-agent usage hint so delegated custody can
use the active workflow's event-driven wait interval without unchanged timeout
commentary. This avoids request mutation and reaches desktop root tasks whose app
context replaces generic developer instructions.

Switchyard uses Luna High to classify tasks among five Luna/Sol effort targets.
Its [routing policy and integration guide](config/switchyard/README.md) explains
the choices and deliberately pinned upstream version.

Both GLM routes and Switchyard have recorded
[exact-route v2 proofs](docs/SUBAGENT-CERTIFICATION.md) for their prior deployed
runtime. These [historical proofs](v2_agent/) cover native tool execution,
encrypted child handoffs, and same-child continuation. The current Union
compatibility candidate changes shared protocol handling and still requires
fresh runtime-bound certification before deployment acceptance; passing the
local suite does not renew those proofs. Union remains a v1 preview.

Configuration lives in six JSON files:

- `config/openrouter/openrouter.json`
- `config/openrouter/glm-5.3-flash.json`
- `config/openrouter/glm-5.3-flash-gmicloud.json`
- `config/openrouter/union-alpha.json`
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

After a Windows Codex app, Codex CLI, Router upstream, or Switchyard upstream
update, refresh the complete maintenance state with one read-only command:

```powershell
.\maintenance\refresh-compatibility-state.ps1
```

The command does not restart Router or spend provider quota. A reported app
tool mismatch still requires one ordinary Windows app turn to compare the live
tool registry. A Switchyard upstream change still requires review and a pinned
rebuild rather than an automatic merge.

When drift is reported, `-AnalyzeUpstream` shows the conditional original
Router or Switchyard review without merging or deploying anything.

`npm test` is the normal retained-product suite. It directly covers native Codex, GLM, Union Alpha, Switchyard, app functions, namespace restoration, encrypted subagent relay, v2 promotion, and Windows lifecycle behavior.

Load maintenance context only when it applies:

- Codex, Windows app, OpenRouter, or GLM work: [compatibility maintenance](docs/agents/compatibility-maintenance.md)
- Union Alpha endpoint work: [Union Alpha compatibility](docs/agents/union-alpha.md)
- Switchyard source, build, or deployment: [Switchyard integration](config/switchyard/README.md)
- Subagents v2 evidence: [certification](docs/SUBAGENT-CERTIFICATION.md)
- Installation details: [installation and updates](docs/INSTALL.md)
- Failures and recovery: [troubleshooting](docs/TROUBLESHOOTING.md)

## Security

All listeners bind to loopback. External routes never receive the caller's Codex authorization, account ID, installation ID, or residency headers. The full managed loopback URL contains a local capability and should be redacted before sharing logs or screenshots.

Report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/stevennitesh/codex-router-lite/security/advisories/new).

## License and attribution

Codex Router Lite is distributed under the MIT License in [LICENSE](LICENSE). It is derived from `duolahypercho/codex-router`; [NOTICE.md](NOTICE.md) preserves upstream attribution.
