# Codex Router agent entry

This checkout owns the Windows Codex Router. Read only the task branch below;
follow its conditional pointers rather than loading all documentation.

| Task | Start here |
| --- | --- |
| Add or change a model/endpoint | [Model onboarding](docs/agents/model-onboarding.md) |
| Understand the Router or change shared code | [Architecture and ownership](docs/agents/architecture.md) |
| Diagnose errors, odd responses, tool failures, or lost history | [Debugging](docs/agents/debugging.md) |
| Codex app/CLI updated: check compatibility AND relevant upstream changes | [Compatibility maintenance](docs/agents/compatibility-maintenance.md) |
| Install, deploy, or restart | [Installation](docs/INSTALL.md); for a failing service, first [troubleshooting](docs/TROUBLESHOOTING.md) |
| Change Switchyard classifier, targets, pin, or binary | [Switchyard integration](config/switchyard/README.md) |
| Change subagent eligibility or certify a route | [Certification](docs/SUBAGENT-CERTIFICATION.md) |
| Edit repository instructions or documentation | [Context ownership](docs/agents/context-ownership.md) |
| Work on issues or labels | [Tracker](docs/agents/issue-tracker.md) |
| Resolve domain meaning or accepted decisions | [Domain route](docs/agents/domain.md) |

Before substantive code work, also read the [engineering contract](docs/agents/engineering-contract.md).
Inspect Git status and branch; preserve existing work. Keep credentials and private
payloads out of source and output. Commit and push only within user authorization.
Historical evidence is not current runtime authority.
