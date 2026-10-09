import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const hash = value => createHash("sha256").update(value).digest("hex");

test("Switchyard build checks ordered native commands and returns only complete candidates", { skip: process.platform !== "win32" }, t => {
  // PowerShell expands Windows 8.3 paths; compare the same directory identity
  // when the runner supplies a short-name temporary root.
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "router-build-fixture-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "maintenance"));
  mkdirSync(path.join(directory, "config/switchyard/patches"), { recursive: true });
  copyFileSync(path.join(root, "maintenance/build-switchyard-candidate.ps1"), path.join(directory, "maintenance/build-switchyard-candidate.ps1"));
  for (const name of ["contribution", "compatibility"]) writeFileSync(path.join(directory, `config/switchyard/patches/${name}.patch`), name);
  const lock = {
    repository: "https://github.com/example/synthetic.git", commit: "a".repeat(40), rustToolchain: "1.96.1", binary: "target/release/switchyard-server.exe",
    upstreamContribution: { patch: "patches/contribution.patch", patchSha256: hash("contribution") },
    patch: "patches/compatibility.patch", patchSha256: hash("compatibility"),
  };
  const wrapper = path.join(directory, "build-fixture.ps1");
  writeFileSync(wrapper, `
$ErrorActionPreference='Stop'
function Record-Command([string]$Name,[string[]]$Arguments) {
 Add-Content -LiteralPath (Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'trace.jsonl') -Value (@{command=$Name;args=$Arguments} | ConvertTo-Json -Compress)
}
function git {
 Record-Command 'git' $args
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'clone') {
  $buildPath=$args[-1]; New-Item -ItemType Directory -Path $buildPath | Out-Null
  [IO.File]::WriteAllText((Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'build-path.txt'),$buildPath)
  if ($env:SWITCHYARD_BUILD_FAILURE -eq 'clone') { $global:LASTEXITCODE=9 }
 }
}
function rustup {
 Record-Command 'rustup' $args
 $global:LASTEXITCODE=0
 if ($args -contains 'clippy' -and $env:SWITCHYARD_BUILD_FAILURE -eq 'lint') { $global:LASTEXITCODE=7 }
 if ($args -contains 'build') {
  New-Item -ItemType Directory -Path 'target/release' | Out-Null
  [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'target/release/switchyard-server.exe'),'synthetic binary')
 }
}
try {
 $candidate=& (Join-Path $PSScriptRoot 'maintenance/build-switchyard-candidate.ps1')
 Write-Output ('BUILD_RESULT=' + ($candidate | ConvertTo-Json -Compress))
} catch { Write-Output $_.Exception.Message; exit 1 }
`);
  for (const mode of ["success", "clone", "lint", "patch-hash", "binary-path"]) {
    const inputs = structuredClone(lock);
    if (mode === "patch-hash") inputs.patchSha256 = "f".repeat(64);
    if (mode === "binary-path") inputs.binary = "../foreign.exe";
    writeFileSync(path.join(directory, "config/switchyard/source.lock"), JSON.stringify(inputs));
    for (const name of ["trace.jsonl", "build-path.txt"]) rmSync(path.join(directory, name), { force: true });
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, SWITCHYARD_BUILD_FIXTURE: directory, SWITCHYARD_BUILD_FAILURE: mode },
    });
    assert.equal(result.status, mode === "success" ? 0 : 1, result.stdout + result.stderr);
    const tracePath = path.join(directory, "trace.jsonl");
    const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8").trim().split(/\r?\n/u).map(JSON.parse) : [];
    const buildPathFile = path.join(directory, "build-path.txt");
    const buildPath = existsSync(buildPathFile) ? readFileSync(buildPathFile, "utf8") : undefined;
    if (buildPath) {
      assert.equal(realpathSync.native(path.dirname(buildPath)), realpathSync.native(os.tmpdir()));
      assert.match(path.basename(buildPath), /^switchyard-build-[a-f0-9]{32}$/u);
      t.after(() => rmSync(buildPath, { recursive: true, force: true }));
    }
    if (mode === "success") {
      const candidate = JSON.parse(/^BUILD_RESULT=(.+)$/mu.exec(result.stdout)[1]);
      assert.equal(candidate.candidateHash, hash("synthetic binary"));
      assert.equal(candidate.upstreamCommit, lock.commit);
      assert.equal(candidate.buildRoot, buildPath);
      assert.ok(existsSync(candidate.candidateBinary));
      assert.deepEqual(trace.filter(row => row.command === "git").map(row => row.args.slice(2)), [
        ["--no-checkout", lock.repository, buildPath], ["checkout", "--detach", lock.commit],
        ["apply", "--check", path.join(directory, "config/switchyard/patches/contribution.patch")], ["apply", path.join(directory, "config/switchyard/patches/contribution.patch")],
        ["apply", "--check", path.join(directory, "config/switchyard/patches/compatibility.patch")], ["apply", path.join(directory, "config/switchyard/patches/compatibility.patch")],
      ]);
      const cargo = trace.filter(row => row.args[2] === "cargo").map(row => row.args.slice(3));
      assert.deepEqual(cargo.map(args => args[0]), ["fmt", "clippy", "test", "build"]);
      assert.ok(cargo.slice(1).every(args => args.includes("--locked")));
    } else {
      assert.doesNotMatch(result.stdout, /BUILD_RESULT=/u);
      if (buildPath) assert.equal(existsSync(buildPath), false, "failed checkout was removed");
      if (mode === "clone") assert.equal(trace.length, 1, "failed clone stops all later commands");
      if (mode === "lint") assert.equal(trace.some(row => row.args.includes("build") || row.args.includes("test")), false);
      if (mode === "patch-hash" || mode === "binary-path") assert.equal(trace.length, 0, "invalid inputs fail before cloning");
    }
  }
});
