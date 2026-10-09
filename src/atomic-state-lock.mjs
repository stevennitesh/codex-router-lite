import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const WAIT_MS = 25;
const MAX_WAIT_MS = 2_000;
const STALE_MS = 30_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockPath(target) {
  return `${target}.lock`;
}

function staleLock(pathname) {
  try {
    const stat = lstatSync(pathname);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return Date.now() - stat.mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function lockOwner(pathname) {
  try {
    const entries = readdirSync(pathname);
    if (entries.length !== 1) return { empty: entries.length === 0 };
    const name = entries[0];
    const generation = /^owner-([1-9][0-9]*)-[0-9a-f-]{36}$/u.exec(name);
    if (name !== "owner" && !generation) return {};
    const owner = path.join(pathname, name);
    const stat = lstatSync(owner);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64) {
      return { name };
    }
    const value = readFileSync(owner, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(value) || (generation && generation[1] !== value)) return { name };
    const pid = Number(value);
    return { name, pid: Number.isSafeInteger(pid) ? pid : undefined };
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access/probe failures do not prove that an owner exited.
    return error?.code !== "ESRCH";
  }
}

function removeEmptyLock(pathname) {
  try { rmdirSync(pathname); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  }
}

function removeOwner(pathname, name) {
  try { unlinkSync(path.join(pathname, name)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  // Never recursively remove the shared path: another generation may have
  // replaced it since this owner was observed. Its unique file keeps it nonempty.
  removeEmptyLock(pathname);
}

function recoverLock(pathname, owner) {
  if (owner.pid ? !processIsAlive(owner.pid) : owner.name === "owner" && staleLock(pathname)) {
    removeOwner(pathname, owner.name);
    return true;
  }
  // Older versions could crash between mkdir and writing their owner file.
  if (owner.empty && staleLock(pathname)) {
    removeEmptyLock(pathname);
    return true;
  }
  return false;
}

function acquire(target, { waitMs = MAX_WAIT_MS } = {}) {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new TypeError("State lock wait must be a non-negative number of milliseconds.");
  }
  const pathname = lockPath(target);
  mkdirSync(path.dirname(pathname), { recursive: true });
  const name = `owner-${process.pid}-${randomUUID()}`;
  const prepared = mkdtempSync(`${pathname}.prepare-`);
  const started = Date.now();
  try {
    writeFileSync(path.join(prepared, name), `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    while (true) {
      try {
        // Publish a complete, nonempty generation. No contender can mistake a
        // partially initialized new directory for an abandoned old lock.
        renameSync(prepared, pathname);
        return () => removeOwner(pathname, name);
      } catch (error) {
        let stat;
        try { stat = lstatSync(pathname); }
        catch (cause) {
          if (cause?.code === "ENOENT" && ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code)) continue;
          throw error;
        }
        if (stat.isSymbolicLink()) throw new Error(`Refusing to use a symbolic-link state lock: ${pathname}`);
        if (!stat.isDirectory()) throw error;
      }
      const owner = lockOwner(pathname);
      if (recoverLock(pathname, owner)) continue;
      if (Date.now() - started >= waitMs) {
        throw new Error(`Timed out waiting for state lock${owner.pid ? ` held by ${owner.pid}` : ""}: ${pathname}`);
      }
      sleep(WAIT_MS);
    }
  } finally {
    // Only this invocation's private preparation path may be removed recursively.
    rmSync(prepared, { recursive: true, force: true });
  }
}

export function withAtomicStateLock(target, operation, options) {
  if (typeof operation !== "function") throw new TypeError("State lock operation must be a function.");
  const release = acquire(target, options);
  let failed = false;
  try {
    return operation();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { release(); }
    catch (error) { if (!failed) throw error; }
  }
}
