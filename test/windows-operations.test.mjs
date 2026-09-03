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

import {
  buildServiceProcessState,
  serviceProcessOwns,
} from "../src/service-process.mjs";
import {
  assertServiceWriteIsolated,
  skipServiceManagerCall,
} from "../src/service-write-guard.mjs";
import {
  currentCheckoutInstaller,
  installationNeedsRefresh,
  parseArguments,
} from "../src/update.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readScript = (name) => readFileSync(path.join(root, name), "utf8");

test("the Windows operational scripts parse in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  for (const name of [
    "install.ps1",
    "deploy-codex-router.ps1",
    "restart-codex-router.ps1",
    "model-router.ps1",
    "maintenance/deploy-switchyard-candidate.ps1",
    "src/windows-process-tree.ps1",
  ]) {
    const target = path.join(root, name).replaceAll("'", "''");
    const check = [
      "$tokens = $null; $errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${target}', [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
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
  assert.match(source, /config-manager\.mjs"\) enable[\s\S]*\$activationStarted = \$true[\s\S]*Invoke-RouterService \$repoRoot "stop"/);
  assert.match(source, /Copy-RuntimeFile \$stageRoot \$runtimeRoot "switchyard-server\.exe"/);
  assert.match(source, /Assert-CodexCatalog \$repoRoot/);
  assert.match(source, /check-codex-catalog-compat\.mjs"\) \$codexBinary --catalog \$catalogPath/);
  assert.match(source, /Assert-CheckoutIdentity \$repoRoot \$expectedRouterCommit "Running Router candidate checkout"/);
  assert.match(source, /Invoke-RouterInstall \$rollbackRouterRoot/);
  assert.match(source, /Assert-RouterHealth \$rollbackRouterRoot \$expectedRollbackCommit/);
  assert.match(source, /if \(-not \$activationStarted\)/);
  assert.doesNotMatch(source, /AppData\\Local\\codex-router/);
});

test("the Windows restart helper uses the supported service transaction", () => {
  const source = readScript("restart-codex-router.ps1");
  assert.match(source, /\$env:LOCALAPPDATA/);
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
