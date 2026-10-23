---
name: codex-in-app-browser
description: Route a custom (non-OpenAI) model to the current Codex in-app browser runtime. Use when the user asks to open, inspect, navigate, click, type, or capture a page in the Codex browser panel.
---

# Codex in-app browser

Read the current task's browser tool definitions and any official browser skill
or runtime documentation they reference. Follow their documented initialization,
then read returned runtime documentation before further browser actions. These
sources own browser selection, tab creation, API shape, screenshots, and action
confirmation rules.

Use the exact tool identity and schema exposed in this task, including any
documented JavaScript runtime setup. Reuse this task's own persistent bindings;
after a reset, follow the current initialization instructions again. Do not borrow
another task's session state, guess plugin-version paths, or build a side-channel
browser driver.

If the supported browser capability remains unavailable after following its
documented discovery and setup, report the missing prerequisite. A tool name or
bootstrap remembered from an older Codex build does not establish availability.
