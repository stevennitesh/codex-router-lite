import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import {
  CODEX_HOME,
  LOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
} from "./paths.mjs";
import {
  clearServiceProcessState,
  readServiceProcessState,
  serviceProcessOwns,
} from "./service-process.mjs";
import {
  ensureProgramTreeReadable,
  protectPrivateFile,
  writePrivateFile,
} from "./file-security.mjs";
import { serviceProxyEnvironment } from "./proxy-environment.mjs";
import {
  skipServiceManagerCall,
  assertServiceWriteIsolated,
} from "./service-write-guard.mjs";
import { windowsScheduledTaskState } from "./windows-task-state.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const renderCommands = new Set(["render", "render-launcher", "render-task"]);
const taskName = "Codex Router";
const guardLauncherWrite = () => assertServiceWriteIsolated(STATE_DIR, {
  redirected: Boolean(
    process.env.MODEL_ROUTER_STATE_DIR || process.env.CODEX_ROUTER_STATE_DIR,
  ),
  label: "service launchers",
  override: "MODEL_ROUTER_STATE_DIR",
});

const wrapperPath = path.join(STATE_DIR, "start-codex-router.cmd");
const launcherPath = path.join(STATE_DIR, "start-codex-router-hidden.vbs");

if (effectivePlatform !== "win32" && !renderCommands.has(command)) {
  throw new Error("The Task Scheduler service manager runs on Windows only.");
}

function cmdEscape(value) {
  return String(value).replaceAll("%", "%%").replaceAll('"', '""');
}

function vbsEscape(value) {
  return String(value).replaceAll('"', '""');
}

function wrapper() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  const variables = {
    MODEL_ROUTER_TARGET: TARGET,
    MODEL_ROUTER_STATE_DIR: STATE_DIR,
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    MODEL_ROUTER_PORT: String(PORTS.router),
    MODEL_ROUTER_API_PORT: String(PORTS.api),
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    ...serviceProxyEnvironment(),
    // The LiteLLM gateway is a Python process. Force UTF-8 output so its
    // startup banner and logs do not crash on Windows systems whose default
    // ANSI/OEM code page is not UTF-8 (e.g. Russian cp1251), where Python
    // would otherwise encode stdout as the legacy code page.
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${Object.entries(variables)
    .map(([key, value]) => `set "${key}=${cmdEscape(value)}"`)
    .join("\r\n")}\r\n"${cmdEscape(process.execPath)}" "${cmdEscape(start)}" >> "${cmdEscape(LOG_PATH)}" 2>&1\r\n`;
}

// The scheduled task launches this script through `wscript.exe //B //NoLogo`,
// which is a windowless host, and the script starts the CMD wrapper with a
// window style of 0. Without it the wrapper owned a console window that stayed
// on screen for the router's lifetime and reappeared on every watchdog restart.
//
// The `True` wait flag keeps the task instance alive for the Router's lifetime,
// so Task Scheduler state and `schtasks /End` track the real process tree.
// The exit code remains useful for diagnostics, but RestartOnFailure does not
// reliably relaunch an action that started and later exited. The minute
// heartbeat in installTask owns that recovery path.
function launcher() {
  // A Windows path cannot contain a double quote, but escape it anyway so a
  // hand-edited state directory can never break out of the string literal.
  // Chr(34) supplies the quotes cmd.exe needs around the wrapper path, which
  // keeps this generated source free of stacked quote-doubling.
  return [
    "Option Explicit",
    "",
    "Dim quote, shell, status",
    "quote = Chr(34)",
    'Set shell = CreateObject("WScript.Shell")',
    "On Error Resume Next",
    `status = shell.Run("cmd.exe /D /C " & quote & quote & "${vbsEscape(wrapperPath)}" & quote & quote, 0, True)`,
    "If Err.Number <> 0 Then",
    "  WScript.Quit 1",
    "End If",
    "On Error Goto 0",
    "WScript.Quit status",
    "",
  ].join("\r\n");
}

function schtasks(args, options = {}) {
  // Queries are intentionally not skipped: status must report whether the
  // named task exists. Callers mark only service-manager mutations below.
  if (options.mutating && skipServiceManagerCall()) {
    return "";
  }
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeAtomic(target, contents) {
  guardLauncherWrite();
  // The VBS host keeps its script file open for the lifetime of the Router.
  // Replacing an unchanged launcher can therefore raise a sharing violation
  // during an otherwise routine reinstall or checkout ownership transfer.
  // Preserve an identical file in place; the CMD wrapper still changes when
  // its source checkout or captured service environment changes.
  if (existsSync(target)) {
    try {
      if (readFileSync(target).equals(contents)) {
        protectPrivateFile(target);
        return;
      }
    } catch {
      // Fall through to the atomic replacement so its error remains the
      // authoritative result when the existing file cannot be inspected.
    }
  }
  // Proxy URLs may contain credentials. The shared writer protects the new
  // file before replacing the old launcher.
  writePrivateFile(target, contents);
}

function writeLaunchers() {
  // Refuse before creating the state directory. A test must never leave even
  // an empty directory behind in the user's real install location.
  guardLauncherWrite();
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(wrapperPath, Buffer.from(wrapper(), "utf8"));
  // wscript.exe parses a script file with the system ANSI code page unless the
  // file carries a UTF-16 byte order mark, so a state directory holding
  // non-ASCII characters only round-trips when the launcher is UTF-16LE.
  writeAtomic(
    launcherPath,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(launcher(), "utf16le")]),
  );
}

// `//B` suppresses script errors and prompts, `//NoLogo` suppresses the banner;
// neither host allocates a console, so nothing is drawn at logon.
function taskAction() {
  return {
    execute: "wscript.exe",
    // Unlike cmd.exe, wscript.exe follows the standard command-line parser, so
    // the launcher path takes a single quote pair. cmd.exe's doubled-quote form
    // would parse as an empty argument followed by a split path.
    argument: `//B //NoLogo "${launcherPath}"`,
  };
}

function legacyTaskAction() {
  return {
    execute: "cmd.exe",
    argument: `/D /C ""${wrapperPath}""`,
  };
}

function taskSnapshot() {
  if (!taskExists()) return { exists: false };
  const canonical = taskAction();
  const legacy = legacyTaskAction();
  const script = [
    "$task = Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -ErrorAction Stop",
    "$actions = @($task.Actions)",
    "$principal = [string]$task.Principal.UserId",
    "$current = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$ownedPrincipal = ($principal -ieq $current.Name -or $principal -ieq $current.User.Value)",
    "if (-not $ownedPrincipal) { try { $ownedPrincipal = ((New-Object Security.Principal.NTAccount -ArgumentList $principal).Translate([Security.Principal.SecurityIdentifier]).Value -ieq $current.User.Value) } catch { $ownedPrincipal = $false } }",
    "$ownedAction = $false",
    "if ($actions.Count -eq 1) {",
    "  $execute = [string]$actions[0].Execute",
    "  $arguments = [string]$actions[0].Arguments",
    "  $ownedAction = (($execute -ieq $env:CODEX_ROUTER_TASK_EXECUTE -and $arguments -ceq $env:CODEX_ROUTER_TASK_ARGUMENT) -or ($execute -ieq $env:CODEX_ROUTER_LEGACY_EXECUTE -and $arguments -ceq $env:CODEX_ROUTER_LEGACY_ARGUMENT))",
    "}",
    "$scheduler = New-Object -ComObject Schedule.Service",
    "$scheduler.Connect()",
    "$registered = $scheduler.GetFolder('\\').GetTask($env:CODEX_ROUTER_TASK)",
    "$snapshot = [ordered]@{ exists = $true; owned = ($ownedPrincipal -and $ownedAction); xml = (Export-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK); sddl = $registered.GetSecurityDescriptor(7); running = ($task.State.ToString() -ieq 'Running') }",
    "[Console]::Out.Write(($snapshot | ConvertTo-Json -Compress))",
  ].join("\n");
  const env = {
    ...process.env,
    CODEX_ROUTER_TASK: taskName,
    CODEX_ROUTER_TASK_EXECUTE: canonical.execute,
    CODEX_ROUTER_TASK_ARGUMENT: canonical.argument,
    CODEX_ROUTER_LEGACY_EXECUTE: legacy.execute,
    CODEX_ROUTER_LEGACY_ARGUMENT: legacy.argument,
  };
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      return JSON.parse(execFileSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: TASK_STATE_TIMEOUT_MS,
          windowsHide: true,
        },
      ));
    } catch {
      // Try the other PowerShell host before using schtasks as an absence check.
    }
  }
  throw new Error(`Unable to verify ownership of the existing ${taskName} scheduled task.`);
}

function assertOwnedTask(snapshot) {
  if (snapshot.exists && snapshot.owned !== true) {
    throw new Error(`The ${taskName} scheduled task is not owned by this Codex Router installation; refusing to modify it.`);
  }
}

function launcherSnapshot() {
  return new Map([wrapperPath, launcherPath].map((target) => [
    target,
    existsSync(target) ? readFileSync(target) : undefined,
  ]));
}

function restoreLaunchers(snapshot) {
  for (const [target, contents] of snapshot) {
    if (contents === undefined) {
      if (existsSync(target)) unlinkSync(target);
    } else {
      writeAtomic(target, contents);
    }
  }
}

function restoreInstallState(snapshot, launchers) {
  const current = taskSnapshot();
  assertOwnedTask(current);
  if (current.exists) endTask();
  restoreLaunchers(launchers);
  if (!snapshot.exists) {
    try {
      schtasks(["/Delete", "/TN", taskName, "/F"], { quiet: true, mutating: true });
    } catch {
      // The failed install may not have registered anything.
    }
    return;
  }
  const script = [
    "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "Register-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -Xml ([string]$payload.xml) -Force | Out-Null",
    "$scheduler = New-Object -ComObject Schedule.Service",
    "$scheduler.Connect()",
    "$scheduler.GetFolder('\\').GetTask($env:CODEX_ROUTER_TASK).SetSecurityDescriptor([string]$payload.sddl, 0x10)",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_ROUTER_TASK: taskName },
      input: JSON.stringify({ xml: snapshot.xml, sddl: snapshot.sddl }),
      stdio: ["pipe", "ignore", "ignore"],
      timeout: TASK_STATE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (snapshot.running) {
    schtasks(["/Run", "/TN", taskName], { quiet: true, mutating: true });
  }
}

function installTask() {
  // PowerShell is a second Task Scheduler path, independent of schtasks().
  // Keep it behind the same mutation guard so tests cannot register or replace
  // the user's real task.
  if (skipServiceManagerCall()) return;
  const { execute, argument } = taskAction();
  const script = [
    // The action strings travel through the environment so that the quotes
    // around the launcher path never pass through powershell.exe's -Command
    // reparse or the schtasks argument escaper.
    "$action = New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TASK_EXECUTE -Argument $env:CODEX_ROUTER_TASK_ARGUMENT",
    "$logon = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    "$heartbeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 9999)",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable",
    "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -Action $action -Trigger @($logon, $heartbeat) -Settings $settings -Principal $principal -Force | Out-Null",
  ].join("; ");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          CODEX_ROUTER_TASK: taskName,
          CODEX_ROUTER_TASK_EXECUTE: execute,
          CODEX_ROUTER_TASK_ARGUMENT: argument,
        },
        // Registration can run from the Windows app, where a console child
        // gets its own window.
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch {
    schtasks(
      [
        "/Create",
        "/TN",
        taskName,
        "/SC",
        "ONLOGON",
        "/TR",
        `${execute} ${argument}`,
        "/RL",
        "LIMITED",
        "/F",
      ],
      { quiet: true, mutating: true },
    );
  }
}

// `schtasks /End` returns once Task Scheduler has accepted the request, not
// once the instance is gone, and `MultipleInstances IgnoreNew` silently drops a
// `/Run` issued while the old one is still winding down -- which leaves the
// router stopped until the next logon, and turns the installer's readiness wait
// into a five-minute stall followed by a rollback. Polling the real state beats
// retrying `/Run`: it continues as soon as the instance has actually gone
// instead of guessing how long that takes, and it gives up on a fixed deadline
// instead of hoping one extra attempt is enough.
const TASK_STOP_TIMEOUT_MS = 10_000;
const TASK_STOP_POLL_MS = 250;
// Every state query has to return for the deadline above to mean anything, so a
// wedged PowerShell is capped rather than allowed to hang the install outright.
const TASK_STATE_TIMEOUT_MS = 15_000;
// Task Scheduler can report Ready before the detached cmd/node descendants
// have gone away. Give the verified tree and its ports their own bounded wait
// after task state changes, so restart never races the old listener.
const SERVICE_TREE_STOP_TIMEOUT_MS = 15_000;
const SERVICE_TREE_STOP_POLL_MS = 250;
const SERVICE_TREE_COMMAND_TIMEOUT_MS = 2_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForTaskToStop() {
  const deadline = Date.now() + TASK_STOP_TIMEOUT_MS;
  // An undefined state means no PowerShell could answer -- the same restricted
  // shell that blocks registration -- so there is nothing to poll and waiting
  // would only spend the deadline on a question that cannot be answered.
  while (taskState() === "running") {
    if (Date.now() >= deadline) return;
    sleep(TASK_STOP_POLL_MS);
  }
}

function servicePorts(state) {
  const ports = state?.ports && typeof state.ports === "object" ? state.ports : PORTS;
  return [...new Set(Object.values(ports).filter((port) => Number.isSafeInteger(port) && port > 0))];
}

// `taskkill /T /F` is the ownership boundary. This netstat check is only a
// final readiness guard: if an unrelated process owns one of the configured
// ports it is never killed, and restart waits until the normal readiness check
// can report the conflict instead of claiming the old tree was stopped.
function managedPortStillListening(state) {
  // netstat is a machine-wide probe. It is not needed to exercise fixture
  // service lifecycle code and can observe unrelated listeners, so keep it
  // out of real Windows test runs.
  if (skipServiceManagerCall()) return false;
  try {
    const output = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SERVICE_TREE_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const ports = new Set(servicePorts(state).map((port) => `:${port}`));
    return String(output)
      .split(/\r?\n/)
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        const local = String(fields[1] || "");
        const colon = local.lastIndexOf(":");
        const suffix = colon >= 0 ? local.slice(colon) : local;
        return fields[0] === "TCP" && fields[3] === "LISTENING" && ports.has(suffix);
      });
  } catch {
    // A missing/blocked netstat cannot prove a listener is present. The
    // identity-checked process tree is still terminated below, and the normal
    // health probe remains the final readiness check.
    return false;
  }
}

function stopOwnedServiceTree() {
  // This path can issue taskkill and then poll process/port state for 15s.
  // Under test, the service-manager mutation was skipped, so there is no
  // owned tree to stop and no reason to touch the host or wait on it.
  if (skipServiceManagerCall()) return;
  const state = readServiceProcessState();
  if (!state || state.pid === process.pid || !serviceProcessOwns(state, { platform: effectivePlatform })) {
    return;
  }
  try {
    execFileSync("taskkill.exe", ["/PID", String(state.pid), "/T", "/F"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: SERVICE_TREE_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // A process that already exited is the desired state. If taskkill failed
    // for another reason, the bounded wait below leaves the record intact so a
    // later stop can try the same verified identity again.
  }
  const deadline = Date.now() + SERVICE_TREE_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const alive = serviceProcessOwns(state, { platform: effectivePlatform });
    const listening = managedPortStillListening(state);
    if (!alive && !listening) {
      clearServiceProcessState();
      return;
    }
    sleep(SERVICE_TREE_STOP_POLL_MS);
  }
  if (
    !serviceProcessOwns(state, { platform: effectivePlatform }) &&
    !managedPortStillListening(state)
  ) {
    clearServiceProcessState();
  }
}

function endTask() {
  // Do not poll after a skipped `/End`: taskState is a truthful read, but in a
  // test there was no mutation to wait for and a missing PowerShell can spend
  // the full timeout.
  const managerSkipped = skipServiceManagerCall();
  if (managerSkipped) return;
  try {
    schtasks(["/End", "/TN", taskName], { quiet: true, mutating: true });
  } catch {
    // The task may not exist, or may not be running. An orphaned router root
    // can still be recorded even in that case, so continue to the ownership
    // cleanup rather than returning early.
  }
  waitForTaskToStop();
  stopOwnedServiceTree();
}

// Only a task that still exists can be started. `Register-ScheduledTask -Force`
// unregisters before it registers, so a failed registration leaves either the
// previous definition or nothing at all, and `/Run` against a name that is gone
// recovers nothing while reporting an error of its own.
function taskExists() {
  try {
    schtasks(["/Query", "/TN", taskName], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function taskState() {
  const script =
    "try { [Console]::Out.Write((Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK).State.ToString()) } catch { exit 1 }";
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      return execFileSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_TASK: taskName },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: TASK_STATE_TIMEOUT_MS,
          // Status can be polled from the Windows app, so keep the helper
          // console hidden.
          windowsHide: true,
        },
      ).trim().toLowerCase();
    } catch {
      // Try Windows PowerShell after PowerShell Core, or fall back to schtasks.
    }
  }
  return undefined;
}

async function taskRunning() {
  // Scheduler's Running state can be stale, while Ready can race a detached
  // launcher that is still serving. In either case require the registered
  // task instance and its exact live launcher to agree.
  const corroborated = await windowsScheduledTaskState({
    taskName,
    platform: effectivePlatform,
    timeoutMs: TASK_STATE_TIMEOUT_MS,
  });
  // Neither signal is sufficient alone: COM instances can outlive their
  // process, while the machine-wide launcher scan can also see a manually
  // started router. Only their conjunction corroborates this task.
  return corroborated?.instanceCount > 0 && corroborated?.launcherAlive === true;
}

if (
  !new Set([
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "status",
    "render",
    "render-launcher",
    "render-task",
  ]).has(command)
) {
  console.error(
    "Usage: service-windows.mjs install|uninstall|start|stop|restart|status|render|render-launcher|render-task",
  );
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(wrapper());
} else if (command === "render-launcher") {
  process.stdout.write(launcher());
} else if (command === "render-task") {
  process.stdout.write(`${JSON.stringify(taskAction())}\n`);
} else if (command === "install") {
  // Keep the guard outside the scheduler-recovery catch below. An unredirected
  // test install is a safety violation, not a restricted Task Scheduler
  // failure, and must exit non-zero without touching the host filesystem.
  guardLauncherWrite();
  const previousTask = taskSnapshot();
  assertOwnedTask(previousTask);
  const previousLaunchers = launcherSnapshot();
  try {
    // The task runs at Limited integrity. Repair elevated-install ACLs before
    // it tries to load src/start.mjs from this program tree.
    ensureProgramTreeReadable(SOURCE_ROOT);
    // Writing the launchers belongs inside the try: renameSync over the .vbs
    // raises a sharing violation while a running wscript.exe still holds it
    // open, and that used to throw out of install with nothing to catch it.
    writeLaunchers();
    // An upgrade from the console-visible task may still have that instance
    // running. Register-ScheduledTask -Force replaces the definition under the
    // same task name, so no duplicate is left behind, but it does not stop the
    // running instance, and MultipleInstances IgnoreNew would then drop the new
    // hidden run — the console window would survive until the next logon.
    endTask();
    installTask();
    const installedTask = taskSnapshot();
    if (!installedTask.exists) throw new Error(`${taskName} registration did not create a task.`);
    assertOwnedTask(installedTask);
    schtasks(["/Run", "/TN", taskName], { quiet: true, mutating: true });
  } catch (installError) {
    let restoreError;
    try {
      restoreInstallState(previousTask, previousLaunchers);
    } catch (error) {
      restoreError = error;
    }
    if (restoreError) {
      throw new AggregateError([installError, restoreError], "Windows service install failed and its previous state could not be fully restored.");
    }
    throw installError;
  }
  // Launchers alone are not an installed service. A restricted scheduler (or
  // a test-mode mutation guard) must not claim success when the task is absent.
  process.stdout.write(`${JSON.stringify({ installed: taskExists(), path: wrapperPath })}\n`);
} else if (command === "uninstall") {
  // Refuse before `/End`, `/Delete`, or any filesystem removal when a test has
  // not redirected its service state directory.
  guardLauncherWrite();
  assertOwnedTask(taskSnapshot());
  endTask();
  try {
    schtasks(["/Delete", "/TN", taskName, "/F"], { quiet: true, mutating: true });
  } catch {
    // The task may not exist.
  }
  for (const target of [launcherPath, wrapperPath]) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // The launcher may already be gone, or a concurrent uninstall removed it.
    }
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "status") {
  let installed = false;
  let state = "stopped";
  let loaded = false;
  try {
    const snapshot = taskSnapshot();
    if (!snapshot.exists || !snapshot.owned) throw new Error("missing or foreign task");
    installed = true;
    state = taskState() || "ready";
    loaded = await taskRunning();
    if (loaded) state = "running";
  } catch {
    // Missing task.
  }
  process.stdout.write(
    `${JSON.stringify({ installed, loaded, state })}\n`,
  );
} else if (command === "stop") {
  // Stopping is idempotent, like uninstall: a task that is missing
  // or already idle is the state the caller asked for, not an error to raise.
  const previousTask = taskSnapshot();
  assertOwnedTask(previousTask);
  if (previousTask.exists) {
    schtasks(["/Change", "/TN", taskName, "/DISABLE"], { quiet: true, mutating: true });
    endTask();
  }
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  const previousTask = taskSnapshot();
  assertOwnedTask(previousTask);
  if (!previousTask.exists) {
    throw new Error("Codex Router task is not registered. Run node src/service.mjs install first.");
  }
  if (command === "restart") endTask();
  schtasks(["/Change", "/TN", taskName, "/ENABLE"], { quiet: true, mutating: true });
  schtasks(["/Run", "/TN", taskName], { quiet: true, mutating: true });
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
