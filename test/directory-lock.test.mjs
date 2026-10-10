import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";
import { withCatalogPublicationLock } from "../src/catalog-publication-lock.mjs";
import { withModelOverlayLock } from "../src/model-overlay-lock.mjs";
import { withCallerKeyRotationLock } from "../src/caller-key-rotation-lock.mjs";
import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

const wrappers = [
  [withCatalogPublicationLock,"catalog-publication","catalog_publication_locked","catalogLockReleaseError",120_000,250,600_000],
  [withModelOverlayLock,"model-overlay-transaction","model_overlay_locked","modelOverlayLockReleaseError",120_000,250,600_000],
  [withCallerKeyRotationLock,"caller-key-rotation","caller_key_rotation_locked","callerKeyRotationLockReleaseError",15_000,100,600_000],
  [withServiceOperationLock,"service-operation",undefined,"serviceLockReleaseError",15_000,100,90_000],
];

test("each public lock wrapper serializes its target and releases after operation failure", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(),"router-locks-"));
  try {
    for (const [withLock,,code] of wrappers) {
      let unlock, entered;
      const acquired = new Promise(resolve => { entered = resolve; });
      const held = withLock(async () => { entered(); await new Promise(resolve => { unlock = resolve; }); }, {stateDir});
      await acquired;
      await assert.rejects(withLock(() => assert.fail("contending operation ran"),{stateDir,waitMs:0}), error => error.code === code && /still running/u.test(error.message));
      unlock(); await held;
      const failure = new Error("operation failed"); failure.catalogRollbackSafe = true;
      await assert.rejects(withLock(() => { throw failure; },{stateDir}), error => error === failure);
      assert.equal(await withLock(() => "reacquired",{stateDir}),"reacquired");
    }
  } finally { rmSync(stateDir,{recursive:true,force:true}); }
});

test("late heartbeat stat cannot compromise a released lease or touch its successor", { timeout: 8000 }, async t => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-late-heartbeat-"));
  const originalLock = lockfile.lock, originalStat = fs.stat;
  const compromised = [];
  t.mock.method(lockfile, "lock", (target, options) => originalLock(target, { ...options, onCompromised: error => compromised.push(error.code) }));
  try {
    for (const missing of [true, false]) {
      let armed = false, releaseOperation, arrived, late;
      // The production heartbeat is unref'ed. Keep this isolated test alive
      // while awaiting it, and fail explicitly if the callback never arrives.
      const heartbeat = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Lock heartbeat did not arrive.")), 4000);
        arrived = () => { clearTimeout(deadline); resolve(); };
      });
      const held = new Promise(resolve => { releaseOperation = resolve; });
      const statMock = t.mock.method(fs, "stat", (...args) => {
        if (!armed || args[0] !== path.join(stateDir, "catalog-publication.lock")) return originalStat(...args);
        const callback = args.pop();
        return originalStat(...args, (...result) => {
          late = (gone = false) => callback(...(gone
            ? [Object.assign(new Error("released directory"), { code: "ENOENT" })] : result));
          arrived();
        });
      });
      const first = withCatalogPublicationLock(async () => { armed = true; await held; }, { stateDir, heartbeatMs: 1000, staleMs: 5000 });
      await heartbeat;
      armed = false;
      releaseOperation(); await first;
      if (missing) {
        // An already dispatched stat can complete after rmdir with ENOENT.
        late(true);
      } else {
        await withCatalogPublicationLock(async () => {
          const target = path.join(stateDir, "catalog-publication.lock");
          const before = fs.statSync(target).mtimeMs;
          late();
          await new Promise(resolve => setTimeout(resolve, 25));
          assert.equal(fs.statSync(target).mtimeMs, before);
        }, { stateDir });
      }
      statMock.mock.restore();
    }
    assert.deepEqual(compromised, []);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("lock wrappers retain budgets and operation error identity when release also fails", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(),"router-lock-release-"));
  const original = lockfile.lock, releaseFailure = new Error("release failed");
  try {
    for (const [withLock,name,,annotation,wait,retry,stale] of wrappers) {
      let observed;
      lockfile.lock = async (target,options) => {
        observed = {target,options};
        return async () => { throw releaseFailure; };
      };
      const failure = new Error("original failure"); failure.catalogRollbackSafe = true;
      await assert.rejects(withLock(() => { throw failure; },{stateDir}), error => error === failure);
      assert.equal(failure[annotation],releaseFailure);
      assert.equal(failure.catalogRollbackSafe,true);
      assert.equal(observed.target,path.join(stateDir,name));
      const { fs: heartbeatFs, ...lockOptions } = observed.options;
      assert.equal(typeof heartbeatFs.stat, "function");
      assert.deepEqual(lockOptions,{
        realpath:false,lockfilePath:`${path.join(stateDir,name)}.lock`,stale,update:10_000,
        retries:{retries:Math.ceil(wait/retry)-1,factor:1,minTimeout:retry,maxTimeout:retry,randomize:false},
      });
      const frozen = Object.freeze(new Error("frozen original"));
      await assert.rejects(withLock(() => { throw frozen; },{stateDir}),error => error === frozen);
      await assert.rejects(withLock(() => "completed",{stateDir}),error => error.cause === releaseFailure);
      let caught = "not thrown";
      try { await withLock(() => {throw undefined;},{stateDir}); } catch(error) {caught=error;}
      assert.equal(caught,undefined);
    }
  } finally { lockfile.lock = original; rmSync(stateDir,{recursive:true,force:true}); }
});
