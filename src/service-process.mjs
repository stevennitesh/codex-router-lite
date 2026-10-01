import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import {
  PORTS,
  SERVICE_PROCESS_STATE_PATH,
  SOURCE_ROOT,
  STATE_DIR,
} from "./paths.mjs";
import { processCommandLine, processStartIdentity, SERVICE_START_PROBE_BUDGET } from "./process-identity.mjs";

const STATE_VERSION = 1;

function normalized(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function entrypointFor(sourceRoot) {
  return normalized(path.join(sourceRoot, "src", "start.mjs"));
}

function safePid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function buildServiceProcessState({
  pid = process.pid,
  identity = processStartIdentity,
  commandLine = processCommandLine,
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
  ports = PORTS,
  probeBudget,
} = {}) {
  const safe = safePid(pid);
  if (!safe) return undefined;
  const processIdentity = identity(safe, { budget: probeBudget });
  const liveCommandLine = commandLine(safe, { budget: probeBudget });
  if (!processIdentity || !liveCommandLine) return undefined;
  const entrypoint = entrypointFor(sourceRoot);
  if (!normalized(liveCommandLine).includes(entrypoint)) return undefined;
  return {
    version: STATE_VERSION,
    managed: true,
    pid: safe,
    processIdentity: String(processIdentity),
    commandLine: String(liveCommandLine),
    sourceRoot: path.resolve(sourceRoot),
    stateDir: path.resolve(stateDir),
    ports: Object.fromEntries(
      Object.entries(ports || {})
        .filter(([, value]) => Number.isSafeInteger(value) && value > 0)
        .map(([name, value]) => [name, value]),
    ),
    startedAt: Date.now(),
  };
}

export function writeServiceProcessState(options = {}) {
  const state = buildServiceProcessState({ ...options, probeBudget: SERVICE_START_PROBE_BUDGET });
  if (!state) {
    throw new Error(
      "The Windows service could not verify its own start.mjs process identity; refusing to run without a stoppable process record.",
    );
  }
  writePrivateJson(options.statePath || SERVICE_PROCESS_STATE_PATH, state);
  return state;
}

export function readServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state?.version === STATE_VERSION && state?.managed === true ? state : undefined;
  } catch {
    return undefined;
  }
}

export function clearServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH) {
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function serviceProcessOwns(
  state,
  {
    identity = processStartIdentity,
    commandLine = processCommandLine,
    sourceRoot = SOURCE_ROOT,
    stateDir = STATE_DIR,
  } = {},
) {
  const pid = safePid(state?.pid);
  if (
    !state ||
    state.version !== STATE_VERSION ||
    state.managed !== true ||
    !pid ||
    typeof state.processIdentity !== "string" ||
    !state.processIdentity ||
    typeof state.commandLine !== "string" ||
    !state.commandLine ||
    typeof state.sourceRoot !== "string" ||
    !state.sourceRoot ||
    typeof state.stateDir !== "string" ||
    !state.stateDir
  ) {
    return false;
  }
  // The record lives in a user-writable state directory. Require both path
  // anchors to still be this installation before a PID can be terminated; a
  // hand-edited record for another checkout must never become a kill switch.
  if (
    normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot)) ||
    normalized(state.stateDir) !== normalized(path.resolve(stateDir))
  ) {
    return false;
  }
  const entrypoint = entrypointFor(state.sourceRoot);
  if (!normalized(state.commandLine).includes(entrypoint)) return false;
  if (identity(pid) !== state.processIdentity) return false;
  const liveCommandLine = commandLine(pid);
  return Boolean(liveCommandLine && normalized(liveCommandLine).includes(entrypoint));
}

// Stopping a task is insufficient: its detached process tree can survive.
export function assertServiceProcessStopped(state, {
  owns = serviceProcessOwns,
  listening = () => false,
} = {}) {
  if ((state && owns(state)) || listening(state)) {
    throw new Error("The previous Router process or managed listener is still running; refusing to replace it.");
  }
}

export function assertServiceReplacementOwnership(state, {
  sourceRoot = SOURCE_ROOT,
  owns = (value) => serviceProcessOwns(value, { sourceRoot: value.sourceRoot }),
} = {}) {
  if (state && owns(state) && normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot))) {
    throw new Error("A live Router from another checkout still owns the state. Use the guarded deployment transaction before transferring installation ownership.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "assert-replacement") {
    try { assertServiceReplacementOwnership(readServiceProcessState()); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (process.argv[2] !== "verify" || !process.argv[3]) {
    console.error("Usage: service-process.mjs verify <expected-source-root>|assert-replacement");
    process.exitCode = 2;
  } else {
    const state = readServiceProcessState();
    const owned = serviceProcessOwns(state, { sourceRoot: path.resolve(process.argv[3]) });
    process.stdout.write(`${JSON.stringify({ owned, sourceRoot: owned ? state.sourceRoot : null })}\n`);
  }
}
