# Switchyard integration

This directory is the source of truth for Codex Router's Switchyard integration.
Do not keep a permanent Switchyard checkout or archived runtime copies. The
installed files under `C:\Users\steve\.codex\switchyard` are generated or
deployed artifacts, not editable source.

## Ownership and locations

| Item | Authoritative location | Notes |
|---|---|---|
| Router integration and tests | `C:\Users\steve\AppData\Local\codex-router` | Owns the catalog, request handling, provider selection, and process supervision. |
| Switchyard source change | `config\switchyard\patches\switchyard-codex-compat.patch` | Apply to the upstream commit recorded in `source.lock`. |
| Routing policy template | `config\switchyard\routes.template.toml` | Contains no generated local caller key. |
| Optional worker role | `config\switchyard\switchyard_worker.toml` | Source for `%CODEX_HOME%\agents\switchyard_worker.toml`. |
| Active runtime | `C:\Users\steve\.codex\switchyard` | Keep only deployed binary, active routes, provenance, routing history, and current logs. |

There is no permanent Switchyard source clone. Rebuild from a disposable checkout.
The runtime directory is necessary because Router launches an installed binary, but
it must not become a second source tree.

## Request flow

1. Codex sends the selected model to Codex Router.
2. Native Sol, Terra, Luna, GLM-5.3-Flash, and other picker entries stay on their existing routes.
3. Only `switchyard/auto` uses the `switchyard-native` request profile.
4. Router sends ordinary `switchyard/auto` turns to Switchyard on
   `127.0.0.1:4000` as uncompressed Responses JSON.
5. Switchyard classifies the turn, selects a Luna or Sol target and effort, then
   sends it back through Router's authenticated loopback Responses endpoint.
6. `forward_auth = true` preserves the Codex login headers for the native ChatGPT
   backend.

Router remains the only catalog owner. Switchyard is one separately selectable
model. It never replaces the default provider, merged catalog, or native models.

## Why the Switchyard patch exists

Upstream Switchyard identifies targets by the upstream model ID and lets caller
request fields win over target defaults. That cannot represent several effort
variants of the same native model safely. The patch adds:

- `routing_id`, a unique local identity for each target while `id` remains the
  exact model sent upstream;
- `body_overrides`, recursively merged after caller fields so the selected
  target owns `reasoning.effort`, `store`, and `stream` without erasing native
  reasoning siblings such as context and summary controls; and
- `remove_body_fields`, applied last to strip fields rejected by the upstream;
- raw Responses item inspection for Codex tool outputs, so custom, computer,
  shell, and tool-search continuations retain the selected target instead of
  being mistaken for a new user turn; and
- forwarding of the common `priority` service tier to the hidden classifier
  request as well as the selected serving request.

Every configured target enforces `store = false` and `stream = true` and removes
`max_output_tokens`. The ChatGPT subscription Responses backend requires this
shape. The patch also documents and tests the new fields.

## Routing policy

- `luna-high` handles closed, low-risk work with cheap verification.
- `luna-max` handles difficult but tightly specified and strongly verifiable work.
- `sol-medium` is the default for ambiguity, weak verification, or judgment.
- `sol-high` handles hard diagnosis, architecture, migrations, security, and
  consequential review.
- `sol-xhigh` is reserved for exceptional quality-first or recovery work.

The full classifier prompt and schema live in `routes.template.toml`.

## V2 subagents

`switchyard/auto` currently advertises Codex multi-agent v1. Its earlier v2
application lives at `v2_agent/switchyard/auto/`, but it is a draft for the new
runtime candidate because the accepted observations predate the pinned upstream
commit and compatibility patch. After deployment, rerun the exact-route encrypted
child, marker, continuation, and forced-tool checks and bind the proof to the
deployed source, patch, binary, Router commit, and route hashes before promoting
the catalog entry back to v2.

## Compaction and request compatibility

Switchyard owns ordinary turns only. It does not implement either Codex compaction
endpoint. Router detects v1 and v2 compaction requests and sends those directly to
the native model behind the public route. Router also skips routed-agent input
normalization for the Switchyard profile because the selected native model receives
the original Codex request after Switchyard chooses the target.

The public `switchyard/auto` catalog entry derives its context and compaction
contract from the current native Sol behavior template whenever Router publishes
the catalog. When `auto_compact_token_limit` is absent, Codex derives its native
threshold as 90 percent of the resolved context window. Router preserves that
absence. It separately preserves the token-budget and context-reset controls in
`model_messages`; those controls do not set the automatic compaction threshold.
The context values therefore follow the installed Codex catalog instead of being
frozen in this integration. Switchyard's internal routes may retain their larger
model context windows; those limits do not control when the Codex client compacts
its task history.

The Codex-facing entry also inherits the request contract of its native Sol behavior
template: native instructions and model messages, image input, web search, verbosity,
original image detail, parallel/custom tools, Responses Lite, and code-only tool mode.
The route keeps its own picker effort ladder because Switchyard, not the picker,
chooses the downstream model and effort. The optional `switchyard_worker` role must
not set `model_context_window` or `model_reasoning_summary`; omitting both lets root
and worker sessions use the same catalog-owned native defaults.
Its checked-in source is `config\switchyard\switchyard_worker.toml`; copy that file
to `%CODEX_HOME%\agents\switchyard_worker.toml` when installing or refreshing the
named role. Codex v2 inherited children already use the root's Switchyard model and
do not require the named role.

The local Router endpoint currently has no WebSocket relay. Current Codex builds
may attempt the upgrade and then fall back to the supported HTTP Responses stream. This is a
transport latency/logging difference, not a request-shape or agent-behavior change.
The `priority` Fast service tier is advertised and passed through because every Sol
and Luna target supports it. The Sol-only `ultrafast` tier stays hidden; advertising
it on the routed root would send an unsupported tier whenever the classifier chooses
Luna. Codex subagents can inherit the common Fast tier from the root.

Codex may send zstd-compressed native requests. The local Switchyard hop receives
plain JSON because Switchyard currently accepts JSON bodies, not Codex's zstd
request encoding.

## Runtime supervision

Router starts Switchyard only when the `switchyard` provider is selected. Router
launches the installed binary, waits for `/health`, observes its exit, and owns its
lifetime. Do not start a second Switchyard process.

Defaults and supported overrides:

- runtime root: `%CODEX_HOME%\switchyard` or `CODEX_ROUTER_SWITCHYARD_ROOT`;
- binary: `switchyard-server.exe` or `CODEX_ROUTER_SWITCHYARD_BIN`;
- route config: `routes.toml` or `CODEX_ROUTER_SWITCHYARD_CONFIG`; and
- local Responses address: `http://127.0.0.1:4000/v1` or
  `CODEX_ROUTER_SWITCHYARD_BASE_URL`.

Use Router's own controls. Enabling or disabling Switchyard requires one supervised
Router restart because provider selection changes the child-process set.

```powershell
$routerRoot = Join-Path $env:LOCALAPPDATA "codex-router"
& (Join-Path $routerRoot "model-router.ps1") codex providers enable switchyard
& (Join-Path $routerRoot "restart-codex-router.ps1")
Invoke-RestMethod http://127.0.0.1:4000/health -TimeoutSec 2
```

Never issue a standalone stop during maintenance. Use the guarded restart command,
which owns both shutdown and startup.

## Route deployment

`routes.template.toml` deliberately contains
`__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__`. The real URL contains Router's
generated local caller capability and must not enter source control, issues, logs,
or support bundles. Obtain the current managed `openai_base_url` from the local
Codex configuration without printing it, substitute it into a staged runtime
`routes.toml`, validate the staged config, then deploy it through a guarded restart.

## Rebuild

`source.lock` pins the upstream repository, commit, Rust toolchain, patch path, and
patch SHA-256. Use a disposable checkout:

```powershell
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ("switchyard-build-" + [guid]::NewGuid())
$routerRoot = "C:\Users\steve\AppData\Local\codex-router"
$patchPath = Join-Path $routerRoot "config\switchyard\patches\switchyard-codex-compat.patch"
git clone https://github.com/NVIDIA-NeMo/Switchyard.git $buildRoot
git -C $buildRoot checkout --detach bb011ca452c2274ea10c4a4cc55264e54abf0a62
git -C $buildRoot apply --check $patchPath
git -C $buildRoot apply $patchPath
Push-Location $buildRoot
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p switchyard-llm-client -p switchyard-runner
cargo build --release -p switchyard-server
Pop-Location
```

Before deployment, verify that Router can build a custom catalog from the target
Codex binary and that the same binary can parse it:

```powershell
node scripts/check-codex-catalog-compat.mjs "C:\path\to\desktop-codex.exe"
```

The check validates the current nested model-message controls and routed
capability fields. It uses a temporary catalog and does not change the active
Codex or Router configuration.

Validate the new binary with the active route configuration before replacement.
After a guarded replacement, verify Router health, Switchyard `/health`, the merged
catalog, and one routed smoke request. Delete the disposable checkout afterward.

## Provenance and retention

The currently installed binary may predate this source lock until the next
guarded restart. `SOURCE_COMMIT` records the deployed binary; `source.lock`
records the reproducible candidate built from upstream commit
`bb011ca452c2274ea10c4a4cc55264e54abf0a62` and the canonical patch in this
directory.

Keep only the active binary, active `routes.toml`, `SOURCE_COMMIT`, routing history,
and current service logs under `.codex\switchyard`. An upgrade may create one
temporary rollback binary. Remove it after health and smoke checks pass. Do not
retain activation scripts, PID files, standalone model catalogs, old route trees,
build output, or permanent source checkouts.
