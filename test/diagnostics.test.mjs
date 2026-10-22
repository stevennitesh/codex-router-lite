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
    "file-security.mjs": "export const privateFileIsProtected=()=>process.env.DIAGNOSTICS_CREDENTIAL!=='unprotected';",
    "catalog.mjs": "export const routedCatalogConfigured=()=>true;",
    "control-health.mjs": `import {readControlHealth as read} from ${JSON.stringify(moduleUrl("control-health.mjs"))};
export const readControlHealth=()=>read({readCallerSecret:()=> 'synthetic-fixture-capability-00000000000000',fetchImpl:async()=>{if(process.env.DIAGNOSTICS_OFFLINE==='1')throw new Error('refused');return new Response(process.env.DIAGNOSTICS_BODY,{status:Number(process.env.DIAGNOSTICS_STATUS||200)});}});`,
    "provider-selection.mjs": "export const providerSelectionStatus=()=>({status:'ok',providers:[]});export const selectedConfiguredListedModels=()=>[];",
    "routed-models.mjs": "export const MODEL_BY_SLUG=new Map();export const PROVIDERS=new Map([['openrouter',{}]]);",
    "provider-credentials.mjs": "export const credentialStatus=()=>({configured:process.env.DIAGNOSTICS_CREDENTIAL!=='missing',fileStatus:process.env.DIAGNOSTICS_CREDENTIAL});export const primaryCredentialPath=()=> 'fixture-credential';",
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

test("Doctor's credential repair binds to the protected CLI while access failures retain ACL guidance", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  try {
    const commands = [];
    for (const mode of ["missing", "unprotected", "access-denied", "probe-failed"]) {
      const result = f.runDoctor({ service: "codex-router", degraded: [] }, { DIAGNOSTICS_CREDENTIAL: mode });
      assert.equal(result.status, mode === "missing" ? 0 : 1, result.stderr);
      const credential = JSON.parse(result.stdout).find(check => check.name === "OpenRouter GLM credential");
      if (mode === "access-denied" || mode === "probe-failed") {
        assert.match(credential.fix, /ownership and ACLs/u); assert.match(credential.fix, /do not replace/u);
      } else commands.push(credential.fix.replace(/^Run /u, "").replace(/\.$/u, ""));
    }
    const probe = path.join(f.directory, "bind-command.ps1");
    writeFileSync(probe, `param([string]$Source,[string]$SuggestedCommand)
$ErrorActionPreference='Stop'
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Invalid CLI syntax' }
$inert=Join-Path $PSScriptRoot 'inert-cli.ps1'
[IO.File]::WriteAllText($inert,"[CmdletBinding()]\n"+$ast.ParamBlock.Extent.Text+"\n"+'[pscustomobject]@{target=$Target;command=$Command;arguments=$CommandArguments} | ConvertTo-Json -Compress',[Text.UTF8Encoding]::new($false))
$boundArguments=$SuggestedCommand.Split(' ')[1..4]
& $inert @boundArguments
`);
    for (const command of commands) {
      assert.equal(command.split(" ").length, 5);
      // The real parameter declaration validates binding; the product body and
      // protected key command are never executed.
      const bound = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe, "-Source", path.join(root, "model-router.ps1"), "-SuggestedCommand", command], {
        encoding: "utf8", windowsHide: true, timeout: 10_000,
      });
      assert.equal(bound.status, 0, bound.stderr || bound.error?.message);
      assert.deepEqual(JSON.parse(bound.stdout), { target: "codex", command: "provider-key", arguments: ["openrouter", "set"] });
    }
  } finally { f.dispose(); }
});

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
    writeFileSync(wrapper, `param([switch]$SkipTests,[switch]$FullTests,[switch]$Online)
$global:npmCalls=0
$global:networkCalls=0
$global:catalogCalls=0
$global:doctorCalls=0
$global:webCalls=0
$global:scopedCalls=0
function git {
 $global:LASTEXITCODE=0
 if ($args -contains 'fetch' -or $args -contains 'ls-remote' -or $args -contains 'clone') { $global:networkCalls++ }
 if ($args -contains 'ls-remote') { $lock=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'config/switchyard/source.lock') | ConvertFrom-Json; "$($lock.commit)\tHEAD" }
 elseif ($args -contains 'rev-parse') { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
 elseif ($args -contains 'rev-list') { if ($args -contains '--left-right') { '0 0' } else { '0' } }
 elseif ($args -contains 'status') { '## main' }
}
function node {
 $global:LASTEXITCODE=0
 if ($args -contains '--input-type=module') {
  if (($args -join ' ') -match 'readWebMaintenanceStatus') { $global:webCalls++; $env:DIAGNOSTICS_WEB_STATUS }
  else { Join-Path $PSScriptRoot 'fixture-codex.ps1' }
 }
 elseif ($args -contains 'src/doctor.mjs') { $global:doctorCalls++; $env:DIAGNOSTICS_CHECKS }
 elseif ($args -contains 'scripts/check-codex-catalog-compat.mjs') { $global:catalogCalls++ }
 elseif ($args -contains '--test') { $global:scopedCalls++; if ($env:DIAGNOSTICS_FAIL_SCOPED -eq '1') { $global:LASTEXITCODE=8 } }
}
function npm { $global:npmCalls++; $global:LASTEXITCODE=if($env:DIAGNOSTICS_FAIL_TESTS -eq '1'){7}else{0} }
function Get-AuthenticodeSignature { [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Subject='CN=OpenAI'}} }
function Get-AppxPackage { [pscustomobject]@{Version='fixture-1.0';PackageFullName='fixture-package'} }
try { & (Join-Path $PSScriptRoot 'maintenance/refresh-compatibility-state.ps1') -AnalyzeUpstream -SkipFetch:(-not $Online) -SkipTests:$SkipTests -FullTests:$FullTests }
catch { Write-Output $_.Exception.Message; Write-Output "FIXTURE_NPM_CALLS=$global:npmCalls"; exit 1 }
Write-Output "FIXTURE_NPM_CALLS=$global:npmCalls"
Write-Output "FIXTURE_NETWORK_CALLS=$global:networkCalls"
Write-Output "FIXTURE_CATALOG_CALLS=$global:catalogCalls"
Write-Output "FIXTURE_DOCTOR_CALLS=$global:doctorCalls"
Write-Output "FIXTURE_WEB_CALLS=$global:webCalls"
Write-Output "FIXTURE_SCOPED_CALLS=$global:scopedCalls"
`);
    for (const mode of ["scoped", "full", "online", "skip", "skip-missing-plugin", "wrong-service", "web-disabled", "web-invalid-config", "web-stale-adapter", "web-missing-adapter", "web-disabled-stale-adapter", "web-refresh-required", "web-manifest-required", "failed-tests", "failed-scoped"]) {
      // Feed ordinary Doctor's actual produced JSON through the refresh aggregation.
      const doctor = f.runDoctor({ service: mode === "wrong-service" ? "foreign" : "codex-router", degraded: [] });
      assert.equal(doctor.status, 0, doctor.stderr);
      const webStatus = {
        configurationStatus: mode === "web-invalid-config" ? "unavailable" : "ok",
        enabled: mode === "web-invalid-config" ? null : !mode.startsWith("web-disabled"),
        adapterState: ["web-disabled", "web-invalid-config", "web-missing-adapter"].includes(mode) ? "absent" : "installed",
        adapterInstalled: !["web-disabled", "web-invalid-config", "web-missing-adapter", "web-stale-adapter", "web-disabled-stale-adapter"].includes(mode),
        adapterConflictCount: mode.endsWith("stale-adapter") ? 1 : 0,
        runtimeUpdateStatus: mode === "web-refresh-required" ? "refresh-required" : mode === "web-manifest-required" ? "manifest-required" : mode === "web-disabled" ? "not-configured" : "current",
        detail: "not-safe-private-web-metadata",
      };
      const skip = mode.startsWith("skip"), result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...(skip ? ["-SkipTests"] : []), ...(mode === "full" ? ["-FullTests"] : []), ...(mode === "online" ? ["-Online"] : [])], {
        encoding: "utf8", windowsHide: true, timeout: 15_000,
        env: { ...process.env, DIAGNOSTICS_CHECKS: doctor.stdout, DIAGNOSTICS_WEB_STATUS: JSON.stringify(webStatus), DIAGNOSTICS_PLUGIN: mode === "skip-missing-plugin" ? "missing" : "present", DIAGNOSTICS_FAIL_TESTS: mode === "failed-tests" ? "1" : "0", DIAGNOSTICS_FAIL_SCOPED: mode === "failed-scoped" ? "1" : "0" },
      });
      const failed = mode.startsWith("failed-");
      assert.equal(result.status, failed ? 1 : 0, result.stderr + result.stdout);
      assert.match(result.stdout, new RegExp(`FIXTURE_NPM_CALLS=${skip ? 0 : mode === "full" ? 2 : 1}`, "u"));
      if (!failed) {
        assert.match(result.stdout, /Model execution and Desktop app-tool behavior were not tested/u);
        assert.match(result.stdout, new RegExp(`FIXTURE_NETWORK_CALLS=${mode === "online" ? 2 : 0}`, "u"));
        assert.match(result.stdout, /FIXTURE_CATALOG_CALLS=1/u);
        assert.match(result.stdout, /FIXTURE_DOCTOR_CALLS=1/u);
        assert.match(result.stdout, /FIXTURE_WEB_CALLS=1/u);
        assert.match(result.stdout, new RegExp(`FIXTURE_SCOPED_CALLS=${skip || mode === "full" ? 0 : 1}`, "u"));
        assert.match(result.stdout, /Web live readiness: browserSession=unknown; appLoaded=unknown; hookTrusted=unknown/u);
        assert.match(result.stdout, /ChatGPT Web browser, native-tool and Stop readiness remain unverified/u);
        assert.doesNotMatch(result.stdout + result.stderr, /not-safe-private-web-metadata/u);
        if (mode !== "online") assert.match(result.stdout, /current head is unknown/u);
      }
      if (mode === "full") assert.match(result.stdout, /Full source suite: passed/u);
      if (mode === "scoped" || mode === "online") assert.match(result.stdout, /Catalog and namespace compatibility tests: passed/u);
      if (mode === "scoped") {
        assert.match(result.stdout, /configurationStatus=ok; enabled=true/u);
        assert.match(result.stdout, /state=installed; installed=true; conflicts=0/u);
      }
      if (skip) assert.match(result.stdout, /source verification was skipped/u);
      const webWarning = ["web-invalid-config", "web-stale-adapter", "web-missing-adapter", "web-disabled-stale-adapter", "web-refresh-required", "web-manifest-required"].includes(mode);
      if (mode === "wrong-service" || mode === "skip-missing-plugin" || webWarning) assert.match(result.stdout, /warnings above still require investigation/iu);
      else if (!failed) assert.doesNotMatch(result.stdout, /warnings above still require investigation/iu);
      if (mode === "web-disabled") {
        assert.match(result.stdout, /configurationStatus=ok; enabled=false/u);
        assert.match(result.stdout, /state=absent; installed=false; conflicts=0/u);
        assert.doesNotMatch(result.stdout, /Web Stop adapter is missing/u);
      }
      if (mode === "web-invalid-config") assert.match(result.stdout, /Saved Web configuration is unavailable or invalid/u);
      if (mode === "web-refresh-required" || mode === "web-manifest-required") {
        assert.match(result.stdout, mode === "web-refresh-required" ? /coordinated runtime refresh[\s\S]*refresh-runtime\s+--apply/u : /runtime anchors are missing or ambiguous[\s\S]*--manifest/u);
        assert.doesNotMatch(result.stdout, /Web Stop adapter is missing|Saved Web configuration is unavailable/u);
      } else if (webWarning) assert.match(result.stdout, /Web Stop adapter is missing, stale or its ownership is unconfirmed/u);
      if (mode === "failed-tests") assert.match(result.stdout, /npm exited with status 7/u);
      if (mode === "failed-scoped") assert.match(result.stdout, /node exited with status 8/u);
    }
  } finally { f.dispose(); }
});
