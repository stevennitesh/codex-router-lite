import assert from "node:assert/strict";
import test from "node:test";
import { venvRuntimeOutcome, venvRuntimeProblem } from "../src/venv-runtime.mjs";

test("interpreter scheduling timeout remains inconclusive while actual failures prove a failed probe", () => {
  const seen = [];
  const spawn = (_python, args, options) => {
    seen.push({ args, timeout: options.timeout });
    return { error: Object.assign(new Error("scheduling timeout"), { code: "ETIMEDOUT" }) };
  };
  const outcome = venvRuntimeOutcome("python", { spawn, timeoutMs: 10, retryTimeoutMs: 20 });
  assert.equal(outcome.kind, "timeout");
  assert.deepEqual(seen.map(probe => probe.timeout), [10, 20]);
  assert.deepEqual(seen[0].args, ["-I", "-c", "import encodings, sys; print(sys.prefix)"]);
  for (const result of [
    { error: Object.assign(new Error("missing interpreter"), { code: "ENOENT" }) },
    { status: 1, stderr: "could not import encodings" },
  ]) {
    let calls = 0;
    const failed = venvRuntimeOutcome("python", { spawn: () => { calls++; return result; } });
    assert.equal(calls, 1, "permanent failures do not spend a scheduling retry");
    assert.equal(failed.kind, "failed");
  }
});

test("successful retry and existing descriptive probe API retain their meaning", () => {
  let calls = 0;
  assert.deepEqual(venvRuntimeOutcome("python", { spawn: () => ++calls === 1
    ? { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) } : { status: 0 } }), { kind: "ok" });
  assert.equal(venvRuntimeProblem("python", { spawn: () => ({ status: 0 }) }), undefined);
  assert.match(venvRuntimeProblem("python", { spawn: () => ({ status: 1, stderr: "invalid stdlib" }) }), /invalid stdlib/u);
});
