import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { readControlHealth } from "./control-health.mjs";
import { readInstallManifest } from "./install-manifest.mjs";
import { readServiceProcessState, serviceProcessOwns } from "./service-process.mjs";

const execFile = promisify(execFileCallback);
const sameRoot = (left, right) => typeof left === "string" && path.isAbsolute(left)
  && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

async function readServiceStatus(root) {
  const { stdout } = await execFile(process.execPath, [path.join(root, "src/service.mjs"), "status"], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, CODEX_ROUTER_SOURCE_ROOT: root },
  });
  return JSON.parse(stdout);
}

// Packaged activation and rollback share acceptance, including when the old
// generation predates this helper. The transaction invokes its source copy.
// Git commit and Switchyard provenance remain with the checkout transaction.
export async function assertDeploymentRuntime(root, {
  readHealth = readControlHealth,
  readManifest = readInstallManifest,
  readProcess = readServiceProcessState,
  ownsProcess = serviceProcessOwns,
  readTask = readServiceStatus,
  timeoutMs = 45_000,
  now = Date.now,
  pause = sleep,
} = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("Deployment acceptance requires an absolute installed source root.");
  }
  const expectedRoot = path.resolve(root);
  const deadline = now() + timeoutMs;
  let lastError = "Router is unavailable.";
  do {
    const health = await readHealth({ timeoutMs: Math.max(1, Math.min(3_000, deadline - now())) });
    if (health?.ok === true && health.status === 200 && health.service === "codex-router"
        && Array.isArray(health.degraded) && health.degraded.length === 0) break;
    lastError = health?.degraded?.length ? `degraded dependencies: ${health.degraded.join(", ")}`
      : "Router full health is unavailable or has an invalid service identity.";
    if (now() >= deadline) throw new Error(`Deployment full health failed: ${lastError}`);
    await pause(Math.min(500, deadline - now()));
  } while (true);

  const task = await readTask(expectedRoot);
  if (task?.installed !== true || task.loaded !== true || task.state !== "running") {
    throw new Error("Deployment task identity is not one running owned generation.");
  }
  const processState = readProcess();
  if (!sameRoot(processState?.sourceRoot, expectedRoot)
      || !ownsProcess(processState, { sourceRoot: expectedRoot })) {
    throw new Error("Deployment process identity is not live and owned by the installed source root.");
  }
  const manifest = readManifest();
  if (manifest?.version !== 1 || manifest.current?.target !== "codex"
      || !sameRoot(manifest.current?.sourceRoot, expectedRoot)) {
    throw new Error("Deployment install manifest does not match the installed source root and target.");
  }
  return { accepted: true, sourceRoot: expectedRoot,
    checks: { routerFullHealth: true, taskIdentity: true, processIdentity: true, installManifest: true } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await assertDeploymentRuntime(process.argv[2]))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
