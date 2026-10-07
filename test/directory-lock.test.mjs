import assert from "node:assert/strict";
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
      assert.deepEqual(observed.options,{
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
