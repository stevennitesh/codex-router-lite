---
name: codex-in-app-browser
description: Use the current Codex unified CUA runtime to operate the in-app browser from a custom (non-OpenAI) model. Use when the user asks to open, inspect, navigate, click, type, or capture a page in the Codex browser panel.
---

# Codex in-app browser

Use the current unified CUA JavaScript tool exposed by the Codex app. Its live
tool instructions own browser selection, tab creation, bootstrap, API shape,
and screenshots.

On the first call after initialization or reset, execute exactly one documented
CUA entrypoint and read the returned documentation before continuing. Reuse the
persistent bindings on later calls. Never import a versioned plugin script,
start a separate REPL, or build a side-channel browser driver.

If the unified CUA tool is absent, report that this Codex build does not expose
the supported browser runtime. Do not fall back to a retired `node_repl`
bootstrap merely because an old skill mentioned it.
