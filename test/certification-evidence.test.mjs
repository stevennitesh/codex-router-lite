import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractCertificationEvidence, extractCertificationOutcomes } from "../maintenance/certification-evidence.mjs";
import { certificationBatchPreflight } from "../maintenance/certification-preflight.mjs";
import { certificationResultExitCode, executeCertificationPlan, publishCertificationDraft } from "../maintenance/certification-runner.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";

const at = second => new Date(Date.UTC(2026,9,7,12,0,second)).toISOString();
const CHILD_ID = "019a0780-0000-7000-8000-000000000001";
const OTHER_CHILD_ID = "019a0780-0000-7000-8000-000000000002";
const SESSION_ID = "019a0780-0000-7000-8000-000000000003";
const identityHash = (kind, value) => createHash("sha256").update(`codex-router/${kind}/v1\0${value.toLowerCase()}`).digest("hex");

function fixture(slug = "openrouter/deepseek-v4.1-flash-together", cleanup = false, childId = CHILD_ID) {
  const route = MODEL_BY_SLUG.get(slug), role = routedAgentDefinition(route).agentName;
  const row = (second,type,payload) => ({timestamp:at(second),type,payload});
  const call = (second,name,arguments_,call_id) => row(second,"response_item",{type:"function_call",name,arguments:JSON.stringify(arguments_),call_id});
  const output = (second,call_id,output) => row(second,"response_item",{type:"function_call_output",call_id,output:typeof output === "string" ? output : JSON.stringify(output)});
  const context = {model:slug,effort:route.defaultEffort,sandbox_policy:{type:"workspace-write"},approval_policy:"on-request"};
  const run = {version:1,startedAt:at(0),endedAt:at(20),parentSessionId:"private-parent",routerCommit:"a".repeat(40),sourceRoot:path.resolve("fixture-source"),codexVersion:"codex-cli 0.162.0-alpha.2",windowsAppVersion:"26.1002.7124.0",executionSurface:"codex-cli",windowsSandbox:"mxc",sandboxPolicy:"workspace-write",approvalPolicy:"on-request",routes:[{slug,firstMarker:"CERT_FIRST_OK",secondMarker:"CERT_SECOND_OK"}]};
  const child = [
    row(0,"session_meta",{id:childId,parent_thread_id:run.parentSessionId,agent_role:role,agent_path:"/root/child"}),
    row(1,"turn_context",context),
    row(2,"response_item",{type:"agent_message",content:[{type:"encrypted_content",encrypted_content:"private-ciphertext"}]}),
    call(3,"exec_command",{cmd:"Write-Output (19+23)"},"private-call"),
    output(4,"private-call","Process exited with code 0\nOutput:\n42\n"),
    row(5,"response_item",{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"CERT_FIRST_OK"}]}),
    row(6,"event_msg",{type:"task_complete"}),
    row(9,"turn_context",context),
    row(10,"response_item",{type:"agent_message",content:[{type:"encrypted_content",encrypted_content:"private-second-ciphertext"}]}),
    row(11,"response_item",{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"CERT_SECOND_OK"}]}),
    row(12,"event_msg",{type:"task_complete"}),
  ];
  const parent = [
    row(0,"session_meta",{id:run.parentSessionId,cli_version:"0.162.0-alpha.2"}),
    row(0,"turn_context",{...context,model:"gpt-6.1-sol"}),
    call(1,"spawn_agent",{agent_type:role,task_name:"child",fork_turns:"none"},"private-spawn"),
    output(1,"private-spawn",{task_name:"/root/child"}),
    ...(cleanup ? [call(7,"interrupt_agent",{target:"child"},"private-cleanup1"),output(7,"private-cleanup1",{previous_status:{completed:"CERT_FIRST_OK"}})] : []),
    call(9,"followup_task",{target:"child",message:"Return CERT_SECOND_OK without tools"},"private-followup"),
    output(9,"private-followup",{task_name:"/root/child"}),
    ...(cleanup ? [call(13,"interrupt_agent",{target:"child"},"private-cleanup2"),output(13,"private-cleanup2",{previous_status:{completed:"CERT_SECOND_OK"}})] : []),
    row(15,"event_msg",{type:"task_complete"}),
  ];
  let routerLog = [3,4,10].map(second => `[codex-router] timing at=${at(second)} model=${slug} provider=${route.provider} status=200 total_ms=10 thread_sha256=${identityHash("thread",childId)}${route.provider === "switchyard" ? ` session_sha256=${identityHash("session",SESSION_ID)}` : ""}`).join("\n");
  let switchyardRoutingLog;
  if (route.provider === "switchyard") {
    routerLog = `Switchyard libsy server\n${at(2).replace(".000Z",".000001Z")} INFO selected_model="switchyard/sol-medium" agent_id="${childId}"\n${routerLog}`;
    switchyardRoutingLog = [3,4,10].map(second => JSON.stringify({ts:at(second).replace(".000Z",".000001Z"),session_id:SESSION_ID,model:"switchyard/sol-medium"})).join("\n");
  }
  return {run,parent,children:[child],routerLog,switchyardRoutingLog,installManifest:{version:1,current:{commit:run.routerCommit,sourceRoot:run.sourceRoot,packageVersion:"0.7.0"}}};
}

test("extraction verifies native observations and emits only redacted draft proof", () => {
  for (const cleanup of [false,true]) {
    const input = fixture(undefined,cleanup), before = structuredClone(input);
    const summary = extractCertificationEvidence(input);
    assert.deepEqual(input,before);
    assert.equal(summary.status,"draft");
    assert.equal(summary.reports[0].draftProof.status,"draft");
    assert.equal(summary.reports[0].draftProof.endpointProvider,"together");
    assert.deepEqual(summary.reports[0].draftProof.checks.streaming,{outcome:"pending"});
    assert.equal(summary.reports[0].lifecycle.completedCleanupCalls,cleanup ? 2 : 0);
    assert.equal(summary.reports[0].draftProof.checks.sameThreadFollowUp.outcome,"pass");
    assert.doesNotMatch(JSON.stringify(summary),/private-parent|private-child|private-ciphertext|private-call|fixture-source/u);
  }
});

test("a completed window remains extractable after the child is resumed", () => {
  const input = fixture(), expected = extractCertificationEvidence(input);
  input.children[0].push(
    {timestamp:at(21),type:"turn_context",payload:input.children[0][1].payload},
    {timestamp:at(22),type:"event_msg",payload:{type:"turn_aborted"}},
  );
  assert.deepEqual(extractCertificationEvidence(input),expected);
  for (const requiredIndex of [8,10]) {
    const incomplete = fixture();
    incomplete.children[0][requiredIndex].timestamp = at(21);
    assert.throws(() => extractCertificationEvidence(incomplete));
  }
});

test("empty native follow-up acknowledgements require actual same-child delivery", () => {
  const nativeFixture = () => {
    const input = fixture(undefined,true);
    input.parent.find(row => row.payload.call_id === "private-followup" && row.payload.type === "function_call_output").payload.output = "";
    return input;
  };
  assert.equal(extractCertificationEvidence(nativeFixture()).reports[0].draftProof.checks.sameThreadFollowUp.outcome,"pass");
  for (const mutate of [
    input => {input.parent = input.parent.filter(row => row.payload.call_id !== "private-followup" || row.payload.type !== "function_call_output");},
    input => {input.children[0][8].payload.content = [{type:"text",text:"unencrypted"}];},
    input => {input.children[0][8].timestamp = at(8);},
    input => {input.children[0][9].payload.content[0].text = "WRONG_SECOND_OK";},
    input => {input.parent.find(row => row.payload.name === "followup_task").payload.arguments = JSON.stringify({target:"different-child"});},
    input => {input.parent.find(row => row.payload.call_id === "private-followup" && row.payload.type === "function_call_output").payload.output = "arbitrary acknowledgement";},
  ]) {
    const input = nativeFixture(); mutate(input);
    assert.throws(() => extractCertificationEvidence(input));
  }
});

test("failed, cancelled, mismatched and partial windows cannot become proof", () => {
  const mutations = [
    input => {input.run.endedAt = input.run.startedAt;},
    input => {input.run.startedAt = "2026-02-30T00:00:00.000Z";},
    input => {input.run.startedAt = "2026-10-07T12:00:00Z";},
    input => {input.run.routes[0].slug = "unknown/model";},
    input => {input.installManifest.current.commit = "b".repeat(40);},
    input => {input.installManifest.current.sourceRoot = path.resolve("another-source");},
    input => {input.parent[0].payload.id = "different-parent";},
    input => {input.children[0][0].payload.parent_thread_id = "different-parent";},
    input => {input.children.push(structuredClone(input.children[0]));},
    input => {input.children[0][1].payload.effort = "unsupported";},
    input => {input.children[0][1].payload.sandbox_policy.type = "danger-full-access";},
    input => {input.children[0][4].payload.call_id = "wrong-call";},
    input => {input.children[0][4].payload.output = "Process exited with code 1\nOutput:\n42\n";},
    input => {input.children[0][3].payload.arguments = JSON.stringify({cmd:"Write-Output (19+23)",sandbox_permissions:"require_escalated"});},
    input => {input.children[0][8].payload.content = [{type:"text",text:"unencrypted"}];},
    input => {input.children[0][9].payload.content[0].text = "WRONG_SECOND_OK";},
    input => {input.children[0].pop();},
    input => {input.parent.find(row => row.payload.name === "followup_task").timestamp = at(5);},
    input => {input.parent.find(row => row.payload.name === "followup_task").payload.arguments = JSON.stringify({target:"different-child"});},
    input => {input.parent.find(row => row.payload.call_id === "private-followup" && row.payload.type === "function_call_output").payload.call_id = "wrong-followup-call";},
    input => {input.parent.find(row => row.payload.call_id === "private-followup" && row.payload.type === "function_call_output").payload.output = JSON.stringify({task_name:"/root/different-child"});},
    input => {input.parent.find(row => row.payload.call_id === "private-followup" && row.payload.type === "function_call_output").payload.output = JSON.stringify({task_name:"/root/child",error:"failed continuation"});},
    input => {input.parent.at(-1).timestamp = at(5);},
    input => {input.parent.splice(-1,0,{timestamp:at(14),type:"event_msg",payload:{type:"task_aborted"}});},
    input => {input.children[0].push({timestamp:at(13),type:"event_msg",payload:{type:"turn_aborted",reason:"interrupted"}});},
    input => {input.routerLog = input.routerLog.replace("status=200","status=0");},
    input => {input.routerLog = input.routerLog.replace("provider=openrouter","provider=switchyard");},
    input => {input.routerLog += `\n[codex-router] timing at=${at(16)} model=${input.run.routes[0].slug} provider=openrouter status=200 total_ms=10 thread_sha256=${identityHash("thread",CHILD_ID)}`;},
    input => {input.parent.pop();},
  ];
  for (const mutate of mutations) {const input = fixture(); mutate(input); assert.throws(() => extractCertificationEvidence(input));}
  const cancelled = fixture(undefined,true);
  cancelled.parent.find(row => row.payload.call_id === "private-cleanup1" && row.payload.type === "function_call_output").payload.output = JSON.stringify({previous_status:"running"});
  assert.throws(() => extractCertificationEvidence(cancelled),/already-completed/);
});

function pairedFixture(otherSlug = "openrouter/glm-5.3-flash-together") {
  const input = fixture(), other = fixture(otherSlug,false,OTHER_CHILD_ID);
  input.run.routes.push(other.run.routes[0]);
  other.children[0][0].payload.agent_path = "/root/child2";
  for (const row of other.parent) {
    if (row.payload.call_id) row.payload.call_id += "_2";
    if (row.payload.type === "function_call") {
      const arguments_ = JSON.parse(row.payload.arguments);
      if (arguments_.task_name) arguments_.task_name = "child2";
      if (arguments_.target) arguments_.target = "child2";
      row.payload.arguments = JSON.stringify(arguments_);
    } else if (row.payload.type === "function_call_output") {
      row.payload.output = JSON.stringify({task_name:"/root/child2"});
    }
  }
  for (const row of other.children[0]) if (row.payload.call_id) row.payload.call_id += "_2";
  input.parent.splice(-1,0,...other.parent.filter(row => row.type === "response_item"));
  input.children.push(other.children[0]);
  input.routerLog += "\n" + other.routerLog;
  if (other.switchyardRoutingLog) input.switchyardRoutingLog = other.switchyardRoutingLog;
  return input;
}

test("preflight marker pairs can be reused across distinct exact child identities", () => {
  const input = pairedFixture();
  assert.equal(extractCertificationEvidence(input).reports.length,2);
  input.children[1][0].payload.id = CHILD_ID;
  assert.throws(() => extractCertificationEvidence(input),/different child identities/);
  input.children[1][0].payload.id = CHILD_ID.toUpperCase();
  assert.throws(() => extractCertificationEvidence(input),/different child identities/);
});

test("same-route foreign timings cannot satisfy, inflate or invalidate a child's proof", () => {
  const input = fixture(), slug = input.run.routes[0].slug;
  for (const second of [0,3,8,16,20]) for (const status of [200,429]) {
    input.routerLog += `\n[codex-router] timing at=${at(second)} model=${slug} provider=openrouter status=${status} total_ms=10 thread_sha256=${identityHash("thread",OTHER_CHILD_ID)}`;
  }
  input.routerLog += `\n[codex-router] timing at=INVALID_FOREIGN_TIME model=${slug} provider=openrouter status=429 total_ms=10`;
  const summary = extractCertificationEvidence(input);
  assert.equal(summary.reports[0].timings.length,3);
  for (const value of [CHILD_ID,OTHER_CHILD_ID,identityHash("thread",CHILD_ID),"thread_sha256","session_sha256"]) assert.ok(!JSON.stringify(summary).includes(value));
  for (const mutate of [
    value => { value.routerLog = value.routerLog.replace("status=200","status=429"); },
    value => { value.routerLog = value.routerLog.replace(`thread_sha256=${identityHash("thread",CHILD_ID)}`,""); },
    value => { value.routerLog = value.routerLog.replace(identityHash("thread",CHILD_ID),identityHash("thread",OTHER_CHILD_ID)); },
    value => { value.routerLog = value.routerLog.split("\n").slice(1).join("\n"); },
    value => { value.routerLog = value.routerLog.replace(at(3),"INVALID_OWN_TIME"); },
  ]) {
    const invalid = structuredClone(input); mutate(invalid);
    assert.throws(() => extractCertificationEvidence(invalid));
  }
  const legacy = fixture(); legacy.routerLog = legacy.routerLog.replace(/ thread_sha256=[a-f0-9]{64}/gu,"");
  assert.throws(() => extractCertificationEvidence(legacy));
});

test("actual Router timing output remains child-specific through native evidence extraction", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(),"certification-timing-wire-"));
  let router;
  const upstreamRequests = [];
  const upstream = http.createServer(async (request,response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    upstreamRequests.push({headers:request.headers,body});
    const failed = body.input === "SYNTHETIC_REFUSAL";
    response.writeHead(failed ? 503 : 200,{"content-type":"application/json"});
    response.end(JSON.stringify(failed ? {error:{message:"PRIVATE_PROVIDER_CANARY"}} :
      {id:"resp_synthetic",status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"42"}]}]}));
  });
  try {
    await new Promise(resolve => upstream.listen(0,"127.0.0.1",resolve));
    const port = await openPort(), capability = "synthetic-timing-caller-capability-long-enough";
    const base = callerBaseUrl(port,capability), target = `http://127.0.0.1:${upstream.address().port}/v1`;
    router = launch("router.mjs",{MODEL_ROUTER_STATE_DIR:state,CODEX_HOME:state,
      CODEX_ROUTER_PORT:String(port),CODEX_ROUTER_CALLER_KEY:capability,CODEX_ROUTER_INTERNAL_KEY:"synthetic-timing-internal-capability-long-enough",
      CODEX_ROUTER_API_BASE_URL:target,CODEX_ROUTER_GATEWAY_BASE_URL:target,CODEX_NATIVE_BASE_URL:target,CODEX_ROUTER_QUIET:"1"});
    await ready(`http://127.0.0.1:${port}/live`,router);
    const input = fixture(), slug = input.run.routes[0].slug;
    const request = async (thread,failed = false) => {
      const result = await fetch(`${base}/responses`,{method:"POST",headers:{"content-type":"application/json","thread-id":thread,"session-id":SESSION_ID},
        body:JSON.stringify({model:slug,input:failed ? "SYNTHETIC_REFUSAL" : "SYNTHETIC_TIMING",stream:false})});
      await result.text(); assert.equal(result.status,failed ? 503 : 200);
    };
    const start = Date.now() - 2;
    await request(OTHER_CHILD_ID);
    await new Promise(resolve => setTimeout(resolve,15));
    const childStart = Date.now();
    await request(CHILD_ID); await request(OTHER_CHILD_ID,true);
    await request(CHILD_ID); await request(CHILD_ID);
    const childEnd = Date.now() + 80;
    await new Promise(resolve => setTimeout(resolve,90));
    await request(OTHER_CHILD_ID);
    const end = Date.now() + 2;
    await stop(router);
    input.routerLog = router.errors();
    const stamp = second => new Date(second === 0 ? start : second >= 15 ? end - 1 : childStart + Math.round((second - 1) * (childEnd - childStart) / 11)).toISOString();
    for (const rows of [input.parent,...input.children]) for (const row of rows) row.timestamp = stamp(Number(/:(\d{2})\.000Z$/u.exec(row.timestamp)[1]));
    input.run.startedAt = new Date(start).toISOString(); input.run.endedAt = new Date(end).toISOString();
    const summary = extractCertificationEvidence(input);
    assert.equal(summary.reports[0].timings.length,3);
    assert.ok(summary.reports[0].timings.every(row => row.status === 200));
    for (const value of [CHILD_ID,OTHER_CHILD_ID,SESSION_ID,identityHash("thread",CHILD_ID),"PRIVATE_PROVIDER_CANARY"]) assert.ok(!JSON.stringify(summary).includes(value));
    assert.equal(upstreamRequests.length,6);
    assert.ok(upstreamRequests.every(({headers,body}) => headers["thread-id"] === undefined && headers["session-id"] === undefined && !JSON.stringify(body).includes("sha256")));
    const failed = structuredClone(input); failed.routerLog = failed.routerLog.replace(`model=${slug} provider=openrouter status=200`, `model=${slug} provider=openrouter status=429`);
    // The first timing is foreign; changing it still cannot invalidate the child.
    assert.equal(extractCertificationEvidence(failed).reports[0].timings.length,3);
    let changed = false;
    failed.routerLog = input.routerLog.split("\n").map(line => {
      if (changed || !line.includes(`thread_sha256=${identityHash("thread",CHILD_ID)}`)) return line;
      changed = true; return line.replace("status=200","status=429");
    }).join("\n");
    assert.ok(changed); assert.throws(() => extractCertificationEvidence(failed));
  } finally {
    if (router && router.exitCode === null) await stop(router);
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    rmSync(state,{recursive:true,force:true});
  }
});

test("route outcomes retain healthy children while strict extraction rejects partial batches", () => {
  for (const index of [0,1]) {
    const input = pairedFixture(), before = structuredClone(input);
    input.children[index][9].payload.content[0].text = "WRONG_SECOND_OK";
    const outcomes = extractCertificationOutcomes(input);
    assert.equal(outcomes.status,"partial");
    assert.deepEqual(outcomes.reports.map(report => report.slug),[input.run.routes[1 - index].slug]);
    assert.deepEqual(outcomes.failures.map(report => report.slug),[input.run.routes[index].slug]);
    assert.equal(outcomes.failures[0].code,"native_evidence_invalid");
    assert.throws(() => extractCertificationEvidence(input));
    assert.deepEqual(input.run,before.run);
    assert.doesNotMatch(JSON.stringify(outcomes),/private-parent|private-child|private-ciphertext|private-call|fixture-source/u);
  }
});

test("partial extraction cannot bypass shared parent, runtime, scope or identity checks", () => {
  for (const mutate of [
    input => { input.installManifest.current.commit = "b".repeat(40); },
    input => { input.parent[0].payload.id = "wrong-parent"; },
    input => { input.parent[1].payload.sandbox_policy.type = "danger-full-access"; },
    input => { input.parent.push({timestamp:at(7),type:"event_msg",payload:{type:"turn_aborted"}}); },
    input => { input.children[1][0].payload.id = input.children[0][0].payload.id; },
    input => { input.run.routes.pop(); },
    input => { input.parent.find(row => row.payload.name === "spawn_agent").payload.arguments = JSON.stringify({agent_type:"unrequested_role"}); },
  ]) {
    const input = pairedFixture(); mutate(input);
    assert.throws(() => extractCertificationOutcomes(input));
  }
});

function planFor(input) {
  const routes = input.run.routes.map(spec => MODEL_BY_SLUG.get(spec.slug));
  const roles = new Map(routes.map(route => {
    const role = routedAgentDefinition(route);
    return [path.join("roles",role.fileName),role.contents];
  }));
  const batch = certificationBatchPreflight(routes,{catalogPath:"catalog",manifestPath:"manifest",agentsDir:"roles",read:file => {
    if (file === "catalog") return JSON.stringify({models:routes.map(route => ({slug:route.slug,visibility:"list",multi_agent_version:"v2"}))});
    if (file === "manifest") return JSON.stringify(input.installManifest);
    return roles.get(file);
  }});
  const streaming = {version:1,routerCommit:input.run.routerCommit,codexVersion:input.run.codexVersion,windowsAppVersion:input.run.windowsAppVersion,reports:[]};
  return {batch,streaming};
}

function streamResponse(slug, status = 200) {
  if (status !== 200) return new Response("PRIVATE_BODY_CANARY",{status,headers:{"x-private":"PRIVATE_HEADER_CANARY"}});
  return new Response([
    {type:"response.output_text.delta",delta:"CERT_STREAM_OK"},
    {type:"response.completed",response:{status:"completed",model:slug}},
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
}

test("one shared plan publishes only the independently complete native route", async () => {
  for (const invalidIndex of [0,1]) {
    const input = pairedFixture(); input.children[invalidIndex][9].payload.content[0].text = "WRONG_SECOND_OK";
    const {batch,streaming} = planFor(input), requests = [], records = [];
    let parents = 0;
    const result = await executeCertificationPlan(batch,{streaming,now:() => at(0),
      request:report => { requests.push(report.slug); return streamResponse(report.slug); },
      native:async selected => {
        parents++;
        assert.deepEqual(selected.runManifestTemplate.routes,input.run.routes);
        return extractCertificationOutcomes(input);
      },record:(result,streams) => records.push(JSON.parse(JSON.stringify({result,streams})))});
    assert.equal(parents,1); assert.equal(requests.length,2);
    assert.equal(result.status,"partial"); assert.equal(certificationResultExitCode(result),1);
    assert.equal(result.summary.reports.length,1);
    const healthy = input.run.routes[1 - invalidIndex].slug;
    assert.equal(result.summary.reports[0].slug,healthy);
    assert.doesNotMatch(JSON.stringify(records),/PRIVATE_BODY_CANARY|PRIVATE_HEADER_CANARY|private-child|private-parent|private-ciphertext/u);
    const root = mkdtempSync(path.join(os.tmpdir(),"partial-certification-"));
    try {
      const evidencePath = path.join(root,"docs/history/partial.json");
      assert.equal(publishCertificationDraft(result.summary,evidencePath,{sourceRoot:root}).status,"accepted");
      const proof = JSON.parse(readFileSync(path.join(root,"v2_agent",healthy,"proof.json"),"utf8"));
      assert.equal(proof.status,"accepted"); assert.equal(proof.checks.streaming.outcome,"pass");
      assert.equal(JSON.parse(readFileSync(evidencePath,"utf8")).reports.length,1);
      assert.equal(existsSync(path.join(root,"v2_agent",input.run.routes[invalidIndex].slug,"proof.json")),false);
    } finally { rmSync(root,{recursive:true,force:true}); }
  }
});

test("route refusals skip native work for that route and preserve the all-pass call counts", async () => {
  for (const statuses of [[200,200],[429,200],[200,503]]) {
    const input = pairedFixture(), {batch,streaming} = planFor(input), requests = [];
    let parents = 0;
    const result = await executeCertificationPlan(batch,{streaming,now:() => at(0),
      request:report => { requests.push(report.slug); return streamResponse(report.slug,statuses[requests.length - 1]); },
      native:async selected => {
        parents++;
        const expected = batch.reports.filter((_report,index) => statuses[index] === 200).map(report => report.slug);
        assert.deepEqual(selected.reports.map(report => report.slug),expected);
        assert.deepEqual(selected.runManifestTemplate.routes.map(report => report.slug),expected);
        return extractCertificationOutcomes(expected.length === 2 ? input : fixture(expected[0]));
      }});
    assert.equal(requests.length,2); assert.equal(parents,1);
    assert.equal(result.status,statuses.every(status => status === 200) ? "draft" : "partial");
    assert.equal(certificationResultExitCode(result),result.status === "draft" ? 0 : 1);
    assert.equal(result.summary.reports.length,statuses.filter(status => status === 200).length);
    const failed = result.outcomes.find(outcome => outcome.status === "failed");
    if (failed) { assert.equal(failed.phase,"streaming"); assert.equal(failed.code,"http_refusal"); assert.ok([429,503].includes(failed.httpStatus)); }
  }
});

test("preflight blockers stay explicit without stopping a ready independent route", async () => {
  for (const allBlocked of [false,true]) {
    const input = pairedFixture(), {batch,streaming} = planFor(input);
    batch.reports[1].readyForFreshParent = false; batch.reports[1].blockers = ["Synthetic stale role"];
    if (allBlocked) { batch.reports[0].readyForFreshParent = false; batch.reports[0].blockers = ["Synthetic hidden route"]; }
    let requests = 0, parents = 0;
    const result = await executeCertificationPlan(batch,{streaming,now:() => at(0),
      request:report => { requests++; return streamResponse(report.slug); },
      native:async selected => { parents++; assert.equal(selected.reports.length,1); return extractCertificationOutcomes(fixture()); }});
    assert.equal(requests,allBlocked ? 0 : 1); assert.equal(parents,allBlocked ? 0 : 1);
    assert.equal(result.status,allBlocked ? "failed" : "partial");
    assert.equal(result.outcomes[1].status,"blocked"); assert.equal(result.outcomes[1].phase,"preflight");
  }
});

test("optional Switchyard smoke is route-scoped except for changed runtime identity", async () => {
  for (const scenario of ["pass","check-failed","process-failed","missing-binding","exception","runtime-changed","stream-failed"]) {
    const input = pairedFixture("switchyard/auto");
    const binding = JSON.parse(readFileSync(new URL("../v2_agent/switchyard/auto/proof.json",import.meta.url),"utf8")).runtimeBinding;
    input.runtimeBinding = {...binding,routerCommit:input.run.routerCommit};
    const {batch,streaming} = planFor(input);
    let smokeCalls = 0;
    const result = await executeCertificationPlan(batch,{streaming,now:() => at(0),
      request:report => streamResponse(report.slug,scenario === "stream-failed" && report.slug === "switchyard/auto" ? 429 : 200),
      native:async selected => extractCertificationOutcomes(selected.reports.length === 2 ? input : fixture()),
      smoke:async () => {
        smokeCalls++;
        if (scenario === "exception") throw new Error("PRIVATE_SMOKE_CANARY");
        if (scenario === "missing-binding") return {passed:false,evidence:{requiredFailures:["not-ready"]}};
        return {passed:scenario !== "process-failed",evidence:{binding:{routerCommit:scenario === "runtime-changed" ? "b".repeat(40) : input.run.routerCommit},requiredFailures:scenario === "check-failed" ? ["synthetic_failure"] : []}};
      }});
    assert.equal(smokeCalls,scenario === "stream-failed" ? 0 : 1);
    assert.equal(result.status,scenario === "pass" ? "draft" : scenario === "runtime-changed" ? "failed" : "partial");
    assert.equal(result.summary?.reports.length || 0,scenario === "pass" ? 2 : scenario === "runtime-changed" ? 0 : 1);
    if (result.status === "partial") assert.equal(result.summary.reports[0].slug,input.run.routes[0].slug);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SMOKE_CANARY/u);
  }
});

test("functions wrapper is verified from its produced command output", () => {
  const input = fixture(), child = input.children[0];
  child[3].payload = {type:"custom_tool_call",name:"exec",call_id:"private-call",input:'text(await tools.exec_command({"cmd":"Write-Output (19+23)","sandbox_permissions":"use_default"}));'};
  child[4].payload = {type:"custom_tool_call_output",call_id:"private-call",output:[{type:"input_text",text:JSON.stringify({exit_code:0,output:"42\n"})}]};
  assert.equal(extractCertificationEvidence(input).reports[0].tool.output,"42");
  child[3].payload.input += " await tools.other_tool({});";
  assert.throws(() => extractCertificationEvidence(input),/only the requested command/);
});

test("Switchyard observations require runtime binding and same-session successful routing", () => {
  const input = fixture("switchyard/auto");
  assert.throws(() => extractCertificationEvidence(input),/Switchyard needs/);
  input.runtimeBinding = {routerCommit:input.run.routerCommit,upstreamCommit:"b".repeat(40),upstreamContributionCommit:"c".repeat(40),...Object.fromEntries(["upstreamContributionSha256","patchSha256","binarySha256","routesSha256","templateSha256","templateSourceSha256"].map(key => [key,"d".repeat(64)]))};
  assert.equal(extractCertificationEvidence(input).reports[0].draftProof.runtimeBinding.routerCommit,input.run.routerCommit);
  const ownFailure = structuredClone(input);
  ownFailure.routerLog += `\n${at(7)} WARN falling back agent_id="${CHILD_ID}"`;
  assert.throws(() => extractCertificationEvidence(ownFailure),/Switchyard needs/);
  const foreignFailure = structuredClone(input);
  foreignFailure.routerLog += `\n${at(7)} WARN falling back agent_id="${OTHER_CHILD_ID}"`;
  assert.equal(extractCertificationEvidence(foreignFailure).reports[0].timings.length,3);
  input.switchyardRoutingLog = input.switchyardRoutingLog.replace(SESSION_ID,OTHER_CHILD_ID);
  assert.throws(() => extractCertificationEvidence(input),/Switchyard needs/);
});

test("CLI binds installed policy, skips unrelated transcript bodies and never overwrites outputs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"router-cert-evidence-"));
  try {
    const input = fixture(), state = path.join(root,"state"), source = path.join(root,"source"), children = path.join(root,"children");
    for (const directory of [state,children,path.join(source,"config/openrouter")]) mkdirSync(directory,{recursive:true});
    input.run.sourceRoot = source; input.installManifest.current.sourceRoot = source;
    const routePath = path.join(source,`config/${input.run.routes[0].slug}.json`);
    writeFileSync(routePath,JSON.stringify({models:[{...MODEL_BY_SLUG.get(input.run.routes[0].slug),multiAgentVersion:"v1"}]}));
    const runPath = path.join(root,"run.json"), parentPath = path.join(root,"parent.jsonl"), logPath = path.join(root,"router.log"), outputPath = path.join(root,"evidence.json");
    const jsonl = value => value.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(path.join(state,"install-manifest.json"),JSON.stringify(input.installManifest));
    writeFileSync(runPath,JSON.stringify(input.run)); writeFileSync(parentPath,jsonl(input.parent));
    writeFileSync(path.join(children,"child.jsonl"),jsonl(input.children[0]));
    writeFileSync(path.join(children,"unrelated.jsonl"),JSON.stringify({type:"session_meta",payload:{parent_thread_id:"another-private-parent"}}) + "\nINVALID PRIVATE TRANSCRIPT MUST NOT BE READ\n");
    writeFileSync(logPath,input.routerLog);
    const argv = ["maintenance/certification-evidence.mjs","extract","--run",runPath,"--parent",parentPath,"--children",children,"--router-log",logPath,"--output",outputPath];
    const execute = () => spawnSync(process.execPath,argv,{encoding:"utf8",windowsHide:true,env:{...process.env,MODEL_ROUTER_STATE_DIR:state,CODEX_HOME:root}});
    const success = execute(); assert.equal(success.status,0,success.stderr);
    const summary = readFileSync(outputPath,"utf8");
    assert.doesNotMatch(summary,/private-parent|private-child|private-ciphertext|fixture-source|another-private-parent/u);
    assert.equal(JSON.parse(summary).reports[0].draftProof.status,"draft");
    const repeated = execute(); assert.equal(repeated.status,1); assert.match(repeated.stderr,/EEXIST/);
    assert.equal(readFileSync(outputPath,"utf8"),summary);
    assert.equal(readFileSync(runPath,"utf8"),JSON.stringify(input.run));
    assert.equal(readFileSync(parentPath,"utf8"),jsonl(input.parent));
    rmSync(outputPath);
    const changed = {...MODEL_BY_SLUG.get(input.run.routes[0].slug),upstreamModel:"different/model"};
    writeFileSync(routePath,JSON.stringify({models:[changed]}));
    const mismatch = execute(); assert.equal(mismatch.status,1); assert.match(mismatch.stderr,/installed exact route policy differs/);
    assert.throws(() => readFileSync(outputPath),{code:"ENOENT"});
    argv[argv.length - 1] = runPath;
    const collision = execute(); assert.equal(collision.status,1); assert.match(collision.stderr,/not replace a private input/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("CLI checks Switchyard artifact hashes and excludes failed earlier windows", () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"router-cert-switchyard-"));
  try {
    const input = fixture("switchyard/auto"), state = path.join(root,"state"), source = path.join(root,"source"), runtime = path.join(root,"switchyard"), children = path.join(root,"children");
    const config = path.join(source,"config/switchyard"), patches = path.join(config,"patches");
    for (const directory of [state,runtime,children,patches]) mkdirSync(directory,{recursive:true});
    input.run.sourceRoot = source; input.installManifest.current.sourceRoot = source;
    writeFileSync(path.join(config,"auto.json"),JSON.stringify({models:[{...MODEL_BY_SLUG.get("switchyard/auto"),multiAgentVersion:"v1"}]}));
    const hash = contents => createHash("sha256").update(contents).digest("hex");
    const binary = "synthetic binary - never execute", routes = "synthetic routes\n", patch = "synthetic compatibility patch\n", contribution = "synthetic contribution\n", template = "synthetic template\r\n";
    const lock = {commit:"b".repeat(40),patch:"patches/compat.patch",patchSha256:hash(patch),upstreamContribution:{sourceCommit:"c".repeat(40),patch:"patches/contribution.patch",patchSha256:hash(contribution)}};
    const provenance = {routerCommit:input.run.routerCommit,upstreamCommit:lock.commit,upstreamContributionCommit:lock.upstreamContribution.sourceCommit,upstreamContributionSha256:hash(contribution),patchSha256:hash(patch),binarySha256:hash(binary),routesSha256:hash(routes),templateSha256:hash(template),templateSourceSha256:hash("synthetic template\n"),privateField:"must-not-copy-private-provenance"};
    writeFileSync(path.join(config,"source.lock"),JSON.stringify(lock));
    writeFileSync(path.join(patches,"compat.patch"),patch); writeFileSync(path.join(patches,"contribution.patch"),contribution);
    writeFileSync(path.join(config,"routes.template.toml"),template);
    const binaryPath = path.join(runtime,"switchyard-server.exe"), routesPath = path.join(runtime,"routes.toml");
    writeFileSync(binaryPath,binary); writeFileSync(routesPath,routes); writeFileSync(path.join(runtime,"provenance.json"),JSON.stringify(provenance));
    writeFileSync(path.join(runtime,"routing.jsonl"),input.switchyardRoutingLog + "\n" + JSON.stringify({ts:at(20).replace(".000Z",".000001Z"),session_id:OTHER_CHILD_ID,model:"switchyard/sol-medium"}));
    const runPath = path.join(root,"run.json"), parentPath = path.join(root,"parent.jsonl"), logPath = path.join(root,"router.log"), outputPath = path.join(root,"evidence.json");
    writeFileSync(path.join(state,"install-manifest.json"),JSON.stringify(input.installManifest)); writeFileSync(runPath,JSON.stringify(input.run));
    writeFileSync(parentPath,input.parent.map(row => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(path.join(children,"child.jsonl"),input.children[0].map(row => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(logPath,`Switchyard libsy server\n[codex-router] timing at=${at(-10)} model=switchyard/auto provider=switchyard status=0 total_ms=20\n${at(2).replace(".000Z",".000001Z")} INFO selected_model="switchyard/sol-medium" agent_id="private-trace-id"\n${input.routerLog}\n${at(20).replace(".000Z",".000001Z")} WARN falling back outside this window`);
    const argv = ["maintenance/certification-evidence.mjs","extract","--run",runPath,"--parent",parentPath,"--children",children,"--router-log",logPath,"--output",outputPath];
    const execute = () => spawnSync(process.execPath,argv,{encoding:"utf8",windowsHide:true,env:{...process.env,MODEL_ROUTER_STATE_DIR:state,CODEX_HOME:root,CODEX_ROUTER_SWITCHYARD_ROOT:runtime,CODEX_ROUTER_SWITCHYARD_BIN:binaryPath,CODEX_ROUTER_SWITCHYARD_CONFIG:routesPath}});
    const success = execute(); assert.equal(success.status,0,success.stderr);
    const summary = readFileSync(outputPath,"utf8");
    assert.equal(JSON.parse(summary).reports[0].draftProof.runtimeBinding.templateSourceSha256,hash("synthetic template\n"));
    assert.doesNotMatch(summary,/private-switchyard-session|must-not-copy-private-provenance/u);
    rmSync(outputPath); writeFileSync(binaryPath,"wrong binary");
    const mismatch = execute(); assert.equal(mismatch.status,1); assert.match(mismatch.stderr,/runtime hashes or pinned source binding differ/);
    assert.throws(() => readFileSync(outputPath),{code:"ENOENT"});
  } finally {rmSync(root,{recursive:true,force:true});}
});
