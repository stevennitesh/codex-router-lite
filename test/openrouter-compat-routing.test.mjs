import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { SseFrameBuffer, sseFrameFields } from "../src/sse-framing.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";

test("actual Router guards zero-usage edits and preserves produced history evidence", async () => {
  const tools=[{type:"namespace",name:"mcp__fixture",tools:[{type:"function",name:"inspect",parameters:{type:"object"}}]}];
  const call={type:"function_call",id:"fc",call_id:"c",name:"mcp__fixture__inspect",arguments:'{"value":18446744073709551615}'};
  const msg={type:"message",role:"assistant",id:"msg",content:[{type:"output_text",text:"OK"}]};
  const payload={status:"completed",output:[call,msg],usage:{input_tokens:0,output_tokens:3,total_tokens:3}};
  const encode=e=>`data: ${JSON.stringify(e)}\n\n`;
  let mode="safe";
  const captured=[],sockets=new Set();
  const hop=http.createServer(async(req,res)=>{
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    captured.push(JSON.parse(Buffer.concat(chunks)));
    if (mode==="compact") {
      const summary={objective:"Continue",requirement_refs:["U001"],attempt_refs:["C001"],observation_refs:["R001"],unverified:[],unknowns:[],blockers:[],next_step:"Continue"};
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({status:"completed",output:[{...msg,content:[{type:"output_text",text:JSON.stringify(summary)}]}]})); return;
    }
    if (mode.startsWith("phase-") || mode==="multiline" || mode==="unsafe-after-edit") {
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const terminal={type:"response.completed",response:{...payload,status:mode==="phase-status"?"incomplete":"completed"}};
      if (mode==="multiline") res.end('data: '+JSON.stringify(terminal,null,2).split('\n').join('\ndata: ')+'\n\n');
      else if (mode==="unsafe-after-edit") res.end(encode({type:"response.in_progress",response:{usage:{input_tokens:0,output_tokens:1}}})+'data: {"type":"response.completed","type":"response.completed"}\n\n');
      else res.end(encode({type:"response.output_text.delta",item_id:"msg",delta:"OK"})+encode({type:"response.output_item.done",item:msg})
        +(mode==="phase-eof"?'data: '+JSON.stringify(terminal):encode(terminal)));
      return;
    }
    let raw=JSON.stringify(mode==="partial"?{...payload,usage:{input_tokens:12}}:payload);
    if (mode==="duplicate") raw=raw.replace('"name":"mcp__fixture__inspect"','"name":"other","na\\u006de":"mcp__fixture__inspect"');
    if (mode==="precision") raw=raw.replace('"status":"completed"','"status":"completed","marker":0.123456789012345678901');
    res.writeHead(200,{"Content-Type":"application/json"});res.end(raw);
  });
  hop.on("connection",s=>{sockets.add(s);s.once("close",()=>sockets.delete(s));});
  await new Promise(resolve=>hop.listen(0,"127.0.0.1",resolve));
  const port=await openPort(),caller="history-regression-synthetic-caller";
  const target=`http://127.0.0.1:${hop.address().port}/v1`;
  const router=launch("router.mjs",{CODEX_ROUTER_PORT:String(port),CODEX_ROUTER_CALLER_KEY:caller,
    CODEX_ROUTER_INTERNAL_KEY:"history-regression-synthetic-internal",CODEX_ROUTER_SHOW_ALL_MODELS:"1",
    CODEX_ROUTER_GATEWAY_BASE_URL:target,CODEX_ROUTER_API_BASE_URL:target,CODEX_NATIVE_BASE_URL:target,
    CODEX_ROUTER_ZERO_INPUT_ESTIMATE:"1",CODEX_ROUTER_QUIET:"1"},{stateDirPrefix:"history-regression-"});
  const base=callerBaseUrl(port,caller);
  const post=async(extra={},suffix="responses")=>{
    const before=captured.length;
    const res=await fetch(`${base}/${suffix}`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer history-regression-synthetic-native-session"},
      body:JSON.stringify({model:"openrouter/glm-5.3-flash-streamlake",input:"x".repeat(5000),tools,stream:false,...extra}),
      signal:AbortSignal.timeout(10000)});
    const wire=await res.text();
    assert.equal(captured.length,before+1,"one inference, including error paths");
    if (mode!=="unsafe-after-edit") assert.equal(res.status,200,wire);
    return wire;
  };
  try {
    await ready(`${base}/models`,router);
    const produced=JSON.parse(await post());
    assert.ok(produced.usage.input_tokens>1000);
    assert.equal(produced.output[0].name,"inspect");
    assert.equal(produced.output[0].namespace,"mcp__fixture");
    assert.equal(produced.output[0].arguments,call.arguments);
    await post({input:[...produced.output,{type:"function_call_output",call_id:"c",output:"OBSERVED"},{role:"user",content:"Continue"}]});
    const replay=captured.at(-1).input;
    assert.equal(replay.find(i=>i.type==="function_call").name,call.name);
    assert.equal(replay.find(i=>i.type==="function_call").arguments,call.arguments);
    assert.equal(replay.find(i=>i.type==="function_call_output").output,"OBSERVED");
    for (mode of ["duplicate","precision"]) {
      const wire=await post();
      assert.equal(JSON.parse(wire).output[0].name,call.name);
      if (mode==="duplicate") assert.match(wire,/"name":"other","na\\u006de":"mcp__fixture__inspect"/u);
      else assert.match(wire,/0\.123456789012345678901/u);
      assert.equal(JSON.parse(wire).usage.input_tokens,0);
    }
    mode="safe";
    const native=JSON.parse(await post({model:"gpt-6.1-sol"}));
    assert.equal(native.usage.input_tokens,0,"native routes retain provider counts");
    assert.equal(native.output[0].name,call.name,"native identity is not externally restored");
    mode="multiline";
    const wire=await post({stream:true});
    assert.match(wire,/"input_tokens":\d{4,}/u);
    mode="partial";await post();
    for (let n=0;n<50&&!router.errors().includes("out_tokens=unknown");n++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.match(router.errors(),/out_tokens=unknown/u);
    for (mode of ["phase-eof","phase-status"]) assert.ok(!(await post({stream:true})).includes('"phase":"final_answer"'));
    mode="unsafe-after-edit";
    assert.match(await post({stream:true}),/local_router_(?:stream_failed|error)/u);
    mode="compact";
    const compact=JSON.parse(await post({input:[{role:"user",content:"Keep outcome"},{type:"function_call",call_id:"command",name:"inspect",arguments:"{}"},
      {type:"function_call_output",call_id:"command",output:'{"exit_code":7,"exit_code":0}'}]},"responses/compact"));
    assert.match(compact.output.at(-1).content[0].text,/"outcome": "returned"/u);
    assert.ok(!compact.output.at(-1).content[0].text.includes('"outcome": "exit_0"'));
  } finally {
    await stop(router);for (const s of sockets) s.destroy();await new Promise(resolve=>hop.close(resolve));
  }
});

test("actual Router preserves provider evidence, repairs framing and replays produced calls", async () => {
  const search = { type: "openrouter:web_search", id: "ws", status: "completed",
    action: { type: "search", sources: [{ url: "https://example.invalid/source" }] } };
  const call = { type: "function_call", id: "fc", call_id: "call", name: "mcp__fixture__inspect",
    arguments: '{"value":18446744073709551615}' };
  const message = { type: "message", id: "msg", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [{ type: "url_citation", url: "https://example.invalid/source" }] }] };
  const tools = [{ type: "namespace", name: "mcp__fixture", tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }] }];
  const completed = { type: "response.completed", response: { id: "resp", status: "completed", output: [search, call, message] } };
  let mode;
  const captured = [], sockets = new Set();
  const encode = (event, ending = "\n") => `data: ${JSON.stringify(event)}${ending}${ending}`;
  const hop = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    captured.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (mode === "duplicate-json" || mode === "precise-json") {
      let raw = JSON.stringify(completed.response);
      raw = mode === "duplicate-json" ? raw.replace('"name":"mcp__fixture__inspect"', '"name":"other","na\\u006de":"mcp__fixture__inspect"')
        : raw.replace('"status":"completed"', '"status":"completed","marker":0.123456789012345678901');
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(raw); return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "unsafe-after-search") {
      response.end(encode({ type: "response.output_item.added", output_index: 0, item: search })
        + 'data: {"type":"response.completed","type":"response.completed"}\n\n'); return;
    }
    if (mode === "unsafe-after-glm") {
      response.end(encode({ type: "response.output_text.delta", item_id: "msg", delta: "OK" })
        + 'data: {"type":"response.output_text.delta","delta":"A","delta":"B"}\n\n'); return;
    }
    const events = mode.startsWith("glm-") ? [
      { type: "response.output_item.done", output_index: 0, item: { id: "rs", type: "reasoning" } },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg", delta: "OK" },
      { type: "response.content_part.done", output_index: 0, item_id: "msg", part: { type: "reasoning_text", reasoning: "PRIVATE" } },
      { type: "response.output_item.done", output_index: 0, item: message },
      { ...completed, response: { ...completed.response, output: [message] } },
    ] : [{ type: "response.output_item.done", output_index: 0, item: search },
      { type: "response.output_item.done", output_index: 1, item: call }, completed];
    const multiline = mode.includes("multiline");
    const ending = mode.endsWith("cr") ? "\r" : mode.endsWith("crlf") ? "\r\n" : "\n";
    const wire = events.map(event => multiline ? `event: ${event.type}\n${JSON.stringify(event, null, 2).split('\n').map(line => 'data: ' + line).join('\n')}\n\n` : encode(event, ending)).join('');
    response.end((mode === "search-bom" ? '\uFEFF' : '') + wire);
  });
  hop.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => hop.listen(0, "127.0.0.1", resolve));
  const port = await openPort(), caller = "provider-compat-synthetic-caller-key";
  const router = launch("router.mjs", { CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: caller,
    CODEX_ROUTER_INTERNAL_KEY: "provider-compat-synthetic-internal-key", CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${hop.address().port}/v1`,
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${hop.address().port}/v1`, CODEX_ROUTER_QUIET: "1" },
    { stateDirPrefix: "provider-compat-" });
  const base = callerBaseUrl(port, caller);
  const post = async (input = "synthetic") => {
    const response = await fetch(`${base}/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/glm-5.3-flash-streamlake", stream: !mode.endsWith("json"), input,
        tools: mode.startsWith("glm-") || mode === "unsafe-after-glm" ? tools : [{ type: "web_search" }, ...tools] }),
      signal: AbortSignal.timeout(10000) });
    const wire = await response.text();
    if (mode.startsWith("unsafe-")) assert.ok([200, 502].includes(response.status), `${mode}: ${wire}`);
    else assert.equal(response.status, 200, `${mode}: ${wire}`);
    return wire;
  };
  const eventsFrom = wire => [...new SseFrameBuffer().write(Buffer.from(wire))].filter(frame => !frame.continuation)
    .map(frame => sseFrameFields(frame.bytes, frame.atStreamStart)).filter(fields => fields.data && fields.data !== "[DONE]")
    .map(fields => JSON.parse(fields.data));
  try {
    await ready(`${base}/models`, router);
    for (mode of ["search-lf", "search-crlf", "search-cr", "search-multiline", "search-bom"]) {
      const events = eventsFrom(await post());
      const produced = events.find(event => event.type === "response.completed").response.output;
      assert.equal(produced[0].type, "web_search_call");
      assert.deepEqual(produced[0].action, search.action);
      assert.deepEqual(produced[2].content, message.content);
      assert.equal(produced[1].name, "inspect", mode); assert.equal(produced[1].namespace, "mcp__fixture", mode);
      assert.equal(produced[1].arguments, call.arguments);
      await post([...produced, { type: "function_call_output", call_id: "call", output: "DONE" }, { role: "user", content: "continue" }]);
      const replay = captured.at(-1).input;
      assert.equal(replay.find(item => item.id === "ws").type, "openrouter:web_search");
      assert.equal(replay.find(item => item.call_id === "call" && item.type === "function_call").arguments, call.arguments);
      assert.equal(replay.find(item => item.type === "function_call_output").output, "DONE");
    }
    for (mode of ["glm-cr", "glm-multiline"]) {
      const wire = await post(); const events = eventsFrom(wire);
      assert.equal(wire.includes("PRIVATE"), false);
      assert.equal(events.find(event => event.type === "response.output_text.delta").output_index, 1);
      assert.equal(events.filter(event => event.type === "response.output_item.added" && event.item.type === "message").length, 1);
    }
    for (mode of ["duplicate-json", "precise-json"]) {
      const wire = await post(); const output = JSON.parse(wire).output;
      assert.equal(output[0].type, "openrouter:web_search");
      assert.equal(output[1].name, "mcp__fixture__inspect");
      if (mode === "duplicate-json") assert.match(wire, /"name":"other","na\\u006de":"mcp__fixture__inspect"/u);
      else assert.match(wire, /0\.123456789012345678901/u);
    }
    for (mode of ["unsafe-after-search", "unsafe-after-glm"]) {
      const before = captured.length, wire = await post();
      assert.match(wire, /local_router_(?:stream_failed|error)/u);
      assert.equal(eventsFrom(wire).some(event => event.type === "response.completed"), false);
      assert.equal(captured.length, before + 1, "no ambiguous inference replay");
    }
  } finally {
    await stop(router);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => hop.close(resolve));
  }
});
