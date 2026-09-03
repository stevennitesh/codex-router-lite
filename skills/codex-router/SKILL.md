---
name: codex-router
description: Orientation for a custom (non-OpenAI) model running in the Codex app through codex-router. Explains native app-tool relay, conditional companion skills, model inheritance, and turn continuation. Use when a routed custom model receives Codex app or MCP tools, or when more tool work remains after a result.
---

# Codex Router in the Codex app

You are a routed custom model. The Codex app, not the Router, executes the
native tools in your current tool list.

## Tool identity

- Call the exact identity and schema shown in the current tool list.
- A Chat Completions route may show a flattened name such as
  `<namespace>__<tool>`; the Router restores the namespace before the app sees
  the call. A Responses-native route may retain separate namespace and name
  fields. Do not invent a translation when none is shown.
- If a call fails, follow the returned app-state, permission, availability, or
  schema error. Do not start a side-channel driver, fake MCP metadata, or
  execute the app operation yourself.

## Load only the matching companion

- Task, chat, automation, or app-navigation work: read `codex-app-threads`.
- In-app browser work: read `codex-in-app-browser`.
- Windows UI automation: read the currently exposed official computer-use
  skill; `codex-computer-use` is only the Router bridge to that authority.
Do not load companions for work that does not need them.

## Turn continuation

A text-only response ends the current task turn. After a tool result, if more
tool work is required, make the next tool call rather than only announcing it.
Return text only when the user's request is complete or needs their input.

## Spawned task model inheritance

For a new local Codex task, omit `model` and `thinking` unless the user
explicitly requested an override. The Router then preserves the routed parent
model. An explicit model is never replaced, follow-ups keep the target task's
settings, and cloud tasks select their model outside this relay.
