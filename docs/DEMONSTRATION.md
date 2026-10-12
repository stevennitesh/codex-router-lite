# Tool execution and continued conversation

This is a readable summary of the **October 11, 2026 historical CLI run**. The
[machine-readable record](history/2026-10-11-audit-release-certification.json)
owns its observations. The command is a synthetic compatibility check, not a
coding benchmark or a measurement of productivity.

## What was exercised

A native Codex parent assigned a routed child a small PowerShell task:

```powershell
Write-Output (19+23)
```

The child requested `exec_command` through Codex's tools. Codex executed the
command with default sandbox permissions and returned output `42` with exit
code `0`. The child then returned `CERT_FIRST_OK`. A follow-up went to that
same child, which returned `CERT_SECOND_OK` without another tool call.

This sequence tests more than an API response: a routed child requests a real
tool, receives the matching result, finishes a turn and continues on the same
thread. The [runner assignment](../maintenance/certification-runner.mjs#L58-L69)
defines the task; the
[evidence reader](../maintenance/certification-evidence.mjs) verifies tool-output
identity, markers, native parent spawn and the two encrypted handoffs.

## Observed results

All six routes in the record produced output `42`, both requested markers and
same-child continuation. Each also passed a separate streamed-response check on
the same deployed Router generation.

| Exact route | Actual tool output | First marker | Follow-up on same child |
| --- | --- | --- | --- |
| GLM / StreamLake | `42` | `CERT_FIRST_OK` | `CERT_SECOND_OK` |
| GLM / Together | `42` | `CERT_FIRST_OK` | `CERT_SECOND_OK` |
| DeepSeek / Together | `42` | `CERT_FIRST_OK` | `CERT_SECOND_OK` |
| DeepSeek / DeepInfra | `42` | `CERT_FIRST_OK` | `CERT_SECOND_OK` |
| Pareto / Unbiased | `42` | `CERT_FIRST_OK` | `CERT_SECOND_OK` |
| Switchyard / automatic native routing | `42` | `CERT_FIRST_OK` | `CERT_SECOND_OK` |

For one concrete example, GLM / StreamLake returned output `42` at
`2026-10-11T05:47:02.735Z`, its first marker at `05:47:04.963Z` and its
follow-up marker at `05:47:11.276Z`. These are recorded observations, not a
reconstructed transcript. The published record contains no private conversation
or account identifiers.

## Versions and scope

The run used Router `0.7.0`, deployed commit
`4806fa3c5962c6bf9f9384a03ed3887813b49bb9`, and
`codex-cli 0.162.0-alpha.17.2` on Windows. It used session-only MXC,
workspace-write and on-request approval. The record identifies Windows app
`26.1007.2314.0`, but the execution surface was the CLI. It does not establish
desktop elevated-sandbox compatibility or arbitrary MCP-tool compatibility.

Each route had two completed turns and two completed cleanup calls. No active
turn was cancelled. Separate Switchyard checks exercised tool continuation,
image fallback and native compaction, with each observation attached to its own
request in the same record.

## Inspect or reproduce

- [Machine record](history/2026-10-11-audit-release-certification.json): exact
  route, runtime identity, timestamps and observations.
- [Accepted route applications](../v2_agent/README.md): evidence consumed by
  package checks, with earlier dated runs retained separately.
- [Certification procedure](SUBAGENT-CERTIFICATION.md): how to run an exact-route
  check against an installed runtime. It sends quota-consuming model requests
  and needs explicit live authorization.
- [Architecture and verification](agents/architecture.md#verification): local
  source checks and their scope. These do not send model requests.

No model request or runtime replacement is needed to read this demonstration.
