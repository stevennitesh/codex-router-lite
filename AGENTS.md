# Codex Router agent instructions

This repository is the source of truth for the installed Codex Router. Keep this
file on the common path; load the detailed runbook only for the branch of work
you are performing.

The retained product is Windows Codex app and native Codex compatibility,
`openrouter/glm-5.3-flash`, `switchyard/auto` over native Codex models, and
exact-route subagents v2. Treat other clients, providers, platforms, and Router
UIs as legacy. Touch them only to isolate or remove dependencies, preserve a
required migration, or prevent regressions in the retained product.

## Before changing anything

- Inspect `git status`, the active branch, and the configured runtime paths.
  Preserve unrelated user changes.
- Load only the branch-specific guide named below. Do not preload every
  maintenance document.

## Route to the detailed runbook

- Legacy client, API/OAuth relay, response translation, or retry removal work
  involving DeepSeek Harness, Gemini CLI, Cursor, Claude Code, or OpenClaw:
  read the corresponding outcome, procedure, and write-boundary sections in
  [`docs/agents/router-maintenance.md`](docs/agents/router-maintenance.md).
- Legacy provider, model, vision, embeddings, anonymous endpoint, or local-model
  removal work: read only the matching section in that runbook.
- Codex native catalog, app functions/tools, namespace relay, installed-version
  drift, Windows Codex app, OpenRouter, or GLM-5.3-Flash work: read
  [`docs/agents/compatibility-maintenance.md`](docs/agents/compatibility-maintenance.md).
- Switchyard source, routes, rebuilds, startup, health, or deployment: after the
  compatibility guide, read [`config/switchyard/README.md`](config/switchyard/README.md).
  Its checked-in patch, route template, and `source.lock` are authoritative;
  the installed runtime is generated output.
- Control Center, desktop tray, macOS, or Linux removal and migration work: read
  [`apps/control-center/README.md`](apps/control-center/README.md) for the
  cross-platform app and [`docs/MACOS-TRAY.md`](docs/MACOS-TRAY.md) only for the
  native macOS host.
- Service, gateway, update, rollback, or installer work: read the matching
  lifecycle and installation sections in the detailed runbook before touching
  a live runtime.
- Credential, discovery-disabled, proxy, or remote-endpoint work: read the
  matching security boundary and preserve its fail-closed behavior.
- Subagent claims, selection semantics, proof artifacts, or v2 declarations:
  read [`docs/SUBAGENT-CERTIFICATION.md`](docs/SUBAGENT-CERTIFICATION.md). Bind
  registry acceptance to exact route and runtime evidence.
- Specification, issue, or tracker work: read
  [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
- Label, state, or triage work: read
  [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
- Settled domain meaning or ADR work: read
  [`docs/agents/domain.md`](docs/agents/domain.md), then load only the context
  record or ADR it points to.
- Load [`docs/agents/engineering-contract.md`](docs/agents/engineering-contract.md)
  only when an invoked engineering skill requires shared design judgment.
- Generated media or scratch work: follow `Generated media and scratch output`.

## Commands

- JavaScript syntax and v2 application validation: `npm run check`.
- Full Node test suite: `npm test`.

## Common implementation contract

- Keep native GPT routes and Codex-owned catalog behavior unchanged unless the
  task explicitly targets them. Apply compatibility changes only to the routed
  model or provider that requires them.
- Keep one active runtime. Build third-party sources in a disposable checkout;
  retain only the reproducible pin, canonical patch, and active deployed
  artifacts described by their integration runbook.
- Never issue a standalone Router stop during maintenance. On Windows use
  `restart-codex-router.ps1 -InstallDir <intended-install-root>`; elsewhere use
  the guarded service restart named by `src/router-restart.mjs`. A deployment
  transaction must restore and start the previous runtime on failure.
- Keep secrets out of source, command output, logs, fixtures, and support
  bundles. Use the protected stores and generated placeholders described by the
  runbook.
- Add or update the narrow regression test for a behavior change. Run
  `npm run check`, the affected tests, and any current Codex catalog compatibility
  check. For deployment, also prove the installed source/hash and live health or
  routed behavior.
- Use `generated/` or a disposable temp directory for scratch output. Do not add
  permanent source clones, ad hoc backups, or alternate runtime trees.
- Do not push unless the user asks. Commit only when requested or when the
  repository workflow for the task explicitly requires it.
