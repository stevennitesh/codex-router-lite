import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { waitForRouterHealth } from "../src/router-health.mjs";
import { waitForServiceReadiness } from "../src/service-readiness.mjs";
import { captureLogPosition, diagnoseWindowsLaunchFailure, readLogTail } from "../src/windows-launch-diagnosis.mjs";

const deadTask = async () => ({ launcherAlive: false, instanceCount: 0, lastTaskResult: 42 });
const fixtureLog = new URL("./fixtures/absent-readiness.log", import.meta.url);

test("readiness uses only new launch output, even when unrelated output updates an old log", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-launch-log-"));
  try {
    const entry = path.join(directory, "repaired.cjs"), log = path.join(directory, "router.log");
    const previous = spawnSync(process.execPath, [entry], { encoding: "utf8", windowsHide: true });
    assert.equal(previous.status, 1); assert.match(previous.stderr, /MODULE_NOT_FOUND/u);
    writeFileSync(entry, "// repaired and readable\n");
    assert.equal(spawnSync(process.execPath, [entry], { windowsHide: true }).status, 0);
    const fresh = path.join(directory, "new-absent.cjs");
    for (const mode of ["unchanged", "unrelated-append", "new-module-error"]) {
      writeFileSync(log, previous.stderr);
      const position = captureLogPosition(log);
      let query = false;
      await assert.rejects(waitForServiceReadiness({ timeoutMs: 500, pollMs: 1, launchGraceMs: 0,
        logPath: log, logPosition: position,
        waitForHealth: async ({ signal }) => { await delay(30_000, undefined, { signal }); },
        getWindowsTaskState: async () => {
          assert.equal(query, false); query = true;
          if (mode === "unrelated-append") appendFileSync(log, "\nnew attempt failed for another reason\n");
          if (mode === "new-module-error") appendFileSync(log, `\nCannot find module '${fresh}'\n`);
          return { launcherAlive: false, instanceCount: 0, lastTaskResult: 42 };
        },
      }), error => {
        assert.match(error.message, /LastTaskResult=0x2a/u); assert.ok(!error.message.includes(entry));
        if (mode === "new-module-error") { assert.ok(error.message.includes(fresh)); assert.match(error.message, /absent now/u); }
        else assert.doesNotMatch(error.message, /Node could not resolve|task.*token/iu);
        return true;
      });
    }
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^router-launch-log-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("log cursors handle absent, truncated, rotated and unavailable logs with bounded reads", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-launch-log-"));
  try {
    const log = path.join(directory, "router.log"), missing = captureLogPosition(log);
    assert.equal(readLogTail(log, { after: missing }), "");
    writeFileSync(log, "first output"); assert.equal(readLogTail(log, { after: missing }), "first output");
    const unchanged = captureLogPosition(log);
    assert.equal(readLogTail(log, { after: unchanged }), "");
    assert.equal(readLogTail(log, { after: { unavailable: true } }), "");
    writeFileSync(log, "old ".repeat(100)); const past = new Date(Date.now() - 60_000); utimesSync(log, past, past);
    const beforeTruncate = captureLogPosition(log); writeFileSync(log, "new short output");
    assert.equal(readLogTail(log, { after: beforeTruncate }), "new short output");
    utimesSync(log, past, past); const beforeRotate = captureLogPosition(log);
    renameSync(log, path.join(directory, "router.old")); writeFileSync(log, "new rotated output");
    assert.equal(readLogTail(log, { after: beforeRotate }), "new rotated output");
    const cursor = captureLogPosition(log); appendFileSync(log, "x".repeat(100_000));
    assert.equal(Buffer.byteLength(readLogTail(log, { after: cursor })), 64 * 1024);
    assert.equal(readLogTail(log, { after: cursor, maxBytes: 32 }), "x".repeat(32));
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^router-launch-log-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("module resolution and current presence never establish a task-token cause", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-launch-log-"));
  try {
    const emptyPackage = path.join(directory, "package"); mkdirSync(emptyPackage);
    const loader = spawnSync(process.execPath, ["-e", "require(process.argv[1])", emptyPackage], { encoding: "utf8", windowsHide: true });
    assert.equal(loader.status, 1); assert.match(loader.stderr, /MODULE_NOT_FOUND/u);
    const explanation = diagnoseWindowsLaunchFailure({ logText: loader.stderr });
    assert.match(explanation, /not a regular file/u); assert.doesNotMatch(explanation, /token could not read|grant.*account/u);
    const entry = path.join(directory, "regular.cjs"); writeFileSync(entry, "// readable\n");
    assert.match(diagnoseWindowsLaunchFailure({ logText: `Cannot find module '${entry}'` }), /presence alone does not identify/u);
    assert.match(diagnoseWindowsLaunchFailure({ logText: "Cannot find module 'package-name'" }), /installed dependencies/u);
    assert.match(diagnoseWindowsLaunchFailure({ logText: `Cannot find module '${entry}'`, inspect: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /could not be inspected by this process/u);
    assert.equal(diagnoseWindowsLaunchFailure({ logText: "no loader evidence" }), undefined);
    assert.equal(readFileSync(entry, "utf8"), "// readable\n");
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^router-launch-log-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const healthy of [true, false]) {
  test(`a pending task query is canceled by ${healthy ? "successful health" : "the readiness deadline"}`, { timeout: 5_000 }, async () => {
    let querying, querySettled = false, observedBudget, observedSignal;
    const started = new Promise(resolve => { querying = resolve; });
    const operation = waitForServiceReadiness({ timeoutMs: healthy ? 2_000 : 80, pollMs: 1, launchGraceMs: 0,
      waitForHealth: async ({ signal }) => {
        await started;
        if (healthy) { await delay(10); return { ok: true }; }
        await delay(30_000, undefined, { signal });
      },
      getWindowsTaskState: async ({ timeoutMs, signal }) => {
        observedBudget = timeoutMs; observedSignal = signal; querying();
        try { await delay(30_000, undefined, { signal }); return { launcherAlive: false, instanceCount: 0, lastTaskResult: 42 }; }
        finally { querySettled = true; }
      },
    });
    if (healthy) assert.equal((await operation).ok, true);
    else await assert.rejects(operation, /readiness deadline/u);
    assert.equal(querySettled, true);
    assert.equal(observedSignal.aborted, true);
    assert.ok(observedBudget > 0 && observedBudget <= (healthy ? 2_000 : 80));
  });
}

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
