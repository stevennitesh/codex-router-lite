import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

test("the Windows operational scripts parse in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  const targets = [
    "install.ps1",
    "deploy-codex-router.ps1",
    "restart-codex-router.ps1",
    "model-router.ps1",
    "maintenance/deploy-switchyard-candidate.ps1",
    "maintenance/refresh-compatibility-state.ps1",
    "src/windows-process-tree.ps1",
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

test("the Switchyard deployment owns preflight, activation, and exact rollback", () => {
  const source = readScript("maintenance/deploy-switchyard-candidate.ps1");
  for (const name of [
    "CODEX_ROUTER_SWITCHYARD_ROOT",
    "CODEX_ROUTER_SWITCHYARD_BIN",
    "CODEX_ROUTER_SWITCHYARD_CONFIG",
    "CODEX_ROUTER_SWITCHYARD_BASE_URL",
  ]) assert.match(source, new RegExp(name, "u"));
  assert.match(source, /config-manager\.mjs"\) validate-enable/);
  assert.match(source, /config-manager\.mjs"\) enable[\s\S]*\$activationStarted = \$true[\s\S]*Invoke-RouterService \$runningRouterRoot "stop"/);
  assert.match(source, /Copy-RuntimeFile \$stageRoot \$runtimeRoot "switchyard-server\.exe"/);
  assert.match(source, /Assert-CodexCatalog \$repoRoot/);
  assert.match(source, /check-codex-catalog-compat\.mjs"\) \$codexBinary --catalog \$catalogPath/);
  assert.match(source, /Assert-CheckoutIdentity \$repoRoot \$expectedRouterCommit "Running Router candidate checkout"/);
  assert.match(source, /Resolve-RunningRouterRoot @\(\$repoRoot, \$rollbackRouterRoot\)[\s\S]*Assert-RouterHealth \$runningRouterRoot \$expectedRollbackCommit[\s\S]*ShouldProcess/);
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
    /Install-PinnedPythonRequirements \$CandidatePython \$true[\s\S]*src\/service\.mjs stop[\s\S]*Move-Item -LiteralPath \$PythonCandidate -Destination \$PythonVenv[\s\S]*src\/service\.mjs install/u,
  );
  assert.match(
    source,
    /if \(\$PythonSwapStarted\)[\s\S]*Move-Item -LiteralPath \$PythonBackup -Destination \$PythonVenv[\s\S]*src\/service\.mjs install[\s\S]*src\/wait-health\.mjs/u,
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
  assert.match(source, /SpecialFolder]::LocalApplicationData/);
  assert.doesNotMatch(source, /\$HOME|\.local[\\/]share/);
  assert.match(source, /\$routerRoot\s*=\s*\[IO\.Path\]::GetFullPath\(\$InstallDir\)/);
  assert.match(source, /src\\service\.mjs"\) restart/);
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
  assert.match(installer, /src\/install-manifest\.mjs record[\s\S]*src\/service\.mjs install[\s\S]*src\/wait-health\.mjs/);
  assert.match(installer, /if \(\$ServiceInstalled -and -not \$ServiceWasInstalled\)/);
  assert.match(service, /-MultipleInstances IgnoreNew/);
  assert.match(service, /New-ScheduledTaskTrigger -Once[\s\S]*-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(service, /-StartWhenAvailable/);
  assert.match(service, /-Trigger @\(\$logon, \$heartbeat\)/);
  assert.match(service, /ensureProgramTreeReadable\(SOURCE_ROOT\)[\s\S]*writeLaunchers\(\)/);
  assert.match(service, /if \(command === "restart"\) endTask\(\)/);

  const update = currentCheckoutInstaller("win32", "codex");
  assert.equal(update.command, "powershell.exe");
  assert.ok(update.args.includes("-CheckoutInstall"));
  assert.deepEqual(update.args.slice(-2), ["-Target", "codex"]);
  assert.equal(installationNeedsRefresh(undefined, "candidate"), true);
  assert.deepEqual(parseArguments(["rollback", "--force"]), {
    command: parseArguments(["rollback"]).command,
    force: true,
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
  const commandLine = () => `node "${sourceRoot}\\src\\start.mjs"`;
  const identity = () => "4242|node.exe";
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine,
    sourceRoot,
    stateDir,
  });
  assert.equal(serviceProcessOwns(state, {
    platform: "win32",
    identity,
    commandLine,
    sourceRoot,
    stateDir,
  }), true);
  assert.equal(serviceProcessOwns(state, {
    platform: "win32",
    identity: () => "new-generation|node.exe",
    commandLine,
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

function deploymentFixture({ candidateFails }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-deploy-test-"));
  const source = path.join(directory, "source");
  const install = path.join(directory, "install");
  const log = path.join(directory, "install.log");
  for (const rootPath of [source, install]) {
    mkdirSync(path.join(rootPath, "maintenance"), { recursive: true });
    mkdirSync(path.join(rootPath, "src"), { recursive: true });
  }
  copyFileSync(path.join(root, "deploy-codex-router.ps1"), path.join(source, "deploy-codex-router.ps1"));
  const files = ["install.ps1", "marker.txt", "src/start.mjs", "src/doctor.mjs"];
  writeFileSync(
    path.join(source, "maintenance", "windows-package.json"),
    JSON.stringify({ version: 1, files }),
  );
  writeFileSync(path.join(source, "marker.txt"), "candidate\n");
  writeFileSync(path.join(source, "src", "start.mjs"), "// candidate\n");
  writeFileSync(path.join(source, "src", "doctor.mjs"), "process.exit(0);\n");
  writeFileSync(
    path.join(source, "install.ps1"),
    `[CmdletBinding()]\nparam([switch]$CheckoutInstall, [string]$Target)\nAdd-Content -LiteralPath $env:DEPLOY_TEST_LOG -Value candidate\n${candidateFails ? "throw 'forced candidate failure'" : "exit 0"}\n`,
  );

  writeFileSync(path.join(install, "marker.txt"), "previous\n");
  writeFileSync(path.join(install, "retired.txt"), "restore me\n");
  writeFileSync(path.join(install, "src", "start.mjs"), "// previous\n");
  writeFileSync(path.join(install, "src", "doctor.mjs"), "process.exit(0);\n");
  writeFileSync(
    path.join(install, "install.ps1"),
    "[CmdletBinding()]\nparam([switch]$CheckoutInstall, [string]$Target)\nAdd-Content -LiteralPath $env:DEPLOY_TEST_LOG -Value previous\nexit 0\n",
  );
  writeFileSync(
    path.join(install, ".codex-router-deploy-manifest.json"),
    JSON.stringify({ version: 1, files: [...files, "retired.txt"] }),
  );
  return { directory, source, install, log, files };
}

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
      JSON.parse(readFileSync(path.join(fixture.install, ".codex-router-deploy-manifest.json"), "utf8").replace(/^\uFEFF/u, "")).files,
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
