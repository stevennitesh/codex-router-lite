import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MINIMUM_INTERVAL_MS = 10_000;

export function catalogRefreshIntervalMs(value = process.env.CODEX_ROUTER_CATALOG_REFRESH_MS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MINIMUM_INTERVAL_MS
    ? parsed
    : DEFAULT_INTERVAL_MS;
}

function executeRefresh() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(SOURCE_ROOT, "src", "catalog.mjs"), "--refresh-if-stale"],
      {
        cwd: SOURCE_ROOT,
        encoding: "utf8",
        env: process.env,
        timeout: 180_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || "Catalog refresh failed").trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function refreshCatalogIfStale({ execute = executeRefresh } = {}) {
  const output = String(await execute()).trim();
  if (!output) throw new Error("Catalog refresh returned no result.");
  const result = JSON.parse(output.split(/\r?\n/u).at(-1));
  if (typeof result?.changed !== "boolean") {
    throw new Error("Catalog refresh returned an invalid result.");
  }
  return result;
}

export function startCatalogAutoRefresh({
  intervalMs = catalogRefreshIntervalMs(),
  refresh = refreshCatalogIfStale,
  log = (message) => console.error(`[codex-router] ${message}`),
} = {}) {
  let running = false;
  let stopped = false;
  const check = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await refresh();
      if (result.changed) {
        log("Codex changed; refreshed the native and routed model catalogs. Fully quit and reopen Codex to reload the picker.");
      }
    } catch (error) {
      log(`automatic catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(check, intervalMs);
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = startCatalogAutoRefresh();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stop();
      process.exitCode = 0;
    });
  }
}
