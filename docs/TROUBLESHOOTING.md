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

## GLM fails

Confirm the selected slug is `openrouter/glm-5.3-flash`, the OpenRouter key is present, and doctor reports the OpenRouter hop healthy. Preserve a sanitized response event order. Separate Router, LiteLLM, OpenRouter, NovitaAI, and model failures before editing.

Do not turn on fallback or add a provider to hide an endpoint failure.

## App functions do not execute

Compare the current Windows Codex tool definitions with `src/codex-app-tools.mjs`. Check the flattened call and restored namespace as a pair. A provider returning plausible JSON does not prove the app received a native tool call.

## Switchyard is unavailable

Load `config/switchyard/README.md`. Verify the locked source, patch, binary, generated route, capability file, provenance, and health as one unit. Do not copy one artifact from another generation.

## Windows task mismatch

A task with the expected name but different launcher, arguments, source root, ACL, or generation is foreign. Do not adopt or overwrite it. Use the installer or guarded restart transaction after resolving ownership.

Never stop Router separately during maintenance. If the user has not authorized a restart, report that a restart is required and stop before changing the live service.
