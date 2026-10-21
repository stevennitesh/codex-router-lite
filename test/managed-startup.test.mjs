import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { openPort } from "./port-pool.mjs";
import { serviceProcessOwns } from "../src/service-process.mjs";

const root = path.resolve(import.meta.dirname, "..");

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("managed startup did not stop")), 8_000)),
  ]);
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`managed startup exited: ${child.errors()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // The managed path has not bound the Router port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`managed startup did not become healthy: ${child.errors()}`);
}

for (const foreground of [false, true]) {
for (const selectedProviders of [[], ["openrouter"]]) {
for (const gatewayFails of [false, true]) {
  test(`${foreground ? "foreground" : "managed"} startup supports native requests without a provider key (${selectedProviders.length ? "OpenRouter selected" : "native only"}, ${gatewayFails ? "optional spawn failure" : "healthy gateway"})`,
    {
      skip: process.platform !== "win32",
      timeout: 30_000,
    }, async t => {
      const state = mkdtempSync(path.join(os.tmpdir(), "codex-router-startup-"));
      const [nativePort, gatewayPort, apiPort, routerPort] = await Promise.all([
        openPort(), openPort(), openPort(), openPort(),
      ]);
      const nativeRequests = [];
      const native = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        nativeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        json(response, 200, {
          id: "resp_native_startup",
          status: "completed",
          model: "gpt-5.6-sol",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native ready" }] }],
        });
      });
      await listen(native, nativePort);
      const gatewayCommand = path.join(state, gatewayFails ? "unusable-gateway.exe" : "gateway.cmd");
      if (gatewayFails) mkdirSync(gatewayCommand);
      else writeFileSync(
        gatewayCommand,
        `@echo off\r\n"${process.execPath}" "${path.join(root, "test", "managed-startup-gateway-fixture.mjs")}" %*\r\n`,
      );
      writeFileSync(path.join(state, "internal-secret"), "internal-startup-capability-long-enough\n");
      writeFileSync(path.join(state, "caller-secret"), "caller-startup-capability-long-enough\n");
      writeFileSync(
        path.join(state, "enabled-providers.json"),
        `${JSON.stringify({ version: 1, providers: selectedProviders })}\n`,
      );
      const recordPath = path.join(state, "service-process.json");
      const previousRecord = '{"version":1,"managed":true,"synthetic":"prior managed record"}\n';
      if (foreground) writeFileSync(recordPath, previousRecord);
      const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = spawn(foreground ? shell : process.execPath, foreground
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "model-router.ps1"), "codex", "start", "--foreground"]
        : [path.join(root, "src", "start.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          CODEX_HOME: path.join(state, "codex"),
          OPENROUTER_API_KEY: "",
          MODEL_ROUTER_STATE_DIR: state,
          CODEX_ROUTER_STATE_DIR: state,
          MODEL_ROUTER_LITELLM_BIN: gatewayCommand,
          CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}/backend-api/codex`,
          MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
          MODEL_ROUTER_API_PORT: String(apiPort),
          MODEL_ROUTER_PORT: String(routerPort),
          CODEX_ROUTER_CATALOG_REFRESH_MS: "600000",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      const errors = [];
      child.stderr.on("data", (chunk) => errors.push(chunk));
      child.errors = () => Buffer.concat(errors).toString("utf8");
      t.after(async () => {
        await stopChild(child).catch(() => child.kill("SIGKILL"));
        native.closeAllConnections();
        await new Promise((resolve) => native.close(resolve));
        rmSync(state, { recursive: true, force: true });
      });

      const healthUrl = `http://127.0.0.1:${routerPort}/${gatewayFails ? "live" : "health"}`;
      assert.equal((await waitForHealth(healthUrl, child)).ok, true);
      if (gatewayFails) {
        const deadline = Date.now() + 5_000;
        while (!child.errors().includes("spawn ") && Date.now() < deadline) {
          assert.equal(child.exitCode, null, child.errors());
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.match(child.errors(), /spawn .*ENOENT/u);
        assert.doesNotMatch(child.errors(), /Unhandled 'error' event/u);
        assert.equal(child.exitCode, null);
      }
      if (foreground) {
        assert.equal(readFileSync(recordPath, "utf8"), previousRecord, "foreground startup preserves the managed record");
      } else {
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        assert.equal(record.pid, child.pid);
        assert.equal(serviceProcessOwns(record, { sourceRoot: root, stateDir: state }), true);
      }
      const fullHealth = await fetch(
        `http://127.0.0.1:${routerPort}/_codex-router/caller-startup-capability-long-enough/v1/health`,
      );
      assert.equal(fullHealth.status, gatewayFails ? 503 : 200);
      const health = await fullHealth.json();
      if (gatewayFails) assert.ok(health.degraded.includes("gateway"));
      if (selectedProviders.length) {
        assert.equal(health.api.reachable, true);
        assert.equal(health.api.ready, false);
        assert.equal(health.api.credential_present, false);
      } else {
        assert.deepEqual(health.api, { reachable: true, enabled: false });
      }

      const nativeResponse = await fetch(
        `http://127.0.0.1:${routerPort}/_codex-router/caller-startup-capability-long-enough/v1/responses`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-native-session",
            "chatgpt-account-id": "synthetic-account",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "native startup proof", stream: false }),
        },
      );
      assert.equal(nativeResponse.status, 200, await nativeResponse.text());
      assert.equal(nativeRequests.length, 1);

      const external = await fetch(
        `http://127.0.0.1:${routerPort}/_codex-router/caller-startup-capability-long-enough/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openrouter/pareto", input: "must remain unavailable" }),
        },
      );
      assert.equal(external.status, selectedProviders.length ? 401 : 409);
    });
}
}
}

for (const mode of ["shutdown", "deadline", "deadline-inconclusive"]) test(mode === "shutdown"
  ? "startup hosts catalog checks without an idle watcher and retains shutdown custody through refresh-tree cleanup"
  : `catalog deadline retains tree custody and ${mode === "deadline" ? "retries after completed cleanup" : "blocks retries after inconclusive cleanup"}`, {
  skip: process.platform !== "win32", timeout: 30_000,
}, async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-catalog-startup-"));
  const state = path.join(directory, "state"), source = path.join(directory, "source");
  mkdirSync(state);
  mkdirSync(path.join(source, "src"), { recursive: true });
  writeFileSync(path.join(state, "internal-secret"), "internal-catalog-fixture-capability-long-enough\n");
  writeFileSync(path.join(state, "caller-secret"), "caller-catalog-fixture-capability-long-enough\n");
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: [] }));
  const trace = path.join(directory, "refresh.json"), descendantTrace = path.join(directory, "probe-pid");
  const descendant = path.join(directory, "probe.mjs");
  writeFileSync(descendant, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(descendantTrace)},String(process.pid));process.send({ready:true});setInterval(()=>{},1000);`);
  writeFileSync(path.join(source, "src", "catalog.mjs"), `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const probe=spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});probe.once('message',()=>process.stdout.write(JSON.stringify({event:'probe-ready',pid:process.pid})+'\\n'));writeFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),managedEnvironment:process.env.MODEL_ROUTER_QUIET==='1'&&process.env.CODEX_ROUTER_INTERNAL_KEY==='internal-catalog-fixture-capability-long-enough'}));setInterval(()=>{},1000);`);
  const url = file => pathToFileURL(file).href;
  const health = path.join(directory, "health.mjs"), config = path.join(directory, "config.mjs");
  writeFileSync(health, "export async function waitForHealth(){return {ok:true};}");
  writeFileSync(config, "export function writeLiteLlmConfig(){}");
  const cleanup = path.join(directory, "cleanup.mjs");
  writeFileSync(cleanup, `import {readFileSync} from 'node:fs';import {stopWindowsBatchChild as real} from ${JSON.stringify(url(path.join(root, "src/windows-batch-cleanup.mjs")))};let calls=0;
export async function stopWindowsBatchChild(child,lifecycle){const call=++calls;const receipt=await real(child,lifecycle);const pid=Number(readFileSync(${JSON.stringify(descendantTrace)},'utf8'));let descendantAlive=true;try{process.kill(pid,0);}catch(error){if(error.code!=='ESRCH')throw error;descendantAlive=false;}process.send({type:'cleanup-proof-'+call,receipt,descendantAlive});await new Promise(resolve=>{const listener=message=>{if(message.type==='release-cleanup'){process.off('message',listener);resolve();}};process.on('message',listener);});if(${mode === "deadline-inconclusive"}&&call===1)throw new Error('intentional inconclusive tree cleanup proof');return receipt;}`);
  const loader = path.join(directory, "loader.mjs");
  writeFileSync(loader, `const replacements=new Map(${JSON.stringify([
    [url(path.join(root, "src/health-probe.mjs")), url(health)],
    [url(path.join(root, "src/litellm-config.mjs")), url(config)],
  ])});export async function resolve(s,c,n){const found=await n(s,c);const replacement=c.parentURL===${JSON.stringify(url(path.join(root, "src/start.mjs")))}?replacements.get(found.url):c.parentURL===${JSON.stringify(url(path.join(root, "src/catalog-auto-refresh.mjs")))}&&found.url===${JSON.stringify(url(path.join(root, "src/windows-batch-cleanup.mjs")))}?${JSON.stringify(url(cleanup))}:undefined;return replacement?{url:replacement,shortCircuit:true}:found;}`);
  const controller = path.join(directory, "controller.mjs");
  writeFileSync(controller, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import path from 'node:path';import {mock} from 'node:test';import {markForegroundSupervisor} from ${JSON.stringify(url(path.join(root, "src/service-process.mjs")))};
const actualSpawn=cp.spawn,actualExecFile=cp.execFile;let launches=[],refreshes=0,completed=false;
cp.spawn=(command,args,options)=>{const script=path.basename(args[0]||'');if(['router.mjs','api-forwarder.mjs','catalog-auto-refresh.mjs'].includes(script)||args.includes('--config')){launches.push(script==='--config'?'gateway':script);return actualSpawn(process.execPath,['--input-type=module','-e','setInterval(()=>{},1000)'],options);}return actualSpawn(command,args,options);};
cp.execFile=(command,args,...rest)=>{const child=actualExecFile(command,args,...rest);if(path.basename(args[0]||'')==='catalog.mjs'){const iteration=++refreshes;let output='';child.stdout.on('data',chunk=>{output+=chunk;for(let newline;(newline=output.indexOf('\\n'))!==-1;){const line=output.slice(0,newline);output=output.slice(newline+1);if(JSON.parse(line).event==='probe-ready')process.send({type:'probe-ready-'+iteration});}});child.once('close',()=>process.send({type:'refresh-closed-'+iteration,pid:child.pid}));}return child;};const actualError=console.error;console.error=(...values)=>{actualError(...values);if(String(values[0]).includes('automatic catalog refresh failed:'))process.send({type:'refresh-failed',message:String(values[0])});};syncBuiltinESMExports();markForegroundSupervisor();mock.timers.enable({apis:['setInterval','setTimeout']});
process.on('message',message=>{if(message.type==='advance'){mock.timers.tick(message.milliseconds??30000);process.send({type:message.checkpoint,completed,launches,refreshes});}else if(message.type==='stop')process.emit('SIGTERM');else if(message.type==='finish')process.disconnect();});
await import(${JSON.stringify(url(path.join(root, "src/start.mjs")))});completed=true;process.send({type:'import-complete',launches,refreshes});`);
  const child = spawn(process.execPath, ["--no-warnings", "--experimental-loader", url(loader), controller], {
    cwd: root,
    env: {
      ...process.env, CODEX_ROUTER_SOURCE_ROOT: source, CODEX_HOME: path.join(directory, "codex"),
      CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_LITELLM_BIN: process.execPath, OPENROUTER_API_KEY: "",
      CODEX_ROUTER_CATALOG_REFRESH_MS: "10000", CODEX_ROUTER_GATEWAY_RESTARTS: "0",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  const messages = [], errors = [];
  child.on("message", message => messages.push(message));
  child.stderr.on("data", chunk => errors.push(chunk));
  const diagnostic = () => Buffer.concat(errors).toString("utf8");
  const message = type => new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      child.off("message", check); child.off("close", closed);
      t.signal.removeEventListener("abort", aborted); settle(value);
    };
    const closed = () => finish(reject, new Error(`catalog fixture closed before ${type}: ${diagnostic()}`));
    const aborted = () => finish(reject, new Error(`catalog fixture timed out at ${type}: ${diagnostic()}`));
    const check = () => {
      const found = messages.find(value => value.type === type);
      if (found) return finish(resolve, found);
      if (child.exitCode !== null || child.signalCode !== null) return closed();
      if (t.signal.aborted) return aborted();
    };
    child.on("message", check); child.once("close", closed);
    t.signal.addEventListener("abort", aborted, { once: true }); check();
  });
  try {
    // The real catalog fixture starts eagerly and owns a real disposable probe.
    await message("probe-ready-1");
    const refresh = JSON.parse(readFileSync(trace, "utf8"));
    assert.deepEqual(refresh.args, ["--refresh-if-stale"]);
    assert.equal(refresh.managedEnvironment, true);
    child.send({ type: "advance", checkpoint: "active-checkpoint" });
    const active = await message("active-checkpoint");
    assert.equal(active.refreshes, 1, "interval ticks cannot overlap the active refresh");
    assert.deepEqual(active.launches, ["router.mjs", "api-forwarder.mjs", "gateway"], "three persistent children; no fourth watcher process");
    if (mode === "shutdown") child.send({ type: "stop" });
    else child.send({ type: "advance", milliseconds: 180_000, checkpoint: "deadline-checkpoint" });
    const proof = await message("cleanup-proof-1");
    assert.equal(proof.descendantAlive, false, "cancellation reaps the catalog-owned probe too");
    assert.equal((await message("refresh-closed-1")).pid, refresh.pid, "the actual refresh child has closed");
    child.send({ type: "advance", checkpoint: "stopping-checkpoint" });
    const stopping = await message("stopping-checkpoint");
    assert.equal(stopping.completed, false, "supervisor import keeps custody after child close until native cleanup settles");
    assert.equal(stopping.refreshes, 1);
    child.send({ type: "release-cleanup" });
    if (mode !== "shutdown") {
      const failure = await message("refresh-failed");
      assert.match(failure.message, mode === "deadline" ? /timed out after 180000 ms/u : /inconclusive tree cleanup proof/u);
      child.send({ type: "advance", checkpoint: "retry-checkpoint" });
      const retry = await message("retry-checkpoint");
      assert.equal(retry.refreshes, mode === "deadline" ? 2 : 1,
        "a deadline permits another check only after complete tree cleanup proof");
      if (mode === "deadline") await message("probe-ready-2");
      child.send({ type: "stop" });
      if (mode === "deadline") {
        assert.equal((await message("cleanup-proof-2")).descendantAlive, false);
        await message("refresh-closed-2");
        child.send({ type: "release-cleanup" });
      }
    }
    const expectedRefreshes = mode === "deadline" ? 2 : 1;
    assert.equal((await message("import-complete")).refreshes, expectedRefreshes);
    child.send({ type: "advance", checkpoint: "stopped-checkpoint" });
    const stopped = await message("stopped-checkpoint");
    assert.equal(stopped.completed, true);
    assert.equal(stopped.refreshes, expectedRefreshes, "no refresh is restarted after supervisor shutdown");
    if (mode === "shutdown") assert.doesNotMatch(diagnostic(), /catalog refresh cleanup failed|automatic catalog refresh failed/u);
    else if (mode === "deadline-inconclusive") assert.match(diagnostic(), /catalog refresh cleanup failed/u);
  } finally {
    if (child.connected) child.send({ type: "finish" });
    await stopChild(child);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^router-catalog-startup-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});
