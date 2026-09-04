# v2 agent application: `switchyard/auto`

## Route

- Routed slug: `switchyard/auto`
- Native target family: `gpt-5.6-luna` and `gpt-5.6-sol`
- Switchyard upstream: `4022b677b20e852de538e0a1a56f041d3ba39f1f`
- Router version: `0.5.1`, commit `06523bd4cbb51a3650d39e162061438ae875a73f`
- Codex version/build: `codex-cli 0.153.0`
- Execution surface: Codex desktop native orchestration on Windows
- Current application status: accepted

The exact pinned source, compatibility patch, release binary, Router commit,
and generated routes recorded in `proof.json` were deployed together. A native
Windows Codex parent created an exact-route `switchyard/auto` child, which ran a
real Git tool call, returned the first marker, accepted a follow-up on the same
child, and returned the second marker. The live trace used one agent and
correlation ID throughout and contained no classifier error or fallback.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Source and patch | pass | The canonical patch applies cleanly to the pinned upstream commit. |
| Build and static tests | pass | Rust 1.96.1 format, clippy, retained tests, and release build passed on Windows. |
| Streaming Responses | pass | `switchyard/auto` streamed successfully with status 200. |
| Function call | pass | The child called `git rev-parse --show-toplevel` and continued normally. |
| Encrypted relay | pass | The native parent-to-child relay continued through the ordinary Codex app path with status 200. |
| Marker-return spawn | pass | The child returned `SWITCHYARD_V2_WIRE_MARKER_ONE`. |
| Same-thread follow-up | pass | Agent/correlation ID `01a06ad2-f6c0-7940-8be1-748d3c2252e7` returned `SWITCHYARD_V2_WIRE_MARKER_TWO`. |

## Limits and reviewer reproduction

Acceptance applies only to the exact runtime binding in `proof.json`. Re-run the
five checks from `docs/SUBAGENT-CERTIFICATION.md` whenever the Router commit,
Switchyard source or patch, release binary, generated routes, Codex build, or
native Windows orchestration behavior changes.
