import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

// MODULE_NOT_FOUND describes resolution failure. Current path presence cannot
// establish which file existed, or what the task token could read, at launch.
const MISSING_MODULE = /Cannot find module '([^']+)'/g;

const LOG_TAIL_BYTES = 64 * 1024;

// Capture before the service-manager command: an immediate launch error may
// already be in the log when the platform command returns and readiness starts.
export function captureLogPosition(logPath) {
  try {
    const { dev, ino, birthtimeMs, size, mtimeMs } = statSync(logPath);
    return { dev, ino, birthtimeMs, size, mtimeMs };
  } catch (error) {
    return error.code === "ENOENT" ? { missing: true } : { unavailable: true };
  }
}

// Seeks to the window rather than loading the file: this runs on a failure
// path that is already reporting an outage, and the router log is long-lived.
export function readLogTail(logPath, { maxBytes = LOG_TAIL_BYTES, after } = {}) {
  let descriptor;
  try {
    if (after?.unavailable) return "";
    descriptor = openSync(logPath, "r");
    const { dev, ino, birthtimeMs, size, mtimeMs } = fstatSync(descriptor);
    let start = Math.max(0, size - maxBytes);
    if (after && !after.missing) {
      const sameFile = dev === after.dev && ino === after.ino && birthtimeMs === after.birthtimeMs;
      if (sameFile && size >= after.size) start = Math.max(start, after.size);
      else if (mtimeMs <= after.mtimeMs) return "";
      // A changed/shortened file with a newer modification time can contain
      // fresh output after rotation/truncation. Never reread an unchanged tail.
    }
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    const read = readSync(descriptor, buffer, 0, length, start);
    // A window that starts mid-character would corrupt the first rune; the
    // patterns this feeds are anchored well inside the tail, so the partial
    // leading line is simply not worth reconstructing.
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    // A log the router cannot read is not evidence of anything; the caller
    // falls back to its generic message.
    return "";
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Nothing actionable; the diagnosis is best-effort by design.
      }
    }
  }
}

/**
 * Explain a Windows scheduled-task launch failure, or return undefined when
 * the log carries no evidence worth adding.
 *
 * Callers own launch attribution. Report loader/path facts and qualified next
 * checks; inspecting as the current user cannot prove a task-token failure.
 */
export function diagnoseWindowsLaunchFailure({ logText, inspect = statSync } = {}) {
  if (typeof logText !== "string" || !logText) return undefined;
  const named = [...logText.matchAll(MISSING_MODULE)].map((match) => match[1]);
  if (named.length === 0) return undefined;
  const modulePath = named.at(-1);
  const symptom = `Node could not resolve module '${modulePath}'. `;
  if (!path.isAbsolute(modulePath)) {
    return symptom + "Verify the launch entry and its installed dependencies.";
  }
  try {
    if (!inspect(modulePath).isFile()) {
      return symptom + "The path exists but is not a regular file. Verify its module entry and installed dependencies.";
    }
    return symptom + "The file exists now. Verify the launch command, module resolution and the task account's read/execute access; presence alone does not identify the cause.";
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return symptom + "The named path is absent now. Verify the launch entry and dependencies; use the installer to restore missing Router program files.";
    }
    return symptom + "The named path could not be inspected by this process. Verify its presence and the task account's read/execute access.";
  }
}
