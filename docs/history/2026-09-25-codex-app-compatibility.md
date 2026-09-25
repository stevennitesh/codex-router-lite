# Codex app 26.924.1866 compatibility review - 2026-09-25

Historical compatibility evidence. Current authority remains the Router source,
the native catalog read from the installed Codex binary, the app-tool snapshot,
and the upstream review records.

## Installed app and CLI

The updated Windows package is `26.924.1866.0`. The signed bundled CLI resolves
to `codex-cli 0.158.0-alpha.2`.

The current CLI parsed 15 models through Router's generated catalog and the
retained GLM, Pareto, and Switchyard catalog contracts passed. Router health,
native authentication, OpenRouter endpoint policy, Switchyard runtime presence,
and scheduled-task ownership were healthy during the read-only compatibility
refresh.

The new native catalog adds `supports_reasoning_effort_updates`. The installed
members used by `switchyard/auto` are mixed: Astra advertises true while Sol
and Luna advertise false. Router therefore projects false for the composite
route rather than copying Astra's capability or omitting the field. External
routes also remain false unless a future route owns and verifies such behavior.

## App tools

The bundled `codex-app-tools@openai-bundled` plugin is now version `0.1.5`.
The checked-in app-tool snapshot is still paired with Windows app
`26.915.4065.0` / `codex-cli 0.155.0-alpha.9.2`.

The current desktop app starts app-server with the bundled app-tools MCP enabled,
but the MCP process is started on demand and its pipe environment is owned by the
desktop host. CLI-only diagnostics do not expose the live model-facing app-tool
registry or schemas. The snapshot is therefore intentionally not rebound by
version inference. Runtime relay remains based on the caller's actual tool
definitions and discoveries, so the stale snapshot does not grant or remove
callable tools; it remains a drift-inspection evidence gap.

A fresh ordinary Windows app turn that exposes the current registry is still
required before claiming exact app-tool-schema parity for this build.

## Original Router upstream

Reviewed original Router from
`1a339dda8e6934024d933f9a48f4b9a7d954f6d0` through
`9fb6440d9f310ce03b28e9b4eaeaf3b970b2703f` (46 commits).

Integrated the Windows launcher hardening from upstream: the managed scheduled
task now invokes `wscript.exe //E:VBScript //B //NoLogo`, so an unrelated
user-level `.vbs` file association cannot prevent the hidden Router launcher
from running. The immediately previous Router-owned action is recognized during
migration so the hardened ownership check does not misclassify the existing
installation as foreign.

Other retained-area upstream findings were dispositioned as follows:

- Responses-native reasoning preservation is already covered because Router Lite
  retired its old Chat reasoning-carry shim when LiteLLM 1.102.1 took ownership.
- The generalized Chat message-envelope repair adds no retained route beyond
  Router Lite's existing GLM repair; Pareto and Switchyard/native paths use
  Responses rather than the LiteLLM Chat bridge.
- Generic-client native string-input/non-streaming normalization is outside the
  current Codex app contract; the app sends list input and streaming native
  turns.
- Search-sidecar, generic failover, BOM-tolerant hand-edited registries, and the
  newly added provider/UI families are outside Lite ownership.
- Image-payload refusal recovery remains deferred for the image-capable GLM
  route until the retained endpoint reproduces a payload ceiling or a stable
  provider contract justifies a limit.

## Switchyard upstream

Switchyard moved from the locked `70f277e094981706854f05674da2f2ec939ac443`
to `9cf6fadfc60bfdf59ee61bf8a14226807c2540bc` (three commits). The two code
changes repair non-streaming OpenAI Chat custom-tool decoding and
Anthropic-to-Responses thinking translation. Router Lite's Switchyard path is
Responses on both sides and does not configure those Chat/Anthropic translation
surfaces, so neither fix changes the retained runtime contract.

The canonical PR #762 patch no longer applies textually to upstream HEAD because
of upstream README drift. That alone is not a reason to rebase a verified
runtime pin. Keep the reviewed source lock until a retained Switchyard behavior
or planned pin refresh requires another deliberate rebase.

## Source changes

This review updates only source/catalog/service compatibility:

- project `supports_reasoning_effort_updates` conservatively;
- pin the Windows hidden launcher to the VBScript engine;
- preserve the old Router-owned launcher action as a migration identity; and
- advance original-Router review bookkeeping.

It does not deploy, restart, or recertify the managed Router runtime.
