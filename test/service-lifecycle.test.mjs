import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(helpers, `import {appendFileSync} from 'node:fs';import path from 'node:path';
const scenario=${JSON.stringify(scenario)},source=${JSON.stringify(source)},trace=${JSON.stringify(trace)};
let exists=!['missing','install-new'].includes(scenario),killed=false,identityCalls=0;
const note=(name,args)=>appendFileSync(trace,JSON.stringify({name,args})+'\\n');
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
   if(scenario==='query-error')throw new Error('fixture query unavailable');
   if(scenario==='malformed-task')return '{}';
   return JSON.stringify(exists?{exists:true,owned:scenario!=='foreign',running:false,xml:'fixture XML',sddl:'fixture SDDL'}:{exists:false});
  }
  if(script.includes('Register-ScheduledTask')){exists=true;return '';}
  if(script.includes('.State.ToString()'))return 'ready';
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
  if(scenario==='stop-process-partial')return{status:0,stdout:'42|'};
  if(scenario==='stop-reused')return{status:0,stdout:'43|fixture-node.exe'};
  return killed?{status:3}:{status:0,stdout:'42|fixture-node.exe'};
 }
 if(scenario==='stop-command-unknown')return{status:1};
 return{status:0,stdout:'node "'+path.join(source,'src/start.mjs')+'"'};
}
export function execFile(){throw new Error('unexpected async helper');}
`);
  writeFileSync(security, "import {writeFileSync} from 'node:fs';export const ensureProgramTreeReadable=()=>{};export const protectPrivateFile=()=>{};export const writePrivateFile=(p,v)=>writeFileSync(p,v);export const writePrivateJson=(p,v)=>writeFileSync(p,JSON.stringify(v));");
  writeFileSync(filesystem, `import * as fs from 'node:fs';export * from 'node:fs';export function unlinkSync(p){if(${JSON.stringify(scenario)}==='unlink-error'&&String(p).endsWith('start-codex-router-hidden.vbs'))throw new Error('fixture unlink refused');return fs.unlinkSync(p);}`);
  const loader = path.join(directory, "loader.mjs");
  writeFileSync(loader, `export async function resolve(s,c,n){
if(s==='node:child_process')return{url:${JSON.stringify(pathToFileURL(helpers).href)},shortCircuit:true};
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
for (const scenario of ["query-error", "malformed-task", "foreign"]) {
  for (const command of ["install", "uninstall", "status"]) test(`Windows ${command} refuses ${scenario} before changing the task`, () => {
    const f = managerFixture(scenario);
    try { const result = f.run(command); assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unable to verify ownership|not owned by/u);
      assert.equal(readFileSync(path.join(f.state, "start-codex-router.cmd"), "utf8"), "previous launcher");
      assert.equal(f.calls().some(c => c.name === "schtasks.exe" || c.args.at(-1).includes("Register-ScheduledTask")), false);
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

test("the ordinary service caller renews its lock while awaiting the renderer", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-service-lock-fixture-"));
  const state = path.join(directory, "state"), source = path.join(directory, "source"), trace = path.join(directory, "trace.jsonl");
  mkdirSync(path.join(source, "src"), { recursive: true }); mkdirSync(state); writeFileSync(trace, "");
  const helpers = path.join(directory, "helpers.mjs"), loader = path.join(directory, "loader.mjs");
  writeFileSync(helpers, `import {withServiceOperationLock as lock} from ${JSON.stringify(fileUrl('src/service-operation-lock.mjs'))};
export const withServiceOperationLock=operation=>lock(operation,{stateDir:${JSON.stringify(state)},waitMs:0,staleMs:2000,retryMs:50});
export const prepareRouterServiceMutation=async()=>({status:'offline'});export const resumeRouterAdmission=async()=>({});export const waitForServiceReadiness=async()=>({ok:true});`);
  writeFileSync(loader, `export async function resolve(s,c,n){const r=await n(s,c);if(c.parentURL===${JSON.stringify(fileUrl('src/service.mjs'))}&&${JSON.stringify(['service-operation-lock.mjs','service-drain.mjs','service-readiness.mjs'].map(p=>fileUrl('src/'+p)))}.includes(r.url))return{url:${JSON.stringify(pathToFileURL(helpers).href)},shortCircuit:true};return r;}`);
  writeFileSync(path.join(source, "src/service-windows.mjs"), `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(trace)},JSON.stringify({command:process.argv[2],at:Date.now()})+'\\n');await new Promise(r=>setTimeout(r,4500));`);
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
    while (!readFileSync(trace, "utf8")) await new Promise(r => setTimeout(r,20));
    await new Promise(r => setTimeout(r,3300));
    const contender = await run("stop"); assert.notEqual(contender.code, 0); assert.match(contender.stderr, /operation is still running/u);
    const result = await owner; assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(trace, "utf8").trim().split(/\r?\n/u).length, 1);
  } finally { if (owner) await owner; rmSync(directory, { recursive: true, force: true }); }
});
