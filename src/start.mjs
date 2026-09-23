import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertCallerSecret } from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  loopback,
} from "./paths.mjs";
import { SHUTDOWN_DRAIN_MS, SHUTDOWN_FLUSH_MS } from "./http-utils.mjs";
import { waitForHealth as pollHealth } from "./health-probe.mjs";
import { gatewaySupervisorLimits, superviseOptionalChild } from "./gateway-supervisor.mjs";
import { writeLiteLlmConfig } from "./litellm-config.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import { venvRuntimeProblem } from "./venv-runtime.mjs";
import { clearServiceProcessState, writeServiceProcessState } from "./service-process.mjs";
import {
  environmentProxyOptedIn,
  inheritedProxyEnvironment,
  redactProxyCredentials,
} from "./proxy-environment.mjs";
import {
  installedSwitchyardLaunch,
  SWITCHYARD_CAPABILITY_ENV,
  switchyardSelectedForStartup,
} from "./switchyard-runtime.mjs";
import { providerSelectionStatus } from "./provider-selection.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";

// Before anything reads the environment or spawns a child. A service manager
// hands this process the proxy the install recorded; a shell hands it whatever
// the shell had, which for a desktop-app-spawned shell is nothing. Restoring
// the recorded values here makes every start path -- managed, foreground, or
// accidental -- reach upstreams the same way, and `commonEnv` below propagates
// them to the router and the forwarders through `process.env`.
const restoredProxy = inheritedProxyEnvironment();
for (const [name, value] of Object.entries(restoredProxy)) {
  process.env[name] = value;
}
// Unconditionally, and never behind MODEL_ROUTER_QUIET: this silently changes
// where every upstream request goes, and the whole reason the original failure
// took so long to find is that nothing near the router ever said which network
// path it was using. A managed start never reaches here -- its environment is
// declared -- so this line appears only on the paths that need it. The
// credential in a proxy URL is stripped; the host and port are the point.
if (Object.keys(restoredProxy).length > 0) {
  const address = restoredProxy.https_proxy ?? restoredProxy.HTTPS_PROXY
    ?? restoredProxy.http_proxy ?? restoredProxy.HTTP_PROXY;
  const shown = redactProxyCredentials({ address }).address;
  console.error(
    "[model-router] no proxy environment was inherited; restored the installed one" +
    `${shown ? ` (${shown})` : ""} from the install manifest.`,
  );
}

const dependencyFix = "Run `./install.ps1 -CheckoutInstall -ForceDeps`";

const configuredLiteLlm =
  process.env.MODEL_ROUTER_LITELLM_BIN ||
  process.env.CODEX_ROUTER_LITELLM_BIN;
const usesBundledVenv = !configuredLiteLlm;
const litellm = configuredLiteLlm || path.join(
  SOURCE_ROOT,
  ".venv",
  "Scripts",
  "python.exe",
);
// Windows console-script executables embed the absolute interpreter path they
// were installed against. The installer deliberately builds dependencies in a
// candidate venv and atomically moves it into `.venv`, so launching the
// generated `litellm.exe` after activation fails with "Failed to canonicalize
// script path". Invoke LiteLLM's declared console entry point through the venv
// interpreter instead; Python resolves the moved environment from its adjacent
// pyvenv.cfg and does not retain the staging path.
const litellmArgs = usesBundledVenv
  ? ["-I", "-X", "utf8", "-c", "from litellm import run_server; run_server()"]
  : [];
if (!existsSync(INTERNAL_SECRET_PATH)) {
  throw new Error("Internal service key is missing; run .\\install.ps1 -Target codex.");
}
if (!existsSync(CALLER_SECRET_PATH)) {
  throw new Error("Router caller key is missing; run .\\install.ps1 -Target codex.");
}
const internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
if (!internalKey) throw new Error("Internal service key is empty.");
const callerKey = assertCallerSecret(
  readFileSync(CALLER_SECRET_PATH, "utf8").trim(),
);

const commonEnv = {
  MODEL_ROUTER_TARGET: "codex",
  MODEL_ROUTER_STATE_DIR: STATE_DIR,
  MODEL_ROUTER_CALLER_KEY: callerKey,
  MODEL_ROUTER_INTERNAL_KEY: internalKey,
  MODEL_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  MODEL_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  MODEL_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  MODEL_ROUTER_API_PORT: String(PORTS.api),
  MODEL_ROUTER_PORT: String(PORTS.router),
  MODEL_ROUTER_QUIET: "1",
  CODEX_ROUTER_CALLER_KEY: callerKey,
  CODEX_ROUTER_INTERNAL_KEY: internalKey,
  CODEX_ROUTER_API_FORWARD_BASE_URL: loopback(PORTS.api, "/v1"),
  CODEX_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  CODEX_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  CODEX_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  CODEX_ROUTER_CATALOG: MERGED_CATALOG_PATH,
  CODEX_ROUTER_API_PORT: String(PORTS.api),
  CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  CODEX_ROUTER_PORT: String(PORTS.router),
  LITELLM_MASTER_KEY: internalKey,
  LITELLM_LOG: "ERROR",
  LITELLM_TELEMETRY: "False",
  NO_COLOR: "1",
  // LiteLLM prints Unicode banners at startup; on a non-UTF-8 Windows code page
  // (e.g. cp1252) that raises UnicodeEncodeError and the child never comes up.
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  // `--use-env-proxy` is a process argument, not an inherited environment
  // variable. Preserve its positive decision for the Node forwarders this
  // process launches; NODE_OPTIONS and NODE_USE_ENV_PROXY already inherit via
  // process.env.
  ...(environmentProxyOptedIn() ? { NODE_USE_ENV_PROXY: "1" } : {}),
};

const children = [];
let shuttingDown = false;

// Every child goes through `spawnableCommand` for the one case that needs it:
// a Windows `.cmd`/`.bat` launcher, which Node has refused to spawn without a
// shell since the CVE-2024-27980 fix and answers with a bare EINVAL. The
// bundled gateway uses python.exe, while `MODEL_ROUTER_LITELLM_BIN` and
// `CODEX_ROUTER_LITELLM_BIN` remain operator-set and may point at a batch
// wrapper. Our own Node children resolve to `process.execPath`, so they are
// pass-through on every platform.
function run(command, args, extraEnv = {}) {
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    cwd: SOURCE_ROOT,
    env: { ...process.env, ...commonEnv, ...extraEnv },
    stdio: "inherit",
    ...spawnable.options,
  });
  children.push(child);
  return child;
}

function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ label, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ label, code, signal }));
  });
}

// The probe loop lives in src/health-probe.mjs so it can be tested directly;
// importing this file starts the whole service pipeline.
function waitForHealth(label, url, headers = {}, timeoutMs = 30_000, expectedService, child) {
  return pollHealth({
    label,
    url,
    headers,
    timeoutMs,
    expectedService,
    child,
    isShuttingDown: () => shuttingDown,
  });
}

// Each child answers SIGTERM by draining what is in flight for up to
// SHUTDOWN_DRAIN_MS and then ending those responses cleanly, so this backstop
// has to outlast that. It used to fire at three seconds flat, which killed a
// router still holding a streaming turn open -- and a SIGKILLed socket is an
// RST, which Codex reports as `error decoding response body` rather than as
// the restart it was. Derive the deadline from the drain so the two cannot
// drift apart; the margin covers the exit itself.
const SIGKILL_AFTER_MS = SHUTDOWN_DRAIN_MS + SHUTDOWN_FLUSH_MS + 2_000;

function stopChildren() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, SIGKILL_AFTER_MS).unref();
}

const FRONTEND = { script: "router.mjs", service: "codex-router", label: "Codex router" };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopChildren);

async function main() {
  const providerSelection = providerSelectionStatus();
  let switchyardLaunch;
  try {
    switchyardLaunch = installedSwitchyardLaunch({
      selected: switchyardSelectedForStartup(providerSelection),
    });
  } catch (error) {
    console.error(`[codex-router] Switchyard startup is unavailable: ${error instanceof Error ? error.message : String(error)}.`);
  }
  // This ephemeral capability belongs only to the Router -> Switchyard hop.
  // It is separate from both caller and internal service credentials, never
  // enters argv or the route file, and rotates with the supervised service.
  const switchyardCapability = switchyardLaunch
    ? randomBytes(32).toString("hex")
    : undefined;
  const frontend = FRONTEND;
  const frontendService = frontend.service;
  const router = run(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", frontend.script)],
    switchyardCapability
      ? { [SWITCHYARD_CAPABILITY_ENV]: switchyardCapability }
      : {},
  );
  await waitForHealth(
    frontend.label,
    loopback(PORTS.router, "/live"),
    {},
    30_000,
    frontendService,
    router,
  );
  console.error(`[${frontendService}] ready (authenticated loopback endpoint)`);

  const limits = gatewaySupervisorLimits();
  const supervise = (label, start, healthy) => {
    void superviseOptionalChild({
      label,
      start,
      waitForExit,
      waitForHealth: healthy,
      isShuttingDown: () => shuttingDown,
      log: (message) => console.error(`[${frontendService}] ${message}`),
      ...limits,
    }).catch((error) => {
      if (!shuttingDown) console.error(`[${frontendService}] ${label} supervisor failed: ${error instanceof Error ? error.message : String(error)}.`);
    });
  };

  supervise(
    "API forwarder",
    () => run(process.execPath, [path.join(SOURCE_ROOT, "src", "api-forwarder.mjs")]),
    (child) => waitForHealth(
      "API forwarder",
      loopback(PORTS.api, "/health"),
      { Authorization: `Bearer ${internalKey}` },
      30_000,
      undefined,
      child,
    ),
  );

  if (switchyardLaunch) {
    const startSwitchyard = () => {
      const credential = resolveProviderCredential("openrouter");
      return run(switchyardLaunch.binary, switchyardLaunch.args, {
        [SWITCHYARD_CAPABILITY_ENV]: switchyardCapability,
        ...(credential?.value ? { OPENROUTER_API_KEY: credential.value } : {}),
      });
    };
    supervise(
      "Switchyard",
      startSwitchyard,
      (child) => waitForHealth(
        "Switchyard",
        switchyardLaunch.healthUrl,
        {},
        30_000,
        undefined,
        child,
      ),
    );
  }

  const startGateway = () => {
    if (!existsSync(litellm)) {
      throw new Error(`LiteLLM is not installed at ${litellm}. ${dependencyFix}.`);
    }
    if (usesBundledVenv) {
      const venvProblem = venvRuntimeProblem(litellm);
      if (venvProblem) {
        throw new Error(`The LiteLLM virtual environment is broken at ${litellm} (${venvProblem}). ${dependencyFix}.`);
      }
    }
    writeLiteLlmConfig();
    return run(litellm, [
      ...litellmArgs,
      "--config",
      LITELLM_CONFIG_PATH,
      "--host",
      "127.0.0.1",
      "--port",
      String(PORTS.gateway),
    ]);
  };
  // LiteLLM cold starts can take minutes under heavy system load. Killing it
  // mid-import restarts the import from scratch and
  // the service loops forever, so wait long enough for a starved import.
  const gatewayHealthy = (child) =>
    waitForHealth(
      "LiteLLM gateway",
      loopback(PORTS.gateway, "/health/liveliness"),
      { Authorization: `Bearer ${internalKey}` },
      300_000,
      undefined,
      child,
    );
  supervise("LiteLLM gateway", startGateway, gatewayHealthy);
  supervise(
    "Catalog refresh watcher",
    () => run(process.execPath, [path.join(SOURCE_ROOT, "src", "catalog-auto-refresh.mjs")]),
    async (child) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`exited during startup (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`);
      }
    },
  );
  const result = await waitForExit(router, frontend.label);
  if (!shuttingDown) {
    console.error(
      `[${frontendService}] ${result.label} exited (code=${String(result.code)}, signal=${String(result.signal)}).`,
    );
  }
  return result.code || 0;
}

let exitCode = 0;
let serviceProcessRecorded = false;
try {
  // Task Scheduler can report its wscript host as stopped while the detached
  // cmd/node descendants still own every router port. Record the verified
  // start.mjs identity so the Windows service manager can terminate that tree
  // before it launches a replacement.
  writeServiceProcessState();
  serviceProcessRecorded = true;
  exitCode = await main();
} catch (error) {
  if (!shuttingDown) {
    const reason = (error instanceof Error && error.message) || String(error);
    console.error(`[model-router] startup failed: ${reason}; inspect the service logs above for details.`);
    exitCode = 1;
  }
} finally {
  stopChildren();
  await Promise.all(children.map((child) => waitForExit(child, "child")));
  if (serviceProcessRecorded) {
    try {
      clearServiceProcessState();
    } catch {
      // A stale record is harmless after the root and its children are gone;
      // the next Windows stop re-validates identity before it can signal one.
    }
  }
}
// All children have exited, so let Node drain its own child-process bookkeeping
// before terminating. A synchronous process.exit() here races libuv's Windows
// async-handle close path and can abort with UV_HANDLE_CLOSING after a child
// fails during startup (for example, an EADDRINUSE forwarder).
process.exitCode = exitCode;
