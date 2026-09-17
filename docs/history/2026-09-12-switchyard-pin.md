# Switchyard pin review - 2026-09-12

Historical review evidence, not the current pin or deployment status. Read
[the active integration guide](../../config/switchyard/README.md) and `source.lock`
for maintained authority.

The September 12 update selects upstream `a70a1fba`, including native freeform
tools, Responses input/reasoning fixes, target reasoning effort, and transport
URL redaction. The local patch retains exact routing IDs, native credentials,
loopback protection, classifier task-only input, and the five existing effort
targets. Target-specific prompts also key by routing ID so effort variants do
not collide. The later `1e912482` category redesign changes classifier policy
and is intentionally deferred; it needs a separate routing-quality evaluation.
