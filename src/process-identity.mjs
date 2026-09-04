import { spawnSync } from "node:child_process";

const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 5_000;

// A PID alone is not an identity: the operating system reuses them, and a
// router that remembers only a number can eventually send a signal to whatever
// inherited it. Pair the PID with the process's start time and executable, and
// require both to match before acting on it.
//
// Service shutdown uses this check before signaling a recorded process.
export function processStartIdentity(
  pid,
  { spawn = spawnSync } = {},
) {
  const result = processStartIdentityProbe(pid, { spawn });
  return result.state === "alive" ? result.identity : undefined;
}

function processStartIdentityProbe(
  pid,
  { spawn = spawnSync } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unknown" };
  try {
    const script =
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      "if ($null -eq $p) { exit 3 }; " +
      `[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $p.Path)`;
    const result = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: WINDOWS_PROCESS_PROBE_TIMEOUT_MS,
      },
    );
    const identity = String(result.stdout || "").trim();
    if (result.status === 0 && identity) return { state: "alive", identity };
    if (result.status === 3) return { state: "absent" };
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
  { spawn = spawnSync } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const scripts = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; [Console]::Out.Write($p.CommandLine)`,
      `$p = Get-WmiObject Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; [Console]::Out.Write($p.CommandLine)`,
    ];
    for (const script of scripts) {
      const result = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: WINDOWS_PROCESS_PROBE_TIMEOUT_MS,
        },
      );
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
