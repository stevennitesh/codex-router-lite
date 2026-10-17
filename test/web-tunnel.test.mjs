import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";
import { startWebTunnel } from "../src/web-tunnel.mjs";

const secret = "synthetic_runtime_key_not_for_public_output";
const serverUrl = `http://127.0.0.1:17845/${"a".repeat(64)}/mcp`;
const scalar = (config, name) => JSON.parse(new RegExp(`^\\s+${name}: (".*")$`, "mu").exec(config)[1]);

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
  const root = mkdtempSync(path.join(tmpdir(), "codex-web-tunnel-"));
  const stateDir = path.join(root, "state");
  const keyPath = path.join(root, "runtime-key.secret");
  writeFileSync(keyPath, `${secret}\n`, { mode: 0o600 });
  const requests = [], observed = {};
  let healthStatus = 200, readyStatus = 200, tunnel;
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(request.url === "/healthz" ? healthStatus : readyStatus);
    response.end("health body is never retained");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = new Child();
  t.after(async () => {
    try { await tunnel?.close(); }
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
    setHealth: (health, readiness) => { healthStatus = health; readyStatus = readiness; },
    async start(extra = {}) { tunnel = await startWebTunnel({ ...options, ...extra }); return tunnel; },
  };
}

test("official client receives protected YAML references and real loopback health establishes readiness", { timeout: 25_000 }, async t => {
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
  assert.deepEqual(f.requests.slice(0, 2), ["/healthz", "/readyz"]);
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
    const server = http.createServer((request, response) => response.end("ready"));
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

test("liveness alone cannot resolve readiness and shutdown cancels the outstanding readiness promise", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  f.setHealth(200, 503);
  const tunnel = await f.start();
  let resolved = false;
  void tunnel.ready.then(() => { resolved = true; }, () => {});
  await new Promise(resolve => {
    const check = setInterval(() => { if (f.requests.includes("/readyz")) { clearInterval(check); resolve(); } }, 10);
  });
  assert.equal(resolved, false);
  assert.equal(tunnel.status().healthy, true);
  assert.equal(tunnel.status().ready, false);
  const rejected = assert.rejects(tunnel.ready, { code: "web_tunnel_cancelled" });
  await tunnel.close();
  await rejected;
  assert.deepEqual(readdirSync(f.stateDir), []);
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
