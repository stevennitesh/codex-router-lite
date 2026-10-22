import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const fileUrl = name => pathToFileURL(path.join(root, name)).href;

function managerFixture(scenario) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-service-fixture-"));
  const state = path.join(directory, "state"), source = path.join(directory, "source");
  mkdirSync(state); mkdirSync(source);
  const trace = path.join(directory, "trace.jsonl"); writeFileSync(trace, "");
  const record = path.join(state, "service-process.json");
  if (scenario.startsWith("stop-")) writeFileSync(record, JSON.stringify({ version: 1, managed: true,
    pid: 333333, processIdentity: "42|fixture-node.exe", commandLine: `node "${path.join(source, "src/start.mjs")}"`,
    sourceRoot: source, stateDir: state, ports: { router: 47002 } }));
  if (scenario === "invalid-record") writeFileSync(record, "malformed JSON");
  for (const name of ["start-codex-router.cmd", "start-codex-router-hidden.vbs"]) writeFileSync(path.join(state, name), "previous launcher");
  const helpers = path.join(directory, "helpers.mjs"), security = path.join(directory, "security.mjs"), filesystem = path.join(directory, "filesystem.mjs");
  const realChild = path.join(directory, "real-child.mjs");
  writeFileSync(realChild, "export {spawnSync} from 'node:child_process';");
  writeFileSync(helpers, `import {appendFileSync} from 'node:fs';import path from 'node:path';import {spawnSync as actualSpawnSync} from ${JSON.stringify(pathToFileURL(realChild).href)};
const scenario=${JSON.stringify(scenario)},source=${JSON.stringify(source)},trace=${JSON.stringify(trace)};
let exists=!['missing','install-new'].includes(scenario),registered=false,killed=false,identityCalls=0;
const note=(name,args)=>appendFileSync(trace,JSON.stringify({name,args})+'\\n');
const taskState=scenario==='status-unknown'?'Unknown':scenario.startsWith('status-running')?'Running':'Ready';
export function execFileSync(executable,args){const name=path.basename(executable).toLowerCase();note(name,args);
 if(name==='schtasks.exe'){
  if(args[0]==='/Delete'){
   if(scenario==='delete-error')throw new Error('fixture deletion refused');
   exists=false;if(scenario==='delete-race')throw new Error('concurrent deletion');
  }return '';
 }
 if(name==='powershell.exe'||name==='pwsh.exe'){
  const script=args.at(-1);
  if(script.includes('$snapshot =')){
   if(scenario.startsWith('task-error-')&&!registered){
    const hresult={'task-error-account':-2147216625,'task-error-missing':-2147024894,'task-error-denied':-2147024891}[scenario];
    const prefix="function New-Object { param($ComObject) if ($ComObject -ne 'Schedule.Service') { throw 'unexpected COM construction' }; $scheduler=[pscustomobject]@{}; $scheduler | Add-Member -MemberType ScriptMethod -Name Connect -Value {}; $scheduler | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($name) $folder=[pscustomobject]@{}; $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($taskName) throw [Runtime.InteropServices.COMException]::new('synthetic task observation', "+hresult+") }; return $folder }; return $scheduler }; ";
    const observed=actualSpawnSync('powershell.exe',[...args.slice(0,-1),prefix+script],{windowsHide:true,encoding:'utf8',timeout:15000});
    if(observed.error||observed.status!==0)throw observed.error??new Error('synthetic task query failed');
    return observed.stdout;
   }
   if(scenario==='query-error')throw new Error('fixture query unavailable');
   if(scenario==='malformed-task')return '{}';
   return JSON.stringify(exists?{exists:true,owned:scenario!=='foreign',state:scenario==='malformed-state'?null:taskState,running:taskState==='Running',xml:'fixture XML',sddl:'fixture SDDL'}:{exists:false});
  }
  if(script.includes('Register-ScheduledTask')){exists=true;registered=true;return '';}
  if(script.includes('.State.ToString()'))return taskState;
  throw new Error('unexpected PowerShell fixture call');
 }
 if(name==='netstat.exe'){
  if(scenario==='stop-listener-unknown')throw new Error('fixture netstat unavailable');
  return scenario==='stop-listener-live'?'TCP 127.0.0.1:47002 0.0.0.0:0 LISTENING 333333':'';
 }
 if(name==='taskkill.exe'){
  if(scenario==='stop-kill-unknown')throw new Error('fixture termination refused');
  killed=true;return '';
 }
 throw new Error('unexpected helper '+name);
}
export function spawnSync(_exe,args){note('process-probe',args);const script=args.at(-1);
 if(script.includes('Get-Process')){
  identityCalls++;
  if(scenario==='stop-process-unknown'||(scenario==='stop-kill-unknown'&&identityCalls>1))return{status:null,error:{code:'ETIMEDOUT'}};
  const identity=scenario==='stop-process-partial'?'42|':scenario==='stop-reused'?'43|fixture-node.exe':'42|fixture-node.exe';
  const commandLine=['stop-command-unknown','stop-reused'].includes(scenario)?null:'node "'+path.join(source,'src/start.mjs')+'"';
  return killed?{status:3}:{status:0,stdout:JSON.stringify({identity,commandLine})};
 }
 if(scenario==='stop-command-unknown')return{status:1};
 return{status:0,stdout:'node "'+path.join(source,'src/start.mjs')+'"'};
}
export function execFile(executable,args,_options,callback){note(path.basename(executable).toLowerCase(),args);
 if(scenario==='status-running-unavailable'){callback(new Error('fixture task instance query unavailable'));return;}
 const instances=['status-running','status-running-stale','status-ready-live'].includes(scenario)?1:0;
 const launcher=['status-running','status-ready-live','status-ready-no-instance'].includes(scenario)?1:0;
 callback(null,instances+'|0|'+launcher);
}
`);
  writeFileSync(security, "import {writeFileSync} from 'node:fs';export const ensureProgramTreeReadable=()=>{};export const protectPrivateFile=()=>{};export const writePrivateFile=(p,v)=>writeFileSync(p,v);export const writePrivateJson=(p,v)=>writeFileSync(p,JSON.stringify(v));");
  writeFileSync(filesystem, `import * as fs from 'node:fs';export * from 'node:fs';export function unlinkSync(p){if(${JSON.stringify(scenario)}==='unlink-error'&&String(p).endsWith('start-codex-router-hidden.vbs'))throw new Error('fixture unlink refused');return fs.unlinkSync(p);}`);
  const loader = path.join(directory, "loader.mjs");
  writeFileSync(loader, `export async function resolve(s,c,n){
if(s==='node:child_process'&&c.parentURL!==${JSON.stringify(pathToFileURL(realChild).href)})return{url:${JSON.stringify(pathToFileURL(helpers).href)},shortCircuit:true};
if(s==='node:fs'&&c.parentURL===${JSON.stringify(fileUrl('src/service-windows.mjs'))})return{url:${JSON.stringify(pathToFileURL(filesystem).href)},shortCircuit:true};
const r=await n(s,c);if(r.url===${JSON.stringify(fileUrl('src/file-security.mjs'))})return{url:${JSON.stringify(pathToFileURL(security).href)},shortCircuit:true};return r;}`);
  const env = { ...process.env, CODEX_HOME: path.join(directory, "codex"), CODEX_ROUTER_SOURCE_ROOT: source,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_PORT: "47002", CODEX_ROUTER_SERVICE_PLATFORM: "win32" };
  delete env.NODE_TEST_CONTEXT; delete env.MODEL_ROUTER_SKIP_SERVICE_MANAGER;
  return { directory, state, record, trace, env, loader,
    run: command => spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href,
      path.join(root, "src/service-windows.mjs"), command], { env, windowsHide: true, encoding: "utf8", timeout: 15_000 }),
    calls: () => readFileSync(trace, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const scenario of ["stop-process-unknown", "stop-process-partial", "stop-kill-unknown", "stop-command-unknown", "stop-listener-unknown", "stop-listener-live", "invalid-record"]) {
  test(`Windows stop preserves recovery state on ${scenario}`, () => {
    const f = managerFixture(scenario);
    try { const result = f.run("stop"); assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
      assert.equal(existsSync(f.record), true); assert.doesNotMatch(result.stdout, /"state":"stopped"/u);
      assert.match(result.stderr, /unknown|absence could not be verified|still running|record could not be verified/u);
    } finally { f.dispose(); }
  });
}
for (const scenario of ["stop-proven", "stop-reused"]) {
  test(`Windows stop accepts ${scenario} without killing a reused PID`, () => {
    const f = managerFixture(scenario);
    try { const result = f.run("stop"); assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(f.record), false);
      assert.equal(f.calls().some(c => c.name === "taskkill.exe"), scenario === "stop-proven");
    } finally { f.dispose(); }
  });
}
for (const scenario of ["query-error", "malformed-task", "malformed-state", "foreign"]) {
  for (const command of ["install", "uninstall", "status", "stop", "start", "restart"]) test(`Windows ${command} refuses ${scenario} before changing the task`, () => {
    const f = managerFixture(scenario);
    try { const result = f.run(command); assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unable to verify ownership|not owned by/u);
      assert.equal(readFileSync(path.join(f.state, "start-codex-router.cmd"), "utf8"), "previous launcher");
      assert.equal(f.calls().some(c => c.name === "schtasks.exe" || c.args.at(-1).includes("Register-ScheduledTask")), false);
    } finally { f.dispose(); }
  });
}
test("Windows stop disables heartbeat before ending the task and start reenables it", () => {
  for (const command of ["stop", "start", "restart"]) {
    const f = managerFixture("owned");
    try {
      const result = f.run(command);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(f.calls().filter(call => call.name === "schtasks.exe").map(call => call.args),
        command === "stop" ? [["/Change", "/TN", "Codex Router", "/DISABLE"], ["/End", "/TN", "Codex Router"]]
          : command === "start" ? [["/Change", "/TN", "Codex Router", "/ENABLE"], ["/Run", "/TN", "Codex Router"]]
            : [["/End", "/TN", "Codex Router"], ["/Change", "/TN", "Codex Router", "/ENABLE"], ["/Run", "/TN", "Codex Router"]]);
      assert.equal(JSON.parse(result.stdout).state, command === "stop" ? "stopped" : "running");
    } finally { f.dispose(); }
  }
});
for (const command of ["start", "restart"]) {
  test(`Windows ${command} refuses a missing task before mutation`, () => {
    const f = managerFixture("missing");
    try {
      const result = f.run(command);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not registered.*install/u);
      assert.equal(f.calls().some(call => call.name === "schtasks.exe"), false);
      assert.equal(result.stdout.includes('"state":"running"'), false);
    } finally { f.dispose(); }
  });
}
for (const scenario of ["delete-error", "unlink-error", "delete-race", "missing"]) {
  test(`Windows uninstall reports the actual ${scenario} outcome`, () => {
    const f = managerFixture(scenario);
    try { const result = f.run("uninstall"), failed = ["delete-error", "unlink-error"].includes(scenario);
      assert.equal(result.status, failed ? 1 : 0, result.stderr);
      assert.equal(result.stdout.includes('"installed":false'), !failed);
      if (failed) assert.match(result.stderr, /fixture (deletion|unlink) refused/u);
      if (scenario === "delete-error") for (const name of ["start-codex-router.cmd", "start-codex-router-hidden.vbs"]) assert.equal(readFileSync(path.join(f.state, name), "utf8"), "previous launcher");
    } finally { f.dispose(); }
  });
}
test("fresh task installation and confirmed-absent status remain supported", () => {
  const f = managerFixture("install-new");
  try { const result = f.run("install"); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"installed":true/u); }
  finally { f.dispose(); }
  const absent = managerFixture("missing");
  try { const result = absent.run("status"); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).installed, false); }
  finally { absent.dispose(); }
});

test("Windows status reuses its owned task state and still corroborates the live launcher", () => {
  for (const [scenario, state, loaded] of [
    ["owned", "ready", false],
    ["status-unknown", "unknown", false],
    ["status-running", "running", true],
    ["status-running-stale", "running", false],
    ["status-running-unavailable", "running", false],
    ["status-ready-live", "running", true],
    ["status-ready-no-instance", "ready", false],
  ]) {
    const f = managerFixture(scenario);
    try {
      const result = f.run("status");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { installed: true, loaded, state }, scenario);
      const calls = f.calls();
      assert.equal(calls.length, 2, "one owned snapshot and one independent task/launcher query");
      assert.equal(calls.every(call => call.name === "powershell.exe"), true);
    } finally { f.dispose(); }
  }
});

test("the authoritative task snapshot recognizes actual COM task absence", { skip: process.platform !== "win32" }, () => {
  const f = managerFixture("missing");
  try {
    assert.equal(f.run("status").status, 0);
    const call = f.calls().find(c => c.args.at(-1).includes("$snapshot ="));
    const result = spawnSync("powershell.exe", call.args, { windowsHide: true, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, CODEX_ROUTER_TASK: `Router-Absent-${path.basename(f.directory)}` } });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { exists: false });
  } finally { f.dispose(); }
});

test("the generated owned task snapshot retains its raw Scheduler state", { skip: process.platform !== "win32" }, () => {
  const f = managerFixture("owned");
  try {
    assert.equal(f.run("status").status, 0);
    const call = f.calls().find(c => c.args.at(-1).includes("$snapshot ="));
    const prefix = `
function New-Object { param($ComObject) if($ComObject -ne 'Schedule.Service'){throw 'unexpected COM construction'};
 $scheduler=[pscustomobject]@{}
 $scheduler | Add-Member -MemberType ScriptMethod -Name Connect -Value {}
 $scheduler | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($path)
  $folder=[pscustomobject]@{}
  $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($name)
   $registered=[pscustomobject]@{}
   $registered | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptor -Value {param($flags) 'fixture SDDL'}
   return $registered
  }
  return $folder
 }
 return $scheduler
}
function Get-ScheduledTask { param($TaskName)
 [pscustomobject]@{Actions=@([pscustomobject]@{Execute='wscript.exe';Arguments='fixture action'});Principal=[pscustomobject]@{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name};State=$env:FIXTURE_TASK_STATE}
}
function Export-ScheduledTask { param($TaskName) 'fixture XML' }
`;
    for (const state of ["Running", "Unknown"]) {
      const result = spawnSync("powershell.exe", [...call.args.slice(0, -1), prefix + call.args.at(-1)], {
        windowsHide: true, encoding: "utf8", timeout: 15_000,
        env: { ...f.env, CODEX_ROUTER_TASK_EXECUTE: "wscript.exe", CODEX_ROUTER_TASK_ARGUMENT: "fixture action", FIXTURE_TASK_STATE: state },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { exists: true, owned: true, state, xml: "fixture XML", sddl: "fixture SDDL", running: state === "Running" });
    }
  } finally { f.dispose(); }
});

for (const scenario of ["task-error-account", "task-error-denied", "task-error-missing"]) {
  for (const command of ["status", "install", "uninstall"]) test(`actual task catch preserves ${scenario} in ${command}`, { skip: process.platform !== "win32" }, () => {
    const f = managerFixture(scenario);
    try {
      const result = f.run(command);
      assert.equal(result.error, undefined);
      if (scenario !== "task-error-missing") {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unable to verify ownership/u);
        for (const name of ["start-codex-router.cmd", "start-codex-router-hidden.vbs"]) assert.equal(readFileSync(path.join(f.state, name), "utf8"), "previous launcher");
        assert.equal(f.calls().some(c => c.name === "schtasks.exe" || c.args.at(-1).includes("Register-ScheduledTask")), false);
      } else {
        assert.equal(result.status, 0, result.stderr);
        if (command === "status") assert.equal(JSON.parse(result.stdout).installed, false);
        if (command === "install") assert.equal(JSON.parse(result.stdout).installed, true);
        if (command === "uninstall") assert.equal(existsSync(path.join(f.state, "start-codex-router.cmd")), false);
      }
    } finally { f.dispose(); }
  });
}

test("direct and control service entries exit naturally and propagate status after cleanup", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-service-control-"));
  const source = path.join(directory, "source"), state = path.join(directory, "state"), rendered = path.join(directory, "rendered"), drained = path.join(directory, "drained");
  mkdirSync(path.join(source, "src"), { recursive: true }); mkdirSync(state);
  writeFileSync(path.join(source, "src/service-windows.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(rendered)},'rendered');process.exitCode=Number(process.env.RENDERER_STATUS);`);
  const helpers = path.join(directory, "helpers.mjs"), loader = path.join(directory, "loader.mjs");
  // beforeExit runs after Node drains its event loop and is skipped by a forced
  // process.exit, which can race native-handle teardown on Windows.
  writeFileSync(helpers, `import {writeFileSync} from 'node:fs';process.once('beforeExit',()=>writeFileSync(${JSON.stringify(drained)},'drained'));
export async function prepareRouterServiceMutation(){if(process.env.THROW_REFUSAL==='1')throw new Error('synthetic ownership refusal');return {status:'offline'};}export async function resumeRouterAdmission(){return {};}`);
  writeFileSync(loader, `export async function resolve(s,c,n){const r=await n(s,c);if(c.parentURL===${JSON.stringify(fileUrl('src/service.mjs'))}&&r.url===${JSON.stringify(fileUrl('src/service-drain.mjs'))})return{url:${JSON.stringify(pathToFileURL(helpers).href)},shortCircuit:true};return r;}`);
  try {
    for (const status of [0, 7, "throw"]) for (const entry of ["direct", "control"]) {
      rmSync(rendered, { force: true });
      rmSync(drained, { force: true });
      const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href,
        path.join(root, entry === "direct" ? "src/service.mjs" : "src/control.mjs"), ...(entry === "direct" ? ["stop"] : ["service", "stop"])], {
        encoding: "utf8", windowsHide: true, timeout: 15000,
        env: { ...process.env, CODEX_HOME: path.join(directory, "codex"), CODEX_ROUTER_SOURCE_ROOT: source,
          MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state, CODEX_ROUTER_SERVICE_PLATFORM: "win32",
          RENDERER_STATUS: String(status), THROW_REFUSAL: status === "throw" ? "1" : "0" },
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, status === "throw" ? 1 : status, result.stderr);
      assert.equal(existsSync(rendered), status !== "throw", "preflight refusal must not launch the renderer");
      assert.equal(existsSync(path.join(state, "service-operation.lock")), false, "the awaited wrapper must release before exit");
      assert.equal(existsSync(drained), true, "the CLI must let its event loop drain before exiting");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the ordinary service caller retains its lease while awaiting the renderer", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-service-lock-fixture-"));
  const state = path.join(directory, "state"), source = path.join(directory, "source"), trace = path.join(directory, "trace.jsonl");
  mkdirSync(path.join(source, "src"), { recursive: true }); mkdirSync(state); writeFileSync(trace, "");
  const helpers = path.join(directory, "helpers.mjs"), loader = path.join(directory, "loader.mjs"), release = path.join(directory, "release-renderer");
  const log = path.join(state, "router.log"), oldOutput = "previous launch output\n";
  writeFileSync(log, oldOutput);
  writeFileSync(helpers, `import {withServiceOperationLock as lock} from ${JSON.stringify(fileUrl('src/service-operation-lock.mjs'))};
import assert from 'node:assert/strict';import {readLogTail} from ${JSON.stringify(fileUrl('src/windows-launch-diagnosis.mjs'))};
export const withServiceOperationLock=operation=>lock(operation,{stateDir:${JSON.stringify(state)},waitMs:0,heartbeatMs:1000,retryMs:50});
export const prepareRouterServiceMutation=async()=>({status:'offline'});export const resumeRouterAdmission=async()=>({});
export const waitForServiceReadiness=async options=>{assert.equal(options.logPosition.size,${Buffer.byteLength(oldOutput)});const fresh=readLogTail(${JSON.stringify(log)},{after:options.logPosition});assert.equal(fresh,'current renderer output\\n');return {ok:true};};`);
  writeFileSync(loader, `export async function resolve(s,c,n){const r=await n(s,c);if(c.parentURL===${JSON.stringify(fileUrl('src/service.mjs'))}&&${JSON.stringify(['service-operation-lock.mjs','service-drain.mjs','service-readiness.mjs'].map(p=>fileUrl('src/'+p)))}.includes(r.url))return{url:${JSON.stringify(pathToFileURL(helpers).href)},shortCircuit:true};return r;}`);
  // Only the owner waits at the gate. A wrongly admitted stop must finish so
  // the custody assertion can fail and release the owner's renderer.
  writeFileSync(path.join(source, "src/service-windows.mjs"), `import {appendFileSync,existsSync} from 'node:fs';appendFileSync(${JSON.stringify(log)},'current renderer output\\n');appendFileSync(${JSON.stringify(trace)},JSON.stringify({command:process.argv[2],at:Date.now()})+'\\n');if(process.argv[2]==='install')while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));`);
  const env = { ...process.env, CODEX_HOME: path.join(directory, "codex"), CODEX_ROUTER_SOURCE_ROOT: source,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state, CODEX_ROUTER_SERVICE_PLATFORM: "win32" };
  const run = command => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href, path.join(root, "src/service.mjs"), command], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const errors = []; child.stderr.on("data", chunk => errors.push(chunk)); child.once("error", reject);
    child.once("close", code => resolve({ code, stderr: Buffer.concat(errors).toString("utf8") }));
  });
  let owner;
  try {
    owner = run("install");
    const waitFor = async (description, observed) => {
      const deadline = Date.now() + 3_300;
      while (!observed()) {
        assert.ok(Date.now() < deadline, description);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await waitFor("the renderer must start under its caller's lease", () => readFileSync(trace, "utf8"));
    const lock = path.join(state, "service-operation.lock");
    const ownerPath = path.join(lock, readdirSync(lock)[0]);
    const initialHeartbeat = statSync(ownerPath).mtimeMs;
    await waitFor("the service lease must heartbeat while the renderer remains pending", () => statSync(ownerPath).mtimeMs > initialHeartbeat);
    const contender = await run("stop"); assert.notEqual(contender.code, 0); assert.match(contender.stderr, /operation is still running/u);
    writeFileSync(release, "complete renderer\n");
    const result = await owner; assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(trace, "utf8").trim().split(/\r?\n/u).length, 1);
    assert.equal(existsSync(lock), false);
  } finally { writeFileSync(release, "complete renderer\n"); if (owner) await owner; rmSync(directory, { recursive: true, force: true }); }
});
