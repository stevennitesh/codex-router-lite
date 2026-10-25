# ChatGPT Web models

This optional integration lets Router use ChatGPT in the Codex in-app browser.
Router owns the browser turn, its local MCP broker and the tunnel process. ChatGPT
requests tools through that broker; native Codex executes each declared tool with
its ordinary permissions and returns the actual result. Browser operations also
run through the current native JavaScript tool. No separate launcher or inference
controller is required.

This is unofficial browser automation. Configuration and offline checks do not
establish account-bound browser, tool, continuation or cancellation readiness.
Verify those through an actual Web conversation before relying on the route.

## Everyday use

After setup, choose a model ending in `(Web)` in an ordinary Codex conversation.
Use Codex tools normally and keep working in that conversation to reuse its saved
ChatGPT context. Stop retains the chat and tab for continuation.

For troubleshooting, `model-router.ps1 codex web status` combines local
configuration, Router, key and adapter diagnostics.
It distinguishes observed local readiness from browser sign-in, app-loaded state
and hook trust that still need verification in Codex. Follow a reported next action
rather than reinstalling or restarting automatically.

## Configure the browser integration

Use a signed-in ChatGPT account in the current Codex in-app browser. Register the
Router MCP connector with the official tunnel service, and retain its tunnel ID,
runtime key and exact connector identity. The connector's visible selection button
and attached chip must match the configured name and app ID.

Create a JSON configuration file with these safe fields. Replace the example
values with current observed paths, connector identities and account capabilities:

```json
{
  "runtimeModule": "C:\\absolute\\path\\official-browser-runtime.mjs",
  "pluginName": "Router local tools",
  "pluginAppId": "asdk_app_REPLACE_WITH_OBSERVED_ID",
  "pluginSelectionButtonName": "REPLACE_WITH_EXACT_CONNECTOR_BUTTON",
  "tunnelId": "tunnel_REPLACE_WITH_REGISTERED_ID",
  "tunnelClientPath": "C:\\absolute\\path\\officialtunnelclient.exe",
  "capabilities": {
    "solAvailable": true,
    "extraHighAvailable": false,
    "proAvailable": false
  }
}
```

`runtimeModule` is the current official public browser runtime module supplied by
the installed Codex browser skill. Router loads it through native Codex; it does
not vendor or hardcode a versioned module path. Both file paths must be absolute
and name existing regular files. `pluginAppId` must begin with `asdk_app_`, and
`tunnelId` must begin with `tunnel_`. Use the exact observed connector button name,
including any visible suffix. `capabilities` is a safe account observation used
for model publication; it is checked against the browser before sending.

An optional integer `mcpPort` selects a dedicated loopback port from 1 through
65535, separate from Router ports. Omit it to let the operating
system choose a free port. The schema accepts only the fields shown above and
`mcpPort`. Do not put runtime keys, cookies or account credentials in this file.

Save the runtime key at the hidden prompt, then configure the integration and refresh
the model picker:

```powershell
.\model-router.ps1 codex web tunnel-key set
.\model-router.ps1 codex web browser 'C:\absolute\path\web-browser.json'
.\restart-codex-router.ps1
.\model-router.ps1 codex refresh-catalog
```

The explicit catalog refresh publishes the picker before you reopen Codex;
startup's automatic freshness check runs asynchronously. Use `web status` only
when you need diagnostics, rather than adding it to every setup or restart.

After changing browser or tunnel settings, restart Router before sending a Web
request. Reopening Codex reloads its adapter; it does not reload Router's running
tunnel and browser configuration. The guarded restart waits for active work and
leaves the current service running if it cannot safely replace it.

The key is stored in Router state as the owner-only
`chatgpt-web-runtime-key.secret` file. `set` never accepts a key argument or echoes
the value. The key needs Tunnels Read and Use permission in the tunnel's Platform
organization. After replacing a key for a running tunnel, restart Router so its
owned tunnel client loads the replacement. Inspect or remove it with:

```powershell
.\model-router.ps1 codex web tunnel-key status
.\model-router.ps1 codex web tunnel-key remove
```

Complete [Immediate Stop setup](#immediate-stop) below before the single final
Codex restart, then choose a model ending in `(Web)`. Configuration
publishes the eligible model choices while preserving previous visibility choices;
it does not launch the browser or prove tool access. Router starts its loopback
MCP listener and official tunnel client when an enabled in-app configuration is
loaded at startup, or on its first Web request after configuration. It uses a
private tunnel configuration and owns their cleanup. Reconfigure paths and
observed connector details after an update changes them.

Tunnel readiness requires a successful hosted control-plane poll. The client's
local `/readyz` response alone does not establish authenticated polling. Rejected
poll credentials fail with `web_tunnel_auth_rejected`; replace the protected key
or correct its Tunnels permissions, then restart Router. Other polling failures
leave the tunnel unready rather than permitting a tool-dependent Web turn.

## Browser turns and tools

Each Codex conversation uses one normal saved ChatGPT chat. Follow-ups send newly
added native history; they reuse ChatGPT's existing context. Router can reopen the
saved chat after its tab closes or Codex restarts. Native `/compact` preserves the
delivery checkpoint locally without requesting a model summary.

Tools run through native Codex with its ordinary approvals and sandbox. An
uncertain Send or unresolved tool action blocks continuation so an action cannot
be repeated accidentally. A full ChatGPT conversation can transfer readable Codex
context once to a successor chat when the page presents its explicit maximum-length
notice. Input is text only; media upload is unsupported.

## Immediate Stop

Immediate browser cancellation uses the Router MCP adapter and a separately trusted
Interrupt hook. The adapter covers ordinary primary Web conversations and excludes
subagents. Codex's Stop cancels generation while retaining the same saved chat and
tab. Native cancellation also revokes tool access; it cannot undo a tool that has
already started.

After installing the adapter, review and trust **Stopping ChatGPT Web generation
through Router adapter** in Codex Settings → Hooks, then fully quit and reopen Codex.
Use the normal Codex app; no external Web launcher or special startup script is
needed. Configuration alone does not establish live Stop readiness.

For the adapter manifest, installation commands, source-version matching and
rollback, see [integration maintenance](agents/web-integration.md#adapter-installation-and-rollback).
That guide also owns [browser and context details](agents/web-integration.md#saved-chats-and-browser-lifecycle)
and [Stop's authority and deadline](agents/web-integration.md#immediate-stop).

## Refresh after a Codex update

After an app update, apply the coordinated runtime refresh:

```powershell
.\model-router.ps1 codex web refresh-runtime --apply
```

The command checks whether a refresh is needed and reads the configured official
Node REPL and browser service to validate
their runtime identities. It preserves your connector, tunnel, runtime key and
model capabilities. If the configured runtime is missing or ambiguous, supply a
reviewed manifest with `--manifest 'C:\absolute\path\adapter-manifest.json'`.
Omit `--apply` for a read-only preview when needed; a separate preview is optional.
`codex web status` uses that same planner and reports `refresh-required` when the
current app runtime differs, even if the old files still exist. Missing old app
files remain a stale runtime, not lost Web configuration or foreign ownership.

Applying a required refresh waits for active Router work, installs the matching
adapter and browser configuration, and reloads Router. By default it does not
force an interruption. Only with explicit authorization to interrupt blocking
Router requests, add `--force-service-replacement` to the `--apply` command.
The override is rejected without `--apply`. Run the coordinated command directly;
do not close admission with a separate forced drain before runtime refresh.
Candidate validation happens before the coordinator drains work, and it resumes
admission if installation fails before reload and prior state is restored.
The serving Router must support Web-aware drain checks: active
generations, uncertain Sends and unresolved native actions postpone the refresh.
The override still requires all three Web counters to be known and zero.
If an older Router cannot supply that proof, deploy and reload the current Router
before applying the runtime refresh. Fully quit and reopen Codex normally when the command reports that
the adapter needs to reload. The existing trusted Interrupt hook is retained;
verify tools, Stop and same-chat continuation after activation.
Replacing an already owned adapter through `web stop install-adapter <manifest>`
also uses this coordinated refresh; first installation remains the setup path.

## Actual model and effort

| Picker identity | Route suffix | Codex effort → browser control |
| --- | --- | --- |
| GPT-6 Sol Instant (Web) | `gpt-6-sol-instant` | `low` → Instant |
| GPT-6 Sol (Web) | `gpt-6-sol` | `medium` → Medium; `high` → High; account-dependent `xhigh` → Extra High |
| GPT-5.6 Sol Instant (Web) | `gpt-5.6-sol-instant` | `low` → Instant |
| GPT-5.6 Sol (Web) | `gpt-5.6-sol` | `medium` → Medium; `high` → High; account-dependent `xhigh` → Extra High |
| GPT-5.6 Sol Pro (Web) | `gpt-5.6-pro` | `max` → Pro |
| GPT-6 Astra Pro (Web) | `gpt-6-pro` | `max` → Pro |

Every slug has prefix `chatgpt-web/`. Pro rows require the saved account capability
to expose Pro. Router verifies the browser family and effort before Send; a shared
internal ChatGPT backend ID does not identify the serving model. Unsupported
effort fails without silently changing models or using Codex inference.

## Subagent selector

```powershell
.\model-router.ps1 codex subagents protocol status
.\model-router.ps1 codex subagents protocol v1
.\model-router.ps1 codex refresh-catalog
```

The default remains V2. V1 enables plaintext collaboration and permits configured
Web roles. V2 retains the certified route contract and excludes Web
roles. Picking a Web primary model never switches the protocol. Changing the
selector requires a full Codex restart and a new conversation; it cannot convert
an existing task.
The CLI reports the configured protocol and this restart requirement, not the
protocol of an already-running conversation. User-owned conflicting feature
settings are refused rather than overwritten.

V1 alone does not establish browser authentication or tool readiness. Native
parents continue to use their ordinary Codex allowance. Existing V2 proof files
do not certify Web routes.

```powershell
.\model-router.ps1 codex web status
.\model-router.ps1 codex picker hide chatgpt-web/gpt-6-pro
.\model-router.ps1 codex subagents protocol v2
.\model-router.ps1 codex web disconnect
.\model-router.ps1 codex refresh-catalog
```

Disconnect disables new Web requests and publication. It preserves saved browser
configuration and the protected tunnel key; remove the key separately when needed.
