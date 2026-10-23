import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

import { CODEX_HOME } from "./paths.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const INITIAL_TAIL_BYTES = 512 * 1024;
const READ_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_CATCHUP_BYTES = 8 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 5_000;

function unavailable(reason) {
  return Object.assign(new Error("The exact native Web turn cancellation could not be monitored."), {
    code: "WEB_TURN_CANCELLATION_UNAVAILABLE", reason,
  });
}

// Discovery reads names only. Never scan another conversation's contents or
// accept a rollout path from the Responses caller.
async function findRollout(codexHome, threadId) {
  let home;
  try { home = await realpath(codexHome); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const sessions = path.join(home, "sessions");
  let root;
  try { root = await lstat(sessions); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!root.isDirectory() || root.isSymbolicLink()) throw unavailable("rollout_path");
  let entries = 0;
  const matches = [];
  const patterns = [/^\d{4}$/u, /^(?:0[1-9]|1[0-2])$/u, /^(?:0[1-9]|[12]\d|3[01])$/u];
  const rolloutName = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${threadId}\\.jsonl$`, "u");
  async function visit(directory, depth) {
    for await (const entry of await opendir(directory)) {
      if (++entries > 50_000) throw unavailable("rollout_lookup_limit");
      const target = path.join(directory, entry.name);
      if (depth < 3) {
        if (entry.isDirectory() && patterns[depth].test(entry.name)) await visit(target, depth + 1);
      } else if (entry.isFile() && rolloutName.test(entry.name)) matches.push(target);
    }
  }
  await visit(sessions, 0);
  if (matches.length > 1) throw unavailable("rollout_ambiguous");
  return matches[0] ?? null;
}

const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

/** Watch one active native rollout, independently of individual Responses rounds.
 * ready resolves after its bounded existing tail is checked. Loss of authority
 * reports onUnavailable and never manufactures a cancellation event. The owner
 * must close this watcher when its Web generation completes or is retired.
 */
export function watchWebTurnCancellation({
  threadId, turnId, codexHome = CODEX_HOME, onCancel, onUnavailable, pollMs = 200,
} = {}) {
  if (!UUID.test(threadId ?? "") || typeof turnId !== "string" || !/^[\w-]{1,128}$/u.test(turnId)
      || !path.isAbsolute(codexHome) || typeof onCancel !== "function"
      || onUnavailable !== undefined && typeof onUnavailable !== "function"
      || !Number.isInteger(pollMs) || pollMs < 10 || pollMs > 5_000) {
    throw new TypeError("Native cancellation monitoring requires an exact thread, turn and callback.");
  }
  let closed = false, state = "pending", timer, wake, filePath, generation, offset = 0;
  let pending = Buffer.alloc(0), discardInitialPartial = false;
  let resolveReady, rejectReady, readySettled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Owners can close before awaiting readiness without creating an unhandled rejection.
  void ready.catch(() => {});
  const delay = () => new Promise(resolve => {
    wake = resolve;
    timer = setTimeout(() => { timer = undefined; wake = undefined; resolve(); }, pollMs);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function consume(bytes) {
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (discardInitialPartial) { discardInitialPartial = false; continue; }
      if (line.length > MAX_LINE_BYTES) throw unavailable("rollout_line_limit");
      if (!line.length || line.length === 1 && line[0] === 13) continue;
      let row;
      try { row = JSON.parse(decoder.decode(line)); }
      catch { throw unavailable("rollout_invalid"); }
      if (row?.type === "event_msg" && row.payload?.type === "turn_aborted"
          && row.payload.turn_id === turnId) return true;
    }
    if (pending.length > MAX_LINE_BYTES) throw unavailable("rollout_line_limit");
    return false;
  }

  async function readThrough(file, end) {
    if (end - offset > MAX_CATCHUP_BYTES) throw unavailable("rollout_gap");
    while (!closed && offset < end) {
      const bytes = Buffer.alloc(Math.min(READ_BYTES, end - offset));
      const result = await file.read(bytes, 0, bytes.length, offset);
      if (!result.bytesRead) throw unavailable("rollout_gap");
      offset += result.bytesRead;
      if (consume(bytes.subarray(0, result.bytesRead))) return true;
    }
    return false;
  }

  async function checkFile() {
    const stat = await lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== generation) {
      throw unavailable("rollout_changed");
    }
    if (stat.size < BigInt(offset)) throw unavailable("rollout_truncated");
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable("rollout_size");
    return Number(stat.size);
  }

  async function readWindow(initial = false) {
    // The pathname remains the authority even when there is no new data. Avoid
    // opening an unchanged rollout, but still reject replacement or truncation.
    if (!initial && await checkFile() === offset) return false;
    const file = await open(filePath, "r");
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile()) throw unavailable("rollout_path");
      if (initial) {
        const canonical = await realpath(filePath);
        const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (normalize(canonical) !== normalize(filePath)) throw unavailable("rollout_path");
        generation = identity(stat);
      } else if (identity(stat) !== generation) throw unavailable("rollout_changed");
      const end = await checkFile();
      if (initial) {
        offset = Math.max(0, end - INITIAL_TAIL_BYTES);
        if (offset > 0) {
          const before = Buffer.alloc(1);
          const previous = await file.read(before, 0, 1, offset - 1);
          if (previous.bytesRead !== 1) throw unavailable("rollout_gap");
          discardInitialPartial = before[0] !== 10;
        }
      }
      return await readThrough(file, end);
    } finally {
      // Do not hold a Windows file handle between polls: native archive and
      // rollout ownership must not depend on this observer releasing a lock.
      await file.close();
    }
  }

  async function monitor() {
    try {
      const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
      while (!closed && !filePath) {
        filePath = await findRollout(codexHome, threadId);
        if (closed) break;
        if (!filePath) {
          if (Date.now() >= deadline) throw unavailable("rollout_missing");
          await delay();
        }
      }
      if (closed) return { state: "closed" };
      const cancelled = await readWindow(true);
      if (cancelled && !closed) return { state: "cancelled" };
      if (!closed) {
        state = "watching";
        readySettled = true; resolveReady();
      }
      while (!closed) {
        await delay();
        if (!closed && await readWindow()) return { state: "cancelled" };
      }
      return { state: "closed" };
    } catch (error) {
      return { state: "unavailable", error: error.code === "WEB_TURN_CANCELLATION_UNAVAILABLE"
        ? error : unavailable("rollout_access") };
    }
  }

  const finished = monitor().then(result => {
    state = closed ? "closed" : result.state;
    try {
      if (!closed && result.state === "cancelled") onCancel();
      else if (!closed && result.state === "unavailable") onUnavailable?.(result.error);
    } finally {
      if (!readySettled) {
        readySettled = true;
        if (state === "unavailable") rejectReady(result.error);
        else resolveReady();
      }
    }
    return result;
  });
  // Notification failures belong to the caller; keep the exposed promise while
  // preventing a fire-and-forget watcher from crashing the service.
  void finished.catch(() => {});
  return {
    ready, finished,
    get state() { return state; },
    async close() {
      closed = true;
      clearTimeout(timer);
      wake?.();
      await finished;
      state = "closed";
    },
  };
}
