import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readScript = (name) => readFileSync(path.join(root, name), "utf8");

test("the Windows operational scripts parse in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  for (const name of [
    "install.ps1",
    "deploy-codex-router.ps1",
    "restart-codex-router.ps1",
    "model-router.ps1",
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

test("the local deploy helper copies source without purging target-only files", () => {
  const source = readScript("deploy-codex-router.ps1");
  assert.match(source, /Test-NestedDirectory \$sourceDir \$installDir/);
  assert.match(source, /Test-NestedDirectory \$installDir \$sourceDir/);
  assert.match(source, /"\/E"/);
  assert.doesNotMatch(source, /"\/(?:MIR|PURGE)"/);
  assert.match(source, /\.codex-router-deploy-manifest\.json/);
  assert.match(source, /Resolve-ManagedTargetFile/);
  assert.match(source, /Remove-Item -LiteralPath \$Target -Force/);
  assert.match(source, /ReparsePoint/);
  for (const directory of [".git", ".venv", "node_modules", "target", "dist", "release"]) {
    assert.match(source, new RegExp(`"${directory.replace(".", "\\.")}"`));
  }
  assert.match(source, /\$CopyExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(source, /if \(\$CopyExitCode -gt 7\)/);
});

test("deploy runs the installed canonical transaction and doctor without replacing selection", () => {
  const source = readScript("deploy-codex-router.ps1");
  assert.match(
    source,
    /Join-Path \$installDir "install\.ps1"\) -CheckoutInstall -Target codex/,
  );
  assert.doesNotMatch(source, /-Providers\b/);
  assert.match(source, /src\\doctor\.mjs/);
  assert.match(source, /\$DoctorExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(source, /if \(\$DoctorExitCode -ne 0\)/);
  assert.doesNotMatch(source, /src\\catalog\.mjs/);
  assert.doesNotMatch(source, /src\\litellm-config\.mjs/);
  assert.doesNotMatch(source, /control\.mjs.*service.*restart/);
});

test("Windows refreshes managed Codex skills as a best-effort post-install step", () => {
  const install = readScript("install.ps1");
  const health = install.indexOf("src/wait-health.mjs");
  const skills = install.indexOf("src/skills-install.mjs install");
  assert.ok(skills > health, "skills must run after the healthy service transaction");
  assert.match(install, /\$SkillsExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(install, /Managed Codex skills could not be refreshed[\s\S]*the router is installed/);
});
