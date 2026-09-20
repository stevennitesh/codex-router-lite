# Codex Router Lite

**More model choices. The Codex workflow I already enjoy.**

**Windows-only · unofficial personal project · pre-1.0**

[Quick start](#quick-start) · [Models](#models) · [Make it yours](#make-it-yours) · [Feedback](CONTRIBUTING.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

I built Router Lite to use other models inside the Windows Codex app while keeping
its tools, conversations, and native GPT models. The exciting part is having those
choices in the same workspace, without moving my work into another client.

It runs locally between Codex and the selected model provider, handling the API
and tool differences. The project stays focused on Windows Codex desktop and the
native CLI, with a small, explicit set of routes.

## What you get

- **Choose your endpoint.** Separate model-picker entries for each OpenRouter route, with no silent provider fallback.
- **Keep using Codex tools.** Router translates tool calls and conversation history so supported models can work through the native interface.
- **Keep native GPT access.** Native models and account visibility remain owned by your installed Codex build.
- **Let Switchyard choose.** OpenRouter's Jev classifier helps the local router select a native Luna, Sol or Astra model and reasoning effort.

## Models

| Model | Route | Details |
| --- | --- | --- |
| GLM-5.3-Flash | OpenRouter → Novita | [Compatibility](docs/agents/openrouter-glm.md) |
| GLM-5.3-Flash | OpenRouter → GMICloud | [Compatibility](docs/agents/openrouter-glm.md) |
| Pareto | OpenRouter → Unbiased | [Compatibility](docs/agents/pareto.md) |
| Switchyard Auto | OpenRouter/Jev decision → native Luna / Sol / Astra answer | [Routing policy](config/switchyard/README.md#routing-policy); local Switchyard build required |

Pareto supports automatic tool selection and has no hosted-search capability.
Pareto and GLM have [active recorded v2 proofs](v2_agent/README.md), each valid
only for its named runtime. Switchyard certification additionally binds the exact
source, patch, binary, generated routes, and Router commit; its application records
whether the checked source matches an accepted runtime. See the
[current application](v2_agent/switchyard/auto/proof.md).

## Quick start

You’ll need **Windows 10/11**, **PowerShell 5.1+**, **Git**, **Node.js 22.19+**,
**Python 3.10+ or uv**, and **Codex desktop or CLI**. OpenRouter routes also need
your own OpenRouter API key.

**1. Clone, review, and install**

```powershell
git clone https://github.com/stevennitesh/codex-router-lite.git
Set-Location codex-router-lite
.\install.ps1 -Target codex
```

The installer preserves your Codex login and user-owned settings, adds the managed
Codex routing configuration, and installs a local Windows scheduled background task.

**2. Add your OpenRouter key**

```powershell
.\model-router.ps1 codex provider-key openrouter set
```

Enter it through the protected prompt. Keep keys out of chat, command arguments,
and repository files.

**3. Check your setup**

```powershell
.\model-router.ps1 codex status
.\model-router.ps1 codex doctor
```

Fully quit and reopen Codex to reload the model picker, then select your route.

Switchyard needs a separate [build and deployment](config/switchyard/maintenance.md).
Rust is only needed to build Switchyard. For setup details and recovery, see
[installation](docs/INSTALL.md) and [troubleshooting](docs/TROUBLESHOOTING.md).

## Make it yours

Most work here starts with a new model or endpoint. The
[model onboarding guide](docs/agents/model-onboarding.md) walks through choosing a
compatible API, adding route metadata, translating tools, and testing the real
Codex path. Start with the [Router Lite system specification](docs/agents/architecture.md)
if you want to understand how the pieces fit together.

Route settings live under [config/openrouter](config/openrouter/) and
[config/switchyard](config/switchyard/). Model registration lives in
[src/routed-models.mjs](src/routed-models.mjs). A new endpoint needs compatibility
checks as well as a configuration entry.

This is a maintainer-led personal project, so external pull requests are not
accepted. Use the privacy-safe issue forms for bugs or route and behavior ideas,
or fork the repository for your own changes.

Run the local checks after making changes:

```powershell
npm ci
npm run verify
npm run audit:ci
```

Maintainers also audit the hashed Python production lock before release; the
exact pinned command is in the [GLM dependency guide](docs/agents/openrouter-glm.md#python-dependency-lock).

Then follow the [deployment guide](docs/INSTALL.md#update) to install your edited
source. Restarting alone does not deploy changes.

## Keeping up with Codex

To check for and install a published Router Lite update:

```powershell
.\model-router.ps1 codex update check
.\model-router.ps1 codex update
```

`main` is the rolling tested update channel. The updater fetches `origin/main`,
fast-forwards only, and reinstalls the managed generation; it does not merge
local divergence.

When Codex itself updates, the [compatibility workflow](docs/agents/compatibility-maintenance.md)
checks the installed app and reviews upstream Router and Switchyard changes worth
integrating. Updates are reviewed deliberately, not merged automatically.

For unexpected responses or tool failures, start with the
[debugging guide](docs/agents/debugging.md). Agents working in this repo can use
[AGENTS.md](AGENTS.md) to load only the guidance their task needs.

## Privacy and attribution

Router listens locally. OpenRouter requests use your protected provider key;
your Codex credentials and account headers are not forwarded to OpenRouter.
Model requests still go to the selected provider. See [security](SECURITY.md)
for the trust boundaries and private vulnerability reporting.

**Switchyard Auto also sends bounded task text to OpenRouter/Jev for model
selection, even though its answer comes from a native GPT model.** Text can come
from three sources: the latest genuine ordinary user turn, a recovered current
encrypted child assignment, or the delegated input of a recognized current
`codex_app` task delivery. Ordinary tool outputs, assistant answers and reasoning
are excluded. Failed or unsafe recognized assignments fall back to Sol without a
Jev call, while ordinary and known historical tool outputs retain the current
route. Task and conversation content remains intact for the native answer model;
Router still applies the request-field changes owned by the selected route. See
[security](SECURITY.md) and the [routing policy](config/switchyard/README.md#routing-policy)
for the exact admission, currentness and egress boundaries.

Built on [duolahypercho/codex-router](https://github.com/duolahypercho/codex-router),
with a narrower focus on my Windows Codex workflow. Independent project;
not affiliated with OpenAI or OpenRouter. [MIT license](LICENSE) · [Attribution](NOTICE.md)
