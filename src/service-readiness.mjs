import { waitForRouterHealth } from "./router-health.mjs";
import { LOG_PATH } from "./paths.mjs";
import { windowsScheduledTaskState } from "./windows-task-state.mjs";
import { diagnoseWindowsLaunchFailure, readLogTail } from "./windows-launch-diagnosis.mjs";

const TASK_LAUNCH_GRACE_MS = 15_000;
const TASK_STATE_POLL_MS = 1_000;

function sleep(milliseconds) {
  return milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// `waitForRouterHealth` reports failure as a resolved result object, not a
// rejection. Normalize both shapes so the guard can trust one contract:
// `healthy === true` only when the router actually answered.
async function settleHealth(waitForHealth, timeoutMs) {
  try {
    const health = await waitForHealth({ timeoutMs });
    return { healthy: health?.ok === true, health };
  } catch (error) {
    return { healthy: false, error };
  }
}

/**
 * Wait for router health while honoring Windows' authoritative task state.
 *
 * Task Scheduler can keep a stale instance entry (or a Running state) after
 * its launcher tree has died, so liveness is read from two places: the COM
 * instance enumeration, and a direct scan for a live process whose command
 * line references the generated launcher. Once both stop reporting a live
 * launch for longer than the launch grace, readiness fails with the task's
 * own result instead of polling health for the full budget. A query failure
 * is inconclusive and never fails the wait by itself.
 */
export async function waitForServiceReadiness({
  timeoutMs = 300_000,
  launchGraceMs = TASK_LAUNCH_GRACE_MS,
  pollMs = TASK_STATE_POLL_MS,
  getWindowsTaskState = windowsScheduledTaskState,
  waitForHealth = waitForRouterHealth,
  logPath = LOG_PATH,
} = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // Keep exactly one health attempt in flight for the whole operation; the
  // readiness guard may finish first and must not create an unhandled
  // rejection.
  const healthWinner = settleHealth(waitForHealth, Math.max(0, deadline - Date.now())).then(
    (outcome) => ({ kind: "health", outcome }),
  );
  const failureOf = (outcome) =>
    outcome.error ??
    new Error(outcome.health?.error || "service did not become healthy");

  let deadSince;
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      healthWinner,
      sleep(Math.min(pollMs, deadline - Date.now())).then(() => null),
    ]);
    if (winner) {
      // The health attempt settles only after its full budget, which matches
      // this guard's own deadline, so an early settlement is a real verdict.
      if (winner.outcome.healthy) return winner.outcome.health;
      throw failureOf(winner.outcome);
    }

    let taskState;
    try {
      taskState = await getWindowsTaskState();
    } catch {
      taskState = undefined;
    }
    const launcherAlive =
      taskState?.launcherAlive === true ||
      (taskState?.launcherAlive === undefined && taskState?.instanceCount > 0);
    if (taskState && !launcherAlive) {
      deadSince ??= Date.now();
      if (Date.now() - deadSince >= launchGraceMs) {
        const result = Number.isSafeInteger(taskState.lastTaskResult)
          ? `0x${taskState.lastTaskResult.toString(16)}`
          : "unknown";
        // The task's own result is a bare exit code. When the router log
        // explains why the launch died, say that instead of leaving the
        // operator to reconcile "no running launcher" against a Node error
        // that names a file they can open.
        const diagnosis = diagnoseWindowsLaunchFailure({ logText: readLogTail(logPath) });
        throw new Error(
          `Windows Scheduled Task has no running launcher process (LastTaskResult=${result}); router cannot become healthy.` +
            (diagnosis ? `\n${diagnosis}` : ""),
        );
      }
    } else if (launcherAlive) {
      deadSince = undefined;
    }
  }

  const winner = await healthWinner;
  if (winner.outcome.healthy) return winner.outcome.health;
  throw failureOf(winner.outcome);
}
