import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 5_000;
// Startup may wait for cold PowerShell; stop/ownership checks retain their
// short budgets. Retry only a timeout, never a completed negative result.
export const SERVICE_START_PROBE_BUDGET = Object.freeze({ timeoutMs: 45_000, attempts: 2 });

function probe(script, spawn, budget, environment) {
  const root = environment.SystemRoot || environment.WINDIR;
  const systemShell = root && path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const executable = systemShell && existsSync(systemShell) ? systemShell : "powershell.exe";
  const timeout = budget?.timeoutMs ?? WINDOWS_PROCESS_PROBE_TIMEOUT_MS;
  const attempts = budget?.attempts ?? 1;
  let result;
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout,
    });
    if (result.error?.code !== "ETIMEDOUT") break;
  }
  return result;
}

// A PID alone is not an identity: the operating system reuses them, and a
// router that remembers only a number can eventually send a signal to whatever
// inherited it. Pair the PID with the process's start time and executable, and
// require both to match before acting on it.
//
// Service shutdown uses this check before signaling a recorded process.
export function isProcessStartIdentity(value) {
  if (typeof value !== "string") return false;
  const [ticks, executable, extra] = value.split("|");
  return /^\d+$/u.test(ticks) && Boolean(executable?.trim()) && extra === undefined;
}

export function processStartIdentity(
  pid,
  { spawn = spawnSync, budget, environment = process.env } = {},
) {
  const result = processStartIdentityProbe(pid, { spawn, budget, environment });
  return result.state === "alive" ? result.identity : undefined;
}

export function processStartIdentityProbe(
  pid,
  { spawn = spawnSync, budget, environment = process.env } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unknown" };
  try {
    const script =
      "$ErrorActionPreference = 'Stop'; try { " +
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $p.Path) " +
      "} catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { exit 3 }; exit 1 }";
    const result = probe(script, spawn, budget, environment);
    const identity = String(result.stdout || "").trim();
    // An unavailable executable path is incomplete evidence, not a changed
    // identity that could prove the recorded generation has exited.
    if (!result.error && result.status === 0 && isProcessStartIdentity(identity)) return { state: "alive", identity };
    if (!result.error && result.status === 3) return { state: "absent" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

// Return the command line for a live process. A start time and executable are
// enough to reject PID reuse, but they do not prove that a Node process belongs
// to this checkout. The Windows service uses this extra identity before it
// recursively terminates the router tree.
export function processCommandLine(
  pid,
  { spawn = spawnSync, budget, environment = process.env } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const scripts = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; [Console]::Out.Write($p.CommandLine)`,
      `$p = Get-WmiObject Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; [Console]::Out.Write($p.CommandLine)`,
    ];
    for (const script of scripts) {
      const result = probe(script, spawn, budget, environment);
      const value = String(result.stdout || "").trim();
      if (result.status === 0 && value) return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// True when the recorded state still describes a live process this router
// started. Everything that stops or signals a managed process goes through
// this, so a server somebody else is running is never touched.
