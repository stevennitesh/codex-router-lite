import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { watchWebTurnCancellation } from "../src/web-turn-cancellation.mjs";

const THREAD = "01a144be-0020-74f1-bfc1-75d8f5c883fb";
const TURN = "01a1470f-e78f-7451-bf05-6496664a3726";
const FOREIGN = "01a144be-0020-74f1-bfc1-75d8f5c883fa";
const event = (turnId = TURN) => JSON.stringify({ timestamp: "2026-10-16T23:34:35Z",
  type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted" } });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitFor = async predicate => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the rollout poll.");
    await delay(10);
  }
};

async function fixture(t, { contents = "", create = true } = {}) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "router-turn-cancel-"));
  const day = path.join(codexHome, "sessions", "2026", "10", "16");
  const file = path.join(day, `rollout-2026-10-16T07-44-25-${THREAD}.jsonl`);
  await mkdir(day, { recursive: true });
  if (create) await writeFile(file, contents, "utf8");
  const watchers = [];
  t.after(async () => {
    await Promise.all(watchers.map(watcher => watcher.close()));
    await rm(codexHome, { recursive: true, force: true });
  });
  return { codexHome, day, file, watch(options = {}) {
    const watcher = watchWebTurnCancellation({ threadId: THREAD, turnId: TURN,
      codexHome, pollMs: 10, onCancel() {}, ...options });
    watchers.push(watcher);
    return watcher;
  } };
}

test("unchanged polls validate the pathname without reopening and growth resumes exact cancellation reads", async t => {
  const fix = await fixture(t, { contents: event(FOREIGN) + "\n" });
  const originalOpen = fs.open, originalLstat = fs.lstat;
  let opened = 0, checked = 0, cancelled = 0;
  const openMock = t.mock.method(fs, "open", (...args) => {
    if (args[0] === fix.file) opened += 1;
    return originalOpen(...args);
  });
  const lstatMock = t.mock.method(fs, "lstat", async (...args) => {
    const stat = await originalLstat(...args);
    if (args[0] === fix.file) checked += 1;
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => {
    openMock.mock.restore();
    lstatMock.mock.restore();
    syncBuiltinESMExports();
  });
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  await waitFor(() => checked >= 4);
  assert.equal(opened, 1, "idle polls must still check identity without acquiring a file handle");
  assert.equal(cancelled, 0);
  const previousChecks = checked;
  await appendFile(fix.file, event(FOREIGN) + "\n");
  await waitFor(() => checked >= previousChecks + 4);
  assert.equal(opened, 2, "one growth window must be read, then unchanged polls must stop reopening");
  assert.equal(watcher.state, "watching");
  await appendFile(fix.file, event() + "\n");
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(opened, 3);
  assert.equal(cancelled, 1);
});

test("same-size rollout replacement loses authority before an idle poll can skip reading", async t => {
  const fix = await fixture(t, { contents: event(FOREIGN) + "\n" });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  const replacement = path.join(fix.day, "replacement.jsonl");
  await writeFile(replacement, event() + "\n");
  await rename(replacement, fix.file);
  assert.equal((await watcher.finished).error.reason, "rollout_changed");
  assert.equal(watcher.state, "unavailable");
  assert.equal(cancelled, 0);
});

test("native cancellation follows the exact appended event once, including split UTF-8/JSONL", async t => {
  const fix = await fixture(t, { contents: JSON.stringify({ type: "event_msg",
    payload: { type: "task_started", turn_id: TURN } }) + "\n" });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  const irrelevant = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "café" } }) + "\n");
  const split = irrelevant.indexOf(Buffer.from("é")) + 1;
  await appendFile(fix.file, irrelevant.subarray(0, split));
  await delay(30);
  assert.equal(cancelled, 0);
  await appendFile(fix.file, irrelevant.subarray(split));
  const exact = event();
  await appendFile(fix.file, exact.slice(0, -5));
  await delay(30);
  assert.equal(cancelled, 0, "a partial native event is not a cancellation");
  await appendFile(fix.file, exact.slice(-5) + "\n" + event() + "\n");
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(cancelled, 1);
});

test("initial tail catches an already flushed exact abort without reading another session", async t => {
  const ignoredLargeRow = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(700_000) } });
  const fix = await fixture(t, { contents: ignoredLargeRow + "\n" + event() + "\n" });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  assert.equal(cancelled, 1, "an already flushed interruption must retire the turn before readiness permits work");
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(cancelled, 1);
});

test("other turns, absent IDs, user text, foreign sessions and recovery copies cannot cancel", async t => {
  const fakeUser = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: event() } });
  const fix = await fixture(t, { contents: [event("other-turn"),
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }), fakeUser,
    JSON.stringify({ type: "response_item", payload: { type: "turn_aborted", turn_id: TURN } })].join("\n") + "\n" });
  await writeFile(path.join(fix.day, `rollout-2026-10-16T07-44-25-${FOREIGN}.jsonl`), "not JSON\n" + event() + "\n");
  await writeFile(path.join(fix.day, `rollout-copy-${THREAD}.jsonl`), "not JSON\n" + event() + "\n");
  await mkdir(path.join(fix.codexHome, "sessions", "recovery"));
  await writeFile(path.join(fix.codexHome, "sessions", "recovery", `rollout-copy-${THREAD}.jsonl`), event() + "\n");
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  await delay(30);
  assert.equal(watcher.state, "watching");
  assert.equal(cancelled, 0);
  await appendFile(fix.file, event() + "\n");
  await watcher.finished;
  assert.equal(cancelled, 1);
});

test("a rollout created after monitoring begins is discovered before readiness", async t => {
  const fix = await fixture(t, { create: false });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await writeFile(fix.file, event() + "\n", "utf8");
  await watcher.ready;
  await watcher.finished;
  assert.equal(cancelled, 1);
});

test("closing an active or pending watcher ends observation without a cancellation", async t => {
  const fix = await fixture(t);
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  await watcher.close();
  await watcher.close();
  await appendFile(fix.file, event() + "\n");
  await delay(30);
  assert.equal(watcher.state, "closed");
  assert.equal(cancelled, 0);
  await rm(fix.file);
  const pending = fix.watch({ onCancel: () => { cancelled += 1; } });
  await pending.close();
  await pending.ready;
  assert.equal((await pending.finished).state, "closed");
  assert.equal(cancelled, 0);
});

test("truncation, replacement and invalid complete rows lose authority without inventing cancellation", async t => {
  for (const failure of ["truncate", "replace", "invalid"]) {
    const fix = await fixture(t, { contents: JSON.stringify({ type: "session_meta" }) + "\n" });
    let cancelled = 0, unavailable;
    const watcher = fix.watch({ onCancel: () => { cancelled += 1; }, onUnavailable: error => { unavailable = error; } });
    await watcher.ready;
    if (failure === "truncate") await truncate(fix.file, 0);
    if (failure === "replace") {
      const replacement = path.join(fix.day, "replacement.jsonl");
      await writeFile(replacement, event() + "\n");
      await rename(replacement, fix.file);
    }
    if (failure === "invalid") await appendFile(fix.file, "invalid-private-body\n");
    const result = await watcher.finished;
    assert.equal(result.state, "unavailable");
    assert.equal(cancelled, 0);
    assert.equal(unavailable.code, "WEB_TURN_CANCELLATION_UNAVAILABLE");
    assert.ok(!unavailable.message.includes("private"));
    assert.ok(!unavailable.message.includes(fix.file));
    assert.equal(unavailable.reason, failure === "truncate" ? "rollout_truncated"
      : failure === "replace" ? "rollout_changed" : "rollout_invalid");
  }
});

test("ambiguous exact-thread files reject readiness without choosing a conversation", async t => {
  const fix = await fixture(t);
  await writeFile(path.join(fix.day, `rollout-2026-10-16T07-44-26-${THREAD}.jsonl`), event() + "\n");
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await assert.rejects(watcher.ready, { code: "WEB_TURN_CANCELLATION_UNAVAILABLE", reason: "rollout_ambiguous" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(cancelled, 0);
});

test("watching is read-only and rejects arbitrary path-shaped thread or turn identities", async t => {
  const contents = event("other-turn") + "\n";
  const fix = await fixture(t, { contents });
  for (const options of [{ threadId: "../../outside" }, { turnId: "../outside" }, { threadId: FOREIGN + ".jsonl" }]) {
    assert.throws(() => fix.watch(options), TypeError);
  }
  const watcher = fix.watch();
  await watcher.ready;
  await watcher.close();
  assert.equal(await readFile(fix.file, "utf8"), contents);
});

test("a missing native rollout reports bounded unavailability rather than a fake cancellation", async t => {
  const fix = await fixture(t, { create: false });
  let cancelled = 0, unavailable = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; },
    onUnavailable: error => { unavailable += 1; assert.equal(error.reason, "rollout_missing"); } });
  await assert.rejects(watcher.ready, { code: "WEB_TURN_CANCELLATION_UNAVAILABLE", reason: "rollout_missing" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(cancelled, 0);
  assert.equal(unavailable, 1);
});
