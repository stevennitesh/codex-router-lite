import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "undici";

import { handleResponsesWebSocketUpgrade } from "../src/responses-websocket.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";

function frame(value, rawJson = JSON.stringify(value)) {
  const body = Buffer.from(rawJson);
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.alloc(4);
  if (body.length >= 126) { header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2); }
  return Buffer.concat([header, body]);
}

async function fixture(t, { handle, httpHandle, headers = {}, nativeOptions = {}, prepare, fetchImpl, actualRouter = false, routerEnvironment = {}, switchyardTools = false } = {}) {
  const sockets = new Set();
  const requests = [];
  const handshakes = [];
  const httpHeaders = [];
  const results = [];
  const prior = new Map();
  let httpRequests = 0;
  let generation = 0;
  let router;
  let routerChild;
  let stateDirectory;
  let catalogPath;
  let routerPort;
  let peer;
  let client;
  const upstream = http.createServer(async (request, response) => {
    httpRequests += 1;
    httpHeaders.push(request.headers);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ ...payload, fixtureTransport: "http" });
    if (httpHandle) { await httpHandle({ request, response, payload }); return; }
    response.writeHead(200, { "content-type": "application/json" });
    const output = switchyardTools && payload.model === "switchyard-auto"
      ? [{ type: "function_call", id: "fc_switchyard", call_id: "call_switchyard", name: "fixture_tool", arguments: "{}" }]
      : [{ id: "msg_http_real", type: "message", role: "assistant", content: [{ type: "output_text", text: "42" }] }];
    response.end(JSON.stringify({ id: "resp_http_real", status: "completed", output, usage: { input_tokens: 7, output_tokens: 2 } }));
  });
  upstream.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    handshakes.push(request.headers);
    if (nativeOptions.rejectHandshake) {
      socket.end(`HTTP/1.1 ${nativeOptions.rejectHandshake} Rejected\r\nConnection: close\r\nretry-after: 2\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nx-codex-turn-state: fixture-state\r\nx-codex-primary-used-percent: 12\r\nx-codex-primary-window-minutes: 300\r\nx-codex-primary-reset-at: 1791420000\r\n\r\n`);
    let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 2) {
        const opcode = bytes[0] & 15;
        let length = bytes[1] & 127;
        let offset = 2;
        if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (bytes.length < 10) return; length = Number(bytes.readBigUInt64BE(2)); offset = 10; }
        if (bytes.length < offset + 4 + length) return;
        const mask = bytes.subarray(offset, offset + 4);
        const body = Buffer.from(bytes.subarray(offset + 4, offset + 4 + length));
        bytes = bytes.subarray(offset + 4 + length);
        for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index & 3];
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 1) continue;
        const payload = JSON.parse(body.toString("utf8"));
        requests.push(payload);
        const send = value => socket.write(frame(value));
        const id = `resp_native_fixture_${++generation}`;
        const complete = output => {
          prior.set(id, { input: payload.input, output });
          for (const [index, item] of output.entries()) send({ type: "response.output_item.done", output_index: index, item });
          send({ type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 7, output_tokens: 2 } } });
        };
        if (handle) handle({ payload, send, sendRaw: rawJson => socket.write(frame(undefined, rawJson)), complete, socket, id, prior });
        else complete([]);
      }
    });
  });
  t.after(async () => {
    client?.close();
    peer?.forceClose();
    if (routerChild) await stop(routerChild);
    for (const socket of sockets) socket.destroy();
    await Promise.all([upstream, router].filter(Boolean).map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    if (stateDirectory) rmSync(stateDirectory, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  let admit = true;
  if (actualRouter) {
    stateDirectory = mkdtempSync(path.join(os.tmpdir(), "router-native-ws-"));
    const codexHome = path.join(stateDirectory, "codex");
    mkdirSync(codexHome);
    catalogPath = path.join(stateDirectory, "native-models.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", supported_reasoning_levels: ["medium", "high"] }] }));
    if (switchyardTools) {
      const runtime = path.join(stateDirectory, "switchyard");
      mkdirSync(runtime);
      writeFileSync(path.join(runtime, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
      writeFileSync(path.join(runtime, "routes.toml"), "# fixture\n");
      writeFileSync(path.join(stateDirectory, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["switchyard"] }));
    }
    routerPort = await openPort();
    routerChild = launch("router.mjs", {
      CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: stateDirectory,
      CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_CALLER_KEY: "native-ws-fixture-caller-capability-long-enough",
      CODEX_ROUTER_INTERNAL_KEY: "fixture-internal-capability-long-enough",
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      CODEX_ROUTER_CATALOG: catalogPath, CODEX_ROUTER_QUIET: "1",
      ...(switchyardTools ? {
        CODEX_ROUTER_SWITCHYARD_ROOT: path.join(stateDirectory, "switchyard"),
        CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
        CODEX_ROUTER_SWITCHYARD_CAPABILITY: "fixture-switchyard-capability",
      } : {}),
      ...routerEnvironment,
    });
    await ready(`http://127.0.0.1:${routerPort}/live`, routerChild);
  } else {
  router = http.createServer((_request, response) => response.end());
  router.on("upgrade", (request, socket, head) => handleResponsesWebSocketUpgrade(request, socket, head, {
    callerKey: "fixture-capability-long-enough",
    authenticateUpgrade: () => "/v1/responses",
    responsesUrl: "http://unused-http-owner/responses",
    admitRequest: () => { if (!admit) throw new Error("draining"); },
    onPeer: value => { peer = value; },
    maxEventBytes: nativeOptions.maxEventBytes || 1024 * 1024,
    ...(nativeOptions.maxMessageBytes ? { maxMessageBytes: nativeOptions.maxMessageBytes } : {}),
    maxContinuationBytes: nativeOptions.maxContinuationBytes || 1024 * 1024,
    prepareNativeRequest: async arguments_ => {
      if (prepare && !prepare(arguments_)) return undefined;
      if (!arguments_.payload.model?.startsWith("gpt-")) return undefined;
      return {
        target: `http://127.0.0.1:${upstream.address().port}/responses`,
        headers: arguments_.request.headers,
        payload: arguments_.payload,
        rebuildPayload: input => ({ ...arguments_.payload, input }),
        finish: result => results.push(result),
      };
    },
    fetchImpl: async (...args) => {
      httpRequests += 1;
      if (fetchImpl) return fetchImpl(...args);
      return new Response(JSON.stringify({ id: "resp_http", status: "completed", output: [] }), { headers: { "content-type": "application/json" } });
    },
  }));
  await new Promise(resolve => router.listen(0, "127.0.0.1", resolve));
  routerPort = router.address().port;
  }
  const clientUrl = actualRouter
    ? `${callerBaseUrl(routerPort, "native-ws-fixture-caller-capability-long-enough").replace("http:", "ws:")}/responses`
    : `ws://127.0.0.1:${routerPort}/v1/responses`;
  client = new WebSocket(clientUrl, {
    headers: { "openai-beta": "responses_websockets=2026-02-06", authorization: "Bearer native-fixture-session", "chatgpt-account-id": "account-fixture", "x-openai-internal-codex-residency": "us", ...headers },
  });
  await new Promise((resolve, reject) => { client.addEventListener("open", resolve, { once: true }); client.addEventListener("error", reject, { once: true }); });
  const exchange = async payload => {
    const events = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.removeEventListener("message", onMessage); reject(new Error("Native fixture response timed out.")); }, 3000);
      const onMessage = ({ data }) => {
        const value = JSON.parse(data);
        events.push(value);
        if (["response.completed", "response.failed", "response.incomplete", "error"].includes(value.type)) {
          client.removeEventListener("message", onMessage);
          clearTimeout(timer);
          resolve();
        }
      };
      client.addEventListener("message", onMessage);
      client.send(JSON.stringify({ type: "response.create", model: "gpt-6.1-sol", stream: true, input: [], ...payload }));
    });
    await setImmediate();
    return events;
  };
  return { requests, handshakes, httpHeaders, results, exchange, sockets, client, routerChild, catalogPath, routerPort,
    get httpRequests() { return httpRequests; }, get peer() { return peer; }, setAdmission: value => { admit = value; } };
}

test("native WebSocket passes real prewarming and tool continuation over one credential-preserving connection", async t => {
  const tool = { type: "function_call", id: "fc_native", call_id: "call_native", name: "fixture_tool", arguments: "{}" };
  const state = await fixture(t, { headers: { "x-session-id": "native-session-hint", "x-codex-routing-hint": "native-route-hint" }, handle: ({ payload, complete }) => complete(payload.generate === false ? [] : payload.previous_response_id ? [] : [tool]) });
  const clientMetadata = { thread_id: "current-thread", ws_request_header_traceparent: "current-trace" };
  const prewarm = await state.exchange({ input: [{ role: "user", content: "seed" }], generate: false, client_metadata: clientMetadata });
  assert.equal(prewarm.at(-1).response.id, "resp_native_fixture_1");
  assert.equal(state.requests[0].generate, false);
  const first = await state.exchange({ input: [{ role: "user", content: "call tool" }], client_metadata: clientMetadata });
  const produced = first.find(event => event.type === "response.output_item.done").item;
  const suffix = { type: "function_call_output", call_id: produced.call_id, output: "42" };
  const second = await state.exchange({ previous_response_id: first.at(-1).response.id, input: [suffix], client_metadata: { thread_id: "current-thread", ws_request_header_traceparent: "current-trace" } });
  assert.equal(second.at(-1).type, "response.completed");
  assert.equal(state.requests[2].previous_response_id, first.at(-1).response.id);
  assert.deepEqual(state.requests[2].input, [suffix]);
  assert.equal(state.requests[2].client_metadata.ws_request_header_traceparent, "current-trace");
  assert.equal(state.handshakes.length, 1);
  assert.equal(state.handshakes[0].authorization, "Bearer native-fixture-session");
  assert.equal(state.handshakes[0]["chatgpt-account-id"], "account-fixture");
  assert.equal(state.handshakes[0]["x-openai-internal-codex-residency"], "us");
  assert.equal(state.handshakes[0]["x-session-id"], "native-session-hint");
  assert.equal(state.handshakes[0]["x-codex-routing-hint"], "native-route-hint");
  assert.equal(state.httpRequests, 0);
  assert.equal(state.results.length, 3);
  assert.ok(state.results.every(result => result.status === 200));
  assert.ok(prewarm.some(event => event.type === "codex.rate_limits"));
});

test("actual Router retires switched Switchyard workflows through native WebSocket completion", async t => {
  let mode = "answer";
  const nextTool = { type: "function_call", id: "fc_native_next", call_id: "call_native_next", name: "fixture_tool", arguments: "{}" };
  const state = await fixture(t, {
    actualRouter: true, switchyardTools: true,
    headers: { "session-id": "old-cache", "thread-id": "old-thread" },
    handle: ({ send, complete, id }) => {
      if (mode === "failed" || mode === "incomplete") {
        send({ type: `response.${mode}`, response: { id, status: mode, output: [] } });
      } else {
        if (mode === "next-tool") send({ type: "response.output_item.done", output_index: 0, item: nextTool });
        // The done event is authoritative even when the completed array omits it.
        complete([]);
      }
    },
  });
  const lifecycle = async (action, body) => {
    const response = await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET", headers: { authorization: "Bearer fixture-internal-capability-long-enough", "content-type": "application/json" },
      ...(action ? { body: JSON.stringify(body || {}) } : {}),
    });
    return { status: response.status, ...await response.json() };
  };
  const metadata = { thread_id: "workflow-thread", session_id: "workflow-session" };
  const first = await state.exchange({ model: "switchyard/auto", input: [{ role: "user", content: "use a tool" }], client_metadata: metadata });
  assert.equal(first.at(-1).type, "response.completed");
  const produced = first.at(-1).response.output.find(item => item.type === "function_call");
  assert.ok(produced);
  const result = { type: "function_call_output", call_id: produced.call_id, output: "done" };
  assert.equal((await lifecycle()).workflowCalls, 1);
  assert.equal((await lifecycle("drain")).status, "deferred");
  for (const [input, client_metadata, nextMode] of [
    [[produced, result], { thread_id: "unrelated-thread" }, "answer"],
    [[{ ...result, call_id: "wrong-call" }], metadata, "answer"],
    [[produced, result], metadata, "failed"],
    [[produced, result], metadata, "incomplete"],
  ]) {
    mode = nextMode;
    const events = await state.exchange({ input, client_metadata });
    assert.equal(events.at(-1).type, nextMode === "answer" ? "response.completed" : `response.${nextMode}`);
    assert.equal((await lifecycle()).workflowCalls, 1);
    assert.equal((await lifecycle("drain")).status, "deferred");
  }
  mode = "next-tool";
  const next = await state.exchange({ input: [produced, result], client_metadata: metadata });
  assert.deepEqual(next.find(event => event.type === "response.output_item.done").item, nextTool);
  assert.equal((await lifecycle()).workflowCalls, 1);
  assert.equal((await lifecycle("drain")).status, "deferred");
  mode = "answer";
  await state.exchange({ previous_response_id: next.at(-1).response.id, input: [{ type: "function_call_output", call_id: nextTool.call_id, output: "done" }], client_metadata: metadata });
  assert.equal((await lifecycle()).workflowCalls, 0);
  assert.equal((await lifecycle()).indeterminateWorkflow, false);
  assert.equal((await lifecycle("drain")).status, "drained");
});

test("canceled native WebSocket consumption leaves the Switchyard workflow pending", async t => {
  const state = await fixture(t, { actualRouter: true, switchyardTools: true, handle: () => {} });
  const metadata = { thread_id: "canceled-workflow" };
  const first = await state.exchange({ model: "switchyard/auto", input: [{ role: "user", content: "use tool" }], client_metadata: metadata });
  const produced = first.at(-1).response.output.find(item => item.type === "function_call");
  assert.ok(produced);
  const status = async () => (await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle`, {
    headers: { authorization: "Bearer fixture-internal-capability-long-enough" },
  })).json();
  state.client.send(JSON.stringify({ type: "response.create", model: "gpt-6.1-sol", stream: true,
    input: [produced, { type: "function_call_output", call_id: produced.call_id, output: "done" }], client_metadata: metadata }));
  for (let attempt = 0; state.requests.length < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.requests.length, 2);
  assert.equal((await status()).activeRequests, 1);
  state.client.close();
  for (let attempt = 0; (await status()).activeRequests && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await status()).activeRequests, 0);
  assert.equal((await status()).workflowCalls, 1);
  const drain = await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle/drain`, {
    method: "POST", headers: { authorization: "Bearer fixture-internal-capability-long-enough", "content-type": "application/json" }, body: "{}",
  });
  assert.equal(drain.status, 409);
});

test("completed Switchyard SSE turns retire tools after the WebSocket adapter closes the HTTP body", async t => {
  const tool = { type:"function_call", id:"fc_switchyard", call_id:"call_switchyard", name:"fixture_tool", arguments:"{}" };
  const state = await fixture(t, { actualRouter:true, switchyardTools:true, httpHandle:({response,payload}) => {
    const output = payload.input.some(item => item.type === "function_call_output")
      ? [{type:"message",role:"assistant",content:[{type:"output_text",text:"done"}]}] : [tool];
    response.writeHead(200,{"content-type":"text/event-stream"});
    for (const item of output) response.write(`data: ${JSON.stringify({type:"response.output_item.done",item})}\n\n`);
    response.write(`data: ${JSON.stringify({type:"response.completed",response:{id:"resp_switchyard",status:"completed",output}})}\n\n`);
    // Keep the upstream body open: the adapter must close it at the terminal.
  }});
  const lifecycle = async () => (await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle`,{
    headers:{authorization:"Bearer fixture-internal-capability-long-enough"},
  })).json();
  const settled = async () => {
    let observed;
    const deadline = Date.now()+3000;
    do {
      observed = await lifecycle();
      if (observed.activeRequests === 0) return observed;
      await new Promise(resolve => setTimeout(resolve,10));
    } while (Date.now()<deadline);
    assert.equal(observed.activeRequests,0);
  };
  const client_metadata = {thread_id:"terminal-close-workflow"};
  const first = await state.exchange({model:"switchyard/auto",client_metadata});
  assert.equal(first.at(-1).type,"response.completed");
  const pending = await settled();
  assert.equal(pending.indeterminateWorkflow,false);
  assert.equal(pending.workflowCalls,1);
  const second = await state.exchange({model:"switchyard/auto",client_metadata,
    input:[tool,{type:"function_call_output",call_id:tool.call_id,output:"done"}]});
  assert.equal(second.at(-1).type,"response.completed");
  const completed = await settled();
  assert.equal(completed.indeterminateWorkflow,false);
  assert.equal(completed.workflowCalls,0);
  const drain = await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle/drain`,{
    method:"POST",headers:{authorization:"Bearer fixture-internal-capability-long-enough","content-type":"application/json"},body:"{}",
  });
  assert.equal((await drain.json()).status,"drained");
});

test("an unfinished Switchyard SSE turn still blocks drain after the client closes", async t => {
  const state = await fixture(t,{actualRouter:true,switchyardTools:true,httpHandle:({response}) => {
    response.writeHead(200,{"content-type":"text/event-stream"});
    response.write(`data: ${JSON.stringify({type:"response.output_item.done",item:{type:"function_call",call_id:"partial-call",name:"fixture_tool",arguments:"{}"}})}\n\n`);
  }});
  const seen = new Promise(resolve => state.client.addEventListener("message",({data}) => {
    if (JSON.parse(data).type === "response.output_item.done") resolve();
  }));
  state.client.send(JSON.stringify({type:"response.create",model:"switchyard/auto",stream:true,input:[],client_metadata:{thread_id:"partial-switchyard-workflow"}}));
  await seen;
  state.client.close();
  const lifecycle = async () => (await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle`,{
    headers:{authorization:"Bearer fixture-internal-capability-long-enough"},
  })).json();
  let status;
  const deadline = Date.now()+3000;
  do {
    status = await lifecycle();
    if (!status.activeRequests) break;
    await new Promise(resolve => setTimeout(resolve,10));
  } while(Date.now()<deadline);
  assert.equal(status.activeRequests,0);
  assert.equal(status.indeterminateWorkflow,true);
  const drain = await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle/drain`,{
    method:"POST",headers:{authorization:"Bearer fixture-internal-capability-long-enough","content-type":"application/json"},body:"{}",
  });
  assert.equal(drain.status,409);
  assert.equal((await drain.json()).reason,"switchyard-workflow-indeterminate");
});

test("native validated events preserve raw Unicode, escapes and unknown fields over the actual socket", async t => {
  const tool = { type: "function_call", id: "fc_raw", call_id: "call_raw", name: "fixture_tool", arguments: '{"text":"漢🙂"}' };
  let firstRaw;
  const state = await fixture(t, { handle: ({ payload, sendRaw, complete, id }) => {
    if (payload.previous_response_id) { complete([]); return; }
    sendRaw(`{ "type": "response.output_item.done", "output_index": 0, "item": ${JSON.stringify(tool)}, "fixture_unknown": 1e2 }`);
    firstRaw = `{ "type" : "response.completed", "response": {"id":${JSON.stringify(id)},"status":"completed","output":[${JSON.stringify(tool)}],"fixture":"漢\\uD83D\\uDE42"}, "fixture_unknown": true }`;
    sendRaw(firstRaw);
  } });
  const rawEvents = [];
  state.client.addEventListener("message", event => rawEvents.push(String(event.data)));
  const first = await state.exchange({ input: [{ role: "user", content: '漢🙂\\\n"' }] });
  assert.equal(rawEvents.find(raw => JSON.parse(raw).type === "response.completed"), firstRaw);
  const produced = first.find(event => event.type === "response.output_item.done").item;
  assert.deepEqual(produced, tool);
  const suffix = { type: "function_call_output", call_id: produced.call_id, output: 'result 漢🙂\\\n"' };
  const next = await state.exchange({ previous_response_id: first.at(-1).response.id, input: [suffix] });
  assert.equal(next.at(-1).type, "response.completed");
  assert.deepEqual(state.requests[1].input, [suffix]);
  assert.equal(state.requests[1].previous_response_id, first.at(-1).response.id);
});

test("native raw JSON still rejects malformed events and invalid completions without creating a baseline", async t => {
  for (const raw of ['{malformed}', '{"type":"response.completed","response":{"status":"completed","output":[]}}']) {
    const state = await fixture(t, { handle: ({ sendRaw }) => sendRaw(raw) });
    const first = await state.exchange({});
    assert.equal(first.at(-1).type, "error");
    assert.equal(first.filter(event => event.type === "response.completed").length, 0);
    const next = await state.exchange({ previous_response_id: "resp_unproduced", input: [] });
    assert.equal(next.at(-1).status, 409);
    assert.equal(state.requests.length, 1);
  }
});

test("native UTF-8 serialization keeps exact fallback bounds for initial input and produced tool output", async t => {
  const input = [{ role: "user", content: '漢🙂\\\n"' }];
  const tool = { type: "function_call", id: "fc_bytes", call_id: "call_bytes", name: "fixture_tool", arguments: "{}" };
  const bound = Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(JSON.stringify([tool])) + 32;
  for (const maxContinuationBytes of [bound, bound - 1]) {
    const state = await fixture(t, { nativeOptions: { maxContinuationBytes }, handle: ({ payload, complete }) => complete(payload.model === "gpt-6.1-sol" ? [tool] : []) });
    const first = await state.exchange({ input });
    const suffix = { type: "function_call_output", call_id: first.at(-1).response.output[0].call_id, output: '漢🙂\\\n"' };
    const next = await state.exchange({ model: "gpt-6-astra", previous_response_id: first.at(-1).response.id, input: [suffix] });
    if (maxContinuationBytes === bound) {
      assert.equal(next.at(-1).type, "response.completed");
      assert.deepEqual(state.requests[1].input, [...input, tool, suffix]);
      assert.equal(state.requests[1].previous_response_id, undefined);
    } else {
      assert.equal(next.at(-1).status, 409);
      assert.equal(state.requests.length, 1);
    }
  }
});

test("native normalized request byte bounds include envelope and UTF-8 input exactly", async t => {
  const payload = { model: "gpt-6.1-sol", stream: true, input: [{ role: "user", content: '漢🙂\\\n"' }] };
  const instructions = "漢🙂".repeat(40);
  const bound = Buffer.byteLength(JSON.stringify({ ...payload, instructions, type: "response.create" }));
  for (const maxMessageBytes of [bound, bound - 1]) {
    const state = await fixture(t, { nativeOptions: { maxMessageBytes }, prepare: ({ payload }) => {
      payload.instructions = instructions;
      return true;
    } });
    const result = await state.exchange(payload);
    if (maxMessageBytes === bound) {
      assert.equal(result.at(-1).type, "response.completed");
      assert.deepEqual(state.requests[0].input, payload.input);
      assert.equal(state.requests[0].instructions, instructions);
    } else {
      assert.equal(result.at(-1).status, 413);
      assert.equal(state.requests.length, 0);
      assert.equal(state.handshakes.length, 0);
    }
  }
});

test("native model changes start a fresh normalized full baseline without a foreign previous ID", async t => {
  const state = await fixture(t);
  const input = [{ role: "user", content: "original" }];
  const first = await state.exchange({ input });
  await state.exchange({ model: "gpt-6-astra", previous_response_id: first.at(-1).response.id, input: [{ role: "user", content: "next" }] });
  assert.equal(state.handshakes.length, 2);
  assert.equal(state.requests[1].previous_response_id, undefined);
  assert.deepEqual(state.requests[1].input, [...input, { role: "user", content: "next" }]);
});

test("a lost idle native connection reconstructs the previously produced baseline once", async t => {
  const state = await fixture(t);
  const input = [{ role: "user", content: "original" }];
  const first = await state.exchange({ input });
  const [socket] = state.sockets;
  await new Promise(resolve => { socket.once("close", resolve); socket.destroy(); });
  await new Promise(resolve => setTimeout(resolve, 20));
  await state.exchange({ previous_response_id: first.at(-1).response.id, input: [{ role: "user", content: "next" }] });
  assert.equal(state.handshakes.length, 2);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[1].previous_response_id, undefined);
  assert.deepEqual(state.requests[1].input, [...input, { role: "user", content: "next" }]);
});

test("native partial output is never replayed after transport failure", async t => {
  const state = await fixture(t, { handle: ({ send, socket }) => {
    send({ type: "response.output_text.delta", delta: "partial" });
    setTimeout(() => socket.destroy(), 10);
  } });
  const events = await state.exchange({});
  assert.deepEqual(events.filter(event => event.type !== "response.metadata" && event.type !== "codex.rate_limits").map(event => event.type), ["response.output_text.delta", "error"]);
  assert.equal(state.requests.length, 1);
  assert.equal(state.httpRequests, 0);
});

for (const status of [401, 429, 426]) {
  test(`native handshake ${status} preserves failure policy before a billable frame`, async t => {
    const state = await fixture(t, { nativeOptions: { rejectHandshake: status } });
    const events = await state.exchange({});
    assert.equal(state.requests.length, 0);
    assert.equal(state.httpRequests, status === 426 ? 1 : 0);
    if (status !== 426) {
      assert.equal(events.at(-1).status, status);
      assert.equal(events.at(-1).headers["retry-after"], "2");
    } else assert.equal(events.at(-1).type, "response.completed");
  });
}

test("external model switches preserve produced native history through the existing HTTP path", async t => {
  let body;
  const output = [{ id: "msg_native", type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }];
  const state = await fixture(t, { handle: ({ complete }) => complete(output), fetchImpl: async (_url, init) => {
    body = JSON.parse(Buffer.from(init.body).toString("utf8"));
    return new Response(JSON.stringify({ id: "resp_external", status: "completed", output: [] }), { headers: { "content-type": "application/json" } });
  } });
  const input = [{ role: "user", content: "original" }];
  const first = await state.exchange({ input });
  await state.exchange({ model: "openrouter/pareto", previous_response_id: first.at(-1).response.id, input: [{ role: "user", content: "next" }] });
  assert.deepEqual(body.input, [...input, ...output, { role: "user", content: "next" }]);
  assert.equal(state.httpRequests, 1);
  assert.equal(state.requests.length, 1);
});

test("native stream cancellation destroys its upstream and admission rejects the next frame", async t => {
  let sent;
  const begun = new Promise(resolve => { sent = resolve; });
  const state = await fixture(t, { handle: ({ socket }) => sent(socket) });
  const rejected = await (async () => { state.setAdmission(false); return state.exchange({}); })();
  assert.equal(rejected[0].status, 503);
  assert.equal(state.handshakes.length, 0);
  state.setAdmission(true);
  state.client.send(JSON.stringify({ type: "response.create", model: "gpt-6.1-sol", stream: true, input: [] }));
  const socket = await begun;
  const closed = new Promise(resolve => socket.once("close", resolve));
  state.peer.forceClose();
  await closed;
  await setImmediate();
  assert.equal(state.results.at(-1).outcome, "canceled");
});

test("native oversized events fail without creating a continuation or retry", async t => {
  const state = await fixture(t, { nativeOptions: { maxEventBytes: 256 }, handle: ({ send }) => send({ type: "response.output_text.delta", delta: "x".repeat(400) }) });
  const first = await state.exchange({});
  assert.equal(first.at(-1).type, "error");
  assert.equal(state.requests.length, 1);
  const second = await state.exchange({ previous_response_id: "resp_invented" });
  assert.equal(second.at(-1).status, 409);
  assert.equal(state.requests.length, 1);
});

test("native credential and session changes cannot reuse a previous account or conversation", async t => {
  const state = await fixture(t, { prepare: ({ request, payload }) => {
    if (payload.client_metadata?.fixture_new_credential) request.headers.authorization = "Bearer second-native-fixture";
    return true;
  } });
  const first = await state.exchange({ input: [{ role: "user", content: "first" }], client_metadata: { session_id: "session-one" } });
  const second = await state.exchange({ previous_response_id: first.at(-1).response.id, input: [], client_metadata: { session_id: "session-two" } });
  await state.exchange({ previous_response_id: second.at(-1).response.id, input: [], client_metadata: { session_id: "session-two", fixture_new_credential: true } });
  assert.equal(state.handshakes.length, 3);
  assert.equal(state.handshakes[2].authorization, "Bearer second-native-fixture");
  assert.ok(state.requests.every(request => request.previous_response_id === undefined));
});

test("native continuation works beyond the bounded local fallback cache without retaining a false baseline", async t => {
  const state = await fixture(t, { nativeOptions: { maxContinuationBytes: 128 } });
  const first = await state.exchange({ input: [{ role: "user", content: "x".repeat(256) }] });
  const second = await state.exchange({ previous_response_id: first.at(-1).response.id, input: [{ role: "user", content: "next" }] });
  assert.equal(second.at(-1).type, "response.completed");
  assert.equal(state.requests[1].previous_response_id, first.at(-1).response.id);
  assert.deepEqual(state.requests[1].input, [{ role: "user", content: "next" }]);
  const changed = await state.exchange({ model: "gpt-6-astra", previous_response_id: second.at(-1).response.id, input: [] });
  assert.equal(changed.at(-1).status, 409);
  assert.equal(state.requests.length, 2);
});

test("native request deadline releases the upstream and emits one explicit terminal failure", async t => {
  const state = await fixture(t, { prepare: ({ controller }) => {
    const error = Object.assign(new Error("fixture deadline"), { status: 504, code: "ERR_ROUTER_REQUEST_TIMEOUT" });
    setTimeout(() => controller.abort(error), 30);
    return true;
  }, handle: () => {} });
  const events = await state.exchange({});
  assert.equal(events.at(-1).status, 504);
  assert.equal(events.at(-1).error.type, "ERR_ROUTER_REQUEST_TIMEOUT");
  assert.equal(events.filter(event => event.type === "error").length, 1);
  assert.equal(state.results.at(-1).status, 504);
  assert.equal(state.results.at(-1).outcome, "failed");
});

test("native in-band failures preserve actual provider events and never become successful baselines", async t => {
  const state = await fixture(t, { handle: ({ send }) => send({ type: "error", status: 429, error: { type: "rate_limit_reached", message: "fixture limit" }, headers: { "retry-after": "3" } }) });
  const first = await state.exchange({});
  assert.deepEqual(first.at(-1), { type: "error", status: 429, error: { type: "rate_limit_reached", message: "fixture limit" }, headers: { "retry-after": "3" } });
  const invalid = await state.exchange({ previous_response_id: "resp_failed", input: [] });
  assert.equal(invalid.at(-1).status, 409);
  assert.equal(state.requests.length, 1);
  assert.equal(state.results[0].status, 429);
});

test("actual Router native preparation reaches persistent WebSockets with repaired effort and foreign history", async t => {
  const tool = { id: "fc_actual", type: "function_call", call_id: "call_actual", name: "fixture_tool", arguments: "{}" };
  const state = await fixture(t, { actualRouter: true, handle: ({ payload, complete }) => complete(payload.previous_response_id ? [] : [tool]) });
  const first = await state.exchange({ reasoning: { effort: "max" }, input: [{ id: "foreign-message", type: "message", role: "user", content: "first" }] });
  assert.equal(state.requests[0].reasoning.effort, "high");
  assert.equal(state.requests[0].input[0].id, undefined);
  const produced = first.find(event => event.type === "response.output_item.done").item;
  const suffix = { type: "function_call_output", call_id: produced.call_id, output: "42" };
  await state.exchange({ previous_response_id: first.at(-1).response.id, input: [suffix], reasoning: { effort: "max" } });
  assert.equal(state.requests[1].previous_response_id, first.at(-1).response.id);
  assert.deepEqual(state.requests[1].input, [suffix]);
  assert.equal(state.handshakes.length, 1);
  writeFileSync(state.catalogPath, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", supported_reasoning_levels: ["medium"] }] }));
  await state.exchange({ input: [], reasoning: { effort: "max" } });
  assert.equal(state.requests[2].reasoning.effort, "medium");
  assert.equal(state.httpRequests, 0);
  assert.match(state.routerChild.errors(), /transport=websocket/u);
});

test("actual Router preserves local caller substitution and external routing on HTTP", async t => {
  const local = await fixture(t, { actualRouter: true, headers: { authorization: "Bearer native-ws-fixture-caller-capability-long-enough" } });
  const managed = await local.exchange({ input: [{ role: "user", content: "local" }] });
  assert.equal(managed.at(-1).type, "response.completed");
  assert.equal(local.requests[0].fixtureTransport, "http");
  assert.equal(local.requests[0].store, false);
  assert.equal(local.handshakes.length, 0);
  const external = await fixture(t, { actualRouter: true, headers: { "x-session-id": "native-session-hint", "x-codex-routing-hint": "native-route-hint" } });
  const routed = await external.exchange({ model: "openrouter/pareto", input: [{ role: "user", content: "external" }] });
  assert.equal(routed.at(-1).type, "response.completed");
  assert.equal(external.requests[0].fixtureTransport, "http");
  assert.equal(external.handshakes.length, 0);
  assert.equal(external.httpHeaders[0]["chatgpt-account-id"], undefined);
  assert.equal(external.httpHeaders[0]["x-session-id"], undefined);
  assert.equal(external.httpHeaders[0]["x-codex-routing-hint"], undefined);
  assert.equal(external.httpHeaders[0]["x-openai-internal-codex-residency"], undefined);
});

test("actual native and external WebSocket timing logs follow current per-response thread metadata", async t => {
  const first = "019a0780-0000-7000-8000-000000000001", second = "019a0780-0000-7000-8000-000000000002";
  const digest = value => createHash("sha256").update(`codex-router/thread/v1\0${value}`).digest("hex");
  for (const model of ["gpt-6.1-sol","openrouter/pareto"]) {
    const state = await fixture(t,{actualRouter:true,headers:{"thread-id":first},handle:({complete}) => complete([])});
    for (const thread of [first,second]) {
      const events = await state.exchange({model,client_metadata:{thread_id:thread,session_id:thread}});
      assert.equal(events.at(-1).type,"response.completed");
    }
    const timingLines = () => state.routerChild.errors().split("\n").filter(line => line.startsWith("[codex-router] timing "));
    // Client completion precedes the server's finally block and stderr delivery.
    const deadline = Date.now()+3000;
    while (timingLines().length<2 && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,10));
    await stop(state.routerChild);
    const timings = timingLines();
    assert.equal(timings.length,2);
    assert.ok(timings[0].includes(`thread_sha256=${digest(first)}`));
    assert.ok(timings[1].includes(`thread_sha256=${digest(second)}`));
    assert.ok(timings.every(line => !line.includes(first) && !line.includes(second)));
    assert.equal(state.handshakes.length,model.startsWith("gpt-") ? 2 : 0);
  }
});

test("actual Router deadline aborts a held native WebSocket and releases admission", async t => {
  const state = await fixture(t, { actualRouter: true, routerEnvironment: { MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: "100" }, handle: () => {} });
  const events = await state.exchange({});
  assert.equal(events.at(-1).status, 504);
  const status = await fetch(`http://127.0.0.1:${state.routerPort}/internal/lifecycle`, { headers: { authorization: "Bearer fixture-internal-capability-long-enough" } });
  assert.equal((await status.json()).activeRequests, 0);
});

test("coalesced native rate-limit metadata after completion preserves incremental continuation", async t => {
  const metadata = { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 22 } } };
  const state = await fixture(t, { handle: ({ socket, id }) => socket.write(Buffer.concat([
    frame({ type: "response.completed", response: { id, status: "completed", output: [] } }),
    frame(metadata),
  ])) });
  const first = await state.exchange({});
  const second = await state.exchange({ previous_response_id: first.at(-1).response.id });
  assert.equal(state.handshakes.length, 1);
  assert.equal(state.requests[1].previous_response_id, first.at(-1).response.id);
  assert.ok(second.some(event => event.type === "codex.rate_limits" && event.rate_limits.primary.used_percent === 22));
});
