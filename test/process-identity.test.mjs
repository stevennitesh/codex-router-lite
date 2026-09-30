import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processCommandLine, processStartIdentity, SERVICE_START_PROBE_BUDGET } from "../src/process-identity.mjs";
import { serviceProcessOwns, writeServiceProcessState } from "../src/service-process.mjs";

test("cold startup retries only timed-out process probes", () => {
  for (const probe of [processStartIdentity, processCommandLine]) {
    const calls = [];
    const value = probe(42, {
      budget: SERVICE_START_PROBE_BUDGET,
      spawn: (executable, args, options) => {
        calls.push({ executable, options });
        return calls.length === 1
          ? { error: { code: "ETIMEDOUT" }, stdout: "" }
          : { status: 0, stdout: "verified-process" };
      },
    });
    assert.equal(value, "verified-process");
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
