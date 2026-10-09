import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPrivateFile, privateFileIsProtected, protectPrivateFile, writePrivateFile, writePrivateJsonAsync } from "../src/file-security.mjs";
import { restoreCallerCapability, swapCallerCapability } from "../src/caller-key-rotation.mjs";

const windows = { skip: process.platform !== "win32" };
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "private-staging-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const exec = childProcess.execFileSync;
const spawn = childProcess.spawn;
function powershell(script, extra) {
  return exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, ...extra },
  }).trim();
}

test("sync, async and rotating private files stay empty until Windows ACL hardening", windows, async t => {
  const root = fixture(t);
  powershell("$ErrorActionPreference='Stop'; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; $none=[Security.AccessControl.PropagationFlags]::None; $allow=[Security.AccessControl.AccessControlType]::Allow; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$none,$allow)); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,$none,$allow)); [IO.Directory]::SetAccessControl($env:FIXTURE_DIRECTORY,$acl)", { FIXTURE_DIRECTORY: root });
  const staging = [];
  function beforeHardening(options) {
    for (const target of JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES || "[]")) {
      if (!target.includes(".tmp.") && !target.includes(".rotate-new.")) continue;
      assert.equal(readFileSync(target, "utf8"), "", "no bytes are present under inherited permissions");
      const readable = powershell("$acl=[IO.File]::GetAccessControl($env:FIXTURE_FILE); $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); [Console]::Out.Write((@($rules | Where-Object {$_.IdentityReference.Value -eq 'S-1-1-0' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)}).Count -gt 0).ToString())", { FIXTURE_FILE: target });
      assert.equal(readable, "True", "the fixture genuinely permits foreign reads before hardening");
      staging.push(target);
    }
  }
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    beforeHardening(options);
    return exec(command, args, options);
  });
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    beforeHardening(options);
    return spawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const syncTarget = path.join(root, "sync.secret");
  const asyncTarget = path.join(root, "async.json");
  writeFileSync(syncTarget, "synthetic old value");
  writePrivateFile(syncTarget, "synthetic new value");
  await writePrivateJsonAsync(asyncTarget, { synthetic: "private fixture" });
  assert.equal(readFileSync(syncTarget, "utf8"), "synthetic new value");
  assert.deepEqual(JSON.parse(readFileSync(asyncTarget, "utf8")), { synthetic: "private fixture" });
  assert.equal(privateFileIsProtected(syncTarget), true);
  assert.equal(privateFileIsProtected(asyncTarget), true);

  const secretPath = path.join(root, "caller-secret");
  const prior = "synthetic_previous_" + "a".repeat(48);
  const next = "synthetic_next_" + "b".repeat(48);
  writePrivateFile(secretPath, prior + "\n");
  const operationId = "a".repeat(32);
  const rotated = swapCallerCapability({ secretPath, operationId, generateSecret: () => next });
  assert.equal(readFileSync(secretPath, "utf8").trim(), next);
  assert.equal(privateFileIsProtected(rotated.backupPath), true);
  assert.equal(privateFileIsProtected(secretPath), true);
  assert.equal(restoreCallerCapability({ secretPath, operationId }).currentSecret, prior);
  assert.equal(readFileSync(secretPath, "utf8").trim(), prior);
  assert.equal(privateFileIsProtected(secretPath), true);
  assert.equal(staging.length, 4);
});

test("failed hardening preserves the old target and removes only its empty staging file", windows, async t => {
  const root = fixture(t);
  const target = path.join(root, "existing.secret");
  writeFileSync(target, "unchanged synthetic value");
  t.mock.method(childProcess, "execFileSync", (_command, _args, options) => {
    for (const staged of JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES)) assert.equal(readFileSync(staged, "utf8"), "");
    throw new Error("synthetic ACL failure");
  });
  t.mock.method(childProcess, "spawn", (_command, _args, options) => {
    for (const staged of JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES)) assert.equal(readFileSync(staged, "utf8"), "");
    return spawn(process.execPath, ["-e", "process.stderr.write('synthetic ACL failure');process.exit(7)"], options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => writePrivateFile(target, "replacement"), /ACL failure/);
  await assert.rejects(writePrivateJsonAsync(target, { replacement: true }), /ACL failure/);
  assert.equal(readFileSync(target, "utf8"), "unchanged synthetic value");
  assert.deepEqual(readdirSync(root), ["existing.secret"]);
  assert.throws(() => createPrivateFile(target, "replacement"), { code: "EEXIST" });
  assert.equal(readFileSync(target, "utf8"), "unchanged synthetic value");
  assert.equal(existsSync(target), true);
});

test("real ACL verification works without inheriting ambient credentials", windows, t => {
  const root = fixture(t), target = path.join(root, "fixture.secret");
  writeFileSync(target, "synthetic fixture");
  const names = ["OPENROUTER_API_KEY", "CODEX_ROUTER_CALLER_KEY", "MODEL_ROUTER_INTERNAL_KEY"];
  const saved = names.map(name => process.env[name]);
  for (const name of names) process.env[name] = "synthetic-environment-canary";
  t.after(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));
  let verifications = 0;
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    for (const name of names) assert.equal(options.env[name], undefined);
    if (options.env.CODEX_ROUTER_PRIVATE_FILE) verifications++;
    return exec(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(privateFileIsProtected(target), false);
  protectPrivateFile(target);
  assert.equal(privateFileIsProtected(target), true);
  assert.equal(verifications, 2);
});
