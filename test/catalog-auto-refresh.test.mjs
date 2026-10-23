import assert from "node:assert/strict";
import test from "node:test";

import { startCatalogAutoRefresh } from "../src/catalog-auto-refresh.mjs";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("catalog scheduler checks immediately, skips overlap, and reports changes only", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const checks = [], messages = [];
  const stop = startCatalogAutoRefresh({
    intervalMs: 10_000,
    refresh: () => new Promise(resolve => checks.push(resolve)),
    log: message => messages.push(message),
  });
  assert.equal(checks.length, 1, "the first check does not wait for its interval");
  t.mock.timers.tick(30_000);
  assert.equal(checks.length, 1, "a slow refresh owns every intervening tick");
  checks[0]({ changed: false });
  await flush();
  assert.deepEqual(messages, []);
  t.mock.timers.tick(10_000);
  assert.equal(checks.length, 2);
  checks[1]({ changed: true });
  await flush();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Fully quit and reopen Codex/u);
  await stop();
  t.mock.timers.tick(30_000);
  assert.equal(checks.length, 2, "stopped schedulers never launch another refresh");
});

test("catalog scheduler reports synchronous and asynchronous failures and retries on schedule", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let checks = 0;
  const messages = [];
  const stop = startCatalogAutoRefresh({
    intervalMs: 10_000,
    refresh: () => {
      checks++;
      if (checks === 1) throw new Error("synchronous launch refusal");
      if (checks === 2) return Promise.reject(new Error("asynchronous refresh refusal"));
      return Promise.resolve({ changed: false });
    },
    log: message => messages.push(message),
  });
  t.mock.timers.tick(10_000);
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(checks, 3);
  assert.deepEqual(messages, [
    "automatic catalog refresh failed: synchronous launch refusal",
    "automatic catalog refresh failed: asynchronous refresh refusal",
  ]);
  await stop();
});

test("catalog scheduler cancellation retains custody until its active operation settles", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish, signal, checks = 0;
  const messages = [];
  const stop = startCatalogAutoRefresh({
    intervalMs: 10_000,
    refresh: options => {
      checks++;
      signal = options.signal;
      return new Promise((_, reject) => { finish = () => reject(signal.reason); });
    },
    log: message => messages.push(message),
  });
  let closed = false;
  const stopped = stop().then(() => { closed = true; });
  assert.equal(signal.aborted, true);
  await flush();
  assert.equal(closed, false, "requesting cancellation is not terminal completion");
  t.mock.timers.tick(30_000);
  assert.equal(checks, 1);
  finish();
  await stopped;
  await stop();
  assert.equal(closed, true);
  assert.deepEqual(messages, [], "cooperative shutdown is not an automatic-refresh failure");
});

test("catalog scheduler exposes cancellation cleanup failure to its supervisor", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const failure = new Error("owned refresh tree cleanup failed");
  const messages = [];
  const stop = startCatalogAutoRefresh({
    refresh: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(failure), { once: true });
    }),
    log: message => messages.push(message),
  });
  await assert.rejects(stop(), error => error === failure);
  assert.deepEqual(messages, ["automatic catalog refresh failed: owned refresh tree cleanup failed"]);
});
