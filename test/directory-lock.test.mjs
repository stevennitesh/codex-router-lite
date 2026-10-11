import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { withCatalogPublicationLock } from "../src/catalog-publication-lock.mjs";
import { withModelOverlayLock } from "../src/model-overlay-lock.mjs";
import { withCallerKeyRotationLock } from "../src/caller-key-rotation-lock.mjs";
import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

const wrappers = [
  [withCatalogPublicationLock, "catalog-publication", "catalog_publication_locked", "catalogLockReleaseError", "catalog-publication-lock.mjs"],
  [withModelOverlayLock, "model-overlay-transaction", "model_overlay_locked", "modelOverlayLockReleaseError", "model-overlay-lock.mjs"],
  [withCallerKeyRotationLock, "caller-key-rotation", "caller_key_rotation_locked", "callerKeyRotationLockReleaseError", "caller-key-rotation-lock.mjs"],
  [withServiceOperationLock, "service-operation", undefined, "serviceLockReleaseError", "service-operation-lock.mjs"],
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadPid = 99999999;
function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-locks-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}
function generation(stateDir, name, pid = deadPid) {
  const directory = path.join(stateDir, `${name}.lock`);
  fs.mkdirSync(directory);
  const owner = `owner-${pid}-${randomUUID()}`;
  fs.writeFileSync(path.join(directory, owner), `${pid}\n`);
  return { directory, owner };
}

test("each wrapper holds its complete operation and preserves wait/retry/error contracts", async t => {
  const stateDir = fixture(t);
  for (const [withLock, name, code] of wrappers) {
    let unlock, entered;
    const acquired = new Promise(resolve => { entered = resolve; });
    const held = withLock(async () => { entered(); await new Promise(resolve => { unlock = resolve; }); }, { stateDir });
    await acquired;
    const owner = fs.readdirSync(path.join(stateDir, `${name}.lock`));
    assert.equal(owner.length, 1);
    assert.equal(fs.readFileSync(path.join(stateDir, `${name}.lock`, owner[0]), "utf8"), `${process.pid}\n`);
    const start = performance.now();
    try {
      await assert.rejects(withLock(() => assert.fail("contending operation ran"), { stateDir, waitMs: 40, retryMs: 5 }), error =>
        error.code === code && error.cause.code === "ELOCKED" && /still running/u.test(error.message));
      assert.ok(performance.now() - start >= 30, "wait override must not become immediate refusal");
    } finally { unlock(); await held; }
    const failure = new Error("operation failed"); failure.catalogRollbackSafe = true;
    await assert.rejects(withLock(() => { throw failure; }, { stateDir }), error => error === failure);
    assert.equal(await withLock(async () => "reacquired", { stateDir }), "reacquired");
    assert.equal(fs.existsSync(path.join(stateDir, `${name}.lock`)), false);
  }
  assert.equal(fs.readdirSync(stateDir).some(name => name.includes(".prepare-")), false);
});

test("publication contains its owner before the public directory exists", async t => {
  const stateDir = fixture(t), rename = fs.promises.rename;
  const destinations = [];
  t.mock.method(fs.promises, "rename", async (from, to) => {
    const names = fs.readdirSync(from);
    assert.equal(names.length, 1);
    assert.equal(fs.readFileSync(path.join(from, names[0]), "utf8"), `${process.pid}\n`);
    assert.equal(fs.existsSync(to), false);
    destinations.push(path.basename(to));
    return rename(from, to);
  });
  for (const [withLock] of wrappers) await withLock(() => {}, { stateDir });
  assert.deepEqual(destinations, wrappers.map(([, name]) => `${name}.lock`));
});

test("each wrapper preserves primary errors when actual owner release also fails", async t => {
  const stateDir = fixture(t), rmdir = fs.promises.rmdir;
  const releaseFailure = new Error("release failed");
  t.mock.method(fs.promises, "rmdir", pathname => {
    if (pathname.endsWith(".lock")) return Promise.reject(releaseFailure);
    return rmdir(pathname);
  });
  for (const [withLock, name, , annotation] of wrappers) {
    const directory = path.join(stateDir, `${name}.lock`);
    const failure = new Error("original failure"); failure.catalogRollbackSafe = true;
    await assert.rejects(withLock(() => { throw failure; }, { stateDir }), error => error === failure);
    assert.equal(failure[annotation], releaseFailure);
    assert.equal(failure.catalogRollbackSafe, true);
    fs.rmdirSync(directory);
    const frozen = Object.freeze(new Error("frozen original"));
    await assert.rejects(withLock(() => { throw frozen; }, { stateDir }), error => error === frozen);
    fs.rmdirSync(directory);
    await assert.rejects(withLock(() => "completed", { stateDir }), error => error.cause === releaseFailure);
    fs.rmdirSync(directory);
    for (const value of [undefined, null, false, 0]) {
      let caught = "not thrown";
      try { await withLock(() => { throw value; }, { stateDir }); } catch (error) { caught = error; }
      assert.equal(caught, value);
      fs.rmdirSync(directory);
    }
  }
});

test("heartbeat release waits for the dispatched effect before admitting its successor", { timeout: 8000 }, async t => {
  const stateDir = fixture(t), utimes = fs.promises.utimes;
  let dispatch, finishEffect, endOperation;
  const dispatched = new Promise(resolve => { dispatch = resolve; });
  t.mock.method(fs.promises, "utimes", (...args) => new Promise((resolve, reject) => {
    finishEffect = () => utimes(...args).then(resolve, reject);
    dispatch(args[0]);
  }));
  let completed = false;
  const first = withCatalogPublicationLock(() => new Promise(resolve => { endOperation = resolve; }), { stateDir, heartbeatMs: 1000 }).then(() => { completed = true; });
  const owner = await dispatched;
  assert.match(path.basename(owner), new RegExp(`^owner-${process.pid}-`));
  endOperation();
  await delay(25);
  assert.equal(completed, false, "release must still own the pending heartbeat");
  await assert.rejects(withCatalogPublicationLock(() => assert.fail("pending release overlapped"), { stateDir, waitMs: 0 }), /still running/u);
  finishEffect(); await first;
  await withCatalogPublicationLock(() => assert.equal(fs.readdirSync(path.dirname(owner)).includes(path.basename(owner)), false), { stateDir });
});

test("an old dispatched heartbeat and release cannot touch a replacement generation", { timeout: 8000 }, async t => {
  const stateDir = fixture(t), utimes = fs.promises.utimes;
  let dispatch, finishEffect, endFirst, endSecond, secondEntered;
  const dispatched = new Promise(resolve => { dispatch = resolve; });
  const mock = t.mock.method(fs.promises, "utimes", (...args) => new Promise((resolve, reject) => {
    finishEffect = () => utimes(...args).then(resolve, reject); dispatch(args[0]);
  }));
  const first = withCatalogPublicationLock(() => new Promise(resolve => { endFirst = resolve; }), { stateDir, heartbeatMs: 1000 });
  const firstOutcome = assert.rejects(first, error => error.cause?.code === "ENOENT");
  const oldOwner = await dispatched, directory = path.dirname(oldOwner);
  fs.renameSync(directory, path.join(stateDir, "detached-old-generation"));
  mock.mock.restore();
  const entered = new Promise(resolve => { secondEntered = resolve; });
  const second = withCatalogPublicationLock(async () => { secondEntered(); await new Promise(resolve => { endSecond = resolve; }); }, { stateDir });
  await entered;
  const successor = fs.readdirSync(directory)[0];
  const before = fs.statSync(path.join(directory, successor)).mtimeMs;
  endFirst(); finishEffect(); await firstOutcome;
  assert.deepEqual(fs.readdirSync(directory), [successor]);
  assert.equal(fs.statSync(path.join(directory, successor)).mtimeMs, before);
  endSecond(); await second;
});

test("unknown, live/reused, malformed and legacy owners never expire into absence", async t => {
  const stateDir = fixture(t);
  for (const [withLock, name] of wrappers) {
    for (const kind of ["live", "unknown", "empty", "malformed"]) {
      const { directory, owner } = generation(stateDir, name, process.pid);
      if (kind === "empty") fs.unlinkSync(path.join(directory, owner));
      if (kind === "malformed") fs.writeFileSync(path.join(directory, owner), `${deadPid}\n`);
      fs.utimesSync(directory, new Date(0), new Date(0));
      if (kind !== "empty") fs.utimesSync(path.join(directory, owner), new Date(0), new Date(0));
      const mock = kind === "unknown" ? t.mock.method(process, "kill", () => { throw Object.assign(new Error("probe denied"), { code: "EPERM" }); }) : undefined;
      try {
        await assert.rejects(withLock(() => assert.fail(`${kind} owner stolen`), { stateDir, waitMs: 0 }), /still running/u);
        assert.equal(fs.existsSync(directory), true);
      } finally { mock?.mock.restore(); fs.rmSync(directory, { recursive: true }); }
    }
  }
  const canary = path.join(stateDir, "canary"); fs.mkdirSync(canary); fs.writeFileSync(path.join(canary, "keep"), "unchanged");
  fs.symlinkSync(canary, path.join(stateDir, "service-operation.lock"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(withServiceOperationLock(() => assert.fail("symlink used"), { stateDir, waitMs: 0 }), /symbolic-link/u);
  assert.equal(fs.readFileSync(path.join(canary, "keep"), "utf8"), "unchanged");
});

test("permission-shaped owner reads wait for the live owner to release across all wrappers", { timeout: 8000 }, async t => {
  const stateDir = fixture(t), readFile = fs.promises.readFile;
  for (const [withLock, name] of wrappers) {
    for (const code of ["EPERM", "EACCES"]) {
      let entered, unlock, observed;
      const held = new Promise(resolve => { entered = resolve; });
      const readLiveOwner = new Promise(resolve => { observed = resolve; });
      const first = withLock(async () => { entered(); await new Promise(resolve => { unlock = resolve; }); }, { stateDir });
      await held;
      const directory = path.join(stateDir, `${name}.lock`);
      const owner = fs.readdirSync(directory)[0], ownerPath = path.join(directory, owner);
      let attempts = 0, secondEntered = false;
      const mock = t.mock.method(fs.promises, "readFile", async (pathname, ...args) => {
        if (pathname === ownerPath) {
          attempts++;
          if (attempts <= 2) throw Object.assign(new Error("owner inspection temporarily denied"), { code });
          const value = await readFile(pathname, ...args);
          observed();
          return value;
        }
        return readFile(pathname, ...args);
      });
      const second = withLock(() => { secondEntered = true; return "serialized"; }, { stateDir, waitMs: 1000, retryMs: 5 });
      // Observe rejection immediately so the predecessor also leaves the real
      // held owner cleanly rather than becoming an unhandled rejected promise.
      const outcome = second.then(value => ({ value }), error => ({ error }));
      try {
        const progress = await Promise.race([readLiveOwner.then(() => "reobserved"), outcome]);
        assert.equal(progress, "reobserved", "temporary owner inspection failure must be retried");
        assert.ok(attempts >= 3);
        assert.equal(secondEntered, false, "uncertain inspection must not steal the live generation");
        assert.deepEqual(fs.readdirSync(directory), [owner]);
        assert.equal(fs.readFileSync(ownerPath, "utf8"), `${process.pid}\n`);
      } finally {
        unlock(); await first; mock.mock.restore();
      }
      const result = await outcome;
      if (result.error) throw result.error;
      assert.equal(result.value, "serialized");
      assert.equal(secondEntered, true);
      assert.equal(fs.existsSync(directory), false);
    }
  }
});

test("persistent inaccessible owners exhaust the existing wait budget without removal", { timeout: 8000 }, async t => {
  const stateDir = fixture(t), readFile = fs.promises.readFile;
  for (const [withLock, name, lockCode] of wrappers) {
    for (const code of ["EPERM", "EACCES"]) {
      const { directory, owner } = generation(stateDir, name, process.pid);
      const ownerPath = path.join(directory, owner);
      let attempts = 0;
      const mock = t.mock.method(fs.promises, "readFile", (pathname, ...args) => {
        if (pathname !== ownerPath) return readFile(pathname, ...args);
        attempts++;
        return Promise.reject(Object.assign(new Error("owner inspection denied"), { code }));
      });
      const start = performance.now();
      try {
        await assert.rejects(withLock(() => assert.fail("inaccessible owner stolen"), { stateDir, waitMs: 40, retryMs: 5 }), error =>
          error.code === lockCode && error.cause?.code === "ELOCKED" && /still running/u.test(error.message));
        const elapsed = performance.now() - start;
        assert.ok(elapsed >= 30, "inspection uncertainty must retain the wait budget");
        assert.ok(elapsed < 1000, "persistent uncertainty must remain bounded");
        // Native I/O or scheduling may exhaust the elapsed budget after the
        // first inspection. The transient-owner test proves actual retries.
        assert.ok(attempts >= 1, "inaccessible owner must be inspected");
        assert.deepEqual(fs.readdirSync(directory), [owner]);
        assert.equal(fs.readFileSync(ownerPath, "utf8"), `${process.pid}\n`);
        assert.equal(fs.readdirSync(stateDir).some(entry => entry.includes(".prepare-")), false);
      } finally { mock.mock.restore(); fs.rmSync(directory, { recursive: true }); }
    }
  }
});

test("unexpected owner inspection errors remain failures with their original identity", async t => {
  const stateDir = fixture(t), readFile = fs.promises.readFile;
  const { directory, owner } = generation(stateDir, "catalog-publication", process.pid);
  const ownerPath = path.join(directory, owner);
  const failure = Object.assign(new Error("owner read I/O failure"), { code: "EIO" });
  t.mock.method(fs.promises, "readFile", (pathname, ...args) =>
    pathname === ownerPath ? Promise.reject(failure) : readFile(pathname, ...args));
  await assert.rejects(withCatalogPublicationLock(() => assert.fail("uninspected owner stolen"), { stateDir, waitMs: 1000 }), error => error === failure);
  assert.deepEqual(fs.readdirSync(directory), [owner]);
  assert.equal(fs.readFileSync(ownerPath, "utf8"), `${process.pid}\n`);
  assert.equal(fs.readdirSync(stateDir).some(entry => entry.includes(".prepare-")), false);
});

const worker = `
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const module=await import(process.env.LOCK_MODULE), withLock=module[process.env.LOCK_EXPORT];
const root=process.env.LOCK_ROOT, role=process.env.LOCK_ROLE;
const file=name=>path.join(root,name);
const wait=name=>{const end=Date.now()+8000;while(!fs.existsSync(file(name))){if(Date.now()>end)throw new Error('Barrier timed out: '+name);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}};
const original=process.kill;
process.kill=(pid,signal)=>{
 if(pid===${deadPid}&&signal===0){fs.writeFileSync(file(role+'-observed'),'');wait('a-observed');wait('b-observed');if(role==='b')wait('a-entered');}
 else if(role==='b'&&signal===0)fs.writeFileSync(file('b-saw-live-owner'),'');
 return original(pid,signal);
};
await withLock(async()=>{
 if(role==='a'){
  const directory=file(process.env.LOCK_NAME+'.lock'),owner=fs.readdirSync(directory)[0];
  fs.utimesSync(path.join(directory,owner),new Date(0),new Date(0));
  fs.utimesSync(directory,new Date(0),new Date(0));
  fs.writeFileSync(file('a-entered'),'');wait('b-saw-live-owner');
  fs.writeFileSync(file('a-finished'),'');
 }else assert.ok(fs.existsSync(file('a-finished')),'overlapping operations');
},{stateDir:root,waitMs:5000,retryMs:10});
console.log(JSON.stringify({role,serialized:true}));
`;
function runWorker(t, stateDir, role, withLock, module, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker], {
      env: { ...process.env, LOCK_MODULE: pathToFileURL(path.resolve("src", module)).href,
        LOCK_EXPORT: withLock.name, LOCK_ROOT: stateDir, LOCK_ROLE: role, LOCK_NAME: name },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = "", errors = "";
    child.stdout.on("data", data => output += data); child.stderr.on("data", data => errors += data);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}

test("two real dead-owner recoverers cannot delete a fresh generation across all four wrappers", { timeout: 40000 }, async t => {
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  for (const [withLock, name, , , module] of wrappers) {
    const stateDir = fixture(t); generation(stateDir, name);
    const results = await Promise.all([runWorker(t, stateDir, "a", withLock, module, name), runWorker(t, stateDir, "b", withLock, module, name)]);
    assert.ok(results.every(result => result.serialized));
    assert.equal(fs.existsSync(path.join(stateDir, `${name}.lock`)), false);
    assert.equal(fs.readdirSync(stateDir).some(entry => entry.includes(".prepare-")), false);
  }
});
