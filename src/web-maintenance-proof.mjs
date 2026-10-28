import { spawnSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessStartIdentity } from "./process-identity.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { validWebConversationRisk } from "./web-runtime.mjs";

const helper = fileURLToPath(new URL("./web-maintenance-processes.ps1", import.meta.url));
const normalize = value => path.resolve(value).toLowerCase();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = (phase = "classification", reason = "unconfirmed", details = {}) => Object.assign(new Error(
  `Forced Web maintenance requires a fresh complete census proving Codex, its managed adapter and both official runtime cohorts have exited. Process proof: ${phase}/${reason}.${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}`),
{ code: "ERR_WEB_MAINTENANCE_PROOF", diagnostic: { phase, reason, ...details } });
const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper];
const shell = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function helperFailure(phase, stderr, fallback) {
  try {
    const value = JSON.parse(stderr);
    if (value.phase === phase && ["enumeration-failed", "row-inspection-failed", "broker-inspection-failed", "invalid-scope", "invalid-budget", "process-open-unknown",
      "handle-open-unknown", "identity-read-unknown", "exit-wait-unknown"].includes(value.reason)
        && ["none", "native-host", "official-helper", "official-repl", "node-or-adapter", "descendant"].includes(value.role)) {
      return failure(phase, value.reason, { role: value.role });
    }
  } catch { /* Arbitrary helper/shell error text is never diagnostic output. */ }
  return failure(phase, fallback);
}

function registeredSystemSandboxBroker(row, rows) {
  const service = row.service, parent = rows.find(item => item.pid === row.parentPid);
  if (row.name.toLowerCase() !== "codex-windows-sandbox-service.exe" || row.sessionId !== 0
      || parent?.name.toLowerCase() !== "services.exe" || parent.sessionId !== 0 || parent.probeState === "absent"
      || service?.name !== "CodexSandboxService.OpenAI.Codex" || service.processId !== row.pid || service.state !== "Running"
      || !["localsystem", "nt authority\\system"].includes(service.startName?.toLowerCase())
      || !["localsystem", "nt authority\\system"].includes(service.registryAccount?.toLowerCase())
      || !Number.isSafeInteger(service.registryType) || !(service.registryType & 0x10) || service.registryType & 0x20
      || !/^OpenAI\.Codex_\d+(?:\.\d+){2,3}_(?:x64|arm64)__[a-z0-9]+$/u.test(service.packageFullName ?? "")) return false;
  const image = value => typeof value === "string" ? /^"([^"\r\n]+)"$/u.exec(value)?.[1] ?? (!value.includes('"') ? value : undefined) : undefined;
  const configured = image(service.configuredImagePath), registered = image(service.registeredImagePath);
  if (!configured || !registered || !path.isAbsolute(configured) || normalize(configured) !== normalize(registered)
      || path.basename(configured).toLowerCase() !== row.name.toLowerCase()) return false;
  const resources = path.dirname(configured), app = path.dirname(resources), packageRoot = path.dirname(app);
  if (path.basename(resources).toLowerCase() !== "resources" || path.basename(app).toLowerCase() !== "app"
      || path.basename(packageRoot) !== service.packageFullName || path.basename(path.dirname(packageRoot)).toLowerCase() !== "windowsapps") return false;
  return (!row.executablePath || normalize(row.executablePath) === normalize(configured))
    && (!row.identity || normalize(row.identity.split("|")[1]) === normalize(configured));
}

function webMaintenanceScope(adapter, ownPid = process.pid) {
  const plans = [adapter?.currentRuntime, adapter?.candidate];
  const absolute = value => typeof value === "string" && value.trim() !== "" && !value.includes("\0") && path.isAbsolute(value);
  if (!Number.isSafeInteger(ownPid) || ownPid < 1 || ownPid > 0x7fffffff
      || plans.some(plan => !plan || ["node", "officialCli", "officialNodeRepl"].some(name => !absolute(plan[name]?.path))
        || !absolute(plan.runtimeModule)) || !absolute(adapter?.managedEntryPath)) throw failure("census", "invalid-scope");
  return { ownPid, roots: [...new Set([...plans.flatMap(plan => [path.dirname(plan.node.path), path.dirname(plan.officialCli.path),
    path.dirname(plan.officialNodeRepl.path), path.dirname(plan.runtimeModule)]), path.dirname(path.dirname(adapter.managedEntryPath))].map(normalize))] };
}

export function readWebMaintenanceProcesses(adapter, { spawn = spawnSync, ownPid } = {}) {
  try {
    const scope = webMaintenanceScope(adapter, ownPid);
    const result = spawn(shell(), args, { input: JSON.stringify({ action: "census", scope }), encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw failure("census", result.error.code === "ETIMEDOUT" ? "timeout" : "launch-failed");
    if (result.status !== 0) throw helperFailure("census", result.stderr, "helper-failed");
    return JSON.parse(result.stdout);
  } catch (error) { if (error?.code === "ERR_WEB_MAINTENANCE_PROOF") throw error; throw failure("census", "invalid-response"); }
}

// Old paths come from the protected installed manifest, even if the app updater
// deleted their files. New paths come only from the validated candidate plan.
export function relevantWebMaintenanceProcesses(census, adapter, { ownPid = process.pid } = {}) {
  if (census?.complete !== true || !Array.isArray(census.processes)) throw failure();
  const { roots } = webMaintenanceScope(adapter, ownPid);
  const seen = new Set(), relevant = new Set(), brokers = new Set(), rows = census.processes;
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.pid) || row.pid < 0 || seen.has(row.pid)
        || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || typeof row.name !== "string" || !row.name
        || !["alive", "absent", "unknown"].includes(row.probeState)
        || row.executablePath != null && !path.isAbsolute(row.executablePath)
        || row.identity != null && !isProcessStartIdentity(row.identity)
        || row.commandLine != null && typeof row.commandLine !== "string") throw failure();
    seen.add(row.pid);
    if (row.pid === 0 && (row.name !== "System Idle Process" || row.identity != null || row.executablePath != null)) throw failure();
    const executable = row.executablePath ?? row.identity?.split("|")[1];
    const command = row.commandLine?.toLowerCase().replaceAll("/", path.sep) ?? "";
    const underCohort = executable && roots.some(root => normalize(executable).startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));
    const named = /^(?:codex(?:[-_].*)?|chatgpt|node_repl)\.exe$/iu.test(row.name);
    const managedCommand = roots.some(root => command.includes(root));
    if (registeredSystemSandboxBroker(row, rows)) brokers.add(row.pid);
    if (row.pid === ownPid) {
      if (!row.identity || normalize(executable) !== normalize(process.execPath)) throw failure();
      continue; // The independent maintenance worker itself owns no browser work.
    }
    // An unidentifiable generic Node/adapter process could belong to either
    // cohort; it cannot be dismissed as a Router or unrelated application.
    if (named || underCohort || managedCommand || /^(?:node|entry)\.exe$/iu.test(row.name) && (!row.identity || !row.commandLine?.trim())) relevant.add(row.pid);
  }
  let advanced;
  do {
    advanced = false;
    for (const row of rows) if (row.pid !== ownPid && relevant.has(row.parentPid) && !relevant.has(row.pid)) { relevant.add(row.pid); advanced = true; }
  } while (advanced);
  return rows.filter(row => {
    if (!relevant.has(row.pid)) return false;
    // The registered SYSTEM broker survives a normal app quit. Its actual tool
    // descendants remain relevant; no service is stopped or treated as a job.
    if (row.probeState === "absent" || brokers.has(row.pid)) return false;
    if (!row.identity || !row.commandLine?.trim() || !row.executablePath
        || normalize(row.identity.split("|")[1]) !== normalize(row.executablePath)) throw failure("classification", "matching-identity-unknown", {
      role: /^(?:codex|chatgpt)\.exe$/iu.test(row.name) ? "native-host" : /^codex.*\.exe$/iu.test(row.name) ? "official-helper"
        : /^node_repl\.exe$/iu.test(row.name) ? "official-repl" : /^(?:node|entry)\.exe$/iu.test(row.name) ? "node-or-adapter" : "descendant",
      probeState: row.probeState, missingIdentity: !row.identity, missingCommand: !row.commandLine?.trim(), missingPath: !row.executablePath,
    });
    return true;
  });
}

export function assertWebMaintenanceAbsent(adapter, { census = readWebMaintenanceProcesses, ownPid } = {}) {
  const live = relevantWebMaintenanceProcesses(census(adapter, { ownPid }), adapter, { ownPid });
  if (live.length) throw failure("classification", "live-processes", { count: live.length });
}

export async function waitForWebMaintenanceExit(adapter, { timeoutMs = 30 * 60_000,
  census = readWebMaintenanceProcesses, wait = waitForWebMaintenanceGenerations, now = Date.now, ownPid } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60_000) throw new Error("Invalid bounded Codex exit wait.");
  const deadline = now() + timeoutMs;
  while (true) {
    const processes = relevantWebMaintenanceProcesses(census(adapter, { ownPid }), adapter, { ownPid });
    if (!processes.length) return;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Codex did not fully exit before the maintenance deadline; no runtime selection was changed.");
    await wait(processes, Math.min(60_000, remaining));
    // Handles establish exit of known generations; this fresh complete census
    // also rejects replacements, old orphaned children and early app reopen.
  }
}

export async function waitForWebMaintenanceGenerations(processes, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = execFile(shell(), args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs + 20_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(helperFailure("wait", stderr, error.killed ? "timeout" : "helper-failed")); return; }
      try {
        if (JSON.parse(stdout).waited !== true) throw failure("wait", "invalid-response");
        resolve();
      } catch { reject(failure("wait", "invalid-response")); }
    });
    child.stdin.once("error", () => reject(failure("wait", "request-write-failed")));
    child.stdin.end(JSON.stringify({ action: "wait", processes: processes.map(({ pid, identity, name }) => ({ pid, identity, name })), timeoutMs }));
  });
}

export function snapshotWebConversationLedgers(stateDir, { isPrivate = privateFileIsProtected } = {}) {
  const directory = path.join(stateDir, "web-in-app", "conversations");
  const snapshot = []; let names;
  try { names = readdirSync(directory).sort(); }
  catch (error) { if (error.code === "ENOENT") return snapshot; throw new Error("Saved Web conversation ledgers are unreadable."); }
  for (const name of names) {
    const mapping = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/iu.test(name);
    const file = path.join(directory, name), before = lstatSync(file);
    for (let cursor = file; ; cursor = path.dirname(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("Saved Web conversation ledger links are refused.");
      if (path.dirname(cursor) === cursor) break;
    }
    if (!before.isFile() || before.size > 16 * 1024 * 1024 || !isPrivate(file)) throw new Error("Saved Web conversation ledger is not a protected bounded regular file.");
    const bytes = readFileSync(file), after = lstatSync(file);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Saved Web conversation ledger changed during inspection.");
    // The runtime admits only exact UUID.json mappings. Recovery copies and
    // other regular sidecars have no execution authority; preserve their bytes
    // without interpreting historical contents as current action risk.
    if (!mapping) { snapshot.push({ name, kind: "sidecar", sha256: digest(bytes) }); continue; }
    let value; try { value = JSON.parse(bytes); } catch { throw new Error("Saved Web conversation ledger is invalid."); }
    if (!validWebConversationRisk(value, name.slice(0, -5))) throw new Error("Saved Web conversation ledger has invalid or unknown durable action risk.");
    snapshot.push({ name, kind: "conversation", sha256: digest(bytes), uncertainSend: value.uncertainSend, unresolvedActions: value.unresolvedCoding.length });
  }
  return snapshot;
}

export function assertWebConversationLedgersUnchanged(stateDir, expected, options) {
  if (JSON.stringify(snapshotWebConversationLedgers(stateDir, options)) !== JSON.stringify(expected)) throw new Error("Saved Web conversation ledger changed during maintenance; evidence was preserved.");
}
