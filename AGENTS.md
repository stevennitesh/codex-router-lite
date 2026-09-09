# Codex Router agent instructions

This repository is the source of truth for the installed Codex Router. Keep this
file on the common path; load the detailed runbook only for the branch of work
you are performing.

The retained product is Windows Codex app and native Codex compatibility, exact
Novita and GMICloud routes for OpenRouter GLM-5.3-Flash, `switchyard/auto` over
native Codex models, and exact-route subagents v2. Other clients, providers,
platforms, Router UIs, and migration systems are outside the product and must
not return.

## Before code or runtime changes

- Inspect `git status`, the active branch, and the configured runtime paths.
  Preserve unrelated user changes.
- Load only the branch-specific guide named below. Do not preload every
  maintenance document.

## Route to the detailed runbook

- Installed Windows app/CLI drift or upstream review: start with
  [`docs/agents/compatibility-maintenance.md`](docs/agents/compatibility-maintenance.md).
- Native catalog, app functions/tools, namespace relay, or encrypted handoffs:
  read [native Codex compatibility](docs/agents/native-codex.md).
- GLM endpoint policy, Responses repair, hosted search, or Python pins:
  read [OpenRouter GLM compatibility](docs/agents/openrouter-glm.md).
- Switchyard source, routes, rebuilds, startup, health, or deployment: read
  [`config/switchyard/README.md`](config/switchyard/README.md), then only its
  applicable runtime or maintenance branch.
  Its checked-in patch, route template, and `source.lock` are authoritative;
  the installed runtime is generated output.
- Installation, update, or deployment work: read
  [`docs/INSTALL.md`](docs/INSTALL.md). Service failure or rollback work: read
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) before touching a live
  runtime.
- Credential or remote-endpoint work: read the forwarding boundary in
  [native Codex](docs/agents/native-codex.md), the exact-endpoint policy in
  [OpenRouter GLM](docs/agents/openrouter-glm.md), or the local-hop boundary in
  [Switchyard](config/switchyard/README.md#security-and-request-flow), according
  to the affected hop. Preserve fail-closed behavior. For proxy changes, trace
  `src/proxy-environment.mjs` and `src/fetch-transport.mjs` as the current owners.
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
- For substantive code design, implementation, debugging, refactoring, or review,
  read [`docs/agents/engineering-contract.md`](docs/agents/engineering-contract.md).

## Commands

- JavaScript syntax, product-boundary enforcement, and v2 application
  validation, including the Python dependency lock: `npm run check`.
- Retained-product suite: `npm test`.

## Common implementation contract

- Keep native GPT routes and Codex-owned catalog behavior unchanged unless the
  task explicitly targets them. Apply compatibility changes only to the routed
  model or provider that requires them.
- Treat [`maintenance/windows-package.json`](maintenance/windows-package.json)
  as the complete installed file set. The permanent product check rejects
  excluded families and transitional adapters; do not weaken it to keep dead
  code.
- Keep one active runtime. Build third-party sources in a disposable checkout;
  retain only the reproducible pin, canonical patch, and active deployed
  artifacts described by their integration runbook.
- Never issue a standalone Router stop during maintenance. Use
  `restart-codex-router.ps1 -InstallDir <intended-install-root>`. A deployment
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
