import path from "node:path";

import { withDirectoryLock } from "./directory-lock.mjs";

import { STATE_DIR } from "./paths.mjs";

export async function withServiceOperationLock(
  operation,
  {
    stateDir = STATE_DIR,
    waitMs = 15_000,
    retryMs = 100,
    staleMs = 90_000,
  } = {},
) {
  return withDirectoryLock(operation, {
    target: path.join(stateDir, "service-operation"), waitMs, retryMs, staleMs, heartbeatMs: 10_000,
    defaults: {waitMs:15_000,retryMs:100,staleMs:90_000,heartbeatMs:10_000},
    lockedError: (_wait, cause) => new Error("Another background-service operation is still running; retry shortly.", {cause}),
    releaseErrorKey: "serviceLockReleaseError",
    releaseErrorMessage: error => `The background-service operation completed, but its lock could not be released (${error?.message}).`,
  });
}
