import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { recoverPendingCallerKeyRotationUnlocked, runCallerKeyRotation, runNodeCommand } from "../src/caller-key.mjs";
import { restoreCallerCapability, swapCallerCapability, discardCallerCapabilityBackup, discardCallerCapabilityRetiredGenerations } from "../src/caller-key-rotation.mjs";
import { withServiceOperationLock } from "../src/service-operation-lock.mjs";
import { privateFileIsProtected, protectPrivateFile, writePrivateFile, writePrivateJson } from "../src/file-security.mjs";
import { readCallerKeyRotationJournal, clearCallerKeyRotationJournal } from "../src/caller-key-rotation-journal.mjs";
import { withCallerKeyRotationLock } from "../src/caller-key-rotation-lock.mjs";
import { withModelOverlayLock } from "../src/model-overlay-lock.mjs";
import { assertCallerSecret, assertInternalSecret, validServiceSecret } from "../src/caller-auth.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, "generated");

test("caller and internal capabilities accept the generated-secret contract without echoing rejected keys", () => {
  for (const value of ["a".repeat(32), "synthetic_capability-" + "z".repeat(48), randomBytes(48).toString("base64url")]) {
    assert.equal(validServiceSecret(value), true);
    assert.equal(assertCallerSecret(value), value);
    assert.equal(assertInternalSecret(value), value);
  }
  for (const value of [undefined, null, 32, "", "sk-1234", "a".repeat(31), "invalid!" + "a".repeat(48), "a".repeat(24) + "\n" + "b".repeat(24), "a".repeat(48) + "é"]) {
    assert.equal(validServiceSecret(value), false);
    assert.throws(() => assertCallerSecret(value), {
      message: "The local router caller key is missing or invalid; run .\\install.ps1 -Target codex.",
    });
    assert.throws(() => assertInternalSecret(value), {
      message: "The internal service key is missing or invalid; run .\\install.ps1 -Target codex.",
    });
  }
});

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, "caller-key-test-"));
  const script = path.join(dir, "command.mjs");
  return { dir, script, relative: path.relative(root, script),
    cleanup() { assert.ok(dir.startsWith(scratch + path.sep)); rmSync(dir, { recursive: true, force: true }); } };
}

test("rotation command captures completion and redacts a failed child's caller URL", async () => {
  const f = fixture();
  try {
    writeFileSync(f.script, "setTimeout(()=>process.stdout.write('complete'),20);\n");
    assert.equal(await runNodeCommand(f.relative), "complete");
    const syntheticSecret = "x".repeat(64);
    writeFileSync(f.script, `process.stderr.write('refresh failed http://127.0.0.1:9876/_codex-router/${syntheticSecret}/v1'); process.exitCode=9;\n`);
    await assert.rejects(runNodeCommand(f.relative), error =>
      error.message.includes("refresh failed") && !error.message.includes(syntheticSecret));
  } finally { f.cleanup(); }
});

test("rotation child wait holds the service generation and advances its own heartbeat", { timeout: 30_000 }, async () => {
  const f = fixture();
  const ready = path.join(f.dir, "ready"), finish = path.join(f.dir, "finish");
  const lock = path.join(f.dir, "service-operation.lock");
  let child, ended, output = "", errors = "";
  try {
    writeFileSync(f.script, `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(ready)},'ready');
const poll=setInterval(()=>{if(existsSync(${JSON.stringify(finish)})){clearInterval(poll);clearTimeout(watchdog);process.stdout.write('finished');}},20);
const watchdog=setTimeout(()=>{clearInterval(poll);process.exitCode=2;},25000);
`);
    const runner = pathToFileURL(path.join(root, "src/caller-key.mjs")).href;
    const locks = pathToFileURL(path.join(root, "src/service-operation-lock.mjs")).href;
    child = spawn(process.execPath, ["--input-type=module", "-e", `
import { runNodeCommand } from ${JSON.stringify(runner)};
import { withServiceOperationLock } from ${JSON.stringify(locks)};
await withServiceOperationLock(()=>runNodeCommand(${JSON.stringify(f.relative)}),{stateDir:${JSON.stringify(f.dir)},heartbeatMs:1000,waitMs:0});
process.stdout.write('released');
`], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    ended = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { errors += data; });
    const readyDeadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < readyDeadline && child.exitCode === null) await delay(20);
    assert.ok(existsSync(ready), `fixture child did not reach the command: ${errors}`);
    const owner = path.join(lock, readdirSync(lock)[0]);
    const initialMtime = statSync(owner).mtimeMs;
    await delay(6_000); // The actual async child keeps this generation held.
    assert.equal(child.exitCode, null, "the command must still be running at contention");
    assert.ok(statSync(owner).mtimeMs > initialMtime, "the generation's heartbeat advances while awaiting the child");
    let entered = false;
    await assert.rejects(withServiceOperationLock(() => { entered = true; }, { stateDir: f.dir, waitMs: 0 }), /still running/u);
    assert.equal(entered, false);
    writeFileSync(finish, "finish");
    assert.deepEqual(await ended, { code: 0, signal: null }, errors);
    assert.equal(output, "released");
    assert.equal(await withServiceOperationLock(() => "reacquired", { stateDir: f.dir, waitMs: 0 }), "reacquired");
  } finally {
    // Let the fixture command close cooperatively before removing its files.
    if (child?.exitCode === null) { writeFileSync(finish, "finish"); await ended; }
    f.cleanup();
  }
});

function rotationOptions(f, runNode) {
  const secretPath = path.join(f.dir, "caller.secret");
  const operationId = "a".repeat(32);
  writeFileSync(secretPath, "s".repeat(64) + "\n");
  return {
    secretPath, runNode, assertOwnership() {},
    withLock: operation => operation(), withMutationLocks: operation => operation(), withServiceLock: operation => operation(),
    recoverPending: async () => ({ recovered: false }),
    beginJournal: async fields => ({ ...fields, operationId, phase: "prepared" }),
    updateJournal: async (journal, phase, { patch = {} } = {}) => ({ ...journal, ...patch, phase }),
    rotateSecret: fields => swapCallerCapability({ ...fields, generateSecret: () => "n".repeat(64), protect() {} }),
    finalizeRotation: async ({ journal }) => discardCallerCapabilityBackup({ secretPath, operationId: journal.operationId }),
    runServiceMutation: async () => assert.fail("stopped synthetic service must not be mutated"),
    recoverAfterFailure: async () => assert.fail("successful rotation must not recover"),
  };
}

test("rollback resumes its interrupted missing-live rename and retains the displaced key", { skip: process.platform !== "win32" }, () => {
  const f = fixture(), secretPath = path.join(f.dir, "caller-secret"), operationId = "b".repeat(32);
  const backup = `${secretPath}.rotate-rollback.${operationId}`, displaced = `${secretPath}.rotate-displaced.${operationId}`;
  try {
    writePrivateFile(backup, "p".repeat(64));
    writePrivateFile(displaced, "c".repeat(64));
    assert.equal(restoreCallerCapability({ secretPath, operationId }).currentSecret, "p".repeat(64));
    assert.equal(readFileSync(displaced, "utf8"), "c".repeat(64));
    assert.equal(existsSync(backup), false);
  } finally { f.cleanup(); }
});

test("rotation awaits actual async status JSON and client refresh before finalizing", async () => {
  const f = fixture(), calls = [];
  try {
    writeFileSync(f.script, `
const result=process.argv[2]==='codex' ? {mode:'router',config_protected:true} : process.argv[2]==='service' ? {installed:false} : {};
setTimeout(()=>process.stdout.write(JSON.stringify(result)),20);
`);
    const options = rotationOptions(f, async (script, args) => {
      calls.push([script, ...args]);
      return runNodeCommand(f.relative, [args[0] === "caller-capability-refresh" ? "refresh" : script.includes("config-manager") ? "codex" : "service"]);
    });
    assert.deepEqual(await runCallerKeyRotation(options), { rotated: true, targets: ["codex"], serviceRestarted: false });
    assert.deepEqual(calls, [["src/config-manager.mjs", "status"], ["src/service.mjs", "status"], ["src/config-manager.mjs", "caller-capability-refresh"]]);
    assert.equal(readFileSync(options.secretPath, "utf8").trim(), "n".repeat(64));
  } finally { f.cleanup(); }
});

test("invalid async client status fails before any capability change", async () => {
  const f = fixture();
  try {
    writeFileSync(f.script, "setTimeout(()=>process.stdout.write('invalid status'),20);\n");
    const options = rotationOptions(f, () => runNodeCommand(f.relative));
    options.beginJournal = async () => assert.fail("invalid status must not start rotation");
    await assert.rejects(runCallerKeyRotation(options), /returned invalid status JSON/u);
    assert.equal(readFileSync(options.secretPath, "utf8").trim(), "s".repeat(64));
  } finally { f.cleanup(); }
});

test("refresh failure is collected before restoring the previous capability", async () => {
  const f = fixture(), finished = path.join(f.dir, "child-finished");
  let recoveryCalls = 0;
  try {
    writeFileSync(f.script, `
import { writeFileSync } from 'node:fs';
setTimeout(()=>{writeFileSync(${JSON.stringify(finished)},'finished');process.stderr.write('synthetic refresh failure');process.exitCode=9;},30);
`);
    const options = rotationOptions(f, (script, args) => {
      if (args[0] === "caller-capability-refresh") return runNodeCommand(f.relative);
      return Promise.resolve(JSON.stringify(script.includes("config-manager") ? { mode: "router", config_protected: true } : { installed: false }));
    });
    options.recoverAfterFailure = async ({ secretPath }) => {
      recoveryCalls++;
      assert.ok(existsSync(finished), "the child must finish before recovery touches the capability");
      assert.equal(readFileSync(secretPath, "utf8").trim(), "n".repeat(64));
      restoreCallerCapability({ secretPath, operationId: "a".repeat(32), protect() {}, secretIsProtected: () => true });
    };
    await assert.rejects(runCallerKeyRotation(options), /synthetic refresh failure/u);
    assert.equal(recoveryCalls, 1);
    assert.equal(readFileSync(options.secretPath, "utf8").trim(), "s".repeat(64));
  } finally { f.cleanup(); }
});

const windows = { skip: process.platform !== "win32" };
const prior = "synthetic_prior_" + "p".repeat(48);
const next = "synthetic_current_" + "c".repeat(48);
const unknown = "synthetic_unbound_" + "u".repeat(48);
const hash = value => createHash("sha256").update(value).digest("hex");

function recoveryFixture(t, { phase = "secret-swapped", live, backup = prior, displaced, temporary,
  wasRunning = false, running = false } = {}) {
  const f = fixture();
  t.after(() => f.cleanup());
  const secretPath = path.join(f.dir, "caller-secret"), operationId = "c".repeat(32);
  const paths = { live: secretPath, backup: `${secretPath}.rotate-rollback.${operationId}`,
    displaced: `${secretPath}.rotate-displaced.${operationId}`, temporary: `${secretPath}.rotate-new.${operationId}` };
  assert.ok(f.dir.startsWith(scratch + path.sep));
  for (const target of Object.values(paths)) assert.equal(path.dirname(target), f.dir);
  for (const [kind, value] of Object.entries({ live, backup, displaced, temporary })) {
    if (value !== undefined) writePrivateFile(paths[kind], value);
  }
  const journalPath = path.join(f.dir, "caller-key-rotation.json");
  assert.equal(path.dirname(journalPath), f.dir);
  const journal = { version: 1, phase, operationId, targets: ["codex"], serviceWasRunning: wasRunning,
    previousSecretSha256: hash(prior),
    ...(["prepared", "service-stopped"].includes(phase) ? {} : { currentSecretSha256: hash(next) }) };
  writePrivateJson(journalPath, journal);
  const events = [];
  const options = {
    secretPath,
    readJournal: () => readCallerKeyRotationJournal({ journalPath }),
    readServiceStatus: async () => { events.push("status"); return { installed: true, state: running ? "running" : "stopped" }; },
    runServiceMutation: async command => { events.push(command); running = command === "start"; },
    runNode: async (script, args) => {
      assert.equal(script, "src/config-manager.mjs");
      assert.deepEqual(args, ["caller-capability-refresh"]);
      assert.ok(readFileSync(secretPath, "utf8") === prior);
      events.push("refresh");
    },
    verifyServiceKeys: async ({ previousSecret, currentSecret }) => {
      const expectedStale = live && live !== prior ? live :
        journal.currentSecretSha256 && [displaced, temporary].includes(next) ? next : undefined;
      assert.ok(currentSecret === prior && expectedStale !== undefined && previousSecret === expectedStale);
      assert.equal(running, true);
      events.push("verify-stale");
    },
    verifyCurrentKey: async ({ currentSecret }) => {
      assert.ok(currentSecret === prior);
      assert.equal(running, true);
      events.push("verify-current");
    },
    retireGenerations: fields => { events.push("retire"); return discardCallerCapabilityRetiredGenerations(fields); },
    clearJournal: fields => {
      events.push("clear");
      assert.equal(privateFileIsProtected(secretPath), true);
      return clearCallerKeyRotationJournal({ ...fields, journalPath });
    },
  };
  const recover = () => withCallerKeyRotationLock(() => withModelOverlayLock(() =>
    withServiceOperationLock(() => recoverPendingCallerKeyRotationUnlocked(options), { stateDir: f.dir }),
  { stateDir: f.dir }), { stateDir: f.dir });
  return { ...f, paths, secretPath, journal, journalPath, events, options, recover };
}

for (const phase of ["prepared", "service-stopped", "secret-swapped", "clients-refreshed", "service-started"]) {
test(`pending ${phase} recovery resumes absent live with occupied auxiliary paths`, windows, async t => {
  const bound = !["prepared", "service-stopped"].includes(phase);
  const f = recoveryFixture(t, { phase, displaced: bound ? next : unknown, temporary: unknown, wasRunning: true });
  assert.deepEqual(await f.recover(), { recovered: true, committed: false });
  assert.ok(readFileSync(f.secretPath, "utf8") === prior);
  assert.equal(existsSync(f.paths.backup), false);
  assert.equal(existsSync(f.paths.displaced), !bound);
  assert.ok(readFileSync(f.paths.temporary, "utf8") === unknown);
  assert.equal(existsSync(f.journalPath), false);
  assert.deepEqual(f.events, ["status", "refresh", "start", bound ? "verify-stale" : "verify-current", "retire", "clear"]);
});
}

test("verified recovery commits only private journal-bound generations and clears last", windows, async t => {
  const f = recoveryFixture(t, { phase: "verified", live: next, displaced: unknown, temporary: next, running: true });
  assert.deepEqual(await f.recover(), { recovered: true, committed: true });
  assert.ok(readFileSync(f.secretPath, "utf8") === next);
  assert.ok(readFileSync(f.paths.displaced, "utf8") === unknown);
  assert.equal(existsSync(f.paths.backup), false);
  assert.equal(existsSync(f.paths.temporary), false);
  assert.deepEqual(f.events, ["retire", "clear"]);
});

for (const redundantBackup of [false, true]) {
test(`already restored prior repeats consistency work with ${redundantBackup ? "redundant" : "absent"} backup`, windows, async t => {
  const f = recoveryFixture(t, { live: prior, backup: redundantBackup ? prior : undefined, displaced: next, running: true });
  // Explicit undefined uses the fixture's default; remove it for this case.
  if (!redundantBackup) rmSync(f.paths.backup);
  await f.recover();
  assert.deepEqual(f.events, ["status", "stop", "refresh", "start", "verify-stale", "retire", "clear"]);
  assert.ok(readFileSync(f.secretPath, "utf8") === prior);
  assert.equal(existsSync(f.paths.displaced), false);
});
}

test("rollback displaces a bound live key and keeps it through consistency verification", windows, async t => {
  const f = recoveryFixture(t, { live: next, running: true });
  const verify = f.options.verifyServiceKeys;
  f.options.verifyServiceKeys = async fields => {
    assert.ok(readFileSync(f.paths.displaced, "utf8") === next);
    assert.equal(existsSync(f.journalPath), true);
    await verify(fields);
  };
  await f.recover();
  assert.deepEqual(f.events, ["status", "stop", "refresh", "start", "verify-stale", "retire", "clear"]);
  assert.equal(existsSync(f.paths.displaced), false);
});

test("early rollback preserves an unbound displaced live key and temporary generation", windows, async t => {
  const f = recoveryFixture(t, { phase: "prepared", live: unknown, temporary: next, wasRunning: true });
  await f.recover();
  assert.ok(readFileSync(f.paths.displaced, "utf8") === unknown);
  assert.ok(readFileSync(f.paths.temporary, "utf8") === next);
  assert.equal(privateFileIsProtected(f.paths.displaced), true);
});

test("recovery preserves stopped intent while completing client consistency", windows, async t => {
  const f = recoveryFixture(t, { displaced: next });
  await f.recover();
  assert.deepEqual(f.events, ["status", "refresh", "retire", "clear"]);
  assert.ok(readFileSync(f.secretPath, "utf8") === prior);
  assert.equal(existsSync(f.journalPath), false);
});

for (const state of [
  { label: "wrong prior backup", live: prior, backup: unknown },
  { label: "missing prior", live: undefined, backup: undefined, removeBackup: true },
  { label: "unbound live with recorded current", live: unknown },
  { label: "occupied displacement slot", live: next, displaced: next },
]) {
test(`recovery refuses ${state.label} before service effects`, windows, async t => {
  const f = recoveryFixture(t, { ...state, running: true });
  if (state.removeBackup) rmSync(f.paths.backup);
  const before = Object.fromEntries(Object.entries(f.paths).map(([kind, target]) => [kind, existsSync(target) ? readFileSync(target) : undefined]));
  await assert.rejects(f.recover(), /refusing recovery/u);
  assert.deepEqual(f.events, []);
  for (const [kind, value] of Object.entries(before)) {
    if (value) assert.deepEqual(readFileSync(f.paths[kind]), value);
    else assert.equal(existsSync(f.paths[kind]), false);
  }
  assert.equal(existsSync(f.journalPath), true);
});
}

test("recovery rechecks live identity before retirement and leaves the journal pending on change", windows, async t => {
  const f = recoveryFixture(t, { displaced: next, wasRunning: true });
  const verify = f.options.verifyServiceKeys;
  f.options.verifyServiceKeys = async fields => {
    await verify(fields);
    writePrivateFile(f.secretPath, unknown);
  };
  await assert.rejects(f.recover(), /refusing cleanup/u);
  assert.ok(readFileSync(f.secretPath, "utf8") === unknown);
  assert.ok(readFileSync(f.paths.displaced, "utf8") === next);
  assert.equal(existsSync(f.journalPath), true);
  assert.equal(f.events.includes("clear"), false);
});

test("verified recovery refuses a mismatching live generation without rolling back or deleting", windows, async t => {
  const f = recoveryFixture(t, { phase: "verified", live: prior, displaced: next, running: true });
  await assert.rejects(f.recover(), /refusing cleanup/u);
  assert.ok(readFileSync(f.secretPath, "utf8") === prior);
  assert.ok(readFileSync(f.paths.backup, "utf8") === prior);
  assert.ok(readFileSync(f.paths.displaced, "utf8") === next);
  assert.equal(existsSync(f.journalPath), true);
  assert.deepEqual(f.events, ["retire"]);
});

for (const failure of ["refresh", "start", "verify", "retire", "clear"]) {
test(`recovery retries prior-already-live after ${failure} interruption`, windows, async t => {
  const f = recoveryFixture(t, { displaced: next, temporary: unknown, wasRunning: true });
  const method = { refresh: "runNode", start: "runServiceMutation", verify: "verifyServiceKeys", retire: "retireGenerations", clear: "clearJournal" }[failure];
  const original = f.options[method];
  let interrupted = false;
  f.options[method] = async (...args) => {
    if (!interrupted && (failure !== "start" || args[0] === "start")) {
      interrupted = true;
      if (failure === "retire") await original(...args); // Cleanup completed, but the journal was not yet cleared.
      throw new Error(`synthetic ${failure} interruption`);
    }
    return original(...args);
  };
  await assert.rejects(f.recover(), new RegExp(`synthetic ${failure} interruption`, "u"));
  assert.ok(readFileSync(f.secretPath, "utf8") === prior);
  assert.equal(existsSync(f.journalPath), true);
  assert.ok(readFileSync(f.paths.temporary, "utf8") === unknown);
  await f.recover();
  assert.equal(existsSync(f.journalPath), false);
  assert.ok(readFileSync(f.paths.temporary, "utf8") === unknown);
  assert.equal(f.events.at(-1), "clear");
});
}

test("rollback retains its generations until the actual refresh child completes", { ...windows, timeout: 30_000 }, async t => {
  const f = recoveryFixture(t, { displaced: next, wasRunning: true });
  writeFileSync(f.script, `const watchdog=setTimeout(()=>process.exit(2),20000);process.on('message',()=>{clearTimeout(watchdog);process.disconnect();process.stdout.write('complete');});process.send('ready');`);
  let child, ended, ready;
  const reached = new Promise(resolve => { ready = resolve; });
  f.options.runNode = async () => {
    child = spawn(process.execPath, [f.script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", errors = "";
    child.stdout.on("data", value => { output += value; });
    child.stderr.on("data", value => { errors += value; });
    child.once("message", ready);
    ended = new Promise(resolve => child.once("close", code => resolve({ code, output, errors })));
    assert.deepEqual(await ended, { code: 0, output: "complete", errors: "" });
    f.events.push("child-complete");
  };
  const recovering = f.recover();
  try {
    await Promise.race([reached, recovering.then(() => assert.fail("recovery completed before the refresh barrier"))]);
    assert.ok(readFileSync(f.paths.displaced, "utf8") === next);
    assert.equal(existsSync(f.journalPath), true);
    assert.equal(f.events.includes("retire"), false);
    child.send("finish");
    await recovering;
    assert.ok(f.events.indexOf("child-complete") < f.events.indexOf("verify-stale"));
    assert.ok(f.events.indexOf("verify-stale") < f.events.indexOf("retire"));
  } finally {
    if (child?.exitCode === null && child.connected) child.send("finish");
    await ended;
    await recovering;
  }
});

for (const fault of ["unprotected", "symlink", "read-denied"]) {
test(`recovery refuses a ${fault} prior before stopping service`, windows, async t => {
  const f = recoveryFixture(t, { running: true });
  try {
    if (fault === "unprotected") {
      rmSync(f.paths.backup);
      writeFileSync(f.paths.backup, prior);
    } else if (fault === "symlink") {
      // Windows symlink creation needs a host privilege. Exercise the lstat
      // result directly while retaining the real protected backing fixture.
      const lstat = fs.lstatSync;
      t.mock.method(fs, "lstatSync", (target, ...args) => target === f.paths.backup
        ? { isFile: () => true, isSymbolicLink: () => true }
        : lstat(target, ...args));
      syncBuiltinESMExports();
    } else {
      const script = "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[IO.File]::GetAccessControl($env:FIXTURE_FILE);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadData,[Security.AccessControl.AccessControlType]::Deny));[IO.File]::SetAccessControl($env:FIXTURE_FILE,$acl)";
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        windowsHide: true, timeout: 15_000, env: { ...process.env, FIXTURE_FILE: f.paths.backup },
      });
    }
    await assert.rejects(f.recover());
    assert.deepEqual(f.events, []);
    assert.equal(existsSync(f.journalPath), true);
    assert.equal(existsSync(f.secretPath), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (fault === "read-denied") protectPrivateFile(f.paths.backup);
  }
});
}
