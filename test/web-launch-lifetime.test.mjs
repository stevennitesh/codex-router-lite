import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function until(check, message) {
  const deadline = Date.now() + 15_000;
  while (!check()) { assert.ok(Date.now() < deadline, message); await sleep(25); }
}
function powershell(script, extra = {}) {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 20_000, ...extra });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test("Web launcher survives its requesting process tree while retaining only isolated bridge state", {
  skip: process.platform !== "win32", timeout: 60_000,
}, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-web-lifetime-"));
  const executable = path.join(directory, "disposable launcher.exe");
  const source = path.join(directory, "fixture.cs");
  const callerScript = path.join(directory, "caller.mjs");
  const receiptPath = path.join(directory, "receipt.json");
  const isolatedHome = path.join(directory, "native");
  const stateDir = path.join(directory, "state");
  const controlHome = path.join(directory, "control");
  const bridgeHome = path.join(stateDir, "web-bridge", "browser");
  let caller, receipt;
  const launchedPids = [];
  try {
    mkdirSync(path.join(isolatedHome, "sessions"), { recursive: true });
    mkdirSync(controlHome);
    writeFileSync(path.join(isolatedHome, "auth.json"), '{"fixture":"native credentials must stay private"}');
    writeFileSync(source, `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public class Fixture {
  public static void Main() {
    string root = Environment.GetEnvironmentVariable("CODEX_WEB_GPT_LAUNCHER_DATA_DIR");
    File.WriteAllLines(Path.Combine(root, "process.txt"), new string[] {
      Process.GetCurrentProcess().Id.ToString(), Process.GetCurrentProcess().SessionId.ToString(),
      Environment.GetEnvironmentVariable("CODEX_HOME"), Environment.GetEnvironmentVariable("CODEX_CHATGPT_WEB_HOME"), root,
      Environment.GetEnvironmentVariable("OPENROUTER_API_KEY") == null ? "credential absent" : "credential present",
      Environment.GetEnvironmentVariable("NODE_OPTIONS") == null ? "node options absent" : "node options present"
    });
    while (!File.Exists(Path.Combine(root, "stop"))) Thread.Sleep(25);
  }
}
`, "utf8");
    powershell('Add-Type -Path $env:FIXTURE_SOURCE -OutputAssembly $env:FIXTURE_EXECUTABLE -OutputType ConsoleApplication',
      { env: { ...process.env, FIXTURE_SOURCE: source, FIXTURE_EXECUTABLE: executable } });
    const moduleUrl = pathToFileURL(path.resolve("src/chatgpt-web.mjs")).href;
    writeFileSync(callerScript, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchWebBridge } from ${JSON.stringify(moduleUrl)};
const executable = process.argv[2];
// This is the previous implementation, retained as a real negative control.
const control = spawn(executable, [], { detached: true, windowsHide: true, stdio: "ignore",
  env: { ...process.env, CODEX_WEB_GPT_LAUNCHER_DATA_DIR: process.argv[4] } });
await new Promise((resolve, reject) => { control.once("spawn", resolve); control.once("error", reject); });
control.unref();
const result = await launchWebBridge(executable);
writeFileSync(process.argv[3], JSON.stringify({ ...result, callerPid: process.pid, controlPid: control.pid }));
setInterval(() => {}, 1000);
`, "utf8");
    caller = spawn(process.execPath, [callerScript, executable, receiptPath, controlHome], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: isolatedHome, CODEX_ROUTER_STATE_DIR: stateDir,
        OPENROUTER_API_KEY: "disposable-test-credential", NODE_OPTIONS: "--no-warnings" },
    });
    let failure = "";
    caller.stderr.setEncoding("utf8").on("data", chunk => { failure += chunk; });
    await until(() => { assert.equal(caller.exitCode, null, failure); return existsSync(receiptPath); }, "independent launch returned a receipt");
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    launchedPids.push(receipt.controlPid, receipt.processId);
    await until(() => existsSync(path.join(bridgeHome, "process.txt")) && existsSync(path.join(controlHome, "process.txt")),
      "both independent launcher and detached negative control started");
    const observation = readFileSync(path.join(bridgeHome, "process.txt"), "utf8").trim().split(/\r?\n/u);
    const control = readFileSync(path.join(controlHome, "process.txt"), "utf8").trim().split(/\r?\n/u);
    assert.equal(Number(observation[0]), receipt.processId);
    assert.equal(observation[1], control[1], "the independent launcher stays in the same Windows user session");
    assert.equal(observation[2], path.join(stateDir, "web-bridge", "codex"));
    assert.equal(observation[3], path.join(stateDir, "web-bridge", "bridge"));
    assert.equal(observation[4], bridgeHome);
    assert.equal(observation[5], "credential absent");
    assert.equal(observation[6], "node options absent");
    assert.equal(control[5], "credential present", "the negative control reproduces the previous inherited environment");
    assert.equal(existsSync(path.join(stateDir, "web-bridge", "codex", "auth.json")), false);

    const killed = spawnSync("taskkill.exe", ["/PID", String(caller.pid), "/T", "/F"],
      { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    assert.equal(killed.status, 0, killed.stderr);
    await until(() => !alive(receipt.controlPid) && !alive(caller.pid), "caller and ordinary detached child were terminated");
    assert.equal(alive(receipt.processId), true, "provider-owned launcher survives Codex-like caller tree shutdown");
    writeFileSync(path.join(bridgeHome, "stop"), "stop fixture");
    await until(() => !alive(receipt.processId), "independent launcher remains explicitly stoppable");
  } finally {
    if (caller?.pid && alive(caller.pid)) {
      spawnSync("taskkill.exe", ["/PID", String(caller.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    }
    // If launch failed after process creation, its fixture trace still owns
    // enough information to stop it without touching any actual launcher.
    for (const root of [bridgeHome, controlHome]) {
      if (existsSync(root)) writeFileSync(path.join(root, "stop"), "stop fixture");
      if (existsSync(path.join(root, "process.txt"))) launchedPids.push(Number(readFileSync(path.join(root, "process.txt"), "utf8").split(/\r?\n/u)[0]));
    }
    for (const pid of new Set(launchedPids)) {
      if (!alive(pid)) continue;
      await until(() => !alive(pid), "owned fixture stops during cleanup");
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^router-web-lifetime-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});
