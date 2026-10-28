import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const fixtureParent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.tmp");
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(path.join(fixtureParent, "web-tunnel-tests-"));
const syntheticEnvironment = {
  CODEX_HOME: path.join(fixtureRoot, "codex"), MODEL_ROUTER_STATE_DIR: path.join(fixtureRoot, "router-state"),
  CODEX_ROUTER_STATE_DIR: path.join(fixtureRoot, "router-state"),
  MODEL_ROUTER_MODEL_PICKER_STATE: path.join(fixtureRoot, "model-picker.json"),
  MODEL_ROUTER_MULTI_AGENT_STATE: path.join(fixtureRoot, "multi-agent-settings.json"),
};
Object.assign(process.env, syntheticEnvironment);
for (const [name, expected] of Object.entries(syntheticEnvironment)) {
  assert.equal(process.env[name], expected, `${name} must be synthetic before loading any production module.`);
  assert.ok(!path.relative(fixtureRoot, expected).startsWith(".."));
}
mkdirSync(syntheticEnvironment.CODEX_HOME);
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const { privateFileIsProtected } = await import("../src/file-security.mjs");
const { startWebTunnel } = await import("../src/web-tunnel.mjs");

const secret = "synthetic_runtime_key_not_for_public_output";
const serverUrl = `http://127.0.0.1:17845/${"a".repeat(64)}/mcp`;
const scalar = (config, name) => JSON.parse(new RegExp(`^\\s+${name}: (".*")$`, "mu").exec(config)[1]);
const pollingHealth = (details = {}, fields = {}) => ({
  status: "ok", state: "polling", limited: false,
  details: { last_success: "2026-10-19T20:00:00Z", consecutive_failures: 0, ...details }, ...fields,
});
const healthSnapshot = (poll = pollingHealth(), fields = {}) => ({
  schema_version: 1, live: true, ready: true, snapshot_at: "2026-10-19T20:00:01Z",
  runtime: { instance_id: "a".repeat(32), version: "0.0.16", flavor: "full",
    started_at: "2026-10-19T19:00:00Z", uptime_seconds: 3601, lifecycle: "running" },
  components: { "control-plane": poll }, ...fields,
});
const waitFor = async predicate => {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for the tunnel state.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

class Child extends EventEmitter {
  pid = 10420;
  exitCode = null;
  signalCode = null;
  kills = [];
  finish(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
  kill(signal) {
    this.kills.push(signal);
    // Closure is a separate observation; requesting termination is insufficient.
    setTimeout(() => this.finish(null, signal), 15);
    return true;
  }
}

async function fixture(t) {
  const root = mkdtempSync(path.join(fixtureRoot, "codex-web-tunnel-"));
  const stateDir = path.join(root, "state");
  const keyPath = path.join(root, "runtime-key.secret");
  writeFileSync(keyPath, `${secret}\n`, { mode: 0o600 });
  const requests = [], observed = {};
  let healthStatus = 200, readyStatus = 200, pollHealth = pollingHealth(), pollStatus = 200, snapshotFields = {}, tunnel, expectedCloseCode;
  let holdResponse, bodyOverride;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (holdResponse) { holdResponse(response); holdResponse = undefined; return; }
    if (request.url === "/health?details=true") {
      response.writeHead(pollStatus, { "Content-Type": "application/json" });
      response.end(bodyOverride ?? JSON.stringify(healthSnapshot(pollHealth, { live: healthStatus === 200, ready: readyStatus === 200, ...snapshotFields })));
      return;
    }
    response.writeHead(404);
    response.end("unsupported health route");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = new Child();
  t.after(async () => {
    try { await tunnel?.close(); }
    catch (error) { if (!expectedCloseCode) throw error; assert.equal(error.code, expectedCloseCode); }
    finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      rmSync(root, { recursive: true, force: true });
    }
  });
  const spawnImpl = (command, args, options) => {
    observed.command = command;
    observed.args = structuredClone(args);
    observed.options = options;
    observed.configFile = args[args.indexOf("--config") + 1];
    observed.config = readFileSync(observed.configFile, "utf8");
    observed.healthFile = scalar(observed.config, "url_file");
    writeFileSync(observed.healthFile, `http://127.0.0.1:${server.address().port}\n`, "utf8");
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const options = { executable: process.execPath, tunnelId: "tunnel_native_codex", keyPath, serverUrl, stateDir, spawnImpl };
  return { root, stateDir, keyPath, requests, observed, child, options,
    expectCloseFailure: code => { expectedCloseCode = code; },
    setHealth: (health, readiness) => { healthStatus = health; readyStatus = readiness; },
    setPolling: (value, status = 200) => { pollHealth = value; pollStatus = status; },
    setSnapshot: fields => { snapshotFields = fields; },
    setBody: value => { bodyOverride = value; },
    holdNextResponse: () => new Promise(resolve => { holdResponse = resolve; }),
    async start(extra = {}) { tunnel = await startWebTunnel({ ...options, ...extra }); return tunnel; },
  };
}

test("official client receives protected YAML references and observed successful polling establishes readiness", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const tunnel = await f.start();
  await tunnel.ready;
  assert.deepEqual(f.observed.args, ["run", "--config", f.observed.configFile, "--admin-ui.log-buffer-events", "1"]);
  assert.equal(f.observed.command, process.execPath);
  assert.equal(f.observed.options.shell, false);
  assert.equal(f.observed.options.windowsHide, true);
  assert.equal(f.observed.options.stdio, "ignore");
  assert.equal(scalar(f.observed.config, "api_key"), `file:${f.keyPath}`);
  assert.equal(scalar(f.observed.config, "url"), serverUrl);
  assert.ok(f.observed.config.includes('listen_addr: "127.0.0.1:0"'));
  assert.equal(f.observed.config.includes(secret), false);
  assert.equal(JSON.stringify(f.observed.args).includes(serverUrl), false);
  assert.equal(JSON.stringify(f.observed.args).includes(secret), false);
  assert.equal(JSON.stringify(tunnel.status()).includes(serverUrl), false);
  if (process.platform === "win32") assert.equal(privateFileIsProtected(f.observed.configFile), true);
  assert.deepEqual(f.requests, ["/health?details=true"], "One aggregate request replaces the three startup probes.");
  assert.deepEqual(tunnel.status(), { state: "ready", running: true, healthy: true, ready: true, pid: f.child.pid });
  const firstClose = tunnel.close();
  assert.equal(tunnel.close(), firstClose);
  assert.equal(existsSync(f.observed.configFile), true);
  assert.equal(tunnel.status().running, true);
  await firstClose;
  assert.deepEqual(f.child.kills, ["SIGTERM"]);
  assert.equal(existsSync(f.observed.configFile), false);
  assert.equal(existsSync(f.observed.healthFile), false);
  assert.deepEqual(readdirSync(f.stateDir), []);
  assert.equal(readFileSync(f.keyPath, "utf8"), `${secret}\n`);
  assert.deepEqual(tunnel.status(), { state: "stopped", running: false, healthy: false, ready: false, pid: f.child.pid });
});

test("isolated tunnel environment excludes native credentials and inherited tunnel overrides", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const injected = ["OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "OPENROUTER_API_KEY", "CODEX_ROUTER_CALLER_SECRET", "CONTROL_PLANE_API_KEY", "MCP_EXTRA_HEADERS", "MCP_SERVER_URL", "TUNNEL_CLIENT_CONFIG", "NODE_OPTIONS"];
  const previous = new Map(injected.map(name => [name, process.env[name]]));
  let tunnel;
  try {
    for (const name of injected) process.env[name] = `synthetic_${name}`;
    tunnel = await f.start();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  await tunnel.ready;
  for (const name of injected) assert.equal(f.observed.options.env[name], undefined);
  assert.equal(JSON.stringify(f.observed.options.env).includes(secret), false);
});

test("the owner waits for an actual child process to close before removing its private configuration", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  let child, configFile;
  const program = `
    const fs = require("node:fs"), http = require("node:http");
    const config = fs.readFileSync(process.argv[1], "utf8");
    const scalar = name => JSON.parse(new RegExp('^\\\\s+' + name + ': (".*")$', 'm').exec(config)[1]);
    // Even unsafe vendor diagnostics must remain outside Router output.
    console.error(scalar("url"));
    console.error(fs.readFileSync(scalar("api_key").slice(5), "utf8"));
    const server = http.createServer((request, response) => response.end(request.url === "/health?details=true"
      ? JSON.stringify(${JSON.stringify(healthSnapshot())}) : "unsupported"));
    server.listen(0, "127.0.0.1", () => fs.writeFileSync(scalar("url_file"), "http://127.0.0.1:" + server.address().port));
  `;
  const tunnel = await f.start({ spawnImpl: (executable, args, options) => {
    configFile = args[args.indexOf("--config") + 1];
    child = spawn(executable, ["-e", program, configFile], options);
    return child;
  } });
  await tunnel.ready;
  assert.equal(tunnel.status().pid, child.pid);
  assert.equal(child.stdout, null);
  assert.equal(child.stderr, null);
  assert.equal(child.exitCode, null);
  await tunnel.close();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(existsSync(configFile), false);
  assert.deepEqual(readdirSync(f.stateDir), []);
  assert.equal(readFileSync(f.keyPath, "utf8"), `${secret}\n`);
});

test("cleanup failures retain only bounded operation, errno and post-close directory state diagnostics", { timeout: 25_000 }, async t => {
  for (const kind of ["config", "health", "unknown-entry"]) await t.test(kind, async t => {
    const f = await fixture(t);
    const tunnel = await f.start();
    await tunnel.ready;
    const ownedDirectory = path.dirname(f.observed.configFile);
    let obstruction;
    if (kind === "unknown-entry") {
      obstruction = path.join(ownedDirectory, `private-name-${secret}`);
      writeFileSync(obstruction, `${serverUrl}\n`, "utf8");
    } else {
      obstruction = kind === "config" ? f.observed.configFile : f.observed.healthFile;
      rmSync(obstruction);
      mkdirSync(obstruction);
    }
    f.expectCloseFailure("web_tunnel_cleanup_failed");
    const closing = tunnel.close();
    assert.equal(tunnel.close(), closing);
    assert.equal(tunnel.status().running, true);
    assert.equal(tunnel.status().cleanupFailures, undefined, "No cleanup observation precedes actual child closure.");
    let retained;
    await assert.rejects(closing, error => {
      retained = error;
      assert.equal(error.code, "web_tunnel_cleanup_failed");
      assert.equal(error.cause, undefined);
      assert.deepEqual(error.cleanupFailures.map(value => value.operation), [
        ...(kind === "unknown-entry" ? [] : [`unlink-${kind}`]), "rmdir-owned",
      ]);
      for (const value of error.cleanupFailures) {
        assert.deepEqual(Object.keys(value), value.operation === "rmdir-owned" ? ["operation", "errno", "directoryState"] : ["operation", "errno"]);
        assert.ok(["EACCES", "EEXIST", "EISDIR", "ENOTEMPTY", "EPERM"].includes(value.errno));
      }
      assert.equal(error.cleanupFailures.at(-1).directoryState, "nonempty");
      for (const privateValue of [secret, serverUrl, f.root, f.keyPath, obstruction]) {
        assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(privateValue), false);
      }
      return true;
    });
    assert.equal(tunnel.status().running, false);
    assert.equal(tunnel.status().error, "web_tunnel_cleanup_failed");
    assert.deepEqual(tunnel.status().cleanupFailures, retained.cleanupFailures);
    assert.equal(existsSync(obstruction), true, "The owner never recursively removes unexpected directory entries.");
    assert.equal(readFileSync(f.keyPath, "utf8"), `${secret}\n`);
    await assert.rejects(tunnel.close(), error => error === retained);
    assert.deepEqual(f.child.kills, ["SIGTERM"]);
  });
});

test("liveness alone cannot resolve readiness and shutdown cancels the outstanding readiness promise", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  f.setHealth(200, 503);
  const tunnel = await f.start();
  let resolved = false;
  void tunnel.ready.then(() => { resolved = true; }, () => {});
  await waitFor(() => tunnel.status().healthy);
  assert.equal(resolved, false);
  assert.equal(tunnel.status().healthy, true);
  assert.equal(tunnel.status().ready, false);
  const rejected = assert.rejects(tunnel.ready, { code: "web_tunnel_cancelled" });
  await tunnel.close();
  await rejected;
  assert.deepEqual(readdirSync(f.stateDir), []);
});

test("a rejected runtime key fails readiness despite passing local probes and cleans owned private state", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  f.setPolling(pollingHealth({ last_success: undefined, consecutive_failures: 201, failure_category: "http_error", http_status: 401 },
    { status: "degraded", state: "backoff", reason_code: "http_error", last_error: `untrusted ${secret} ${serverUrl}` }));
  const tunnel = await f.start();
  await assert.rejects(tunnel.ready, error => {
    assert.equal(error.code, "web_tunnel_auth_rejected");
    assert.match(error.message, /runtime key|Tunnels.*Use/u);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(serverUrl), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  await tunnel.close();
  assert.deepEqual(f.requests, ["/health?details=true"]);
  assert.deepEqual(tunnel.status(), { state: "failed", running: false, healthy: false, ready: false, pid: f.child.pid, error: "web_tunnel_auth_rejected" });
  assert.deepEqual(f.child.kills, ["SIGTERM"]);
  assert.deepEqual(readdirSync(f.stateDir), []);
  assert.equal(readFileSync(f.keyPath, "utf8"), `${secret}\n`);
});

test("local readiness waits for the first successful poll and keeps a long poll or local backpressure ready", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  f.setPolling(pollingHealth({ last_success: undefined }, { status: "unknown" }));
  const tunnel = await f.start();
  let resolved = false;
  void tunnel.ready.then(() => { resolved = true; }, () => {});
  await waitFor(() => f.requests.length >= 2);
  assert.equal(resolved, false);
  assert.equal(tunnel.status().ready, false);
  f.setPolling(pollingHealth());
  await tunnel.ready;
  assert.equal(tunnel.status().ready, true);
  const count = f.requests.length;
  f.setPolling(pollingHealth({}, { state: "backpressured" }));
  await waitFor(() => f.requests.length >= count + 2);
  assert.equal(tunnel.status().ready, true);
});

test("a later poll authorization failure revokes readiness and stops the owned daemon", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const tunnel = await f.start();
  await tunnel.ready;
  f.setPolling(pollingHealth({ consecutive_failures: 1, failure_category: "http_error", http_status: 403 },
    { status: "degraded", state: "backoff" }));
  await waitFor(() => tunnel.status().state === "failed");
  await tunnel.close();
  assert.equal(tunnel.status().error, "web_tunnel_auth_rejected");
  assert.equal(tunnel.status().ready, false);
  assert.equal(tunnel.status().healthy, false);
  assert.deepEqual(readdirSync(f.stateDir), []);
});

test("a failed poll revokes current readiness until a subsequent successful poll", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const tunnel = await f.start();
  await tunnel.ready;
  f.setPolling(pollingHealth({ consecutive_failures: 1, failure_category: "http_error", http_status: 503 },
    { status: "degraded", state: "backoff" }));
  await waitFor(() => tunnel.status().healthy === false);
  assert.equal(tunnel.status().ready, false);
  assert.equal(tunnel.status().running, true);
  f.setPolling(pollingHealth({}, { state: "idle" }));
  await waitFor(() => tunnel.status().ready);
  assert.equal(tunnel.status().healthy, true);
  assert.deepEqual(f.child.kills, []);
});

test("unavailable or unsupported poll diagnostics cannot establish readiness", { timeout: 45_000 }, async t => {
  const cases = [
    ["route unavailable", {}, pollingHealth(), 404],
    ["transient HTTP failure", {}, pollingHealth(), 503],
    ["local HTTP denial is not hosted-poll rejection", {}, pollingHealth(), 403],
    ["unsupported schema", { schema_version: 2 }],
    ["missing liveness", { live: undefined }],
    ["missing readiness", { ready: undefined }],
    ["invalid readiness type", { ready: "true" }],
    ["missing components", { components: undefined }],
    ["missing control-plane", { components: { mcp: pollingHealth() } }],
    ["limited control-plane", {}, pollingHealth({}, { limited: true })],
    ["omitted control-plane details", {}, pollingHealth({}, { details: undefined })],
    ["invalid failure count", {}, pollingHealth({ consecutive_failures: -1 })],
    ["missing poll timestamp", {}, pollingHealth({ last_success: undefined })],
    ["invalid poll timestamp", {}, pollingHealth({ last_success: "not a timestamp" })],
    ["oversized aggregate", { future_field: "x".repeat(64 * 1024) }],
  ];
  for (const [name, fields, poll = pollingHealth(), status = 200] of cases) {
    await t.test(name, async t => {
      const f = await fixture(t);
      f.setPolling(poll, status);
      f.setSnapshot(fields);
      const tunnel = await f.start();
      let resolved = false;
      void tunnel.ready.then(() => { resolved = true; }, () => {});
      // A second request can only start after the first sample was consumed.
      await waitFor(() => f.requests.length >= 2);
      assert.equal(resolved, false);
      assert.equal(tunnel.status().ready, false);
      assert.equal(tunnel.status().running, true);
      assert.deepEqual(f.child.kills, []);
      const rejected = assert.rejects(tunnel.ready, { code: "web_tunnel_cancelled" });
      await tunnel.close();
      await rejected;
    });
  }
});

test("aggregate byte budget accepts the documented limit and rejects one extra byte with recovery", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const empty = healthSnapshot(pollingHealth(), { future_field: "" });
  const padding = "x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(empty)));
  f.setSnapshot({ future_field: padding });
  const tunnel = await f.start();
  await tunnel.ready;
  assert.equal(tunnel.status().ready, true, "Aggregate responses above the former 24 KiB component limit are supported.");
  f.setSnapshot({ future_field: `${padding}x` });
  await waitFor(() => !tunnel.status().healthy);
  assert.equal(tunnel.status().ready, false);
  f.setSnapshot({ future_field: "x".repeat(25 * 1024), truncated: true });
  // Truncation elsewhere does not invalidate complete control-plane evidence.
  await waitFor(() => tunnel.status().ready);
  assert.deepEqual(f.child.kills, []);
});

test("aggregate liveness and local startup readiness each gate successful poll evidence", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const tunnel = await f.start();
  await tunnel.ready;
  f.setHealth(503, 200);
  await waitFor(() => !tunnel.status().healthy);
  assert.equal(tunnel.status().ready, false);
  f.setHealth(200, 503);
  await waitFor(() => tunnel.status().healthy);
  assert.equal(tunnel.status().ready, false);
  f.setHealth(200, 200);
  await waitFor(() => tunnel.status().ready);
  assert.deepEqual(f.child.kills, []);
});

test("transient HTTP and malformed aggregate bodies revoke current readiness and recover", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const tunnel = await f.start();
  await tunnel.ready;
  for (const [status, body] of [[503, undefined], [200, "{"], [200, Buffer.from([0xff])]]) {
    f.setPolling(pollingHealth(), status);
    f.setBody(body);
    await waitFor(() => !tunnel.status().healthy);
    assert.equal(tunnel.status().ready, false);
    assert.equal(tunnel.status().running, true);
    f.setPolling(pollingHealth());
    f.setBody(undefined);
    await waitFor(() => tunnel.status().ready);
    assert.deepEqual(f.child.kills, []);
  }
});

test("an unfinished aggregate request cannot overlap another poll or restore readiness during close", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const tunnel = await f.start();
  await tunnel.ready;
  const pending = f.holdNextResponse();
  const response = await pending;
  const count = f.requests.length;
  // Keep the response pending across the next cadence tick, using its actual
  // abort as evidence that the bounded request has drained.
  const drained = new Promise(resolve => response.once("close", resolve));
  await drained;
  assert.equal(f.requests.length, count, "The 1.5s request spans a 1s cadence tick without overlapping it.");
  await waitFor(() => !tunnel.status().healthy);
  await waitFor(() => tunnel.status().ready);
  const pendingClose = f.holdNextResponse();
  const closingResponse = await pendingClose;
  const closingDrain = new Promise(resolve => closingResponse.once("close", resolve));
  const closing = tunnel.close();
  closingResponse.end(JSON.stringify(healthSnapshot()));
  await Promise.all([closing, closingDrain]);
  assert.equal(tunnel.status().ready, false);
  assert.equal(tunnel.status().healthy, false);
  assert.equal(tunnel.status().state, "stopped");
});

test("a late successful snapshot cannot restore readiness before child closure", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const requested = Promise.withResolvers(), result = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", () => { requested.resolve(); return result.promise; });
  t.mock.method(f.child, "kill", signal => { f.child.kills.push(signal); return true; });
  const tunnel = await f.start();
  await requested.promise;
  const rejected = assert.rejects(tunnel.ready, { code: "web_tunnel_cancelled" });
  const closing = tunnel.close();
  result.resolve(new Response(JSON.stringify(healthSnapshot())));
  // Drain the resolved fetch/body microtasks without inferring success from
  // elapsed time. The synthetic child stays open until assertions complete.
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(tunnel.status().state, "stopping");
    assert.equal(tunnel.status().running, true);
    assert.equal(tunnel.status().healthy, false);
    assert.equal(tunnel.status().ready, false);
  } finally { f.child.finish(null, "SIGTERM"); }
  await closing;
  await rejected;
  assert.deepEqual(f.child.kills, ["SIGTERM"]);
});

test("signal cancellation stops the owned child, removes private files, and preserves the key", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const tunnel = await f.start({ signal: controller.signal });
  await tunnel.ready;
  controller.abort(new Error(`untrusted reason ${secret}`));
  await tunnel.close();
  assert.equal(tunnel.status().state, "stopped");
  assert.equal(existsSync(f.observed.configFile), false);
  assert.equal(readFileSync(f.keyPath, "utf8"), `${secret}\n`);
  const before = readdirSync(f.stateDir);
  await assert.rejects(startWebTunnel({ ...f.options, signal: controller.signal }), error => error.code === "web_tunnel_cancelled" && !error.message.includes(secret));
  assert.deepEqual(readdirSync(f.stateDir), before);
});

test("spawn failures return fixed errors and remove only their own private state", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.start({ spawnImpl: () => { throw new Error(`raw failure ${secret} ${serverUrl}`); } }), error => {
    assert.equal(error.code, "web_tunnel_start_failed");
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(serverUrl), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(readdirSync(f.stateDir), []);
  assert.equal(readFileSync(f.keyPath, "utf8"), `${secret}\n`);
  const child = new Child();
  const tunnel = await f.start({ spawnImpl: () => {
    queueMicrotask(() => { child.emit("error", new Error(`raw child failure ${secret}`)); child.finish(-1); });
    return child;
  } });
  await assert.rejects(tunnel.ready, { code: "web_tunnel_start_failed" });
  await tunnel.close();
  assert.equal(tunnel.status().error, "web_tunnel_start_failed");
  assert.deepEqual(readdirSync(f.stateDir), []);
});

test("an exited daemon loses readiness and its private state is cleaned without retaining child diagnostics", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const tunnel = await f.start();
  await tunnel.ready;
  f.child.finish(23);
  await tunnel.close();
  assert.deepEqual(tunnel.status(), { state: "failed", running: false, healthy: false, ready: false, pid: f.child.pid, error: "web_tunnel_exited" });
  assert.deepEqual(readdirSync(f.stateDir), []);
  assert.deepEqual(f.child.kills, []);
});

test("untrusted health URL files cannot redirect health checks to another destination", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const baseSpawn = f.options.spawnImpl;
  const tunnel = await f.start({ signal: controller.signal, spawnImpl: (...args) => {
    const child = baseSpawn(...args);
    writeFileSync(f.observed.healthFile, `http://user:password@127.0.0.1:${new URL(serverUrl).port}/`, "utf8");
    return child;
  } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(tunnel.status().ready, false);
  assert.deepEqual(f.requests, []);
  const rejected = assert.rejects(tunnel.ready, { code: "web_tunnel_cancelled" });
  controller.abort();
  await tunnel.close();
  await rejected;
  for (const target of ["http://example.com/mcp", "http://127.0.0.1:17845/mcp", `${serverUrl}?extra=1`]) {
    await assert.rejects(startWebTunnel({ ...f.options, serverUrl: target }), { code: "web_tunnel_invalid_config" });
  }
  assert.deepEqual(readdirSync(f.stateDir), []);
});
