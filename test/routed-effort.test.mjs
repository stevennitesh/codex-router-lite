import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { CHECKED_IN_MODELS, MODEL_BY_SLUG, OPENROUTER_MODELS, validateRoutedEffort } from "../src/routed-models.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { clampModelEfforts, codexEffortVocabulary } from "../src/catalog.mjs";
import { prepareOpenRouterEndpointRequest } from "../src/openrouter-endpoint-compat.mjs";
import { prepareOpenRouterRequest } from "../src/openrouter-request.mjs";
import { prepareRoutedRequest } from "../src/routed-request.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, stop, responseJson } from "./router-fixture.mjs";

const slug = "openrouter/glm-5.3-flash-streamlake";
const reasoningRoutes = OPENROUTER_MODELS.filter(route => route.requestProfile !== "pareto");
const effectiveEffort = payload => payload.reasoning !== undefined ? payload.reasoning?.effort
  : payload.reasoning_effort && typeof payload.reasoning_effort === "object" ? payload.reasoning_effort.effort : payload.reasoning_effort;

test("legacy and modern catalog choices and role defaults round trip to exact canonical endpoint efforts", () => {
  const originalRoutes = structuredClone(reasoningRoutes);
  for (const [version, top] of [["0.142.5", "xhigh"], ["0.143.0-alpha.1", "xhigh"],
    [undefined, "xhigh"], ["unknown", "xhigh"], ["0.143.0", "max"], ["0.144.0-beta.1", "max"], ["1.0.0", "max"]]) {
    for (const route of reasoningRoutes) {
      const [projected] = clampModelEfforts([route], codexEffortVocabulary(version));
      assert.deepEqual(projected.reasoningLevels.map(level => level.effort), ["low", "high", top]);
      assert.equal(projected.defaultEffort, route.defaultEffort === "max" ? top : "high");
      if (top === "max") assert.equal(projected, route);
      const roleEffort = JSON.parse(/^model_reasoning_effort = (.+)$/mu.exec(routedAgentDefinition(projected).contents)[1]);
      assert.equal(roleEffort, projected.defaultEffort);
      for (const effort of [...projected.reasoningLevels.map(level => level.effort), roleEffort]) {
        const expected = effort === "xhigh" ? "max" : effort;
        assert.equal(validateRoutedEffort(route, effort), expected);
        const shapes = [{reasoning: {effort, summary: "auto", budget_tokens: 1000}},
          {reasoning: {effort, summary: "auto", budget_tokens: 1000}, reasoning_effort: "medium"},
          {reasoning_effort: effort}, {reasoning_effort: {effort, summary: "auto", budget_tokens: 1000}}];
        for (const shape of shapes) {
          const input = {model: route.slug, input: "Synthetic catalog round trip", ...shape}, saved = structuredClone(input);
          const options = [{}, {compaction: true}, ...(route.searchTool ? [{hosted: true}] : [])];
          for (const option of options) {
            const request = option.hosted ? {...input, tools: [{type: "web_search"}]} : input;
            const prepared = prepareRoutedRequest(request, route, option);
            const sent = prepareOpenRouterRequest(prepared.payload);
            assert.equal(effectiveEffort(prepared.payload), expected);
            assert.equal(effectiveEffort(sent), expected);
            if (shape.reasoning) assert.equal(Object.hasOwn(sent, "reasoning_effort"), false);
            assert.deepEqual(prepareOpenRouterEndpointRequest(prepared.payload, route), prepared.payload);
            assert.deepEqual(prepareOpenRouterEndpointRequest(sent, route), sent);
            if (shape.reasoning || typeof shape.reasoning_effort === "object") {
              assert.equal((sent.reasoning || sent.reasoning_effort).summary, "auto");
              assert.equal((sent.reasoning || sent.reasoning_effort).budget_tokens, 1000);
            }
          }
          for (const content of [{input: "Synthetic direct final call"}, {messages: []}]) {
            assert.equal(effectiveEffort(prepareOpenRouterRequest({...input, ...content})), expected);
          }
          assert.deepEqual(input, saved);
        }
      }
    }
  }
  assert.deepEqual(reasoningRoutes, originalRoutes);
});

test("legacy aliases require a unique canonical max on the exact registered reasoning route", () => {
  for (const route of reasoningRoutes) {
    const missing = {...route, reasoningLevels: route.reasoningLevels.filter(level => level.effort !== "max")};
    assert.throws(() => validateRoutedEffort(missing, "xhigh"), /Unsupported reasoning effort/);
    assert.throws(() => prepareOpenRouterEndpointRequest({reasoning: {effort: "xhigh"}}, missing),
      error => error.code === "unsupported_reasoning_effort");
    for (const extra of ["xhigh", "ultra"]) {
      const ambiguous = {...route, reasoningLevels: [...route.reasoningLevels, {effort: extra}]};
      assert.throws(() => clampModelEfforts([ambiguous], codexEffortVocabulary("0.142.5")), /ambiguous.*effort/i);
      if (extra === "ultra") {
        assert.throws(() => validateRoutedEffort(ambiguous, "xhigh"), /Unsupported reasoning effort/);
        assert.throws(() => prepareOpenRouterEndpointRequest({reasoning_effort: "xhigh"}, ambiguous),
          error => error.code === "unsupported_reasoning_effort");
      } else assert.equal(validateRoutedEffort(ambiguous, "xhigh"), "xhigh");
    }
    const genuine = {...route, reasoningLevels: [{effort: "xhigh"}]};
    assert.equal(validateRoutedEffort(genuine, "xhigh"), "xhigh");
    assert.equal(prepareOpenRouterEndpointRequest({reasoning_effort: "xhigh"}, genuine).reasoning_effort, "xhigh");
    for (const unrelated of [{...route, slug: "openrouter/synthetic"}, {...route, requestProfile: "synthetic"}]) {
      assert.throws(() => validateRoutedEffort(unrelated, "xhigh"), /Unsupported reasoning effort/);
    }
  }
  assert.equal(validateRoutedEffort(MODEL_BY_SLUG.get("switchyard/auto"), "xhigh"), "xhigh");
  assert.throws(() => validateRoutedEffort(MODEL_BY_SLUG.get("openrouter/pareto"), "xhigh"), /Unsupported reasoning effort/);
});

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
    const legacy = execute("xhigh"); assert.equal(legacy.status,0,legacy.stderr);
    assert.equal(JSON.parse(readFileSync(settingsPath,"utf8")).efforts[slug],"max");
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
    writeEffort("xhigh"); const aliased = await request(); await aliased.arrayBuffer();
    assert.equal(aliased.status,200); assert.equal(captured.length,1);
    assert.equal(captured[0].reasoning.effort,"max");
    writeEffort("high"); const response = await request(); await response.arrayBuffer();
    assert.equal(response.status,200); assert.equal(captured.length,2);
    assert.equal(captured[1].reasoning.effort,"high");
    writeEffort(undefined); const cleared = await request(); await cleared.arrayBuffer();
    assert.equal(cleared.status,200); assert.equal(captured.length,3);
    assert.equal(captured[2].reasoning.effort,MODEL_BY_SLUG.get(slug).defaultEffort);
  } finally {
    await stop(router); await new Promise(resolve=>hop.close(resolve)); rmSync(state,{recursive:true,force:true});
  }
});

test("ordinary Router and internal forwarder reject unsupported route settings before dispatch", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "router-settings-wire-"));
  const captured = [];
  const provider = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    responseJson(response, {id: "synthetic-settings-response", object: "response", status: "completed", output: [
      {id: "synthetic-settings-message", type: "message", role: "assistant", content: [{type: "output_text", text: "ok"}]},
    ]});
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const [routerPort, apiPort] = await Promise.all([openPort(), openPort()]);
  const caller = "synthetic-settings-caller-capability-with-sufficient-length";
  const internal = "synthetic-settings-internal-capability-with-sufficient-length";
  const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;
  const env = {CODEX_HOME: state, MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_PORT: String(apiPort), CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1", OPENROUTER_API_KEY: "synthetic-provider-key",
    OPENROUTER_API_BASE_URL: providerBase, CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_GATEWAY_BASE_URL: providerBase};
  const api = launch("api-forwarder.mjs", env), router = launch("router.mjs", env);
  const base = callerBaseUrl(routerPort, caller);
  const post = (url, payload, headers = {}) => fetch(url, {method: "POST", headers: {"Content-Type": "application/json", ...headers},
    body: JSON.stringify(payload)});
  try {
    await ready(`http://127.0.0.1:${apiPort}/health`, api, {Authorization: `Bearer ${internal}`});
    await ready(`${base}/models`, router);
    for (const route of OPENROUTER_MODELS) {
      const body = {model: route.slug, input: "Synthetic settings validation", stream: false};
      const invalids = [{payload: {...body, max_output_tokens: route.maxOutputTokens + 1}, code: "unsupported_output_limit"},
        ...(route.requestProfile === "pareto" ? [] : [{payload: {...body, reasoning: {effort: "medium"}}, code: "unsupported_reasoning_effort"}])];
      for (const {payload, code} of invalids) {
        for (const [url, headers] of [[`${base}/responses`, {}],
          [`http://127.0.0.1:${apiPort}/v1/responses`, {Authorization: `Bearer ${internal}`} ]]) {
          const rejected = await post(url, payload, headers), result = await rejected.json();
          assert.equal(rejected.status, 400, JSON.stringify(result));
          assert.equal(result.error.code, code);
          assert.equal(captured.length, 0, "invalid settings must not reach any provider");
        }
      }
    }
    for (const route of OPENROUTER_MODELS) {
      const response = await post(`${base}/responses`, {model: route.slug, input: "Synthetic supported settings", stream: false,
        max_output_tokens: 2048, ...(route.requestProfile === "pareto" ? {} : {reasoning: {effort: "low"}})});
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal(captured.length, OPENROUTER_MODELS.length);
    for (const payload of captured) {
      assert.equal(payload.max_output_tokens, 2048);
      if (payload.model !== "unbiased/pareto") assert.equal(payload.reasoning.effort, "low");
    }
    for (const route of OPENROUTER_MODELS.filter(route => route.requestProfile === "deepseek-v4.1-flash")) {
      for (const [url, headers] of [[`${base}/responses`, {}],
        [`http://127.0.0.1:${apiPort}/v1/responses`, {Authorization: `Bearer ${internal}`}]]) {
        for (const reasoning of [{effort: "low"}, {}]) {
          const prior = captured.length;
          const response = await post(url, {model: route.slug, input: "Synthetic conflicting reasoning settings",
            stream: false, max_output_tokens: 2048, reasoning, reasoning_effort: "medium"}, headers);
          assert.equal(response.status, 200, await response.text());
          assert.equal(captured.length, prior + 1);
          assert.deepEqual(captured.at(-1).reasoning, reasoning);
          assert.equal(Object.hasOwn(captured.at(-1), "reasoning_effort"), false);
          assert.deepEqual(captured.at(-1).provider, route.openRouterProviderPolicy);
        }
      }
    }
  } finally {
    await Promise.all([stop(router), stop(api)]);
    await new Promise(resolve => provider.close(resolve));
    rmSync(state, {recursive: true, force: true});
  }
});
