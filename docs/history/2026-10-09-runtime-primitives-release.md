# Runtime primitives deployment and certification, 2026-10-09

Historical release evidence. Timestamps use UTC; this record does not establish
the identity of a later installation.

## Deployed revision

Commit `3aa818e771b1e644cf891752787f5ea9acbf04b7` contains the
[runtime primitives repairs](2026-10-09-runtime-primitives-audit-fixes.md).
It was pushed to `origin/main` and deployed through the independent checkout
transaction. The worker accepted it at `2026-10-09T06:46:24.2002795Z`.
All eleven acceptance checks passed: full Router and Switchyard health, task
and process ownership, clean candidate, install manifest, Doctor, protected
endpoints, provenance, installed hashes and installed catalog parsing.
Normal admission drain succeeded; forced replacement was not used.

The transaction retained the installed Switchyard binary and private routes.
Their SHA-256 identities remained:

- binary: `c8f0434a224a84a7db769f1eb0ca392e6f4159fc5e4e87fa330cfff7dca5dca1`
- routes: `9d69181ce81c689050ddf4c4fb6bc6785aef01e534a87bf665c9e925c80fc97a`

Only their Router-commit binding changed. No Codex binary or persistent Windows
sandbox setting was replaced.

## Verification

The [candidate CI run](https://github.com/stevennitesh/codex-router-lite/actions/runs/37894832952)
passed on Windows with Node 22.19.0 and 24.x. The Node 22 job passed all
684 tests. The Node production audit and hashed Python lock audit reported no
known vulnerabilities. Local current-Codex parsing had already passed for all
17 models on CLI `0.162.0-alpha.2`; unchanged source verification was reused.

## Switchyard proof renewal

The [reviewed certification](2026-10-09-runtime-primitives-certification.json)
passed all five required checks for `switchyard/auto` on the deployed revision.
The separate streaming request and all three native child requests returned
HTTP 200. The child produced `42` from an actual sandboxed command, received
two encrypted handoffs, and returned both markers from the same thread.
Two cleanup calls observed already-completed turns; no active turn was cancelled.

The proof binds the unchanged Switchyard source, patches, binary, routes and
template to the deployed Router commit. Other routes retain their prior accepted
proofs because their request, tool and endpoint contracts did not change.
The classifier, routing targets and supplemental media/compaction paths were
unchanged; their previous observations were not repeated or counted as new checks.

The run used Codex CLI `0.162.0-alpha.2`, Windows app `26.1002.7124.0`,
session-only MXC, workspace-write and on-request approval. It does not certify
the desktop's elevated sandbox, arbitrary MCP tools, or model reliability.
Persistent `windows.sandbox = "elevated"` remained unchanged. Raw transcripts,
session identities, provider bodies and capabilities remain local.

## Recovery retention

The runtime backup and exact previous Router checkout were retained through
proof acceptance. At `2026-10-09T06:50:52.980Z`, the current process still belonged
to the installed checkout, its manifest identified the deployed revision, and
full Router health returned HTTP 200 with no degraded components. The clean
disposable recovery checkout and this deployment's runtime backup were removed
at `2026-10-09T06:50:56.2803876Z`. The worker had already removed its staging
directory. Other recovery paths and private observation records were preserved.

The accepted proof and this record are published in a later evidence-only
commit. Their identities continue to name the deployed revision above; these
documentation and proof changes do not require another runtime replacement.
