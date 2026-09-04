# v2 agent application: `switchyard/auto`

## Route

- Routed slug: `switchyard/auto`
- Native target family: `gpt-5.6-luna` and `gpt-5.6-sol`
- Switchyard upstream: `4022b677b20e852de538e0a1a56f041d3ba39f1f`
- Router version: `0.5.1`, candidate commit pending
- Codex version/build: `codex-cli 0.153.0`
- Execution surface: Codex desktop native orchestration on Windows
- Current application status: draft

The pinned source with the canonical Codex compatibility patch passes format,
clippy, the Switchyard compatibility test set, and a release build. The draft
records that candidate binary and the current generated route hash. It does not
claim native subagent compatibility yet. The Router candidate must be committed
and deployed before the runtime binding and five live checks can be accepted.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Source and patch | pass | The canonical patch applies cleanly to the pinned upstream commit. |
| Build and static tests | pass | Rust 1.96.1 format, clippy, retained tests, and release build passed on Windows. |
| Streaming Responses | pending | Requires the deployed candidate through the ordinary Codex route. |
| Function call | pending | Requires the deployed candidate through the ordinary Codex route. |
| Encrypted relay | pending | Requires a native parent to create a `switchyard/auto` child. |
| Marker-return spawn | pending | Requires the deployed native child path. |
| Same-thread follow-up | pending | Requires a follow-up to the same native child. |

## Limits and reviewer reproduction

Deploy the exact Router commit, Switchyard binary, and generated routes recorded
in `proof.json`. Then run the five checks from
`docs/SUBAGENT-CERTIFICATION.md` through the Windows Codex app. Do not mark the
application accepted or change the route to v2 from build evidence alone.
