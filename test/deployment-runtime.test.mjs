import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertDeploymentRuntime } from "../src/deployment-acceptance.mjs";

const root = path.resolve("packaged-router");
const healthy = { ok: true, status: 200, service: "codex-router", degraded: [] };
function boundaries(overrides = {}) {
  return {
    timeoutMs: 0,
    readHealth: async () => healthy,
    readTask: async () => ({ installed: true, loaded: true, state: "running" }),
    readProcess: () => ({ sourceRoot: root }),
    ownsProcess: () => true,
    readManifest: () => ({ version: 1, current: { target: "codex", sourceRoot: root, commit: null } }),
    ...overrides,
  };
}

test("packaged acceptance requires full health and installed identity without Git metadata", async () => {
  const result = await assertDeploymentRuntime(root, boundaries());
  assert.equal(result.accepted, true);
  assert.deepEqual(result.checks, { routerFullHealth: true, taskIdentity: true, processIdentity: true, installManifest: true });
  for (const health of [
    { ...healthy, ok: false }, { ...healthy, status: 503 },
    { ...healthy, service: "other-service" }, { ...healthy, degraded: ["gateway"] },
    { ...healthy, degraded: undefined },
  ]) {
    await assert.rejects(assertDeploymentRuntime(root, boundaries({ readHealth: async () => health })), /full health failed/u);
  }
  for (const task of [
    { installed: false, loaded: true, state: "running" },
    { installed: true, loaded: false, state: "running" },
    { installed: true, loaded: true, state: "stopped" },
  ]) {
    await assert.rejects(assertDeploymentRuntime(root, boundaries({ readTask: async () => task })), /task identity/u);
  }
  await assert.rejects(assertDeploymentRuntime(root, boundaries({ ownsProcess: () => false })), /process identity/u);
  await assert.rejects(assertDeploymentRuntime(root, boundaries({ readProcess: () => ({ sourceRoot: path.resolve("foreign") }) })), /process identity/u);
  for (const current of [{ target: "codex", sourceRoot: path.resolve("foreign") }, { target: "other", sourceRoot: root }]) {
    await assert.rejects(assertDeploymentRuntime(root, boundaries({ readManifest: () => ({ version: 1, current }) })), /install manifest/u);
  }
});

test("full health converges within a bounded window and caps its final request and pause", async () => {
  for (const converges of [false, true]) {
    let clock = 0;
    const budgets = [], pauses = [];
    const operation = assertDeploymentRuntime(root, boundaries({
      timeoutMs: 800, now: () => clock,
      readHealth: async ({ timeoutMs }) => {
        budgets.push(timeoutMs); clock += Math.min(100, timeoutMs);
        return converges && budgets.length === 2 ? healthy : { ...healthy, degraded: ["gateway"] };
      },
      pause: async (ms) => { pauses.push(ms); clock += ms; },
    }));
    if (converges) {
      assert.equal((await operation).accepted, true);
      assert.deepEqual(budgets, [800, 200]);
    } else {
      await assert.rejects(operation, /degraded dependencies: gateway/u);
      assert.ok(clock <= 801);
      assert.ok(pauses.every((ms) => ms <= 500 && ms >= 0));
      assert.equal(budgets.at(-1), 1);
    }
  }
});
