import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-update-fixture-"));
  const source = path.join(directory, "checkout"), remote = path.join(directory, "origin.git");
  const trace = path.join(directory, "trace.jsonl");
  mkdirSync(path.join(source, "src"), { recursive: true }); writeFileSync(trace, "");
  copyFileSync(path.join(root, "src/update.mjs"), path.join(source, "src/update.mjs"));
  writeFileSync(path.join(source, "src/paths.mjs"), "export const SOURCE_ROOT=process.env.UPDATE_FIXTURE_ROOT;\n");
  writeFileSync(path.join(source, "src/install-manifest.mjs"), "export const readInstallManifest=()=>({current:{commit:process.env.UPDATE_FIXTURE_INSTALLED}});\n");
  writeFileSync(path.join(source, "src/service-drain.mjs"), `import {execFileSync} from 'node:child_process';import {appendFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
const head=execFileSync('git',['-C',process.env.UPDATE_FIXTURE_ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
appendFileSync(process.env.UPDATE_FIXTURE_TRACE,JSON.stringify({kind:'drain',command:process.argv[2],head,force:process.argv.includes('--force-service-replacement')})+'\\n');
if(process.argv[2]==='prepare'){
 if(process.env.UPDATE_FIXTURE_MUTATE==='edit')writeFileSync(path.join(process.env.UPDATE_FIXTURE_ROOT,'release.txt'),'edit during prepare\\n');
 if(process.env.UPDATE_FIXTURE_MUTATE==='branch')execFileSync('git',['-C',process.env.UPDATE_FIXTURE_ROOT,'switch','-c','concurrent'],{stdio:'pipe'});
}
process.exit(process.argv[2]==='prepare'&&process.env.UPDATE_FIXTURE_DENY==='1'&&!process.argv.includes('--force-service-replacement')?7:0);`);
  writeFileSync(path.join(source, "install.ps1"), `param([switch]$CheckoutInstall,[string]$Target,[switch]$ForceServiceReplacement)
$head=(& git -C $env:UPDATE_FIXTURE_ROOT rev-parse HEAD).Trim()
@{kind='installer';head=$head;target=$Target;force=[bool]$ForceServiceReplacement} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:UPDATE_FIXTURE_TRACE
if ($env:UPDATE_FIXTURE_FAIL_INSTALL -eq '1' -and (Get-Content -LiteralPath (Join-Path $env:UPDATE_FIXTURE_ROOT 'release.txt')) -eq 'B') { exit 1 }
exit 0
`);
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Update fixture"); git("config", "user.email", "update@example.invalid");
  git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", path.join(directory, "no-hooks"));
  git("config", "core.autocrlf", "false");
  writeFileSync(path.join(source, "release.txt"), "A\n"); git("add", "."); git("commit", "-m", "fixture A"); const a = git("rev-parse", "HEAD");
  writeFileSync(path.join(source, "release.txt"), "B\n"); writeFileSync(path.join(source, "new.txt"), "remote tracked file\n");
  git("add", "."); git("commit", "-m", "fixture B"); const b = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", source, remote], { windowsHide: true, stdio: "pipe" });
  git("remote", "add", "origin", remote); git("fetch", "origin", "main"); git("update-ref", "refs/codex-router/rollback", a);
  const calls = () => readFileSync(trace, "utf8").replaceAll("\uFEFF", "").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(source, "src/update.mjs"), ...args], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, UPDATE_FIXTURE_ROOT: source, UPDATE_FIXTURE_TRACE: trace, UPDATE_FIXTURE_INSTALLED: a,
      CODEX_ROUTER_REPOSITORY_URL: remote, ...extra },
  });
  const clear = () => writeFileSync(trace, "");
  const dispose = () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^router-update-fixture-/u);
    rmSync(directory, { recursive: true, force: true });
  };
  return { source, git, a, b, run, calls, clear, dispose };
}

test("rollback then refused update preserves detached HEAD and tracked content", { skip: !windows }, () => {
  const f = fixture();
  try {
    const rolled = f.run(["rollback"]); assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(f.git("branch", "--show-current"), ""); assert.equal(f.git("rev-parse", "main"), f.b);
    f.clear(); const result = f.run(["update"], { UPDATE_FIXTURE_DENY: "1" });
    assert.equal(result.status, 1); assert.match(result.stderr, /replacement was deferred/u);
    assert.equal(f.git("rev-parse", "HEAD"), f.a); assert.equal(f.git("branch", "--show-current"), "");
    assert.equal(readFileSync(path.join(f.source, "release.txt"), "utf8"), "A\n");
    assert.deepEqual(f.calls().map(c => [c.kind, c.command, c.head]), [["drain", "prepare", f.a]]);
  } finally { f.dispose(); }
});

test("force cannot discard edits on a deferred update or rollback", { skip: !windows }, () => {
  const f = fixture();
  try {
    for (const command of ["update", "rollback"]) {
      f.git("reset", "--hard", command === "update" ? f.a : f.b);
      writeFileSync(path.join(f.source, "release.txt"), "personal edit\n"); f.clear();
      const result = f.run([command, "--force"], { UPDATE_FIXTURE_DENY: "1" });
      assert.equal(result.status, 1); assert.match(result.stderr, /replacement was deferred/u);
      assert.equal(readFileSync(path.join(f.source, "release.txt"), "utf8"), "personal edit\n");
      assert.equal(f.calls().length, 1); assert.equal(f.calls()[0].force, false);
    }
  } finally { f.dispose(); }
});

test("authorized advance discards only after prepare and preserves explicit service force", { skip: !windows }, () => {
  const f = fixture();
  try {
    f.git("reset", "--hard", f.a); writeFileSync(path.join(f.source, "release.txt"), "personal edit\n");
    assert.match(f.run(["update"]).stderr, /local changes/u); assert.equal(f.calls().length, 0);
    const result = f.run(["update", "--force", "--force-service-replacement"], { UPDATE_FIXTURE_DENY: "1" });
    assert.equal(result.status, 0, result.stderr); assert.equal(f.git("rev-parse", "HEAD"), f.b);
    const calls = f.calls(); assert.equal(calls[0].head, f.a); assert.equal(calls[0].force, true);
    assert.equal(calls[1].kind, "installer"); assert.equal(calls[1].head, f.b); assert.equal(calls[1].force, true);
  } finally { f.dispose(); }
});

test("failed installer or fast-forward transition restores the captured checkout", { skip: !windows }, () => {
  for (const mode of ["installer", "untracked-collision", "detached-main-diverged"]) {
    const f = fixture();
    try {
      f.git("reset", "--hard", f.a);
      if (mode === "untracked-collision") writeFileSync(path.join(f.source, "new.txt"), "keep my untracked file\n");
      if (mode === "detached-main-diverged") {
        writeFileSync(path.join(f.source, "release.txt"), "local branch C\n"); f.git("add", "."); f.git("commit", "-m", "fixture divergent main");
        f.git("switch", "--detach", f.a);
      }
      const result = f.run(["update"], { UPDATE_FIXTURE_FAIL_INSTALL: mode === "installer" ? "1" : "0" });
      assert.equal(result.status, 1); assert.match(result.stderr, /restored to/u);
      assert.equal(f.git("rev-parse", "HEAD"), f.a); assert.equal(readFileSync(path.join(f.source, "release.txt"), "utf8"), "A\n");
      assert.equal(f.calls().filter(c => c.kind === "installer").at(-1).head, f.a);
      if (mode === "untracked-collision") assert.equal(readFileSync(path.join(f.source, "new.txt"), "utf8"), "keep my untracked file\n");
    } finally { f.dispose(); }
  }
});

test("synchronized, local-ahead and divergent preflight never rewrite or restart", { skip: !windows }, () => {
  const f = fixture();
  try {
    const synchronized = f.run(["update"], { UPDATE_FIXTURE_INSTALLED: f.b });
    assert.equal(synchronized.status, 0, synchronized.stderr); assert.equal(JSON.parse(synchronized.stdout).reinstalled, false);
    writeFileSync(path.join(f.source, "release.txt"), "local C\n"); f.git("add", "."); f.git("commit", "-m", "fixture local C");
    const c = f.git("rev-parse", "HEAD"), ahead = f.run(["update"], { UPDATE_FIXTURE_INSTALLED: c });
    assert.equal(ahead.status, 0, ahead.stderr); assert.equal(JSON.parse(ahead.stdout).relation, "local-ahead");
    f.git("reset", "--hard", f.a); writeFileSync(path.join(f.source, "release.txt"), "divergent C\n"); f.git("add", "."); f.git("commit", "-m", "fixture divergent C");
    const divergent = f.git("rev-parse", "HEAD"), result = f.run(["update"]);
    assert.equal(result.status, 1); assert.match(result.stderr, /diverged/u); assert.equal(f.git("rev-parse", "HEAD"), divergent);
    assert.equal(f.calls().length, 0); assert.equal(existsSync(path.join(f.source, "new.txt")), false);
  } finally { f.dispose(); }
});

test("changes during preparation are preserved and refuse checkout replacement", { skip: !windows }, () => {
  for (const mode of ["edit", "branch"]) {
    const f = fixture();
    try {
      f.git("reset", "--hard", f.a);
      const result = f.run(["update"], { UPDATE_FIXTURE_MUTATE: mode });
      assert.equal(result.status, 1); assert.match(result.stderr, mode === "edit" ? /local changes/u : /checkout changed/u);
      assert.equal(f.git("rev-parse", "HEAD"), f.a);
      assert.equal(readFileSync(path.join(f.source, "release.txt"), "utf8"), mode === "edit" ? "edit during prepare\n" : "A\n");
      assert.equal(f.git("branch", "--show-current"), mode === "branch" ? "concurrent" : "main");
      assert.equal(f.calls().some(c => c.kind === "installer"), false);
    } finally { f.dispose(); }
  }
});
