import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const powershell = windows ? path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : "powershell.exe";
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
let compiledTool;
function pythonFixtureTool() {
  if (compiledTool) return compiledTool.executable;
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-installer-compiler-"));
  const executable = path.join(directory, "python-fixture.exe");
  try {
    execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -Path ${quote(path.join(root, "test/fixtures/python-environment-tool.cs"))} -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`], { windowsHide: true, encoding: "utf8" });
    compiledTool = { directory, executable };
    return executable;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
after(() => { if (compiledTool) rmSync(compiledTool.directory, { recursive: true, force: true }); });

function fixture(tool, { mode = "dependencies", broken = false, failService = false } = {}) {
  const compiled = pythonFixtureTool();
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-installer-maintenance-"));
  try {
    const source = path.join(directory, "source");
    const bin = path.join(directory, "bin");
    const home = path.join(directory, "home");
    const trace = path.join(directory, "trace.txt");
    for (const target of [path.join(source, "src"), path.join(source, "requirements"), bin]) mkdirSync(target, { recursive: true });
    writeFileSync(trace, "");
    writeFileSync(path.join(source, "package.json"), '{"name":"codex-router-lite","type":"module"}');
    writeFileSync(path.join(source, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "codex-router-lite" } } }));
    for (const file of ["install.ps1", "src/install-plan.mjs", "src/venv-runtime.mjs", "requirements/python.in", "requirements/python.txt"]) {
      copyFileSync(path.join(root, file), path.join(source, file));
    }
    const executable = path.join(bin, "python-fixture.exe");
    copyFileSync(compiled, executable);
    writeFileSync(path.join(bin, "py.cmd"), `@echo off\r\n"${executable}" %*\r\nexit /b %errorlevel%\r\n`);
    if (tool === "uv") writeFileSync(path.join(bin, "uv.cmd"), `@echo off\r\n"${executable}" --fixture-uv %*\r\nexit /b %errorlevel%\r\n`);
    const nodeTrace = path.join(bin, "node-trace.mjs");
    writeFileSync(nodeTrace, `import {appendFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const args=process.argv.slice(2); appendFileSync(process.env.ROUTER_INSTALL_TRACE,'node\\t'+args.join('\\t')+'\\n'); if(args[0]==='--input-type=module' && ['4202','4000'].includes(args.at(-1))) process.exit(0); const result=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'}); process.exit(result.status ?? 1);`);
    writeFileSync(path.join(bin, "node.cmd"), `@echo off\r\n"${process.execPath}" "${nodeTrace}" %*\r\nexit /b %errorlevel%\r\n`);
    writeFileSync(path.join(bin, "npm.cmd"), '@echo off\r\nif not exist node_modules mkdir node_modules\r\necho {"lockfileVersion":3,"packages":{}}>node_modules\\.package-lock.json\r\nexit /b 0\r\n');
    const forbidden = ["config-manager", "service", "provider-selection", "service-process", "secret", "catalog", "litellm-config", "install-manifest", "skills-install", "service-drain", "wait-health"];
    for (const name of forbidden) {
      let action = "";
      if (mode === "dependencies" || name === "wait-health") action = `throw new Error('unexpected ${name} invocation');`;
      else if (name === "config-manager") action = "if(process.argv[2]==='status')console.log(JSON.stringify({mode:'router'}));";
      else if (name === "service") {
        action = `import {writeFileSync} from 'node:fs'; const live=${JSON.stringify(path.join(directory, "service-live.json"))}; if(process.argv[2]==='status')console.log(JSON.stringify({installed:${mode === "full"},loaded:${mode === "full"}})); if(process.argv[2]==='stop')writeFileSync(live,'false'); if(process.argv[2]==='install')writeFileSync(live,'true');`;
        if (failService) action += `if(process.argv[2]==='install'){ const p=${JSON.stringify(path.join(directory, "service-failed"))}; const fs=await import('node:fs'); if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exitCode=8;} }`;
      }
      else if (name === "service-process") action = `import {existsSync,readFileSync} from 'node:fs'; const live=${JSON.stringify(path.join(directory, "service-live.json"))}; if(process.argv[2]==='verify'){const owned=existsSync(live)?JSON.parse(readFileSync(live,'utf8')):${mode === "full"}; console.log(JSON.stringify({status:owned?'owned':'absent',owned,sourceRoot:owned?${JSON.stringify(source)}:null}));}`;
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
    const errorFile = path.join(directory, "installer-error.txt"), runner = path.join(directory, "installer-runner.ps1");
    // The PowerShell console formatter wraps even path tokens according to the
    // host width. Assert recovery paths against the actual exception message,
    // while preserving the rendered stderr and original nonzero outcome.
    writeFileSync(runner, `param([switch]$PrepareOnly,[switch]$DependenciesOnly,[switch]$ForceDeps,[switch]$ForceServiceReplacement)
try { & ${quote(path.join(source, "install.ps1"))} -InstallDir ${quote(path.join(directory, "unused-install"))} -CheckoutInstall @PSBoundParameters }
catch { [IO.File]::WriteAllText(${quote(errorFile)}, $_.Exception.Message, (New-Object Text.UTF8Encoding $false)); throw }
`);
    const run = (args) => {
      rmSync(errorFile, { force: true });
      const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner, ...args], { encoding: "utf8", windowsHide: true, env: environment, timeout: 30_000 });
      return { ...result, errorMessage: existsSync(errorFile) ? readFileSync(errorFile, "utf8") : undefined };
    };
    return { directory, source, home, trace, environment, run, calls: () => readFileSync(trace, "utf8").trim().split(/\r?\n/u).filter(Boolean) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
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
if(command==='status') console.log(JSON.stringify({installed:true,loaded:true}));
if(command==='stop'||command==='install') {
  counts[command]++;
  if(command==='install'&&counts.install===1) counts.previous = readdirSync(${JSON.stringify(f.source)}).find(n=>n.startsWith('.venv-previous-'));
  writeFileSync(file,JSON.stringify(counts));
  if(command==='stop'&&counts.stop===${failedStop}) process.exitCode=7;
  else if(command==='stop') writeFileSync(${JSON.stringify(path.join(f.directory, "service-live.json"))},'false');
  if(command==='install') writeFileSync(${JSON.stringify(path.join(f.directory, "service-live.json"))},'true');
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
        assert.match(result.stderr, /Install failed.*dependency rollback failed/u);
        assert.ok(result.errorMessage.includes(state.previous), "refusal names the retained recovery path");
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
    const failed = /\.venv-failed-[0-9a-f]{32}/u.exec(result.errorMessage)?.[0];
    assert.ok(failed, result.errorMessage);
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
try { & ${quote(path.join(f.source, "install.ps1"))} -InstallDir ${quote(path.join(f.directory, "unused-install"))} -CheckoutInstall -ForceDeps }
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
      const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(f.source, "install.ps1"), "-InstallDir", path.join(f.directory, "unused-install"), ...(checkout ? ["-CheckoutInstall"] : []), "-ForceDeps"];
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

// Exercise real npm lifecycle, lock, tree and import behavior entirely offline.
// The service, Python executable and port observations remain fixture boundaries.
function offlineNodeFixture({ stopped = false } = {}) {
  const f = fixture("uv", { mode: "full" });
  try {
    const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    const packageRoot = path.join(f.directory, "offline-package");
    mkdirSync(packageRoot);
    const env = { ...f.environment, npm_config_cache: path.join(f.directory, "npm-cache"), npm_config_registry: "http://127.0.0.1:1" };
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.cjs", scripts: { postinstall: "node postinstall.cjs" } }));
    writeFileSync(path.join(packageRoot, "postinstall.cjs"), `const fs=require('node:fs');fs.writeFileSync('installed-by-script',__dirname);if(process.env.ROUTER_FIXTURE_FAULT==='npm'&&__dirname.includes('.node-deps-candidate-'))process.exit(8);`);
    writeFileSync(path.join(packageRoot, "index.cjs"), `const fs=require('node:fs');if(process.env.ROUTER_FIXTURE_FAULT==='import'&&__dirname.includes('.node-deps-candidate-'))throw Error('candidate import refused');if(process.env.ROUTER_FIXTURE_FAULT==='relocation'&&__dirname.includes('.node-deps-candidate-')&&fs.readFileSync(__dirname+'/installed-by-script','utf8')!==__dirname)throw Error('candidate relocation refused');module.exports={ready:true};`);
    execFileSync(process.execPath, [npm, "pack", "--offline", "--no-audit", "--no-fund"], { cwd: packageRoot, env, encoding: "utf8", windowsHide: true });
    writeFileSync(path.join(f.source, "package.json"), JSON.stringify({ name: "codex-router-lite", type: "module", dependencies: { "fixture-dependency": "file:" + path.join(packageRoot, "fixture-dependency-1.0.0.tgz") } }));
    execFileSync(process.execPath, [npm, "install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], { cwd: f.source, env, encoding: "utf8", windowsHide: true });
    const npmDriver = path.join(f.directory, "bin/npm-driver.cjs");
    writeFileSync(npmDriver, `const{spawnSync}=require('node:child_process');const fs=require('node:fs');fs.appendFileSync(process.env.ROUTER_INSTALL_TRACE,'npm\\t'+process.cwd()+'\\n');const p=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(npm)},...process.argv.slice(2),'--offline','--no-audit','--no-fund'],{stdio:'inherit'});if(p.status===0&&process.env.ROUTER_FIXTURE_FAULT==='input'&&process.cwd().includes('.node-deps-candidate-'))fs.appendFileSync('package.json','\\n');process.exit(p.status??1);`);
    writeFileSync(path.join(f.directory, "bin/npm.cmd"), `@echo off\r\n"${process.execPath}" "${npmDriver}" %*\r\nexit /b %errorlevel%\r\n`);
    Object.assign(f.environment, env);
    const initial = f.run(["-DependenciesOnly"]);
    assert.equal(initial.status, 0, initial.stderr);
    writeFileSync(path.join(f.source, "node_modules/previous.txt"), "previous node tree");
    writeFileSync(path.join(f.source, ".venv/previous.txt"), "previous Python tree");
    f.oldNodeStamp = readFileSync(path.join(f.source, "node_modules/.codex-router-install.json"));
    f.oldPythonStamp = readFileSync(path.join(f.source, ".venv/.codex-router-install.json"));
    writeFileSync(f.trace, "");
    const countsFile = path.join(f.directory, "service-counts.json"), liveFile = path.join(f.directory, "service-live.json");
    writeFileSync(liveFile, JSON.stringify(!stopped));
    writeFileSync(path.join(f.source, "src/service.mjs"), `
import {createRequire} from 'node:module';import{existsSync,readFileSync,writeFileSync,readdirSync,rmSync}from'node:fs';import path from'node:path';
const file=${JSON.stringify(countsFile)},live=${JSON.stringify(liveFile)},root=${JSON.stringify(f.source)},fault=process.env.ROUTER_FIXTURE_FAULT,command=process.argv[2];
const c=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{stop:0,install:0};
if(command==='status')console.log(JSON.stringify({installed:true,loaded:${!stopped}}));
if(command==='stop'||command==='install'){
 createRequire(import.meta.url)('fixture-dependency');
 c[command]++;c.previousNode=readdirSync(root).find(n=>n.startsWith('.node-deps-previous-'))||c.previousNode;c.previousPython=readdirSync(root).find(n=>n.startsWith('.venv-previous-'))||c.previousPython;
 if(command==='install'&&c.install>1)c.restoredBeforeImport=existsSync(path.join(root,'node_modules/previous.txt'))&&existsSync(path.join(root,'.venv/previous.txt'));
 writeFileSync(file,JSON.stringify(c));
 if(command==='stop'){if(fault==='recovery-stop'&&c.stop===2)process.exitCode=7;else writeFileSync(live,'false');}
 if(command==='install'){writeFileSync(live,'true');if(['service','damaged','recovery-stop','unknown','listener','stopped'].includes(fault)&&c.install===1){
   if(fault==='damaged'){rmSync(path.join(root,'node_modules/fixture-dependency'),{recursive:true});writeFileSync(live,'false');}
   if(fault==='unknown')writeFileSync(${JSON.stringify(path.join(f.directory, "unknown-process"))},'1');
   process.exitCode=8;
 }}
}`);
    writeFileSync(path.join(f.source, "src/service-process.mjs"), `import{existsSync,readFileSync}from'node:fs';const unknown=existsSync(${JSON.stringify(path.join(f.directory, "unknown-process"))});const owned=JSON.parse(readFileSync(${JSON.stringify(liveFile)},'utf8'));console.log(JSON.stringify({status:unknown?'unknown':owned?'owned':'absent',owned:unknown?false:owned,sourceRoot:!unknown&&owned?${JSON.stringify(f.source)}:null}));`);
    writeFileSync(path.join(f.directory, "bin/node-trace.mjs"), `import{appendFileSync,existsSync,readFileSync,writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';const a=process.argv.slice(2),fault=process.env.ROUTER_FIXTURE_FAULT;appendFileSync(process.env.ROUTER_INSTALL_TRACE,'node\\t'+a.join('\\t')+'\\n');if(a[0]==='--input-type=module'&&['4202','4000'].includes(a.at(-1))){const c=existsSync(${JSON.stringify(countsFile)})?JSON.parse(readFileSync(${JSON.stringify(countsFile)},'utf8')):{};process.exit(fault==='listener'&&c.install>0&&a.at(-1)==='4000'?1:0);}if(a[0]?.endsWith('install-plan.mjs')&&a[1]==='record'&&fault==='record-'+a[2]&&!existsSync(${JSON.stringify(path.join(f.directory, "record-failed"))})){writeFileSync(${JSON.stringify(path.join(f.directory, "record-failed"))},'1');process.exit(8);}const p=spawnSync(${JSON.stringify(process.execPath)},a,{stdio:'inherit'});process.exit(p.status??1);`);
    f.counts = () => existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, "utf8")) : { stop: 0, install: 0 };
    f.assertPrevious = () => {
      assert.equal(readFileSync(path.join(f.source, "node_modules/previous.txt"), "utf8"), "previous node tree");
      assert.equal(readFileSync(path.join(f.source, ".venv/previous.txt"), "utf8"), "previous Python tree");
      assert.deepEqual(readFileSync(path.join(f.source, "node_modules/.codex-router-install.json")), f.oldNodeStamp);
      assert.deepEqual(readFileSync(path.join(f.source, ".venv/.codex-router-install.json")), f.oldPythonStamp);
    };
    f.runFault = fault => { f.environment.ROUTER_FIXTURE_FAULT = fault; return f.run(["-ForceDeps"]); };
    return f;
  } catch (error) { rmSync(f.directory, { recursive: true, force: true }); throw error; }
}

test("real offline Node preparation refuses npm, input, import and relocation faults before drain", { skip: !windows }, () => {
  for (const fault of ["npm", "input", "import", "relocation"]) {
    const f = offlineNodeFixture();
    try {
      const result = f.runFault(fault);
      assert.notEqual(result.status, 0, fault);
      f.assertPrevious();
      assert.deepEqual(f.counts(), { stop: 0, install: 0 });
      assert.ok(!f.calls().some(call => call.includes("service-drain.mjs")), result.stderr);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});
test("real offline Node candidate preserves active dependencies on refused drain and active PrepareOnly", { skip: !windows }, () => {
  for (const scenario of ["drain", "prepare"]) {
    const f = offlineNodeFixture();
    try {
      writeFileSync(path.join(f.source, "src/service-drain.mjs"), "if(process.argv[2]==='prepare')process.exitCode=7;");
      const result = f.run(scenario === "prepare" ? ["-PrepareOnly", "-ForceDeps"] : ["-ForceDeps"]);
      assert.notEqual(result.status, 0);
      f.assertPrevious();
      assert.deepEqual(f.counts(), { stop: 0, install: 0 });
      assert.ok(!f.calls().some(call => /(?:secret|catalog|litellm-config|install-manifest)\.mjs/u.test(call)), result.stderr);
      if (scenario === "prepare") assert.ok(!f.calls().some(call => call.startsWith("npm\t")));
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});
test("real offline Node and Python promote together, preserve npm scripts and retire after acceptance", { skip: !windows }, () => {
  const f = offlineNodeFixture();
  try {
    const result = f.run(["-ForceDeps"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.counts().stop, 1); assert.equal(f.counts().install, 1);
    assert.equal(existsSync(path.join(f.source, "node_modules/fixture-dependency/installed-by-script")), true);
    const imported = execFileSync(process.execPath, ["--input-type=module", "-e", "import{createRequire}from'node:module';console.log(createRequire(process.cwd()+'/package.json')('fixture-dependency').ready)"], { cwd: f.source, env: f.environment, encoding: "utf8" });
    assert.equal(imported.trim(), "true");
    assert.ok(!readdirSync(f.source).some(name => /^\.(?:node-deps|venv)-(?:candidate|previous|failed)-/u.test(name)));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test("real offline dependency rollback restores trees and stamps before old service imports", { skip: !windows }, () => {
  for (const fault of ["record-node-deps", "record-python-deps", "service", "damaged", "stopped"]) {
    const f = offlineNodeFixture({ stopped: fault === "stopped" });
    try {
      const result = f.runFault(fault);
      assert.notEqual(result.status, 0, fault);
      assert.ok(!/dependency rollback failed/u.test(result.stderr), result.stderr);
      f.assertPrevious();
      const counts = f.counts();
      assert.equal(counts.stop, fault === "service" ? 2 : fault === "stopped" ? 3 : 1, result.stderr);
      assert.equal(counts.install, fault.startsWith("record-") ? 1 : 2);
      if (!fault.startsWith("record-")) assert.equal(counts.restoredBeforeImport, true);
      assert.equal(f.calls().filter(call => call.startsWith("npm\t")).length, 1, "recovery uses retained tree without npm");
      if (fault === "stopped") assert.equal(readFileSync(path.join(f.directory, "service-live.json"), "utf8"), "false");
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});
test("real offline candidate retains both trees for refused recovery stop, unknown process or listener", { skip: !windows }, () => {
  for (const fault of ["recovery-stop", "unknown", "listener"]) {
    const f = offlineNodeFixture();
    try {
      const result = f.runFault(fault);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Install failed.*dependency rollback failed/u);
      const counts = f.counts();
      assert.equal(counts.stop, fault === "unknown" ? 1 : 2);
      assert.equal(counts.install, 1);
      assert.equal(existsSync(path.join(f.source, "node_modules/fixture-dependency/package.json")), true);
      assert.equal(readFileSync(path.join(f.source, counts.previousNode, "previous.txt"), "utf8"), "previous node tree");
      assert.equal(readFileSync(path.join(f.source, counts.previousPython, "previous.txt"), "utf8"), "previous Python tree");
      assert.ok(result.errorMessage.includes(counts.previousNode), result.errorMessage);
      assert.ok(result.errorMessage.includes(counts.previousPython), result.errorMessage);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("real offline transaction restores both generations after each Node or Python promotion rename fails", { skip: !windows }, () => {
  const predicates = {
    "node-previous": "$leaf -eq 'node_modules' -and $parent -eq 'source'",
    "node-promotion": "$leaf -eq 'node_modules' -and $parent.StartsWith('.node-deps-candidate-')",
    "python-previous": "$leaf -eq '.venv'",
    "python-promotion": "$leaf.StartsWith('.venv-candidate-') -and [IO.Path]::GetFileName($Destination) -eq '.venv'",
  };
  for (const [fault, predicate] of Object.entries(predicates)) {
    const f = offlineNodeFixture();
    try {
      const wrapper = path.join(f.directory, "rename-failure.ps1");
      writeFileSync(wrapper, `$ErrorActionPreference='Stop';$script:injected=$false
function Move-Item { param([string]$LiteralPath,[string]$Destination)
 $leaf=[IO.Path]::GetFileName($LiteralPath);$parent=[IO.Path]::GetFileName([IO.Path]::GetDirectoryName($LiteralPath))
 if(-not $script:injected -and (${predicate})){$script:injected=$true;throw 'fixture ${fault} rename failed'}
 Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
try { & ${quote(path.join(f.source, "install.ps1"))} -CheckoutInstall -InstallDir ${quote(path.join(f.directory, "unused-install"))} -ForceDeps } catch { Write-Error -ErrorRecord $_ -ErrorAction Continue;exit 1 }
`);
      const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper], { env: f.environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
      assert.notEqual(result.status, 0, fault);
      assert.match(result.stderr, new RegExp(`fixture ${fault} rename failed`, "u"));
      assert.ok(!/dependency rollback failed/u.test(result.stderr), result.stderr);
      f.assertPrevious();
      assert.equal(f.counts().stop, 1); assert.equal(f.counts().install, 1);
      assert.ok(!readdirSync(f.source).some(name => /^\.(?:node-deps|venv)-(?:candidate|previous|failed)-/u.test(name)), result.stderr);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("real offline Node restoration rename failure retains old and failed trees with both errors", { skip: !windows }, () => {
  const f = offlineNodeFixture();
  try {
    f.environment.ROUTER_FIXTURE_FAULT = "service";
    const wrapper = path.join(f.directory, "restore-failure.ps1");
    const errorFile = path.join(f.directory, "restore-error.txt");
    writeFileSync(wrapper, `$ErrorActionPreference='Stop'
function Move-Item { param([string]$LiteralPath,[string]$Destination)
 if([IO.Path]::GetFileName($LiteralPath).StartsWith('.node-deps-previous-')){throw 'fixture Node restore rename failed'}
 Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
try { & ${quote(path.join(f.source, "install.ps1"))} -CheckoutInstall -InstallDir ${quote(path.join(f.directory, "unused-install"))} -ForceDeps } catch { [IO.File]::WriteAllText(${quote(errorFile)}, $_.Exception.Message, (New-Object Text.UTF8Encoding $false));Write-Error -ErrorRecord $_ -ErrorAction Continue;exit 1 }
`);
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper], { env: f.environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Install failed.*dependency rollback failed/u);
    assert.match(result.stderr, /fixture Node restore rename failed/u);
    const errorMessage = readFileSync(errorFile, "utf8");
    assert.match(errorMessage, /Install failed \(Background-service installation failed\.\) and dependency rollback failed \(fixture Node restore rename failed\)/u);
    const counts = f.counts();
    assert.equal(counts.stop, 2); assert.equal(counts.install, 1);
    assert.equal(readFileSync(path.join(f.source, counts.previousNode, "previous.txt"), "utf8"), "previous node tree");
    assert.equal(readFileSync(path.join(f.source, counts.previousPython, "previous.txt"), "utf8"), "previous Python tree");
    const failed = readdirSync(f.source).find(name => name.startsWith(".node-deps-failed-"));
    assert.ok(failed); assert.equal(existsSync(path.join(f.source, failed, "fixture-dependency/package.json")), true);
    for (const [field, tree] of [["node-previous", counts.previousNode], ["python-previous", counts.previousPython], ["node-failed", failed]]) {
      const reportedPath = new RegExp(`${field}=([^;]+)`, "u").exec(errorMessage)?.[1];
      assert.ok(reportedPath, errorMessage);
      assert.equal(realpathSync.native(reportedPath), realpathSync.native(path.join(f.source, tree)), errorMessage);
    }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("uncertain installer observations and active DependenciesOnly refuse before replacing bytes", { skip: !windows }, () => {
  for (const scenario of ["status-failed", "status-legacy", "process-unknown", "process-foreign", "dependencies-active", "dependencies-unknown"]) {
    const f = fixture("uv", { mode: "full" });
    try {
      assert.equal(f.run(["-DependenciesOnly"]).status, 0);
      writeFileSync(path.join(f.source, "node_modules/previous.txt"), "previous node tree");
      writeFileSync(path.join(f.source, ".venv/previous.txt"), "previous Python tree");
      const stamp = readFileSync(path.join(f.source, "node_modules/.codex-router-install.json"));
      writeFileSync(f.trace, "");
      if (scenario === "status-failed") writeFileSync(path.join(f.source, "src/service.mjs"), "process.exitCode=8;");
      if (scenario === "status-legacy") writeFileSync(path.join(f.source, "src/service.mjs"), "console.log(JSON.stringify({installed:true}));");
      if (["process-unknown", "process-foreign", "dependencies-unknown"].includes(scenario)) writeFileSync(path.join(f.source, "src/service-process.mjs"), `console.log(JSON.stringify({status:${JSON.stringify(scenario === "process-foreign" ? "foreign" : "unknown")},owned:false,sourceRoot:null}));`);
      if (scenario.startsWith("dependencies-")) {
        mkdirSync(f.environment.MODEL_ROUTER_STATE_DIR, { recursive: true });
        writeFileSync(path.join(f.environment.MODEL_ROUTER_STATE_DIR, "install-manifest.json"), JSON.stringify({ current: { sourceRoot: f.source } }));
      }
      const result = f.run([...(scenario.startsWith("dependencies-") ? ["-DependenciesOnly"] : []), "-ForceDeps"]);
      assert.notEqual(result.status, 0, scenario);
      assert.match(result.stderr, /(?:service (?:state|status|observation)|identity|absence|ownership|unknown|foreign)/iu, result.stderr);
      assert.equal(readFileSync(path.join(f.source, "node_modules/previous.txt"), "utf8"), "previous node tree");
      assert.equal(readFileSync(path.join(f.source, ".venv/previous.txt"), "utf8"), "previous Python tree");
      assert.deepEqual(readFileSync(path.join(f.source, "node_modules/.codex-router-install.json")), stamp);
      assert.ok(!f.calls().some(call => /(?:provider-selection|secret|catalog|litellm-config|install-manifest|service-drain)\.mjs/u.test(call)), result.stderr);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});
