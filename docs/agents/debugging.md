# Debugging Router behavior

Read [architecture](architecture.md) if the request path is unfamiliar. For service
startup, health, permissions or rollback begin with [troubleshooting](../TROUBLESHOOTING.md).
For installed app/CLI or upstream drift use [compatibility maintenance](compatibility-maintenance.md).
Routine wire diagnosis does not require an upstream refresh or deployment.

## Locate the first divergence

Identify the exact slug/endpoint, current source and installed generation, caller
(desktop, CLI, child), transport, and whether this is an ordinary turn, replay,
compaction or cancellation. Read configured paths from `src/paths.mjs`; source
checkout success is not proof about a different installed generation.

Start with redacted `model-router.ps1 codex status` and `doctor`. Inspect only the
relevant time window in Router timings or a user-authorized conversation log.
Distinguish provider failure, client cancellation, sandbox restrictions and app
hydration from Router defects. Do not export an existing conversation merely to
reproduce an error; prefer a minimal synthetic reproduction.

Compare the native input, prepared provider payload, provider event order and
restored native output. Preserve call IDs, namespace/name pairs, terminal status
and HTTP status in sanitized evidence. Locate the earliest violated contract:

| Symptom | First source and next guide |
| --- | --- |
| Missing model, effort or deferred tools | `src/catalog.mjs`, route JSON; [native Codex](native-codex.md) |
| HTTP 400, tool choice or replay rejected | `src/routed-request.mjs`, `src/openrouter-request.mjs`; [preparation](request-preparation.md), then the endpoint guide |
| Wrong/missing tool or custom arguments | `src/namespace-relay.mjs`; compare declaration, produced call and replay identity together |
| Missing/duplicate stream events | `src/zai-responses-compat.mjs` for GLM; generic relay, `src/message-phase.mjs`, `src/empty-completion-guard.mjs` for shared behavior |
| Lost context or false compaction success | `src/compaction-checkpoint.mjs` and compaction callers in `src/router.mjs` |
| Native handoff/auth failure | `src/codex-native-session.mjs`, `src/native-request-compat.mjs`; [native Codex](native-codex.md) |
| Disconnect, retry or proxy anomaly | `src/api-forwarder.mjs`, `src/upstream-retry.mjs`, `src/fetch-transport.mjs`, `src/proxy-environment.mjs` |
| Wrong Switchyard target/classifier output | [Switchyard runtime diagnostics](../../config/switchyard/runtime.md) |
| Missing or duplicate agent instructions | [Instruction ownership](context-ownership.md#runtime-instructions) |

## Repair and close

Fix the first owner that violates its contract. A compatibility transform is
justified when the upstream wire behavior cannot be changed here; give it an exact
scope predicate and a regression that fails without it. Remove unused transforms.
Do not hide a rejection with fallback, repeated retries, invented tool calls or
prose parsing. Use a paired case differing in the suspected cause to test a hypothesis.

Retest the actual produced history through the next turn and, when affected,
compaction or native/model switching. Include the relevant negative path and an
unaffected route for shared changes. Follow [verification](architecture.md#verification).
State what was reproduced, the repaired owner, and remaining uncertainty. Store
dated investigation evidence separately from the maintained behavior guide.
