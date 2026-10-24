import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { readControlHealth } from "../src/control-health.mjs";
import { readWebMaintenanceStatus, webTunnelKeyStatus } from "../src/web-status.mjs";

const canary = "synthetic-private-web-status-key";
const callerKey = "synthetic-caller-capability-for-status-fixture";
const healthy = { ok: true, status: 200, service: "codex-router", router: "ready", degraded: [] };
function dependencies(overrides = {}) {
  return {
    readConfiguration: () => ({ enabled: true, localToolsConfigured: true, models: [{ slug: "chatgpt-web/fixture" }],
      browser: { runtimeModule: "fixture-runtime.mjs" }, tunnel: { id: "tunnel_fixture" } }),
    readProtocol: () => "v1",
    readKeyStatus: () => ({ configured: true, fileStatus: "present" }),
    readAdapterStatus: () => ({ installed: true, ownershipVerified: true, state: "installed", conflicts: [], appLoaded: "unknown", hookTrusted: "unknown",
      restartRequired: "unknown", trustRequired: "unknown" }),
    readRuntimePlan: async () => ({ ready: true, changed: false, routerRestartRequired: false, codexRestartRequired: false }),
    readHealth: async options => { assert.equal(options.timeoutMs, 3_000); return healthy; },
    ...overrides,
  };
}

test("key status reports file presence and usable contents without returning any key", () => {
  for (const [contents, expected] of [[`${canary}\n`, { configured: true, fileStatus: "present" }], [" \n", { configured: false, fileStatus: "empty" }]]) {
    const status = webTunnelKeyStatus({ keyPath: "fixture", probe: () => ({ status: "present" }), read: (_file, encoding) => {
      assert.equal(encoding, "utf8"); return contents;
    } });
    assert.deepEqual(status, expected); assert.equal(JSON.stringify(status).includes(canary), false);
  }
  assert.deepEqual(webTunnelKeyStatus({ probe: () => ({ status: "missing" }), read: () => assert.fail("do not read a missing key") }), { configured: false, fileStatus: "missing" });
  for (const status of ["access-denied", "invalid", "probe-failed"]) assert.throws(() => webTunnelKeyStatus({ probe: () => ({ status }) }), /Cannot read/u);
  assert.throws(() => webTunnelKeyStatus({ probe: () => ({ status: "present" }), read: () => `${canary}\nembedded-control` }), error => !error.message.includes(canary));
});

test("healthy Router and installed local adapter leave Web runtime and app trust unproved", async () => {
  const status = await readWebMaintenanceStatus(dependencies());
  assert.equal(status.configurationStatus, "ok"); assert.equal(status.enabled, true); assert.equal(status.subagentProtocol, "v1");
  assert.deepEqual(status.router, { status: "ready", reachable: true, httpStatus: 200, degraded: [] });
  assert.equal(status.stopAdapter.installed, true);
  for (const field of ["appLoaded", "hookTrusted", "restartRequired", "trustRequired"]) assert.equal(status.stopAdapter[field], "unknown");
  for (const field of ["tunnel", "browserSession", "nativeTools", "immediateStop"]) assert.equal(status.readiness[field], "unknown");
  assert.deepEqual(status.next, []);
  assert.equal(status.runtimeUpdate.status, "current");
});

test("maintenance diagnoses an app update through one shared read-only plan without rechecking the old runtime", async () => {
  let plans = 0;
  const status = await readWebMaintenanceStatus(dependencies({
    readConfiguration: () => ({ enabled: true, runtimeStatus: "stale", runtimeIssues: ["The configured browser runtime is missing."] }),
    readAdapterStatus: options => {
      assert.deepEqual(options, { inspectRuntime: false });
      return { installed: false, ownershipVerified: true, state: "installed", conflicts: [], runtimeStatus: "not-checked" };
    },
    readRuntimePlan: async () => { plans++; return { ready: true, changed: true, routerRestartRequired: true, codexRestartRequired: true }; },
  }));
  assert.equal(plans, 1); assert.equal(status.enabled, true); assert.equal(status.configurationStatus, "ok");
  assert.deepEqual(status.runtimeUpdate, { status: "refresh-required", ready: true, routerRestartRequired: true, codexRestartRequired: true });
  assert.equal(status.next.length, 1); assert.match(status.next[0], /refresh-runtime --apply/u);
  assert.equal(status.next.some(action => /install-adapter|ownership condition/u.test(action)), false);
  assert.equal(status.readiness.immediateStop, "unknown");
});

test("runtime drift is diagnosed even while the previous browser files are still present", async () => {
  const status = await readWebMaintenanceStatus(dependencies({
    readRuntimePlan: async () => ({ ready: true, changed: true, routerRestartRequired: true, codexRestartRequired: true }),
  }));
  assert.equal(status.runtimeUpdate.status, "refresh-required");
  assert.match(status.next[0], /refresh-runtime --apply/u);
});

test("ambiguous anchors and failed verification retain different bounded update instructions", async () => {
  for (const [code, expected] of [["ERR_WEB_RUNTIME_ANCHORS", "manifest-required"], ["ERR_SIGNATURE", "unavailable"]]) {
    const status = await readWebMaintenanceStatus(dependencies({
      readRuntimePlan: async () => { throw Object.assign(new Error(canary), { code }); },
    }));
    assert.equal(status.runtimeUpdate.status, expected); assert.equal(status.runtimeUpdate.ready, false);
    assert.equal(JSON.stringify(status).includes(canary), false);
    assert.equal(status.next.some(action => /--apply/u.test(action)), false);
    assert.match(status.next[0], expected === "manifest-required" ? /--manifest/u : /validation failure/u);
  }
});

test("ownership conflicts and unconfigured Web never attempt candidate discovery", async () => {
  for (const branch of ["disabled", "conflict", "absent"]) {
    const status = await readWebMaintenanceStatus(dependencies({
      readConfiguration: () => ({ enabled: branch !== "disabled" }),
      readAdapterStatus: () => branch === "conflict"
        ? { state: "installed", installed: false, ownershipVerified: false, conflicts: ["Foreign hook preserved."] }
        : { state: "absent", installed: false, ownershipVerified: false, conflicts: [] },
      readRuntimePlan: () => assert.fail("Do not discover a candidate without a configured owned installation."),
    }));
    assert.equal(status.runtimeUpdate.status, branch === "disabled" ? "not-configured" : branch === "conflict" ? "ownership-conflict" : "setup-required");
    assert.equal(status.next.some(action => /refresh-runtime --apply/u.test(action)), false);
  }
});

test("disabled configuration does not turn absent adapter or key into required setup work", async () => {
  const status = await readWebMaintenanceStatus(dependencies({ readConfiguration: () => ({ enabled: false, localToolsConfigured: false, models: [] }),
    readKeyStatus: () => ({ configured: false, fileStatus: "missing" }), readAdapterStatus: () => ({ installed: false, state: "absent", conflicts: [] }) }));
  assert.equal(status.readiness.tunnel, "disabled");
  assert.equal(status.next.length, 1); assert.match(status.next[0], /when you want to enable/u);
  assert.equal(status.next.some(action => /tunnel-key set|restart|trust/iu.test(action)), false);
});

test("enabled configuration offers adapter setup only when local installation is absent or removed", async () => {
  for (const state of ["absent", "removed"]) {
    const status = await readWebMaintenanceStatus(dependencies({ readAdapterStatus: () => ({ installed: false, state, conflicts: [] }) }));
    assert.equal(status.next.length, 1); assert.match(status.next[0], /install-adapter/u);
    assert.equal(status.next.some(action => /restart|trust/iu.test(action)), false);
  }
});

test("missing key, ownership conflict and offline Router yield only their supported next actions", async () => {
  const status = await readWebMaintenanceStatus(dependencies({ readKeyStatus: () => ({ configured: false, fileStatus: "missing" }),
    readAdapterStatus: () => ({ installed: false, state: "prepared", recoveryRequired: true, conflicts: ["foreign launch selection"] }),
    readHealth: options => readControlHealth({ ...options, readCallerSecret: () => callerKey,
      fetchImpl: async () => { throw new Error(canary); } }) }));
  assert.equal(status.router.status, "unavailable"); assert.equal(status.readiness.tunnel, "unknown");
  assert.equal(status.next.length, 3);
  assert.ok(status.next.some(action => /tunnel-key set/u.test(action)));
  assert.ok(status.next.some(action => /codex doctor/u.test(action)));
  assert.ok(status.next.some(action => /ownership condition/u.test(action)));
  assert.equal(JSON.stringify(status).includes(canary), false);
});

test("partial health and unreadable local observations remain unknown without echoing underlying errors", async () => {
  const status = await readWebMaintenanceStatus(dependencies({ readConfiguration: () => { throw new Error(canary); },
    readProtocol: () => { throw new Error(canary); }, readKeyStatus: () => { throw new Error(canary); }, readAdapterStatus: () => { throw new Error(canary); },
    readHealth: async () => ({ ok: true, status: 200, service: "foreign", router: "ready", degraded: [canary] }) }));
  assert.equal(status.configurationStatus, "unavailable"); assert.equal(status.enabled, null);
  assert.equal(status.subagentProtocol, "unknown"); assert.equal(status.tunnelKey.configured, null);
  assert.equal(status.stopAdapter.installed, null); assert.equal(status.router.status, "unknown");
  assert.equal(JSON.stringify(status).includes(canary), false);
});

test("CLI web status reaches the aggregate through protected loopback health without a provider or browser call", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-web-status-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, "codex"); mkdirSync(codexHome);
  writeFileSync(path.join(directory, "caller-secret"), callerKey, "utf8");
  writeFileSync(path.join(directory, "chatgpt-web-runtime-key.secret"), canary, "utf8");
  const preload = path.join(directory, "health-fixture.mjs");
  writeFileSync(preload, `globalThis.fetch=async(url,options)=>{
    if(url!==${JSON.stringify(`http://127.0.0.1:4202/_codex-router/${callerKey}/v1/health`)}||options.headers.Accept!=='application/json'||!options.signal||options.redirect!=='error')throw new Error('Unexpected fixture request');
    return new Response(JSON.stringify(${JSON.stringify({ ...healthy, version: canary, unexpected: canary })}),{status:200});
  };\n`, "utf8");
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.resolve(import.meta.dirname, "../src/control.mjs"), "web", "status"], {
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: directory, CODEX_HOME: codexHome,
      MODEL_ROUTER_MULTI_AGENT_STATE: path.join(directory, "subagents.json"), MODEL_ROUTER_PORT: "4202" },
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
  const status = JSON.parse(run.stdout);
  assert.equal(status.enabled, false); assert.equal(status.router.status, "ready");
  assert.deepEqual(status.tunnelKey, { configured: true, fileStatus: "present" });
  assert.equal(status.stopAdapter.state, "absent"); assert.equal(status.stopAdapter.appLoaded, "unknown");
  assert.equal((run.stdout + run.stderr).includes(canary), false); assert.equal((run.stdout + run.stderr).includes(callerKey), false);
});

test("CLI subagent diagnostics retain configured routes after an app update removes the Web runtime", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-subagent-web-status-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, "codex"); mkdirSync(codexHome);
  const runtimeModule = path.join(directory, "removed-browser-runtime.mjs");
  const executable = path.join(directory, "inert-tunnel-client.exe");
  writeFileSync(executable, "Synthetic tunnel path; never execute.\n", "utf8");
  const settingsPath = path.join(directory, "chatgpt-web.json");
  const settings = { version: 1, enabled: true,
    capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false },
    browser: { runtimeModule, pluginName: "Router local tools", pluginAppId: "asdk_app_fixture", pluginSelectionButtonName: "Router local tools, Connectors" },
    tunnel: { id: "tunnel_fixture", executable } };
  writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
  const efforts = { "chatgpt-web/gpt-6-sol": "high", "switchyard/auto": "medium" };
  writeFileSync(path.join(directory, "subagents.json"), JSON.stringify({ version: 2, mode: "proven", enabled: [], disabled: [], protocol: "v2", efforts }), "utf8");
  const options = { env: { ...process.env, MODEL_ROUTER_STATE_DIR: directory, CODEX_HOME: codexHome,
    MODEL_ROUTER_MULTI_AGENT_STATE: path.join(directory, "subagents.json") }, encoding: "utf8", timeout: 10_000, windowsHide: true };
  const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../src/control.mjs"), "subagents", "status"], options);
  assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
  const status = JSON.parse(run.stdout);
  assert.equal(status.web.enabled, true); assert.equal(status.web.runtimeStatus, "stale");
  assert.deepEqual(status.web.runtimeIssues, ["Browser runtime module: configured file is missing."]);
  assert.equal(status.snapshot.protocol, "v2"); assert.deepEqual(status.snapshot.efforts, efforts);
  assert.equal(status.routes.find(row => row.slug === "openrouter/pareto").multiAgentVersion, "v2");
  assert.equal(status.routes.find(row => row.slug === "switchyard/auto").multiAgentVersion, "v1");
  const webRoutes = status.routes.filter(row => row.slug.startsWith("chatgpt-web/"));
  assert.deepEqual(webRoutes.map(row => row.slug), ["chatgpt-web/gpt-6-sol-instant", "chatgpt-web/gpt-6-sol", "chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol"]);
  assert.ok(webRoutes.every(row => row.multiAgentVersion === "v1"));
  assert.deepEqual(status.web.models.map(({ slug, multiAgentVersion }) => ({ slug, multiAgentVersion })), webRoutes);
  const strict = spawnSync(process.execPath, ["--input-type=module", "--eval", [
    "import assert from 'node:assert/strict';",
    "import {readWebBridgeSettings, webBridgeModels, requestWebBridge} from " + JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/chatgpt-web.mjs")).href) + ";",
    "assert.throws(() => readWebBridgeSettings(), /configured file is missing/);",
    "assert.throws(() => webBridgeModels(), /configured file is missing/);",
    "await assert.rejects(() => requestWebBridge({model:'chatgpt-web/gpt-6-sol',input:[]}), /configured file is missing/);",
  ].join("\n")], options);
  assert.equal(strict.error, undefined); assert.equal(strict.status, 0, strict.stderr);
  writeFileSync(settingsPath, JSON.stringify({ ...settings, enabled: false }), "utf8");
  const disabled = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../src/control.mjs"), "subagents", "status"], options);
  assert.equal(disabled.error, undefined); assert.equal(disabled.status, 0, disabled.stderr);
  const disabledStatus = JSON.parse(disabled.stdout);
  assert.equal(disabledStatus.web.enabled, false); assert.equal(disabledStatus.web.runtimeStatus, "stale");
  assert.equal(disabledStatus.routes.some(row => row.slug.startsWith("chatgpt-web/")), false);
});

test("CLI subagent diagnostics reject malformed Web settings instead of reporting a disabled or ready bridge", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-subagent-web-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, "codex"); mkdirSync(codexHome);
  for (const settings of ["not json", JSON.stringify({ version: 1, enabled: false, capabilities: {} })]) {
    writeFileSync(path.join(directory, "chatgpt-web.json"), settings, "utf8");
    const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../src/control.mjs"), "subagents", "status"], {
      env: { ...process.env, MODEL_ROUTER_STATE_DIR: directory, CODEX_HOME: codexHome,
        MODEL_ROUTER_MULTI_AGENT_STATE: path.join(directory, "subagents.json") }, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(run.error, undefined); assert.equal(run.status, 1); assert.equal(run.stdout, "");
    assert.match(run.stderr, /invalid state|require an in-app browser and tunnel/u);
  }
});
