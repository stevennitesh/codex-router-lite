import path from "node:path";

import { withDirectoryLock } from "./directory-lock.mjs";

import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 250;
// The lock covers only state mutation, publication, and rollback. Detached
// model downloads happen before it is acquired. Keep the stale horizon beyond
// the synchronous Codex probes a catalog publication can perform, while the
// heartbeat makes a live async transaction safe to wait on.
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function modelOverlayLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "model-overlay-transaction");
}

function lockWaitError(waitMs, cause) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const error = new Error(
    `Another model-overlay transaction is still running after ${seconds} second${seconds === 1 ? "" : "s"}. ` +
      "Wait for that router command to finish, then retry; abandoned locks are recovered automatically.",
    { cause },
  );
  error.code = "model_overlay_locked";
  return error;
}

/**
 * Serialize the complete model-overlay transaction across CLI and detached
 * worker processes. The catalog publisher has its own lock and
 * is entered by a fresh child while this lock is held; the two locks therefore
 * never nest in one process and read-only catalog/status calls remain unlocked.
 */
export async function withModelOverlayLock(
  operation,
  {
    stateDir = STATE_DIR,
    waitMs = DEFAULT_WAIT_MS,
    retryMs = DEFAULT_RETRY_MS,
    staleMs = DEFAULT_STALE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = {},
) {
  return withDirectoryLock(operation, {
    target: modelOverlayLockTarget(stateDir), waitMs, retryMs, staleMs, heartbeatMs,
    defaults: {waitMs:DEFAULT_WAIT_MS,retryMs:DEFAULT_RETRY_MS,staleMs:DEFAULT_STALE_MS,heartbeatMs:DEFAULT_HEARTBEAT_MS},
    lockedError: lockWaitError, releaseErrorKey: "modelOverlayLockReleaseError",
    releaseErrorMessage: error => `The model-overlay transaction completed, but its lock could not be released (${error?.message}).`,
  });
}
