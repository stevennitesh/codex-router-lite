import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, ".."), windows = { skip: process.platform !== "win32" };
function fixture(t) {
  const parent = path.join(root, ".tmp", "codex-app-activation"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "case-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("registered desktop identity selects the manifest GUI app and binds its current package and AUMID", windows, t => {
  const directory = fixture(t), script = path.join(directory, "identity.ps1");
  writeFileSync(script, `param([string]$Scenario)
$ErrorActionPreference='Stop'
. '${path.join(root, "maintenance/codex-app-activation.ps1").replaceAll("'", "''")}'
function Get-AppxPackage { param($Name)
  $package=[pscustomobject]@{Name='OpenAI.Codex';PackageFullName='OpenAI.Codex_fixture';PackageFamilyName='OpenAI.Codex_family';PublisherId='fixture';InstallLocation='C:\\fixture'}
  if($Scenario -eq 'ambiguous-package'){return @($package,$package)}; return $package
}
function Get-AppxPackageManifest { param($Package)
  [pscustomobject]@{Package=[pscustomobject]@{Applications=[pscustomobject]@{Application=@(
    [pscustomobject]@{Id='Desktop';Executable='app/ChatGPT.exe';EntryPoint='Windows.FullTrustApplication'},
    [pscustomobject]@{Id='CommandRunner';Executable='app/resources/codex-command-runner.exe';EntryPoint='Windows.FullTrustApplication'})}}}
}
function Get-StartApps {
  $app=[pscustomobject]@{AppID='OpenAI.Codex_family!Desktop'}
  if($Scenario -eq 'ambiguous-app'){return @($app,$app)}
  if($Scenario -eq 'command-only'){return [pscustomobject]@{AppID='OpenAI.Codex_family!CommandRunner'}}
  return $app
}
function Get-FileHash { param($LiteralPath,$Algorithm) [pscustomobject]@{Hash=('a'*64)} }
try { Get-CodexMaintenanceReopenIdentity | ConvertTo-Json -Compress } catch { [Console]::Error.Write('registration-rejected'); exit 1 }
`);
  for (const scenario of ["current", "ambiguous-package", "ambiguous-app", "command-only"]) {
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, scenario], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (scenario === "current") {
      assert.equal(result.status, 0, result.stderr); const identity = JSON.parse(result.stdout);
      assert.equal(identity.aumid, "OpenAI.Codex_family!Desktop"); assert.equal(identity.executable, "app/ChatGPT.exe");
      assert.equal(identity.manifestSha256, "a".repeat(64));
    } else assert.equal(result.status, 1, scenario);
  }
});

test("worker reopens only after durable accepted success and lock release, retaining activation failure separately", windows, async t => {
  for (const scenario of ["success", "activation-failure", "registration-changed", "registration-unavailable", "session-mismatch", "deployment-failure", "acceptance-failure", "not-requested"]) await t.test(scenario, t => {
    const directory = fixture(t), operation = path.join(directory, "deployments", "a".repeat(32)); mkdirSync(operation, { recursive: true });
    const identity = { version: 1, sessionId: 1, packageFullName: "OpenAI.Codex_fixture", packageFamilyName: "OpenAI.Codex_family", publisherId: "fixture",
      applicationId: "Desktop", aumid: "OpenAI.Codex_family!Desktop", executable: "app/ChatGPT.exe", installLocation: directory, manifestSha256: "a".repeat(64) };
    const resultPath = path.join(operation, "result.json"), trace = path.join(directory, "activated"), binary = path.join(directory, "switchyard.exe");
    const commit = "a".repeat(40), binaryHash = "b".repeat(64), candidateHash = "c".repeat(64);
    const accepted = { version: 1, accepted: true, routerCommit: commit, candidateSha256: candidateHash, sourceRoot: root, candidateBinary: binary,
      scope: "installation-and-runtime-readiness", liveWebVerification: "required-after-reopen",
      switchyardBinarySha256: binaryHash, codexReopenRequired: true, deploymentAcceptancePath: path.join(operation, "router.json"), deploymentResultPath: path.join(operation, "underlying-result.json"),
      deployment: { version: 1, accepted: true, deployed: true, routerCommit: commit, switchyardBinarySha256: binaryHash, switchyardCommit: commit,
        switchyardRoutesSha256: binaryHash, rollbackRoot: directory, rollbackRouterRoot: directory, checks: Object.fromEntries(["switchyardHealth", "taskIdentity", "routerFullHealth", "cleanCandidate", "installManifest", "doctor", "protectedEndpoints", "processIdentity", "provenance", "installedHashes", "installedCatalog"].map(name => [name, true])) },
      finalAdapter: { managedDirectory: directory }, ledgers: { sha256: binaryHash, count: 0, sidecarCount: 0, uncertainSends: 0 },
      retainedPriorAdapter: { managedDirectory: directory, runtimeModule: path.join(directory, "runtime.mjs"), liveRollbackQualified: false },
      checks: Object.fromEntries(["sourceCandidate", "processAbsence", "webRuntimeRefreshed", "deploymentAccepted", "ledgerPreserved", "adapterFinal"].map(name => [name, true])) };
    if (scenario === "acceptance-failure") accepted.checks.processAbsence = false;
    writeFileSync(path.join(directory, "identity.json"), JSON.stringify(identity)); writeFileSync(path.join(directory, "accepted.json"), JSON.stringify(accepted));
    for (const name of ["deployment-worker.ps1", "deployment-json.ps1"]) copyFileSync(path.join(root, "maintenance", name), path.join(directory, name));
    writeFileSync(path.join(directory, "web-runtime-maintenance.mjs"), `import {readFileSync} from 'node:fs';import {validateWebMaintenanceAcceptance} from ${JSON.stringify(pathToFileURL(path.join(root, "maintenance/web-runtime-maintenance.mjs")).href)};const [command,commit,binary,hash,candidate,receipt]=process.argv.slice(2);validateWebMaintenanceAcceptance(JSON.parse(readFileSync(receipt,'utf8')),commit,candidate,binary,hash);`);
    const suffix = `
function Get-CodexMaintenanceReopenIdentity {
 if('${scenario}' -eq 'registration-unavailable'){throw 'PRIVATE_REGISTRATION_CANARY'}
 $value=Get-Content -LiteralPath '${path.join(directory, "identity.json").replaceAll("'", "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json
 if('${scenario}' -eq 'registration-changed'){$value.aumid='changed'}
 if('${scenario}' -eq 'session-mismatch'){$value.sessionId=0};return $value
}
function Invoke-CodexMaintenanceRegisteredActivation([string]$Aumid) {
 $completed=Get-Content -LiteralPath '${resultPath.replaceAll("'", "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json
 if($completed.state -ne 'completed' -or $completed.succeeded -ne $true -or $completed.acceptance.accepted -ne $true -or $completed.reopen.status -ne 'attempting'){throw 'Acceptance was not durable before activation.'}
 $lock=[IO.File]::Open('${path.join(directory, "deployments", "deployment.lock").replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$lock.Dispose()
 [IO.File]::WriteAllText('${trace.replaceAll("'", "''")}','activation-after-unlock')
 if('${scenario}' -eq 'activation-failure'){throw 'PRIVATE_ACTIVATION_CANARY'}
 return 4242
}
`;
    writeFileSync(path.join(directory, "codex-app-activation.ps1"), readFileSync(path.join(root, "maintenance/codex-app-activation.ps1"), "utf8") + suffix);
    const transaction = path.join(directory, "transaction.ps1");
    writeFileSync(transaction, `param([switch]$InProcess,[string]$AcceptancePath,[string]$ExpectedRouterCommit,[string]$CandidateBinary,[string]$ExpectedBinarySha256,[string]$ExpectedCandidateSha256)
if('${scenario}' -eq 'deployment-failure'){throw 'Fixture deployment failure.'}
Copy-Item -LiteralPath '${path.join(directory, "accepted.json").replaceAll("'", "''")}' -Destination $AcceptancePath
`);
    const requestPath = path.join(operation, "request.json");
    writeFileSync(requestPath, JSON.stringify({ script: transaction, environment: {}, requireAcceptance: true, acceptanceKind: "web-runtime-maintenance",
      reopenCodex: scenario === "not-requested" ? null : identity, parameters: { InProcess: true, ExpectedRouterCommit: commit, CandidateBinary: binary, ExpectedBinarySha256: binaryHash, ExpectedCandidateSha256: candidateHash } }));
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(directory, "deployment-worker.ps1"), "-RequestPath", requestPath], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    const completed = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.doesNotMatch(JSON.stringify(completed), /PRIVATE_(?:ACTIVATION|REGISTRATION)_CANARY/u);
    const deploymentFailed = ["deployment-failure", "acceptance-failure"].includes(scenario);
    assert.equal(completed.succeeded, !deploymentFailed, result.stderr);
    assert.equal(result.status, deploymentFailed ? 1 : 0, result.stderr);
    if (scenario === "success") { assert.equal(completed.reopen.status, "activated"); assert.equal(completed.reopen.processId, 4242); }
    if (scenario === "activation-failure") { assert.equal(completed.reopen.failure, "activation-failed"); assert.equal(completed.reopen.attempted, true); }
    if (scenario === "registration-changed") { assert.equal(completed.reopen.failure, "registration-changed"); assert.equal(completed.reopen.attempted, false); }
    if (scenario === "registration-unavailable") { assert.equal(completed.reopen.failure, "registration-unavailable"); assert.equal(completed.reopen.attempted, false); }
    if (scenario === "session-mismatch") { assert.equal(completed.reopen.failure, "interactive-session-mismatch"); assert.equal(completed.reopen.attempted, false); }
    if (deploymentFailed) assert.equal(completed.reopen.attempted, false);
    if (scenario === "not-requested") assert.equal(completed.reopen, undefined);
    if (["success", "activation-failure"].includes(scenario)) assert.equal(readFileSync(trace, "utf8"), "activation-after-unlock");
    else assert.equal(existsSync(trace), false, "activation must not run after rejection or without opt-in");
  });
});
