import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { privateFileIsProtected, protectPrivateFile } from "../src/file-security.mjs";

const windows = { skip: process.platform !== "win32" };
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "secret-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, command, prefix = []) {
  return spawnSync(process.execPath, [...prefix, "src/secret.mjs", command], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: root, CODEX_ROUTER_STATE_DIR: root, CODEX_HOME: root },
  });
}
const synthetic = "synthetic_capability_" + "a".repeat(48);

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

test("invalid contents and non-absence read errors do not regenerate capabilities", windows, t => {
  const root = fixture(t), caller = path.join(root, "caller-secret");
  writeFileSync(caller, "invalid fixture");
  assert.equal(run(root, "ensure").status, 1);
  assert.equal(readFileSync(caller, "utf8"), "invalid fixture");
  assert.equal(existsSync(path.join(root, "internal-secret")), false);
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
