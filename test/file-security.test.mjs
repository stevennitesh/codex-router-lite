import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("real ACL helpers retain supplied AppData paths without inheriting ambient credentials", windows, async t => {
  const root = fixture(t), target = path.join(root, "fixture.secret");
  writeFileSync(target, "synthetic fixture");
  const runtime = { APPDATA: path.join(root, "Roaming"), LOCALAPPDATA: path.join(root, "Local") };
  for (const directory of Object.values(runtime)) mkdirSync(directory);
  const secrets = ["OPENROUTER_API_KEY", "CODEX_ROUTER_CALLER_KEY", "MODEL_ROUTER_INTERNAL_KEY", "PROBE_API_KEY", "NODE_OPTIONS"];
  const names = [...Object.keys(runtime), ...secrets];
  const saved = names.map(name => process.env[name]);
  Object.assign(process.env, runtime);
  for (const name of secrets) process.env[name] = "synthetic-environment-canary";
  t.after(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));
  let verifications = 0;
  const launches = new Set();
  function inspect(options, mode) {
    for (const [name, value] of Object.entries(runtime)) assert.equal(options.env[name], value);
    for (const name of secrets) assert.equal(options.env[name], undefined);
    if (options.env.CODEX_ROUTER_PRIVATE_FILES) launches.add(mode);
  }
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    inspect(options, "sync");
    if (options.env.CODEX_ROUTER_PRIVATE_FILE) verifications++;
    return exec(command, args, options);
  });
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    inspect(options, "async");
    return spawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(privateFileIsProtected(target), false);
  protectPrivateFile(target);
  assert.equal(privateFileIsProtected(target), true);
  const asyncTarget = path.join(root, "async.json");
  await writePrivateJsonAsync(asyncTarget, { synthetic: true });
  assert.equal(privateFileIsProtected(asyncTarget), true);
  assert.deepEqual([...launches].sort(), ["async", "sync"]);
  assert.equal(verifications, 3);
});

// These paths exist only in the mocked filesystem. Each writer reaches its
// real cleanup boundary without launching a process or opening private state.
function privateCleanupFixture(t, writer, race) {
  const original = Object.assign(new Error("synthetic private-write failure"), { code: race === "collision" ? "EEXIST" : "EIO" });
  const owned = { kind: "file", dev: 17n, ino: 2n ** 60n };
  const foreign = { ...owned, ino: owned.ino + 1n };
  let current = race === "collision" ? foreign : owned;
  let hardened = false;
  let contents = "";
  let closed = 0;
  let removals = 0;
  const metadata = value => ({ ...value,
    isFile: () => value.kind === "file",
    isSymbolicLink: () => value.kind === "symlink",
  });
  const fail = () => {
    if (race === "regular") current = foreign;
    if (race === "device") current = { ...owned, dev: owned.dev + 1n };
    if (race === "directory" || race === "symlink") current = { ...owned, kind: race };
    if (race === "absent") current = undefined;
    throw original;
  };
  const harden = () => {
    assert.equal(contents, "", "private bytes must wait for hardening");
    hardened = true;
    if (writer === "create") fail();
  };
  t.mock.method(fs, "mkdirSync", () => {});
  t.mock.method(fs, "openSync", (_target, flags, mode) => {
    assert.equal(flags, "wx");
    assert.equal(mode, 0o600);
    if (race === "collision") throw original;
    return 123;
  });
  t.mock.method(fs, "fstatSync", (descriptor, options) => {
    assert.equal(descriptor, 123);
    assert.equal(options?.bigint, true, "ownership must retain exact file IDs");
    if (race === "unknown") throw original;
    return metadata(owned);
  });
  t.mock.method(fs, "writeFileSync", (descriptor, value) => {
    assert.equal(descriptor, 123, "write through the original descriptor");
    assert.equal(hardened, true);
    contents = value;
  });
  t.mock.method(fs, "closeSync", descriptor => { assert.equal(descriptor, 123); closed++; });
  t.mock.method(fs, "renameSync", fail);
  t.mock.method(fs, "lstatSync", (_target, options) => {
    assert.equal(options?.bigint, true);
    if (race === "inspect") throw Object.assign(new Error("unbounded synthetic detail ".repeat(1000)), { code: "EACCES" });
    if (!current) throw Object.assign(new Error("synthetic absent path"), { code: "ENOENT" });
    return metadata(current);
  });
  t.mock.method(fs, "unlinkSync", () => {
    removals++;
    if (race === "cleanup") throw Object.assign(new Error("unbounded synthetic detail ".repeat(1000)), { code: "EPERM" });
    current = undefined;
  });
  t.mock.method(childProcess, "execFileSync", harden);
  t.mock.method(childProcess, "spawn", () => {
    harden();
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    original,
    invoke: () => writer === "create"
      ? createPrivateFile("synthetic-private-file", "synthetic contents", { protect: harden })
      : writer === "sync"
        ? writePrivateFile("synthetic-private-file", "synthetic contents")
        : writePrivateJsonAsync("synthetic-private-file", { synthetic: "contents" }),
    result: () => ({ current, owned, foreign, closed, removals }),
  };
}

for (const writer of ["create", "sync", "async"]) {
  for (const race of ["regular", "device", "directory", "symlink", "absent", "owned", "cleanup", "inspect", "unknown", "collision"]) {
    test(writer + " private cleanup preserves ownership after " + race + " failure", async t => {
      const fixture = privateCleanupFixture(t, writer, race);
      let failure;
      try { await fixture.invoke(); } catch (error) { failure = error; }
      assert.equal(failure, fixture.original, "cleanup must preserve the operation's original error");
      const result = fixture.result();
      assert.equal(result.closed, race === "collision" ? 0 : 1);
      assert.equal(result.removals, ["owned", "cleanup"].includes(race) ? 1 : 0);
      if (["absent", "owned"].includes(race)) assert.equal(result.current, undefined);
      else assert.ok(result.current, "an unrelated or unverified object must be preserved");
      if (race === "regular" || race === "collision") assert.equal(result.current, result.foreign);
      if (race === "device") assert.notEqual(result.current.dev, result.owned.dev);
      if (["directory", "symlink"].includes(race)) assert.equal(result.current.kind, race);
      if (["absent", "owned", "collision"].includes(race)) assert.equal(failure.cleanupError, undefined);
      else {
        const code = race === "cleanup" ? "EPERM" : race === "inspect" ? "EACCES" : "ESTALE";
        assert.equal(failure.cleanupError?.code, code);
        assert.ok(failure.cleanupError.message.length < 128, "cleanup diagnostics must be bounded");
        assert.doesNotMatch(failure.cleanupError.message, /unbounded synthetic detail/);
      }
    });
  }
}
