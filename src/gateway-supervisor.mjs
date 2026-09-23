// The LiteLLM gateway is the one child of the service that is not ours. It is
// a large Python process pinned by `requirements/python.txt`, and a bug
// anywhere in that tree can end the process rather than the request. One
// observed failure mapped an upstream 429 outside the request handler and the
// proxy exited 1.
//
// Before this module, `start.mjs` raced every child's exit and tore the whole
// service down when any of them died, so a gateway crash took the router and
// its provider forwarder with it. Task Scheduler does bring the service back, but it brings
// back *everything*: the router's in-memory state is discarded and the gateway
// pays a cold Python import that start.mjs itself allows up to five minutes
// for. For that whole window clients get a refused connection -- "Connection
// error", with nothing naming the gateway as the cause.
//
// Restarting only the gateway keeps the router listening, so a crash costs one
// stalled request instead of the session: the router answers with a translated
// upstream error, `/health` reports `gateway.reachable: false` and returns 503,
// and doctor's "Router health" check sees it.
//
// Three rules keep the restart from being worse than the crash:
//
//   1. **Only after the gateway has been healthy once.** A gateway that never
//      came up is a configuration or dependency failure, and retrying it hides
//      the message the operator needs. Startup failure is unchanged: it still
//      throws out of `main()` and takes the service down.
//   2. **Bounded, in a window.** At most `maxRestarts` failures inside
//      `windowMs`; past that the supervisor returns and the service exits so
//      the OS supervisor performs a genuinely clean restart. Without the
//      window, an install that crashes once a week would eventually exhaust a
//      lifetime budget and stop being restarted at all; without the bound, a
//      gateway that dies on every request becomes a spawn loop.
//   3. **Never silent.** Every crash, every restart, and the decision to stop
//      restarting are logged unconditionally. The Windows service sets
//      `CODEX_ROUTER_QUIET`, and a quiet restart would hide a crash loop.

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_BACKOFF_MS = 30_000;
export const DEFAULT_STARTUP_BUDGETS = 3;

// Doubling from the base, capped. The cap matters more than the curve: a
// gateway that crashes on a poisoned request recovers on the first restart,
// while one that dies on startup must not be respawned faster than it takes to
// read the failure in the log.
function restartBackoffMs(attempt, base = DEFAULT_RESTART_BACKOFF_MS) {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const step = Math.max(0, base) * 2 ** Math.min(index, 16);
  return Math.min(step, MAX_RESTART_BACKOFF_MS);
}

function positiveInteger(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < 0) return fallback;
  if (floored === 0 && !allowZero) return fallback;
  return floored;
}

// `CODEX_ROUTER_GATEWAY_RESTARTS=0` disables supervision entirely. This is
// useful for a bisect or crash investigation because the process dies where
// the failure occurred.
export function gatewaySupervisorLimits(env = process.env) {
  return {
    maxRestarts: positiveInteger(env.CODEX_ROUTER_GATEWAY_RESTARTS, DEFAULT_MAX_RESTARTS, {
      allowZero: true,
    }),
    backoffMs: positiveInteger(
      env.CODEX_ROUTER_GATEWAY_RESTART_BACKOFF_MS,
      DEFAULT_RESTART_BACKOFF_MS,
      { allowZero: true },
    ),
    windowMs: positiveInteger(
      env.CODEX_ROUTER_GATEWAY_RESTART_WINDOW_MS,
      DEFAULT_RESTART_WINDOW_MS,
    ),
  };
}

function isRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function reason(error) {
  return (error instanceof Error && error.message) || String(error);
}

/**
 * Watch an already-healthy gateway child and restart it in place when it dies.
 *
 * Resolves with the same shape `waitForExit` produces -- `{ label, code,
 * signal }` -- so the caller can keep racing it against the other children.
 * `restarts` counts the crashes seen, and `exhausted` is true when the loop
 * gave up rather than the service shutting down.
 */
export async function superviseGateway({
  label = "LiteLLM gateway",
  child,
  start,
  waitForExit,
  waitForHealth,
  stop = (target) => target.kill("SIGTERM"),
  isShuttingDown = () => false,
  log = (message) => console.error(message),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  windowMs = DEFAULT_RESTART_WINDOW_MS,
  backoffMs = DEFAULT_RESTART_BACKOFF_MS,
  startupBudgets = DEFAULT_STARTUP_BUDGETS,
} = {}) {
  let current = child;
  let restarts = 0;
  const failures = [];

  for (;;) {
    const exit = await waitForExit(current, label);
    if (isShuttingDown()) return { ...exit, restarts };

    const at = now();
    failures.push(at);
    while (failures.length > 0 && at - failures[0] > windowMs) failures.shift();

    const describeExit = `code=${String(exit.code)}, signal=${String(exit.signal)}`;
    if (maxRestarts <= 0 || failures.length > maxRestarts) {
      log(
        maxRestarts <= 0
          ? `${label} exited (${describeExit}); restarts are disabled.`
          : `${label} exited (${describeExit}) after ${failures.length - 1} restart(s) ` +
            `within ${Math.round(windowMs / 1000)}s; not restarting it again.`,
      );
      return { ...exit, restarts, exhausted: true };
    }

    const wait = restartBackoffMs(failures.length - 1, backoffMs);
    log(
      `${label} exited (${describeExit}); restarting in ${wait} ms ` +
        `(restart ${failures.length} of ${maxRestarts}). The router stays up; ` +
        `requests fail with an upstream error until it answers again.`,
    );
    await sleep(wait);
    if (isShuttingDown()) return { ...exit, restarts };

    restarts += 1;
    try {
      current = start();
      // A replacement that is still alive after one cold-start budget may be
      // starved while importing rather than broken. Restarting that process
      // would throw away all import progress and can create a permanent loop
      // under the same load, so give the same child a few bounded budgets.
      for (let budget = 1; ; budget += 1) {
        try {
          await waitForHealth(current);
          break;
        } catch (error) {
          if (
            budget >= startupBudgets ||
            !isRunning(current) ||
            isShuttingDown()
          ) {
            throw error;
          }
          log(
            `${label} is still starting (${reason(error)}); waiting instead of restarting ` +
              `its import (budget ${budget + 1} of ${startupBudgets}).`,
          );
        }
      }
      log(`${label} is healthy again after ${restarts} restart(s).`);
    } catch (error) {
      log(`${label} did not come back: ${reason(error)}.`);
      // A child that is alive but never became healthy would leave the loop
      // parked on a `waitForExit` that resolves only when something else kills
      // it, so end it here and let the next iteration count it.
      if (isRunning(current)) stop(current);
    }
  }
}

/**
 * Start an optional child without making frontend lifetime depend on its first
 * successful launch. Startup failures use the same bounded backoff as later
 * crashes; once healthy, the established supervisor owns its lifetime.
 */
export async function superviseOptionalChild({
  label,
  start,
  waitForExit,
  waitForHealth,
  stop = (target) => target.kill("SIGTERM"),
  isShuttingDown = () => false,
  log = (message) => console.error(message),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRestarts = DEFAULT_MAX_RESTARTS,
  windowMs = DEFAULT_RESTART_WINDOW_MS,
  backoffMs = DEFAULT_RESTART_BACKOFF_MS,
} = {}) {
  let child;
  for (let attempt = 0; attempt <= maxRestarts; attempt += 1) {
    if (isShuttingDown()) return { label, restarts: attempt };
    try {
      child = start();
      await waitForHealth(child);
      if (attempt > 0) log(`${label} became healthy after ${attempt} startup retry(s).`);
      return superviseGateway({
        label,
        child,
        start,
        waitForExit,
        waitForHealth,
        stop,
        isShuttingDown,
        log,
        sleep,
        maxRestarts,
        windowMs,
        backoffMs,
      });
    } catch (error) {
      if (isRunning(child)) stop(child);
      if (attempt >= maxRestarts) {
        log(`${label} did not become healthy after ${attempt + 1} attempt(s): ${reason(error)}; not restarting it again.`);
        return { label, restarts: attempt, exhausted: true };
      }
      const wait = restartBackoffMs(attempt, backoffMs);
      log(`${label} is unavailable: ${reason(error)}; retrying in ${wait} ms. The router stays up.`);
      await sleep(wait);
    }
  }
}
