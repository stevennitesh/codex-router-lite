# Codex Router agent instructions

This repository is the source of truth for the installed Codex Router. Keep this
file on the common path; load the detailed runbook only for the branch of work
you are performing.

## Before changing anything

- Inspect `git status`, the active branch, and the configured runtime paths.
  Preserve unrelated user changes.
- Read the matching section of
  [`docs/agents/router-maintenance.md`](docs/agents/router-maintenance.md) before
  changing installation, providers, models, credentials, catalogs, relays,
  service behavior, or client integration.
- For Switchyard source, routing, rebuilds, or deployment, also read
  [`config/switchyard/README.md`](config/switchyard/README.md). Its checked-in
  patch, route template, and `source.lock` are authoritative; the installed
  runtime is generated output.

## Route to the detailed runbook

- Codex, DeepSeek Harness, Gemini CLI, Cursor, Claude Code, or OpenClaw setup:
  read the corresponding outcome, procedure, and write-boundary sections.
- Model, provider, context-window, vision, embeddings, anonymous endpoint, or
  local-model work: read `Requests to install or expose more models` and the
  provider-specific section involved.
- GLM-5.3-Flash work: read `GLM-5.3-Flash routes` and `Routed subagent regression
  prevention`.
- Service, gateway, update, rollback, or installer work: read the lifecycle and
  installation sections before operating on a live runtime.
- Credential, discovery-disabled, proxy, or remote-endpoint work: read the
  matching security boundary and preserve its fail-closed behavior.
- Subagent claims or v2 declarations: read `Subagent capability is researched,
  not asserted` and the routed subagent regression section. Bind acceptance to
  exact route and runtime evidence.
- Generated media or scratch work: follow `Generated media and scratch output`.

## Common implementation contract

- Keep native GPT routes and Codex-owned catalog behavior unchanged unless the
  task explicitly targets them. Apply compatibility changes only to the routed
  model or provider that requires them.
- Keep one active runtime. Build third-party sources in a disposable checkout;
  retain only the reproducible pin, canonical patch, and active deployed
  artifacts described by their integration runbook.
- Never issue a standalone Router stop during maintenance. Use the guarded
  restart entry point, or one independent rollback-owning transaction that
  restores and starts the previous runtime on failure.
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
