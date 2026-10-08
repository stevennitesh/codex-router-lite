import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertServiceProcessStopped, assertServiceReplacementOwnership } from "../src/service-process.mjs";
import { installedSourceRoot } from "../src/install-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("operational helpers resolve the recorded checkout and refuse missing or relative installation roots", () => {
  assert.equal(installedSourceRoot({ current: { sourceRoot: root } }), root);
  assert.throws(() => installedSourceRoot({}), /explicit installation directory/u);
  assert.throws(() => installedSourceRoot({ current: { sourceRoot: "relative" } }), /explicit installation directory/u);
});
test("root restart follows the manifest and root deploy rejects checkout overlap before mutation", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-root-helpers-"));
  try {
    const source = path.join(directory, "source");
    const installed = path.join(directory, "installed");
    const state = path.join(directory, "home/codex-router");
    for (const target of [path.join(source, "src"), path.join(installed, "src"), state]) mkdirSync(target, { recursive: true });
    for (const name of ["restart-codex-router.ps1", "deploy-codex-router.ps1"]) copyFileSync(path.join(root, name), path.join(source, name));
    writeFileSync(path.join(source, "src/start.mjs"), "// fixture");
    const manifestModule = pathToFileURL(path.join(root, "src/install-manifest.mjs")).href;
    writeFileSync(path.join(source, "src/install-manifest.mjs"), `import {installedSourceRoot} from ${JSON.stringify(manifestModule)}; console.log(installedSourceRoot());`);
    const restarted = path.join(directory, "restarted.json");
    writeFileSync(path.join(installed, "src/service.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(restarted)}, JSON.stringify(process.argv.slice(2)));`);
    const manifestPath = path.join(state, "install-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 1, current: { sourceRoot: installed } }));
    const run = (script) => spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(source, script)], { encoding: "utf8", env: { ...process.env, CODEX_HOME: path.join(directory, "home"), MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state }, timeout: 10_000 });
    const restart = run("restart-codex-router.ps1");
    assert.equal(restart.status, 0, restart.stderr);
    assert.deepEqual(JSON.parse(readFileSync(restarted, "utf8")), ["restart"]);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, current: { sourceRoot: source } }));
    const deploy = run("deploy-codex-router.ps1");
    assert.notEqual(deploy.status, 0);
    assert.match(deploy.stderr, /use maintenance\\deploy-switchyard-candidate\.ps1/u);
    assert.deepEqual(JSON.parse(readFileSync(restarted, "utf8")), ["restart"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("the independent deployment worker survives termination of the entire caller tree", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "independent-deployment-"));
  const parent = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "test/fixtures/independent-deployment.ps1"), "-FixtureRoot", directory, "-CodeRoot", root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  parent.stdout.on("data", (chunk) => { output += chunk; });
  parent.stderr.on("data", (chunk) => { output += chunk; });
  const waitFor = async (check) => {
    const deadline = Date.now() + 20_000;
    while (!check() && Date.now() < deadline) await delay(100);
    assert.ok(check(), output);
  };
  let launch;
  try {
    await waitFor(() => existsSync(path.join(directory, "launch.json")));
    launch = JSON.parse(readFileSync(path.join(directory, "launch.json"), "utf8").replace(/^\uFEFF/u, ""));
    assert.equal(launch.started, true);
    // If the custodian were a descendant, /T would terminate it as well.
    execFileSync("taskkill.exe", ["/PID", String(parent.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    writeFileSync(path.join(directory, "release.txt"), "continue after caller termination");
    await waitFor(() => existsSync(path.join(directory, "survived.txt")));
    await waitFor(() => {
      try { return JSON.parse(readFileSync(launch.resultPath, "utf8").replace(/^\uFEFF/u, "")).state === "completed"; }
      catch { return false; }
    });
    assert.equal(JSON.parse(readFileSync(launch.resultPath, "utf8")).succeeded, true);
    assert.equal(readFileSync(path.join(directory, "transaction/runtime/switchyard-server.exe"), "utf8"), "previous-switchyard-server.exe");
    assert.match(readFileSync(path.join(directory, "transaction/trace.txt"), "utf8"), /stop-candidate\s+install-previous\s+healthy-previous/u);
  } finally {
    if (parent.exitCode === null) { try { execFileSync("taskkill.exe", ["/PID", String(parent.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} }
    // The worker completes before successful cleanup. On a failed test its
    // fixture-only release deadline bounds its lifetime without killing a PID
    // that might already have been reused by Windows.
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
test("a live process or listener prevents false stop success", () => {
  assert.throws(() => assertServiceProcessStopped({}, { owns: () => true }), /still running/u);
  assert.throws(() => assertServiceProcessStopped({}, { owns: () => false, listening: () => true }), /still running/u);
  assert.doesNotThrow(() => assertServiceProcessStopped({}, { owns: () => false }));
});
test("manual installation cannot transfer state away from a live previous checkout", () => {
  const state = { sourceRoot: path.resolve("previous") };
  assert.throws(() => assertServiceReplacementOwnership(state, { sourceRoot: path.resolve("candidate"), owns: () => true }), /guarded deployment/u);
  assert.doesNotThrow(() => assertServiceReplacementOwnership(state, { sourceRoot: state.sourceRoot, owns: () => true }));
  assert.doesNotThrow(() => assertServiceReplacementOwnership(state, { owns: () => false }));
});
for (const failure of ["none", "drain", "install", "health", "acceptance", "stop", "rollback-stop", "rollback-install"]) {
  test(`checkout deployment handles ${failure} with exact generation ownership`, { skip: process.platform !== "win32" }, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "switchyard-transaction-"));
    try {
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "test/fixtures/switchyard-transaction.ps1"), "-CodeRoot", root, "-FixtureRoot", directory, "-Failure", failure], { encoding: "utf8", timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr);
      const read = (name) => readFileSync(path.join(directory, name), "utf8").replace(/^\uFEFF/u, "");
      const outcome = JSON.parse(read("outcome.json"));
      const trace = read("trace.txt").trim().split(/\r?\n/u);
      if (failure === "drain") {
        assert.deepEqual(trace, ["drain"]);
        assert.equal(outcome.activationStarted, false);
        assert.equal(outcome.keepRollback, false);
        assert.match(read("error.txt"), /aborted before the running service changed/u);
      } else {
        assert.equal(outcome.keepRollback, true);
      }
      if (["drain", "install", "health", "acceptance", "stop", "rollback-install"].includes(failure)) {
        for (const name of ["switchyard-server.exe", "routes.toml", "SOURCE_COMMIT", "provenance.json"]) {
          assert.equal(read(`runtime/${name}`), `previous-${name}`);
          assert.equal(read(`rollback/${name}`), `previous-${name}`);
        }
      }
      if (["install", "health", "acceptance"].includes(failure)) {
        assert.deepEqual(trace, ["drain", "stop-previous", "install-candidate", "healthy-candidate", "stop-candidate", "install-previous", "healthy-previous"].filter((entry) => failure !== "install" || entry !== "healthy-candidate"));
        assert.match(read("error.txt"), /exact previous Router and Switchyard generation was restored/u);
        assert.equal(outcome.liveRoot, path.join(directory, "previous"));
      }
      if (["stop", "rollback-stop", "rollback-install"].includes(failure)) {
        assert.match(read("error.txt"), /rollback failed.*Recovery files remain/su);
      }
      if (failure === "rollback-stop") {
        assert.equal(read("runtime/switchyard-server.exe"), "candidate-binary");
        assert.ok(!trace.includes("install-previous"));
      }
      if (failure === "none") {
        assert.deepEqual(trace, ["drain", "stop-previous", "install-candidate", "healthy-candidate"]);
        // Consume the actual PowerShell-produced file through the Node handoff.
        assert.equal(JSON.parse(readFileSync(path.join(directory, "runtime/provenance.json"), "utf8")).routerCommit, "a".repeat(40));
        const acceptance = JSON.parse(read("acceptance.json"));
        assert.equal(acceptance.accepted, true);
        assert.equal(acceptance.routerCommit, "a".repeat(40));
        assert.equal(acceptance.rollbackRouterRoot, path.join(directory, "previous"));
        assert.equal(Object.keys(acceptance.checks).length, 11);
        assert.ok(Object.values(acceptance.checks).every(value => value === true));
      } else {
        assert.equal(existsSync(path.join(directory, "acceptance.json")), false);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("explicit forced checkout deployment keeps transaction recovery and restores admission before activation failures", {skip:process.platform!=="win32"}, () => {
  for (const failure of ["none","configuration"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(),"switchyard-forced-transaction-"));
    try {
      const result = spawnSync("powershell.exe",["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(root,"test/fixtures/switchyard-transaction.ps1"),"-CodeRoot",root,"-FixtureRoot",directory,"-Failure",failure,"-ForceServiceReplacement"],{encoding:"utf8",timeout:20000});
      assert.equal(result.status,0,result.stderr);
      const read = name => readFileSync(path.join(directory,name),"utf8").replace(/^\uFEFF/u,"");
      const outcome = JSON.parse(read("outcome.json"));
      const trace = read("trace.txt").trim().split(/\r?\n/u);
      if (failure === "none") {
        assert.deepEqual(trace,["drain","stop-previous","install-candidate","healthy-candidate"]);
        assert.equal(JSON.parse(read("acceptance.json")).accepted,true);
      } else {
        assert.deepEqual(trace,["drain","resume"]);
        assert.equal(outcome.activationStarted,false);
        assert.equal(outcome.liveRoot,path.join(directory,"previous"));
        assert.equal(read("runtime/switchyard-server.exe"),"previous-switchyard-server.exe");
        assert.match(read("error.txt"),/aborted before the running service changed/u);
      }
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }
});
