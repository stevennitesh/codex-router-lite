import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { readWebMaintenanceProcesses, relevantWebMaintenanceProcesses, assertWebMaintenanceAbsent, waitForWebMaintenanceExit, snapshotWebConversationLedgers, assertWebConversationLedgersUnchanged } from "../src/web-maintenance-proof.mjs";
import { validWebConversationRisk } from "../src/web-runtime.mjs";

const base = path.resolve(".tmp", "web-maintenance-proof");
const plan = name => ({ node: { path: path.join(base, name, "node.exe") }, officialCli: { path: path.join(base, name, "codex.exe") },
  officialNodeRepl: { path: path.join(base, name, "node_repl.exe") }, runtimeModule: path.join(base, name, "browser", "scripts", "browser-client.mjs") });
const adapter = { currentRuntime: plan("old-removed"), candidate: plan("new"), managedEntryPath: path.join(base, "adapter", "generation", "entry.exe") };
const row = (pid, executable, commandLine = `"${executable}"`, ticks = "100") => ({ pid, parentPid: 0, probeState: "alive", executablePath: executable,
  name: path.basename(executable), identity: `${ticks}|${executable}`, commandLine });
const census = processes => ({ complete: true, processes });

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

test("actual census distinguishes positive process exit from denied live inspection", { skip: process.platform !== "win32" }, t => {
  mkdirSync(base, { recursive: true }); const directory = mkdtempSync(path.join(base, "census-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const scenario of ["gone", "denied", "exit-during-inspection"]) {
    const script = path.join(directory, `${scenario}.ps1`);
    const prefix = `
$script:observations = 0
function Get-CimInstance { param($ClassName, $Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected service query.' }
  [pscustomobject]@{ ProcessId = 1234; ParentProcessId = 0; SessionId = 1; Name = 'node_repl.exe'; ExecutablePath = 'C:\\fixture\\node_repl.exe'; CommandLine = 'fixture node_repl.exe' }
}
function Get-Process { [CmdletBinding()]param($Id)
  $script:observations++
  if ('${scenario}' -eq 'gone' -or ('${scenario}' -eq 'exit-during-inspection' -and $script:observations -gt 1)) {
    $record = [Management.Automation.ErrorRecord]::new([ArgumentException]::new('Fixture exited.'), 'NoProcessFoundForGivenId', [Management.Automation.ErrorCategory]::ObjectNotFound, $Id)
    $PSCmdlet.ThrowTerminatingError($record)
  }
  if ('${scenario}' -eq 'denied') { throw 'Fixture access denied.' }
  $process = [pscustomobject]@{ HasExited = $false; Path = 'C:\\fixture\\node_repl.exe'; StartTime = [DateTime]::UtcNow }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
  return $process
}
`;
    writeFileSync(script, prefix + readFileSync(path.resolve(import.meta.dirname, "../src/web-maintenance-processes.ps1"), "utf8"));
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      input: '{"action":"census"}', encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).processes[0].probeState, scenario === "denied" ? "unknown" : "absent");
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
    assert.throws(() => readWebMaintenanceProcesses({ spawn: () => result }), /fresh complete census/u);
  }
  assert.deepEqual(readWebMaintenanceProcesses({ spawn: () => ({ status: 0, stdout: '{"complete":true,"processes":[]}' }) }), census([]));
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
