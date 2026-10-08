import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processCommandLine, processStartIdentity, processStartIdentityProbe, SERVICE_START_PROBE_BUDGET } from "../src/process-identity.mjs";
import { buildServiceProcessState, serviceProcessOwns, serviceProcessStatus, readServiceProcessState, writeServiceProcessState } from "../src/service-process.mjs";

test("cold startup retries only timed-out process probes", () => {
  for (const probe of [processStartIdentity, processCommandLine]) {
    const calls = [];
    const value = probe(42, {
      budget: SERVICE_START_PROBE_BUDGET,
      spawn: (executable, args, options) => {
        calls.push({ executable, options });
        return calls.length === 1
          ? { error: { code: "ETIMEDOUT" }, stdout: "" }
          : { status: 0, stdout: "42|node.exe" };
      },
    });
    assert.equal(value, "42|node.exe");
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
  const identity = (_pid, options) => { budgets.push(options?.budget); return "42|node.exe"; };
  const commandLine = (_pid, options) => { budgets.push(options?.budget); return `node "${sourceRoot}\\src\\start.mjs"`; };
  try {
    const statePath = path.join(directory, "service-process.json");
    const state = writeServiceProcessState({ pid: 42, sourceRoot, stateDir: directory, statePath, identity, commandLine });
    assert.deepEqual(budgets, [SERVICE_START_PROBE_BUDGET, SERVICE_START_PROBE_BUDGET]);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).processIdentity, "42|node.exe");
    budgets.length = 0;
    assert.equal(serviceProcessOwns(state, { sourceRoot, stateDir: directory, identity, commandLine }), true);
    assert.deepEqual(budgets, [undefined, undefined]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("managed process records refuse foreground and unknown entrypoints", () => {
  const sourceRoot = path.join(os.tmpdir(), "router-identity-fixture");
  for (const entry of ["foreground-start.mjs", "unexpected-start.mjs"]) {
    const options = { pid: 42, sourceRoot, identity: () => "42|node.exe",
      commandLine: () => `node "${path.join(sourceRoot, "src", entry)}"` };
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
  const commandLine = () => `node "${path.join(sourceRoot, "src/start.mjs")}"`;
  const record = buildServiceProcessState({ pid: 42, sourceRoot, stateDir, identity: () => "42|node.exe", commandLine });
  for (const [probe, expected] of [
    [{ state: "unknown" }, "unknown"], [{ state: "absent" }, "absent"],
    [{ state: "alive", identity: "43|node.exe" }, "absent"], [{ state: "alive", identity: "42|node.exe" }, "owned"],
    [{ state: "alive", identity: "42|" }, "unknown"],
  ]) assert.equal(serviceProcessStatus(record, { sourceRoot, stateDir, commandLine, probe: () => probe }), expected);
  assert.equal(serviceProcessStatus(record, { sourceRoot, stateDir, probe: () => ({ state: "alive", identity: "42|node.exe" }), commandLine: () => undefined }), "unknown");
  assert.equal(serviceProcessStatus(record, { sourceRoot: path.resolve("foreign"), stateDir, probe: () => ({ state: "alive", identity: "42|node.exe" }), commandLine }), "foreign");
  assert.equal(serviceProcessStatus({ ...record, processIdentity: "42|" }), "unknown");
  assert.equal(buildServiceProcessState({ pid: 42, sourceRoot, stateDir, identity: () => "42|", commandLine }), undefined);
  assert.equal(serviceProcessStatus({}), "unknown");
  assert.equal(serviceProcessStatus(undefined), "absent");
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
