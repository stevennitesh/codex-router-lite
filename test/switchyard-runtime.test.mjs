import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installedSwitchyardLaunch,
  switchyardLaunch,
  switchyardHealthUrl,
  switchyardRuntimeStatus,
  switchyardSelectedForStartup,
} from "../src/switchyard-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Switchyard supervision starts only after an explicit provider selection", () => {
  assert.equal(switchyardLaunch({ selected: false }), undefined);
  assert.equal(switchyardSelectedForStartup({ explicit: false, providers: ["switchyard"] }), false);
  assert.equal(switchyardSelectedForStartup({ explicit: true, providers: ["openrouter"] }), false);
  assert.equal(switchyardSelectedForStartup({ explicit: true, providers: ["switchyard"] }), true);
});

test("Switchyard supervision derives one loopback process and health contract", () => {
  const stateDir = path.join("C:\\fixture", "codex-router");
  const launch = switchyardLaunch({
    selected: true,
    stateDir,
    platform: "win32",
    env: {
      CODEX_HOME: "C:\\fixture",
      CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://127.0.0.1:4888/v1",
    },
    exists: () => true,
  });
  assert.equal(launch.binary, path.join("C:\\fixture", "switchyard", "switchyard-server.exe"));
  assert.equal(launch.config, path.join("C:\\fixture", "switchyard", "routes.toml"));
  assert.equal(launch.healthUrl, "http://127.0.0.1:4888/health");
  assert.deepEqual(launch.args.slice(0, 6), [
    "--config",
    launch.config,
    "--host",
    "127.0.0.1",
    "--port",
    "4888",
  ]);
  assert.equal(launch.args.at(-1), path.join("C:\\fixture", "switchyard", "routing.jsonl"));
});

test("managed Switchyard rejects a non-loopback bind", () => {
  assert.throws(
    () => switchyardHealthUrl({
      env: { CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://192.0.2.10:4000/v1" },
    }),
    /must bind to loopback/,
  );
  assert.throws(
    () => switchyardLaunch({
      selected: true,
      stateDir: "C:\\fixture\\codex-router",
      env: {
        CODEX_HOME: "/fixture",
        CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://0.0.0.0:4000/v1",
      },
      exists: () => true,
    }),
    /must bind to loopback/,
  );
});

test("Switchyard supervision refuses a selected provider with no installed runtime", () => {
  assert.throws(
    () => switchyardLaunch({
      selected: true,
      stateDir: "C:\\fixture\\codex-router",
      env: { CODEX_HOME: "C:\\fixture" },
      exists: () => false,
    }),
    /runtime is incomplete/,
  );
});

test("Switchyard runtime status names every missing deployment artifact", () => {
  const status = switchyardRuntimeStatus({
    stateDir: "C:\\fixture\\codex-router",
    env: { CODEX_HOME: "C:\\fixture" },
    exists: () => false,
  });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, [
    path.join("C:\\fixture", "switchyard", "switchyard-server.exe"),
    path.join("C:\\fixture", "switchyard", "routes.toml"),
  ]);
});

test("installed Switchyard launch fails open when an old selection outlives its runtime", () => {
  const warnings = [];
  const launch = installedSwitchyardLaunch({
    selected: true,
    warn: (message) => warnings.push(message),
    runtimeOptions: {
      stateDir: "C:\\fixture\\codex-router",
      env: { CODEX_HOME: "C:\\fixture" },
      exists: () => false,
    },
  });
  assert.equal(launch, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /continuing without it/);
});

test("installed Switchyard launch probes each runtime artifact once", () => {
  const checked = [];
  const launch = installedSwitchyardLaunch({
    selected: true,
    runtimeOptions: {
      stateDir: "C:\\fixture\\codex-router",
      env: {
        CODEX_HOME: "C:\\fixture",
        CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://127.0.0.1:4888/v1",
      },
      exists: (target) => {
        checked.push(target);
        return true;
      },
    },
  });
  assert.ok(launch);
  assert.deepEqual(checked, [
    path.join("C:\\fixture", "switchyard", "switchyard-server.exe"),
    path.join("C:\\fixture", "switchyard", "routes.toml"),
  ]);
});

test("Switchyard source lock pins the canonical compatibility patch", () => {
  const configRoot = path.join(root, "config", "switchyard");
  const lock = JSON.parse(readFileSync(path.join(configRoot, "source.lock"), "utf8"));
  const patchBytes = readFileSync(path.join(configRoot, lock.patch));
  assert.match(lock.commit, /^[a-f0-9]{40}$/u);
  assert.equal(createHash("sha256").update(patchBytes).digest("hex"), lock.patchSha256);
  assert.match(patchBytes.toString("utf8"), /merge_override_value/);
});
