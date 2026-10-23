---
name: codex-computer-use
description: Route a custom (non-OpenAI) model to the current official Codex computer-use skill and tools. Use when the user asks to operate Windows app UI that no purpose-built connector, API, or CLI can reach.
---

# Codex computer use

Read the currently exposed official computer-use skill before acting or declaring
computer use unavailable. It owns the Windows safety rules, confirmation policy,
application support, and runtime setup. Follow its documented initialization and
read the required runtime documentation before controlling apps.

Use the exact tools and schemas exposed in this task, including any documented
JavaScript imports. Reuse only this task's own runtime/session state. Do not guess
plugin-version paths, build a separate driver, borrow another task's session, or
reuse approval claims from an older Codex build.

Prefer a purpose-built connector, API, or CLI when one exists. If the official
skill or its supported tools remain unavailable after their documented setup,
report the missing prerequisite.
