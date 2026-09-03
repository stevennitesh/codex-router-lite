---
name: codex-computer-use
description: Route a custom (non-OpenAI) model to the current official Codex computer-use skill and unified CUA tool. Use when the user asks to operate Windows app UI that no purpose-built connector, API, or CLI can reach.
---

# Codex computer use

Read the currently exposed official computer-use skill before acting. It owns
the Windows safety rules, confirmation policy, application support, and current
CUA API. Then use the exact unified CUA tool and schema shown in this session.

Prefer a purpose-built connector, API, or CLI when one exists. Never import a
retired `@oai/sky` or `node_repl` bootstrap, guess a plugin-version path, start a
separate driver, or reuse approval claims from an older Codex build.

If the official skill or unified CUA tool is absent, report that the supported
computer-use surface is unavailable.
