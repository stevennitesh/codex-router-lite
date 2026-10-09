import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensureProgramTreeReadable } from "../src/file-security.mjs";
import {
  buildServiceProcessState,
  serviceProcessOwns,
} from "../src/service-process.mjs";
import {
  assertServiceWriteIsolated,
  skipServiceManagerCall,
} from "../src/service-write-guard.mjs";
import {
  classifyUpdateRelation,
  currentCheckoutInstaller,
  installationNeedsRefresh,
  parseArguments,
  recognizedRepositoryUrl,
} from "../src/update.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readScript = (name) => readFileSync(path.join(root, name), "utf8");

test("checkout deployment preserves a real drain CLI failure in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-drain-error-"));
  const script = path.join(directory, "diagnose.ps1");
  writeFileSync(script, `
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DRAIN_TEST_ROOT "maintenance/deploy-switchyard-candidate.ps1"), [ref]$tokens, [ref]$errors)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Invoke-NodeJson" }, $true)
Invoke-Expression $function.Extent.Text
try {
  Invoke-NodeJson $env:DRAIN_TEST_ROOT @((Join-Path $env:DRAIN_TEST_ROOT "src/service-drain.mjs"), "prepare", "--timeout-ms", "invalid", "--json-errors") "Router admission drain"
  exit 0
} catch {
  Write-Output $_.Exception.Message
  exit 17
}
`);
  try {
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8", env: {
        ...process.env, DRAIN_TEST_ROOT: root,
        CODEX_ROUTER_STATE_DIR: directory, MODEL_ROUTER_STATE_DIR: directory,
        CODEX_ROUTER_PORT: "9", MODEL_ROUTER_PORT: "9",
      },
    });
    assert.equal(result.status, 17, result.stderr);
    assert.match(result.stdout, /Router admission drain failed.*Drain timeout must be an integer/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Windows operational scripts parse in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  const targets = [
    "install.ps1",
    "deploy-codex-router.ps1",
    "restart-codex-router.ps1",
    "model-router.ps1",
    "maintenance/deploy-switchyard-candidate.ps1",
    "maintenance/switchyard-activation.ps1",
    "maintenance/deployment-runner.ps1",
    "maintenance/deployment-worker.ps1",
    "maintenance/deployment-json.ps1",
    "maintenance/refresh-compatibility-state.ps1",
    "maintenance/build-switchyard-candidate.ps1",
  ].map((name) => `'${path.join(root, name).replaceAll("'", "''")}'`);
  const check = [
    `$targets = @(${targets.join(",")})`,
    "foreach ($target in $targets) {",
    "$tokens = $null; $errors = $null",
    "[System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$tokens, [ref]$errors) | Out-Null",
    "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    "}",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
});

test("Windows entrypoints never fall back to a developer checkout", () => {
  for (const name of [
    "install.ps1",
    "deploy-codex-router.ps1",
    "restart-codex-router.ps1",
    "model-router.ps1",
  ]) {
    const source = readScript(name);
    assert.doesNotMatch(source, /E:\\GitHub\\code\\codex-router/iu);
    assert.doesNotMatch(source, /\$RepoDir\b/u);
  }
});

test("Switchyard upstream analysis checks ordered patch layers without misreporting dependency drift", () => {
  const source = readScript("maintenance/refresh-compatibility-state.ps1");
  const contributionCheck = source.indexOf("apply --check $contributionPath");
  const contributionApply = source.indexOf('"apply", $contributionPath');
  const compatibilityCheck = source.indexOf("apply --check $compatibilityPath");
  assert.ok(contributionCheck >= 0);
  assert.ok(contributionApply > contributionCheck);
  assert.ok(compatibilityCheck > contributionApply);
  assert.match(source, /Compatibility-patch applicability was not tested because its required input layer is unavailable/u);
});

test("the Switchyard deployment owns preflight, activation, and exact rollback", () => {
  const source = readScript("maintenance/deploy-switchyard-candidate.ps1") + readScript("maintenance/switchyard-activation.ps1");
  for (const name of [
    "CODEX_ROUTER_SWITCHYARD_ROOT",
    "CODEX_ROUTER_SWITCHYARD_BIN",
    "CODEX_ROUTER_SWITCHYARD_CONFIG",
    "CODEX_ROUTER_SWITCHYARD_BASE_URL",
  ]) assert.match(source, new RegExp(name, "u"));
  assert.match(source, /config-manager\.mjs"\) validate-enable/);
  assert.match(source, /Copy-RuntimeFile \$stageRoot \$runtimeRoot "switchyard-server\.exe"/);
  assert.match(source, /Assert-CodexCatalog \$repoRoot/);
  assert.match(source, /AddSeconds\(45\)[\s\S]*Router full health did not become clean within 45 seconds/u);
  assert.match(source, /Start-Sleep -Milliseconds 500/u);
  assert.match(source, /check-codex-catalog-compat\.mjs"\) \$codexBinary --catalog \$catalogPath/);
  assert.match(source, /install-manifest\.json/);
  assert.match(source, /\$installManifest\.current\.commit/);
  assert.match(source, /provenance\.json/);
  assert.match(source, /\$installedProvenance\.routesSha256/);
  assert.match(source, /Switchyard upstream contribution patch/);
  assert.match(source, /upstreamContributionCommit/);
  assert.match(source, /upstreamContributionSha256/);
  assert.match(source, /templateSha256 = \$templateHash/);
  assert.match(source, /templateSourceSha256 = \$templateSourceHash/);
  assert.match(source, /if \(\$WhatIfPreference\)[\s\S]*worktree add --detach/);
  assert.match(source, /worktree add --detach \$rollbackRouterRoot \$expectedRollbackCommit/);
  assert.match(source, /ExpectedRoutesSha256 is required when CandidateRoutes is not the installed private route file/);
  assert.match(source, /Preserved runtime rollback must be directly under/);
  assert.match(source, /Preserved runtime rollback must be the one existing Switchyard rollback directory/);
  assert.match(source, /Preserved rollback metadata names an unsupported file/);
  assert.match(source, /Assert-CheckoutIdentity \$repoRoot \$expectedRouterCommit "Running Router candidate checkout"/);
  assert.match(source, /Resolve-RunningRouterRoot @\(\$repoRoot, \$rollbackRouterRoot\)[\s\S]*Assert-RouterHealth \$runningRouterRoot \$installedRouterCommit[\s\S]*ShouldProcess/);
  assert.match(
    source,
    /Prepare-RollbackRouter \$rollbackRouterRoot[\s\S]*Assert-CheckoutIdentity \$rollbackRouterRoot \$expectedRollbackCommit "Prepared rollback Router checkout"[\s\S]*ShouldProcess/u,
  );
  assert.match(
    source,
    /Filter "\.rollback-\*"[\s\S]*Get-SubagentPublicationPlan[\s\S]*Deployment preflight[\s\S]*Prepare-RollbackRouter \$rollbackRouterRoot/u,
  );
  assert.match(source, /expectedPublishedV2Agents/);
  assert.match(source, /Invoke-RouterInstall \$rollbackRouterRoot/);
  assert.match(source, /Assert-RouterHealth \$rollbackRouterRoot \$expectedRollbackCommit/);
  assert.match(source, /if \(-not \$activationStarted\)/);
  assert.doesNotMatch(source, /AppData\\Local\\codex-router/);
});

test("Windows install refreshes the current Codex bundled catalog", () => {
  const source = readScript("install.ps1");
  assert.match(source, /node src\/catalog\.mjs --refresh-native/);
  assert.doesNotMatch(source, /Test-NonEmptyFile/);
});

test("the managed Router watches for Codex catalog authority changes", () => {
  const start = readScript("src/start.mjs");
  const packaged = JSON.parse(readScript("maintenance/windows-package.json"));
  assert.match(start, /catalog-auto-refresh\.mjs/u);
  assert.ok(packaged.files.includes("src/catalog-auto-refresh.mjs"));
});

test("Windows live dependency updates stage the Python environment and restore it on failure", () => {
  const source = readScript("install.ps1");
  assert.match(
    source,
    /Install-PythonEnvironment \$PythonCandidate[\s\S]*src\/service\.mjs stop[\s\S]*Move-Item -LiteralPath \$PythonCandidate -Destination \$PythonVenv[\s\S]*src\/service\.mjs install/u,
  );
  assert.match(
    source,
    /if \(\$PythonSwapStarted\)[\s\S]*Move-Item -LiteralPath \$PythonBackup -Destination \$PythonVenv[\s\S]*src\/service\.mjs install/u,
  );
  assert.match(source, /Assert-TransientPythonVenvPath/u);
  assert.match(
    source,
    /Move-Item -LiteralPath \$PythonCandidate -Destination \$RelocatedPythonCandidate[\s\S]*from litellm import run_server; run_server\(\)[\s\S]*--version/u,
  );
  assert.match(
    readScript("src/start.mjs"),
    /Scripts",\s*"python\.exe"[\s\S]*"-I", "-X", "utf8"[\s\S]*from litellm import run_server; run_server\(\)[\s\S]*\.\.\.litellmArgs/u,
  );
});

test("the Windows restart helper uses the supported service transaction", () => {
  const source = readScript("restart-codex-router.ps1");
  assert.match(source, /install-manifest\.mjs"\) root/);
  assert.doesNotMatch(source, /SpecialFolder]::LocalApplicationData/);
  assert.doesNotMatch(source, /\$HOME|\.local[\\/]share/);
  assert.match(source, /\$routerRoot\s*=\s*\[IO\.Path\]::GetFullPath\(\$InstallDir\)/);
  assert.match(source, /\$ServiceArguments\s*=\s*@\("restart"\)/);
  assert.match(source, /src\\service\.mjs"\)\s*@ServiceArguments/);
  assert.match(source, /\$RestartExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(source, /if \(\$RestartExitCode -ne 0\)/);
  assert.doesNotMatch(source, /codex-router\.ps1"\) codex restart/);
  assert.doesNotMatch(source, /control\.mjs.*service.*restart/);
  assert.doesNotMatch(source, /Split-Path -Parent \$MyInvocation\.MyCommand\.Path/);
});

test("Windows install and update retain one guarded service generation", () => {
  const installer = readScript("install.ps1");
  const service = readScript("src/service-windows.mjs");
  assert.match(installer, /\[ValidateSet\("codex"\)\]/);
  assert.match(installer, /src\/install-manifest\.mjs record[\s\S]*src\/service\.mjs install/);
  assert.match(installer, /if \(\$ServiceInstalled -and -not \$ServiceWasInstalled\)/);
  assert.match(service, /-MultipleInstances IgnoreNew/);
  assert.match(service, /New-ScheduledTaskTrigger -Once[\s\S]*-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(service, /-StartWhenAvailable/);
  assert.match(service, /-Trigger @\(\$logon, \$heartbeat\)/);
  assert.match(service, /ensureProgramTreeReadable\(SOURCE_ROOT\)[\s\S]*writeLaunchers\(\)/);
  assert.match(service, /if \(command === "restart"\) endTask\(\)/);
  assert.match(service, /\/\/E:VBScript \/\/B \/\/NoLogo/);
  assert.match(service, /function previousTaskAction\(\)[\s\S]*\/\/B \/\/NoLogo/);
  assert.match(service, /CODEX_ROUTER_PREVIOUS_EXECUTE[\s\S]*CODEX_ROUTER_PREVIOUS_ARGUMENT/);

  const update = currentCheckoutInstaller("win32", "codex");
  assert.equal(update.command, "powershell.exe");
  assert.ok(update.args.includes("-CheckoutInstall"));
  assert.deepEqual(update.args.slice(-2), ["-Target", "codex"]);
  assert.equal(installationNeedsRefresh(undefined, "candidate"), true);
  assert.deepEqual(parseArguments(["rollback", "--force"]), {
    command: parseArguments(["rollback"]).command,
    force: true,
    forceServiceReplacement: false,
  });
});

test(
  "Windows service installation grants its Limited task read access to the program tree",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-checkout-"));
    try {
      mkdirSync(path.join(directory, "src"));
      const start = path.join(directory, "src", "start.mjs");
      writeFileSync(start, "// fixture\n");
      ensureProgramTreeReadable(directory);
      const script = [
        "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_START)",
        "$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')",
        "$rights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
        "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
        "$match = $rules | Where-Object { $_.IdentityReference.Value -eq $users.Value -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $rights) -eq $rights } | Select-Object -First 1",
        "[Console]::Out.Write(($null -ne $match).ToString())",
      ].join("; ");
      const result = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_START: start },
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      ).trim().toLowerCase();
      assert.equal(result, "true");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Windows stop disables heartbeat before ending the task and start reenables it", () => {
  const source = readScript("src/service-windows.mjs");
  const branch = source.slice(source.indexOf('} else if (command === "stop") {') + 7);
  const execute = new Function("command", "taskSnapshot", "assertOwnedTask", "schtasks", "endTask", "process", "taskName", branch);
  for (const command of ["stop", "start", "restart"]) {
    const calls = [];
    execute(command, () => ({ exists: true, owned: true }),
      (task) => { assert.equal(task.owned, true); calls.push("owned"); },
      (args) => calls.push(args.at(-1)), () => calls.push("end"),
      { stdout: { write() {} } }, "Codex Router");
    assert.deepEqual(calls, command === "stop" ? ["owned", "/DISABLE", "end"]
      : command === "start" ? ["owned", "/ENABLE", "Codex Router"]
        : ["owned", "end", "/ENABLE", "Codex Router"]);
  }
  assert.throws(() => execute("stop", () => ({ exists: true }),
    () => { throw new Error("foreign task"); },
    () => assert.fail("must not mutate foreign task"), () => assert.fail("must not stop foreign task"),
    { stdout: { write() {} } }, "Codex Router"), /foreign task/u);
  for (const command of ["start", "restart"]) {
    assert.throws(() => execute(command, () => ({ exists: false }), () => {},
      () => assert.fail("must not mutate a missing task"),
      () => assert.fail("must not end a missing task"),
      { stdout: { write() { assert.fail("must not report running"); } } },
      "Codex Router"), /not registered.*install/u);
  }
});

test("self-update accepts Router Lite origin and rejects the read-only upstream", () => {
  assert.equal(recognizedRepositoryUrl("https://github.com/stevennitesh/codex-router-lite.git"), true);
  assert.equal(recognizedRepositoryUrl("git@github.com:stevennitesh/codex-router-lite.git"), true);
  assert.equal(recognizedRepositoryUrl("https://github.com/duolahypercho/codex-router.git"), false);
  assert.equal(recognizedRepositoryUrl("https://example.test/custom.git", "https://example.test/custom.git"), true);
});

test("self-update distinguishes remote updates from local unpublished work", () => {
  const ancestry = new Set(["old:new", "old:local"]);
  const isAncestor = (left, right) => ancestry.has(`${left}:${right}`);
  assert.equal(classifyUpdateRelation("same", "same", isAncestor), "synchronized");
  assert.equal(classifyUpdateRelation("old", "new", isAncestor), "remote-ahead");
  assert.equal(classifyUpdateRelation("local", "old", isAncestor), "local-ahead");
  assert.equal(classifyUpdateRelation("left", "right", isAncestor), "diverged");
});

test("task identity and the test write guard fail closed", () => {
  const sourceRoot = "C:\\fixture\\router";
  const stateDir = "C:\\fixture\\state";
  const commandLine = `node "${sourceRoot}\\src\\start.mjs"`;
  const probe = () => ({ state: "alive", identity: "4242|node.exe", commandLine });
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    probe,
    sourceRoot,
    stateDir,
  });
  assert.equal(serviceProcessOwns(state, {
    platform: "win32",
    probe,
    sourceRoot,
    stateDir,
  }), true);
  assert.equal(serviceProcessOwns(state, {
    platform: "win32",
    probe: () => ({ state: "alive", identity: "4243|node.exe", commandLine }),
    sourceRoot,
    stateDir,
  }), false);
  assert.throws(
    () => assertServiceWriteIsolated("C:\\live", {
      env: { NODE_TEST_CONTEXT: "child-v8" },
      label: "Windows Scheduled Task",
    }),
    /Refusing to write the Windows Scheduled Task/,
  );
  assert.equal(skipServiceManagerCall({
    env: { NODE_TEST_CONTEXT: "child-v8" },
  }), true);
});

test("Windows status and doctor use the same diagnostic-only path", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-status-test-"));
  const log = path.join(directory, "node.log");
  const shim = path.join(directory, "node.cmd");
  writeFileSync(shim, `@echo off\r\necho %*>>${JSON.stringify(log)}\r\nexit /b 0\r\n`);
  writeFileSync(log, "");
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` };
  try {
    for (const command of ["status", "doctor"]) {
      execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(root, "model-router.ps1"), "codex", command,
      ], { env, encoding: "utf8" });
    }
    const calls = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => /src\\doctor\.mjs$/i.test(call)));
    assert.doesNotMatch(readScript("src/doctor.mjs"), /service\.mjs.*(?:install|start|restart)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function deploymentFixture({ candidateFails, modes = {}, immediateAcceptance = false, requireForce = false }) {
  // PowerShell expands Windows 8.3 paths during installation. Record that
  // same directory identity when CI supplies a short-name temporary root.
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "codex-router-deploy-test-")));
  const source = path.join(directory, "source");
  const install = path.join(directory, "install");
  const log = path.join(directory, "install.log");
  for (const rootPath of [source, install]) {
    mkdirSync(path.join(rootPath, "maintenance"), { recursive: true });
    mkdirSync(path.join(rootPath, "src"), { recursive: true });
  }
  copyFileSync(path.join(root, "deploy-codex-router.ps1"), path.join(source, "deploy-codex-router.ps1"));
  copyFileSync(
    path.join(root, "src", "deployment-classification.mjs"),
    path.join(source, "src", "deployment-classification.mjs"),
  );
  writeFileSync(
    path.join(source, "src", "service-drain.mjs"),
    `const command = process.argv[2];\nif (command === "prepare") process.stdout.write('{"status":"offline"}\\n');\nelse if (command === "resume") process.stdout.write('{"status":"resumed"}\\n');\nelse process.exitCode = 1;\n`,
  );
  const files = [
    "install.ps1",
    "marker.txt",
    "src/start.mjs",
    "src/doctor.mjs",
    "src/deployment-classification.mjs",
    "src/service-drain.mjs",
  ];
  // The shipped acceptance and Doctor execute; only their external Windows,
  // credential and service boundaries are replaced. No live state is queried.
  writeFileSync(path.join(source, "package.json"), '{"name":"codex-router-lite","type":"module"}');
  writeFileSync(path.join(install, "package.json"), '{"name":"codex-router-lite","type":"module"}');
  copyFileSync(path.join(root, "src/deployment-acceptance.mjs"), path.join(source, "src/deployment-acceptance.mjs"));
  if (immediateAcceptance) {
    copyFileSync(path.join(root, "src/deployment-acceptance.mjs"), path.join(source, "src/deployment-acceptance-impl.mjs"));
    writeFileSync(path.join(source, "src/deployment-acceptance.mjs"), `import {assertDeploymentRuntime} from './deployment-acceptance-impl.mjs';
try { console.log(JSON.stringify(await assertDeploymentRuntime(process.argv[2], {timeoutMs:0}))); }
catch(error) { console.error(error.message); process.exitCode=1; }`);
    files.push("src/deployment-acceptance-impl.mjs");
  }
  const boundary = `import {readFileSync} from 'node:fs';
export const root=${JSON.stringify(install)};
const modes=${JSON.stringify(modes)};
export const mode=()=>modes[readFileSync(${JSON.stringify(path.join(install, "marker.txt"))},'utf8').trim()]||'healthy';`;
  const stubs = {
    "fixture-deployment-state": boundary,
    "control-health": `import {mode} from './fixture-deployment-state.mjs'; export const readControlHealth=async()=>({ok:mode()!=='offline',status:mode()==='offline'?0:200,service:mode()==='wrong-service'?'foreign':'codex-router',degraded:mode()==='degraded'?['gateway']:[]});`,
    "service-process": `import {mode,root} from './fixture-deployment-state.mjs'; export const readServiceProcessState=()=>({sourceRoot:mode()==='wrong-process'?root+'-foreign':root}); export const serviceProcessOwns=()=>mode()!=='dead-process';`,
    "install-manifest": `import {mode,root} from './fixture-deployment-state.mjs'; export const readInstallManifest=()=>({version:1,current:{target:'codex',sourceRoot:mode()==='wrong-manifest'?root+'-foreign':root,commit:null}});`,
    "service": `import {mode} from './fixture-deployment-state.mjs'; if(process.argv[2]==='status')console.log(JSON.stringify({installed:mode()!=='wrong-task',loaded:mode()!=='stopped-task',state:'running'})); else throw new Error('unexpected live service mutation');`,
    "codex-binary": `import {mode} from './fixture-deployment-state.mjs'; export const codexExecutableIdentity=()=>({binary:mode()==='doctor-fail'?null:'fixture-codex',version:'fixture'}); export const codexAuthStatus=()=>({authenticated:true});`,
    "file-security": "export const privateFileIsProtected=()=>true;",
    "catalog": "export const routedCatalogConfigured=()=>true;",
    "provider-selection": "export const providerSelectionStatus=()=>({providers:[]}); export const selectedConfiguredListedModels=()=>[];",
    "routed-models": "export const MODEL_BY_SLUG=new Map(); export const PROVIDERS=new Map([['openrouter',{}]]);",
    "provider-credentials": `import {mode} from './fixture-deployment-state.mjs'; export const credentialStatus=()=>({configured:mode()!=='warnings'}); export const primaryCredentialPath=()=> 'fixture-key';`,
    "switchyard-runtime": "export const switchyardRuntimeStatus=()=>({ready:false,binary:'fixture',inaccessible:[],missing:['binary'],invalid:[]});",
    "windows-task-state": "export const windowsScheduledTaskState=async()=>({}); export const interpretWindowsTaskState=()=>({healthy:true,detail:'fixture task'});",
  };
  for (const target of [source, install]) {
    for (const [name, code] of Object.entries(stubs)) writeFileSync(path.join(target, "src", `${name}.mjs`), code);
    copyFileSync(path.join(root, "src/doctor.mjs"), path.join(target, "src/doctor.mjs"));
  }
  files.push("package.json", "src/deployment-acceptance.mjs", ...Object.keys(stubs).map((name) => `src/${name}.mjs`));
  writeFileSync(
    path.join(source, "maintenance", "windows-package.json"),
    JSON.stringify({ version: 1, files }),
  );
  writeFileSync(path.join(source, "marker.txt"), "candidate\n");
  writeFileSync(path.join(source, "src", "start.mjs"), "// candidate\n");
  writeFileSync(
    path.join(source, "install.ps1"),
    `[CmdletBinding()]\nparam([switch]$CheckoutInstall, [string]$Target, [switch]$ForceServiceReplacement)\n${requireForce ? "if (-not $ForceServiceReplacement) { throw 'explicit force missing' }" : ""}\nAdd-Content -LiteralPath $env:DEPLOY_TEST_LOG -Value candidate\n${candidateFails ? "throw 'forced candidate failure'" : "exit 0"}\n`,
  );

  writeFileSync(path.join(install, "marker.txt"), "previous\n");
  writeFileSync(path.join(install, "retired.txt"), "restore me\n");
  writeFileSync(path.join(install, "src", "start.mjs"), "// previous\n");
  writeFileSync(
    path.join(install, "install.ps1"),
    `[CmdletBinding()]\nparam([switch]$CheckoutInstall, [string]$Target, [switch]$ForceServiceReplacement)\n${requireForce ? "if (-not $ForceServiceReplacement) { throw 'explicit force missing' }" : ""}\nAdd-Content -LiteralPath $env:DEPLOY_TEST_LOG -Value previous\nexit 0\n`,
  );
  writeFileSync(
    path.join(install, ".codex-router-deploy-manifest.json"),
    JSON.stringify({ version: 1, files: [...files, "retired.txt"] }),
  );
  return { directory, source, install, log, files };
}

function alignDeploymentFixture(fixture) {
  for (const file of fixture.files) copyFileSync(path.join(fixture.source, file), path.join(fixture.install, file));
  rmSync(path.join(fixture.install, "retired.txt"));
  writeFileSync(path.join(fixture.install, ".codex-router-deploy-manifest.json"), JSON.stringify({ version: 1, files: fixture.files }));
}

test("identical deployment preserves installed files and manifest without activation", { skip: process.platform !== "win32" }, () => {
  const fixture = deploymentFixture({ candidateFails: true });
  try {
    alignDeploymentFixture(fixture);
    const marker = path.join(fixture.install, "marker.txt");
    const originalTime = new Date("2020-01-01T00:00:00Z");
    utimesSync(marker, originalTime, originalTime);
    const manifest = path.join(fixture.install, ".codex-router-deploy-manifest.json");
    const manifestBytes = readFileSync(manifest);
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(fixture.source, "deploy-codex-router.ps1"), "-InstallDir", fixture.install], { encoding: "utf8", env: { ...process.env, DEPLOY_TEST_LOG: fixture.log } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing changed/u);
    assert.equal(statSync(marker).mtimeMs, originalTime.getTime());
    assert.deepEqual(readFileSync(manifest), manifestBytes);
    assert.throws(() => readFileSync(fixture.log), { code: "ENOENT" });
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("no-op detection rejects unsafe stored paths before changing installed files", { skip: process.platform !== "win32" }, () => {
  const fixture = deploymentFixture({ candidateFails: true });
  try {
    alignDeploymentFixture(fixture);
    const manifest = path.join(fixture.install, ".codex-router-deploy-manifest.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, files: [...fixture.files, "../outside.txt"] }));
    const prior = readFileSync(manifest);
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(fixture.source, "deploy-codex-router.ps1"), "-InstallDir", fixture.install], { encoding: "utf8", env: { ...process.env, DEPLOY_TEST_LOG: fixture.log } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe relative path/u);
    assert.deepEqual(readFileSync(manifest), prior);
    assert.equal(readFileSync(path.join(fixture.install, "marker.txt"), "utf8"), "candidate\n");
    assert.throws(() => readFileSync(fixture.log), { code: "ENOENT" });
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("documentation-only deployment publishes files without runtime acceptance or installation", { skip: process.platform !== "win32" }, () => {
  const f = deploymentFixture({ candidateFails: true, modes: { candidate: "offline" } });
  try {
    alignDeploymentFixture(f);
    writeFileSync(path.join(f.source, "LICENSE"), "new documentation");
    writeFileSync(path.join(f.install, "LICENSE"), "previous documentation");
    const files = [...f.files, "LICENSE"];
    writeFileSync(path.join(f.source, "maintenance/windows-package.json"), JSON.stringify({ version: 1, files }));
    writeFileSync(path.join(f.install, ".codex-router-deploy-manifest.json"), JSON.stringify({ version: 1, files }));
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(f.source, "deploy-codex-router.ps1"), "-InstallDir", f.install], {
      windowsHide: true, encoding: "utf8", timeout: 30_000, env: { ...process.env, DEPLOY_TEST_LOG: f.log },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /published \(documentation-only\)/u);
    assert.equal(readFileSync(path.join(f.install, "LICENSE"), "utf8"), "new documentation");
    assert.throws(() => readFileSync(f.log), { code: "ENOENT" });
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("retired package membership remains a change even when source and installed bytes match", { skip: process.platform !== "win32" }, () => {
  const fixture = deploymentFixture({ candidateFails: false });
  try {
    alignDeploymentFixture(fixture);
    for (const directory of [fixture.source, fixture.install]) writeFileSync(path.join(directory, "retired.txt"), "same retired bytes");
    writeFileSync(path.join(fixture.install, ".codex-router-deploy-manifest.json"), JSON.stringify({ version: 1, files: [...fixture.files, "retired.txt"] }));
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(fixture.source, "deploy-codex-router.ps1"), "-InstallDir", fixture.install], { encoding: "utf8", env: { ...process.env, DEPLOY_TEST_LOG: fixture.log } });
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => readFileSync(path.join(fixture.install, "retired.txt")), { code: "ENOENT" });
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("a staged Windows deployment prunes only the previous managed generation", { skip: process.platform !== "win32" }, () => {
  const fixture = deploymentFixture({ candidateFails: false });
  try {
    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(fixture.source, "deploy-codex-router.ps1"),
      "-InstallDir", fixture.install,
    ], {
      encoding: "utf8",
      env: { ...process.env, DEPLOY_TEST_LOG: fixture.log },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(fixture.install, "marker.txt"), "utf8"), "candidate\n");
    assert.throws(() => readFileSync(path.join(fixture.install, "retired.txt")), { code: "ENOENT" });
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(fixture.install, ".codex-router-deploy-manifest.json"), "utf8").replace(/^\uFEFF/u, "")).files.sort(),
      fixture.files.slice().sort(),
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a forced deployment failure restores and verifies the previous generation", { skip: process.platform !== "win32" }, () => {
  const fixture = deploymentFixture({ candidateFails: true });
  try {
    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(fixture.source, "deploy-codex-router.ps1"),
      "-InstallDir", fixture.install,
    ], {
      encoding: "utf8",
      env: { ...process.env, DEPLOY_TEST_LOG: fixture.log },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /previous healthy generation was restored/);
    assert.equal(readFileSync(path.join(fixture.install, "marker.txt"), "utf8"), "previous\n");
    assert.equal(readFileSync(path.join(fixture.install, "retired.txt"), "utf8"), "restore me\n");
    assert.deepEqual(readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), ["candidate", "previous"]);
    assert.ok(
      JSON.parse(readFileSync(path.join(fixture.install, ".codex-router-deploy-manifest.json"), "utf8")).files.includes("retired.txt"),
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("packaged deployment rejects incomplete acceptance and retains failed recovery", { skip: process.platform !== "win32" }, () => {
  for (const mode of ["warnings", "offline", "degraded", "wrong-service", "wrong-task", "stopped-task", "wrong-process", "dead-process", "wrong-manifest", "doctor-fail", "rollback-offline"]) {
    const f = deploymentFixture({
      candidateFails: mode === "rollback-offline",
      modes: mode === "rollback-offline" ? { previous: "offline" } : { candidate: mode },
      immediateAcceptance: true,
    });
    let retainedBackup;
    try {
      const wrapper = path.join(f.directory, "run-deploy.ps1");
      const quote = (text) => `'${text.replaceAll("'", "''")}'`;
      writeFileSync(wrapper, `try { & ${quote(path.join(f.source, "deploy-codex-router.ps1"))} -InstallDir ${quote(f.install)} }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`);
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], {
        windowsHide: true, encoding: "utf8", timeout: 30_000, env: { ...process.env, DEPLOY_TEST_LOG: f.log },
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, mode === "warnings" ? 0 : 1, result.stderr);
      const marker = readFileSync(path.join(f.install, "marker.txt"), "utf8").trim();
      assert.equal(marker, mode === "warnings" ? "candidate" : "previous");
      if (mode === "warnings") {
        assert.match(result.stdout, /\[warn\] OpenRouter GLM credential/u);
        assert.match(result.stdout, /published \(runtime\)/u);
      } else {
        assert.doesNotMatch(result.stdout, /published \(runtime\)/u);
        assert.equal(readFileSync(path.join(f.install, "retired.txt"), "utf8"), "restore me\n");
        assert.deepEqual(readFileSync(f.log, "utf8").trim().split(/\r?\n/u), ["candidate", "previous"]);
        if (mode === "rollback-offline") {
          assert.match(result.stderr, /rollback failed/u);
          assert.doesNotMatch(result.stderr, /previous healthy generation was restored/u);
          retainedBackup = /The backup remains at (.+)\./u.exec(result.stderr)?.[1];
          assert.ok(retainedBackup, result.stderr);
          // Check the actual recovery snapshot before removing only this fixture's set.
          assert.equal(readFileSync(path.join(retainedBackup, "marker.txt"), "utf8"), "previous\n");
        } else {
          assert.match(result.stderr, /previous healthy generation was restored/u);
        }
      }
    } finally {
      if (retainedBackup) {
        const target = path.resolve(path.dirname(retainedBackup));
        assert.ok(target.startsWith(realpathSync.native(os.tmpdir()) + path.sep));
        assert.match(path.basename(target), /^codex-router-deploy-[0-9a-f]{32}$/u);
        rmSync(target, { recursive: true, force: true });
      }
      rmSync(f.directory, { recursive: true, force: true });
    }
  }
});

test("packaged handoff preserves explicit force for installation and recovery", { skip: process.platform !== "win32" }, () => {
  const f = deploymentFixture({ candidateFails: true, requireForce: true });
  try {
    writeFileSync(path.join(f.source, "src/service-drain.mjs"), "if(process.argv[2]==='prepare'&&!process.argv.includes('--force-service-replacement'))process.exitCode=7;");
    const command = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(f.source, "deploy-codex-router.ps1"), "-InstallDir", f.install];
    const options = { windowsHide: true, encoding: "utf8", timeout: 30_000, env: { ...process.env, DEPLOY_TEST_LOG: f.log } };
    const denied = spawnSync("powershell.exe", command, options);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /replacement was deferred/u);
    assert.equal(readFileSync(path.join(f.install, "marker.txt"), "utf8"), "previous\n");
    const forced = spawnSync("powershell.exe", [...command, "-ForceServiceReplacement"], options);
    assert.notEqual(forced.status, 0);
    assert.match(forced.stderr, /previous healthy generation was restored/u);
    assert.deepEqual(readFileSync(f.log, "utf8").trim().split(/\r?\n/u), ["candidate", "previous"]);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
