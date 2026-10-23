# Codex Router agent entry

This checkout owns Codex Router Lite for Windows. Start with the row matching
the task, then follow its conditional pointers. Read other guides when the work
crosses those boundaries.

| Task | Start here |
| --- | --- |
| Add or change a model/endpoint | [Model onboarding](docs/agents/model-onboarding.md) |
| Work on ChatGPT Web setup, saved context, native tools or Stop | [Web setup and use](docs/CHATGPT-WEB.md); for implementation, [Web integration](docs/agents/web-integration.md) |
| Understand Router Lite, its invariants, or change shared code | [Router Lite system specification](docs/agents/architecture.md) |
| Diagnose errors, odd responses, tool failures, or lost history | [Debugging and historical evidence](docs/agents/debugging.md) |
| Codex app/CLI updated: check compatibility AND relevant upstream changes | [Compatibility maintenance](docs/agents/compatibility-maintenance.md) |
| Install, deploy, or restart | [Installation](docs/INSTALL.md); for a failing service, first [troubleshooting](docs/TROUBLESHOOTING.md) |
| Change Switchyard classifier, targets, pin, or binary | [Switchyard integration specification](config/switchyard/README.md) |
| Change subagent eligibility or certify a route | [Certification](docs/SUBAGENT-CERTIFICATION.md) |
| Audit or edit repository context, documentation, or shipped agent skills | [Context ownership](docs/agents/context-ownership.md) |
| Work on issues or labels | [Tracker](docs/agents/issue-tracker.md) |

Verification commands and their scope live in the
[system specification](docs/agents/architecture.md#verification).
Inspect Git status and branch; preserve existing work. Keep credentials and private
payloads out of source and output. Commit and push only within user authorization.
Historical evidence is not current runtime authority.
