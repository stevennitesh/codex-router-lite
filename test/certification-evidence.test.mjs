import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractCertificationEvidence } from "../maintenance/certification-evidence.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";

const at = second => new Date(Date.UTC(2026,9,7,12,0,second)).toISOString();
function fixture(slug = "openrouter/deepseek-v4.1-flash-together", cleanup = false) {
  const route = MODEL_BY_SLUG.get(slug), role = routedAgentDefinition(route).agentName;
  const row = (second,type,payload) => ({timestamp:at(second),type,payload});
  const call = (second,name,arguments_,call_id) => row(second,"response_item",{type:"function_call",name,arguments:JSON.stringify(arguments_),call_id});
  const output = (second,call_id,output) => row(second,"response_item",{type:"function_call_output",call_id,output:typeof output === "string" ? output : JSON.stringify(output)});
  const context = {model:slug,effort:route.defaultEffort,sandbox_policy:{type:"workspace-write"},approval_policy:"on-request"};
  const run = {version:1,startedAt:at(0),endedAt:at(20),parentSessionId:"private-parent",routerCommit:"a".repeat(40),sourceRoot:path.resolve("fixture-source"),codexVersion:"codex-cli 0.162.0-alpha.2",windowsAppVersion:"26.1002.7124.0",executionSurface:"codex-cli",windowsSandbox:"mxc",sandboxPolicy:"workspace-write",approvalPolicy:"on-request",routes:[{slug,firstMarker:"CERT_FIRST_OK",secondMarker:"CERT_SECOND_OK"}]};
  const child = [
    row(0,"session_meta",{id:"private-child",parent_thread_id:run.parentSessionId,agent_role:role,agent_path:"/root/child"}),
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
  const routerLog = [3,4,10].map(second => `[codex-router] timing at=${at(second)} model=${slug} provider=${route.provider} status=200 total_ms=10`).join("\n");
  return {run,parent,children:[child],routerLog,installManifest:{version:1,current:{commit:run.routerCommit,sourceRoot:run.sourceRoot,packageVersion:"0.7.0"}}};
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
    input => {input.routerLog += `\n[codex-router] timing at=${at(16)} model=${input.run.routes[0].slug} provider=openrouter status=200 total_ms=10`;},
    input => {input.parent.pop();},
  ];
  for (const mutate of mutations) {const input = fixture(); mutate(input); assert.throws(() => extractCertificationEvidence(input));}
  const cancelled = fixture(undefined,true);
  cancelled.parent.find(row => row.payload.call_id === "private-cleanup1" && row.payload.type === "function_call_output").payload.output = JSON.stringify({previous_status:"running"});
  assert.throws(() => extractCertificationEvidence(cancelled),/already-completed/);
});

test("preflight marker pairs can be reused across distinct exact child identities", () => {
  const input = fixture(), other = fixture("openrouter/glm-5.3-flash-together");
  input.run.routes.push(other.run.routes[0]);
  other.children[0][0].payload.id = "private-child2";
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
  assert.equal(extractCertificationEvidence(input).reports.length,2);
  other.children[0][0].payload.id = "private-child";
  assert.throws(() => extractCertificationEvidence(input),/different child identities/);
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
  input.switchyardSummary = {routing:{uniqueSessions:1,total:3},failures:{http:0,fallback:0}};
  assert.equal(extractCertificationEvidence(input).reports[0].draftProof.runtimeBinding.routerCommit,input.run.routerCommit);
  input.switchyardSummary.routing.uniqueSessions = 2;
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
    writeFileSync(path.join(runtime,"routing.jsonl"),[3,4,10].map(second => JSON.stringify({ts:at(second).replace(".000Z",".000001Z"),session_id:"private-switchyard-session",model:"switchyard/sol-medium"})).concat(JSON.stringify({ts:at(20).replace(".000Z",".000001Z"),session_id:"outside-window-session",model:"switchyard/sol-medium"})).join("\n"));
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
