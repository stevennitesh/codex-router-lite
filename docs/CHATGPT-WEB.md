# ChatGPT Web models

This optional integration connects Router Lite to an isolated
[codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) launcher. Router
continues to own the real Codex configuration, native catalog and existing routes.
The browser bridge owns ChatGPT login, browser model selection, MCP tool relay
and Web conversation/compaction state. It is unofficial browser automation.

## Connect the launcher

Install the Windows launcher separately, then start it through Router:

```powershell
.\model-router.ps1 codex web launch 'C:\absolute\path\codex-chatgpt-web.exe'
```

This starts a production launcher with isolated Codex configuration and browser
storage below Router's private `web-bridge` directory. Do not run its ordinary
setup against your real `CODEX_HOME`: it replaces the same base URL and protocol
settings Router owns. The launcher must remain running while Web models are used.
For resumed-task and V1 authority checks, its isolated home links the real
Codex `sessions` directory without copying it. Real `config.toml` and `auth.json`
are not linked or copied. This lets the trusted local bridge read canonical task
rollouts; it does not establish live browser/tool compatibility by itself.

In the isolated launcher, sign in to ChatGPT and choose Full harness / Automatic.
Keep experimental Bigger Context off. Complete its browser smoke test, MCP tunnel
and connector setup, then Verify runtime. The browser profile and tunnel keys
stay private; never commit or share them. Router does not import browser cookies
or supply native Codex account credentials to the bridge.

Connect the accepting listener and refresh the picker:

```powershell
.\model-router.ps1 codex web connect http://127.0.0.1:17841/v1
.\model-router.ps1 codex refresh-catalog
```

Fully quit and reopen Codex, then choose a model ending in `(Web)`. Connect reads
the isolated launcher's saved account capability observations and checks its
`/healthz`; this is listener readiness, not a successful live model/tool proof.
After changing accounts or refreshing account capabilities, reconnect and refresh
the catalog. Only the seven exact current bridge slugs are supported; aliases
that ignore the selected effort are excluded. The initial contract was inspected
at bridge 6.1.9, commit `f137c2f84da5df214c1e228d74f5ff43e7641c48`.

## Actual model and effort

| Picker identity | Bridge slug suffix | Codex effort → browser control |
| --- | --- | --- |
| GPT-6 Sol Instant (Web) | `gpt-6-sol-instant` | `low` → Instant |
| GPT-6 Sol (Web) | `gpt-6-sol` | `medium` → Medium; `high` → High; account-dependent `xhigh` → Extra High |
| GPT-5.6 Sol Instant (Web) | `gpt-5.6-sol-instant` | `low` → Instant |
| GPT-5.6 Sol (Web) | `gpt-5.6-sol` | `medium` → Medium; `high` → High; account-dependent `xhigh` → Extra High |
| GPT-5.6 Sol Pro (Web) | `gpt-5.6-pro` | `max` → Pro |
| GPT-6 Astra Pro (Web) | `gpt-6-pro` | `max` → Pro |
| ChatGPT Luna / Think (Web; version unverified) | `gpt-5.6-luna` | `low` → ordinary; `medium` → Think |

Every slug has prefix `chatgpt-web/`. Pro rows appear only when the saved account
capability exposes Pro. Luna appears only for Luna-only accounts: the bridge's
versioned transport ID does not establish the visible browser model version.
For the Sol/Pro routes, the bridge verifies model family and browser mode before
Send. Router does not treat the shared internal backend ID as the serving model.
Unsupported effort fails; it never silently changes model or uses Codex inference.

## Subagent selector

```powershell
.\model-router.ps1 codex subagents protocol status
.\model-router.ps1 codex subagents protocol v1
.\model-router.ps1 codex refresh-catalog
```

The default remains V2. V1 enables plaintext collaboration and permits connected
Web roles. V2 retains the certified route contract and excludes Web roles. Picking
a Web primary model never switches the protocol. Changing the selector requires
a full Codex restart and a new conversation; it cannot convert an existing task.
The CLI reports the configured protocol and this restart requirement, not the
protocol of an already-running conversation. User-owned conflicting feature
settings are refused rather than overwritten.

The Web bridge must be separately launched, provisioned and connected; choosing
V1 alone does not establish browser authentication or activate an unavailable
listener. Native parents continue to use their ordinary Codex allowance.

```powershell
.\model-router.ps1 codex web status
.\model-router.ps1 codex picker hide chatgpt-web/gpt-6-pro
.\model-router.ps1 codex subagents protocol v2
.\model-router.ps1 codex web disconnect
.\model-router.ps1 codex refresh-catalog
```

Disconnect disables new Web requests/publication without deleting browser state
or stopping an externally owned launcher. Backend errors and cancellations pass
through without fallback/retry. Web tools, compaction and V1 collaboration still
need account-bound live verification; offline fixture tests establish Router's
integration contract only. Existing V2 proof files do not certify Web routes.
