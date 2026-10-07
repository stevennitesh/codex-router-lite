# Latency and route-settings deployment: 2026-10-07

Historical deployment and certification evidence, not current runtime authority.

## Deployed candidate

Router commit `c95a10b926de218971c85727efa31eae407eb8af` was pushed to
`origin/main` and deployed through the independent checkout transaction.
Acceptance completed at `2026-10-07T23:47:31.2477755Z`. The previous installed
Router revision was `4ca8bfa6012b6ba3a2057df23361761ce48bbdba`.

The worker verified full Router and Switchyard health, scheduled-task and process
ownership, the install manifest, runtime provenance and hashes, installed catalog
parsing, Doctor, and unauthenticated refusals on protected Switchyard endpoints.
It retained the installed Switchyard binary and private routes; no Codex binary
was replaced. Persistent `windows.sandbox = "elevated"` was unchanged.

Source verification is recorded in the [route-settings audit](2026-10-07-route-settings-audit.md):
497 active tests, current Codex catalog parsing, and the focused regression run
after the independent review correction. The [latency investigation](2026-10-07-router-latency.md)
records the performance experiments and their limits.

## Native certification

The [reviewed five-route run](2026-10-07-latency-settings-certification.json)
renewed GLM Together, DeepSeek Together, DeepSeek DeepInfra, Pareto and Switchyard.
Each exact route passed streamed text and completion, a real sandboxed command
returning `42`, two encrypted handoffs, and both markers from the same child.
All 15 native child requests and five separate streaming requests returned
HTTP 200. No active child turn was cancelled.

The native CLI was `0.162.0-alpha.2`, with observed Windows app version
`26.1002.7124.0`. Certification selected MXC only for that CLI session, retaining
workspace-write and on-request approval. It does not certify the desktop's
elevated sandbox or arbitrary MCP tools. Switchyard's binary, routes and deployed
Router commit are bound in its accepted application. Additional classifier,
media and compaction runs were unnecessary because those contracts were unchanged.

## StreamLake attempt and recovery retention

A separate fresh run attempted only `openrouter/glm-5.3-flash-streamlake` on the
same deployed candidate. Its synthetic streaming phase failed. The matching
Router timing at `2026-10-07T23:50:50.808Z` recorded provider `openrouter`,
HTTP 429 and 603 ms total. No native parent or publishable draft was produced,
and **no refreshed StreamLake proof** was accepted. The preceding accepted
application remains historical evidence for its own earlier revision.

The earlier [direct-provider diagnosis](2026-10-07-streamlake-shared-capacity.md)
established a StreamLake shared-pool capacity refusal. This certification runner
did not retain the current refusal body, so the new status alone does not
independently establish its precise cause. No fallback or automatic retry was
introduced.

The detached previous-revision checkout and protected runtime rollback snapshot
remain retained while the StreamLake check is unresolved. A healthy deployment
was not rolled back merely because a provider refused inference. Any repair
deployment must preserve that recovery set through the maintained transaction.
Release requires completion of the outstanding acceptance check and a fresh
process-ownership/full-health check.

The later evidence-only commit publishes these records and applications; it does
not replace the deployed candidate identity or require another runtime deployment.
Raw rollouts, session identifiers, private run artifacts and capabilities remain
outside tracked files.
