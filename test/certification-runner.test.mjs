import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { certificationBatchPreflight } from "../maintenance/certification-preflight.mjs";
import { certificationParentPrompt, certificationSessionDirectories, completeCertificationDraft, executeCertificationParent, observeCertificationStream, parseCertificationRunnerArguments, publishCertificationDraft } from "../maintenance/certification-runner.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";

const slug = "openrouter/deepseek-v4.1-flash-together";
const route = MODEL_BY_SLUG.get(slug);
const at = second => new Date(Date.UTC(2026,9,7,12,0,second)).toISOString();
function drafts() {
  const proof = JSON.parse(readFileSync(path.join("v2_agent",slug,"proof.json"),"utf8")); proof.status = "draft";
  const batch = certificationBatchPreflight([route],{read:() => undefined});
  const report = {slug,role:batch.reports[0].role,effort:route.defaultEffort,startedAt:at(5),endedAt:at(19),nativeParentSpawnObserved:true,sameChildRollout:true,encryptedHandoffCount:2,tool:{name:"exec_command",output:"42",success:true,defaultSandbox:true},finals:[{marker:"CERT_FIRST_OK"},{marker:"CERT_SECOND_OK"}],timings:[{status:200},{status:200},{status:200}],lifecycle:{completedTurns:2,completedCleanupCalls:2,activeTurnCancelled:false},draftProof:proof};
  const summary = {version:1,historical:true,status:"draft",routerCommit:proof.routerCommit,routerVersion:proof.routerVersion,codexVersion:proof.codexVersion,windowsAppVersion:proof.windowsAppVersion,executionSurface:proof.executionSurface,windowsSandbox:proof.windowsSandbox,sandboxPolicy:proof.sandboxPolicy,approvalPolicy:proof.approvalPolicy,reports:[report]};
  const streaming = {version:1,routerCommit:proof.routerCommit,codexVersion:proof.codexVersion,windowsAppVersion:proof.windowsAppVersion,reports:[{slug,routerCommit:proof.routerCommit,startedAt:at(1),endedAt:at(2),status:200,textDeltas:2,terminalType:"response.completed",markerObserved:true,pass:true}]};
  return {summary,streaming};
}

test("runner requires explicit spend/backend and keeps scope exact", () => {
  const args = ["run","--output","generated/new-proof","--windows-sandbox","mxc","--allow-live",slug];
  const parsed = parseCertificationRunnerArguments(args);
  assert.deepEqual(parsed.routes,[route]); assert.equal(parsed.sandbox,"mxc");
  for (const invalid of [args.filter(arg => arg !== "--allow-live"),[...args,slug],[...args,"--all"],[...args,"--switchyard-smoke"],[...args,"--unexpected"],args.map(arg => arg === "mxc" ? "disabled" : arg)]) assert.throws(() => parseCertificationRunnerArguments(invalid));
  assert.throws(() => parseCertificationRunnerArguments(["publish","--draft","drafts.json","--evidence","docs/history/new.json"]));
  const prompt = certificationParentPrompt(certificationBatchPreflight([route],{read:() => undefined}).reports);
  assert.match(prompt,/exactly 1/u); assert.match(prompt,/SAME child/u); assert.match(prompt,/no model or reasoning_effort override/u); assert.match(prompt,/without retry/u);
});

function eventResponse(events, {status = 200, contentType = "text/event-stream"} = {}) {
  const text = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.subarray(index,index + 7)); controller.close(); }});
  return new Response(body,{status,headers:{"content-type":contentType}});
}
const streamedEvents = [
  {type:"response.output_text.delta",delta:"CERT_"},
  {type:"response.output_text.delta",delta:"STREAM_OK"},
  {type:"response.completed",response:{status:"completed",model:slug}},
];
test("stream proof reads chunked SSE and rejects snapshots, partial and failed completions", async () => {
  const result = await observeCertificationStream(eventResponse(streamedEvents));
  assert.equal(result.textDeltas,2); assert.equal(result.pass,true); assert.equal(result.markerObserved,true);
  for (const response of [
    eventResponse(streamedEvents,{status:401}),eventResponse(streamedEvents,{contentType:"application/json"}),
    eventResponse([streamedEvents[2]]),eventResponse(streamedEvents.slice(0,2)),
    eventResponse([...streamedEvents.slice(0,2),{type:"response.failed"}]),
    eventResponse([...streamedEvents,{type:"response.output_text.delta",delta:"late"}]),
    eventResponse([{type:"response.output_text.delta",delta:"WRONG_MARKER"},streamedEvents[2]]),
  ]) await assert.rejects(observeCertificationStream(response));
});

test("joining native and streaming observations keeps drafts pending review and rejects mismatches", () => {
  const {summary,streaming} = drafts(), before = structuredClone(summary);
  const complete = completeCertificationDraft(summary,streaming);
  assert.deepEqual(summary,before); assert.equal(complete.status,"draft"); assert.equal(complete.reports[0].draftProof.status,"draft");
  assert.equal(complete.reports[0].draftProof.checks.streaming.observedAt,at(2));
  for (const mutate of [
    input => { input.streaming.routerCommit = "a".repeat(40); },
    input => { input.streaming.codexVersion = "different"; },
    input => { input.streaming.reports.push(structuredClone(input.streaming.reports[0])); },
    input => { input.streaming.reports[0].endedAt = at(10); },
    input => { input.streaming.reports[0].pass = false; },
    input => { input.summary.reports[0].draftProof.checks.encryptedRelay.outcome = "pending"; },
  ]) { const input = drafts(); mutate(input); assert.throws(() => completeCertificationDraft(input.summary,input.streaming)); }
});

test("reviewed publication validates before mutation, generates both formats and refuses overwrite", () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"certification-publication-"));
  try {
    const {summary,streaming} = drafts(), draft = completeCertificationDraft(summary,streaming);
    const evidencePath = path.join(root,"docs/history/tested.json"), application = path.join(root,"v2_agent",slug);
    mkdirSync(application,{recursive:true}); writeFileSync(path.join(application,"proof.json"),"prior proof");
    writeFileSync(path.join(application,"proof.md"),"prior markdown");
    const partial = structuredClone(draft); partial.reports[0].draftProof.checks.encryptedRelay.outcome = "pending";
    assert.throws(() => publishCertificationDraft(partial,evidencePath,{sourceRoot:root}));
    assert.equal(readFileSync(path.join(application,"proof.json"),"utf8"),"prior proof"); assert.equal(existsSync(evidencePath),false);
    const wrongBinding = structuredClone(draft); wrongBinding.reports[0].draftProof.endpointProvider = "deepinfra/fp8";
    assert.throws(() => publishCertificationDraft(wrongBinding,evidencePath,{sourceRoot:root}),/endpointProvider/u);
    draft.parentSessionId = "PRIVATE_PARENT_ID_MUST_NOT_PUBLISH";
    draft.reports[0].privateSessionId = "PRIVATE_CHILD_ID_MUST_NOT_PUBLISH";
    draft.reports[0].draftProof.privateTranscript = "PRIVATE_TRANSCRIPT_MUST_NOT_PUBLISH";
    draft.reports[0].draftProof.checks.streaming.sessionId = "PRIVATE_STREAM_ID_MUST_NOT_PUBLISH";
    assert.equal(publishCertificationDraft(draft,evidencePath,{sourceRoot:root}).status,"accepted");
    const accepted = JSON.parse(readFileSync(path.join(application,"proof.json"),"utf8"));
    assert.equal(accepted.status,"accepted"); assert.equal(accepted.evidence,"docs/history/tested.json");
    const markdown = readFileSync(path.join(application,"proof.md"),"utf8");
    assert.match(markdown,/## Evidence/u);
    assert.match(markdown,/\[Redacted run evidence\]\(\.\.\/\.\.\/\.\.\/docs\/history\/tested\.json\)/u);
    assert.match(markdown,/\[certification\]\(\.\.\/\.\.\/\.\.\/docs\/SUBAGENT-CERTIFICATION\.md\)/u);
    assert.doesNotMatch(readFileSync(evidencePath,"utf8"),/PRIVATE_PARENT_ID|PRIVATE_CHILD_ID|PRIVATE_TRANSCRIPT|PRIVATE_STREAM_ID/u);
    assert.throws(() => publishCertificationDraft(draft,evidencePath,{sourceRoot:root}),/new evidence/u);
    assert.equal(readFileSync(path.join(application,"proof.json"),"utf8"),JSON.stringify(accepted,null,2) + "\n");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("publication restores earlier files when a destination write fails", () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"certification-publication-failure-"));
  try {
    const {summary,streaming} = drafts(), draft = completeCertificationDraft(summary,streaming);
    const evidencePath = path.join(root,"docs/history/tested.json"), application = path.join(root,"v2_agent",slug);
    mkdirSync(application,{recursive:true});
    writeFileSync(path.join(application,"proof.json"),"prior proof");
    writeFileSync(path.join(application,"proof.md"),"prior markdown");
    let copied = 0;
    assert.throws(() => publishCertificationDraft(draft,evidencePath,{sourceRoot:root,copy:(from,to) => { if (++copied === 2) throw new Error("synthetic destination failure"); copyFileSync(from,to); }}),/synthetic destination failure/u);
    assert.equal(copied,2);
    assert.equal(readFileSync(path.join(application,"proof.json"),"utf8"),"prior proof"); assert.equal(existsSync(evidencePath),false);
    assert.equal(readFileSync(path.join(application,"proof.md"),"utf8"),"prior markdown");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("native runner bounds its parent and never turns a failed process into a session", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(),"certification-parent-"));
  try {
    const batch = certificationBatchPreflight([route],{read:() => undefined});
    let observed;
    const launch = (binary,args,options) => {
      observed = {binary,args};
      return spawn(process.execPath,["-e","process.stdin.resume(); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-parent'}));});"],options);
    };
    assert.equal(await executeCertificationParent({binary:"codex.exe"},batch,directory,"mxc",{launch,timeoutMs:5000}),"synthetic-parent");
    assert.ok(observed.args.includes('windows.sandbox="mxc"')); assert.ok(observed.args.includes("workspace-write"));
    assert.ok(observed.args.includes('approval_policy="on-request"'));
    assert.equal(JSON.parse(readFileSync(path.join(directory,"parent-exit.json"),"utf8")).deadlineExpired,false);
    const timed = path.join(directory,"timed"); mkdirSync(timed);
    await assert.rejects(executeCertificationParent({binary:"codex.exe"},batch,timed,"elevated",{timeoutMs:100,launch:(_binary,_args,options) => spawn(process.execPath,["-e","setInterval(()=>{},1000);"],options)}),/deadline/u);
    assert.equal(JSON.parse(readFileSync(path.join(timed,"parent-exit.json"),"utf8")).deadlineExpired,true);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("session discovery is bounded across midnight and skips absent date folders", () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"certification-session-dates-"));
  try {
    mkdirSync(path.join(root,"sessions/2026/10/07"),{recursive:true}); mkdirSync(path.join(root,"sessions/2026/10/08"),{recursive:true});
    const directories = certificationSessionDirectories({startedAt:"2026-10-07T23:59:50.000Z",endedAt:"2026-10-08T00:00:10.000Z"},root);
    assert.deepEqual(directories,[path.join(root,"sessions/2026/10/07"),path.join(root,"sessions/2026/10/08")]);
    assert.throws(() => certificationSessionDirectories({startedAt:at(0),endedAt:"2026-10-08T12:00:00.000Z"},root),/bounded hour/u);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
