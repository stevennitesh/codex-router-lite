import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { CHECKED_IN_MODELS, MODEL_BY_SLUG, validateRoutedEffort } from "../src/routed-models.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";

const slug = "openrouter/glm-5.3-flash-streamlake";

test("route effort vocabulary is shared by overrides and generated default roles", () => {
  for(const route of CHECKED_IN_MODELS) {
    for(const level of route.reasoningLevels) assert.equal(validateRoutedEffort(route,level.effort),level.effort);
    assert.match(routedAgentDefinition(route).contents,new RegExp(`model_reasoning_effort = "${route.defaultEffort}"`));
    assert.throws(()=>validateRoutedEffort(route,"unsupported"),/Unsupported reasoning effort/);
    assert.equal(validateRoutedEffort(route,undefined),undefined);
  }
});

test("actual effort CLI rejects without writing, accepts supported values and clears only its override", () => {
  const state = mkdtempSync(path.join(os.tmpdir(),"router-effort-cli-"));
  const settingsPath = path.join(state,"settings.json");
  const initial = {version:2,mode:"selected",enabled:[slug],disabled:[],efforts:{"openrouter/pareto":"none"}};
  writeFileSync(settingsPath,JSON.stringify(initial));
  const execute = effort => spawnSync(process.execPath,["src/control.mjs","subagents","effort",slug,...(effort===undefined?[]:[effort])],{
    encoding:"utf8",windowsHide:true,env:{...process.env,CODEX_HOME:state,MODEL_ROUTER_STATE_DIR:state,MODEL_ROUTER_MULTI_AGENT_STATE:settingsPath},
  });
  try {
    const invalid = execute("unsupported");
    assert.equal(invalid.status,1); assert.match(invalid.stderr,/Unsupported reasoning effort/);
    assert.equal(readFileSync(settingsPath,"utf8"),JSON.stringify(initial));
    for(const level of MODEL_BY_SLUG.get(slug).reasoningLevels) {
      const accepted = execute(level.effort); assert.equal(accepted.status,0,accepted.stderr);
      assert.deepEqual(JSON.parse(readFileSync(settingsPath,"utf8")),{...initial,efforts:{...initial.efforts,[slug]:level.effort}});
    }
    const cleared = execute(); assert.equal(cleared.status,0,cleared.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath,"utf8")),initial);
  } finally {rmSync(state,{recursive:true,force:true});}
});

test("Router diagnoses a persisted invalid child effort before its provider hop", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(),"router-effort-wire-"));
  const settingsPath = path.join(state,"settings.json"), captured = [];
  const writeEffort = effort => writeFileSync(settingsPath,JSON.stringify({version:2,mode:"proven",enabled:[],disabled:[],efforts:{[slug]:effort}}));
  writeEffort("unsupported");
  const hop = http.createServer(async(request,response)=>{
    const chunks=[]; for await(const chunk of request) chunks.push(chunk);
    captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200,{"Content-Type":"application/json"});
    response.end(JSON.stringify({id:"synthetic-effort-response",object:"response",status:"completed",output:[{id:"synthetic-message",type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}]}));
  });
  await new Promise(resolve=>hop.listen(0,"127.0.0.1",resolve));
  const port = await openPort(), caller = "test-router-caller-capability-with-sufficient-length";
  const router = launch("router.mjs",{
    CODEX_HOME:state,MODEL_ROUTER_STATE_DIR:state,MODEL_ROUTER_MULTI_AGENT_STATE:settingsPath,
    CODEX_ROUTER_PORT:String(port),CODEX_ROUTER_CALLER_KEY:caller,
    CODEX_ROUTER_INTERNAL_KEY:"test-internal-service-key-with-sufficient-length",
    CODEX_ROUTER_SHOW_ALL_MODELS:"1",CODEX_ROUTER_QUIET:"1",
    CODEX_ROUTER_GATEWAY_BASE_URL:`http://127.0.0.1:${hop.address().port}/v1`,
  });
  const base = callerBaseUrl(port,caller);
  const request = () => fetch(`${base}/responses`,{method:"POST",headers:{"Content-Type":"application/json","x-openai-subagent":"1"},body:JSON.stringify({model:slug,input:"Synthetic effort check",stream:false})});
  try {
    await ready(`${base}/models`,router);
    for(const effort of ["unsupported",42]) {
      writeEffort(effort); const response = await request(), body = await response.json();
      assert.equal(response.status,400,JSON.stringify(body));
      assert.equal(body.error.code,"unsupported_reasoning_effort");
      assert.match(body.error.message,/configured subagent reasoning effort/);
      assert.equal(captured.length,0);
    }
    writeEffort("high"); const response = await request(); await response.arrayBuffer();
    assert.equal(response.status,200); assert.equal(captured.length,1);
    assert.equal(captured[0].reasoning.effort,"high");
    writeEffort(undefined); const cleared = await request(); await cleared.arrayBuffer();
    assert.equal(cleared.status,200); assert.equal(captured.length,2);
    assert.equal(captured[1].reasoning.effort,MODEL_BY_SLUG.get(slug).defaultEffort);
  } finally {
    await stop(router); await new Promise(resolve=>hop.close(resolve)); rmSync(state,{recursive:true,force:true});
  }
});
