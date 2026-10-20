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
    readAdapterStatus: () => ({ installed: true, state: "installed", conflicts: [], appLoaded: "unknown", hookTrusted: "unknown",
      restartRequired: "unknown", trustRequired: "unknown" }),
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
