import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const powershell = windows ? path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : "powershell.exe";
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function fixture(tool, { mode = "dependencies", broken = false, failService = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-installer-maintenance-"));
  const source = path.join(directory, "source");
  const bin = path.join(directory, "bin");
  const home = path.join(directory, "home");
  const trace = path.join(directory, "trace.txt");
  for (const target of [path.join(source, "src"), path.join(source, "requirements"), bin]) mkdirSync(target, { recursive: true });
  writeFileSync(trace, "");
  writeFileSync(path.join(source, "package.json"), '{"name":"codex-router-lite","type":"module"}');
  writeFileSync(path.join(source, "package-lock.json"), "fixture lock");
  for (const file of ["install.ps1", "src/install-plan.mjs", "src/venv-runtime.mjs", "requirements/python.in", "requirements/python.txt"]) {
    copyFileSync(path.join(root, file), path.join(source, file));
  }
  const executable = path.join(bin, "python-fixture.exe");
  execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -Path ${quote(path.join(root, "test/fixtures/python-environment-tool.cs"))} -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`], { windowsHide: true, encoding: "utf8" });
  writeFileSync(path.join(bin, "py.cmd"), `@echo off\r\n"${executable}" %*\r\nexit /b %errorlevel%\r\n`);
  if (tool === "uv") writeFileSync(path.join(bin, "uv.cmd"), `@echo off\r\n"${executable}" --fixture-uv %*\r\nexit /b %errorlevel%\r\n`);
  const nodeTrace = path.join(bin, "node-trace.mjs");
  writeFileSync(nodeTrace, `import {appendFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const args=process.argv.slice(2); appendFileSync(process.env.ROUTER_INSTALL_TRACE,'node\\t'+args.join('\\t')+'\\n'); const result=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'}); process.exit(result.status ?? 1);`);
  writeFileSync(path.join(bin, "node.cmd"), `@echo off\r\n"${process.execPath}" "${nodeTrace}" %*\r\nexit /b %errorlevel%\r\n`);
  writeFileSync(path.join(bin, "npm.cmd"), "@echo off\r\nif not exist node_modules mkdir node_modules\r\necho fixture>node_modules\\.package-lock.json\r\nexit /b 0\r\n");
  const forbidden = ["config-manager", "service", "provider-selection", "service-process", "secret", "catalog", "litellm-config", "install-manifest", "skills-install", "service-drain", "wait-health"];
  for (const name of forbidden) {
    let action = "";
    if (mode === "dependencies" || name === "wait-health") action = `throw new Error('unexpected ${name} invocation');`;
    else if (name === "config-manager") action = "if(process.argv[2]==='status')console.log(JSON.stringify({mode:'router'}));";
    else if (name === "service") {
      action = `if(process.argv[2]==='status')console.log(JSON.stringify({installed:${mode === "full"}}));`;
      if (failService) action += `if(process.argv[2]==='install'){ const p=${JSON.stringify(path.join(directory, "service-failed"))}; const fs=await import('node:fs'); if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exitCode=8;} }`;
    }
    writeFileSync(path.join(source, "src", `${name}.mjs`), action);
  }
  if (broken) {
    const scripts = path.join(source, ".venv/Scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(executable, path.join(scripts, "python.exe"));
    writeFileSync(path.join(scripts, "broken.txt"), "fixture broken stdlib");
    writeFileSync(path.join(source, ".venv/pyvenv.cfg"), `home = ${directory}\nversion = 3.12.12\n`);
  }
  const environment = {
    ...process.env,
    PATH: [bin, path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot].join(path.delimiter),
    CODEX_HOME: home,
    MODEL_ROUTER_STATE_DIR: path.join(home, "codex-router"),
    CODEX_ROUTER_STATE_DIR: path.join(home, "codex-router"),
    ROUTER_INSTALL_TRACE: trace,
  };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  const run = (args) => spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(source, "install.ps1"), "-CheckoutInstall", ...args], { encoding: "utf8", windowsHide: true, env: environment, timeout: 30_000 });
  return { directory, source, home, trace, environment, run, calls: () => readFileSync(trace, "utf8").trim().split(/\r?\n/u).filter(Boolean) };
}

for (const tool of ["uv", "pip"]) {
  test(`dependency-only preparation executes the hashed ${tool} lock install and reuses valid stamps`, { skip: !windows }, () => {
    const f = fixture(tool);
    try {
      if (tool === "uv") {
        const directInput = path.join(f.source, "requirements/python.in");
        writeFileSync(directInput, "litellm[proxy]==1.96.1\nfastapi==0.141.1\n");
        const refused = f.run(["-DependenciesOnly"]);
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /at or above 1\.96\.2/u);
        assert.ok(!f.calls().some((line) => line.includes("--require-hashes")));
        assert.equal(existsSync(path.join(f.source, "node_modules")), false);
        copyFileSync(path.join(root, "requirements/python.in"), directInput);
      }
      const result = f.run(["-DependenciesOnly"]);
      assert.equal(result.status, 0, result.stderr);
      const install = f.calls().filter((line) => line.includes("--require-hashes"));
      assert.equal(install.length, 1);
      assert.match(install[0], /\t--require-hashes\t-r\trequirements\/python\.txt$/u);
      assert.equal(install[0].startsWith(`${tool === "uv" ? "uv" : "python"}\t`), true);
      assert.equal(existsSync(f.home), false, "dependency preparation never creates Codex state");
      const priorCalls = f.calls().length;
      const second = f.run(["-DependenciesOnly"]);
      assert.equal(second.status, 0, second.stderr);
      assert.ok(!f.calls().slice(priorCalls).some((line) => line.includes("--require-hashes")));
      assert.ok(!f.calls().some((line) => /\b(config-manager|service|secret|catalog|litellm-config|install-manifest)\.mjs/u.test(line)));
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
}

test("dependency-only preparation repairs a present but broken Python runtime", { skip: !windows }, () => {
  const f = fixture("uv", { broken: true });
  try {
    const result = f.run(["-DependenciesOnly"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().some((line) => line.startsWith("uv\tvenv\t") && line.includes("\t--clear\t")));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("PrepareOnly retains catalog generation and full install delegates readiness to service installation", { skip: !windows }, () => {
  for (const mode of ["prepare", "full"]) {
    const f = fixture("uv", { mode, failService: mode === "full" });
    try {
      if (mode === "full") {
        mkdirSync(path.join(f.source, ".venv/Scripts"), { recursive: true });
        writeFileSync(path.join(f.source, ".venv/previous.txt"), "retained environment");
      }
      const result = f.run(mode === "prepare" ? ["-PrepareOnly"] : ["-ForceDeps"]);
      const calls = f.calls();
      if (mode === "prepare") {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(calls.some((line) => line.includes("src/catalog.mjs\t--refresh-native")));
        assert.ok(calls.some((line) => line.includes("src/litellm-config.mjs")));
        assert.ok(!calls.some((line) => /service\.mjs\tinstall$/u.test(line)));
      } else {
        assert.notEqual(result.status, 0, "candidate service failure must remain failure after recovery");
        assert.equal(calls.filter((line) => /service\.mjs\tinstall$/u.test(line)).length, 2, `${result.stderr}\n${calls.join("\n")}`);
        for (const line of calls.filter((value) => /service\.mjs\t(?:stop|install)(?:\t|$)/u.test(value))) {
          assert.deepEqual(line.split("\t").slice(3), [], "ordinary installation never adds force");
        }
        assert.equal(readFileSync(path.join(f.source, ".venv/previous.txt"), "utf8"), "retained environment");
      }
      assert.ok(!calls.some((line) => line.includes("wait-health.mjs")), "service install owns liveness readiness");
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});

function serviceFailures(f, { failedStop = 0, failRecoveryInstall = false } = {}) {
  const countsPath = path.join(f.directory, "service-counts.json");
  writeFileSync(path.join(f.source, "src/service.mjs"), `
import {existsSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
const file = ${JSON.stringify(countsPath)};
const counts = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {stop:0,install:0};
const command = process.argv[2];
if(command==='status') console.log(JSON.stringify({installed:true}));
if(command==='stop'||command==='install') {
  counts[command]++;
  if(command==='install'&&counts.install===1) counts.previous = readdirSync(${JSON.stringify(f.source)}).find(n=>n.startsWith('.venv-previous-'));
  writeFileSync(file,JSON.stringify(counts));
  if(command==='stop'&&counts.stop===${failedStop}) process.exitCode=7;
  if(command==='install'&&(counts.install===1||${failRecoveryInstall})) process.exitCode=8;
}
`);
  return () => JSON.parse(readFileSync(countsPath, "utf8"));
}

test("Python activation and recovery retain environments when stop refuses", { skip: !windows }, () => {
  for (const failedStop of [1, 2]) {
    const f = fixture("uv", { mode: "full" });
    try {
      assert.equal(f.run(["-DependenciesOnly"]).status, 0);
      writeFileSync(path.join(f.source, ".venv/previous.txt"), "previous environment");
      const counts = serviceFailures(f, { failedStop });
      const result = f.run(["-ForceDeps"]);
      assert.notEqual(result.status, 0);
      const state = counts();
      assert.equal(state.stop, failedStop);
      assert.equal(state.install, failedStop === 1 ? 0 : 1);
      const previousRoot = failedStop === 1 ? path.join(f.source, ".venv") : path.join(f.source, state.previous);
      assert.equal(readFileSync(path.join(previousRoot, "previous.txt"), "utf8"), "previous environment");
      if (failedStop === 2) {
        assert.equal(existsSync(path.join(f.source, ".venv/previous.txt")), false);
        assert.equal(existsSync(path.join(f.source, ".venv/Scripts/python.exe")), true);
        assert.match(result.stderr, /Install failed.*Python environment rollback failed/u);
        assert.ok(result.stderr.includes(state.previous), "refusal names the retained recovery path");
      }
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("a failed previous-service install retains the failed candidate for recovery", { skip: !windows }, () => {
  const f = fixture("uv", { mode: "full" });
  try {
    assert.equal(f.run(["-DependenciesOnly"]).status, 0);
    writeFileSync(path.join(f.source, ".venv/previous.txt"), "previous environment");
    serviceFailures(f, { failRecoveryInstall: true });
    const result = f.run(["-ForceDeps"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /previous Router service could not be restored/u);
    assert.equal(readFileSync(path.join(f.source, ".venv/previous.txt"), "utf8"), "previous environment");
    const failed = /\.venv-failed-[0-9a-f]{32}/u.exec(result.stderr)?.[0];
    assert.ok(failed);
    assert.equal(existsSync(path.join(f.source, failed, "Scripts/python.exe")), true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("Python restore failure after verified stop retains both recovery inputs", { skip: !windows }, () => {
  const f = fixture("uv", { mode: "full" });
  try {
    assert.equal(f.run(["-DependenciesOnly"]).status, 0);
    writeFileSync(path.join(f.source, ".venv/previous.txt"), "previous environment");
    const counts = serviceFailures(f);
    const wrapper = path.join(f.directory, "restore-failure.ps1");
    writeFileSync(wrapper, `function Move-Item {
param([string]$LiteralPath, [string]$Destination)
if ($LiteralPath -match '\\.venv-previous-') { throw 'fixture restore move failure' }
Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
try { & ${quote(path.join(f.source, "install.ps1"))} -CheckoutInstall -ForceDeps }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`);
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], { env: f.environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture restore move failure/u);
    assert.deepEqual({ stop: counts().stop, install: counts().install }, { stop: 2, install: 1 });
    assert.equal(readFileSync(path.join(f.source, counts().previous, "previous.txt"), "utf8"), "previous environment");
    const failed = /\.venv-failed-[0-9a-f]{32}/u.exec(result.stderr)?.[0];
    assert.ok(failed, result.stderr);
    assert.equal(existsSync(path.join(f.source, failed, "Scripts/python.exe")), true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("bootstrap and direct installation preserve explicit replacement as one native argument", { skip: !windows }, () => {
  for (const checkout of [false, true]) {
    const f = fixture("uv", { mode: "full", failService: true });
    try {
      // Git is discovered by bootstrap but this fixture must never call it.
      writeFileSync(path.join(f.directory, "bin/git.cmd"), "@echo off\r\nexit /b 9\r\n");
      assert.equal(f.run(["-DependenciesOnly"]).status, 0);
      writeFileSync(path.join(f.source, ".venv/previous.txt"), "previous environment");
      writeFileSync(path.join(f.source, "src/service-drain.mjs"), "if(process.argv[2]==='prepare'&&!process.argv.includes('--force-service-replacement'))process.exitCode=7;");
      const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(f.source, "install.ps1"), ...(checkout ? ["-CheckoutInstall"] : []), "-ForceDeps"];
      const denied = spawnSync(powershell, args, { env: f.environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /replacement was deferred/u);
      assert.ok(!f.calls().some((line) => line.includes("service.mjs\tinstall")));
      writeFileSync(f.trace, "");
      const result = spawnSync(powershell, [...args, "-ForceServiceReplacement"], { env: f.environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
      assert.notEqual(result.status, 0, "original candidate failure is retained after successful recovery");
      assert.match(result.stderr, /Background-service installation failed/u);
      const mutations = f.calls().filter((line) => /service\.mjs\t(?:stop|install)\t/u.test(line));
      assert.equal(mutations.length, 4, result.stderr);
      for (const line of mutations) assert.deepEqual(line.split("\t").slice(3), ["--force-service-replacement"]);
      assert.equal(readFileSync(path.join(f.source, ".venv/previous.txt"), "utf8"), "previous environment");
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("the updater reinstall reaches the installer with explicit replacement intact", { skip: !windows }, () => {
  const f = fixture("uv", { mode: "full" });
  try {
    assert.equal(f.run(["-DependenciesOnly"]).status, 0);
    mkdirSync(path.join(f.source, ".git"));
    copyFileSync(path.join(root, "src/update.mjs"), path.join(f.source, "src/update.mjs"));
    writeFileSync(path.join(f.source, "src/paths.mjs"), `export const SOURCE_ROOT=${JSON.stringify(f.source)};`);
    writeFileSync(path.join(f.source, "src/install-manifest.mjs"), "export const readInstallManifest=()=>({current:{commit:null}});");
    writeFileSync(path.join(f.source, "src/service-drain.mjs"), "if(process.argv[2]==='prepare'&&!process.argv.includes('--force-service-replacement'))process.exitCode=7;");
    const fakeGit = path.join(f.directory, "bin/git.exe");
    const code = 'using System; public static class FixtureGit { public static int Main(string[] args) { if(Array.IndexOf(args,"remote")>=0) Console.WriteLine("https://github.com/stevennitesh/codex-router-lite.git"); else if(Array.IndexOf(args,"rev-parse")>=0) Console.WriteLine(new string(\'a\',40)); else if(Array.IndexOf(args,"fetch")<0) return 9; return 0; } }';
    execFileSync(powershell, ["-NoLogo", "-NoProfile", "-Command", `Add-Type -TypeDefinition ${quote(code)} -OutputAssembly ${quote(fakeGit)} -OutputType ConsoleApplication`], { encoding: "utf8", windowsHide: true });
    const args = [path.join(f.source, "src/update.mjs")];
    const options = { env: { ...f.environment, PATH: f.environment.PATH + path.delimiter + path.dirname(powershell) }, encoding: "utf8", windowsHide: true, timeout: 30_000 };
    const denied = spawnSync(process.execPath, args, options);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /replacement was deferred/u);
    writeFileSync(f.trace, "");
    const result = spawnSync(process.execPath, [...args, "--force-service-replacement"], options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"reinstalled": true/u);
    const installed = f.calls().filter((line) => line.includes("service.mjs\tinstall"));
    assert.equal(installed.length, 1);
    assert.deepEqual(installed[0].split("\t").slice(3), ["--force-service-replacement"]);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("failed first installation preserves explicit force through service cleanup", { skip: !windows }, () => {
  const f = fixture("uv", { mode: "prepare", failService: true });
  try {
    const result = f.run(["-ForceServiceReplacement"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Background-service installation failed/u);
    const commands = f.calls().filter((line) => /service\.mjs\t(?:install|uninstall)(?:\t|$)/u.test(line));
    assert.equal(commands.length, 2);
    for (const line of commands) assert.deepEqual(line.split("\t").slice(3), ["--force-service-replacement"]);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("rollback preparation reaches both current and retained installer contracts without editing prior code", { skip: !windows }, () => {
  for (const scenario of ["new", "legacy", "failure"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "router-rollback-preparation-"));
    try {
      const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "test/fixtures/rollback-preparation.ps1"), "-CodeRoot", root, "-FixtureRoot", directory, "-Case", scenario], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      const readJson = (relative) => JSON.parse(readFileSync(path.join(directory, relative), "utf8").replace(/^\uFEFF/u, ""));
      const call = readJson("previous/call.json");
      const outcome = readJson("outcome.json");
      assert.equal(call.dependenciesOnly, scenario === "new");
      assert.equal(call.prepareOnly, scenario !== "new");
      assert.equal(outcome.installerUnchanged, true);
      assert.equal(outcome.modelState, outcome.originalModel);
      assert.equal(outcome.codexState, outcome.originalCodex);
      assert.equal(outcome.remainingPreparationTrees, 0);
      if (scenario === "new") {
        assert.equal(call.modelState, outcome.originalModel);
        assert.equal(call.codexState, outcome.originalCodex);
      } else {
        // PowerShell expands Windows 8.3 temp aliases (RUNNER~1) to their long
        // names. Prove the actual destination, rather than its path spelling.
        assert.equal(realpathSync.native(path.dirname(call.modelState)),
          realpathSync.native(path.join(directory, "previous/generated")));
        assert.equal(call.modelState, call.codexState);
      }
      if (scenario === "failure") assert.match(outcome.error, /fixture preparation failure/u);
      else assert.equal(outcome.error, null);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
