import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  interpretWindowsTaskState,
  WINDOWS_TASK_DUPLICATE_IGNORED,
  windowsScheduledTaskState,
} from "../src/windows-task-state.mjs";

test("a running task treats IgnoreNew heartbeat rejection as healthy", () => {
  assert.deepEqual(interpretWindowsTaskState({
    instanceCount: 1,
    lastTaskResult: WINDOWS_TASK_DUPLICATE_IGNORED,
    launcherAlive: true,
  }), {
    status: "running",
    healthy: true,
    detail: "running; heartbeat duplicate ignored (0x800710E0)",
  });
  assert.equal(interpretWindowsTaskState({
    instanceCount: 0,
    lastTaskResult: WINDOWS_TASK_DUPLICATE_IGNORED,
    launcherAlive: false,
  }).healthy, false);
});

test("scheduled task queries parse observed state and retain inconclusive failures", async () => {
  let invocation;
  for (const [output, expected] of [
    ["2|267009|1\n", { instanceCount: 2, lastTaskResult: 267009, launcherAlive: true }],
    ["1|267014|0\n", { instanceCount: 1, lastTaskResult: 267014, launcherAlive: false }],
    ["0|267014|0\n", { instanceCount: 0, lastTaskResult: 267014, launcherAlive: false }],
    ["", undefined], ["not-a-count|1", undefined],
  ]) {
    const execFile = (executable, args, options, callback) => {
      invocation ??= { executable, args, options };
      callback(null, output);
    };
    assert.deepEqual(await windowsScheduledTaskState({ execFile, platform: "win32" }), expected, output);
  }
  assert.equal(await windowsScheduledTaskState({ platform: "win32", execFile: () => { throw new Error("access denied"); } }), undefined);
  assert.equal(invocation.executable, "powershell.exe");
  assert.equal(invocation.options.timeout, 10_000);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.CODEX_ROUTER_TASK, "Codex Router");
});

test("the generated task query requires its registered launcher and excludes unrelated and self processes", { skip: process.platform !== "win32" }, async () => {
  const launcher = "C:\\fixture\\start-codex-router-hidden.vbs";
  const processes = {
    registered: { pid: "12345", name: "wscript.exe", commandLine: `wscript.exe //B //NoLogo "${launcher.toUpperCase()}"` },
    foreground: { pid: "12346", name: "node.exe", commandLine: 'node "C:\\fixture\\src\\start.mjs"' },
    foreign: { pid: "12347", name: "wscript.exe", commandLine: 'wscript.exe "C:\\foreign\\start-codex-router-hidden.vbs"' },
    self: { pid: "$PID", name: "wscript.exe", commandLine: `wscript.exe "${launcher}"` },
  };
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  for (const scenario of [
    { name: "registered", census: ["registered", "foreground", "foreign", "self"], instances: 2, alive: true },
    { name: "foreground-only", census: ["foreground"], instances: 1, alive: false },
    { name: "foreign-launcher", census: ["foreign"], instances: 1, alive: false },
    { name: "query-process", census: ["self"], instances: 1, alive: false },
    { name: "dead-launcher", census: [], instances: 1, alive: false },
    { name: "null-instances", census: [], instances: 0, alive: false },
    { name: "wrong-action", census: ["registered"], instances: 1, alive: false, executable: "node.exe" },
  ]) {
    const census = scenario.census.map(name => {
      const process = processes[name];
      return `[pscustomobject]@{ProcessId=${process.pid};Name=${quote(process.name)};CommandLine=${quote(process.commandLine)}}`;
    }).join("; ");
    // Only external Scheduler/process observations are fixtures. Execute the
    // exact PowerShell program produced by windowsScheduledTaskState.
    const prefix = `
$ErrorActionPreference='Stop'
function Get-ScheduledTask { param($TaskName) if($TaskName -ne 'Fixture Task'){throw 'wrong task'}; [pscustomobject]@{} }
function Get-ScheduledTaskInfo { param($TaskName) if($TaskName -ne 'Fixture Task'){throw 'wrong task'}; [pscustomobject]@{LastTaskResult=267014} }
$script:action=[pscustomobject]@{Path=${quote(scenario.executable ?? "wscript.exe")};Arguments=${quote(`//E:VBScript //B //NoLogo "${launcher}"`)}}
$actions=[pscustomobject]@{}
$actions | Add-Member -MemberType ScriptMethod -Name Item -Value {param($index) if($index -ne 1){throw 'wrong action'};return $script:action}
$script:task=[pscustomobject]@{Definition=[pscustomobject]@{Actions=$actions}}
$script:task | Add-Member -MemberType ScriptMethod -Name GetInstances -Value {param($flags) if($flags -ne 0){throw 'wrong instance flags'}; $null; ${Array.from({ length: scenario.instances }, (_, index) => `[pscustomobject]@{Id=${index}}`).join("; ")}}
function New-Object { param($ComObject) if($ComObject -ne 'Schedule.Service'){throw 'wrong COM service'};
 $scheduler=[pscustomobject]@{}
 $scheduler | Add-Member -MemberType ScriptMethod -Name Connect -Value {}
 $scheduler | Add-Member -MemberType ScriptMethod -Name GetFolder -Value {param($path) if($path -ne '\\'){throw 'wrong folder'};
  $folder=[pscustomobject]@{}
  $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value {param($name) if($name -ne 'Fixture Task'){throw 'wrong task'};return $script:task}
  return $folder
 }
 return $scheduler
}
function Get-CimInstance { param($ClassName) if($ClassName -ne 'Win32_Process'){throw 'wrong process census'}; ${census} }
`;
    const result = await windowsScheduledTaskState({ platform: "win32", taskName: "Fixture Task",
      execFile: (executable, args, options, callback) => {
        const observed = spawnSync(executable, [...args.slice(0, -1), prefix + args.at(-1)], options);
        callback(observed.error ?? (observed.status === 0 ? null : new Error(observed.stderr)), observed.stdout);
      },
    });
    assert.deepEqual(result, { instanceCount: scenario.instances, lastTaskResult: 267014, launcherAlive: scenario.alive }, scenario.name);
  }
});

test("query cancellation retains helper custody until close", async () => {
  const controller = new AbortController(), child = new EventEmitter();
  let options, callback, settled = false;
  const query = windowsScheduledTaskState({ platform: "win32", timeoutMs: 12, signal: controller.signal,
    execFile: (_exe, _args, opts, cb) => { options = opts; callback = cb; return child; },
  }).then(result => { settled = true; return result; });
  assert.equal(options.signal, controller.signal);
  assert.equal(options.timeout, 12);
  controller.abort(); callback(new Error("aborted"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  child.emit("close", 1);
  assert.equal(await query, undefined);
});
