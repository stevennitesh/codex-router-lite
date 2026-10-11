import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

function integer(value, fallback, minimum) {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

async function ownerAt(pathname) {
  try {
    const entries = await fs.promises.readdir(pathname);
    if (entries.length !== 1) return {};
    const name = entries[0];
    const generation = /^owner-([1-9][0-9]*)-[0-9a-f-]{36}$/u.exec(name);
    if (!generation) return {};
    const owner = path.join(pathname, name);
    const stat = await fs.promises.lstat(owner);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64) return {};
    const value = (await fs.promises.readFile(owner, "utf8")).trim();
    if (value !== generation[1]) return {};
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? { name, pid } : {};
  } catch (error) {
    // Windows can deny opening an owner while its generation is being
    // released. Uncertain inspection keeps it held within acquisition's wait
    // budget; neither access denial nor absence proves the process exited.
    if (["ENOENT", "EPERM", "EACCES"].includes(error?.code)) return {};
    throw error;
  }
}

function ownerExited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    // A live/reused PID and failed access/probe remain held. Heartbeat age is
    // never authority to steal from an operation that can still resume.
    return error?.code === "ESRCH";
  }
}

async function removeOwner(pathname, name) {
  try { await fs.promises.unlink(path.join(pathname, name)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  // A stale observer can remove only its observed unique file. A complete
  // successor stays nonempty, so this cannot remove its directory.
  try { await fs.promises.rmdir(pathname); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  }
}

function heartbeatFor(pathname, name, interval) {
  const owner = path.join(pathname, name);
  let timer, pending, stopped = false, failure, failed = false;
  const schedule = () => {
    timer = setTimeout(() => {
      const now = new Date();
      pending = Promise.resolve().then(() => fs.promises.utimes(owner, now, now)).catch(error => { failure = error; failed = true; }).finally(() => {
        if (!stopped && !failed) schedule();
      });
    }, interval);
    timer.unref();
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    // Draining the dispatched filesystem effect precedes owner removal and
    // release completion. The pathname also names only this generation.
    await pending;
    await removeOwner(pathname, name);
    if (failed) throw failure;
  };
}

async function acquire(target, wait, retry, heartbeat) {
  const pathname = `${target}.lock`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const prepared = await fs.promises.mkdtemp(`${pathname}.prepare-`);
  const name = `owner-${process.pid}-${randomUUID()}`;
  const deadline = performance.now() + wait;
  let published = false;
  try {
    await fs.promises.writeFile(path.join(prepared, name), `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    while (true) {
      let stat;
      try { stat = await fs.promises.lstat(pathname); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (!stat) {
        try {
          // Claim only a fully initialized nonempty generation. Unlike an empty
          // mkdir followed by a write, it has no recoverable initialization gap.
          await fs.promises.rename(prepared, pathname);
          published = true;
          return heartbeatFor(pathname, name, heartbeat);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code)) throw error;
          try { stat = await fs.promises.lstat(pathname); }
          catch (cause) {
            if (cause?.code !== "ENOENT") throw cause;
            if (performance.now() >= deadline) throw error;
            continue;
          }
        }
      }
      if (stat.isSymbolicLink()) throw new Error(`Refusing to use a symbolic-link directory lock: ${pathname}`);
      if (!stat.isDirectory()) throw new Error(`Refusing to use a non-directory lock: ${pathname}`);
      const owner = await ownerAt(pathname);
      if (owner.pid && ownerExited(owner.pid)) {
        await removeOwner(pathname, owner.name);
        continue;
      }
      // Empty proper-lockfile directories and unknown owner shapes do not
      // identify a dead process. They require quiescent legacy cleanup.
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw Object.assign(new Error(`Directory lock is held${owner.pid ? ` by process ${owner.pid}` : " by an unverified or legacy owner"}: ${pathname}`), { code: "ELOCKED" });
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(retry, remaining)));
    }
  } finally {
    // Recursive removal is confined to this invocation's private preparation.
    if (!published) await fs.promises.rm(prepared, { recursive: true, force: true });
  }
}

// Wrappers own target, wait/retry/heartbeat budgets and user-facing errors.
// This owner keeps acquisition, generation-local heartbeat and release custody.
export async function withDirectoryLock(operation, {
  target, waitMs, retryMs, heartbeatMs, defaults,
  lockedError, releaseErrorKey, releaseErrorMessage,
}) {
  if (typeof operation !== "function") throw new TypeError("Directory lock operation must be a function.");
  const wait = integer(waitMs, defaults.waitMs, 0);
  const retry = integer(retryMs, defaults.retryMs, 1);
  const heartbeat = integer(heartbeatMs, defaults.heartbeatMs, 1_000);
  let release;
  try { release = await acquire(target, wait, retry, heartbeat); }
  catch (error) { if (error?.code === "ELOCKED") throw lockedError(wait, error); throw error; }
  let result, operationError, operationFailed = false;
  try { result = await operation(); }
  catch (error) { operationFailed = true; operationError = error; }
  let releaseError, releaseFailed = false;
  try {
    await release();
  }
  catch (error) { releaseFailed = true; releaseError = error; }
  // Preserve even falsy thrown values and frozen errors. In particular,
  // catalogRollbackSafe must reach the catalog CLI on its original object.
  if (operationFailed) {
    if (releaseFailed && operationError && typeof operationError === "object") {
      try { operationError[releaseErrorKey] = releaseError; } catch {}
    }
    throw operationError;
  }
  if (releaseFailed) throw new Error(releaseErrorMessage(releaseError), { cause: releaseError });
  return result;
}
