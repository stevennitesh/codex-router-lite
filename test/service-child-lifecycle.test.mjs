import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { openPort } from "./port-pool.mjs";
import { processCommandLine } from "../src/process-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

test("ordinary startup reaps batch descendants before retrying the optional gateway", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-child-fixture-"));
  const state = path.join(directory, "state"), trace = path.join(directory, "children.jsonl"); mkdirSync(state); writeFileSync(trace, "");
  const events = () => readFileSync(trace, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const descendant = path.join(directory, "descendant.mjs"), wrapper = path.join(directory, "gateway.cmd");
  writeFileSync(descendant, `import {readFileSync,appendFileSync} from 'node:fs';const trace=process.argv[2];const prior=readFileSync(trace,'utf8').trim().split(/\\r?\\n/u).filter(Boolean).map(JSON.parse).at(-1);let previousAlive=false;if(prior){try{process.kill(prior.pid,0);previousAlive=true;}catch(error){if(error.code!=='ESRCH')throw error;}}appendFileSync(trace,JSON.stringify({pid:process.pid,previousAlive})+'\\n');setTimeout(()=>{},30000);`);
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${descendant}" "${trace}"\r\n`);
  writeFileSync(path.join(state, "internal-secret"), "internal-child-fixture-capability-long-enough\n");
  writeFileSync(path.join(state, "caller-secret"), "caller-child-fixture-capability-long-enough\n");
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: [] }));
  const health = path.join(directory, "health.mjs"), loader = path.join(directory, "loader.mjs");
  writeFileSync(health, `import {readFileSync} from 'node:fs';import {waitForHealth as real} from ${JSON.stringify(pathToFileURL(path.join(root,'src/health-probe.mjs')).href)};let calls=0;
export async function waitForHealth(options){if(options.label!=='LiteLLM gateway')return real(options);calls++;const deadline=Date.now()+3000;while(readFileSync(${JSON.stringify(trace)},'utf8').trim().split(/\\r?\\n/u).filter(Boolean).length<calls){if(Date.now()>deadline)throw new Error('fixture descendant never started');await new Promise(r=>setTimeout(r,10));}throw new Error('intentional bounded gateway health refusal');}`);
  writeFileSync(loader, `export async function resolve(s,c,n){const found=await n(s,c);if(c.parentURL===${JSON.stringify(pathToFileURL(path.join(root,'src/start.mjs')).href)}&&found.url===${JSON.stringify(pathToFileURL(path.join(root,'src/health-probe.mjs')).href)})return{url:${JSON.stringify(pathToFileURL(health).href)},shortCircuit:true};return found;}`);
  const [gatewayPort, apiPort, routerPort] = await Promise.all([openPort(), openPort(), openPort()]);
  const env = { ...process.env, CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_LITELLM_BIN: wrapper, OPENROUTER_API_KEY: "",
    MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort), MODEL_ROUTER_API_PORT: String(apiPort), MODEL_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_RESTARTS: "1", CODEX_ROUTER_GATEWAY_RESTART_BACKOFF_MS: "0", CODEX_ROUTER_CATALOG_REFRESH_MS: "600000" };
  delete env.CODEX_ROUTER_SOURCE_ROOT;
  let child;
  try {
    child = spawn(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href, path.join(root, "src/foreground-start.mjs")], {
      env, cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    const errors = []; child.stderr.on("data", chunk => errors.push(chunk));
    const errorText = () => Buffer.concat(errors).toString("utf8");
    const deadline = Date.now() + 12_000;
    while (events().length < 2 || !errorText().includes("not restarting it again")) {
      assert.equal(child.exitCode, null, errorText());
      assert.ok(Date.now() < deadline, errorText());
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(events().length, 2);
    assert.equal(events()[1].previousAlive, false, "the first descendant is gone before the retry starts");
    assert.ok(events().every(event => !alive(event.pid)), "both failed attempt trees have been reaped");
    assert.equal((await fetch(`http://127.0.0.1:${routerPort}/live`, { signal: AbortSignal.timeout(2_000) })).status, 200);
    assert.equal(child.exitCode, null);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("close", resolve));
    }
    // Baseline failures can orphan a wrapper descendant; reap only a fixture
    // PID whose current command still names this exact disposable script.
    for (const event of events()) if (alive(event.pid) && processCommandLine(event.pid)?.includes(descendant)) {
      spawnSync("taskkill.exe", ["/PID", String(event.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^router-child-fixture-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});
