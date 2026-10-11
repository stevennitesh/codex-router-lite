import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { withAtomicStateLock } from "../src/atomic-state-lock.mjs";

const deadPid = 99999999;
const moduleUrl = pathToFileURL(path.resolve("src/atomic-state-lock.mjs")).href;
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-state-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, target: path.join(root, "ownership.json"), lock: path.join(root, "ownership.json.lock") };
}

test("state locks exclude live owners, release on failure and recover old incomplete locks", t => {
  const f = fixture(t);
  const primary = Object.freeze(new Error("operation failed"));
  assert.throws(() => withAtomicStateLock(f.target, () => {
    assert.throws(() => withAtomicStateLock(f.target, () => assert.fail("overlap"), { waitMs: 0 }), /Timed out waiting/);
    throw primary;
  }), error => error === primary);
  assert.equal(existsSync(f.lock), false);
  for (const kind of ["empty", "partial", "dead"]) {
    mkdirSync(f.lock);
    if (kind !== "empty") writeFileSync(path.join(f.lock, "owner"), kind === "partial" ? "" : `${deadPid}\n`);
    const old = new Date(0); utimesSync(f.lock, old, old);
    withAtomicStateLock(f.target, () => assert.equal(readdirSync(f.lock).length, 1));
    assert.equal(existsSync(f.lock), false);
  }
});

test("a release cannot remove a replacement generation or follow a lock symlink", t => {
  const f = fixture(t);
  const replacement = `owner-${process.pid}-${randomUUID()}`;
  withAtomicStateLock(f.target, () => {
    for (const name of readdirSync(f.lock)) unlinkSync(path.join(f.lock, name));
    rmdirSync(f.lock);
    mkdirSync(f.lock);
    writeFileSync(path.join(f.lock, replacement), `${process.pid}\n`);
  });
  assert.deepEqual(readdirSync(f.lock), [replacement]);
  rmSync(f.lock, { recursive: true });
  const canary = path.join(f.root, "canary"); mkdirSync(canary);
  writeFileSync(path.join(canary, "private.txt"), "unchanged");
  symlinkSync(canary, f.lock, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => withAtomicStateLock(f.target, () => assert.fail("symlink accepted")), /symbolic-link/);
  assert.equal(existsSync(path.join(canary, "private.txt")), true);
});

test("an unknown PID probe failure cannot authorize lock recovery", t => {
  const f = fixture(t); mkdirSync(f.lock);
  writeFileSync(path.join(f.lock, "owner"), `${process.pid}\n`);
  const old = new Date(0); utimesSync(f.lock, old, old);
  const original = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error("probe unavailable"), { code: "EIO" }); };
    assert.throws(() => withAtomicStateLock(f.target, () => assert.fail("unknown owner replaced"), { waitMs: 0 }), /Timed out waiting/);
    assert.equal(existsSync(path.join(f.lock, "owner")), true);
  } finally { process.kill = original; }
});

const worker = `
 import assert from 'node:assert/strict';
 import {existsSync,writeFileSync,readdirSync} from 'node:fs';
 import path from 'node:path';
 const {withAtomicStateLock}=await import(process.env.LOCK_MODULE);
 const role=process.env.LOCK_ROLE, root=process.env.LOCK_ROOT;
 const file=name=>path.join(root,name);
 const wait=name=>{const end=Date.now()+8000;while(!existsSync(file(name))){if(Date.now()>end)throw new Error('Barrier timed out: '+name);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}};
 const original=process.kill;
 process.kill=(pid,signal)=>{
  if(pid===${deadPid}&&signal===0){writeFileSync(file(role+'-observed'),'');wait('a-observed');wait('b-observed');if(role==='b')wait('a-entered');}
  else if(role==='b'&&signal===0){writeFileSync(file('b-saw-live-owner'),'');}
  return original(pid,signal);
 };
 withAtomicStateLock(file('ownership.json'),()=>{
  if(role==='a'){
   writeFileSync(file('a-entered'),'');wait('b-saw-live-owner');
   assert.equal(readdirSync(file('ownership.json.lock')).length,1);
   writeFileSync(file('a-finished'),'');
  }else assert.ok(existsSync(file('a-finished')),'overlapping operations');
 },{waitMs:5000});
 console.log(JSON.stringify({role,serialized:true}));
`;
function runWorker(t, root, role) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker], {
      env: { ...process.env, LOCK_MODULE: moduleUrl, LOCK_ROOT: root, LOCK_ROLE: role },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = "", errors = "";
    child.stdout.on("data", data => output += data);
    child.stderr.on("data", data => errors += data);
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}

test("two real recoverers cannot delete a replacement lock or overlap writes", { timeout: 15000 }, async t => {
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  for (const legacy of [true, false]) {
    const f = fixture(t); mkdirSync(f.lock);
    const name = legacy ? "owner" : `owner-${deadPid}-${randomUUID()}`;
    writeFileSync(path.join(f.lock, name), `${deadPid}\n`);
    const results = await Promise.all([runWorker(t, f.root, "a"), runWorker(t, f.root, "b")]);
    assert.ok(results.every(result => result.serialized));
    assert.equal(existsSync(f.lock), false);
    assert.equal(readdirSync(f.root).some(entry => entry.includes(".prepare-")), false);
  }
});
