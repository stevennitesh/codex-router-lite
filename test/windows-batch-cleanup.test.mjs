import assert from "node:assert/strict";
import cp from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { withServiceOperationLock } from "../src/service-operation-lock.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";
import { stopWindowsBatchChild } from "../src/windows-batch-cleanup.mjs";
import { openPort } from "./port-pool.mjs";

const windows = process.platform === "win32";
const actualSpawn = cp.spawn;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};

async function fixture(body) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-batch-cleanup-"));
  const descendant = path.join(directory, "descendant.mjs"), trace = path.join(directory, "pid");
  const wrapper = path.join(directory, "gateway.cmd");
  writeFileSync(descendant, "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setTimeout(()=>{},30000);\n");
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${descendant}" "${trace}"\r\n`);
  const command = spawnableCommand(wrapper, []), launchedAfterMs = Date.now();
  const child = actualSpawn(command.command, command.args, { ...command.options, stdio: "inherit" });
  const lifecycle = { executable: command.command, launchedAfterMs, launchedBeforeMs: Date.now() };
  let pid;
  try {
    const deadline = Date.now() + 3_000;
    while (!existsSync(trace)) {
      assert.ok(Date.now() < deadline, "the real batch descendant started");
      await sleep(10);
    }
    pid = Number(readFileSync(trace, "utf8"));
    return await body({ child, lifecycle, pid });
  } finally {
    cp.spawn = actualSpawn;
    syncBuiltinESMExports();
    if (child.exitCode === null && child.signalCode === null) {
      const killer = actualSpawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
      await new Promise(resolve => killer.once("close", resolve));
    }
    // This exact descendant belongs to the still-open fixture ChildProcess
    // generation. A failed negative control leaves it alive intentionally.
    if (pid && alive(pid)) {
      const commandLine = cp.spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop | Select-Object -ExpandProperty CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      assert.equal(commandLine.status, 0);
      assert.ok(commandLine.stdout.includes(descendant));
      const killer = actualSpawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
      await new Promise(resolve => killer.once("close", resolve));
    }
    assert.ok(!pid || !alive(pid), "the disposable descendant was reaped");
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^router-batch-cleanup-/u);
    rmSync(directory, { recursive: true, force: true });
  }
}

function affinity(script) {
  const result = cp.spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';$p=Get-Process -Id ${process.pid};${script}`], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("a native batch root exit race completes only after the captured generations exit", { skip: !windows, timeout: 30_000 }, async () => {
  const originalAffinity = affinity("[Console]::Out.Write($p.ProcessorAffinity.ToInt64());$p.ProcessorAffinity=[IntPtr]1");
  try {
    // One CPU and reversed process priorities expose cmd's normal return from
    // its killed child before taskkill reaches cmd. No process is mocked.
    await fixture(async ({ child, pid }) => {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      const killer = actualSpawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
      os.setPriority(killer.pid, os.constants.priority.PRIORITY_LOW);
      const code = await new Promise(resolve => killer.once("close", resolve));
      assert.equal(code, 255, "the original native result rule rejects this real exit race");
      assert.equal(alive(child.pid), false);
      // Native close can precede the final descendant's signaled state.
      const deadline = Date.now() + 3_000;
      while (alive(pid) && Date.now() < deadline) await sleep(10);
      assert.equal(alive(pid), false);
    });
    await fixture(async ({ child, lifecycle, pid }) => {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      cp.spawn = (command, args, options) => {
        const spawned = actualSpawn(command, args, options);
        if (command === "taskkill.exe") os.setPriority(spawned.pid, os.constants.priority.PRIORITY_LOW);
        return spawned;
      };
      syncBuiltinESMExports();
      const receipt = await stopWindowsBatchChild(child, lifecycle);
      assert.equal(receipt.nativeCode, 255);
      assert.equal(receipt.proof, "held-handles");
      assert.ok(receipt.captured >= 2);
      assert.equal(alive(child.pid), false);
      assert.equal(alive(pid), false);
    });
  } finally {
    affinity(`$p.ProcessorAffinity=[IntPtr]::new([long]::Parse('${originalAffinity}'))`);
  }
});

test("an unbound batch root rejects cleanup before any native termination", { skip: !windows, timeout: 15_000 }, async () => {
  await fixture(async ({ child, lifecycle, pid }) => {
    let nativeKills = 0;
    cp.spawn = (command, args, options) => {
      if (command === "taskkill.exe") nativeKills++;
      return actualSpawn(command, args, options);
    };
    syncBuiltinESMExports();
    await assert.rejects(stopWindowsBatchChild(child, { ...lifecycle, launchedAfterMs: lifecycle.launchedAfterMs + 60_000 }), /cleanup failed/u);
    assert.equal(nativeKills, 0);
    assert.equal(alive(child.pid), true);
    assert.equal(alive(pid), true);
  });
});

test("batch cleanup supports the default cmd.exe shell without a ComSpec path", { skip: !windows, timeout: 15_000 }, async () => {
  await fixture(async ({ child, lifecycle, pid }) => {
    await stopWindowsBatchChild(child, { ...lifecycle, executable: path.basename(lifecycle.executable) });
    assert.equal(alive(child.pid), false);
    assert.equal(alive(pid), false);
  });
});

test("a completed nonzero native result cannot accept a surviving captured descendant", { skip: !windows, timeout: 15_000 }, async () => {
  await fixture(async ({ child, lifecycle, pid }) => {
    cp.spawn = (command, args, options) => {
      if (command !== "taskkill.exe") return actualSpawn(command, args, options);
      // Fault the native tree operation while retaining real termination and
      // the real survivor. Only its completed result is changed to nonzero.
      const spawned = actualSpawn(command, args.filter(arg => arg !== "/T"), options);
      const emit = spawned.emit;
      spawned.emit = function (event, ...values) {
        return emit.call(this, event, ...(event === "close" ? [255, values[1]] : values));
      };
      return spawned;
    };
    syncBuiltinESMExports();
    await assert.rejects(stopWindowsBatchChild(child, lifecycle), /cleanup failed/u);
    assert.equal(alive(child.pid), false);
    assert.equal(alive(pid), true, "a missing root is insufficient proof");
  });
});

test("a timed out cleanup closes both its observer and owned native operation", { skip: !windows, timeout: 15_000 }, async () => {
  await fixture(async ({ child, lifecycle, pid }) => {
    let stalled;
    let nativeBudget;
    cp.spawn = (command, args, options) => {
      if (command !== "taskkill.exe") return actualSpawn(command, args, options);
      // A real disposable process models an unresponsive native operation;
      // actual taskkill behavior is covered by the race regression above.
      nativeBudget = options.timeout;
      stalled = actualSpawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], options);
      return stalled;
    };
    syncBuiltinESMExports();
    await assert.rejects(stopWindowsBatchChild(child, lifecycle));
    assert.ok(nativeBudget > 0 && nativeBudget < 5_000, "observer startup shares the original budget");
    assert.ok(stalled.exitCode !== null || stalled.signalCode !== null);
    assert.equal(alive(stalled.pid), false, "the timed out operation cannot outlive its owner");
    assert.equal(alive(child.pid), true);
    assert.equal(alive(pid), true);
  });
});

for (const { rejectCleanup, frontendExit } of [
  { rejectCleanup: false, frontendExit: 0 },
  { rejectCleanup: true, frontendExit: 0 },
  { rejectCleanup: true, frontendExit: 95 },
]) test(frontendExit ? "foreground custody preserves frontend status 95 after cleanup failure" :
  `foreground custody covers cleanup ${rejectCleanup ? "failure" : "completion"} after the batch root closes`, { skip: !windows, timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-batch-custody-"));
  const root = path.resolve(import.meta.dirname, ".."), state = path.join(directory, "state");
  mkdirSync(state);
  const trace = path.join(directory, "descendant-pid"), wrapper = path.join(directory, "gateway.cmd");
  const descendant = path.join(directory, "descendant.mjs");
  writeFileSync(descendant, "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setTimeout(()=>{},30000);\n");
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${descendant}" "${trace}"\r\n`);
  writeFileSync(path.join(state, "internal-secret"), "internal-custody-fixture-capability-long-enough\n");
  writeFileSync(path.join(state, "caller-secret"), "caller-custody-fixture-capability-long-enough\n");
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: [] }));
  const codex = path.join(directory, "codex.cmd"), codexScript = path.join(directory, "codex.mjs");
  writeFileSync(codexScript, "const a=process.argv.slice(2).join(' ');if(a==='--version')console.log('codex-cli 0.153.0');else if(a==='login status'){console.error('Not logged in');process.exitCode=1;}else if(a==='debug models --bundled')console.log(JSON.stringify({models:[]}));else process.exitCode=2;");
  writeFileSync(codex, `@echo off\r\n"${process.execPath}" "${codexScript}" %*\r\n`);
  const health = path.join(directory, "health.mjs"), cleanup = path.join(directory, "cleanup.mjs");
  const url = file => pathToFileURL(file).href;
  writeFileSync(health, `import {existsSync} from 'node:fs';import {waitForHealth as real} from ${JSON.stringify(url(path.join(root,"src/health-probe.mjs")))};
export async function waitForHealth(options){if(options.label==='Codex router')globalThis.fixtureFrontend=options.child;if(options.label!=='LiteLLM gateway')return real(options);while(!existsSync(${JSON.stringify(trace)}))await new Promise(r=>setTimeout(r,10));throw new Error('intentional gateway startup refusal');}`);
  // Delay only the completion handoff after the real native tree cleanup and
  // witness have succeeded. No tree cleanup or descendant exit is mocked.
  writeFileSync(cleanup, `import {stopWindowsBatchChild as real} from ${JSON.stringify(url(path.join(root,"src/windows-batch-cleanup.mjs")))};
export async function stopWindowsBatchChild(child,lifecycle){const proof=await real(child,lifecycle);process.send({type:'cleanup-proof',rootPid:child.pid});await new Promise(resolve=>{const listener=message=>{if(message.type==='release-cleanup'){process.off('message',listener);resolve();}};process.on('message',listener);});if(${rejectCleanup})throw new Error('intentional cleanup handoff failure');return proof;}`);
  const loader = path.join(directory, "loader.mjs"), controller = path.join(directory, "controller.mjs");
  const crashTrigger = path.join(directory, "crash-frontend"), preload = path.join(directory, "preload.mjs");
  // Exercise the real frontend's diagnostic exit handler, after it is healthy
  // and its gateway cleanup is held. The preload affects only this router argv.
  writeFileSync(preload, `import {existsSync} from 'node:fs';import path from 'node:path';if(path.resolve(process.argv[1]||'')===${JSON.stringify(path.join(root,"src/router.mjs"))}){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(crashTrigger)})){clearInterval(timer);throw new Error('intentional fixture frontend crash');}},10);timer.unref();}`);
  writeFileSync(loader, `export async function resolve(s,c,n){const found=await n(s,c);if(c.parentURL===${JSON.stringify(url(path.join(root,"src/start.mjs")))}){if(found.url===${JSON.stringify(url(path.join(root,"src/health-probe.mjs")))})return{url:${JSON.stringify(url(health))},shortCircuit:true};if(found.url===${JSON.stringify(url(path.join(root,"src/windows-batch-cleanup.mjs")))})return{url:${JSON.stringify(url(cleanup))},shortCircuit:true};}return found;}`);
  writeFileSync(controller, `import {writeFileSync} from 'node:fs';let completed=false;process.on('message',message=>{if(message.type==='close-frontend'){const child=globalThis.fixtureFrontend;child.once('close',()=>process.send({type:'frontend-closed',code:child.exitCode}));if(${frontendExit})writeFileSync(${JSON.stringify(crashTrigger)},'crash');else child.kill('SIGTERM');}else if(message.type==='checkpoint')process.send({type:'checkpoint',completed});else if(message.type==='finish')process.disconnect();});await import(${JSON.stringify(url(path.join(root,"src/foreground-start.mjs")))});completed=true;process.send({type:'import-complete'});`);
  const [gatewayPort, apiPort, routerPort] = await Promise.all([openPort(), openPort(), openPort()]);
  const env = { ...process.env, CODEX_BIN: codex, CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_LITELLM_BIN: wrapper, OPENROUTER_API_KEY: "",
    MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort), MODEL_ROUTER_API_PORT: String(apiPort), MODEL_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_RESTARTS: "0", CODEX_ROUTER_CATALOG_REFRESH_MS: "600000" };
  delete env.CODEX_ROUTER_SOURCE_ROOT;
  if (frontendExit) env.NODE_OPTIONS = `--import=${url(preload)}`;
  const child = actualSpawn(process.execPath, ["--no-warnings", "--experimental-loader", url(loader), controller], {
    env, cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages = [], errors = [];
  child.on("message", message => messages.push(message));
  child.stderr.on("data", chunk => errors.push(chunk));
  async function message(type) {
    const deadline = Date.now() + 12_000;
    while (!messages.some(value => value.type === type)) {
      assert.equal(child.exitCode, null, Buffer.concat(errors).toString("utf8"));
      assert.ok(Date.now() < deadline, `missing fixture checkpoint: ${type}`);
      await sleep(10);
    }
    return messages.find(value => value.type === type);
  }
  try {
    const proof = await message("cleanup-proof");
    assert.equal(alive(proof.rootPid), false);
    assert.equal(alive(Number(readFileSync(trace, "utf8"))), false);
    child.send({ type: "close-frontend" });
    const frontend = await message("frontend-closed");
    if (frontendExit) assert.equal(frontend.code, frontendExit, "the real frontend emitted its diagnostic status before cleanup release");
    // Exercise the actual competing operation rather than inferring custody
    // from process liveness or waiting for a missing completion message.
    await assert.rejects(withServiceOperationLock(() => "replacement", { stateDir: state, waitMs: 500, retryMs: 25 }), /Another background-service operation/u);
    child.send({ type: "checkpoint" });
    assert.equal((await message("checkpoint")).completed, false);
    const entries = cp.spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Get-ChildItem -LiteralPath '${path.join(state,"service-operation.lock").replaceAll("'","''")}' | Select-Object -ExpandProperty Name`], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    assert.equal(entries.status, 0);
    assert.match(entries.stdout, new RegExp(`owner-${child.pid}-`));
    child.send({ type: "release-cleanup" });
    await message("import-complete");
    assert.equal(await withServiceOperationLock(() => "replacement", { stateDir: state, waitMs: 500, retryMs: 25 }), "replacement");
    child.send({ type: "finish" });
    await new Promise(resolve => child.once("close", resolve));
    assert.equal(child.exitCode, frontendExit || (rejectCleanup ? 1 : 0), Buffer.concat(errors).toString("utf8"));
    if (rejectCleanup) assert.match(Buffer.concat(errors).toString("utf8"), /cleanup failed: intentional cleanup handoff failure/u);
  } finally {
    if (child.connected) child.send({ type: "release-cleanup" });
    if (child.exitCode === null && child.signalCode === null) {
      const killer = actualSpawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
      await new Promise(resolve => killer.once("close", resolve));
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("close", resolve));
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^router-batch-custody-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});
