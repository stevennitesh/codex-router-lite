import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const moduleUrl = file => pathToFileURL(path.join(root, "src", file)).href;
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-diagnostics-fixture-"));
  const doctor = path.join(directory, "doctor"); mkdirSync(doctor);
  copyFileSync(path.join(root, "src/doctor.mjs"), path.join(doctor, "doctor.mjs"));
  const modules = {
    "codex-binary.mjs": `import {codexExecutableIdentity as identity,codexAuthStatus as auth} from ${JSON.stringify(moduleUrl("codex-binary.mjs"))};
export const codexExecutableIdentity=()=>identity({findBinary:()=>process.env.DIAGNOSTICS_VERSION==='missing-binary'?undefined:'fixture-codex.exe',fingerprintFor:()=> 'stable-fixture',versionFor:()=> process.env.DIAGNOSTICS_VERSION==='unknown'?undefined:'fixture-1.0'});
export const codexAuthStatus=options=>auth({...options,execute:()=>''});`,
    "file-security.mjs": "export const privateFileIsProtected=()=>true;",
    "catalog.mjs": "export const routedCatalogConfigured=()=>true;",
    "control-health.mjs": `import {readControlHealth as read} from ${JSON.stringify(moduleUrl("control-health.mjs"))};
export const readControlHealth=()=>read({readCallerSecret:()=> 'synthetic-fixture-capability-00000000000000',fetchImpl:async()=>{if(process.env.DIAGNOSTICS_OFFLINE==='1')throw new Error('refused');return new Response(process.env.DIAGNOSTICS_BODY,{status:Number(process.env.DIAGNOSTICS_STATUS||200)});}});`,
    "provider-selection.mjs": "export const providerSelectionStatus=()=>({status:'ok',providers:[]});export const selectedConfiguredListedModels=()=>[];",
    "routed-models.mjs": "export const MODEL_BY_SLUG=new Map();export const PROVIDERS=new Map([['openrouter',{}]]);",
    "provider-credentials.mjs": "export const credentialStatus=()=>({configured:true});export const primaryCredentialPath=()=> 'fixture-credential';",
    "switchyard-runtime.mjs": "export const switchyardRuntimeStatus=()=>({ready:true,binary:'fixture-switchyard',inaccessible:[]});",
    "windows-task-state.mjs": "export const windowsScheduledTaskState=async()=>({});export const interpretWindowsTaskState=()=>({healthy:true,detail:'fixture running'});",
  };
  for (const [file, content] of Object.entries(modules)) writeFileSync(path.join(doctor, file), content);
  const runDoctor = (body, env = {}) => spawnSync(process.execPath, [path.join(doctor, "doctor.mjs"), "--json"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, DIAGNOSTICS_BODY: typeof body === "string" ? body : JSON.stringify(body), ...env },
  });
  const dispose = () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^router-diagnostics-fixture-/u);
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, runDoctor, dispose };
}

test("Doctor retains the actual health projection's identity, partial and degraded meanings", () => {
  const f = fixture();
  try {
    for (const [body, env, status, detail] of [
      [{ service: "codex-router", degraded: [] }, {}, "ok", /healthy/u],
      [{ service: "foreign", degraded: [] }, {}, "warn", /invalid service identity/u],
      [{ service: "foreign", degraded: ["gateway"] }, {}, "warn", /invalid service identity/u],
      ["not JSON", {}, "warn", /full health/u],
      [{ service: "codex-router" }, {}, "warn", /full health/u],
      [{ service: "codex-router", degraded: ["gateway", "not-safe-private-metadata"] }, { DIAGNOSTICS_STATUS: "503" }, "warn", /degraded dependencies: gateway/u],
      [{ service: "codex-router", degraded: [] }, { DIAGNOSTICS_OFFLINE: "1" }, "warn", /unreachable/u],
    ]) {
      const result = f.runDoctor(body, env); assert.equal(result.status, 0, result.stderr);
      const checks = JSON.parse(result.stdout), health = checks.find(c => c.name === "Router runtime");
      assert.equal(health.status, status); assert.match(health.detail, detail);
      assert.equal(checks.every(c => c.status === "ok"), status === "ok");
      assert.doesNotMatch(result.stdout, /not-safe-private-metadata/u);
    }
  } finally { f.dispose(); }
});

test("Doctor preserves an actual unknown-version identity and missing binary separately", () => {
  const f = fixture();
  try {
    for (const mode of ["known", "unknown", "missing-binary"]) {
      const result = f.runDoctor({ service: "codex-router", degraded: [] }, { DIAGNOSTICS_VERSION: mode });
      assert.equal(result.status, mode === "missing-binary" ? 1 : 0, result.stderr);
      const checks = JSON.parse(result.stdout), version = checks.find(c => c.name === "Codex version");
      assert.equal(version.status, mode === "known" ? "ok" : "warn");
      assert.equal(version.detail, mode === "known" ? "fixture-1.0" : "unavailable");
      assert.equal(checks.find(c => c.name === "Codex binary").status, mode === "missing-binary" ? "fail" : "ok");
    }
  } finally { f.dispose(); }
});

test("compatibility verdict distinguishes full, skipped, unavailable and failed checks", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  try {
    for (const dir of ["maintenance", "config/switchyard"]) mkdirSync(path.join(f.directory, dir), { recursive: true });
    for (const file of ["maintenance/refresh-compatibility-state.ps1", "maintenance/upstream-router.json", "config/switchyard/source.lock"])
      copyFileSync(path.join(root, file), path.join(f.directory, file));
    writeFileSync(path.join(f.directory, "fixture-codex.ps1"), `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
$global:LASTEXITCODE=0
if ($Rest[0] -eq '--version') { 'fixture-1.0' } elseif ($env:DIAGNOSTICS_PLUGIN -eq 'missing') { '{"installed":[]}' } else { '{"installed":[{"pluginId":"codex-app-tools@openai-bundled","version":"fixture-1.0"}]}' }
`);
    const wrapper = path.join(f.directory, "refresh-fixture.ps1");
    writeFileSync(wrapper, `param([switch]$SkipTests)
$global:npmCalls=0
function git {
 $global:LASTEXITCODE=0
 if ($args -contains 'ls-remote') { $lock=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'config/switchyard/source.lock') | ConvertFrom-Json; "$($lock.commit)\tHEAD" }
 elseif ($args -contains 'rev-parse') { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
 elseif ($args -contains 'rev-list') { if ($args -contains '--left-right') { '0 0' } else { '0' } }
 elseif ($args -contains 'status') { '## main' }
}
function node {
 $global:LASTEXITCODE=0
 if ($args -contains '--input-type=module') { Join-Path $PSScriptRoot 'fixture-codex.ps1' }
 elseif ($args -contains 'src/doctor.mjs') { $env:DIAGNOSTICS_CHECKS }
}
function npm { $global:npmCalls++; $global:LASTEXITCODE=if($env:DIAGNOSTICS_FAIL_TESTS -eq '1'){7}else{0} }
function Get-AuthenticodeSignature { [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Subject='CN=OpenAI'}} }
function Get-AppxPackage { [pscustomobject]@{Version='fixture-1.0';PackageFullName='fixture-package'} }
try { & (Join-Path $PSScriptRoot 'maintenance/refresh-compatibility-state.ps1') -SkipFetch -SkipTests:$SkipTests }
catch { Write-Output $_.Exception.Message; Write-Output "FIXTURE_NPM_CALLS=$global:npmCalls"; exit 1 }
Write-Output "FIXTURE_NPM_CALLS=$global:npmCalls"
`);
    for (const mode of ["full", "skip", "skip-missing-plugin", "wrong-service", "failed-tests"]) {
      // Feed ordinary Doctor's actual produced JSON through the refresh aggregation.
      const doctor = f.runDoctor({ service: mode === "wrong-service" ? "foreign" : "codex-router", degraded: [] });
      assert.equal(doctor.status, 0, doctor.stderr);
      const skip = mode.startsWith("skip"), result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...(skip ? ["-SkipTests"] : [])], {
        encoding: "utf8", windowsHide: true, timeout: 15_000,
        env: { ...process.env, DIAGNOSTICS_CHECKS: doctor.stdout, DIAGNOSTICS_PLUGIN: mode === "skip-missing-plugin" ? "missing" : "present", DIAGNOSTICS_FAIL_TESTS: mode === "failed-tests" ? "1" : "0" },
      });
      assert.equal(result.status, mode === "failed-tests" ? 1 : 0, result.stderr + result.stdout);
      assert.match(result.stdout, new RegExp(`FIXTURE_NPM_CALLS=${skip ? 0 : mode === "failed-tests" ? 1 : 2}`, "u"));
      if (mode === "full") assert.match(result.stdout, /Current repository, runtime, catalog, and app-tool relay checks passed/u);
      else assert.doesNotMatch(result.stdout, /Current repository, runtime, catalog, and app-tool relay checks passed|Source checks passed/u);
      if (skip) assert.match(result.stdout, /retained product checks were skipped/u);
      if (mode === "wrong-service" || mode === "skip-missing-plugin") assert.match(result.stdout, /warnings above still require confirmation/iu);
      if (mode === "failed-tests") assert.match(result.stdout, /npm exited with status 7/u);
    }
  } finally { f.dispose(); }
});
