import path from "node:path";
import { withDirectoryLock } from "./directory-lock.mjs";
import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_RETRY_MS = 100;
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function callerKeyRotationLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "caller-key-rotation");
}

export async function withCallerKeyRotationLock(operation, {
  stateDir = STATE_DIR, waitMs = DEFAULT_WAIT_MS, retryMs = DEFAULT_RETRY_MS,
  staleMs = DEFAULT_STALE_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  return withDirectoryLock(operation, {
    target: callerKeyRotationLockTarget(stateDir), waitMs, retryMs, staleMs, heartbeatMs,
    defaults: {waitMs:DEFAULT_WAIT_MS,retryMs:DEFAULT_RETRY_MS,staleMs:DEFAULT_STALE_MS,heartbeatMs:DEFAULT_HEARTBEAT_MS},
    lockedError: (_wait, cause) => {
      const error = new Error("Another caller capability rotation is still running; retry shortly.", {cause});
      error.code = "caller_key_rotation_locked";
      return error;
    },
    releaseErrorKey: "callerKeyRotationLockReleaseError",
    releaseErrorMessage: error => `Caller capability rotation completed, but its lock could not be released (${error?.message}).`,
  });
}
