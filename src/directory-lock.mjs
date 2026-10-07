import { mkdirSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

function integer(value, fallback, minimum) {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

// Wrappers own lock identity, budgets and user-facing errors. This owner keeps
// acquisition, heartbeat and failure-preserving release consistent.
export async function withDirectoryLock(operation, {
  target, waitMs, retryMs, staleMs, heartbeatMs, defaults,
  lockedError, releaseErrorKey, releaseErrorMessage,
}) {
  const wait = integer(waitMs, defaults.waitMs, 0);
  const retry = integer(retryMs, defaults.retryMs, 1);
  const stale = integer(staleMs, defaults.staleMs, 2_000);
  const heartbeat = Math.min(integer(heartbeatMs, defaults.heartbeatMs, 1_000), stale / 2);
  mkdirSync(path.dirname(target), { recursive: true });
  let release;
  try {
    release = await lockfile.lock(target, {
      realpath: false, lockfilePath: `${target}.lock`, stale, update: heartbeat,
      retries: {
        retries: Math.max(0, Math.ceil(wait / retry) - 1), factor: 1,
        minTimeout: retry, maxTimeout: retry, randomize: false,
      },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") throw lockedError(wait, error);
    throw error;
  }
  let result, operationError, operationFailed = false;
  try { result = await operation(); }
  catch (error) { operationFailed = true; operationError = error; }
  let releaseError, releaseFailed = false;
  try { await release(); }
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
