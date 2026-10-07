import assert from "node:assert/strict";
import test from "node:test";

import { waitForRouterHealth } from "../src/router-health.mjs";
import { waitForServiceReadiness } from "../src/service-readiness.mjs";

const deadTask = async () => ({ launcherAlive: false, instanceCount: 0, lastTaskResult: 42 });
const fixtureLog = new URL("./fixtures/absent-readiness.log", import.meta.url);

test("task death cancels and settles the actual pending health fetch", { timeout: 5_000 }, async () => {
  let probes = 0, active = false, settled = false;
  await assert.rejects(waitForServiceReadiness({
    timeoutMs: 30_000, launchGraceMs: 0, pollMs: 1, getWindowsTaskState: deadTask, logPath: fixtureLog,
    waitForHealth: async options => {
      try {
        return await waitForRouterHealth({ ...options, fetchImpl: async (_url, { signal }) => {
          probes++; active = true;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => { active = false; reject(signal.reason); }, { once: true });
          });
        } });
      } finally { settled = true; }
    },
  }), /no running launcher.*LastTaskResult=0x2a/u);
  assert.equal(probes, 1);
  assert.equal(active, false);
  assert.equal(settled, true, "losing health work is settled before readiness rejects");
});

test("task death cancels the health interval without another probe", { timeout: 5_000 }, async () => {
  let probes = 0, settled = false;
  await assert.rejects(waitForServiceReadiness({
    timeoutMs: 30_000, launchGraceMs: 0, pollMs: 1, getWindowsTaskState: deadTask, logPath: fixtureLog,
    waitForHealth: async options => {
      try {
        return await waitForRouterHealth({ ...options, intervalMs: 30_000, fetchImpl: async () => {
          probes++;
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        } });
      } finally { settled = true; }
    },
  }), /no running launcher/u);
  assert.equal(probes, 1);
  assert.equal(settled, true);
});

test("inconclusive task queries retain the shared health attempt", { timeout: 5_000 }, async () => {
  let resolveHealth, signal, queries = 0;
  const health = { ok: true, payload: { service: "codex-router" } };
  const result = await waitForServiceReadiness({
    timeoutMs: 5_000, launchGraceMs: 0, pollMs: 1,
    waitForHealth: options => {
      signal = options.signal;
      return new Promise(resolve => { resolveHealth = resolve; });
    },
    getWindowsTaskState: async () => {
      assert.equal(signal.aborted, false);
      if (++queries === 1) throw new Error("query unavailable");
      resolveHealth(health);
      return undefined;
    },
  });
  assert.equal(result, health);
  assert.equal(queries, 2);
  assert.equal(signal.aborted, true, "the operation also retires its losing poll timer");
});

test("readiness deadline cancels and settles a losing health attempt", { timeout: 5_000 }, async () => {
  let active = false, settled = false;
  await assert.rejects(waitForServiceReadiness({
    timeoutMs: 20, pollMs: 1, getWindowsTaskState: async () => undefined,
    waitForHealth: async ({ signal }) => {
      active = true;
      try {
        return await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => { active = false; reject(signal.reason); }, { once: true });
        });
      } finally { settled = true; }
    },
  }), /readiness deadline/u);
  assert.equal(active, false);
  assert.equal(settled, true);
});

test("health one-shot probes and explicit cancellation retain separate meanings", async () => {
  let probes = 0;
  assert.equal((await waitForRouterHealth({ timeoutMs: 0, fetchImpl: async () => {
    probes++;
    return new Response(JSON.stringify({ service: "codex-router" }));
  } })).ok, true);
  assert.equal(probes, 1);
  const ready = await waitForServiceReadiness({
    timeoutMs: 0,
    getWindowsTaskState: async () => assert.fail("one-shot readiness does not poll task state"),
    waitForHealth: options => waitForRouterHealth({ ...options, fetchImpl: async () => {
      probes++;
      return new Response(JSON.stringify({ service: "codex-router" }));
    } }),
  });
  assert.equal(ready.ok, true);
  assert.equal(probes, 2);
  const controller = new AbortController();
  const reason = new Error("operation ended"); controller.abort(reason);
  await assert.rejects(waitForRouterHealth({ signal: controller.signal, fetchImpl: async () => {
    assert.fail("an aborted operation must not probe");
  } }), error => error === reason);
});
