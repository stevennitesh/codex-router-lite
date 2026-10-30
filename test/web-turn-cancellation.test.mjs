import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, truncate, writeFile } from "node:fs/promises";
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
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, { contents = "", create = true, sessions = true } = {}) {
  const codexHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "router-turn-cancel-")));
  const day = path.join(codexHome, "sessions", "2026", "10", "16");
  const file = path.join(day, `rollout-2026-10-16T07-44-25-${THREAD}.jsonl`);
  if (sessions) await mkdir(day, { recursive: true });
  if (create) await writeFile(file, contents, "utf8");
  const watchers = [];
  t.after(async () => {
    await Promise.all(watchers.map(watcher => watcher.close()));
    await rm(codexHome, { recursive: true, force: true });
  });
  return { codexHome, day, file, watch(options = {}) {
    const watcher = watchWebTurnCancellation({ threadId: THREAD, turnId: TURN,
      codexHome, onCancel() {}, ...options });
    watchers.push(watcher);
    return watcher;
  } };
}

// Real file reads, with explicit directory notifications and I/O barriers.
// Negative assertions follow completed reads/checks rather than timing delays.
function control(t, fix, hooks = {}) {
  const originalOpen = fs.open, originalLstat = fs.lstat;
  const activity = new EventEmitter(), subscribed = deferred(), sessionsSubscribed = deferred();
  const counts = { open: 0, read: 0, close: 0, check: 0, watchClose: 0, rootMissing: 0 };
  const openedPaths = [];
  const handles = new Map();
  const sessionsPath = path.join(fix.codexHome, "sessions");
  const mark = key => { counts[key] += 1; activity.emit("activity"); };
  const mocks = [
    t.mock.method(nativeFs, "watch", (directory, options, listener) => {
      assert.ok([fix.codexHome, sessionsPath].includes(directory));
      assert.equal(options.recursive, directory === sessionsPath);
      if (directory === sessionsPath && hooks.failSessionsSubscribe) throw new Error("private subscription failure");
      const handle = new EventEmitter();
      handle.close = () => {
        mark("watchClose");
        if (!hooks.holdWatchClose) queueMicrotask(() => handle.emit("close"));
      };
      handles.set(directory, { handle, callback: listener });
      if (directory === fix.codexHome) subscribed.resolve();
      else sessionsSubscribed.resolve();
      return handle;
    }),
    t.mock.method(fs, "open", async (...args) => {
      openedPaths.push(args[0]);
      if (args[0] === fix.file) assert.ok(handles.has(sessionsPath), "subscribe to sessions before reading");
      const file = await originalOpen(...args);
      if (args[0] !== fix.file) return file;
      mark("open");
      const originalRead = file.read.bind(file), originalClose = file.close.bind(file);
      file.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        await hooks.afterRead?.(result);
        mark("read");
        return result;
      };
      file.close = async () => { await originalClose(); mark("close"); await hooks.afterClose?.(); };
      return file;
    }),
    t.mock.method(fs, "lstat", async (...args) => {
      let stat;
      try { stat = await originalLstat(...args); }
      catch (error) {
        if (args[0] === sessionsPath && error.code === "ENOENT") mark("rootMissing");
        throw error;
      }
      if (args[0] === fix.file) mark("check");
      return stat;
    }),
  ];
  syncBuiltinESMExports();
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
  return {
    counts, openedPaths, subscribed: subscribed.promise, sessionsSubscribed: sessionsSubscribed.promise,
    notify(type = "change", filename = path.relative(fix.codexHome, fix.file)) {
      const changed = filename == null ? null : path.resolve(fix.codexHome, filename);
      const child = handles.get(sessionsPath);
      if (child && (changed == null || changed.startsWith(sessionsPath + path.sep))) {
        child.callback(type, changed == null ? null : path.relative(sessionsPath, changed));
      } else handles.get(fix.codexHome).callback(type, filename);
    },
    fail(root = sessionsPath) { handles.get(root).handle.emit("error", new Error("private filesystem detail")); },
    end() { for (const { handle } of handles.values()) handle.emit("close"); },
    async through(kind, target) { while (counts[kind] < target) await once(activity, "activity"); },
  };
}

test("discovery stays under the subscribed canonical home when the caller alias retargets", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event(FOREIGN) + "\n" });
  const other = await fixture(t, { contents: event(FOREIGN) + "\n" });
  const alias = path.join(fix.codexHome, "home-alias");
  const originalRealpath = fs.realpath;
  let aliasReads = 0;
  const mock = t.mock.method(fs, "realpath", async (...args) => {
    if (args[0] === alias) return ++aliasReads === 1 ? fix.codexHome : other.codexHome;
    return originalRealpath(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const io = control(t, fix);
  let cancelled = 0;
  const watcher = fix.watch({ codexHome: alias, onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  assert.deepEqual(io.openedPaths, [fix.file], "only the rollout under the subscribed root may be read");
  assert.equal(aliasReads, 1, "canonical home is bound once before subscription");
  await appendFile(fix.file, event() + "\n");
  io.notify();
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(cancelled, 1);
});

test("subscription precedes the initial read and catches an append during that read", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event(FOREIGN) + "\n" });
  const started = deferred(), release = deferred();
  let first = true, cancelled = 0;
  const io = control(t, fix, { async afterRead() {
    if (first) { first = false; started.resolve(); await release.promise; }
  } });
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await io.subscribed;
  await started.promise;
  try {
    await appendFile(fix.file, event() + "\n");
    io.notify();
  } finally { release.resolve(); }
  await watcher.ready;
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(cancelled, 1);
  assert.equal(io.counts.open, 2, "append beyond initial stat drains before readiness");
  assert.equal(io.counts.close, 2);
  assert.equal(io.counts.watchClose, 2);
});

test("coalesced change/rename bursts queue catchup while a window is in flight", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event(FOREIGN) + "\n" });
  const started = deferred(), release = deferred();
  let hold = false;
  const io = control(t, fix, { async afterRead() {
    if (hold) { hold = false; started.resolve(); await release.promise; }
  } });
  const watcher = fix.watch();
  await watcher.ready;
  hold = true;
  await appendFile(fix.file, event(FOREIGN) + "\n");
  io.notify();
  await started.promise;
  try {
    await appendFile(fix.file, event(FOREIGN) + "\n" + event() + "\n");
    for (let index = 0; index < 100; index += 1) io.notify(index % 2 ? "rename" : "change");
  } finally { release.resolve(); }
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(io.counts.open, 3);
  assert.equal(io.counts.close, 3);
});

test("unchanged directory events validate identity without opening the rollout", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event(FOREIGN) + "\n" });
  const io = control(t, fix);
  const watcher = fix.watch();
  await watcher.ready;
  io.notify("change", "router.log");
  io.notify("rename", path.relative(fix.codexHome, path.join(fix.day, "other.jsonl")));
  const checks = io.counts.check;
  io.notify();
  await io.through("check", checks + 1);
  await watcher.close();
  assert.equal(io.counts.open, 1);
  assert.equal(io.counts.close, 1);
});

test("same-size atomic replacement is rejected at the authoritative read", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event(FOREIGN) + "\n" });
  const io = control(t, fix);
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  assert.equal(io.counts.close, 1, "observer releases its handle before replacement");
  const replacement = path.join(fix.day, "replacement.jsonl");
  await writeFile(replacement, event() + "\n");
  await rename(replacement, fix.file);
  assert.equal(await readFile(fix.file, "utf8"), event() + "\n");
  io.notify("rename");
  assert.equal((await watcher.finished).error.reason, "rollout_changed");
  assert.equal(cancelled, 0);
  assert.equal(io.counts.open, 1, "replacement bytes never gain authority");
});

test("replacement racing file closure invalidates its old handle's abort", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event() + "\n" });
  const started = deferred(), release = deferred();
  const io = control(t, fix, { async afterClose() { started.resolve(); await release.promise; } });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await started.promise;
  const replacement = path.join(fix.day, "replacement.jsonl");
  try {
    await writeFile(replacement, event() + "\n");
    await rename(replacement, fix.file);
    io.notify("rename");
  } finally { release.resolve(); }
  await assert.rejects(watcher.ready, { reason: "rollout_changed" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(cancelled, 0);
  assert.equal(io.counts.close, 1);
});

test("split UTF-8 and partial JSONL wait for complete exact-turn interruption", { timeout: 5_000 }, async t => {
  const fix = await fixture(t);
  const io = control(t, fix);
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  const irrelevant = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "café" } }) + "\n");
  const split = irrelevant.indexOf(Buffer.from("é")) + 1;
  await appendFile(fix.file, irrelevant.subarray(0, split));
  io.notify();
  await io.through("close", 2);
  assert.equal(cancelled, 0);
  await appendFile(fix.file, irrelevant.subarray(split));
  await appendFile(fix.file, event().slice(0, -5));
  io.notify("rename");
  await io.through("close", 3);
  assert.equal(cancelled, 0, "a partial abort cannot cancel");
  await appendFile(fix.file, event().slice(-5) + "\n" + event() + "\n");
  io.notify("change", null);
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(cancelled, 1);
});

test("initial bounded tail catches an already flushed exact abort", { timeout: 5_000 }, async t => {
  const large = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(700_000) } });
  const fix = await fixture(t, { contents: large + "\n" + event() + "\n" });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  assert.equal(cancelled, 1, "initial interrupt retires the turn before readiness");
  assert.equal((await watcher.finished).state, "cancelled");
});

test("foreign turns, user text, foreign sessions and recovery copies cannot cancel", { timeout: 5_000 }, async t => {
  const fakeUser = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: event() } });
  const fix = await fixture(t, { contents: [event("other-turn"),
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }), fakeUser,
    JSON.stringify({ type: "response_item", payload: { type: "turn_aborted", turn_id: TURN } })].join("\n") + "\n" });
  await writeFile(path.join(fix.day, `rollout-2026-10-16T07-44-25-${FOREIGN}.jsonl`), "not JSON\n" + event() + "\n");
  await writeFile(path.join(fix.day, `rollout-copy-${THREAD}.jsonl`), "not JSON\n" + event() + "\n");
  await mkdir(path.join(fix.codexHome, "sessions", "recovery"));
  await writeFile(path.join(fix.codexHome, "sessions", "recovery", `rollout-copy-${THREAD}.jsonl`), event() + "\n");
  const io = control(t, fix);
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await watcher.ready;
  assert.equal(watcher.state, "watching");
  assert.equal(cancelled, 0);
  await appendFile(fix.file, event() + "\n");
  io.notify();
  await watcher.finished;
  assert.equal(cancelled, 1);
});

test("a rollout created after subscription is discovered from queued directory events", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { create: false });
  const io = control(t, fix);
  const watcher = fix.watch();
  await io.subscribed;
  await writeFile(fix.file, event() + "\n");
  io.notify("rename");
  await watcher.ready;
  assert.equal((await watcher.finished).state, "cancelled");
});

test("a missing sessions root can appear after parent subscription without observer writes", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { create: false, sessions: false });
  const io = control(t, fix);
  const watcher = fix.watch();
  await io.subscribed;
  await io.through("rootMissing", 1);
  await assert.rejects(fs.lstat(path.join(fix.codexHome, "sessions")), { code: "ENOENT" });
  assert.equal(watcher.state, "pending");
  assert.equal(io.counts.open, 0);
  await mkdir(fix.day, { recursive: true });
  await writeFile(fix.file, event(FOREIGN) + "\n");
  io.notify("rename", "sessions");
  await io.sessionsSubscribed;
  await watcher.ready;
  await appendFile(fix.file, event() + "\n");
  io.notify();
  assert.equal((await watcher.finished).state, "cancelled");
  assert.equal(io.counts.watchClose, 2);
});

test("a sessions root remaining absent reaches only the existing failure deadline", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { create: false, sessions: false });
  const io = control(t, fix);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watcher = fix.watch({ onCancel() { assert.fail("missing root cancelled"); } });
  await io.through("rootMissing", 1);
  t.mock.timers.tick(5_000);
  await assert.rejects(watcher.ready, { reason: "rollout_missing" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(io.counts.open, 0);
  assert.equal(io.counts.watchClose, 1);
  await assert.rejects(fs.lstat(path.join(fix.codexHome, "sessions")), { code: "ENOENT" });
});

test("ancestor archive rename loses authority without blocking the directory move", { timeout: 5_000 }, async t => {
  const fix = await fixture(t);
  const io = control(t, fix);
  const watcher = fix.watch({ onCancel() { assert.fail("archive cancelled"); } });
  await watcher.ready;
  assert.equal(io.counts.close, 1);
  await rename(fix.day, path.join(fix.codexHome, "archived-day"));
  io.notify("rename", path.relative(fix.codexHome, fix.day));
  assert.equal((await watcher.finished).state, "unavailable");
});

test("sessions-root replacement is signalled by the nonrecursive parent and loses authority", { timeout: 5_000 }, async t => {
  const fix = await fixture(t);
  const io = control(t, fix);
  const watcher = fix.watch({ onCancel() { assert.fail("replaced sessions root cancelled"); } });
  await watcher.ready;
  await rename(path.join(fix.codexHome, "sessions"), path.join(fix.codexHome, "archived-sessions"));
  await mkdir(fix.day, { recursive: true });
  await writeFile(fix.file, event() + "\n");
  io.notify("rename", "sessions");
  assert.equal((await watcher.finished).error.reason, "rollout_changed");
});

test("background tool completion leaves the watcher alive for the owning native turn", { timeout: 5_000 }, async t => {
  const fix = await fixture(t);
  const io = control(t, fix);
  const watcher = fix.watch();
  await watcher.ready;
  for (const type of ["task_complete", "exec_command_end", "agent_message"]) {
    const closed = io.counts.close;
    await appendFile(fix.file, JSON.stringify({ type: "event_msg", payload: { type, turn_id: TURN } }) + "\n");
    io.notify();
    await io.through("close", closed + 1);
    assert.equal(watcher.state, "watching");
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.timers.tick(24 * 60 * 60 * 1_000);
  assert.equal(watcher.state, "watching", "elapsed time cannot retire an active turn");
  await appendFile(fix.file, event() + "\n");
  io.notify();
  assert.equal((await watcher.finished).state, "cancelled");
});

test("close drains an in-flight read and directory closure before resolving", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event() + "\n" });
  const started = deferred(), release = deferred();
  const io = control(t, fix, { holdWatchClose: true, async afterRead() { started.resolve(); await release.promise; } });
  let cancelled = 0, closed = false;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await started.promise;
  const closing = watcher.close().then(() => { closed = true; });
  try {
    assert.equal(io.counts.close, 0);
    assert.equal(closed, false);
  } finally { release.resolve(); }
  await io.through("watchClose", 2);
  assert.equal(io.counts.close, 1);
  assert.equal(closed, false, "read draining alone cannot establish watcher closure");
  io.end();
  await closing;
  await watcher.ready;
  assert.equal((await watcher.finished).state, "closed");
  assert.equal(cancelled, 0);
  await watcher.close();
});

test("close while discovery is pending prevents later notifications from cancelling", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { create: false });
  const io = control(t, fix);
  const watcher = fix.watch({ onCancel() { assert.fail("closed watcher cancelled"); } });
  await io.subscribed;
  await watcher.close();
  await watcher.ready;
  await writeFile(fix.file, event() + "\n");
  io.notify("rename");
  assert.equal((await watcher.finished).state, "closed");
  assert.equal(watcher.state, "closed");
});

test("watch failure during a read drains and rejects readiness without adopting an abort", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event() + "\n" });
  const started = deferred(), release = deferred();
  const io = control(t, fix, { async afterRead() { started.resolve(); await release.promise; } });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await started.promise;
  try { io.fail(); } finally { release.resolve(); }
  await assert.rejects(watcher.ready, { reason: "rollout_watch" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(cancelled, 0);
  assert.equal(io.counts.close, 1);
  assert.equal(io.counts.watchClose, 2);
});

test("unexpected directory watcher closure fails closed after readiness", { timeout: 5_000 }, async t => {
  const fix = await fixture(t);
  const io = control(t, fix);
  const watcher = fix.watch();
  await watcher.ready;
  io.end();
  assert.equal((await watcher.finished).error.reason, "rollout_watch");
});

test("subscription failure rejects readiness without reading a rollout", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event() + "\n" });
  const mock = t.mock.method(nativeFs, "watch", () => { throw new Error("private watch failure"); });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  let cancelled = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; } });
  await assert.rejects(watcher.ready, { code: "WEB_TURN_CANCELLATION_UNAVAILABLE" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(cancelled, 0);
});

test("sessions subscription failure drains the already installed parent watcher", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: event() + "\n" });
  const io = control(t, fix, { failSessionsSubscribe: true });
  const watcher = fix.watch({ onCancel() { assert.fail("unwatched sessions cancelled"); } });
  await assert.rejects(watcher.ready, { reason: "rollout_watch" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(io.counts.open, 0);
  assert.equal(io.counts.watchClose, 1);
});

for (const failure of ["truncate", "invalid"]) test(`${failure} loses authority without exposing contents`, { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { contents: JSON.stringify({ type: "session_meta" }) + "\n" });
  const io = control(t, fix);
  let cancelled = 0, unavailable;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; }, onUnavailable: error => { unavailable = error; } });
  await watcher.ready;
  if (failure === "truncate") await truncate(fix.file, 0);
  if (failure === "invalid") await appendFile(fix.file, "invalid-private-body\n");
  io.notify();
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(cancelled, 0);
  assert.equal(unavailable.code, "WEB_TURN_CANCELLATION_UNAVAILABLE");
  assert.ok(!unavailable.message.includes("private"));
  assert.ok(!unavailable.message.includes(fix.file));
  assert.equal(unavailable.reason, failure === "truncate" ? "rollout_truncated" : "rollout_invalid");
});

test("ambiguous exact-thread files reject readiness", { timeout: 5_000 }, async t => {
  const fix = await fixture(t);
  await writeFile(path.join(fix.day, `rollout-2026-10-16T07-44-26-${THREAD}.jsonl`), event() + "\n");
  const watcher = fix.watch({ onCancel() { assert.fail("ambiguous rollout cancelled"); } });
  await assert.rejects(watcher.ready, { code: "WEB_TURN_CANCELLATION_UNAVAILABLE", reason: "rollout_ambiguous" });
  assert.equal((await watcher.finished).state, "unavailable");
});

test("monitoring is read-only and rejects arbitrary path-shaped identities", { timeout: 5_000 }, async t => {
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

test("real directory notifications discover creation and exact interruption", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { create: false });
  const watcher = fix.watch();
  await writeFile(fix.file, event(FOREIGN) + "\n");
  await watcher.ready;
  await appendFile(fix.file, event() + "\n");
  assert.equal((await watcher.finished).state, "cancelled");
});

test("real parent notifications adopt a sessions root created after its absence was observed", { timeout: 5_000 }, async t => {
  const fix = await fixture(t, { create: false, sessions: false });
  const rootMissing = deferred(), originalLstat = fs.lstat;
  const mock = t.mock.method(fs, "lstat", async (...args) => {
    try { return await originalLstat(...args); }
    catch (error) {
      if (args[0] === path.join(fix.codexHome, "sessions") && error.code === "ENOENT") rootMissing.resolve();
      throw error;
    }
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const watcher = fix.watch();
  await rootMissing.promise;
  await mkdir(fix.day, { recursive: true });
  await writeFile(fix.file, event(FOREIGN) + "\n");
  await watcher.ready;
  await appendFile(fix.file, event() + "\n");
  assert.equal((await watcher.finished).state, "cancelled");
});

for (const rotate of [false, true]) test(`real notifications reject ${rotate ? "rotation" : "atomic replacement"}`, { timeout: 5_000 }, async t => {
  const fix = await fixture(t);
  const watcher = fix.watch({ onCancel() { assert.fail("replacement cancelled"); } });
  await watcher.ready;
  if (rotate) {
    await rename(fix.file, path.join(fix.day, "archived.jsonl"));
    await writeFile(fix.file, event() + "\n");
  } else {
    const replacement = path.join(fix.day, "replacement.jsonl");
    await writeFile(replacement, event() + "\n");
    await rename(replacement, fix.file);
  }
  const result = await watcher.finished;
  assert.equal(result.state, "unavailable");
  assert.ok(["rollout_changed", "rollout_access"].includes(result.error.reason));
});

test("missing native rollout retains its bounded failure deadline without fake cancellation", { timeout: 8_000 }, async t => {
  const fix = await fixture(t, { create: false });
  let cancelled = 0, unavailable = 0;
  const watcher = fix.watch({ onCancel: () => { cancelled += 1; },
    onUnavailable: error => { unavailable += 1; assert.equal(error.reason, "rollout_missing"); } });
  await assert.rejects(watcher.ready, { code: "WEB_TURN_CANCELLATION_UNAVAILABLE", reason: "rollout_missing" });
  assert.equal((await watcher.finished).state, "unavailable");
  assert.equal(cancelled, 0);
  assert.equal(unavailable, 1);
});
