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
import { isProcessStartIdentity, processSnapshotProbe, SERVICE_START_PROBE_BUDGET } from "./process-identity.mjs";

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

// Explicit launch intent must precede start.mjs evaluation. Inferring it from
// argv would let an unexpected managed entrypoint bypass identity verification.
let foregroundSupervisor = false;

export function markForegroundSupervisor() {
  foregroundSupervisor = true;
}

export function shouldRecordServiceProcess() {
  return !foregroundSupervisor;
}

export function buildServiceProcessState({
  pid = process.pid,
  probe = processSnapshotProbe,
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
  ports = PORTS,
  probeBudget,
} = {}) {
  const safe = safePid(pid);
  if (!safe) return undefined;
  const observed = probe(safe, { budget: probeBudget });
  const processIdentity = observed?.identity;
  const liveCommandLine = observed?.commandLine;
  if (observed?.state !== "alive" || !isProcessStartIdentity(processIdentity) || typeof liveCommandLine !== "string" || !liveCommandLine.trim()) return undefined;
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
    if (!validRecord(state)) throw new Error("invalid process record");
    return state;
  } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw new Error("The Router process record could not be verified; refusing to infer that the runtime is absent.", { cause });
  }
}

export function clearServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH) {
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function validRecord(state) {
  return state?.version === STATE_VERSION && state?.managed === true && Boolean(safePid(state.pid))
    && isProcessStartIdentity(state.processIdentity)
    && ["processIdentity", "commandLine", "sourceRoot", "stateDir"].every(name => typeof state[name] === "string" && state[name])
    && path.isAbsolute(state.sourceRoot) && path.isAbsolute(state.stateDir);
}

// Ownership is a positive verdict; a failed observation is never an absence
// verdict. Stop and replacement need this distinction; diagnostics can use
// the boolean convenience below without gaining mutation authority.
export function serviceProcessStatus(
  state,
  {
    probe = processSnapshotProbe,
    sourceRoot = SOURCE_ROOT,
    stateDir = STATE_DIR,
  } = {},
) {
  if (state === undefined) return "absent";
  if (!validRecord(state)) return "unknown";
  const pid = state.pid;
  let observed;
  try {
    observed = probe(pid);
  } catch { return "unknown"; }
  if (observed?.state === "absent") return "absent";
  if (observed?.state !== "alive" || !isProcessStartIdentity(observed.identity)) return "unknown";
  // A reused PID proves the recorded generation exited, but never permits
  // signaling the process that inherited that number.
  if (observed.identity !== state.processIdentity) return "absent";
  // The record lives in a user-writable state directory. Require both path
  // anchors to still be this installation before a PID can be terminated; a
  // hand-edited record for another checkout must never become a kill switch.
  if (
    normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot)) ||
    normalized(state.stateDir) !== normalized(path.resolve(stateDir))
  ) {
    return "foreign";
  }
  const entrypoint = entrypointFor(state.sourceRoot);
  if (!normalized(state.commandLine).includes(entrypoint)) return "unknown";
  const liveCommandLine = observed.commandLine;
  if (typeof liveCommandLine !== "string" || !liveCommandLine.trim()) return "unknown";
  return normalized(liveCommandLine).includes(entrypoint) ? "owned" : "foreign";
}

export function serviceProcessOwns(state, options) {
  return serviceProcessStatus(state, options) === "owned";
}

// Stopping a task is insufficient: its detached process tree can survive.
export function assertServiceProcessStopped(state, {
  status = serviceProcessStatus,
  listening = () => false,
} = {}) {
  const processState = status(state);
  const listener = listening(state);
  if (["owned", "foreign"].includes(processState) || listener === true) {
    throw new Error("The previous Router process or managed listener is still running; refusing to replace it.");
  }
  if (processState !== "absent" || listener !== false) {
    throw new Error("Router stoppage is unknown; refusing to replace it without verified process and listener absence.");
  }
}

export function assertServiceReplacementOwnership(state, {
  sourceRoot = SOURCE_ROOT,
  status = (value) => serviceProcessStatus(value, { sourceRoot: value?.sourceRoot }),
} = {}) {
  const processState = status(state);
  if (["unknown", "foreign"].includes(processState)) {
    throw new Error("The recorded Router process ownership is unknown or foreign; refusing installation replacement.");
  }
  if (state && processState === "owned" && normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot))) {
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
