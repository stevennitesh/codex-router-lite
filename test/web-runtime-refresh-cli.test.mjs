import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function adapterCliFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-web-adapter-cli-"));
  const control = path.resolve(import.meta.dirname, "../src/control.mjs");
  const callsPath = path.join(directory, "calls.jsonl"), loader = path.join(directory, "loader.mjs");
  const record = `import { appendFileSync } from 'node:fs';
    function record(operation, options) { appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ operation, ...(options ? { options } : {}) }) + '\\n', 'utf8'); }
  `;
  const stubs = {
    "./web-stop-adapter-install.mjs": `${record}
      record('adapter-module');
      export function webStopAdapterStatus() { record('status'); return JSON.parse(process.env.ROUTER_CLI_FIXTURE_STATUS); }
      export function installWebStopAdapter(options) { record('install', options); return options; }
      export function rollbackWebStopAdapter() { throw new Error('Unexpected rollback'); }
    `,
    "./web-runtime-refresh.mjs": `${record}
      record('refresh-module');
      export async function refreshWebRuntime(options) { record('refresh', options); return options; }
    `,
    "./chatgpt-web.mjs": `${record}
      export function readWebBridgeSettings() {
        record('settings');
        if (process.env.ROUTER_CLI_FIXTURE_SETTINGS_ERROR) throw new Error(process.env.ROUTER_CLI_FIXTURE_SETTINGS_ERROR);
        return { enabled: process.env.ROUTER_CLI_FIXTURE_ENABLED !== 'false' };
      }
      export function configureInAppWebBridge() { throw new Error('Unexpected configure'); }
      export function disconnectWebBridge() { throw new Error('Unexpected disconnect'); }
      export function webBridgeModels() { throw new Error('Unexpected models'); }
      export function webBridgeStatus() { throw new Error('Unexpected bridge status'); }
      export function webBridgeConfigurationStatus() { throw new Error('Unexpected configuration status'); }
      export const WEB_BRIDGE_TUNNEL_KEY_PATH = 'unused';
    `,
  };
  const urls = {};
  for (const [specifier, source] of Object.entries(stubs)) {
    const filename = path.join(directory, path.basename(specifier));
    writeFileSync(filename, source, "utf8");
    urls[specifier] = pathToFileURL(filename).href;
  }
  writeFileSync(loader, `const stubs = ${JSON.stringify(urls)};
    export async function resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(pathToFileURL(control).href)} && stubs[specifier]) {
        return { url: stubs[specifier], shortCircuit: true };
      }
      return next(specifier, context);
    }
  `, "utf8");
  return {
    manifestPath: path.join(directory, "candidate.json"),
    run(arguments_, status, overrides = {}) {
      writeFileSync(callsPath, "", "utf8");
      const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href,
        control, "web", "stop", ...arguments_], {
        cwd: directory, encoding: "utf8", windowsHide: true, timeout: 15_000,
        env: { ...process.env, CODEX_HOME: directory, MODEL_ROUTER_STATE_DIR: directory,
          ROUTER_CLI_FIXTURE_STATUS: JSON.stringify(status), ROUTER_CLI_FIXTURE_SETTINGS_ERROR: "",
          ROUTER_CLI_FIXTURE_ENABLED: "true", ...overrides },
      });
      assert.equal(result.error, undefined);
      return { ...result, calls: readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
    },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("runtime refresh CLI defaults to planning and rejects ambiguous mutation arguments", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-web-refresh-cli-"));
  const control = path.resolve(import.meta.dirname, "../src/control.mjs");
  const stub = path.join(directory, "refresh.mjs"), loader = path.join(directory, "loader.mjs");
  writeFileSync(stub, "export async function refreshWebRuntime(options) { return options; }\n", "utf8");
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    if (context.parentURL === ${JSON.stringify(pathToFileURL(control).href)} && specifier === './web-runtime-refresh.mjs') {
      return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
    }
    return next(specifier, context);
  }\n`, "utf8");
  const run = arguments_ => spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href,
    control, "web", "refresh-runtime", ...arguments_], {
    cwd: directory, encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, CODEX_HOME: directory, MODEL_ROUTER_STATE_DIR: directory },
  });
  try {
    const plan = run([]);
    assert.equal(plan.error, undefined);
    assert.equal(plan.status, 0, plan.stderr);
    assert.deepEqual(JSON.parse(plan.stdout), { apply: false, forceServiceReplacement: false });

    const apply = run(["--manifest", "candidate.json", "--apply"]);
    assert.equal(apply.error, undefined);
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(JSON.parse(apply.stdout), { apply: true, forceServiceReplacement: false, manifestPath: path.join(directory, "candidate.json") });

    const forced = run(["--force-service-replacement", "--manifest", "candidate.json", "--apply"]);
    assert.equal(forced.error, undefined);
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(JSON.parse(forced.stdout), { apply: true, forceServiceReplacement: true, manifestPath: path.join(directory, "candidate.json") });

    for (const arguments_ of [["--apply", "--apply"], ["--manifest"], ["--manifest", "--apply"],
      ["--manifest", "a.json", "--manifest", "b.json"], ["--force-service-replacement"],
      ["--force-service-replacement", "--manifest", "candidate.json"],
      ["--apply", "--force-service-replacement", "--force-service-replacement"], ["unexpected"]]) {
      const result = run(arguments_);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "", "invalid arguments must not reach the refresh operation");
      assert.match(result.stderr, /Usage: control web refresh-runtime/u);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("adapter replacement coordinates both runtime selections even when the saved browser runtime is missing", () => {
  const fixture = adapterCliFixture();
  try {
    for (const [runtimeStatus, installed] of [["current", true], ["stale", false], ["unavailable", false], ["invalid", false]]) {
      const result = fixture.run(["install-adapter", "candidate.json"], {
        state: "installed", ownershipVerified: true, installed, runtimeStatus, conflicts: [],
      }, { ROUTER_CLI_FIXTURE_SETTINGS_ERROR: "Saved browser runtime is gone; strict execution reads must not run." });
      assert.equal(result.status, 0, result.stderr);
      const options = { apply: true, manifestPath: fixture.manifestPath, replaceAdapter: true };
      assert.deepEqual(JSON.parse(result.stdout), options);
      assert.deepEqual(result.calls, [
        { operation: "adapter-module" }, { operation: "status" }, { operation: "refresh-module" }, { operation: "refresh", options },
      ]);
    }
  } finally { fixture.close(); }
});

test("first adapter installation keeps the strict enabled browser prerequisite and ordinary installer", () => {
  const fixture = adapterCliFixture();
  try {
    for (const state of ["absent", "removed"]) {
      const status = { state, installed: false, ownershipVerified: false, runtimeStatus: "not-checked", conflicts: [] };
      const result = fixture.run(["install-adapter", "candidate.json"], status);
      assert.equal(result.status, 0, result.stderr);
      const options = { manifestPath: fixture.manifestPath };
      assert.deepEqual(JSON.parse(result.stdout), options);
      assert.deepEqual(result.calls, [
        { operation: "adapter-module" }, { operation: "status" }, { operation: "settings" }, { operation: "install", options },
      ]);

      for (const overrides of [{ ROUTER_CLI_FIXTURE_ENABLED: "false" }, { ROUTER_CLI_FIXTURE_SETTINGS_ERROR: "Invalid saved browser runtime." }]) {
        const rejected = fixture.run(["install-adapter", "candidate.json"], status, overrides);
        assert.equal(rejected.status, 1, rejected.stderr);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /configured in-app browser integration|Invalid saved browser runtime/u);
        assert.deepEqual(rejected.calls, [{ operation: "adapter-module" }, { operation: "status" }, { operation: "settings" }]);
      }
    }
  } finally { fixture.close(); }
});

test("adapter install rejects unresolved ownership and recovery before either installer can mutate", () => {
  const fixture = adapterCliFixture();
  try {
    for (const status of [
      { state: "installed", ownershipVerified: false, conflicts: ["Foreign environment selection."] },
      { state: "installed", ownershipVerified: false, conflicts: [] },
      { state: "installed", ownershipVerified: true, conflicts: ["Changed hook."] },
      { state: "prepared", ownershipVerified: true, recoveryRequired: true, conflicts: [] },
      { state: "unknown", ownershipVerified: true, conflicts: [] },
      { state: "removed", ownershipVerified: false, conflicts: ["Managed files changed."] },
    ]) {
      const result = fixture.run(["install-adapter", "candidate.json"], status);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /ownership or recovery is unresolved.*adapter-status/u);
      assert.deepEqual(result.calls, [{ operation: "adapter-module" }, { operation: "status" }]);
    }
  } finally { fixture.close(); }
});

test("invalid adapter command arguments do no adapter inspection or mutation", () => {
  const fixture = adapterCliFixture();
  try {
    for (const arguments_ of [["install-adapter"], ["install-adapter", "--apply"], ["install-adapter", "candidate.json", "extra"],
      ["adapter-status", "extra"], ["adapter-rollback", "extra"], ["unexpected"]]) {
      const result = fixture.run(arguments_, { state: "installed", ownershipVerified: true, conflicts: [] });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Usage: control web stop install-adapter/u);
      assert.deepEqual(result.calls, []);
    }
  } finally { fixture.close(); }
});
