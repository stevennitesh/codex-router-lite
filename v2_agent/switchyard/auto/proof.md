# v2 agent application: `switchyard/auto`

## Route

- Routed slug: `switchyard/auto`
- Native target family: `gpt-5.6-luna` and `gpt-5.6-sol`
- Switchyard upstream: `4eae4bf1e464bd778f1e68c4d5824bc195c3e692`
- Router version: `0.5.1`, commit `83a142cc8172245723d0b1f53aab4cdb92e948e6`
- Codex version/build: `codex-cli 0.153.3`
- Execution surface: Codex desktop native orchestration on Windows
- Current application status: draft pending recertification of upstream `9a743e89223a0d5b14011f1226d5b068f730a3b8`

The evidence below is historical and applies to the previous runtime only.
The new source and patch require a fresh native deployment proof before acceptance.

The exact pinned source, compatibility patch, release binary, Router commit,
and generated routes recorded in `proof.json` were deployed together. A native
Windows Codex parent continued the exact-route child
`switchyard_v2_cert_4eae_final`, which ran a real Git tool call, returned the
first marker, accepted a follow-up on that same child, and returned the second
marker. The accepted window from `2026-09-05T00:12:58.403Z` through
`2026-09-05T00:13:15.097Z` selected `switchyard/sol-medium` throughout and
contained no classifier error, fallback, or cancellation.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Source and patch | pass | The canonical patch applies cleanly to the pinned upstream commit. |
| Build and static tests | pass | Rust 1.96.1 format, clippy, retained tests, and release build passed on Windows. |
| Streaming Responses | pass | `switchyard/auto` streamed successfully with status 200 at `2026-09-05T00:12:58.403Z`. |
| Function call | pass | The child called `git rev-parse --show-toplevel` and continued normally at `2026-09-05T00:12:58.403Z`. |
| Encrypted relay | pass | The native parent-to-child relay continued through the ordinary Codex app path with status 200 at `2026-09-05T00:12:58.403Z`. |
| Marker-return spawn | pass | The child returned `SWITCHYARD_V2_WIRE_MARKER_ONE` at `2026-09-05T00:13:01.433Z`. |
| Same-thread follow-up | pass | The same child returned `SWITCHYARD_V2_WIRE_MARKER_TWO` at `2026-09-05T00:13:15.097Z`. |

## Limits and reviewer reproduction

Acceptance applies only to the exact runtime binding in `proof.json`. Re-run the
five checks from `docs/SUBAGENT-CERTIFICATION.md` whenever the Router commit,
Switchyard source or patch, release binary, generated routes, Codex build, or
native Windows orchestration behavior changes.
