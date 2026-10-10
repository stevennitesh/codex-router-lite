# Windows compatibility deployment and certification, 2026-10-10

Historical release evidence. Timestamps use UTC; this record does not identify a
later installation or certify untested execution paths.

## Publication and verification

[PR #26](https://github.com/stevennitesh/codex-router-lite/pull/26) merged the
[compatibility repairs](2026-10-10-compatibility-repairs.json) as commit
`f8bc922bd0f79ae1ad253cda77451c72dca8621d`.
Independent local review found one stream-failure observation defect; it was
fixed and a fresh review found no further actionable issues. GitHub Codex review
also completed without major findings on the final PR head
`7d59eee94890211295ecda5f44debde3ddd71ebc`. There were no unresolved review threads.
The merged tree matches that reviewed head. Both local and remote PR branches
were removed after merge.

Local `npm run verify:codex` passed 753 tests and parsed all 17 installed models.
The first CI run exposed a Node 22 test-fixture problem: its awaited lock
heartbeat had no referenced event-loop handle. A bounded referenced deadline
fixed the fixture without changing production lock behavior. The final
[CI run](https://github.com/stevennitesh/codex-router-lite/actions/runs/38068328502)
passed on Node 22.19.0 and Node 24, including the Node and Python dependency audits.

## Deployment and recovery

The independent deployment worker accepted the merged revision at
`2026-10-10T17:01:28.6931198Z`. All eleven acceptance checks passed: full Router
and Switchyard health, task and process ownership, clean candidate, install
manifest, Doctor, protected endpoints, provenance, installed hashes and catalog.

Normal deployment waited 90 seconds with one active request, restored admission
and left the prior version running. The operator then explicitly approved
restarting Router and interrupting that request. The guarded deployment succeeded;
its recovery copy could restore previous software but could not resume the request.

The Switchyard pin, binary and routes were unchanged:

- upstream commit: `fbabf51c62793ed0f6af042b60e92ce1cfba083b`
- binary SHA-256: `c8f0434a224a84a7db769f1eb0ca392e6f4159fc5e4e87fa330cfff7dca5dca1`
- routes SHA-256: `9d69181ce81c689050ddf4c4fb6bc6785aef01e534a87bf665c9e925c80fc97a`

Full Router health and live process ownership passed again at
`2026-10-10T17:11:47.8315209Z`, after certification. The runtime backup and previous
Router checkout remain retained for recovery. No Codex binaries or persistent
sandbox settings were replaced.

## Route certification

Shared Responses compatibility changes affected all six routes. The
[first accepted batch](2026-10-10-compatibility-certification.json) covers StreamLake,
both DeepSeek routes, Pareto and Switchyard. GLM Together returned HTTP 429 before
its native sequence. A fresh [Together-only run](2026-10-10-compatibility-together-certification.json)
passed on the same deployed revision and pinned endpoint, with no fallback.
The initial refusal remains a failed observation, separate from the accepted run.

All six routes passed streamed completion, an actual native tool call, encrypted
parent-to-child relay, the first marker and a follow-up marker from the same child.
The accepted runs contain six successful streaming requests and 18 native child
requests, all HTTP 200. Each child produced output `42` from a sandboxed command
and received two encrypted handoffs. Cleanup cancelled no active turns.
Switchyard classifier, routing, media and compaction behavior were unchanged,
so the separate supplemental smoke checks were not repeated.

The runs used CLI `0.162.0-alpha.17.2`, Windows app `26.1007.2314.0`, session-only
MXC, workspace-write and on-request approval. They do not certify the desktop's
elevated sandbox, arbitrary MCP tools or model reliability. Raw transcripts,
session identifiers and provider bodies remain local.

The proof records and this report are published in a later evidence-only commit.
They retain the deployed revision above; publishing them does not require another
runtime replacement or model run.
