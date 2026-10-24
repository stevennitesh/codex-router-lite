import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const hash = value => createHash("sha256").update(value).digest("hex");

test("Switchyard build checks ordered native commands and returns only complete candidates", { skip: process.platform !== "win32" }, t => {
  // PowerShell expands Windows 8.3 paths; compare the same directory identity
  // when the runner supplies a short-name temporary root.
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "router-build-fixture-")));
  assert.equal(realpathSync.native(path.dirname(directory)), realpathSync.native(os.tmpdir()));
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
  const source = path.join(directory, "public-source");
  const longRelative = [...Array(16)].map((_, index) => `nested-source-${index}`).join("/") + "/fixture.md";
  mkdirSync(path.dirname(path.join(source, longRelative)), { recursive: true });
  writeFileSync(path.join(source, longRelative), "long source fixture\n");
  const sourceGit = args => {
    const result = spawnSync("git", ["-c", "core.longpaths=true", "-C", source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  sourceGit(["init"]);
  sourceGit(["add", "."]);
  sourceGit(["-c", "user.name=Build fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  const sourceCommit = sourceGit(["rev-parse", "HEAD"]);
  const wrapper = path.join(directory, "build-fixture.ps1");
  writeFileSync(wrapper, `
$ErrorActionPreference='Stop'
function Record-Command([string]$Name,[string[]]$Arguments) {
 $record=@{command=$Name;args=$Arguments}
 if ($Name -eq 'git' -and $Arguments -contains 'apply') {
  $record.patchBytes=[IO.File]::ReadAllText($Arguments[-1])
 }
 Add-Content -LiteralPath (Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'trace.jsonl') -Value ($record | ConvertTo-Json -Compress)
}
function git {
 Record-Command 'git' $args
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'clone') {
  $buildPath=$args[-1]
  if ($env:SWITCHYARD_BUILD_FAILURE -eq 'long-path') {
   $nativeArgs=@($args); $nativeArgs[-2]=Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'public-source'
   & git.exe @nativeArgs
  } else { New-Item -ItemType Directory -Path $buildPath | Out-Null }
  [IO.File]::WriteAllText((Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'build-path.txt'),$buildPath)
  if ($env:SWITCHYARD_BUILD_FAILURE -eq 'clone') { $global:LASTEXITCODE=9 }
  if ($env:SWITCHYARD_BUILD_FAILURE -eq 'change-and-restore') {
   [IO.File]::WriteAllText((Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'config/switchyard/patches/compatibility.patch'),'changed')
  }
 }
 if ($env:SWITCHYARD_BUILD_FAILURE -eq 'long-path' -and ($args -contains 'checkout' -or $args -contains 'status')) { & git.exe @args }
 if ($args -contains 'status' -and $env:SWITCHYARD_BUILD_FAILURE -eq 'dirty-checkout') { Write-Output ' D missing-source.md' }
 if ($args -contains 'status' -and $env:SWITCHYARD_BUILD_FAILURE -eq 'status') { $global:LASTEXITCODE=8 }
 if ($args -contains 'checkout' -and $env:SWITCHYARD_BUILD_FAILURE -eq 'change-and-restore') {
  [IO.File]::WriteAllText((Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'config/switchyard/patches/compatibility.patch'),'compatibility')
 }
 if ($args -contains '--check' -and $env:SWITCHYARD_BUILD_FAILURE -eq 'post-check-mutation') {
  [IO.File]::WriteAllText((Join-Path $env:SWITCHYARD_BUILD_FIXTURE 'config/switchyard/patches/compatibility.patch'),'changed after validation')
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
  for (const mode of ["success", "long-path", "post-check-mutation", "change-and-restore", "clone", "dirty-checkout", "status", "lint", "patch-hash", "binary-path"]) {
    const snapshotsBefore = new Set(readdirSync(os.tmpdir()).filter(name => /^switchyard-patches-[a-f0-9]{32}$/u.test(name)));
    for (const name of ["contribution", "compatibility"]) writeFileSync(path.join(directory, `config/switchyard/patches/${name}.patch`), name);
    const inputs = structuredClone(lock);
    if (mode === "long-path") inputs.commit = sourceCommit;
    if (mode === "patch-hash") inputs.patchSha256 = "f".repeat(64);
    if (mode === "binary-path") inputs.binary = "../foreign.exe";
    writeFileSync(path.join(directory, "config/switchyard/source.lock"), JSON.stringify(inputs));
    for (const name of ["trace.jsonl", "build-path.txt"]) rmSync(path.join(directory, name), { force: true });
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, SWITCHYARD_BUILD_FIXTURE: directory, SWITCHYARD_BUILD_FAILURE: mode },
    });
    const succeeds = ["success", "long-path", "post-check-mutation", "change-and-restore"].includes(mode);
    assert.equal(result.status, succeeds ? 0 : 1, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(os.tmpdir()).filter(name => /^switchyard-patches-[a-f0-9]{32}$/u.test(name) && !snapshotsBefore.has(name)), [], "success and failure retire their snapshots");
    const tracePath = path.join(directory, "trace.jsonl");
    const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8").trim().split(/\r?\n/u).map(JSON.parse) : [];
    const buildPathFile = path.join(directory, "build-path.txt");
    const buildPath = existsSync(buildPathFile) ? readFileSync(buildPathFile, "utf8") : undefined;
    if (buildPath) {
      assert.equal(realpathSync.native(path.dirname(buildPath)), realpathSync.native(os.tmpdir()));
      assert.match(path.basename(buildPath), /^switchyard-build-[a-f0-9]{32}$/u);
      t.after(() => rmSync(buildPath, { recursive: true, force: true }));
    }
    const applications = trace.filter(row => row.command === "git" && row.args.includes("apply"));
    for (const application of applications) {
      const snapshot = application.args.at(-1);
      assert.equal(realpathSync.native(path.dirname(path.dirname(snapshot))), realpathSync.native(os.tmpdir()));
      assert.match(path.basename(path.dirname(snapshot)), /^switchyard-patches-[a-f0-9]{32}$/u);
      assert.equal(existsSync(path.dirname(snapshot)), false, "patch snapshots were retired");
    }
    if (succeeds) {
      const candidate = JSON.parse(/^BUILD_RESULT=(.+)$/mu.exec(result.stdout)[1]);
      assert.equal(candidate.candidateHash, hash("synthetic binary"));
      assert.equal(candidate.upstreamCommit, inputs.commit);
      assert.equal(candidate.buildRoot, buildPath);
      assert.ok(existsSync(candidate.candidateBinary));
      const [contribution, , compatibility] = applications.map(row => row.args.at(-1));
      assert.deepEqual(trace.filter(row => row.command === "git").map(row => row.args.slice(2)), [
        ["core.longpaths=true", "--filter=blob:none", "--no-checkout", lock.repository, buildPath], ["checkout", "--detach", inputs.commit],
        ["status", "--porcelain=v1", "--untracked-files=all"],
        ["apply", "--check", contribution], ["apply", contribution],
        ["apply", "--check", compatibility], ["apply", compatibility],
      ]);
      assert.deepEqual(applications.map(row => row.patchBytes), ["contribution", "contribution", "compatibility", "compatibility"]);
      if (mode === "long-path") {
        const checkedOut = path.join(buildPath, longRelative);
        assert.ok(checkedOut.length > 260);
        assert.equal(readFileSync(checkedOut, "utf8").replaceAll("\r\n", "\n"), "long source fixture\n");
      }
      if (mode === "post-check-mutation") assert.equal(readFileSync(path.join(directory, "config/switchyard/patches/compatibility.patch"), "utf8"), "changed after validation");
      const cargo = trace.filter(row => row.args[2] === "cargo").map(row => row.args.slice(3));
      assert.deepEqual(cargo.map(args => args[0]), ["fmt", "clippy", "test", "build"]);
      assert.ok(cargo.slice(1).every(args => args.includes("--locked")));
    } else {
      assert.doesNotMatch(result.stdout, /BUILD_RESULT=/u);
      if (buildPath) assert.equal(existsSync(buildPath), false, "failed checkout was removed");
      if (mode === "clone") assert.equal(trace.length, 1, "failed clone stops all later commands");
      if (mode === "dirty-checkout" || mode === "status") {
        assert.equal(applications.length, 0, "incomplete or unknown checkout stops before patching");
        assert.equal(trace.some(row => row.command === "rustup"), false);
        assert.match(result.stdout, mode === "status" ? /checkout status exited with status 8/u : /checkout is incomplete or dirty/u);
      }
      if (mode === "lint") assert.equal(trace.some(row => row.args.includes("build") || row.args.includes("test")), false);
      if (mode === "patch-hash" || mode === "binary-path") assert.equal(trace.length, 0, "invalid inputs fail before cloning");
    }
  }
});
