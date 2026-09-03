import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexDesktopState,
  codexDesktopStateAsync,
  nativeCatalogPublicationMode,
  observeNativeAuthOutcome,
  readNativeAuthObservation,
} from "../src/native-auth-observation.mjs";

test("desktop generation uses the earliest app process and ignores bundled CLI churn", () => {
  const listing = [
    "ChatGPT\t638900000000000000\tC:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\ChatGPT.exe",
    "ChatGPT\t638900000000000100\tC:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\ChatGPT.exe",
    "Codex\t638800000000000000\tC:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe",
  ].join("\n");
  const first = codexDesktopState({
    platform: "win32",
    processList: listing,
  });
  const withoutHelper = codexDesktopState({
    platform: "win32",
    processList: listing.split("\n")[0],
  });
  assert.equal(first.running, true);
  assert.equal(first.generation, withoutHelper.generation);

  const cliOnly = codexDesktopState({
    platform: "win32",
    processList: listing.split("\n")[2],
  });
  assert.deepEqual(cliOnly, { running: false, generation: undefined });
});

test("Unix desktop generations include PID across same-second restarts", () => {
  const linux = (pid) =>
    `${pid} Mon Sep  2 12:34:56 2026 /opt/ChatGPT-desktop /opt/ChatGPT-desktop --desktop`;
  const mac = (pid) =>
    `${pid} Mon Sep  2 12:34:56 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT /Applications/ChatGPT.app/Contents/MacOS/ChatGPT`;
  for (const [platform, fixture] of [["linux", linux], ["darwin", mac]]) {
    const first = codexDesktopState({ platform, processList: fixture(321) });
    const restarted = codexDesktopState({ platform, processList: fixture(322) });
    assert.equal(first.running, true);
    assert.equal(restarted.running, true);
    assert.notEqual(first.generation, restarted.generation);
  }
});

test("native observations persist only 2xx acceptance and 401 rejection", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-native-auth-"));
  const filePath = path.join(directory, "observation.json");
  const desktop = { running: true, generation: "generation-a" };
  try {
    const accepted = await observeNativeAuthOutcome(200, {
      filePath,
      desktop,
      now: Date.parse("2026-09-02T12:00:00Z"),
    });
    assert.equal(accepted.state, "accepted");
    const initialText = readFileSync(filePath, "utf8");

    assert.equal((await observeNativeAuthOutcome(403, { filePath, desktop })).state, "unknown");
    assert.equal(readFileSync(filePath, "utf8"), initialText);

    const duplicate = await observeNativeAuthOutcome(204, {
      filePath,
      desktop,
      now: Date.parse("2026-09-02T13:00:00Z"),
    });
    assert.equal(duplicate.observedAt, "2026-09-02T12:00:00.000Z");
    assert.equal(readFileSync(filePath, "utf8"), initialText);

    const rejected = await observeNativeAuthOutcome(401, {
      filePath,
      desktop,
      now: Date.parse("2026-09-02T14:00:00Z"),
    });
    assert.equal(rejected.state, "rejected");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(filePath, "utf8"))).sort(), [
      "desktopGeneration",
      "observedAt",
      "state",
      "version",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale desktop generations are unknown", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-native-stale-"));
  const filePath = path.join(directory, "observation.json");
  try {
    await observeNativeAuthOutcome(200, {
      filePath,
      desktop: { running: true, generation: "old" },
    });
    assert.equal(readNativeAuthObservation({
      filePath,
      desktop: { running: true, generation: "new" },
    }).state, "unknown");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a held asynchronous process probe does not block the event loop", async () => {
  let release;
  const heldListing = new Promise((resolve) => {
    release = resolve;
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-native-held-probe-"));
  const observation = observeNativeAuthOutcome(200, {
    filePath: path.join(directory, "observation.json"),
    desktopOptions: {
      platform: "linux",
      processListReaderAsync: () => heldListing,
    },
  });
  try {
    let timerRan = false;
    await new Promise((resolve) => setTimeout(() => {
      timerRan = true;
      resolve();
    }, 10));
    assert.equal(timerRan, true);
    release(
      "321 Mon Sep  2 12:34:56 2026 /opt/ChatGPT-desktop /opt/ChatGPT-desktop --desktop",
    );
    assert.equal((await observation).state, "accepted");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent observations commit in invocation order", async () => {
  let release;
  const heldListing = new Promise((resolve) => {
    release = resolve;
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-native-order-"));
  const filePath = path.join(directory, "observation.json");
  try {
    const accepted = observeNativeAuthOutcome(200, {
      filePath,
      desktopOptions: {
        platform: "linux",
        processListReaderAsync: () => heldListing,
      },
    });
    const rejected = observeNativeAuthOutcome(401, {
      filePath,
      desktop: { running: true, generation: "ordered-generation" },
    });
    release(
      "321 Mon Sep  2 12:34:56 2026 /opt/ChatGPT-desktop /opt/ChatGPT-desktop --desktop",
    );
    const first = await accepted;
    await rejected;
    const final = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(first.state, "accepted");
    assert.equal(final.state, "rejected");
    assert.equal(final.desktopGeneration, "ordered-generation");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("async and synchronous desktop probes parse the same listing", async () => {
  const listing =
    "321 Mon Sep  2 12:34:56 2026 /opt/ChatGPT-desktop /opt/ChatGPT-desktop --desktop";
  assert.deepEqual(
    await codexDesktopStateAsync({ platform: "linux", processList: listing }),
    codexDesktopState({ platform: "linux", processList: listing }),
  );
});

test("an upstream outcome stays bound to its pre-send desktop generation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-native-swap-"));
  const filePath = path.join(directory, "observation.json");
  const listing = (ticks) =>
    `ChatGPT\t${ticks}\tC:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\ChatGPT.exe`;
  try {
    const desktopA = await codexDesktopStateAsync({
      platform: "win32",
      processList: listing("638900000000000000"),
    });
    // The upstream response is delayed while the desktop process is replaced.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const desktopB = await codexDesktopStateAsync({
      platform: "win32",
      processList: listing("638900000000000100"),
    });
    assert.notEqual(desktopA.generation, desktopB.generation);

    await observeNativeAuthOutcome(200, {
      filePath,
      desktop: desktopA,
    });
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(written.desktopGeneration, desktopA.generation);
    assert.notEqual(written.desktopGeneration, desktopB.generation);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native catalog publication combines CLI authority with current desktop evidence", () => {
  const signedIn = { authenticated: true, reason: "authenticated" };
  const signedOut = { authenticated: false, reason: "not-logged-in" };
  const running = { running: true, generation: "current" };
  const closed = { running: false };

  assert.equal(nativeCatalogPublicationMode(signedIn, closed, { state: "unknown" }), "all");
  assert.equal(nativeCatalogPublicationMode(signedOut, closed, { state: "accepted" }), "none");
  assert.equal(nativeCatalogPublicationMode(signedOut, running, { state: "accepted" }), "all");
  assert.equal(nativeCatalogPublicationMode(signedOut, running, { state: "rejected" }), "none");
  assert.equal(nativeCatalogPublicationMode(signedOut, running, { state: "unknown" }), "preserve");
  assert.equal(nativeCatalogPublicationMode(
    { authenticated: false, reason: "discovery-disabled" },
    running,
    { state: "accepted" },
  ), "none");
});
