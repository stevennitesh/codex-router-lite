import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        assert.equal(readFileSync(path.join(f.source, ".venv/previous.txt"), "utf8"), "retained environment");
      }
      assert.ok(!calls.some((line) => line.includes("wait-health.mjs")), "service install owns liveness readiness");
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
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
        assert.equal(path.dirname(call.modelState), path.join(directory, "previous/generated"));
        assert.equal(call.modelState, call.codexState);
      }
      if (scenario === "failure") assert.match(outcome.error, /fixture preparation failure/u);
      else assert.equal(outcome.error, null);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
