import { execFile } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import { processStartIdentity } from "./process-identity.mjs";
import { stopWindowsBatchChild } from "./windows-batch-cleanup.mjs";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MINIMUM_INTERVAL_MS = 10_000;
const MAXIMUM_INTERVAL_MS = 2 ** 31 - 1;
const REFRESH_TIMEOUT_MS = 180_000;

export function catalogRefreshIntervalMs(value = process.env.CODEX_ROUTER_CATALOG_REFRESH_MS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MINIMUM_INTERVAL_MS && parsed <= MAXIMUM_INTERVAL_MS
    ? parsed
    : DEFAULT_INTERVAL_MS;
}

function executeRefresh({ env, signal }) {
  return new Promise((resolve, reject) => {
    const deadlineAt = Date.now() + REFRESH_TIMEOUT_MS;
    let result;
    const child = execFile(
      process.execPath,
      [path.join(SOURCE_ROOT, "src", "catalog.mjs"), "--refresh-if-stale"],
      {
        cwd: SOURCE_ROOT,
        encoding: "utf8",
        env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        result = { error, stdout, stderr };
      },
    );
    const lifecycle = { executable: process.execPath };
    if (process.platform === "win32" && child.pid) {
      // Capture while the launch handle binds this process generation. The
      // catalog can own transient Codex probes, so Windows cancellation must
      // end the owned tree rather than just its Node root.
      lifecycle.createdTicks = processStartIdentity(child.pid)?.split("|")[0];
    }
    let stopping;
    let stopReason;
    const stop = reason => {
      stopReason ??= reason;
      clearTimeout(deadline);
      if (stopping || child.exitCode !== null || child.signalCode !== null) return;
      const cleanup = process.platform === "win32"
        ? stopWindowsBatchChild(child, lifecycle)
        : Promise.resolve().then(() => {
          if (!child.kill("SIGTERM")) throw new Error("Catalog refresh termination could not be requested.");
        });
      stopping = cleanup.catch(cause => {
        throw Object.assign(new Error(`Catalog refresh cleanup failed: ${cause.message}`, { cause }), {
          code: "catalog_refresh_cleanup_failed",
        });
      });
      // A native cleanup can fail before the child's close event. Its final
      // result is consumed below, while this handler prevents an early unhandled
      // rejection from abandoning shutdown custody.
      void stopping.catch(() => {});
    };
    // The deadline shares cancellation's tree cleanup and terminal custody.
    // execFile's direct-child timeout can orphan a still-running Codex probe.
    const deadline = setTimeout(() => stop(new Error("Catalog refresh timed out after 180000 ms.")), Math.max(0, deadlineAt - Date.now()));
    const aborted = () => stop(signal.reason);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    child.once("close", async () => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", aborted);
      try {
        await stopping;
        if (stopReason) throw stopReason;
        if (result?.error) {
          throw new Error((result.stderr || result.error.message || "Catalog refresh failed").trim());
        }
        resolve(result?.stdout);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function refreshCatalogIfStale({ execute = executeRefresh, env = process.env, signal } = {}) {
  const output = String(await execute({ env, signal })).trim();
  if (!output) throw new Error("Catalog refresh returned no result.");
  const result = JSON.parse(output.split(/\r?\n/u).at(-1));
  if (typeof result?.changed !== "boolean") {
    throw new Error("Catalog refresh returned an invalid result.");
  }
  return result;
}

export function startCatalogAutoRefresh({
  env = process.env,
  intervalMs = catalogRefreshIntervalMs(env.CODEX_ROUTER_CATALOG_REFRESH_MS),
  refresh = ({ signal }) => refreshCatalogIfStale({ env, signal }),
  log = (message) => console.error(`[codex-router] ${message}`),
} = {}) {
  let running = false;
  let pending;
  let controller;
  let shutdownFailure;
  let stopped = false;
  const check = () => {
    if (running || stopped) return;
    running = true;
    controller = new AbortController();
    pending = (async () => {
      try {
        const result = await refresh({ signal: controller.signal });
        if (result.changed) {
          log("Codex changed; refreshed the native and routed model catalogs. Fully quit and reopen Codex to reload the picker.");
        }
      } catch (error) {
        if (error !== controller.signal.reason) {
          log(`automatic catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
          if (error?.code === "catalog_refresh_cleanup_failed") {
            // Without terminal tree proof, another refresh could overlap a
            // surviving probe even when its Node root has already closed.
            stopped = true;
            clearInterval(timer);
          }
          if (stopped) shutdownFailure = error;
        }
      } finally {
        running = false;
      }
    })();
  };
  const timer = setInterval(check, intervalMs);
  check();
  return () => {
    stopped = true;
    clearInterval(timer);
    controller?.abort();
    // Cancellation cannot release service/foreground custody before the actual
    // refresh child and its native cleanup have reached their terminal states.
    return Promise.resolve(pending).then(() => {
      if (shutdownFailure) throw shutdownFailure;
    });
  };
}
