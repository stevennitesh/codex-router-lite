# v2 agent application: `switchyard/auto`

## Route

- Routed slug: `switchyard/auto`
- Native target family: `gpt-5.6-luna` and `gpt-5.6-sol`
- Switchyard upstream: `9a743e89223a0d5b14011f1226d5b068f730a3b8`
- Router version: `0.5.1`, deployed commit `c939e3abb060d46ae5abbc17bb673d47b4f00232`
- Codex version/build: `codex-cli 0.153.4`, Windows app `26.901.5280.0`
- Execution surface: Codex desktop native orchestration on Windows
- Current application status: accepted

The exact source, patch, release binary, Router commit, and generated routes
recorded in `proof.json` were deployed together through the guarded transaction.
The patch preserves local-hop authentication in upstream's shared router
constructor and adds a regression for both embedded and standalone constructors.
Existing classifier behavior, target overrides, tool continuation, and route
policy remain intact.

The native parent continued `switchyard_cert_9a743e8` for a clean proof sequence.
The child called the native app `list_projects` tool, returned
`SWITCHYARD_9A743E8_CLEAN_ONE`, and then returned
`SWITCHYARD_9A743E8_CLEAN_TWO` on a separate follow-up to the same child.
The accepted window from `2026-09-05T09:01:43.328Z` through
`2026-09-05T09:02:10.912Z` contains three successful HTTP 200 responses, all
served by `switchyard/luna-high`, with no classifier error or fallback.
An earlier interrupted follow-up is excluded from this acceptance window.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Source and patch | pass | Forward application to a fresh pinned checkout and reverse application to the tested source both passed. |
| Build and tests | pass | Rust 1.96.1 format, workspace Clippy, retained crate tests, and Windows release build passed. |
| Runtime identity | pass | Installed binary, routes, source, patch, and Router hashes matched deployment provenance. |
| Local-hop protection | pass | Unauthenticated models and decision requests returned 401; Router and Switchyard health passed. |
| Streaming and app tool | pass | Native list_projects call completed at 2026-09-05T09:01:43.328Z, HTTP 200. |
| Encrypted relay | pass | Ordinary native parent-to-child handoff produced the tool call and returned its result. |
| First marker | pass | SWITCHYARD_9A743E8_CLEAN_ONE returned at 2026-09-05T09:01:47.003Z, HTTP 200. |
| Same-child follow-up | pass | SWITCHYARD_9A743E8_CLEAN_TWO returned at 2026-09-05T09:02:10.912Z, HTTP 200. |

## Limits and reviewer reproduction

Acceptance applies only to the exact runtime binding in `proof.json`. The
evidence commit follows the deployed candidate and does not change runtime code.
Repeat the five checks from `docs/SUBAGENT-CERTIFICATION.md` after changing the
runtime binding or native orchestration contract. The earlier interrupted
sequence and separate GLM child app-tool probes are not Switchyard proof.
