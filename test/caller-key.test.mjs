import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runCallerKeyRotation, runNodeCommand } from "../src/caller-key.mjs";
import { restoreCallerCapability, swapCallerCapability, discardCallerCapabilityBackup } from "../src/caller-key-rotation.mjs";
import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, "generated");

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

test("rotation child wait keeps the service lock live beyond its stale horizon", { timeout: 30_000 }, async () => {
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
await withServiceOperationLock(()=>runNodeCommand(${JSON.stringify(f.relative)}),{stateDir:${JSON.stringify(f.dir)},staleMs:5000,waitMs:0});
process.stdout.write('released');
`], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    ended = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { errors += data; });
    const readyDeadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < readyDeadline && child.exitCode === null) await delay(20);
    assert.ok(existsSync(ready), `fixture child did not reach the command: ${errors}`);
    const initialMtime = statSync(lock).mtimeMs;
    await delay(6_000); // A real wait longer than proper-lockfile's 5s minimum stale horizon.
    assert.equal(child.exitCode, null, "the command must still be running at contention");
    assert.ok(statSync(lock).mtimeMs > initialMtime, "heartbeat must advance while awaiting the child");
    let entered = false;
    await assert.rejects(withServiceOperationLock(() => { entered = true; }, { stateDir: f.dir, staleMs: 5000, waitMs: 0 }), /still running/u);
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
      restoreCallerCapability({ secretPath, operationId: "a".repeat(32), protect() {} });
    };
    await assert.rejects(runCallerKeyRotation(options), /synthetic refresh failure/u);
    assert.equal(recoveryCalls, 1);
    assert.equal(readFileSync(options.secretPath, "utf8").trim(), "s".repeat(64));
  } finally { f.cleanup(); }
});
