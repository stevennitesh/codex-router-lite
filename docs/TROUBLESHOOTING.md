# Troubleshooting

For request, replay, tool or stream defects use [debugging](agents/debugging.md).
This guide owns service and operator diagnosis. Start with read-only checks:

```powershell
.\model-router.ps1 codex status
.\model-router.ps1 codex doctor
```

If a restricted shell reports that protected state is missing, Codex is signed
out, or a provider runtime is unavailable, repeat the same read-only check with
the local authority that owns `%CODEX_HOME%`. Treat the elevated result as the
diagnostic authority. Do not repair ACLs or reinstall from the restricted
shell's false negative.

Do not paste the full managed loopback URL, keys, bearer tokens, account IDs, prompt bodies, or unredacted logs into an issue.

## Codex native models are wrong

Resolve the Codex executable actually used by the app and run:

```powershell
codex --version
node scripts/check-codex-catalog-compat.mjs <codex-executable>
```

The installed build owns native models. Do not repair drift by copying a catalog from another version.

The managed service checks for native catalog authority changes every five
minutes, refreshes the signed-in account cache from the fixed ChatGPT model
endpoint, and republishes only when its content or the installed binary
identity changed. A failed account read preserves the previous cache. A model
whose native entry still has `visibility: "hide"` remains absent by design;
automatic refresh cannot turn a staged account rollout into an entitlement.

## GLM fails

Confirm the selected slug is `openrouter/glm-5.3-flash` for Novita or
`openrouter/glm-5.3-flash-gmicloud` for GMICloud. Check that the OpenRouter key
is present and Doctor names both exact endpoint policies. Preserve a sanitized
response event order. Separate Router, LiteLLM, OpenRouter, the selected
endpoint, and model failures before editing.

Do not turn on fallback or select an unproved provider to hide an endpoint failure.

## Pareto fails

Confirm the selected slug and exact Unbiased endpoint. Follow the
[Pareto contract](agents/pareto.md) for supported controls and replay, then
[debugging](agents/debugging.md) to locate the first divergence. Do not apply
GLM repairs based on an inferred model identity.

## Unsupported verbosity warning

`model_verbosity is set but ignored` means a global or task override requested a
control the selected model does not support. Remove that override to use each
model's catalog default. External routes correctly advertise no verbosity
support; do not change their capability flags to silence the warning. Preserve
an intentional verbosity preference in a native-only configuration when needed.

## App functions do not execute

Compare the current Windows Codex tool definitions with `src/codex-app-tools.mjs`. Check the flattened call and restored namespace as a pair. A provider returning plausible JSON does not prove the app received a native tool call.

## Switchyard is unavailable

Read the [Switchyard boundaries](../config/switchyard/README.md) and
[runtime diagnosis](../config/switchyard/runtime.md). Load the build/deployment
branch only if replacement is needed. Verify the locked source, patch, binary,
generated route, capability file, provenance, and health as one unit. Do not
copy one artifact from another generation.

Start with the redacted current-generation summary:

```powershell
.\model-router.ps1 codex switchyard-trace
```

| Observation | First owner to inspect |
| --- | --- |
| `Input must be a list` | Switchyard's Responses encoder emitted scalar `input`; keep native classifier input as a message list. |
| `input[n].content` rejects an array | The hidden classifier received native content blocks; reduce it to one text-only user message. |
| Judge HTTP 200 followed by a parse failure | The classifier saw conversation or tool-relay traffic instead of task-only text. Check route windowing and classifier input selection. |
| `routed_agents: 0` with accepted v2 proofs | Local subagent mode or its selected allowlist filtered every certified exact route. Run `model-router.ps1 codex subagents status` before changing source. |
| Deployment waits on dependency preparation, then rejects an old rollback | The deployment script is stale. Current source checks candidate and rollback directories before preparing dependencies. |

The trace command reports counts and continuity only. It never prints request
bodies, headers, capabilities, or raw agent identifiers.

When collecting certification evidence after the failure owner is resolved,
use the bounded redacted view instead of copying either raw log:

```powershell
.\model-router.ps1 codex switchyard-certification-evidence --limit 20
```

## Windows task mismatch

A task with the expected name but different launcher, arguments, source root, ACL, or generation is foreign. Do not adopt or overwrite it. Use the installer or guarded restart transaction after resolving ownership.

The installer grants `BUILTIN\Users` read and execute access only to the Router program tree so its Limited scheduled task can load the installed modules. Protected credentials and state remain owner-only. If startup still reports an existing module as missing, inspect the named program-tree ACL before changing task identity or reinstalling.

Never stop Router separately during maintenance. If the user has not authorized a restart, report that a restart is required and stop before changing the live service.

The service task has a minute heartbeat and `MultipleInstances=IgnoreNew`.
While Router is running, a duplicate heartbeat launch may set Task Scheduler's
last result to `0x800710E0`. This means Windows rejected the duplicate task
instance. Confirm Router health, task state, launcher identity, and the next
heartbeat time before treating it as a failure.

## Conversation cuts after restarting Codex

Restarting the Windows Codex app closes its local app-server connection. An
active turn may end with an interruption marker even when Router stayed
healthy. Completed thread history remains stored and can resume after the app
returns. Do not make Router keep a detached provider stream alive because the
new app-server connection cannot reattach to it safely.

A v2 child can also fail history hydration when the app tries to resume it
before loading its parent. The desktop log states that the unloaded parent must
resume first or the client must use `thread/read`. Open the parent task first,
then inspect its child. Diagnose this as native app hydration unless Router
health or the persisted thread file also failed.
