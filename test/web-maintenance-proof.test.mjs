import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { readWebMaintenanceProcesses, relevantWebMaintenanceProcesses, assertWebMaintenanceAbsent, waitForWebMaintenanceExit, snapshotWebConversationLedgers, assertWebConversationLedgersUnchanged } from "../src/web-maintenance-proof.mjs";
import { validWebConversationRisk } from "../src/web-runtime.mjs";
import { processStartIdentity } from "../src/process-identity.mjs";

const base = path.resolve(".tmp", "web-maintenance-proof");
const plan = name => ({ node: { path: path.join(base, name, "node.exe") }, officialCli: { path: path.join(base, name, "codex.exe") },
  officialNodeRepl: { path: path.join(base, name, "node_repl.exe") }, runtimeModule: path.join(base, name, "browser", "scripts", "browser-client.mjs") });
const adapter = { currentRuntime: plan("old-removed"), candidate: plan("new"), managedEntryPath: path.join(base, "adapter", "generation", "entry.exe") };
const row = (pid, executable, commandLine = `"${executable}"`, ticks = "100") => ({ pid, parentPid: 0, probeState: "alive", executablePath: executable,
  name: path.basename(executable), identity: `${ticks}|${executable}`, commandLine });
const census = processes => ({ complete: true, processes });
const censusRequest = (value = adapter, ownPid = process.pid) => {
  let request;
  readWebMaintenanceProcesses(value, { ownPid, spawn: (_shell, _args, options) => {
    request = JSON.parse(options.input); return { status: 0, stdout: JSON.stringify(census([])) };
  } });
  return request;
};
const maintenanceFixture = (prefix, suffix = "", runMain = true) => `
$fixtureTokens = $null; $fixtureErrors = $null
$fixtureAst = [Management.Automation.Language.Parser]::ParseFile('${path.resolve(import.meta.dirname, "../src/web-maintenance-processes.ps1").replaceAll("'", "''")}', [ref]$fixtureTokens, [ref]$fixtureErrors)
if ($fixtureErrors.Count) { throw 'Invalid maintenance helper source.' }
foreach ($statement in $fixtureAst.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { Invoke-Expression $statement.Extent.Text }
}
${prefix}
${runMain ? '$fixtureMain = ($fixtureAst.EndBlock.Statements | Where-Object { $_ -isnot [Management.Automation.Language.FunctionDefinitionAst] } | ForEach-Object { $_.Extent.Text }) -join "`n"\nInvoke-Expression $fixtureMain' : ""}
${suffix}
`;

test("complete process proof covers full native hosts, both old/new child cohorts and managed adapter commands", () => {
  for (const executable of [path.join(base, "desktop", "Codex.exe"), path.join(base, "desktop", "ChatGPT.exe"),
    adapter.currentRuntime.officialNodeRepl.path, adapter.candidate.officialNodeRepl.path,
    adapter.currentRuntime.node.path, adapter.candidate.node.path, adapter.currentRuntime.officialCli.path, adapter.managedEntryPath,
    path.join(path.dirname(adapter.currentRuntime.officialCli.path), "codex-code-mode-host.exe"),
    path.join(path.dirname(adapter.candidate.officialCli.path), "future-official-tool-helper.exe")]) {
    assert.throws(() => assertWebMaintenanceAbsent(adapter, { census: () => census([row(1234, executable)]) }), /fresh complete census/u);
  }
  const generic = path.join(base, "system", "node.exe");
  for (const command of [`node "${path.join(base, "adapter", "old-generation", "web-stop-adapter.mjs")}"`,
    `node "${adapter.currentRuntime.runtimeModule}"`, `node "${adapter.candidate.runtimeModule}"`]) {
    assert.equal(relevantWebMaintenanceProcesses(census([row(1234, generic, command)]), adapter).length, 1);
  }
  assertWebMaintenanceAbsent(adapter, { census: () => census([row(1234, generic, 'node "unrelated-router/src/start.mjs"')]) });
});

test("process census retains descendants and fails closed for unidentifiable official helpers", () => {
  const host = row(1234, adapter.currentRuntime.officialCli.path);
  const child = { ...row(1235, path.join(base, "system", "python.exe")), parentPid: host.pid };
  assert.deepEqual(relevantWebMaintenanceProcesses(census([host, child]), adapter), [host, child]);
  assert.throws(() => relevantWebMaintenanceProcesses(census([{ ...child, identity: null, executablePath: null }, host]), adapter), /fresh complete census/u);
  assert.throws(() => relevantWebMaintenanceProcesses(census([{ ...row(1236, path.join(base, "old-removed", "codex-code-mode-host.exe")), identity: null, executablePath: null }]), adapter), /fresh complete census/u);
  assertWebMaintenanceAbsent(adapter, { census: () => census([{ pid: 0, parentPid: 0, probeState: "alive", name: "System Idle Process", executablePath: null, identity: null, commandLine: null }]) });
});

test("positive process exit omits only that generation while unknown live hosts and their descendants stay guarded", () => {
  const exited = { ...row(1234, adapter.currentRuntime.officialCli.path), probeState: "absent", identity: null };
  assertWebMaintenanceAbsent(adapter, { census: () => census([exited]) });
  const child = { ...row(1235, path.join(base, "system", "cmd.exe")), parentPid: exited.pid };
  assert.deepEqual(relevantWebMaintenanceProcesses(census([exited, child]), adapter), [child]);
  assert.throws(() => relevantWebMaintenanceProcesses(census([{ ...exited, probeState: "unknown" }]), adapter), /fresh complete census/u);
});

function sandboxBroker() {
  const packageFullName = "OpenAI.Codex_26.1023.6123.0_x64__fixture";
  const executable = path.join(base, "WindowsApps", packageFullName, "app", "resources", "codex-windows-sandbox-service.exe");
  const parent = { ...row(1233, path.join(base, "Windows", "services.exe")), sessionId: 0, executablePath: null, identity: null, commandLine: null };
  const broker = { ...row(1234, executable), parentPid: parent.pid, sessionId: 0, probeState: "unknown", executablePath: null, identity: null, commandLine: null,
    service: { name: "CodexSandboxService.OpenAI.Codex", processId: 1234, startName: "LocalSystem", state: "Running",
      configuredImagePath: `"${executable}"`, registeredImagePath: `"${executable}"`, registryType: 528, registryAccount: "LocalSystem", packageFullName } };
  return { parent, broker };
}

test("registered SYSTEM sandbox service is a persistent broker while its actual tool jobs remain relevant", () => {
  const { parent, broker } = sandboxBroker();
  assertWebMaintenanceAbsent(adapter, { census: () => census([parent, broker]) });
  const job = { ...row(1235, path.join(base, "system", "cmd.exe")), parentPid: broker.pid };
  assert.deepEqual(relevantWebMaintenanceProcesses(census([parent, broker, job]), adapter), [job]);
  assert.throws(() => relevantWebMaintenanceProcesses(census([parent, broker, { ...job, identity: null, probeState: "unknown" }]), adapter), /fresh complete census/u);
  assertWebMaintenanceAbsent(adapter, { census: () => census([parent, broker, { ...job, identity: null, probeState: "absent" }]) });
});

test("sandbox service exemption requires registered service account, package image, role and service-manager ancestry", () => {
  for (const mutate of [value => { value.broker.service = null; }, value => { value.broker.service.startName = "ordinary-user"; },
    value => { value.broker.service.registryAccount = "ordinary-user"; }, value => { value.broker.service.registryType = 32; },
    value => { value.broker.service.processId++; }, value => { value.broker.service.packageFullName = "foreign"; },
    value => { value.broker.service.registeredImagePath += " --tool-job"; }, value => { value.parent.name = "ordinary-parent.exe"; },
    value => { value.broker.sessionId = 1; }, value => { value.broker.service.state = "Stopped"; }]) {
    const value = sandboxBroker(); mutate(value);
    assert.throws(() => relevantWebMaintenanceProcesses(census([value.parent, value.broker]), adapter), /fresh complete census/u);
  }
});

test("actual census distinguishes positive process exit from denied live inspection and property argument errors", { skip: process.platform !== "win32" }, t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "census-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const scenario of ["gone", "denied", "exit-during-inspection", "argument-path", "argument-starttime"]) {
    const script = path.join(directory, `${scenario}.ps1`);
    const prefix = `
$script:observations = 0
function Get-CimInstance { param($ClassName, $Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected service query.' }
  [pscustomobject]@{ ProcessId = 1234; ParentProcessId = 0; SessionId = 1; Name = 'node_repl.exe'; ExecutablePath = 'C:\\fixture\\node_repl.exe'; CommandLine = 'fixture node_repl.exe' }
}
function Get-WebMaintenanceProcess { [CmdletBinding()]param($Id)
  $script:observations++
  if ('${scenario}' -eq 'gone' -or ('${scenario}' -eq 'exit-during-inspection' -and $script:observations -gt 1)) {
    $record = [Management.Automation.ErrorRecord]::new([ArgumentException]::new('Fixture exited.'), 'NoProcessFoundForGivenId', [Management.Automation.ErrorCategory]::ObjectNotFound, $Id)
    $PSCmdlet.ThrowTerminatingError($record)
  }
  if ('${scenario}' -eq 'denied') { throw 'Fixture access denied.' }
  $process = [pscustomobject]@{ HasExited = $false; Path = 'C:\\fixture\\node_repl.exe'; StartTime = [DateTime]::UtcNow }
  if ('${scenario}' -eq 'argument-path') { $process | Add-Member -MemberType ScriptProperty -Name Path -Value { throw [ArgumentException]::new('PRIVATE_CENSUS_CANARY'); } -Force }
  if ('${scenario}' -eq 'argument-starttime') { $process | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw [ArgumentException]::new('PRIVATE_CENSUS_CANARY'); } -Force }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
  return $process
}
`;
    writeFileSync(script, maintenanceFixture(prefix));
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      input: JSON.stringify(censusRequest()), encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /PRIVATE_CENSUS_CANARY/u);
    assert.equal(JSON.parse(result.stdout).processes[0].probeState, scenario === "denied" || scenario.startsWith("argument-") ? "unknown" : "absent");
  }
});

test("native process lookup positively identifies current PID and maps only absent open to the absence sentinel", { skip: process.platform !== "win32" }, t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "native-open-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "native-open.ps1");
  writeFileSync(script, maintenanceFixture(`
$ErrorActionPreference = 'Stop'
$observed = Get-WebMaintenanceProcess -Id $PID -ErrorAction Stop
try {
  $nativePath = $observed.Path
  $live = $observed.Id -eq $PID -and -not $observed.HasExited -and $nativePath -and $observed.StartTime.ToUniversalTime().Ticks -gt 0
} finally { $observed.Dispose() }
$absent = $false
try { $missing = Get-WebMaintenanceProcess -Id 2147483647 -ErrorAction Stop; $missing.Dispose() }
catch { if ($_.FullyQualifiedErrorId -match '^NoProcessFoundForGivenId(?:,|$)') { $absent = $true } else { throw } }
[Console]::Out.Write((@{ live = [bool]$live; absent = $absent } | ConvertTo-Json -Compress))
`, "", false));
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { live: true, absent: true });
});

test("scoped native census retains full ancestry and matches full inspection while skipping identified outsiders", { skip: process.platform !== "win32", timeout: 30_000 }, t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "scoped-census-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixturePlan = name => ({ node: { path: `C:\\fixture\\${name}\\node.exe` }, officialCli: { path: `C:\\fixture\\${name}\\codex.exe` },
    officialNodeRepl: { path: `C:\\fixture\\${name}\\node_repl.exe` }, runtimeModule: `C:\\fixture\\${name}\\browser\\scripts\\browser-client.mjs` });
  const fixtureAdapter = { currentRuntime: fixturePlan("old"), candidate: fixturePlan("new"), managedEntryPath: "C:\\fixture\\adapter\\generation\\entry.exe" };
  const ownPid = 400, request = censusRequest(fixtureAdapter, ownPid);
  const fixtures = Array.from({ length: 200 }, (_, index) => row(1000 + index, `C:\\unrelated\\app${index}.exe`));
  const host = { ...row(10, "C:\\desktop\\Codex.exe"), parentPid: 9999 };
  const child = { ...row(11, "C:\\unrelated\\outsider-named.exe"), parentPid: host.pid };
  const grandchild = { ...row(12, "C:\\unrelated\\another-outsider.exe"), parentPid: child.pid };
  const missingPath = { ...row(13, "C:\\fixture\\old\\future-helper.exe", "future-helper worker"), executablePath: null };
  const genericNode = row(14, "C:\\unrelated\\node.exe", "node unrelated.mjs");
  const own = row(ownPid, process.execPath);
  const command = row(15, "C:\\unrelated\\launcher.exe", 'launcher "C:/fixture/new/browser/scripts/browser-client.mjs"');
  const commandChild = { ...row(16, "C:\\unrelated\\cmd.exe"), parentPid: command.pid };
  const newHelper = row(17, "C:\\fixture\\new\\future-helper.exe");
  const missingCommand = { ...row(18, "C:\\unrelated\\missing-command.exe"), commandLine: null };
  const entry = row(19, "C:\\unrelated\\entry.exe");
  const ownChild = { ...row(20, "C:\\unrelated\\own-child.exe"), parentPid: ownPid };
  // Reverse descendant order prevents a one-pass ancestry shortcut from passing.
  fixtures.push({ pid: 0, parentPid: 0, name: "System Idle Process", executablePath: null, commandLine: null },
    grandchild, child, host, missingPath, genericNode, own, commandChild, command, newHelper, missingCommand, entry, ownChild,
    row(25, "C:\\unrelated\\node_repl.exe"));
  for (const scenario of ["live", "replaced", "denied", "exited"]) {
    const script = path.join(directory, `${scenario}.ps1`);
    const prefix = `
$script:fixtureRows = '${JSON.stringify(fixtures).replaceAll("'", "''")}' | ConvertFrom-Json
$script:nativeCalls = [Collections.Generic.List[int]]::new()
$script:lookupCounts = @{}
function Get-CimInstance { param($ClassName, $Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected service query.' }
  foreach ($row in $script:fixtureRows) { [pscustomobject]@{ ProcessId = $row.pid; ParentProcessId = $row.parentPid; SessionId = 1;
    Name = $row.name; ExecutablePath = $row.executablePath; CommandLine = $row.commandLine } }
}
function Get-WebMaintenanceProcess { [CmdletBinding()]param($Id)
  $script:nativeCalls.Add($Id)
  $script:lookupCounts[$Id] = 1 + $script:lookupCounts[$Id]
  if ($Id -eq 25 -and '${scenario}' -eq 'denied') { throw 'PRIVATE_CENSUS_CANARY denied live' }
  if ($Id -eq 25 -and '${scenario}' -eq 'exited') {
    $PSCmdlet.ThrowTerminatingError([Management.Automation.ErrorRecord]::new([ArgumentException]::new('Fixture exited.'), 'NoProcessFoundForGivenId', [Management.Automation.ErrorCategory]::ObjectNotFound, $Id))
  }
  $row = $script:fixtureRows | Where-Object { $_.pid -eq $Id }
  $ticks = if ($Id -eq 25 -and '${scenario}' -eq 'replaced' -and $script:lookupCounts[$Id] -gt 1) { 101 } else { 100 }
  $nativePath = if ($Id -eq 13) { 'C:\\fixture\\old\\future-helper.exe' } else { $row.executablePath }
  $process = [pscustomobject]@{ HasExited = $false; fixturePath = $nativePath; pathReads = 0; StartTime = [DateTime]::new($ticks, [DateTimeKind]::Utc) }
  $process | Add-Member -MemberType ScriptProperty -Name Path -Value { $this.pathReads++; if ($this.pathReads -gt 1) { throw 'PRIVATE_CENSUS_CANARY repeated Path read' }; return $this.fixturePath }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
  return $process
}
`;
    writeFileSync(script, maintenanceFixture(prefix, '[Console]::Out.Write("`n" + (ConvertTo-Json -InputObject @($script:nativeCalls) -Compress))'));
    if (scenario === "live") for (const scope of [undefined, { ownPid, roots: ["relative"] }, { ownPid: 0, roots: ["C:\\"] }]) {
      const invalid = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
        input: JSON.stringify({ action: "census", scope }), encoding: "utf8", windowsHide: true, timeout: 15_000,
      });
      assert.equal(invalid.status, 1);
      assert.deepEqual(JSON.parse(invalid.stderr), { phase: "census", reason: "invalid-scope", role: "none" });
    }
    const inspect = scope => {
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
        input: JSON.stringify({ action: "census", scope }), encoding: "utf8", windowsHide: true, timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stderr, /PRIVATE_CENSUS_CANARY/u);
      const [snapshot, calls] = result.stdout.trim().split(/\r?\n/u).map(value => JSON.parse(value));
      return { snapshot, calls };
    };
    // A root for every fixture drive forces the same native inspection work as
    // the original full census, independently of the narrower final classifier.
    const full = inspect({ ownPid, roots: [...new Set(["C:\\", path.parse(process.execPath).root])] });
    const scoped = inspect(request.scope);
    assert.equal(scoped.snapshot.processes.length, fixtures.length);
    assert.deepEqual(scoped.snapshot.processes.map(({ pid, parentPid }) => [pid, parentPid]), fixtures.map(({ pid, parentPid }) => [pid, parentPid]));
    assert.deepEqual([...new Set(scoped.calls)].sort((a, b) => a - b), [0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25, ownPid]);
    assert.equal(new Set(full.calls).size, fixtures.length);
    assert.ok(scoped.calls.length < full.calls.length / 5);
    const outsider = scoped.snapshot.processes.find(value => value.pid === 1000);
    assert.equal(outsider.identity, null); assert.equal(outsider.probeState, "unknown");
    const classify = snapshot => {
      try { return { pids: relevantWebMaintenanceProcesses(snapshot, fixtureAdapter, { ownPid }).map(value => value.pid) }; }
      catch (error) { assert.equal(error.code, "ERR_WEB_MAINTENANCE_PROOF"); return { diagnostic: error.diagnostic }; }
    };
    assert.deepEqual(classify(scoped.snapshot), classify(full.snapshot));
    if (["denied", "replaced"].includes(scenario)) assert.equal(classify(scoped.snapshot).diagnostic.reason, "matching-identity-unknown");
    else assert.deepEqual(classify(scoped.snapshot).pids, [12, 11, 10, 13, 16, 15, 17, ...(scenario === "live" ? [25] : [])]);
  }
});

test("actual wait preserves positive exit between process lookup and handle acquisition", { skip: process.platform !== "win32", timeout: 30_000 }, async t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "wait-exit-"));
  const signal = path.join(directory, "release-exit"), program = path.join(directory, "child.mjs"), script = path.join(directory, "wait.ps1");
  writeFileSync(program, `import {watch,existsSync} from 'node:fs';const watcher=watch(${JSON.stringify(directory)},()=>{if(existsSync(${JSON.stringify(signal)})){watcher.close();clearTimeout(deadline);}});const deadline=setTimeout(()=>{watcher.close();process.exitCode=1;},20000);console.log('ready');`);
  const child = spawn(process.execPath, [program], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    const identity = processStartIdentity(child.pid); assert.ok(identity);
    const prefix = `
$script:intercepted = $false
$script:openNative = (Get-Command Get-WebMaintenanceProcess).ScriptBlock
function Get-WebMaintenanceProcess { [CmdletBinding()]param($Id)
  $observed = & $script:openNative -Id $Id -ErrorAction Stop
  if (-not $script:intercepted) {
    $script:intercepted = $true
    [IO.File]::WriteAllText('${signal.replaceAll("'", "''")}', 'exit')
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      try { $probe = & $script:openNative -Id $Id -ErrorAction Stop; $probe.Dispose() }
      catch { if ($_.FullyQualifiedErrorId -match '^NoProcessFoundForGivenId(?:,|$)') { break }; throw }
      if ($deadline.ElapsedMilliseconds -gt 5000) { throw 'Fixture exit was not observed.' }
    }
  }
  return $observed
}
`;
    writeFileSync(script, maintenanceFixture(prefix));
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      input: JSON.stringify({ action: "wait", processes: [{ pid: child.pid, identity }], timeoutMs: 1000 }),
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).waited, true);
  } finally {
    writeFileSync(signal, "exit"); await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wait reconciliation rejects denied live generations and distinguishes confirmed PID replacement", { skip: process.platform !== "win32" }, t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "wait-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const scenario of ["denied", "replaced", "exit-before-starttime", "argument-handle", "argument-path", "argument-starttime"]) {
    const script = path.join(directory, `${scenario}.ps1`);
    const prefix = `
$script:lookups = 0
function Get-WebMaintenanceProcess { [CmdletBinding()]param($Id)
  $script:lookups++
  if ('${scenario}' -eq 'exit-before-starttime' -and $script:lookups -gt 1) {
    $PSCmdlet.ThrowTerminatingError([Management.Automation.ErrorRecord]::new([ArgumentException]::new('Fixture exited.'), 'NoProcessFoundForGivenId', [Management.Automation.ErrorCategory]::ObjectNotFound, $Id))
  }
  $ticks = if ('${scenario}' -eq 'replaced' -and $script:lookups -gt 1) { 101 } else { 100 }
  $process = [pscustomobject]@{ HasExited = $false; Path = 'C:\\fixture\\node_repl.exe'; StartTime = [DateTime]::new($ticks, [DateTimeKind]::Utc) }
  if ('${scenario}' -eq 'exit-before-starttime' -or '${scenario}' -in @('argument-path', 'argument-starttime')) {
    $process | Add-Member -NotePropertyName Handle -NotePropertyValue 1
    if ('${scenario}' -eq 'argument-path') { $process | Add-Member -MemberType ScriptProperty -Name Path -Value { throw [ArgumentException]::new('PRIVATE_WAIT_CANARY'); } -Force }
    else { $process | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw [ArgumentException]::new('PRIVATE_WAIT_CANARY'); } -Force }
  } else {
    $process | Add-Member -MemberType ScriptProperty -Name Handle -Value { throw [ArgumentException]::new('PRIVATE_WAIT_CANARY'); }
  }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
  return $process
}
`;
    writeFileSync(script, maintenanceFixture(prefix));
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      input: JSON.stringify({ action: "wait", processes: [{ pid: 1234, identity: "100|C:\\fixture\\node_repl.exe", name: "node_repl.exe" }], timeoutMs: 1000 }),
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    assert.doesNotMatch(result.stderr, /PRIVATE_WAIT_CANARY/u);
    if (scenario === "denied" || scenario.startsWith("argument-")) {
      assert.equal(result.status, 1); const diagnostic = JSON.parse(result.stderr);
      assert.equal(diagnostic.phase, "wait"); assert.equal(diagnostic.role, "official-repl");
      assert.match(diagnostic.reason, /unknown$/u);
    } else { assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).waited, true); }
  }
});

test("maintenance validates durable risks and preserves historical non-resumable V1 history bytes", t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "ledgers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgers = path.join(directory, "web-in-app", "conversations"); mkdirSync(ledgers, { recursive: true });
  const ids = ["00112233-4455-6677-8899-aabbccddeeff", "10112233-4455-6677-8899-aabbccddeeff"];
  const turnId = "11002233-4455-6677-8899-aabbccddeeff";
  const values = ids.map((threadId, index) => ({ version: 1, threadId, bindingId: `bhistory${index}`, browserOwnerTurnIds: [turnId],
    tabId: `historical-tab-${index}`, chatUrl: "https://chatgpt.com/c/00112233-4455-6677-8899-aabbccddeeff", checkpoint: index ? [] : ["a".repeat(64)],
    sendBaseline: index, uncertainSend: false, unresolvedCoding: [], lastTurn: { turnId, sendState: "unsent", completed: false } }));
  const bytes = values.map(value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  for (const [index, value] of values.entries()) {
    assert.equal(validWebConversationRisk(value, value.threadId), true);
    writeFileSync(path.join(ledgers, `${value.threadId}.json`), bytes[index]);
  }
  const options = { isPrivate: () => true }, snapshot = snapshotWebConversationLedgers(directory, options);
  assert.equal(snapshot.length, 2); assert.equal(snapshot.every(value => !value.uncertainSend && value.unresolvedActions === 0), true);
  assertWebConversationLedgersUnchanged(directory, snapshot, options);
  for (const [index, value] of values.entries()) assert.deepEqual(readFileSync(path.join(ledgers, `${value.threadId}.json`)), bytes[index]);
  for (const mutate of [value => { value.version = 2; }, value => { value.threadId = ids[1]; }, value => { value.uncertainSend = "false"; },
    value => { value.unresolvedCoding = "unknown"; }, value => { value.unresolvedCoding = [{ callId: "x", outputType: "unknown" }]; },
    value => { value.lastTurn.sendState = "uncertain"; }, value => { value.lastTurn.completed = true; }, value => { delete value.lastTurn; }]) {
    const changed = structuredClone(values[0]); mutate(changed);
    writeFileSync(path.join(ledgers, `${ids[0]}.json`), JSON.stringify(changed));
    assert.throws(() => snapshotWebConversationLedgers(directory, options), /invalid or unknown durable action risk/u);
  }
});

test("opaque recovery sidecars are byte-preserved without becoming authoritative conversation risk", t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "sidecars-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgers = path.join(directory, "web-in-app", "conversations"); mkdirSync(ledgers, { recursive: true });
  const threadId = "00112233-4455-6677-8899-aabbccddeeff", turnId = "11002233-4455-6677-8899-aabbccddeeff";
  const record = { version: 1, threadId, uncertainSend: false, unresolvedCoding: [], lastTurn: { turnId, sendState: "unsent", completed: false } };
  const mapping = path.join(ledgers, `${threadId}.json`), sidecar = path.join(ledgers, `${threadId}.recovery-copy.json`), opaque = path.join(ledgers, "retained-history.bin");
  const original = Buffer.from(JSON.stringify(record)), historical = Buffer.from('{"uncertainSend":"unknown","unresolvedCoding":["historical-only"]}'), binary = Buffer.from([0, 255, 1, 254]);
  writeFileSync(mapping, original); writeFileSync(sidecar, historical); writeFileSync(opaque, binary);
  const options = { isPrivate: () => true }, snapshot = snapshotWebConversationLedgers(directory, options);
  assert.equal(snapshot.filter(row => row.kind === "conversation").length, 1);
  assert.equal(snapshot.filter(row => row.kind === "sidecar").length, 2);
  assert.equal(snapshot.filter(row => row.kind === "sidecar").every(row => !Object.hasOwn(row, "uncertainSend") && !Object.hasOwn(row, "unresolvedActions")), true);
  assertWebConversationLedgersUnchanged(directory, snapshot, options);
  assert.deepEqual(readFileSync(mapping), original); assert.deepEqual(readFileSync(sidecar), historical); assert.deepEqual(readFileSync(opaque), binary);
  writeFileSync(sidecar, Buffer.concat([historical, Buffer.from("\n")]));
  assert.throws(() => assertWebConversationLedgersUnchanged(directory, snapshot, options), /changed during maintenance/u);
  writeFileSync(sidecar, historical);
  assert.throws(() => snapshotWebConversationLedgers(directory, { isPrivate: file => file !== sidecar }), /protected bounded regular file/u);
  mkdirSync(path.join(ledgers, "unexpected-directory"));
  assert.throws(() => snapshotWebConversationLedgers(directory, options), /protected bounded regular file/u);
});

test("failed, partial, malformed and inaccessible censuses cannot prove absence", () => {
  for (const value of [undefined, { processes: [] }, { complete: false, processes: [] }, census([{}]),
    census([row(0, adapter.currentRuntime.node.path)]), census([{ ...row(1234, adapter.currentRuntime.node.path), identity: "100|" }]),
    census([{ ...row(1234, adapter.currentRuntime.node.path), commandLine: null }]),
    census([row(1234, adapter.currentRuntime.node.path), row(1234, adapter.candidate.node.path)])]) {
    assert.throws(() => assertWebMaintenanceAbsent(adapter, { census: () => value }), /fresh complete census/u);
  }
  for (const result of [{ status: 1, stdout: '{"complete":true,"processes":[]}' }, { status: 0, stdout: "bad" },
    { status: 0, error: new Error("timeout"), stdout: '{"complete":true,"processes":[]}' }]) {
    assert.throws(() => readWebMaintenanceProcesses(adapter, { spawn: () => result }), /fresh complete census/u);
  }
  assert.deepEqual(readWebMaintenanceProcesses(adapter, { spawn: () => ({ status: 0, stdout: '{"complete":true,"processes":[]}' }) }), census([]));
});

test("census scope uses the classifier's normalized old/new and adapter roots and rejects invalid scope before launch", () => {
  const request = censusRequest();
  assert.deepEqual(request, { action: "census", scope: { ownPid: process.pid, roots: [...new Set([
    ...[adapter.currentRuntime, adapter.candidate].flatMap(value => [path.dirname(value.node.path), path.dirname(value.officialCli.path),
      path.dirname(value.officialNodeRepl.path), path.dirname(value.runtimeModule)]), path.dirname(path.dirname(adapter.managedEntryPath)),
  ].map(value => path.resolve(value).toLowerCase()))] } });
  for (const [value, ownPid] of [[undefined, 1], [{ ...adapter, managedEntryPath: "relative" }, 1],
    [{ ...adapter, currentRuntime: { ...adapter.currentRuntime, runtimeModule: null } }, 1], [adapter, 0], [adapter, 1.5]]) {
    let launched = false;
    assert.throws(() => readWebMaintenanceProcesses(value, { ownPid, spawn: () => { launched = true; } }), error => error.diagnostic?.reason === "invalid-scope");
    assert.equal(launched, false);
    assert.throws(() => relevantWebMaintenanceProcesses(census([]), value, { ownPid }), error => error.diagnostic?.reason === "invalid-scope");
  }
  let received;
  assertWebMaintenanceAbsent(adapter, { ownPid: 42, census: (...args) => { received = args; return census([]); } });
  assert.deepEqual(received, [adapter, { ownPid: 42 }]);
});

test("process proof failures retain fixed owner categories without shell errors or private fields", () => {
  for (const [result, expected] of [
    [{ status: null, error: { code: "ETIMEDOUT" } }, { phase: "census", reason: "timeout" }],
    [{ status: 1, stderr: JSON.stringify({ phase: "census", reason: "broker-inspection-failed", role: "official-helper", private: "PRIVATE_CENSUS_CANARY" }) },
      { phase: "census", reason: "broker-inspection-failed", role: "official-helper" }],
    [{ status: 1, stderr: "PRIVATE_CENSUS_CANARY arbitrary shell failure" }, { phase: "census", reason: "helper-failed" }],
  ]) assert.throws(() => readWebMaintenanceProcesses(adapter, { spawn: () => result }), error => {
    assert.deepEqual(error.diagnostic, expected); assert.doesNotMatch(error.message, /PRIVATE_CENSUS_CANARY/u); return true;
  });
});

test("independent exit wait retains process identities and recenses replacement generations", async () => {
  const first = row(1234, adapter.currentRuntime.officialNodeRepl.path, undefined, "100");
  const replacement = row(1234, adapter.candidate.officialNodeRepl.path, undefined, "101");
  const observations = [census([first]), census([replacement]), census([])], waits = [];
  await waitForWebMaintenanceExit(adapter, { census: () => observations.shift(), now: () => 100,
    wait: async (processes, timeout) => { waits.push(processes); assert.ok(timeout <= 60_000); } });
  assert.deepEqual(waits, [[first], [replacement]]);
});

test("exit wait fails on unknown inspection and timeout without a timer-based absence inference", async () => {
  let now = 0, waits = 0;
  await assert.rejects(waitForWebMaintenanceExit(adapter, { timeoutMs: 10, now: () => now,
    census: () => census([row(1234, adapter.currentRuntime.node.path)]), wait: async () => { waits++; now = 11; } }), /deadline/u);
  assert.equal(waits, 1);
  await assert.rejects(waitForWebMaintenanceExit(adapter, { census: () => ({ complete: false, processes: [] }) }), /fresh complete census/u);
});
