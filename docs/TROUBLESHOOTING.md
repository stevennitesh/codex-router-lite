# Troubleshooting

Start with read-only checks:

```powershell
.\model-router.ps1 codex status
.\model-router.ps1 codex doctor
```

Do not paste the full managed loopback URL, keys, bearer tokens, account IDs, prompt bodies, or unredacted logs into an issue.

## Codex native models are wrong

Resolve the Codex executable actually used by the app and run:

```powershell
codex --version
node scripts/check-codex-catalog-compat.mjs <codex-executable>
```

The installed build owns native models. Do not repair drift by copying a catalog from another version.

The managed service checks for native catalog authority changes every five
minutes and republishes only when one changed. A model whose native entry still
has `visibility: "hide"` remains absent by design. Automatic refresh cannot
turn a staged account rollout into an entitlement or infer it from private app
caches.

## GLM fails

Confirm the selected slug is `openrouter/glm-5.3-flash` for Novita or
`openrouter/glm-5.3-flash-gmicloud` for GMICloud. Check that the OpenRouter key
is present and Doctor names both exact endpoint policies. Preserve a sanitized
response event order. Separate Router, LiteLLM, OpenRouter, the selected
endpoint, and model failures before editing.

Do not turn on fallback or select an unproved provider to hide an endpoint failure.

## App functions do not execute

Compare the current Windows Codex tool definitions with `src/codex-app-tools.mjs`. Check the flattened call and restored namespace as a pair. A provider returning plausible JSON does not prove the app received a native tool call.

## Switchyard is unavailable

Load `config/switchyard/README.md`. Verify the locked source, patch, binary, generated route, capability file, provenance, and health as one unit. Do not copy one artifact from another generation.

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

## Windows task mismatch

A task with the expected name but different launcher, arguments, source root, ACL, or generation is foreign. Do not adopt or overwrite it. Use the installer or guarded restart transaction after resolving ownership.

The installer grants `BUILTIN\Users` read and execute access only to the Router program tree so its Limited scheduled task can load the installed modules. Protected credentials and state remain owner-only. If startup still reports an existing module as missing, inspect the named program-tree ACL before changing task identity or reinstalling.

Never stop Router separately during maintenance. If the user has not authorized a restart, report that a restart is required and stop before changing the live service.
