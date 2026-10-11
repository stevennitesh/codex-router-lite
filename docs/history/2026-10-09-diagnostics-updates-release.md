# Diagnostics and update deployment and certification, 2026-10-09

Historical release evidence. Timestamps use UTC; this record does not establish
the identity of a later installation.

## Deployed revision

Commit `ec7ae0a9df3ee5ced01ae64b548ba4d2c0e68524` contains the
[diagnostics and update repairs](2026-10-09-diagnostics-updates-audit-fixes.md).
It was pushed to `origin/main` and deployed through the independent checkout
transaction. The worker accepted it at `2026-10-09T08:12:01.229711Z`.
All eleven acceptance checks passed: full Router and Switchyard health, task
and process ownership, clean candidate, install manifest, Doctor, protected
endpoints, provenance, installed hashes and installed catalog parsing.

The first normal drain deferred after 90 seconds with three active requests
and no Switchyard workflows. It restored admission and left the running
generation unchanged. The operator explicitly approved one controlled
replacement; the guarded transaction then deployed the candidate successfully.

The installed Switchyard binary and private routes were retained:

- binary SHA-256: `c8f0434a224a84a7db769f1eb0ca392e6f4159fc5e4e87fa330cfff7dca5dca1`
- routes SHA-256: `9d69181ce81c689050ddf4c4fb6bc6785aef01e534a87bf665c9e925c80fc97a`

Their Router-commit binding changed. No Codex binary or persistent Windows
sandbox setting was replaced.

## Verification

The [candidate CI run](https://github.com/stevennitesh/codex-router-lite/actions/runs/37902743600)
passed all 696 tests on both supported Windows environments: Node 22.19.0
and 24.x. The Node production dependency audit and hashed Python lock audit
reported no known vulnerabilities. Local source checks and 94 affected tests
had already passed; that unchanged verification was reused.

## Switchyard proof renewal

The [reviewed certification](2026-10-09-diagnostics-updates-certification.json)
passed all five required checks for `switchyard/auto` on the deployed revision.
The separate streaming request and all three native child requests returned
HTTP 200. The child produced `42` from an actual sandboxed command, received
two encrypted handoffs and returned both markers from the same thread.
Two cleanup calls observed already-completed turns; no active turn was cancelled.

The proof binds the unchanged Switchyard source, patches, binary, routes and
template to the deployed Router commit. Other routes retain their prior accepted
proofs because their request, tool and endpoint contracts did not change.
Classifier policy and supplemental media/compaction paths were unchanged;
their previous observations were not repeated or counted as new checks.

The run used Codex CLI `0.162.0-alpha.2`, Windows app `26.1002.7124.0`,
session-only MXC, workspace-write and on-request approval. It does not certify
the desktop's elevated sandbox, arbitrary MCP tools or model reliability.
Persistent `windows.sandbox = "elevated"` remained unchanged. Raw transcripts,
session identities, provider bodies and capabilities remain local.

## Recovery retention

The runtime backup and exact previous Router checkout were retained through
proof acceptance. At `2026-10-09T08:14:58.7490497Z`, full Router health and
installed task, process and manifest ownership passed again, with the manifest
and Switchyard provenance still identifying the deployed revision.
The clean disposable recovery checkout and this deployment's runtime backup
were removed at `2026-10-09T08:15:02.8892392Z`. The worker had already removed
its staging directory. Private observation records were preserved.

The accepted proof and this record are published in a later evidence-only
commit. Their identities continue to name the deployed revision above; these
documentation and proof changes do not require another runtime replacement.
