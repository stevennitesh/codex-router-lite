import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_PATH, NATIVE_CATALOG_PATH, SOURCE_ROOT } from "./paths.mjs";

// config-manager.mjs is a command-line script, so its managed marker prefix is
// restated here rather than imported.
import {
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runOperationProcessTree,
  runProcessTree,
} from "./process-tree.mjs";

const managedMarkerPattern = /^# BEGIN codex-router-/m;
const DEFAULT_TARGET_PUBLICATION_MS = 5 * 60_000;
const MAX_TARGET_PUBLICATION_MS = 5 * 60_000;

function targetPublicationDeadline(deadline, environment = process.env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : environment;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: DEFAULT_TARGET_PUBLICATION_MS,
    maximumMs: MAX_TARGET_PUBLICATION_MS,
  });
}

export async function runTargetPublicationProcess(
  script,
  args = [],
  {
    signal,
    deadline,
    executable = process.execPath,
    sourceRoot = SOURCE_ROOT,
    environment = process.env,
    run = runProcessTree,
  } = {},
) {
  const operationDeadline = targetPublicationDeadline(deadline, environment);
  const result = await runOperationProcessTree(
    executable,
    [path.join(sourceRoot, "src", script), ...args],
    {
      cwd: sourceRoot,
      env: environment,
      signal,
      deadline: operationDeadline,
      run,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Client publication exited with status ${result.status}.`);
  }
}

export function targetCli(command) {
  if (process.platform !== "win32") {
    throw new Error("Codex Router commands support Windows only.");
  }
  return `.\\${command}.ps1`;
}

export function targetPickerName() {
  return "Codex";
}

/**
 * How the user gets the new model list in front of them.
 *
 * Codex loads its catalog once at startup, so it has to be fully quit and
 * reopened.
 */
export function targetRestartHint() {
  return `Fully quit and reopen ${targetPickerName()} to refresh the model picker.`;
}

/**
 * Whether the Codex integration is currently published.
 */
export function installedTargets() {
  return codexIntegrationInstalled() ? ["codex"] : [];
}

function codexIntegrationInstalled() {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    return managedMarkerPattern.test(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // The file exists and cannot be read — Codex mid-write, an AV lock, a
    // permission hiccup. This answer feeds retire-the-service-if-unused, so
    // "cannot tell" must count as installed: tearing down the shared service
    // because a read flaked is the unrecoverable direction, while keeping it
    // alive one cycle longer costs nothing.
    return true;
  }
}

export async function refreshTargetPickerIfInstalled({ signal, deadline } = {}) {
  // Every publisher inherits the operation's one absolute deadline and runs
  // in a separately terminable process tree. The initial check prevents an
  // already-expired operation from touching the first client; each child then
  // remains bounded even if it or one of its descendants wedges.
  const operationDeadline = targetPublicationDeadline(deadline);
  remainingOperationMs(operationDeadline, signal, {
    message: "The router operation deadline expired before client publication completed.",
  });
  let refreshed = false;
  // A managed Codex config is the integration marker. Keep the retained native
  // capture as a fallback during an uninstall or update transition.
  if (codexIntegrationInstalled() || existsSync(NATIVE_CATALOG_PATH)) {
    await runTargetPublicationProcess("catalog.mjs", [], {
      signal,
      deadline: operationDeadline,
    });
    refreshed = true;
  }
  return refreshed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "installed-targets") {
    process.stdout.write(`${installedTargets().join(",")}\n`);
  } else if (process.argv[2] === "restart-notice") {
    process.stdout.write(`${targetRestartHint()}\n`);
  } else {
    console.error("Usage: target-integration installed-targets|restart-notice");
    process.exit(2);
  }
}
