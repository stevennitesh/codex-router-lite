# Pareto v2 certification

Accepted for `openrouter/pareto` → `unbiased/pareto`, pinned to the Unbiased
endpoint with provider fallback disabled.

## Evidence

On 2026-09-18, a fresh native Sol parent using Codex CLI
`0.155.0-alpha.2.6` spawned the generated `router_openrouter_pareto` role.
The run used deployed Router `0.5.1`, commit
`5547e5ec14328d11aee16caeadad695c24d27c82`, with v2 eligibility published
for the authorized certification window. Runtime code was unchanged.

- Window: `00:22:18.819Z` through `00:22:52.469Z`.
- Both child turns selected `openrouter/pareto`.
- Two encrypted handoffs arrived at `00:22:26.003Z` and `00:22:41.337Z`.
- The child called native `exec_command` with `Write-Output (19+23)`.
  The default sandbox succeeded on its first attempt: exit 0, output `42`.
- Streamed completion returned `PARETO_V2_FIRST_OK` at `00:22:34.670Z`.
- Native `followup_task` targeted that same child and returned
  `PARETO_V2_SECOND_OK` at `00:22:45.582Z`.
- The parent interrupted the child only after the second marker and exited 0
  with `PARETO_V2_PARENT_PASS`.
- All three Pareto Router requests completed with HTTP 200, in 6,328 ms,
  1,269 ms, and 4,223 ms. There were no canceled requests in this window.

Evidence was checked against native parent and child rollout events, actual tool
output, Router timings, and the installed commit manifest. Local scratch summaries
live under `generated/pareto/`; private logs and encrypted payloads are not part
of this application.

## Scope and limitations

This proves the native CLI collaboration path, including encrypted relay and
same-child continuation. It does not claim a desktop GUI run or identify Pareto's
underlying models. The retired Union proof is not used. The CLI emitted unrelated
PowerShell snapshot and documentation-MCP startup warnings; neither prevented
the tool or collaboration checks. Refresh this proof when the exact endpoint,
request policy, relay behavior, or relevant runtime changes.
