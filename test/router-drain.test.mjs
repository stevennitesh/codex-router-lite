import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";

const CALLER = "drain-caller-capability-long-enough";
const INTERNAL = "drain-internal-capability-long-enough";

function isolatedPaths(state) {
  const environment = {
    CODEX_HOME: path.join(state, "codex"), MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(state, "picker.json"), MODEL_ROUTER_MULTI_AGENT_STATE: path.join(state, "multi-agent.json"),
    MODEL_ROUTER_CODEX_AUTH: path.join(state, "absent-auth.json"), CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0",
  };
  for (const key of ["CODEX_HOME", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "MODEL_ROUTER_MODEL_PICKER_STATE", "MODEL_ROUTER_MULTI_AGENT_STATE", "MODEL_ROUTER_CODEX_AUTH"]) {
    assert.ok(environment[key] === state || environment[key].startsWith(state + path.sep), `${key} escapes synthetic fixture`);
  }
  return environment;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function routedRequest(port, input) {
  return fetch(`${callerBaseUrl(port, CALLER)}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic-native-session",
      "chatgpt-account-id": "synthetic-account",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input, stream: true }),
  });
}

function lifecycle(port, pathName, body, signal) {
  return fetch(`http://127.0.0.1:${port}/internal/lifecycle${pathName}`, {
    signal,
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${INTERNAL}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitDraining(port) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const response = await lifecycle(port, "", undefined, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
    assert.equal(response.status, 200);
    if ((await response.json()).state === "draining") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Router did not enter draining state");
}

test("real Router callers drain buffered and SSE work, reject new work, resume, and force", {
  timeout: 20_000,
}, async t => {
  const held = [];
  const native = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const marker = typeof payload.input === "string" ? payload.input : "normal";
    if (marker.startsWith("hold")) {
      if (marker.includes("sse")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ type: "response.created", response: { id: marker } })}\n\n`);
      }
      held.push({ marker, response });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `resp_${marker}`, status: "completed", output: [] }));
  });
  const nativePort = await listen(native);
  const routerPort = await openPort();
  const state = mkdtempSync(path.join(os.tmpdir(), "router-drain-"));
  const router = launch("router.mjs", {
    ...isolatedPaths(state),
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_CALLER_KEY: CALLER,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}`,
    CODEX_ROUTER_QUIET: "1",
  });
  t.after(async () => {
    for (const item of held) item.response.destroy();
    await stop(router);
    native.closeAllConnections();
    await new Promise((resolve) => native.close(resolve));
    rmSync(state, { recursive: true, force: true });
  });

  await ready(`http://127.0.0.1:${routerPort}/live`, router, {}, { accept: response => response.ok });
  const live = await (await fetch(`http://127.0.0.1:${routerPort}/live`)).json();
  assert.deepEqual(live.capabilities, ["drain-v1"]);
  const unauthorized = await fetch(`http://127.0.0.1:${routerPort}/internal/lifecycle`, {
    headers: { authorization: `Bearer ${CALLER}` },
  });
  assert.equal(unauthorized.status, 401);

  const sseResponse = await routedRequest(routerPort, "hold-sse");
  while (!held.some((item) => item.marker === "hold-sse")) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const sseDrain = lifecycle(routerPort, "/drain", { timeout_ms: 2_000 });
  await waitDraining(routerPort);
  const rejected = await routedRequest(routerPort, "rejected-during-drain");
  assert.equal(rejected.status, 503);
  const sseHeld = held.find((item) => item.marker === "hold-sse");
  sseHeld.response.end(`data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "resp_sse", status: "completed", output: [] },
  })}\n\n`);
  assert.match(await sseResponse.text(), /response\.completed/u);
  assert.equal((await (await sseDrain).json()).status, "drained");
  assert.equal((await lifecycle(routerPort, "/resume", {})).status, 200);

  const buffered = routedRequest(routerPort, "hold-json-timeout");
  while (!held.some((item) => item.marker === "hold-json-timeout")) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const timed = await lifecycle(routerPort, "/drain", { timeout_ms: 20 });
  assert.equal(timed.status, 409);
  assert.equal((await timed.json()).reason, "timeout");
  const resumed = await routedRequest(routerPort, "after-timeout");
  assert.equal(resumed.status, 200);
  const bufferedHeld = held.find((item) => item.marker === "hold-json-timeout");
  bufferedHeld.response.writeHead(200, { "content-type": "application/json" });
  bufferedHeld.response.end(JSON.stringify({ id: "resp_buffered", status: "completed", output: [] }));
  assert.equal((await buffered).status, 200);

  const forcedRequest = routedRequest(routerPort, "hold-json-force").catch(() => undefined);
  while (!held.some((item) => item.marker === "hold-json-force")) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const forced = await lifecycle(routerPort, "/drain", { force: true });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).status, "forced");
  assert.equal((await routedRequest(routerPort, "after-force")).status, 503);
  await lifecycle(routerPort, "/resume", {});
  await forcedRequest;
});

test("an admitted Switchyard request keeps only its nested callback lease and tool gaps defer drain", {
  timeout: 20_000,
}, async t => {
  let routerPort;
  let callbackAllowed;
  let releaseCallback;
  const callbackGate = () => new Promise((resolve) => { releaseCallback = resolve; });
  let handlerEntered;
  let enterHandler;
  const entered = () => new Promise((resolve) => { enterHandler = resolve; });
  let mode = "callback";
  const native = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_nested", status: "completed", output: [] }));
  });
  const nativePort = await listen(native);
  const switchyard = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const lease = request.headers["x-codex-router-switchyard-callback-lease"];
    assert.equal(typeof lease, "string");
    if (mode === "callback") {
      enterHandler();
      await callbackAllowed;
      const nested = await fetch(`${callerBaseUrl(routerPort, CALLER)}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-native-session",
          "chatgpt-account-id": "synthetic-account",
          "content-type": "application/json",
          "x-codex-router-switchyard-callback-lease": lease,
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "nested", stream: false }),
      });
      assert.equal(nested.status, 200, await nested.text());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_outer", status: "completed", output: [] }));
      return;
    }
    const continuation = Array.isArray(payload.input) && payload.input.some((item) => item.type === "function_call_output");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: continuation ? "resp_tool_done" : "resp_tool_call",
      status: "completed",
      output: continuation ? [] : [{ type: "function_call", name: "fixture", call_id: "call-1", arguments: "{}" }],
    }));
  });
  const switchyardPort = await listen(switchyard);
  routerPort = await openPort();
  const state = mkdtempSync(path.join(os.tmpdir(), "router-switchyard-drain-"));
  const runtime = path.join(state, "switchyard");
  mkdirSync(runtime);
  writeFileSync(path.join(runtime, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
  writeFileSync(path.join(runtime, "routes.toml"), "# fixture\n");
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["switchyard"] }));
  const router = launch("router.mjs", {
    ...isolatedPaths(state),
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_SWITCHYARD_ROOT: runtime,
    CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${switchyardPort}/v1`,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: "fixture-switchyard-capability",
    CODEX_ROUTER_CALLER_KEY: CALLER,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}`,
    CODEX_ROUTER_QUIET: "1",
  });
  t.after(async () => {
    await stop(router);
    for (const server of [native, switchyard]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(state, { recursive: true, force: true });
  });
  await ready(`http://127.0.0.1:${routerPort}/live`, router, {}, { accept: response => response.ok });

  handlerEntered = entered();
  callbackAllowed = callbackGate();
  const outer = fetch(`${callerBaseUrl(routerPort, CALLER)}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic-native-session",
      "chatgpt-account-id": "synthetic-account",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "switchyard/auto", input: "outer-callback", stream: false }),
  });
  await handlerEntered;
  const draining = lifecycle(routerPort, "/drain", { timeout_ms: 2_000 });
  await waitDraining(routerPort);
  releaseCallback();
  assert.equal((await outer).status, 200);
  assert.equal((await (await draining).json()).status, "drained");
  await lifecycle(routerPort, "/resume", {});

  mode = "tools";
  const first = await fetch(`${callerBaseUrl(routerPort, CALLER)}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic-native-session",
      "chatgpt-account-id": "synthetic-account",
      "content-type": "application/json",
      "x-session-id": "tool-session",
    },
    body: JSON.stringify({ model: "switchyard/auto", input: "use a tool", stream: false }),
  });
  assert.equal(first.status, 200, await first.text());
  const toolDeferred = await lifecycle(routerPort, "/drain", { timeout_ms: 50 });
  assert.equal(toolDeferred.status, 409);
  assert.equal((await toolDeferred.json()).reason, "switchyard-workflow-active");
  const continuation = await fetch(`${callerBaseUrl(routerPort, CALLER)}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic-native-session",
      "chatgpt-account-id": "synthetic-account",
      "content-type": "application/json",
      "x-session-id": "tool-session",
    },
    body: JSON.stringify({
      model: "switchyard/auto",
      input: [{ type: "function_call_output", call_id: "call-1", output: "done" }],
      stream: false,
    }),
  });
  assert.equal(continuation.status, 200, await continuation.text());
  assert.equal((await lifecycle(routerPort, "/drain", { timeout_ms: 200 })).status, 200);
  await lifecycle(routerPort, "/resume", {});
});

test("public completed tool continuations drain across models and current conversation identities", {
  timeout: 20_000,
}, async t => {
  let mode = "answer";
  let toolIndex = 0;
  let held;
  let nestedContinuation;
  const seenModels = new Set();
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const payload = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"));
    seenModels.add(payload.model);
    const switchyard = payload.model === "switchyard-auto";
    const consumed = Array.isArray(payload.input) && payload.input.some(item => item.type === "function_call_output");
    if (switchyard && mode === "nested-callback") {
      const nested = await fetch(`${callerBaseUrl(routerPort, CALLER)}/responses`, {
        method: "POST", headers: {
          authorization: "Bearer synthetic-native-session", "chatgpt-account-id": "synthetic-account",
          "content-type": "application/json",
          "x-codex-router-switchyard-callback-lease": request.headers["x-codex-router-switchyard-callback-lease"],
        }, body: JSON.stringify({ model: "gpt-6.1-sol", stream: false, ...nestedContinuation }),
      });
      assert.equal(nested.status, 200);
      await nested.arrayBuffer();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_callback", status: "completed", output: [] }));
      return;
    }
    if (!switchyard && mode === "hold") {
      held = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.created","response":{"id":"held"}}\n\n');
      return;
    }
    if (!switchyard && mode === "failure") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":{"message":"synthetic refusal"}}');
      return;
    }
    const output = (switchyard && !consumed) || (!switchyard && mode === "next-tool")
      ? [{ type: "function_call", id: `fc_${++toolIndex}`, call_id: `call_${toolIndex}`, name: "fixture", arguments: "{}" }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }];
    if (!switchyard && mode === "invalid-sequence") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const encode = event => `data: ${JSON.stringify(event)}\n\n`;
      response.end(encode({ type: "response.output_text.delta", sequence_number: 1, delta: "first" }) +
        encode({ type: "response.output_text.delta", sequence_number: 1, delta: "repeated" }) +
        encode({ type: "response.completed", sequence_number: 2, response: { status: "completed", output } }));
      return;
    }
    response.writeHead(200, !switchyard && mode === "json-headerless" ? {} :
      { "content-type": !switchyard && mode === "json-unknown" ? "application/octet-stream" : "application/json" });
    response.end(JSON.stringify({ id: `resp_${toolIndex}`, status: !switchyard && mode === "incomplete" ? "incomplete" : "completed", output }) +
      (!switchyard && mode === "json-trailer" ? "{malformed}" : ""));
  });
  const port = await listen(upstream);
  const routerPort = await openPort();
  const state = mkdtempSync(path.join(os.tmpdir(), "router-workflow-drain-"));
  const runtime = path.join(state, "switchyard");
  mkdirSync(runtime);
  writeFileSync(path.join(runtime, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
  writeFileSync(path.join(runtime, "routes.toml"), "# fixture\n");
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["switchyard", "openrouter"] }));
  const router = launch("router.mjs", {
    ...isolatedPaths(state),
    CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_CALLER_KEY: CALLER, CODEX_ROUTER_INTERNAL_KEY: INTERNAL,
    CODEX_ROUTER_SWITCHYARD_ROOT: runtime, CODEX_ROUTER_SWITCHYARD_CAPABILITY: "fixture-switchyard-capability",
    CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${port}/v1`,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${port}`, CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${port}/v1`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`, CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: "1000",
  });
  t.after(async () => {
    held?.destroy();
    await stop(router);
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  });
  await ready(`http://127.0.0.1:${routerPort}/live`, router);
  const post = (model, input, headers = {}, client_metadata, signal) => fetch(`${callerBaseUrl(routerPort, CALLER)}/responses`, {
    method: "POST", headers: { authorization: "Bearer synthetic-native-session", "chatgpt-account-id": "synthetic-account", "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, input, stream: false, ...(client_metadata ? { client_metadata } : {}) }), signal,
  });
  const status = async () => (await lifecycle(routerPort, "")).json();
  const produce = async (headers, metadata) => {
    const response = await post("switchyard/auto", "use tool", headers, metadata);
    assert.equal(response.status, 200);
    const tool = (await response.json()).output.find(item => item.type === "function_call");
    assert.ok(tool);
    assert.equal((await status()).workflowCalls, 1);
    assert.equal((await lifecycle(routerPort, "/drain", {})).status, 409);
    return tool;
  };
  const resultFor = tool => [tool, { type: "function_call_output", call_id: tool.call_id, output: "done" }];
  const cleared = async () => {
    assert.equal((await status()).workflowCalls, 0);
    assert.equal((await status()).indeterminateWorkflow, false);
    assert.equal((await lifecycle(routerPort, "/drain", {})).status, 200);
    await lifecycle(routerPort, "/resume", {});
  };
  for (const model of ["switchyard/auto", "gpt-6.1-sol", "openrouter/deepseek-v4.1-flash-together"]) {
    for (const current of [false, true]) {
      const metadata = current ? { thread_id: "current-thread", session_id: "current-session" } : undefined;
      const firstHeaders = current ? { "session-id": "cache-a" } : { "x-session-id": "legacy-session" };
      const nextHeaders = current ? { "session-id": "cache-b" } : firstHeaders;
      const tool = await produce(firstHeaders, metadata);
      const answer = await post(model, resultFor(tool), nextHeaders, metadata);
      assert.equal(answer.status, 200);
      await answer.arrayBuffer();
      await cleared();
    }
  }
  for (mode of ["json-headerless", "json-unknown"]) {
    const metadata = { thread_id: mode, session_id: "json-format-session" };
    const tool = await produce({}, metadata);
    const answer = await post("gpt-6.1-sol", resultFor(tool), {}, metadata);
    assert.equal((await answer.json()).status, "completed");
    await cleared();
  }
  mode = "answer";
  const metadata = { thread_id: "metadata-only", session_id: "metadata-session" };
  let tool = await produce({}, metadata);
  mode = "nested-callback";
  nestedContinuation = { input: resultFor(tool), client_metadata: metadata };
  await (await post("switchyard/auto", "nested callback", {}, metadata)).arrayBuffer();
  assert.equal((await status()).workflowCalls, 1);
  assert.equal((await lifecycle(routerPort, "/drain", {})).status, 409);
  for (const [input, identity, nextMode] of [
    [resultFor(tool), { thread_id: "wrong-thread" }, "answer"],
    [[{ type: "function_call_output", call_id: "wrong-call", output: "done" }], metadata, "answer"],
    [resultFor(tool), metadata, "failure"],
    [resultFor(tool), metadata, "incomplete"],
    [resultFor(tool), metadata, "json-trailer"],
    [resultFor(tool), metadata, "invalid-sequence"],
  ]) {
    mode = nextMode;
    const response = await post("gpt-6.1-sol", input, {}, identity);
    assert.equal(response.status, nextMode === "failure" ? 429 : 200);
    await response.arrayBuffer();
    assert.equal((await status()).workflowCalls, 1);
    assert.equal((await lifecycle(routerPort, "/drain", {})).status, 409);
  }
  mode = "hold";
  const controller = new AbortController();
  const canceled = await post("gpt-6.1-sol", resultFor(tool), {}, metadata, controller.signal);
  controller.abort();
  await canceled.arrayBuffer().catch(() => {});
  for (let attempt = 0; (await status()).activeRequests && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await status()).activeRequests, 0);
  assert.equal((await status()).workflowCalls, 1);
  assert.equal((await lifecycle(routerPort, "/drain", {})).status, 409);
  const timedOut = await post("gpt-6.1-sol", resultFor(tool), {}, metadata);
  const timedOutWire = await timedOut.text();
  assert.match(timedOutWire, /response\.failed/u);
  assert.match(timedOutWire, /execution deadline/u);
  assert.equal((await status()).activeRequests, 0);
  assert.equal((await status()).workflowCalls, 1);
  assert.equal((await lifecycle(routerPort, "/drain", {})).status, 409);
  mode = "next-tool";
  const next = await post("gpt-6.1-sol", resultFor(tool), {}, metadata);
  tool = (await next.json()).output.find(item => item.type === "function_call");
  assert.ok(tool);
  assert.equal((await status()).workflowCalls, 1);
  assert.equal((await lifecycle(routerPort, "/drain", {})).status, 409);
  mode = "answer";
  await (await post("gpt-6.1-sol", resultFor(tool), {}, metadata)).arrayBuffer();
  await cleared();
  // Independent native tools do not create a Switchyard dependency.
  mode = "next-tool";
  await (await post("gpt-6.1-sol", "independent", {}, { thread_id: "independent" })).arrayBuffer();
  await cleared();
  assert.ok(seenModels.has("openrouter-deepseek-v4-1-flash-together"), [...seenModels].join(","));
});

test("accepted HTTP terminals retire consumed tools across coalesced and split provider trailers without replay", {
  timeout: 20_000,
}, async t => {
  const scratch = path.resolve(".tmp");
  mkdirSync(scratch, { recursive: true });
  const state = mkdtempSync(path.join(scratch, "router-terminal-drain-"));
  const runtime = path.join(state, "switchyard");
  mkdirSync(runtime);
  writeFileSync(path.join(runtime, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "synthetic fixture; never executed");
  writeFileSync(path.join(runtime, "routes.toml"), "# fixture\n");
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["switchyard", "openrouter"] }));
  const encode = payload => `data: ${JSON.stringify(payload)}\n\n`;
  const tool = { type: "function_call", id: "fc_terminal", call_id: "call_terminal", name: "fixture", arguments: "{}" };
  const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "served answer" }] };
  let scenario;
  let requests = 0;
  const failures = [];
  const upstream = http.createServer((request, response) => {
    (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const payload = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"));
      requests++;
      const seed = typeof payload.input === "string";
      const output = seed ? [tool] : scenario.doneFallback ? [] : [answer];
      const prefix = !seed && scenario.doneFallback ? encode({ type: "response.output_item.done", item: answer }) : "";
      const terminal = encode({ type: "response.completed", response: { id: seed ? "resp_seed" : "resp_answer", status: "completed", output,
        usage: { input_tokens: !seed && scenario.zero ? 0 : 7, output_tokens: 2 } } });
      const trailer = seed ? "" : scenario.trailer;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!seed && scenario.split) { response.write(prefix + terminal); await setImmediate(); response.end(trailer); }
      else response.end(prefix + terminal + trailer);
    })().catch(error => { failures.push(error.message); response.destroy(); });
  });
  const port = await listen(upstream);
  const routerPort = await openPort();
  const environment = {
    ...isolatedPaths(state),
    CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_CALLER_KEY: CALLER, CODEX_ROUTER_INTERNAL_KEY: INTERNAL,
    CODEX_ROUTER_SWITCHYARD_ROOT: runtime, CODEX_ROUTER_SWITCHYARD_CAPABILITY: "fixture-switchyard-capability",
    CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${port}/v1`, CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${port}`,
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${port}/v1`, CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
    CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1", CODEX_ROUTER_ZERO_INPUT_ESTIMATE: "1", CODEX_ROUTER_QUIET: "1",
  };
  const router = launch("router.mjs", environment);
  t.after(async () => {
    await stop(router);
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  });
  await ready(`http://127.0.0.1:${routerPort}/live`, router);
  const status = async () => (await lifecycle(routerPort, "")).json();
  const post = async (model, input, thread) => {
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER)}/responses`, {
      method: "POST", headers: { authorization: "Bearer synthetic-native-session", "content-type": "application/json" },
      body: JSON.stringify({ model, input, stream: true, client_metadata: { thread_id: thread } }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const trailers = ["", "data: {malformed}\n\n", encode({ type: "response.failed" }), encode({ type: "response.incomplete" }), encode({ usage: { input_tokens: 99, output_tokens: 9 } })];
  const scenarios = trailers.flatMap(trailer => [false, true].map(split => ({ trailer, split })));
  scenarios.push({ trailer: encode({ usage: { input_tokens: 99 } }), zero: true }, { trailer: "", doneFallback: true });
  for (const [index, current] of scenarios.entries()) {
    scenario = current;
    const beforeRequests = requests;
    const thread = `terminal-thread-${index}`;
    const seeded = await post("switchyard/auto", "use tool", thread);
    assert.equal((seeded.match(/"type":"response.completed"/gu) || []).length, 1);
    assert.equal((await status()).workflowCalls, 1);
    const input = [tool, { type: "function_call_output", call_id: tool.call_id, output: current.zero ? "x".repeat(8000) : "done" }];
    const wire = await post(current.zero ? "openrouter/deepseek-v4.1-flash-together" : "gpt-6.1-sol", input, thread);
    assert.equal((wire.match(/"type":"response.completed"/gu) || []).length, 1, JSON.stringify(current));
    assert.match(wire, /served answer/u);
    if (current.zero) assert.match(wire, /"input_tokens":[1-9]\d{3,}/u);
    let settled;
    const deadline = Date.now() + 2000;
    do { settled = await status(); if (!settled.activeRequests) break; await setImmediate(); } while (Date.now() < deadline);
    assert.equal(settled.activeRequests, 0);
    assert.equal(settled.workflowCalls, 0, JSON.stringify(current));
    assert.equal(settled.indeterminateWorkflow, false);
    assert.equal((await lifecycle(routerPort, "/drain", {})).status, 200);
    assert.equal((await lifecycle(routerPort, "/resume", {})).status, 200);
    assert.equal(requests - beforeRequests, 2, "seed and continuation must each be sent exactly once");
  }
  assert.deepEqual(failures, []);
});
