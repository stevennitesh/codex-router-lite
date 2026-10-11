import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STARTUP_BUDGETS,
  superviseGateway,
  superviseOptionalChild,
} from "../src/gateway-supervisor.mjs";

function child(exitCode = null) {
  return { exitCode, signalCode: null };
}

test("an alive replacement keeps its cold import across bounded health budgets", async () => {
  const initial = child(1);
  const replacement = child();
  let healthAttempts = 0;
  let stopCalls = 0;
  let shuttingDown = false;
  const logs = [];

  const result = await superviseGateway({
    child: initial,
    start: () => replacement,
    waitForExit: async (current, label) => {
      if (current === initial) return { label, code: 1, signal: null };
      shuttingDown = true;
      current.exitCode = 0;
      return { label, code: 0, signal: null };
    },
    waitForHealth: async () => {
      healthAttempts += 1;
      if (healthAttempts < DEFAULT_STARTUP_BUDGETS) {
        throw new Error("synthetic cold-start timeout");
      }
    },
    stop: () => {
      stopCalls += 1;
    },
    isShuttingDown: () => shuttingDown,
    sleep: async () => {},
    backoffMs: 0,
    maxRestarts: 1,
    startupBudgets: DEFAULT_STARTUP_BUDGETS,
    log: (message) => logs.push(message),
  });

  assert.equal(healthAttempts, DEFAULT_STARTUP_BUDGETS);
  assert.equal(stopCalls, 0, "a live importing replacement must not be killed between budgets");
  assert.equal(
    logs.filter((line) => line.includes("is still starting")).length,
    DEFAULT_STARTUP_BUDGETS - 1,
  );
  assert.equal(result.restarts, 1);
});

test("optional startup waits for actual child completion before retry", async () => {
  const events = [];
  await superviseOptionalChild({ label: "fixture", maxRestarts: 1, backoffMs: 0,
    start: () => { events.push("start"); return child(); },
    waitForHealth: async () => { throw new Error("not ready"); },
    stop: async () => { events.push("terminate"); },
    waitForExit: async () => { await Promise.resolve(); events.push("closed"); },
    sleep: async () => { events.push("backoff"); }, log: () => {},
  });
  assert.deepEqual(events, ["start", "terminate", "closed", "backoff", "start", "terminate", "closed"]);
});

test("failed optional child cleanup forbids another launch", async () => {
  let starts = 0, waits = 0;
  const result = await superviseOptionalChild({ label: "fixture", maxRestarts: 2,
    start: () => { starts++; return child(); }, waitForHealth: async () => { throw new Error("not ready"); },
    stop: async () => { throw new Error("cleanup refused"); }, waitForExit: async () => { waits++; }, log: () => {},
  });
  assert.equal(starts, 1); assert.equal(waits, 0); assert.equal(result.exhausted, true);
});

test("replacement startup retries remain bounded and eventually stop a wedged child", async () => {
  const initial = child(1);
  const replacement = child();
  let healthAttempts = 0;
  let stopCalls = 0;

  const result = await superviseGateway({
    child: initial,
    start: () => replacement,
    waitForExit: async (current, label) => ({
      label,
      code: current.exitCode,
      signal: current.signalCode,
    }),
    waitForHealth: async () => {
      healthAttempts += 1;
      throw new Error("synthetic cold-start timeout");
    },
    stop: (current) => {
      stopCalls += 1;
      current.signalCode = "SIGTERM";
    },
    sleep: async () => {},
    backoffMs: 0,
    maxRestarts: 1,
    startupBudgets: DEFAULT_STARTUP_BUDGETS,
    log: () => {},
  });

  assert.equal(healthAttempts, DEFAULT_STARTUP_BUDGETS);
  assert.equal(stopCalls, 1);
  assert.equal(result.exhausted, true);
});
