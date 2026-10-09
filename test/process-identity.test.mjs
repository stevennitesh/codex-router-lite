import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { processCommandLine, processStartIdentity, processStartIdentityProbe, processSnapshotProbe, SERVICE_START_PROBE_BUDGET } from "../src/process-identity.mjs";
import { buildServiceProcessState, serviceProcessOwns, serviceProcessStatus, readServiceProcessState, writeServiceProcessState } from "../src/service-process.mjs";

test("cold startup retries only timed-out process probes", () => {
  for (const probe of [processStartIdentity, processCommandLine, processSnapshotProbe]) {
    const snapshot = { identity: "42|node.exe", commandLine: "node fixture" };
    const calls = [];
    const value = probe(42, {
      budget: SERVICE_START_PROBE_BUDGET,
      spawn: (executable, args, options) => {
        calls.push({ executable, options });
        return calls.length === 1
          ? { error: { code: "ETIMEDOUT" }, stdout: "" }
          : { status: 0, stdout: probe === processSnapshotProbe ? JSON.stringify(snapshot) : "42|node.exe" };
      },
    });
    assert.deepEqual(value, probe === processSnapshotProbe ? { state: "alive", ...snapshot } : "42|node.exe");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ options }) => options.timeout === 45_000 && options.windowsHide));
    if (process.platform === "win32") assert.ok(path.isAbsolute(calls[0].executable));
  }
  for (const result of [{ status: 3 }, { status: 1 }, { error: { code: "EACCES" } }]) {
    let calls = 0;
    assert.equal(processStartIdentity(42, {
      budget: SERVICE_START_PROBE_BUDGET,
      spawn: () => { calls++; return result; },
    }), undefined);
    assert.equal(calls, 1);
  }
});

test("ordinary ownership probes retain a single five-second attempt", () => {
  let calls = 0;
  assert.equal(processStartIdentity(42, {
    spawn: (_exe, _args, options) => {
      calls++;
      assert.equal(options.timeout, 5_000);
      return { error: { code: "ETIMEDOUT" } };
    },
  }), undefined);
  assert.equal(calls, 1);
  let startupCalls = 0;
  assert.equal(processStartIdentity(42, {
    budget: SERVICE_START_PROBE_BUDGET,
    spawn: () => { startupCalls++; return { error: { code: "ETIMEDOUT" } }; },
  }), undefined);
  assert.equal(startupCalls, 2);
});

test("service record opts into startup budget without widening later ownership checks", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-process-budget-"));
  const budgets = [];
  const sourceRoot = path.join(directory, "router");
  const probe = (_pid, options) => { budgets.push(options?.budget); return { state: "alive", identity: "42|node.exe", commandLine: `node "${sourceRoot}\\src\\start.mjs"` }; };
  try {
    const statePath = path.join(directory, "service-process.json");
    const state = writeServiceProcessState({ pid: 42, sourceRoot, stateDir: directory, statePath, probe });
    assert.deepEqual(budgets, [SERVICE_START_PROBE_BUDGET]);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).processIdentity, "42|node.exe");
    budgets.length = 0;
    assert.equal(serviceProcessOwns(state, { sourceRoot, stateDir: directory, probe }), true);
    assert.deepEqual(budgets, [undefined]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("managed process records refuse foreground and unknown entrypoints", () => {
  const sourceRoot = path.join(os.tmpdir(), "router-identity-fixture");
  for (const entry of ["foreground-start.mjs", "unexpected-start.mjs"]) {
    const options = { pid: 42, sourceRoot, probe: () => ({ state: "alive", identity: "42|node.exe",
      commandLine: `node "${path.join(sourceRoot, "src", entry)}"` }) };
    assert.equal(buildServiceProcessState(options), undefined);
    assert.throws(() => writeServiceProcessState(options), /refusing to run without a stoppable process record/);
  }
});

test("process observations preserve confirmed absence versus failed probes", () => {
  for (const [result, state] of [
    [{ status: 3 }, "absent"], [{ status: 0, stdout: "42|node.exe" }, "alive"],
    [{ status: 1 }, "unknown"], [{ status: 0, stdout: "" }, "unknown"],
    [{ status: 0, stdout: "42|" }, "unknown"], [{ status: 0, stdout: "42|  " }, "unknown"],
    [{ status: 0, stdout: "|node.exe" }, "unknown"], [{ status: 0, stdout: "malformed" }, "unknown"],
    [{ status: 3, error: { code: "ETIMEDOUT" } }, "unknown"],
  ]) assert.equal(processStartIdentityProbe(42, { spawn: () => result }).state, state);
  assert.equal(processStartIdentityProbe(42, { spawn: () => { throw new Error("denied"); } }).state, "unknown");
});

test("service verdicts reject unknown or foreign evidence without confusing PID reuse", () => {
  const sourceRoot = path.resolve("fixture-router"), stateDir = path.resolve("fixture-state");
  const commandLine = `node "${path.join(sourceRoot, "src/start.mjs")}"`;
  const record = buildServiceProcessState({ pid: 42, sourceRoot, stateDir, probe: () => ({ state: "alive", identity: "42|node.exe", commandLine }) });
  for (const [probe, expected] of [
    [{ state: "unknown" }, "unknown"], [{ state: "absent" }, "absent"],
    [{ state: "alive", identity: "43|node.exe" }, "absent"], [{ state: "alive", identity: "42|node.exe" }, "owned"],
    [{ state: "alive", identity: "42|" }, "unknown"],
  ]) assert.equal(serviceProcessStatus(record, { sourceRoot, stateDir, probe: () => ({ ...probe, commandLine }) }), expected);
  assert.equal(serviceProcessStatus(record, { sourceRoot, stateDir, probe: () => ({ state: "alive", identity: "42|node.exe" }) }), "unknown");
  assert.equal(serviceProcessStatus(record, { sourceRoot, stateDir, probe: () => ({ state: "alive", identity: "43|node.exe" }) }), "absent");
  assert.equal(buildServiceProcessState({ pid: 42, sourceRoot, stateDir, probe: () => ({ state: "alive", identity: "42|node.exe" }) }), undefined);
  assert.equal(serviceProcessStatus(record, { sourceRoot: path.resolve("foreign"), stateDir, probe: () => ({ state: "alive", identity: "42|node.exe", commandLine }) }), "foreign");
  assert.equal(serviceProcessStatus(record, { sourceRoot, stateDir, probe: () => ({ state: "alive", identity: "42|node.exe", commandLine: "node foreign/src/start.mjs" }) }), "foreign");
  assert.equal(serviceProcessStatus({ ...record, processIdentity: "42|" }), "unknown");
  assert.equal(buildServiceProcessState({ pid: 42, sourceRoot, stateDir, probe: () => ({ state: "alive", identity: "42|", commandLine }) }), undefined);
  assert.equal(serviceProcessStatus({}), "unknown");
  assert.equal(serviceProcessStatus(undefined), "absent");
});

test("snapshots retain valid generation facts and distinguish absent from failed observations", () => {
  const good = JSON.stringify({ identity: "42|node.exe", commandLine: "node fixture" });
  for (const [result, expected] of [
    [{ status: 0, stdout: good }, "alive"], [{ status: 3 }, "absent"],
    [{ status: 1 }, "unknown"], [{ status: 0, stdout: "broken JSON" }, "unknown"],
    [{ status: 0, stdout: JSON.stringify({ identity: "42|node.exe" }) }, "alive"],
    [{ status: 0, stdout: JSON.stringify({ identity: "42|", commandLine: "node fixture" }) }, "unknown"],
    [{ status: 0, stdout: JSON.stringify({ identity: "42|node.exe", commandLine: " " }) }, "alive"],
    [{ status: 0, stdout: JSON.stringify({ identity: "42|node.exe", commandLine: 12 }) }, "unknown"],
    [{ status: 3, error: { code: "ETIMEDOUT" } }, "unknown"],
  ]) assert.equal(processSnapshotProbe(42, { spawn: () => result }).state, expected);
  assert.equal(processSnapshotProbe(42, { spawn: () => { throw new Error("denied"); } }).state, "unknown");
  for (const pid of [0, -1, 1.5, NaN]) assert.equal(processSnapshotProbe(pid, { spawn: () => assert.fail("invalid PID spawned") }).state, "unknown");
  let calls = 0;
  assert.equal(processSnapshotProbe(42, { spawn: (_exe, _args, options) => {
    calls++; assert.equal(options.timeout, 5000); return { error: { code: "ETIMEDOUT" } };
  } }).state, "unknown");
  assert.equal(calls, 1);
});

test("snapshot generation recheck and WMI fallback execute in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  for (const changed of [false, true]) {
    const prefix = `
      $script:observations=0;
      function Get-Process {param($Id) $script:observations++; [pscustomobject]@{Path='C:\\fixture\\node.exe';StartTime=([DateTime]::new(2026,1,1)).AddSeconds(${changed ? "$script:observations" : "0"})}};
      function Get-CimInstance {throw 'Synthetic CIM failure'};
      function Get-WmiObject {[pscustomobject]@{CommandLine='node fixture'}};
    `;
    const result = processSnapshotProbe(42, { spawn: (exe, args, options) => {
      const copy = [...args]; copy[copy.length - 1] = prefix + copy[copy.length - 1];
      const stdout = execFileSync(exe, copy, options);
      return { status: 0, stdout };
    } });
    // The script's deliberate exit 1 becomes unknown; a stable generation
    // preserves the actual WMI-produced output through the parser.
    assert.equal(result.state, changed ? "unknown" : "alive");
    if (!changed) assert.equal(result.commandLine, "node fixture");
  }
});

test("actual Windows UTF-8 snapshot reaches service ownership once per observation", { skip: process.platform !== "win32" }, () => {
  const sourceRoot = path.join(os.tmpdir(), "router-漢🙂");
  const identityUrl = pathToFileURL(path.resolve("src/process-identity.mjs")).href;
  const serviceUrl = pathToFileURL(path.resolve("src/service-process.mjs")).href;
  const code = `
    import assert from 'node:assert/strict';
    import {spawnSync} from 'node:child_process';
    const {processSnapshotProbe,processCommandLine,processStartIdentityProbe}=await import(${JSON.stringify(identityUrl)});
    const {buildServiceProcessState,serviceProcessStatus}=await import(${JSON.stringify(serviceUrl)});
    const sourceRoot=process.env.PROCESS_FIXTURE_ROOT;
    let launches=0;
    const probe=(pid,options)=>processSnapshotProbe(pid,{...options,spawn:(...args)=>{launches++;return spawnSync(...args);}});
    const record=buildServiceProcessState({sourceRoot,stateDir:sourceRoot,probe});
    assert.ok(record);assert.ok(record.commandLine.includes('漢🙂'));assert.equal(launches,1);
    assert.equal(serviceProcessStatus(record,{sourceRoot,stateDir:sourceRoot,probe}),'owned');assert.equal(launches,2);
    assert.ok(processCommandLine(process.pid).includes('漢🙂'));
    assert.equal(processStartIdentityProbe(process.pid).identity,record.processIdentity);
    assert.equal(processSnapshotProbe(99999999).state,'absent');
    console.log(JSON.stringify({unicode:true,launchesPerObservation:1,owned:true,absent:true}));
  `;
  const results = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, path.join(sourceRoot, "src/start.mjs")], {
    encoding: "utf8", windowsHide: true, timeout: 20000, env: { ...process.env, PROCESS_FIXTURE_ROOT: sourceRoot },
  }));
  assert.deepEqual(results, { unicode: true, launchesPerObservation: 1, owned: true, absent: true });
});

test("a missing process record is absent but malformed records refuse replacement", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-record-read-"));
  const target = path.join(directory, "record.json");
  try {
    assert.equal(readServiceProcessState(target), undefined);
    for (const text of ["broken JSON", '{"version":1,"managed":true}', '{"version":2,"managed":true}']) {
      writeFileSync(target, text);
      assert.throws(() => readServiceProcessState(target), /could not be verified/u);
    }
    assert.throws(() => readServiceProcessState(directory), /could not be verified/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
