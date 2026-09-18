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

Run from the Router repository in PowerShell. This parses the lock once and
verifies the patch before touching upstream source:

```powershell
$routerRoot = (& git rev-parse --show-toplevel).Trim()
$configRoot = Join-Path $routerRoot "config\switchyard"
$lock = Get-Content -Raw -LiteralPath (Join-Path $configRoot "source.lock") | ConvertFrom-Json
$patchPath = Join-Path $configRoot $lock.patch
$patchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $patchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $lock.patchSha256.ToLowerInvariant()) { throw "Switchyard patch hash does not match source.lock" }
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ("switchyard-build-" + [guid]::NewGuid())
git clone $lock.repository $buildRoot
git -C $buildRoot checkout --detach $lock.commit
git -C $buildRoot apply --check $patchPath
git -C $buildRoot apply $patchPath
rustup toolchain install $lock.rustToolchain --profile minimal
Push-Location $buildRoot
rustup run $lock.rustToolchain cargo fmt --all --check
rustup run $lock.rustToolchain cargo clippy --workspace --all-targets -- -D warnings
rustup run $lock.rustToolchain cargo test -p switchyard-llm-client -p switchyard-libsy -p switchyard-runner -p switchyard-server -p switchyard-translation
rustup run $lock.rustToolchain cargo build --release -p switchyard-server
Pop-Location
$candidateBinary = Join-Path $buildRoot ($lock.binary -replace '/', '\')
$candidateHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidateBinary).Hash.ToLowerInvariant()
```

Keep `$buildRoot`, `$candidateBinary`, `$candidateHash`, and `$lock` for the
staging transaction. Delete the disposable checkout after deployment evidence
and rollback retention are resolved.

## Stage and validate

`routes.template.toml` contains
`__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__`. The replacement URL contains the
private Router caller capability. Read it from managed Codex configuration
without printing it, substitute it into a private staged `routes.toml`, and
apply the current-user ACL before validation. The service-generation
Router-to-Switchyard capability is different and must never be written to this
file.

Stage the binary, route file, and provenance under the active runtime root so
the final replacements stay on one volume. Before stopping anything, run:

```powershell
& $candidateBinary --config $stagedRoutes --dry-run
$codexBinary = node --input-type=module -e "import {findCodexBinary} from './src/codex-binary.mjs'; process.stdout.write(findCodexBinary() || '')"
if (-not $codexBinary) { throw "Current Codex binary was not found" }
node scripts/check-codex-catalog-compat.mjs $codexBinary
npm run check
node --test test/switchyard-runtime.test.mjs test/routing.test.mjs test/catalog.test.mjs
```

The catalog script checks current native-field inheritance and the specific
Switchyard/GLM catalog assertions. It does not validate the patch, route-file
privacy, local-hop authentication, loopback binding, decision redaction, or
runtime health; those need their own checks above and below.

## Deploy and roll back

A guarded restart only restarts the files already installed. It does **not**
copy a rebuilt binary or route file. Because Windows may lock the active
executable, live replacement must be one independent rollback-owning
transaction, not a sequence of ad hoc stop/copy/start commands.

The transaction must:

1. Confirm the intended `-InstallDir`, active runtime root, candidate hashes,
   staged-route dry run, and current Router health.
2. Snapshot the exact active binary, `routes.toml`, `SOURCE_COMMIT`, and any
   provenance file into one private same-volume rollback directory. Record
   which files did not previously exist.
3. Enter one `try`/rollback boundary; stop the Router service inside that
   boundary, replace the complete staged set, write the locked commit and
   binary/patch/route/Router hashes, then start the same service and wait for
   readiness.
4. On any copy, start, or readiness failure, stop the failed generation if
   needed, restore the exact prior set including prior absences, start it, and
   prove its health before returning the original failure.
5. After the candidate is healthy, verify Router health, Switchyard `/health`,
   unauthenticated 401 responses on protected Switchyard endpoints, merged
   catalog parsing, installed binary/config/provenance hashes, and—only when
   separately authorized—one quota-consuming routed smoke.
6. Retain one rollback set until all authorized acceptance checks pass, then
   delete the disposable checkout and rollback set. Never keep alternate active
   runtime trees, activation scripts, PID files, or standalone catalogs.

If no command or reviewed script owns that entire transaction, stop and add
one before deploying. Do not claim that a restart performed a deployment, and
do not weaken the no-standalone-stop rule to work around the missing owner.

The repository-owned transaction is
`maintenance/deploy-switchyard-candidate.ps1`. Pass the staged binary and
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
  -CandidateBinary $candidateBinary `
  -ExpectedBinarySha256 $candidateHash `
  -ExpectedRouterCommit $routerCommit
```

The script validates Codex configuration before stopping Router, deploys from
the active repository root, and restores through the detached checkout if
activation fails. It refuses Switchyard path or address overrides so its file
and health checks cannot certify a different runtime from the one Router
starts. Keep the generated rollback worktree and the active runtime rollback
directory until the authorized acceptance checks pass.

The transaction rejects an old candidate or rollback directory before it
prepares dependencies. Its preflight report names the candidate, running, and
rollback Router commits plus the v2 agents allowed by local subagent settings.
If it reports no expected v2 agents, repair the allowlist before certification.

If a live acceptance check finds a candidate defect before the retained rollback
is accepted, repair and commit the candidate, then pass that exact existing
runtime rollback with `-PreservedRuntimeRollbackRoot`. The transaction validates
its metadata, files, rollback checkout, ancestry, and singular ownership before
activation; a repair deployment failure restores the original pre-candidate
generation. Do not delete the retained rollback to make a second deployment pass.

## Switchyard v2 promotion

`switchyard/auto` is currently a v1 candidate. The material under
`v2_agent/switchyard/auto/` is draft historical evidence for the superseded
policy and does not certify the four-target candidate. Read
[`../../docs/SUBAGENT-CERTIFICATION.md`](../../docs/SUBAGENT-CERTIFICATION.md)
for the five checks before a future v2 promotion. Switchyard additionally
requires the new proof's runtime
binding to record the deployed upstream commit, patch SHA-256, binary SHA-256,
Router commit, and generated-routes SHA-256.

Recertify after any change to one of those identities or to the native
collaboration/tool namespace contract. Do not duplicate the general v2
procedure here.

Deployment and certification normally require two commits. Commit the clean
Router and Switchyard candidate first because deployment binds the running
generation to that commit. After the live v2 run passes, update and commit its
proof separately. The proof must name the deployed candidate commit, not the
later evidence-only commit.
