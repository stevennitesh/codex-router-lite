import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  codexDesktopState,
  codexDesktopStateAsync,
  nativeCatalogPublicationMode,
  observeNativeAuthOutcome,
  readNativeAuthObservation,
} from "../src/native-auth-observation.mjs";

const listing = (start) => `Codex\t${start}\tC:\\Program Files\\Codex\\Codex.exe\n`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("desktop inspection distinguishes app generations and excludes bundled CLI processes", async () => {
  const first = codexDesktopState({ processList: listing(100) });
  assert.equal(first.running, true);
  assert.match(first.generation, /^[a-f0-9]{64}$/);
  assert.notEqual(codexDesktopState({ processList: listing(101) }).generation, first.generation);
  assert.deepEqual(await codexDesktopStateAsync({ processList: "Codex\t100\tC:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe\n" }), {
    running: false, generation: undefined,
  });
  assert.deepEqual(await codexDesktopStateAsync({ processListReaderAsync: async () => { throw new Error("unavailable"); } }), {
    running: true, generation: undefined,
  });
});

test("simultaneous default scans coalesce; forced and synchronous captures remain independent", async (t) => {
  const scans = [];
  t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => {
    scans.push(callback);
  });
  t.mock.method(childProcess, "execFileSync", () => listing(300));
  syncBuiltinESMExports();
  try {
    const now = Date.now() + 600_000;
    const first = codexDesktopStateAsync({ now });
    const second = codexDesktopStateAsync({ now });
    assert.equal(scans.length, 1, "one subprocess inspects simultaneous cold requests");
    const forced = codexDesktopStateAsync({ now, forceRefresh: true });
    assert.equal(scans.length, 2, "forceRefresh does not reuse an older pending capture");
    scans[1](null, listing(200));
    const forcedState = await forced;
    scans[0](null, listing(100));
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.notEqual(a.generation, forcedState.generation);
    assert.deepEqual(await codexDesktopStateAsync({ now }), forcedState, "late old scan cannot replace new cache");

    const pending = codexDesktopStateAsync({ now, forceRefresh: true });
    const synchronous = codexDesktopState({ now, forceRefresh: true });
    scans[2](null, listing(250));
    await pending;
    assert.deepEqual(await codexDesktopStateAsync({ now }), synchronous, "sync caller remains authoritative over old async work");

    const failed = codexDesktopStateAsync({ now, forceRefresh: true });
    scans[3](new Error("inspection denied"));
    assert.deepEqual(await failed, { running: true, generation: undefined });
    const retry = codexDesktopStateAsync({ now: now + 600_000 });
    scans[4](null, listing(400));
    assert.equal((await retry).running, true, "completed failure releases the in-flight slot");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("auth outcomes retain response invocation order when desktop captures resolve in reverse order", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-observation-order-"));
  const filePath = path.join(root, "observation.json");
  const desktop = codexDesktopState({ processList: listing(500) });
  try {
    for (const statuses of [[200, 401], [401, 200]]) {
      const older = deferred();
      const newer = deferred();
      const first = observeNativeAuthOutcome(statuses[0], { filePath, desktop: older.promise, now: 1_000 });
      const second = observeNativeAuthOutcome(statuses[1], { filePath, desktop: newer.promise, now: 2_000 });
      newer.resolve(desktop);
      let finished = false;
      void second.then(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(finished, false, "later response waits within ordered observation tail");
      older.resolve(desktop);
      const results = await Promise.all([first, second]);
      const expected = statuses[1] === 401 ? "rejected" : "accepted";
      assert.equal(results[1].state, expected);
      assert.equal(readNativeAuthObservation({ filePath, desktop }).state, expected);
      assert.equal(JSON.parse(readFileSync(filePath, "utf8")).desktopGeneration, desktop.generation);
    }
    const priorLaunch = codexDesktopState({ processList: listing(501) });
    assert.equal(readNativeAuthObservation({ filePath, desktop: priorLaunch }).state, "unknown");
    await observeNativeAuthOutcome(401, { filePath, desktop: Promise.resolve(priorLaunch), now: 3_000 });
    assert.equal(readNativeAuthObservation({ filePath, desktop }).state, "unknown");
    assert.equal(readNativeAuthObservation({ filePath, desktop: priorLaunch }).state, "rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth observation failures stay unknown and native publication policy stays unchanged", async () => {
  const desktop = codexDesktopState({ processList: listing(600) });
  const root = mkdtempSync(path.join(os.tmpdir(), "native-observation-invalid-"));
  const filePath = path.join(root, "observation.json");
  try {
    writeFileSync(filePath, JSON.stringify({ version: 1, state: "accepted", desktopGeneration: desktop.generation, observedAt: "invalid" }));
    assert.equal(readNativeAuthObservation({ filePath, desktop }).state, "unknown");
    const unchanged = readFileSync(filePath, "utf8");
    assert.equal((await observeNativeAuthOutcome(503, { filePath, desktop })).state, "unknown");
    assert.equal(readFileSync(filePath, "utf8"), unchanged);
    assert.equal((await observeNativeAuthOutcome(200, {
      filePath: path.join(root, "missing", "observation.json"),
      desktop: Promise.resolve({ running: true, generation: undefined }),
    })).state, "unknown");
    assert.equal(nativeCatalogPublicationMode({ authenticated: true }, { running: false }, { state: "rejected" }), "all");
    assert.equal(nativeCatalogPublicationMode({}, desktop, { state: "accepted" }), "all");
    assert.equal(nativeCatalogPublicationMode({}, desktop, { state: "rejected" }), "none");
    assert.equal(nativeCatalogPublicationMode({}, desktop, { state: "unknown" }), "preserve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
