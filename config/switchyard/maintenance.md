# Switchyard build and deployment

Read the [integration boundaries](README.md) before changing source or runtime.
For an upstream update, follow **Update the pin and patch**, then **Build from
source.lock**. For an already-built candidate or a Router-only update retaining
the installed Switchyard binary, start at **Stage and validate**, then **Deploy
and roll back**. Load **Switchyard v2 promotion** when refreshing acceptance.
All commands below run from the Router repository root. For service failure,
read [troubleshooting](../../docs/TROUBLESHOOTING.md) before runtime changes.

## Update the pin and patch

An upstream release or branch update is research input, not an automatic
upgrade. Fetch the upstream repository in a disposable checkout, inspect the
full diff from the locked commit, choose an exact new commit, rebase the
canonical patch deliberately, and update every field in `source.lock`. Review
security, Responses events, tool calls, classifier behavior, configuration
schema, and build dependencies before accepting the new pin.

Do not edit the lock merely because upstream `main` moved or a release tag was
published. The reviewed commit plus canonical patch is the candidate.

## Build from source.lock

Run the maintained build owner from the Router repository:

```powershell
$candidate = .\maintenance\build-switchyard-candidate.ps1
```

It validates the ordered patch hashes before cloning the pinned source, installs
the pinned toolchain and required components, and runs formatting, Clippy, the
retained package tests and release build. Dependency resolution stays locked.
Every native command must succeed before a candidate is returned. Failure removes
only that invocation's disposable checkout. Success returns `buildRoot`,
`candidateBinary`, `candidateHash` and `upstreamCommit`; keep the build directory
until deployment and rollback retention are resolved. The script does not stage
private configuration, spend model quota or change the running service.

## Stage and validate

`routes.template.toml` contains
`__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__`. The replacement URL contains the
private Router caller capability. Read it from managed Codex configuration
without printing it, substitute it into a private staged `routes.toml`, and
apply the current-user ACL before validation. The service-generation
Router-to-Switchyard capability is different and must never be written to this
file.

The deployment owner validates the candidate hashes and route dry run before
stopping Router, then stages and protects the complete set on the runtime volume.
Do not repeat its staging procedure by hand. For Router source edits, select
checks using the [common verification scope](../../docs/agents/architecture.md#verification)
and reuse unchanged results. Source catalog checks and deployment's installed
catalog check cover different inputs.

When a classifier criterion or fallback policy changes, run the maintained
synthetic evaluator only with explicit provider-spend authorization and an
already frozen corpus:

```powershell
node scripts/evaluate-switchyard-routing.mjs $candidate.candidateBinary docs/switchyard-routing-corpus.json $evidencePath
```

The evaluator exercises the candidate's `/v1/decision` path, records provider
build and runtime-policy parity, and stops before holdout when development gates
fail. Its authored corpus is regression evidence, not a representative dataset.
After authorized deployment, select proof and additional smoke scope using
[certification](../../docs/SUBAGENT-CERTIFICATION.md#when-to-refresh-proof).
Use the maintained runner's `--switchyard-smoke` when those checks are needed.
It invokes `scripts/verify-switchyard-live.mjs` once and retains the result;
standalone invocation is for a separately scoped smoke or diagnosis.
Each tool, media and compaction phase supplies its own UUID session/thread
identity and bounded observation window. The two tool requests share one identity.
Foreign traffic cannot satisfy affinity, fallback or classifier-bypass checks;
missing or contradictory own evidence fails the smoke.

## Deploy and roll back

A guarded restart only restarts the files already installed. It does **not**
copy a rebuilt binary or route file. Because Windows may lock the active
executable, live replacement must be one independent rollback-owning
transaction, not a sequence of ad hoc stop/copy/start commands.

The repository-owned transaction is
`maintenance/deploy-switchyard-candidate.ps1`. It owns staging, private snapshots,
[drain](../../docs/INSTALL.md#replacement-and-drain), activation, acceptance and
exact rollback, including previously absent files. Failure returns only after
recovery is checked or reports the retained recovery paths. Pass the candidate binary and
binary hash plus the clean candidate commit. Unless the candidate uses a new
route file, omit the route and rollback arguments. The script then uses the
installed private `routes.toml`, reads its expected hash from installed
Switchyard provenance, reads the rollback commit from the installed Router
manifest, and creates or reuses a detached rollback worktree under
`generated/`. It rejects explicit route or rollback identities that disagree
with those installed authorities.

```powershell
$routerCommit = (& git rev-parse HEAD).Trim()
& .\maintenance\deploy-switchyard-candidate.ps1 `
  -CandidateBinary $candidate.candidateBinary `
  -ExpectedBinarySha256 $candidate.candidateHash `
  -ExpectedRouterCommit $routerCommit
```

This example uses the fresh build result. For a Router-only update, pass the
unchanged installed binary and its verified hash; do not rebuild Switchyard. A changed private route file
also needs `-CandidateRoutes` and `-ExpectedRoutesSha256`.

This command launches a hidden Windows worker outside the caller's process
tree and returns its process ID, `resultPath`, and `logPath`. Read `resultPath`
until `state` is `completed`; `succeeded: true` and its `acceptance.accepted: true`
confirm deployment. Acceptance records the exact candidate, hashes, rollback
paths and checks already enforced by the worker. Reuse that result for deployment
reporting instead of rerunning Doctor, status, catalog and hash checks. A later
process-ownership and full-health check remains necessary before releasing a
rollback retained through quota-consuming certification. Closing
Codex or terminating the calling tool does not terminate the worker or its
rollback. The worker owns an exclusive deployment lock and writes private logs.
`-InProcess` is the worker's internal entrypoint; use the independent default
for live maintenance.

Automatic approval review uses Router for inference. During drain, Router rejects
new inference with HTTP 503 and `ERR_ROUTER_DRAINING`; service replacement also
has an availability gap. Include any needed bounded read-only completion wait in
the authorized launch command when possible, so polling does not need a fresh
review during replacement. If review is unavailable, the requested action has
not run. Let the independent worker continue and request the read after serving
resumes. The worker's completed acceptance remains the deployment authority;
public health alone does not establish admission state or candidate identity.

The script validates Codex configuration before stopping Router, deploys from
the active repository root, and restores through the detached checkout if
activation fails. It refuses Switchyard path or address overrides so its file
and health checks cannot certify a different runtime from the one Router
starts. Keep the generated rollback worktree and the active runtime rollback
directory until the authorized acceptance checks pass.

The transaction rejects abandoned candidate staging before it prepares dependencies.
For an existing recovery directory, it finds the unique completed, successful
deployment result that accepted the installed Router commit and that exact backup.
Its recorded checks, live provenance and installed binary/route hashes must agree.
After the ordinary full-health and process-ownership preflight passes, the worker
moves that backup beside its original result as `retained-runtime-recovery` and
creates a fresh backup for the next update. The original result and detached
rollback checkout remain intact; the preflight and private log name the archive.
Missing, incomplete, mismatched or ambiguous acceptance stops deployment before
the service changes. `-WhatIf` never moves recovery files, and an explicitly
preserved rollback stays in place for repair or interrupted-deployment recovery.

Its preflight report names the candidate, running, and
rollback Router commits plus the v2 agents allowed by local subagent settings.
If it reports no expected v2 agents, repair the allowlist before certification.

If a live acceptance check finds a candidate defect before the retained rollback
is accepted, repair and commit the candidate, then pass that exact existing
runtime rollback with `-PreservedRuntimeRollbackRoot`. The transaction validates
its metadata, files, rollback checkout, ancestry, and singular ownership before
activation; a repair deployment failure restores the original pre-candidate
generation. Do not delete the retained rollback to make a second deployment pass.

The worker pauses new requests and waits up to 90 seconds for running requests
to finish. An unfinished Switchyard tool workflow also postpones the update.
If Router cannot become idle, it stays running and accepts new requests again.
The worker reports why it could not restart, with the running request and
unfinished workflow counts; it exits before changing the running service.
After activation begins, recovery stops the
verified live checkout
and refuses to overwrite runtime files if that stop fails. The retained backup
is preserved on incomplete recovery, and the result reports both failures.
Installation also refuses to transfer ownership away from a live process in
another checkout; HTTP health alone cannot prove installation succeeded.

If an interrupted older deployment or manual install left the manifest naming
the candidate while the rollback checkout still serves requests, add
`-RecoverInterruptedDeployment` together with `-PreservedRuntimeRollbackRoot`.
Recovery requires a live, identity-verified rollback process, its exact clean
checkout, runtime files equal to the retained snapshot, and a candidate-owned
manifest whose commit is in candidate history. It tolerates the missing scheduled
launcher only during that recovery preflight. Final acceptance still requires
the live process, scheduled task, manifest, and runtime provenance to agree.

With explicit approval, `-ForceServiceReplacement` restarts Router without
waiting for running requests to finish. Those requests are interrupted, and
pending Switchyard workflow tracking is cleared. The recovery copy can restore
the previous software but cannot resume an interrupted request. Describe this
effect directly when asking for approval. The transaction forwards
that choice to the authenticated drain, service stop and installer calls during
activation and recovery, retaining the same identity, acceptance and rollback
checks. Normal deployment never interrupts work automatically. An abort
before activation lets Router accept new requests again, even when running
requests were already interrupted.

## Switchyard v2 promotion

`switchyard/auto` is v2 only while its accepted application under
`v2_agent/switchyard/auto/` matches the exact deployed four-target policy. Read
[`../../docs/SUBAGENT-CERTIFICATION.md`](../../docs/SUBAGENT-CERTIFICATION.md)
for the five checks before any future proof refresh. Switchyard additionally
requires the proof's runtime
binding to record the deployed upstream commit, ordered patch SHA-256 values,
binary SHA-256, Router commit, generated-routes SHA-256, deployed-template byte
SHA-256 (`templateSha256`), and line-ending-independent canonical template-source
SHA-256 (`templateSourceSha256`).

Those identities describe the tested generation. A new Router commit, deployment
or restart does not require recertification when Switchyard's certified behavior
is unchanged. Use the [proof refresh rules](../../docs/SUBAGENT-CERTIFICATION.md#when-to-refresh-proof)
and read-only renewal assessment there. Renew for Switchyard implementation,
effective routing policy or native collaboration/tool contract changes; inspect
shared changes before selecting the affected route. Keep historical proof commits
and hashes unchanged and retain normal deployment identity/health/hash acceptance.

When fresh certification is necessary, deployment and evidence publication use
two commits. Commit the clean
Router and Switchyard candidate first because deployment binds the running
generation to that commit. After the live v2 run passes, update and commit its
proof separately. The proof must name the deployed candidate commit, not the
later evidence-only commit. An unrelated deployment reuses the accepted proof
and requires no extra certification run or evidence commit.
