# Subagents v2 certification

Read this only when changing exact-route subagent eligibility, encrypted relay, certification records, or `multiAgentVersion`.

A route is spawnable only when its published model has `multiAgentVersion: "v2"`. Certification belongs to one exact public slug and its current provider, upstream model, request profile, endpoint policy, Router behavior, and Codex execution path.

Local subagent settings may hide or select among certified routes. They cannot
promote a v1 route or replace a checked-in application.

Source publication requires both an exact route with `multiAgentVersion: "v2"`
and its matching accepted application. See the [application index](../v2_agent/README.md)
for current exact-route acceptance. Retired Union Alpha evidence cannot certify
Pareto. Switchyard evidence additionally records its tested deployed source,
patch, binary, generated routes and Router commit. Retain that observed identity;
reuse after later deployments depends on whether the certified behavior changed,
not whether the repository has a new commit.

Generated routed-agent definitions pin each route's checked-in default effort.
Do not inherit an unsupported parent effort into a routed child: Codex rejects
that spawn before the request reaches the Router or provider.

## Required checks

An accepted proof records one run that passes:

1. streamed Responses text and completion
2. a valid tool call
3. encrypted parent-to-child relay
4. the requested child marker
5. a second marker from the same child thread

Streaming and a tool call alone do not prove native collaboration. Do not promote a partial run.

Each checked-in application contains `proof.json` and `proof.md` under
`v2_agent/<provider>/<route>/`. The JSON file is the machine-readable
authority. The Markdown file records reviewer-facing evidence and limitations.
`scripts/check-v2-agent-applications.mjs` validates both files and rejects a v2
declaration without an accepted exact-route application.

Accepted proofs require a 40-character hexadecimal `routerCommit`. Switchyard's
`runtimeBinding.routerCommit` must identify the same commit. Historical proofs
retain their tested revision; it need not equal current HEAD or the current
installation. Draft templates may leave this field blank.

Catalog publication exposes only exact eligible routes. Runtime observations
are diagnostics; they do not create or revoke certification.

## Certifying a new exact route

### Maintained CLI runner

For published roles, use one fresh run directory and name
only the affected exact routes. Run from the normal Windows user context:

```powershell
node maintenance/certification-runner.mjs run --output generated/certification-NEW --windows-sandbox mxc --allow-live openrouter/pareto
```

`--allow-live` records operator authorization for quota-consuming synthetic
requests. Choose `mxc` or `elevated` explicitly; the runner keeps workspace-write
and on-request approval, and does not edit persistent Codex settings. The runner
performs preflight itself; use the standalone command to diagnose blockers.
New v1 candidates still need the temporary proof window below.
Use `--all` only when the affected contract reaches every route. Add
`--switchyard-smoke` when the Switchyard change needs its additional tool,
image fallback and compaction checks; include `switchyard/auto` in that scope.

The runner reads shared preflight state once and records each route's blockers.
It makes one bounded SSE request per ready route, then runs one native parent
sequence for routes whose streaming passed. A route refusal does not discard
other complete observations. Authentication refusals and known Router
unavailability stop further attempts. Shared parent or runtime invalidity rejects
the run. The runner does not retry a failed route or substitute an endpoint.

`result.json` records each route's status, phase, safe failure code and observed
HTTP status where available. Running snapshots also retain successful streaming
metadata; raw provider bodies and arbitrary exception messages are excluded.
Native request timings must carry the child's hashed thread identity. Unrelated
same-route requests do not contribute to its count or invalidate its proof.
Missing attribution, missing child requests and failed child requests remain
rejected. The hashes stay in private logs and are omitted from draft/public evidence.
The runner writes complete redacted `drafts.json` and readable applications under
`review/v2_agent` only for routes that pass all five checks. Optional Switchyard
smoke failure excludes its route; changed runtime identity rejects the run.

Review artifacts merge the generated sources with previously reviewed sources
only when the prior accepted application's slug, provider, upstream model and
endpoint match. Duplicate URLs are removed. These references do not reuse old
observations or runtime bindings; confirm their applicability during review.
New or changed routes start with their generated sources. Edit `drafts.json` to
add or remove references before publication; publication preserves that choice.

The command exits zero for a complete draft. `partial` exits nonzero while
retaining drafts for the complete subset; `failed` has no publishable draft.
Inspect `result.json` before rerunning. Review only the emitted complete drafts
and their official sources, then publish with:

```powershell
node maintenance/certification-runner.mjs publish --draft generated/certification-NEW/drafts.json --evidence docs/history/YYYY-MM-DD-certification.json --reviewed
```

Publication validates the proposed applications before replacing proof files,
generates both proof formats and one redacted run record, and restores previous
files if publication fails. Add the new record to the history/application indexes.
It does not commit, deploy, change route eligibility, or run more models. The
manual path below remains available for desktop runs and diagnosis.
Publishing a complete subset does not certify the omitted routes. After fixing
an incomplete route, name only that route in a fresh authorized run. Raw journals,
manifests and session identifiers stay local.

New extraction requires timing logs from the correlated Router writer. Existing
accepted applications keep their historical meaning; old uncorrelated logs remain
diagnostic records and cannot produce a fresh draft by model/time matching alone.
Switchyard extraction selects the child's agent traces and the routing session
observed on its requests. Missing trace/routing coverage or an ambiguous session
shared with another observed thread is rejected. The standalone Switchyard evidence
command remains a whole-generation diagnostic summary.
Completed-request traces carry a session ID without an agent ID. The extractor
includes them only through that observed, unshared session; an explicit foreign
agent or thread cannot acquire attribution through the session.

### Manual desktop or v1 candidate path

Use this path for a new v1 candidate, a desktop proof, or diagnosis outside the
maintained runner. Start with one read-only readiness check for the exact route,
a subset, or all
registered routes:

```powershell
node maintenance/certification-preflight.mjs openrouter/pareto
node maintenance/certification-preflight.mjs openrouter/pareto switchyard/auto
node maintenance/certification-preflight.mjs --all
```

Choose one command for the intended scope. The batch reads shared installed
state once and checks each route's source eligibility, visibility, published
catalog, generated role contents, and deployed commit. It derives exact roles,
pinned efforts, prompts, application paths, and draft identity metadata from
the registry. Draft checks stay pending until actual observations are collected.
Access errors are not evidence of missing configuration; use the state owner's
local authority. This command does not publish a route, spend quota or accept proof.

For a v1 candidate, use the reported draft identity with the proof templates at
the reported application path. Fill runtime observations and keep status draft.
During the authorized proof window,
set the route's `multiAgentVersion` to `v2`, show it if hidden using the reported
picker command, and refresh the catalog. Run preflight again before starting a
fresh native parent. This window may temporarily fail the accepted-proof gate;
never commit that intermediate state. On failure restore v1, refresh the catalog,
and restore any visibility changed solely for the test.

Use the printed prompt in a fresh native desktop task, or a fresh native
`codex exec` parent if the current desktop task cannot discover the new role.
Keep the sandbox and approval mechanism enabled. Inspect actual tool output,
child handoffs and timings; a parent's PASS text alone is not evidence.

On Windows, create a fresh CLI working directory from the normal Windows user
context before launching the parent. A directory created by a sandboxed tool can
be owned by `CodexSandboxOnline` or `CodexSandboxOffline`; using it as a new
workspace root can prevent Codex's setup helper from configuring its write ACL.
Check `Get-Acl <working-directory>` before the run. If setup fails before a command
starts, inspect the matching timestamp in `%CODEX_HOME%/.sandbox/sandbox*.log`.
Do not treat an approved unsandboxed retry as proof of sandbox reliability. For
an empty disposable fixture, recreate it from the normal user context; preserve
nonempty workspaces and diagnose their permissions separately. Do not reset ACLs
or weaken sandbox policy as part of certification.

When the installed Windows release supports MXC, a CLI proof can select it for
that session with `--config 'windows.sandbox="mxc"'`, keeping workspace-write
and the approval mechanism enabled. Verify real command execution and workspace
write boundaries before relying on a different backend. Record the selected
backend in the proof; a scoped CLI result does not certify the desktop's
elevated backend. Do not change the user's persistent sandbox setting merely
to run certification.


Use a native Codex parent task whose current collaboration schema offers the
candidate's generated `router_<provider>_<model>` agent type. Refresh the
catalog and open a fresh parent task if the role was added after that task
started. Spawn the role through native collaboration, record the first marker,
wait for that child turn to finish, then call `followup_task` on that same child
for the second marker. Never interrupt a running child to send the follow-up.
If native instructions require `interrupt_agent` cleanup after a completed turn,
verify its result reports the child already completed, then follow up on that
same child and record this lifecycle explicitly. Completed-turn cleanup is not
evidence of an active-turn cancellation. A client cancellation appears as Router
`status=0`; discard that evidence window and start a clean sequence. Do not
substitute `codex_app.create_thread`: a separate app task is not the encrypted
child relay being certified.

The route may be published as v2 only for the authorized proof window. Keep its
application draft until all five checks pass; accept the proof and registry
claim together, then require `npm run check` to return green. If the native run
does not complete, restore the route to v1 rather than committing a red gate.

### Collecting manual evidence

Preflight emits a `runManifestTemplate` alongside each draft. Save the template
under ignored `generated/` storage and fill it from the actual run: the parent
session ID, UTC start and end in `YYYY-MM-DDTHH:mm:ss.sssZ` form, observed CLI
and Windows app versions, execution surface, and selected sandbox backend.
Use the emitted route markers and prompts. Do not fill observations from an
earlier run or infer the backend from a successful command.

After the parent and both child turns complete, extract redacted drafts:

```powershell
node maintenance/certification-evidence.mjs extract --run generated/private-run.json --parent <parent-rollout.jsonl> --children <child-rollout-directory> --router-log <router-log> --output generated/certification-drafts.json
```

The extractor checks native child identity, pinned effort, command output,
encrypted handoffs, same-child continuation, completion order, exact-provider
timings, and the installed route binding. Switchyard also requires its locked
runtime provenance and bounded routing evidence. It reads the supplied records
and creates a new output file; it does not run models, overwrite evidence, accept
proof, or change route eligibility.
This manual extraction command remains strict: any failed named route rejects
the batch. The maintained runner collects individual outcomes after checking
the full shared parent and runtime envelope.

The native CLI's empty follow-up acknowledgement is verified through the exact
target and the observed second encrypted handoff and completed child marker.
Structured acknowledgements must also match the child and report no failure.

Parent and child observations are selected from the declared window. Resuming a
child afterward does not invalidate the earlier run; incomplete or cancelled
activity inside the window still fails extraction. Streaming stays pending:
successful timings and rollout snapshots cannot prove SSE transport. Record the
separately observed streamed text and completion before accepting the proof.

The CLI version is checked against the parent transcript. The app version and
backend remain runner-declared observations; the extractor cannot prove them
from that transcript. A CLI proof does not certify the desktop's elevated
backend. Review the emitted draft and its limitations, then place the reviewed
`draftProof` and corresponding `proof.md` at the reported application path using
the acceptance procedure above.

Keep raw rollouts, ciphertext, run manifests, session identifiers, and private
paths out of tracked files. Only reviewed, redacted applications belong in
`v2_agent/`.

## When to refresh proof

Select routes by the changed contract:

| Change | Certification scope |
| --- | --- |
| One endpoint, provider binding, effort or route-specific profile | That exact route and any other callers of the changed profile |
| Shared namespace, encrypted handoff, continuation or compatibility transform | Every route using the changed behavior |
| Switchyard binary, patch, classifier, effective route policy or targets | Switchyard; other routes only if their shared behavior changed |
| Documentation, test or proof formatting | No new model run |
| Deployment, restart, commit, installation/diagnostic/verification maintenance with unchanged serving behavior | No new model run; ordinary source checks and deployment acceptance still apply |

Deployment or a new Router commit alone does not require any route proof,
including Switchyard. A proof's commits and hashes record what was actually
tested. Keep them unchanged when reusing its result; never relabel an old run
with a newer commit. Each fresh run still requires its streaming, native child,
installed manifest and Switchyard provenance to identify the same deployed
generation. Deployment's process, manifest, health and file-hash checks remain.

Before deciding to renew Switchyard, inspect changes since its accepted proof:

```powershell
node maintenance/certification-preflight.mjs --renewal switchyard/auto
```

This read-only assessment includes committed, staged, unstaged and untracked
source changes. `retain` identifies unrelated paths; `renew` identifies pinned
Switchyard implementation or policy changes; `review` asks for a diff review of
shared/unknown code or unavailable history. A shared file edit can affect only
an external route, so file names alone do not require Switchyard model calls.
Also check changes outside Git: the installed binary, effective routing policy,
and Codex execution/tool contract. An app or CLI version change alone calls for
compatibility inspection; renew when it changes the certified contract or a
regression invalidates the previous evidence. There is no time-based expiry.

Keep unaffected accepted records. One fresh native sequence supplies the tool,
handoff and both marker observations. Add Switchyard smoke only for changes to
classifier routing, affinity, media fallback or compaction behavior; skip it for
unrelated maintenance. Never use an automatic `--all` run after deployment.

Refresh the exact route after any change to:

- provider, upstream model, or endpoint binding
- request or reasoning policy
- Codex app-function or namespace relay shape
- encrypted relay or child continuation behavior
- Router compatibility transforms
- Switchyard binary, patch, route file, or selected native target behavior
- the proof epoch

Do not reuse another provider's or another slug's result. A local selection is operator intent, not repository certification.

Certification can consume provider or ChatGPT quota. Never run it without explicit authority. A deterministic mock test cannot replace the native parent, child, and same-thread observations.

After acceptance, follow the [common source verification scope](agents/architecture.md#verification).
Reuse unchanged test and catalog results; the application changes still require
`npm run check`. For a fresh Switchyard run, also record the tested locked commit,
patch hash, binary hash, generated route hash, and Router commit. Reusing an
unchanged contract does not create another proof record or evidence-only commit.

The maintained runner already extracts Switchyard's attributed child evidence.
Its optional `--switchyard-smoke` also runs the separate tool, media and compaction
checks once. Do not repeat either operation with standalone commands afterward.
For whole-generation diagnostics, use [runtime operations](../config/switchyard/runtime.md).
