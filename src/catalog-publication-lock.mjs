import path from "node:path";

import { withDirectoryLock } from "./directory-lock.mjs";

import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 250;
// Blocking Codex probes cannot expire a live owner's lease. Heartbeats record
// activity on that generation only; positive process exit permits recovery.
const DEFAULT_HEARTBEAT_MS = 10_000;

function catalogPublicationLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "catalog-publication");
}

function lockWaitError(waitMs, cause) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const error = new Error(
    `Another Codex model catalog publication is still running after ${seconds} second${seconds === 1 ? "" : "s"}. ` +
      "Wait for that router command to finish, then retry; locks from exited owner processes recover automatically.",
    { cause },
  );
  error.code = "catalog_publication_locked";
  return error;
}

// Every catalog producer executes catalog.mjs in a separate process. The
// directory lock serializes those Windows processes. It spans the whole
// caller operation so mutable inputs, native probes, and the coupled catalog /
// alias / announcement / agent publication observe one serialized snapshot.
export async function withCatalogPublicationLock(
  operation,
  {
    stateDir = STATE_DIR,
    waitMs = DEFAULT_WAIT_MS,
    retryMs = DEFAULT_RETRY_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = {},
) {
  return withDirectoryLock(operation, {
    target: catalogPublicationLockTarget(stateDir), waitMs, retryMs, heartbeatMs,
    defaults: {waitMs:DEFAULT_WAIT_MS,retryMs:DEFAULT_RETRY_MS,heartbeatMs:DEFAULT_HEARTBEAT_MS},
    lockedError: lockWaitError, releaseErrorKey: "catalogLockReleaseError",
    releaseErrorMessage: error => `The Codex model catalog was published, but its publication lock could not be released (${error?.message}).`,
  });
}
