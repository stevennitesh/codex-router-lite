import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { privateFileIsProtected, protectPrivateFile, writePrivateFile } from "../src/file-security.mjs";
import { withCallerKeyRotationLock } from "../src/caller-key-rotation-lock.mjs";

const windows = { skip: process.platform !== "win32" };
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "secret-state-"));
  writeFileSync(path.join(root, ".credential-fixture"), "synthetic credential fixture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, command, prefix = []) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(path.join(import.meta.dirname, "fixtures/credential-state-guard.mjs")).href, ...prefix, "src/secret.mjs", command], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: root, CODEX_ROUTER_STATE_DIR: root, CODEX_HOME: root,
      TEST_CREDENTIAL_STATE_ROOT: root, TEST_CREDENTIAL_HOME_ROOT: root },
  });
}
const synthetic = "synthetic_capability_" + "a".repeat(48);

function barrierChild(t, root, role) {
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(import.meta.dirname, "fixtures/credential-state-guard.mjs")).href,
    "--import", pathToFileURL(path.join(import.meta.dirname, "fixtures/secret-ensure-barrier.mjs")).href, "src/secret.mjs", "ensure"], {
    cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: root, CODEX_ROUTER_STATE_DIR: root, CODEX_HOME: root,
      TEST_ENSURE_ROOT: root, TEST_ENSURE_ROLE: role, TEST_CREDENTIAL_STATE_ROOT: root, TEST_CREDENTIAL_HOME_ROOT: root },
  });
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  child.stdout.resume();
  const events = [], waiters = [];
  child.on("message", ({ event }) => { events.push(event); for (const waiter of waiters.splice(0)) waiter(); });
  const ended = new Promise(resolve => child.once("close", code => resolve({ code, errors })));
  const release = () => writeFileSync(path.join(root, `release-${role}`), "release");
  t.after(async () => {
    if (child.exitCode === null) {
      if (existsSync(root)) release(); else child.kill();
    }
    await ended;
  });
  return { ended, release, async event() {
    while (!events.length) {
      await Promise.race([new Promise(resolve => waiters.push(resolve)), ended.then(result => { throw new Error(`Ensure child ended before its barrier: ${result.errors}`); })]);
    }
    return events.shift();
  } };
}

test("concurrent ensure CLIs preserve the first successfully published pair", { ...windows, timeout: 30_000 }, async t => {
  const root = fixture(t), first = barrierChild(t, root, "a");
  assert.equal(await first.event(), "missing");
  const second = barrierChild(t, root, "b");
  assert.ok(["contended", "missing"].includes(await second.event()));
  first.release();
  assert.deepEqual(await first.ended, { code: 0, errors: "" });
  const targets = ["internal-secret", "caller-secret"].map(name => path.join(root, name));
  const bytes = targets.map(target => readFileSync(target, "utf8"));
  second.release();
  assert.deepEqual(await second.ended, { code: 0, errors: "" });
  targets.forEach((target, index) => assert.ok(readFileSync(target, "utf8") === bytes[index], "a successful initializer must preserve the published identity"));
});

test("ensure waits for the rotation owner before inspecting a missing live capability", { ...windows, timeout: 30_000 }, async t => {
  const root = fixture(t);
  let child;
  await withCallerKeyRotationLock(async () => {
    child = barrierChild(t, root, "b");
    assert.equal(await child.event(), "contended");
    assert.equal(existsSync(path.join(root, "internal-secret")), false);
    assert.equal(existsSync(path.join(root, "caller-secret")), false);
    writePrivateFile(path.join(root, "caller-secret"), synthetic);
    child.release();
  }, { stateDir: root });
  assert.deepEqual(await child.ended, { code: 0, errors: "" });
  assert.equal(readFileSync(path.join(root, "caller-secret"), "utf8"), synthetic);
});

test("pending journals and orphan generations refuse ensure before either key changes", windows, t => {
  for (const journal of [JSON.stringify({ version: 1, operationId: "a".repeat(32), phase: "prepared", targets: [], serviceWasRunning: false, previousSecretSha256: "b".repeat(64) }), "{}", "invalid journal"]) {
    const root = fixture(t);
    writePrivateFile(path.join(root, "caller-key-rotation.json"), journal);
    const result = run(root, "ensure");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rotation.*pending|pending.*rotation/u);
    for (const name of ["internal-secret", "caller-secret"]) assert.equal(existsSync(path.join(root, name)), false);
  }
  const root = fixture(t), orphan = path.join(root, `caller-secret.rotate-displaced.${"a".repeat(32)}`);
  writePrivateFile(orphan, synthetic);
  assert.equal(run(root, "ensure").status, 1);
  assert.equal(existsSync(path.join(root, "internal-secret")), false);
  assert.equal(readFileSync(orphan, "utf8"), synthetic);
  writePrivateFile(path.join(root, "caller-secret"), synthetic);
  assert.equal(run(root, "ensure").status, 0, "valid restored live keys permit retained old auxiliary files");
  assert.equal(readFileSync(orphan, "utf8"), synthetic);
});

test("uncertain journal inspection refuses initialization without changing either capability", windows, t => {
  const root = fixture(t), caller = path.join(root, "caller-secret"), preload = path.join(root, "journal-error.mjs");
  writePrivateFile(caller, synthetic);
  for (const code of ["EACCES", "EIO"]) {
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const lstat=fs.lstatSync;fs.lstatSync=(target,...args)=>{if(String(target).endsWith('caller-key-rotation.json'))throw Object.assign(new Error('synthetic journal error'),{code:${JSON.stringify(code)}});return lstat(target,...args);};syncBuiltinESMExports();`);
    const result = run(root, "ensure", ["--import", pathToFileURL(preload).href]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rotation.*pending/u);
    assert.equal(existsSync(path.join(root, "internal-secret")), false);
    assert.equal(readFileSync(caller, "utf8"), synthetic);
  }
});

test("ensure initializes absent capabilities and preserves valid identities; status is read-only", windows, t => {
  const root = fixture(t);
  const first = run(root, "ensure");
  assert.equal(first.status, 0, first.stderr);
  const targets = ["internal-secret", "caller-secret"].map(name => path.join(root, name));
  const bytes = targets.map(target => readFileSync(target, "utf8"));
  for (const target of targets) assert.equal(privateFileIsProtected(target), true);
  assert.equal(run(root, "ensure").status, 0);
  targets.forEach((target, index) => assert.equal(readFileSync(target, "utf8"), bytes[index]));
  const looseRoot = fixture(t);
  const looseTargets = ["internal-secret", "caller-secret"].map(name => path.join(looseRoot, name));
  looseTargets.forEach(target => writeFileSync(target, synthetic));
  const status = run(looseRoot, "status");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).present, true);
  assert.equal(status.stdout.includes(synthetic), false);
  looseTargets.forEach(target => assert.equal(privateFileIsProtected(target), false));
});

test("real read denial refuses setup before creating the other capability", windows, t => {
  const root = fixture(t), caller = path.join(root, "caller-secret");
  writeFileSync(caller, synthetic);
  const script = "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.File]::GetAccessControl($env:FIXTURE_FILE); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadData,[Security.AccessControl.AccessControlType]::Deny)); [IO.File]::SetAccessControl($env:FIXTURE_FILE,$acl)";
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 15_000, env: { ...process.env, FIXTURE_FILE: caller },
  });
  t.after(() => { if (existsSync(caller)) protectPrivateFile(caller); });
  assert.throws(() => readFileSync(caller, "utf8"), error => ["EPERM", "EACCES"].includes(error.code));
  const result = run(root, "ensure");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /access-denied/);
  assert.equal(existsSync(path.join(root, "internal-secret")), false);
  protectPrivateFile(caller);
  assert.equal(readFileSync(caller, "utf8"), synthetic);
});

for (const name of ["internal-secret", "caller-secret"]) {
test(`invalid ${name} contents are reported without regenerating either capability`, windows, t => {
  for (const value of ["", "sk-1234", "synthetic_invalid!_" + "a".repeat(48), "synthetic invalid_" + "a".repeat(48)]) {
    const root = fixture(t), target = path.join(root, name);
    const other = path.join(root, name === "internal-secret" ? "caller-secret" : "internal-secret");
    writeFileSync(target, value);
    const status = run(root, "status");
    assert.equal(status.status, 1, status.stderr);
    assert.equal(JSON.parse(status.stdout)[name === "internal-secret" ? "internal" : "caller"].fileStatus, "invalid");
    const result = run(root, "ensure");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /is invalid/u);
    if (value) assert.equal((status.stdout + status.stderr + result.stdout + result.stderr).includes(value), false);
    assert.equal(readFileSync(target, "utf8"), value);
    assert.equal(existsSync(other), false);
  }
});
}

test("non-absence read errors do not regenerate capabilities", windows, t => {
  const root = fixture(t), caller = path.join(root, "caller-secret");
  writeFileSync(caller, synthetic);
  const preload = path.join(root, "read-error.mjs");
  for (const code of ["EIO", "ENOENT"]) {
    writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const read=fs.readFileSync; fs.readFileSync=function(target,...args){if(String(target).endsWith('caller-secret')){const error=new Error('synthetic-private-error-canary');error.code=${JSON.stringify(code)};throw error;}return read.call(this,target,...args);};syncBuiltinESMExports();`);
    const result = run(root, "ensure", ["--import", pathToFileURL(preload).href]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`probe-failed \\(${code}\\)`));
    assert.equal(result.stderr.includes("synthetic-private-error-canary"), false);
    assert.equal(readFileSync(caller, "utf8"), synthetic);
    assert.equal(existsSync(path.join(root, "internal-secret")), false);
  }
});
