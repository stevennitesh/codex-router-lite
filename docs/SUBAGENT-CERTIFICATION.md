# Subagents v2 certification

Read this only when changing exact-route subagent eligibility, encrypted relay, certification records, or `multiAgentVersion`.

A route is spawnable only when its published model has `multiAgentVersion: "v2"`. Certification belongs to one exact public slug and its current provider, upstream model, request profile, endpoint policy, Router behavior, and Codex execution path.

Local subagent settings may hide or select among certified routes. They cannot
promote a v1 route or replace a checked-in application.

The accepted active v2 routes are `openrouter/glm-5.3-flash`,
`openrouter/glm-5.3-flash-gmicloud`, `openrouter/pareto`, and `switchyard/auto`. The retired Union Alpha
application remains historical evidence and does not certify `openrouter/pareto`. Switchyard's
application is also bound to its deployed source, patch, binary, generated
routes, and Router commit.

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

Catalog publication exposes only exact eligible routes. Runtime observations
are diagnostics; they do not create or revoke certification.

## Certifying a new exact route

Start with one read-only readiness check:

```powershell
node maintenance/certification-preflight.mjs openrouter/pareto
```

Replace the slug with the exact candidate. The report checks source eligibility,
local visibility, published catalog, generated role contents and deployed commit.
It prints the exact role, pinned effort and a reusable synthetic parent prompt.
Access errors are not evidence of missing configuration; use the state owner's
local authority. This command does not publish a route, spend quota or accept proof.

For a v1 candidate, copy the proof templates into the reported application path,
fill its exact identity, and keep status draft. During the authorized proof window,
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


Use a native Codex parent task whose current collaboration schema offers the
candidate's generated `router_<provider>_<model>` agent type. Refresh the
catalog and open a fresh parent task if the role was added after that task
started. Spawn the role through native collaboration, record the first marker,
wait for that child turn to finish, then call `followup_task` on that same child
for the second marker. Do not pair the follow-up with `interrupt_agent` and do
not interrupt between markers. A client cancellation appears as Router
`status=0`; discard that evidence window and start a clean sequence. Do not
substitute `codex_app.create_thread`: a separate app task is not the encrypted
child relay being certified.

The route may be published as v2 only for the authorized proof window. Keep its
application draft until all five checks pass; accept the proof and registry
claim together, then require `npm run check` to return green. If the native run
does not complete, restore the route to v1 rather than committing a red gate.

## When to refresh proof

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

After an accepted change, run `npm run check`, `npm test`, and the installed-Codex catalog check. For Switchyard, also bind the proof to the locked commit, patch hash, binary hash, generated route hash, and Router commit.

For Switchyard evidence, run
`.\model-router.ps1 codex switchyard-certification-evidence --limit 20`. The
command understands the routing log's `ts`, `session_id`, `model`, and token
fields, but emits no raw session, agent, or correlation identifiers. Select one
bounded passing window and record its successful Router timings; earlier
canceled attempts are not evidence for that window.
