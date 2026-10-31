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
import { privateFileIsProtected, writePrivateFile } from "../src/file-security.mjs";
import { cleanupWebStopAdapterBuilds } from "../src/web-stop-adapter-cleanup.mjs";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("operational helpers resolve the recorded checkout and refuse missing or relative installation roots", () => {
  assert.equal(installedSourceRoot({ current: { sourceRoot: root } }), root);
  assert.throws(() => installedSourceRoot({}), /explicit installation directory/u);
  assert.throws(() => installedSourceRoot({ current: { sourceRoot: "relative" } }), /explicit installation directory/u);
});

test("ordinary snapshots privately publish exact adapter metadata for cleanup and preserve failures", { skip: process.platform !== "win32" }, () => {
  for (const mode of ["installed", "absent", "unknown", "original-before-refresh", "publication-failure"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "switchyard-adapter-binding-"));
    try {
      const managedDirectory = path.join(directory, "adapter-\u00e9-\u{1f680}", "e".repeat(64));
      const original = { generation: "e".repeat(64), managedDirectory, managedManifestSha256: "f".repeat(64) };
      const current = { ...original, generation: "a".repeat(64), managedDirectory: path.join(directory, "adapter", "a".repeat(64)) };
      const maintenance = path.join(directory, "maintenance"); mkdirSync(maintenance);
      const source = path.join(directory, "src"); mkdirSync(source);
      writeFileSync(path.join(source, "file-security.mjs"), `export * from ${JSON.stringify(pathToFileURL(path.join(root, "src/file-security.mjs")).href)};`);
      // Replace only the adapter ownership boundary. The production PowerShell
      // capture, argument handoff and snapshot metadata assignments run intact.
      writeFileSync(path.join(maintenance, "web-runtime-maintenance.mjs"), `
const supplied = process.argv[3];
if (${JSON.stringify(mode)} === "unknown") throw new Error("unknown private ownership");
const value = supplied === undefined ? ${JSON.stringify(mode === "absent" ? null : current)}
  : JSON.parse(Buffer.from(supplied, "base64").toString("utf8"));
process.stdout.write(JSON.stringify(value).replace(/[\\u007f-\\uffff]/g, c => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));
`);
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(root, "test/fixtures/switchyard-recovery.ps1"), "-CodeRoot", root, "-FixtureRoot", directory, "-Mode", "adapter-binding",
        ...(mode === "original-before-refresh" ? ["-RollbackAdapterJson", JSON.stringify(original)] : []),
        ...(mode === "publication-failure" ? ["-Case", mode] : [])], { encoding: "utf8", timeout: 25_000 });
      assert.equal(result.status, 0, result.stderr);
      const outcome = JSON.parse(readFileSync(path.join(directory, "outcome.json"), "utf8"));
      if (mode === "unknown") {
        assert.equal(outcome.succeeded, false);
        assert.equal(outcome.snapshotWritten, false);
        assert.match(outcome.error, /ownership is unknown/u);
      } else if (mode === "publication-failure") {
        assert.equal(outcome.succeeded, false);
        assert.equal(outcome.snapshotWritten, true);
        assert.equal(readFileSync(outcome.metadataPath, "utf8"), "retained recovery metadata");
        assert.ok(outcome.error.includes(outcome.metadataPath), outcome.error);
        assert.match(outcome.error, /Failed to publish private rollback metadata/u);
      } else {
        assert.equal(outcome.succeeded, true, outcome.error);
        const metadata = JSON.parse(readFileSync(outcome.metadataPath, "utf8"));
        assert.equal(privateFileIsProtected(outcome.metadataPath), true);
        assert.deepEqual(metadata, outcome.metadata);
        assert.equal(metadata.version, 1);
        assert.equal(metadata.previousRouterCommit, "b".repeat(40));
        assert.equal(metadata.rollbackRouterRoot, path.join(directory, "previous"));
        assert.deepEqual(metadata.files, ["routes.toml"]);
        assert.ok(Object.hasOwn(metadata, "webStopAdapter"));
        assert.deepEqual(metadata.webStopAdapter, mode === "absent" ? null : mode === "original-before-refresh" ? original : current);
        if (mode === "absent") {
          // Consume the production snapshot through cleanup's strict private
          // reader, with real protected ownership, build and retention files.
          const adapterRoot = path.join(directory, "state/web-stop-adapter"), generation = "a".repeat(64);
          const managedDirectory = path.join(adapterRoot, generation), receiptPath = path.join(adapterRoot, "ownership.json");
          mkdirSync(managedDirectory, { recursive: true });
          const hash = bytes => createHash("sha256").update(bytes).digest("hex");
          const manifest = { owner: "codex-router-web-stop-adapter-v1", version: 1, generation, files: { "entry.exe": hash("fixture entry") } };
          const manifestText = JSON.stringify(manifest);
          writePrivateFile(path.join(managedDirectory, "entry.exe"), "fixture entry");
          writePrivateFile(path.join(managedDirectory, "manifest.json"), manifestText);
          writePrivateFile(receiptPath, JSON.stringify({ owner: manifest.owner, version: 1, state: "installed", generation,
            managedDirectory, managedManifestSha256: hash(manifestText) }));
          const reads = [];
          const cleanup = cleanupWebStopAdapterBuilds({ root: adapterRoot, receiptPath, stateDir: path.join(directory, "state"),
            codexHome: path.join(directory, "home"), write: writePrivateFile,
            isPrivate: file => { reads.push(file); return privateFileIsProtected(file); },
            verifyManaged: () => manifest, readProcessCensus: () => ({ complete: true, processes: [] }),
            environment: { readPair: () => ({ CODEX_CLI_PATH: null, CODEX_NODE_REPL_PATH: path.join(managedDirectory, "entry.exe") }) } });
          assert.equal(cleanup.status, "completed", JSON.stringify(cleanup));
          assert.ok(reads.includes(outcome.metadataPath));
          assert.deepEqual(cleanup.removed, []);
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
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
  assert.throws(() => assertServiceProcessStopped({}, { status: () => "owned" }), /still running/u);
  assert.throws(() => assertServiceProcessStopped({}, { status: () => "absent", listening: () => true }), /still running/u);
  assert.doesNotThrow(() => assertServiceProcessStopped({}, { status: () => "absent" }));
  assert.throws(() => assertServiceProcessStopped({}, { status: () => "unknown" }), /stoppage is unknown/u);
  assert.throws(() => assertServiceProcessStopped({}, { status: () => "absent", listening: () => undefined }), /stoppage is unknown/u);
});
test("manual installation cannot transfer state away from a live previous checkout", () => {
  const state = { sourceRoot: path.resolve("previous") };
  assert.throws(() => assertServiceReplacementOwnership(state, { sourceRoot: path.resolve("candidate"), status: () => "owned" }), /guarded deployment/u);
  assert.doesNotThrow(() => assertServiceReplacementOwnership(state, { sourceRoot: state.sourceRoot, status: () => "owned" }));
  assert.doesNotThrow(() => assertServiceReplacementOwnership(state, { status: () => "absent" }));
  assert.throws(() => assertServiceReplacementOwnership(state, { status: () => "unknown" }), /ownership is unknown/u);
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
  for (const failure of ["none","configuration","health"]) {
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
      } else if (failure === "configuration") {
        assert.deepEqual(trace,["drain","resume"]);
        assert.equal(outcome.activationStarted,false);
        assert.equal(outcome.liveRoot,path.join(directory,"previous"));
        assert.equal(read("runtime/switchyard-server.exe"),"previous-switchyard-server.exe");
        assert.match(read("error.txt"),/aborted before the running service changed/u);
      } else {
        assert.deepEqual(trace,["drain","stop-previous","install-candidate","healthy-candidate","stop-candidate","install-previous","healthy-previous"]);
        assert.equal(outcome.liveRoot,path.join(directory,"previous"));
        assert.equal(read("runtime/switchyard-server.exe"),"previous-switchyard-server.exe");
        assert.match(read("error.txt"),/exact previous Router and Switchyard generation was restored/u);
      }
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }
});
