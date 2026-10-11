import assert from "node:assert/strict";
import test from "node:test";
import { requireGatewayRuntime, venvRuntimeOutcome, venvRuntimeProblem } from "../src/venv-runtime.mjs";

test("interpreter scheduling timeout proceeds to readiness while actual failures stop startup", () => {
  const seen = [];
  const spawn = (_python, args, options) => {
    seen.push({ args, timeout: options.timeout });
    return { error: Object.assign(new Error("scheduling timeout"), { code: "ETIMEDOUT" }) };
  };
  const outcome = venvRuntimeOutcome("python", { spawn, timeoutMs: 10, retryTimeoutMs: 20 });
  assert.equal(outcome.kind, "timeout");
  assert.deepEqual(seen.map(probe => probe.timeout), [10, 20]);
  assert.deepEqual(seen[0].args, ["-I", "-c", "import encodings, sys; print(sys.prefix)"]);
  const warnings = [];
  assert.doesNotThrow(() => requireGatewayRuntime("python", { probe: () => outcome, warn: message => warnings.push(message) }));
  assert.match(warnings[0], /continuing to bounded gateway readiness/u);
  for (const result of [
    { error: Object.assign(new Error("missing interpreter"), { code: "ENOENT" }) },
    { status: 1, stderr: "could not import encodings" },
  ]) {
    let calls = 0;
    const failed = venvRuntimeOutcome("python", { spawn: () => { calls++; return result; } });
    assert.equal(calls, 1, "permanent failures do not spend a scheduling retry");
    assert.equal(failed.kind, "failed");
    assert.throws(() => requireGatewayRuntime("python", { probe: () => failed, dependencyFix: "repair dependencies" }), /virtual environment is broken/u);
  }
});

test("successful retry and existing descriptive probe API retain their meaning", () => {
  let calls = 0;
  assert.deepEqual(venvRuntimeOutcome("python", { spawn: () => ++calls === 1
    ? { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) } : { status: 0 } }), { kind: "ok" });
  assert.equal(venvRuntimeProblem("python", { spawn: () => ({ status: 0 }) }), undefined);
  assert.match(venvRuntimeProblem("python", { spawn: () => ({ status: 1, stderr: "invalid stdlib" }) }), /invalid stdlib/u);
});
