import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { request as httpRequest, Server as HttpServer } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { startWebMcp } from "../src/web-mcp.mjs";
import { createWebToolBroker } from "../src/web-tools.mjs";

const fn = name => ({ type: "function", name, description: "Native tool", parameters: { type: "object", properties: {} } });
const register = (broker, turnId, tools = [fn("read")]) => broker.register({ threadId: "native-thread", turnId, tools });
const finish = (broker, token) => broker.finish(token, broker.beginCompletion(token));
const call = (client, turn, wireName, args = {}) => client.callTool({ name: "codex_tool_call", arguments: { turn_token: turn.token, wire_name: wireName, ...args } });
const discoveryPage = result => JSON.parse(result.content[0].text);
const postOnly = { fetch: (url, init) => init?.method === "GET" ? Promise.resolve(new Response(null, { status: 405 })) : fetch(url, init) };
const withoutDiagnosticTime = receipts => receipts.map(({ at, ...receipt }) => {
  assert.equal(new Date(at).toISOString(), at);
  return receipt;
});

async function nativeCalls(broker, token) {
  let revision = broker.revision(token);
  for (;;) {
    const calls = broker.takeCalls(token);
    if (calls.length) return calls;
    const changed = await broker.waitForChange(token, revision, { timeoutMs: 2_000 });
    assert.equal(changed.closed, false, "MCP turn closed before queueing a native tool call.");
    assert.notEqual(changed.revision, revision, "MCP did not queue a native tool call.");
    revision = changed.revision;
  }
}

async function beginObservation(broker, service, token, options = {}) {
  let subscribed;
  const ready = new Promise(resolve => { subscribed = resolve; });
  const wait = broker.waitForChange;
  broker.waitForChange = (...args) => {
    const result = wait(...args);
    subscribed(args[2].signal);
    return result;
  };
  const response = fetch(service.observationUrl(token, broker.revision(token)), options);
  try {
    return { response, signal: await ready };
  } finally {
    broker.waitForChange = wait;
  }
}

async function fixture(t, options = {}) {
  const broker = createWebToolBroker({ invocationTimeoutMs: 5_000 });
  const service = await startWebMcp({ broker, onDiagnostic: () => {}, ...options });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(({ client }) => client.close()));
    await service.close();
  });
  const connect = async transportOptions => {
    const client = new Client({ name: "native-web-bridge-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(service.url), transportOptions);
    clients.push({ client, transport });
    await client.connect(transport);
    return { client, transport };
  };
  return { broker, service, connect };
}

for (const trace of [false, true]) {
  test(`default diagnostics ${trace ? "trace all stages when enabled at creation" : "log only errors"}`, { timeout: 10_000 }, async t => {
    const previousTrace = process.env.CODEX_ROUTER_WEB_MCP_TRACE;
    t.after(() => {
      if (previousTrace === undefined) delete process.env.CODEX_ROUTER_WEB_MCP_TRACE;
      else process.env.CODEX_ROUTER_WEB_MCP_TRACE = previousTrace;
    });
    if (trace) process.env.CODEX_ROUTER_WEB_MCP_TRACE = "1";
    else delete process.env.CODEX_ROUTER_WEB_MCP_TRACE;
    const logged = [];
    t.mock.method(console, "warn", line => logged.push(line));
    const receipts = () => withoutDiagnosticTime(logged.map(line => {
      const prefix = "[codex-router] web-mcp ";
      assert.equal(line.startsWith(prefix), true);
      return JSON.parse(line.slice(prefix.length));
    }));
    const { broker, service, connect } = await fixture(t, { onDiagnostic: undefined });
    // An existing listener retains its logging policy until Router restarts.
    if (trace) delete process.env.CODEX_ROUTER_WEB_MCP_TRACE;
    else process.env.CODEX_ROUTER_WEB_MCP_TRACE = "1";
    const turn = register(broker, "default-diagnostics");
    const turnHash = createHash("sha256").update(turn.token).digest("hex");
    const { client, transport } = await connect();
    assert.equal(broker.hasClientActivity(turn.token), false, "MCP session setup is not current-token input acceptance.");
    const discovered = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
    assert.deepEqual(discoveryPage(discovered), broker.list(turn.token));
    assert.equal(broker.hasClientActivity(turn.token), true, "Authenticated current-token discovery acknowledges input before a native invocation.");
    const result = call(client, turn, "read", { arguments: { marker: "private-arguments" } });
    const [native] = await nativeCalls(broker, turn.token);
    broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "private-native-result" }]);
    assert.equal((await result).content[0].text, "private-native-result");
    assert.deepEqual(receipts(), trace ? [
      { operation: "list", stage: "received", turnHash },
      { operation: "list", stage: "list-completed", turnHash },
      { operation: "call", stage: "received", turnHash },
      { operation: "call", stage: "invoke-started", turnHash },
      { operation: "call", stage: "native-result", turnHash, isError: false },
    ] : []);
    logged.length = 0;

    const failed = call(client, turn, "read", { arguments: { marker: "private-arguments" } });
    const [nativeFailure] = await nativeCalls(broker, turn.token);
    broker.complete(turn.token, [{ type: "function_call_output", call_id: nativeFailure.call_id, isError: true, output: "private-native-failure" }]);
    assert.equal((await failed).isError, true);
    await assert.rejects(call(client, turn, "read", { arguments: "private-invalid-arguments" }), /invalid arguments/iu);
    await assert.rejects(client.callTool({ name: "private-unknown-operation", arguments: { turn_token: "private-malformed-token" } }), /invalid arguments/iu);
    assert.equal((await call(client, turn, "private-undeclared-tool")).isError, true);
    assert.deepEqual(receipts(), [
      ...(trace ? [
        { operation: "call", stage: "received", turnHash },
        { operation: "call", stage: "invoke-started", turnHash },
      ] : []),
      { operation: "call", stage: "native-result", turnHash, isError: true },
      ...(trace ? [{ operation: "call", stage: "received", turnHash }] : []),
      { operation: "call", stage: "invalid-arguments", turnHash },
      ...(trace ? [{ operation: "unknown", stage: "received" }] : []),
      { operation: "unknown", stage: "unknown-operation" },
      ...(trace ? [
        { operation: "call", stage: "received", turnHash },
        { operation: "call", stage: "invoke-started", turnHash },
      ] : []),
      { operation: "call", stage: "rejected", turnHash },
    ]);
    for (const privateValue of [turn.token, service.url, transport.sessionId, "private-"]) {
      assert.equal(logged.join("\n").includes(privateValue), false);
    }
    assert.equal(finish(broker, turn.token), true);
    assert.equal(service.status().pending, 0);
    logged.length = 0;
    const stale = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
    assert.deepEqual(stale.structuredContent, { error: { code: "web_tool_turn_closed" } });
    assert.deepEqual(receipts(), [
      ...(trace ? [{ operation: "list", stage: "received", turnHash }] : []),
      { operation: "list", stage: "turn-not-active", turnHash },
    ]);
  });
}

test("SDK HTTP client initializes, discovers current native tools, and waits for native execution", { timeout: 10_000 }, async t => {
  const receipts = [];
  const { broker, service, connect } = await fixture(t, { onDiagnostic: receipt => receipts.push(receipt) });
  const turn = register(broker, "function", [{ type: "namespace", name: "mcp__files", tools: [fn("read")] }]);
  const turnHash = createHash("sha256").update(turn.token).digest("hex");
  const { client, transport } = await connect();
  assert.match(transport.sessionId, /^[a-f0-9-]{36}$/u);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ["codex_tools_list", "codex_tool_call"]);
  assert.equal(listed.tools[1].annotations.readOnlyHint, false);
  assert.equal(listed.tools[1].annotations.destructiveHint, true);
  const declarations = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
  assert.deepEqual(discoveryPage(declarations), broker.list(turn.token));
  assert.equal(declarations.structuredContent, undefined);
  let resolved = false;
  const result = call(client, turn, "mcp__files__read", { arguments: { path: "native.txt" } });
  void result.then(() => { resolved = true; });
  const [native] = await nativeCalls(broker, turn.token);
  assert.equal(native.type, "function_call");
  assert.equal(native.namespace, "mcp__files");
  assert.equal(native.name, "read");
  assert.deepEqual(JSON.parse(native.arguments), { path: "native.txt" });
  assert.equal(resolved, false);
  assert.equal(service.status().pending, 1);
  assert.deepEqual(withoutDiagnosticTime(receipts), [
    { operation: "list", stage: "received", turnHash },
    { operation: "list", stage: "list-completed", turnHash },
    { operation: "call", stage: "received", turnHash },
    { operation: "call", stage: "invoke-started", turnHash },
  ]);
  // Only the actual native caller may supply the output that resolves MCP.
  broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "actual native result" }]);
  assert.deepEqual((await result).content, [{ type: "text", text: "actual native result" }]);
  const failed = call(client, turn, "mcp__files__read");
  const [nativeFailure] = await nativeCalls(broker, turn.token);
  broker.complete(turn.token, [{ type: "function_call_output", call_id: nativeFailure.call_id, isError: true, output: "private native failure text" }]);
  assert.equal((await failed).isError, true);
  assert.deepEqual(withoutDiagnosticTime(receipts).slice(4), [
    { operation: "call", stage: "native-result", turnHash, isError: false },
    { operation: "call", stage: "received", turnHash },
    { operation: "call", stage: "invoke-started", turnHash },
    { operation: "call", stage: "native-result", turnHash, isError: true },
  ]);
  const logged = JSON.stringify(receipts);
  for (const privateValue of [turn.token, service.url, transport.sessionId, "mcp__files", "native.txt", "Native tool", "actual native result", "private native failure text"]) {
    assert.equal(logged.includes(privateValue), false);
  }
  assert.equal(finish(broker, turn.token), true);
  assert.equal(service.status().pending, 0);
});

test("SDK focused discovery returns complete function schemas and custom grammar before exact native calls", { timeout: 10_000 }, async t => {
  const { broker, connect } = await fixture(t);
  const parameters = { type: "object", properties: { path: { type: "string", enum: ["native.txt"] } }, required: ["path"], additionalProperties: false };
  const format = { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/\n" };
  const turn = register(broker, "focused", [
    fn("unrelated"), { type: "namespace", name: "mcp__files", tools: [{ ...fn("read"), parameters }] },
    { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Raw code", format }] },
  ]);
  const { client } = await connect();
  const discover = query => client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token, query } });
  const selected = await discover("MCP__FILES__READ");
  assert.deepEqual(discoveryPage(selected).tools, broker.list(turn.token).tools.filter(tool => tool.name === "read"));
  assert.deepEqual(selected.structuredContent, undefined);
  const [read] = discoveryPage(selected).tools;
  assert.deepEqual(read.parameters, parameters);
  const pendingRead = call(client, turn, read.wireName, { arguments: { path: read.parameters.properties.path.enum[0] } });
  const [nativeRead] = await nativeCalls(broker, turn.token);
  assert.equal(nativeRead.namespace, "mcp__files");
  assert.equal(nativeRead.name, "read");
  assert.deepEqual(JSON.parse(nativeRead.arguments), { path: "native.txt" });
  broker.complete(turn.token, [{ type: "function_call_output", call_id: nativeRead.call_id, output: "native file contents" }]);
  assert.equal((await pendingRead).content[0].text, "native file contents");
  const custom = await discover("ExEc");
  assert.deepEqual(discoveryPage(custom).tools[0].format, format);
  assert.deepEqual(custom.structuredContent, undefined);
  const pendingCustom = call(client, turn, discoveryPage(custom).tools[0].wireName, { input: "native" });
  const [nativeCustom] = await nativeCalls(broker, turn.token);
  assert.equal(nativeCustom.type, "custom_tool_call");
  assert.equal(nativeCustom.namespace, "functions");
  assert.equal(nativeCustom.input, "native");
  broker.complete(turn.token, [{ type: "custom_tool_call_output", call_id: nativeCustom.call_id, output: "native code result" }]);
  assert.equal((await pendingCustom).content[0].text, "native code result");
  assert.deepEqual(discoveryPage(await discover("missing")).tools, []);
  assert.equal(finish(broker, turn.token), true);
  assert.equal((await discover("read")).isError, true);
});

test("SDK discovery pages complete schemas and rejects stale or conflicting selections without invoking tools", { timeout: 10_000 }, async t => {
  const { broker, connect } = await fixture(t);
  const turn = register(broker, "paged", Array.from({ length: 12 }, (_, index) => fn(`read_${index}`)));
  const { client } = await connect();
  const discover = selection => client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token, ...selection } });
  const firstResult = await discover({});
  const first = discoveryPage(firstResult);
  assert.equal(firstResult.structuredContent, undefined, "Router JSON is sent only once.");
  assert.equal(first.total, 12);
  assert.equal(first.tools.length, 8);
  const second = discoveryPage(await discover({ cursor: first.nextCursor }));
  assert.equal(second.total, 12);
  assert.equal(second.tools.length, 4);
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual([...first.tools, ...second.tools].map(tool => tool.name), Array.from({ length: 12 }, (_, index) => `read_${index}`));
  const exact = discoveryPage(await discover({ names: ["read_1", "read_11"] }));
  assert.deepEqual(exact.tools.map(tool => tool.name), ["read_1", "read_11"]);
  assert.deepEqual(exact.tools[0].parameters, fn("read_1").parameters);
  assert.equal(discoveryPage(await discover({ query: "read_1" })).total, 1);
  for (const selection of [{ names: [] }, { names: [" "] }, { names: Array(33).fill("read_1") },
    { names: ["read_1"], query: "read" }, { limit: 0 }, { limit: 33 }, { limit: 1.5 }, { cursor: "malformed" }]) {
    await assert.rejects(discover(selection), /invalid arguments/iu);
  }
  const staleSelection = await discover({ names: ["read_1"], cursor: first.nextCursor });
  assert.equal(staleSelection.isError, true);
  assert.deepEqual(staleSelection.structuredContent, { error: { code: "invalid_web_tool_cursor" } });
  assert.match(staleSelection.content[0].text, /no cursor/u);
  broker.update(turn.token, { tools: [fn("changed")] });
  assert.equal((await discover({ cursor: first.nextCursor })).isError, true);
  assert.deepEqual(discoveryPage(await discover({})).tools.map(tool => tool.name), ["changed"]);
  assert.deepEqual(broker.takeCalls(turn.token), []);
  assert.equal(finish(broker, turn.token), true);
});

test("concurrent ChatGPT sessions retain exact turn identity and raw custom input", { timeout: 10_000 }, async t => {
  const { broker, connect } = await fixture(t);
  const first = register(broker, "first");
  const second = register(broker, "second", [{ type: "namespace", name: "functions", tools: [
    { type: "custom", name: "exec", description: "Native code tool", format: { type: "text" } },
  ] }]);
  const [{ client: one }, { client: two }] = await Promise.all([connect(), connect()]);
  const input = "text('native caller executes this');\n$not_a_shell_command";
  const resultOne = call(one, first, "read", { arguments: { marker: "one" } });
  const resultTwo = call(two, second, broker.list(second.token).tools[0].wireName, { input });
  const [[nativeOne], [nativeTwo]] = await Promise.all([nativeCalls(broker, first.token), nativeCalls(broker, second.token)]);
  assert.equal(nativeTwo.type, "custom_tool_call");
  assert.equal(nativeTwo.namespace, "functions");
  assert.equal(nativeTwo.name, "exec");
  assert.equal(nativeTwo.input, input);
  assert.notEqual(nativeOne.call_id, nativeTwo.call_id);
  assert.throws(() => broker.complete(first.token, [{ type: "function_call_output", call_id: nativeTwo.call_id, output: "wrong turn" }]));
  broker.complete(second.token, [{ type: "custom_tool_call_output", call_id: nativeTwo.call_id, output: "two" }]);
  broker.complete(first.token, [{ type: "function_call_output", call_id: nativeOne.call_id, output: "one" }]);
  assert.equal((await resultOne).content[0].text, "one");
  assert.equal((await resultTwo).content[0].text, "two");
  assert.equal(finish(broker, first.token), true);
  assert.equal(finish(broker, second.token), true);
});

test("SDK cancellation retires only its native turn and notifies the generation owner", { timeout: 10_000 }, async t => {
  let cancelled;
  const observed = new Promise(resolve => { cancelled = resolve; });
  const { broker, service, connect } = await fixture(t, { onCancel: token => cancelled(token) });
  const first = register(broker, "cancel"), second = register(broker, "retained");
  const { client } = await connect();
  const controller = new AbortController();
  const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: first.token, wire_name: "read" } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/iu);
  const [native] = await nativeCalls(broker, first.token);
  controller.abort(new Error("test cancellation"));
  await rejected;
  assert.equal(await observed, first.token);
  assert.throws(() => broker.list(first.token), { code: "web_tool_turn_closed" });
  assert.throws(() => broker.complete(first.token, [{ type: "function_call_output", call_id: native.call_id, output: "late" }]));
  assert.equal(broker.list(second.token).tools.length, 1);
  await service.close();
  assert.equal(service.status().listening, false);
});

test("session termination and server close cancel unresolved native calls", { timeout: 10_000 }, async t => {
  const seen = [];
  const { broker, service, connect } = await fixture(t, { onCancel: token => { seen.push(token); } });
  const first = register(broker, "delete"), second = register(broker, "close");
  const [{ client: one, transport }, { client: two }] = await Promise.all([connect(), connect()]);
  const resultOne = call(one, first, "read"), resultTwo = call(two, second, "read");
  // A closed transport may reject the caller; either way it must retire native work.
  const settled = Promise.allSettled([resultOne, resultTwo]);
  await Promise.all([nativeCalls(broker, first.token), nativeCalls(broker, second.token)]);
  await transport.terminateSession();
  assert.throws(() => broker.list(first.token), { code: "web_tool_turn_closed" });
  assert.equal(broker.list(second.token).tools.length, 1);
  await service.close();
  await settled;
  assert.throws(() => broker.list(second.token), { code: "web_tool_turn_closed" });
  assert.deepEqual(new Set(seen), new Set([first.token, second.token]));
  assert.deepEqual(service.status(), { listening: false, sessions: 0, pending: 0 });
});

test("session capacity logs only a bounded error and releases an idle slot without disturbing native work", { timeout: 10_000 }, async t => {
  const previousTrace = process.env.CODEX_ROUTER_WEB_MCP_TRACE;
  delete process.env.CODEX_ROUTER_WEB_MCP_TRACE;
  t.after(() => {
    if (previousTrace === undefined) delete process.env.CODEX_ROUTER_WEB_MCP_TRACE;
    else process.env.CODEX_ROUTER_WEB_MCP_TRACE = previousTrace;
  });
  const logged = [];
  t.mock.method(console, "warn", line => logged.push(line));
  const { broker, service, connect } = await fixture(t, { onDiagnostic: undefined });
  const sessions = [];
  for (let index = 0; index < 32; index += 1) sessions.push(await connect());
  assert.deepEqual(service.status(), { listening: true, sessions: 32, pending: 0 });
  assert.deepEqual(logged, []);

  const turn = register(broker, "session-capacity");
  const result = call(sessions[0].client, turn, "read", { arguments: { marker: "private-native-arguments" } });
  const [native] = await nativeCalls(broker, turn.token);
  const revision = broker.revision(turn.token);
  const observation = await beginObservation(broker, service, turn.token);
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  const limited = await fetch(service.url, { method: "POST", headers, body: JSON.stringify({
    jsonrpc: "2.0", id: "private-request-id", method: "tools/call",
    params: { name: "private-tool-name", arguments: { turn_token: turn.token, input: "private-input" } },
  }) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(limited.headers.get("retry-after"), null);
  assert.deepEqual(await limited.json(), { error: "MCP request rejected." });
  const prefix = "[codex-router] web-mcp ";
  assert.equal(logged.every(line => line.startsWith(prefix)), true);
  assert.deepEqual(withoutDiagnosticTime(logged.map(line => JSON.parse(line.slice(prefix.length)))), [
    { operation: "http", stage: "admission-rejected", reason: "session-capacity", httpStatus: 429, isError: true,
      sessions: 32, creating: 0, pending: 1, observations: 1 },
  ]);
  for (const privateValue of [turn.token, service.url, ...sessions.map(({ transport }) => transport.sessionId), "private-"]) {
    assert.equal(logged.join("\n").includes(privateValue), false);
  }
  // Security checks still precede capacity admission and do not produce receipts.
  assert.equal((await fetch(service.url, { method: "POST", headers: { ...headers, origin: "https://untrusted.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(new URL("/wrong/mcp", service.url), { method: "POST", headers, body: "{}" })).status, 404);
  assert.equal(logged.length, 1);
  assert.deepEqual(service.status(), { listening: true, sessions: 32, pending: 1 });
  assert.equal(broker.revision(turn.token), revision);
  assert.deepEqual(broker.takeCalls(turn.token), [native]);

  await sessions.at(-1).transport.terminateSession();
  assert.deepEqual(service.status(), { listening: true, sessions: 31, pending: 1 });
  const replacement = await connect();
  assert.equal((await replacement.client.listTools()).tools.length, 2);
  assert.deepEqual(service.status(), { listening: true, sessions: 32, pending: 1 });
  broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "actual paired native result" }]);
  assert.equal((await result).content[0].text, "actual paired native result");
  const observed = await observation.response;
  assert.equal(observed.status, 200);
  const changed = await observed.json();
  assert.equal(changed.closed, false);
  assert.ok(changed.revision > revision && changed.revision <= broker.revision(turn.token));
  assert.equal(service.status().pending, 0);
  assert.equal(finish(broker, turn.token), true);
  assert.equal(logged.length, 1);
});

test("64 completed SDK connections reclaim quiescent sessions within the unchanged capacity", { timeout: 15_000 }, async t => {
  const { broker, service, connect } = await fixture(t);
  for (let index = 0; index < 64; index += 1) {
    const turn = register(broker, `completed-client-${index}`);
    const { client } = await connect();
    assert.equal((await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } })).isError, undefined);
    assert.equal(finish(broker, turn.token), true);
    await client.close();
    assert.ok(service.status().sessions <= 32);
    assert.equal(service.status().pending, 0);
  }
});

test("admission expires quiescent sessions immediately and cached clients reinitialize without replaying actions", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { broker, service, connect } = await fixture(t);
  const turn = register(broker, "expired-client");
  const { client: cached, transport } = await connect(postOnly);
  const originalSession = transport.sessionId;
  let invocations = 0;
  const invoke = broker.invoke;
  broker.invoke = (...args) => { invocations += 1; return invoke(...args); };
  const action = call(cached, turn, "read");
  const [native] = await nativeCalls(broker, turn.token);
  broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "exactly once" }]);
  assert.equal((await action).content[0].text, "exactly once");
  assert.equal(finish(broker, turn.token), true);
  t.mock.timers.tick(600_001);
  assert.equal((await fetch(service.url, { method: "POST", headers: { origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await fetch(new URL("/wrong/mcp", service.url), { method: "POST" })).status, 404);
  assert.equal(service.status().sessions, 1, "Security rejection must precede expiry reclamation.");
  await connect(postOnly);
  assert.equal(service.status().sessions, 1, "Admission reclaimed expiry without waiting for the periodic reaper.");
  await assert.rejects(call(cached, turn, "read"), error => error.code === 404);
  assert.equal(transport.sessionId, originalSession, "A 404 does not silently create a new session.");
  assert.equal(invocations, 1);
  await cached.close();
  const replacement = new StreamableHTTPClientTransport(new URL(service.url), postOnly);
  await cached.connect(replacement);
  assert.notEqual(replacement.sessionId, originalSession);
  assert.equal((await cached.listTools()).tools.length, 2);
  assert.equal(invocations, 1, "Explicit initialization must not repeat the previous action.");
});

test("pressure preserves a live broker turn between MCP calls and evicts the oldest inactive session", { timeout: 10_000 }, async t => {
  const { broker, service, connect } = await fixture(t);
  const turn = register(broker, "live-between-calls");
  const active = await connect(postOnly);
  await active.client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
  const idle = [];
  for (let index = 0; index < 31; index += 1) idle.push(await connect(postOnly));
  await connect(postOnly);
  assert.equal(service.status().sessions, 32);
  assert.equal((await active.client.listTools()).tools.length, 2);
  await assert.rejects(idle[0].client.listTools(), error => error.code === 404);
  assert.equal((await idle[1].client.listTools()).tools.length, 2);
  assert.equal(broker.isActive(turn.token), true);
  assert.equal(finish(broker, turn.token), true);
});

test("idle expiry preserves active SSE connections and live broker associations", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const { broker, service, connect } = await fixture(t);
  const streamed = await connect();
  // The SDK starts its optional GET asynchronously after initialization.
  await streamed.client.listTools();
  const current = await connect(postOnly);
  const turn = register(broker, "expiry-live-turn");
  await current.client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
  t.mock.timers.tick(600_001);
  await connect(postOnly);
  assert.equal(service.status().sessions, 3);
  assert.equal((await streamed.client.listTools()).tools.length, 2);
  assert.equal((await current.client.listTools()).tools.length, 2);
  assert.equal(finish(broker, turn.token), true);
});

test("an existing session body upload retains its lease through pressure and expiry", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const { service, connect } = await fixture(t);
  const held = await connect(postOnly);
  const idle = [];
  for (let index = 0; index < 31; index += 1) idle.push(await connect(postOnly));
  let entered;
  const receiving = new Promise(resolve => { entered = resolve; });
  const handle = StreamableHTTPServerTransport.prototype.handleRequest;
  t.mock.method(StreamableHTTPServerTransport.prototype, "handleRequest", function (request, ...args) {
    if (request.headers["x-held-upload"]) entered();
    return handle.call(this, request, ...args);
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id: "upload", method: "tools/list" });
  const upload = httpRequest(service.url, { method: "POST", headers: {
    accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(body),
    "mcp-session-id": held.transport.sessionId, "mcp-protocol-version": held.transport.protocolVersion, "x-held-upload": "1",
  } });
  t.after(() => upload.destroy());
  const completed = new Promise((resolve, rejectUpload) => {
    upload.on("error", rejectUpload);
    upload.on("response", response => {
      let value = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { value += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(value) }));
    });
  });
  upload.write(body.slice(0, 5));
  await receiving;
  await connect(postOnly);
  await assert.rejects(idle[0].client.listTools(), error => error.code === 404);
  t.mock.timers.tick(600_001);
  await connect(postOnly);
  upload.end(body.slice(5));
  const response = await completed;
  assert.equal(response.status, 200);
  assert.equal(response.body.result.tools.length, 2);
  assert.equal((await held.client.listTools()).tools.length, 2);
});

test("native result settlement and cancellation retain their SDK session through reclamation pressure", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const cancelled = [];
  let cancellationObserved;
  const cancellation = new Promise(resolve => { cancellationObserved = resolve; });
  const { broker, service, connect } = await fixture(t, { onCancel: token => { cancelled.push(token); cancellationObserved(token); } });
  const active = await connect(postOnly);
  for (let index = 0; index < 31; index += 1) await connect(postOnly);
  const turn = register(broker, "settling-under-pressure");
  let entered, release;
  const settling = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const invoke = broker.invoke;
  broker.invoke = async (...args) => {
    const result = await invoke(...args);
    entered();
    await gate;
    return result;
  };
  const action = call(active.client, turn, "read");
  const [native] = await nativeCalls(broker, turn.token);
  await connect(postOnly);
  assert.equal(service.status().pending, 1);
  broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "actual native result" }]);
  await settling;
  t.mock.timers.tick(600_001);
  await connect(postOnly);
  assert.equal(service.status().pending, 1);
  assert.equal(broker.beginCompletion(turn.token), undefined);
  assert.deepEqual(cancelled, []);
  release();
  assert.equal((await action).content[0].text, "actual native result");
  assert.equal(finish(broker, turn.token), true);

  broker.invoke = invoke;
  const interrupted = register(broker, "cancel-under-pressure");
  const controller = new AbortController();
  const pending = active.client.callTool({ name: "codex_tool_call", arguments: { turn_token: interrupted.token, wire_name: "read" } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/iu);
  await nativeCalls(broker, interrupted.token);
  await connect(postOnly);
  controller.abort();
  await rejected;
  assert.equal(await cancellation, interrupted.token);
  await active.client.listTools();
  assert.equal(broker.isActive(interrupted.token), false);
  assert.deepEqual(cancelled, [interrupted.token]);
});

test("concurrent initialization reserves at most 32 slots while request bodies are processing", { timeout: 15_000 }, async t => {
  const { service, connect } = await fixture(t);
  let release, filled, rejected;
  const gate = new Promise(resolve => { release = resolve; });
  const capacity = new Promise(resolve => { filled = resolve; });
  const overflow = new Promise(resolve => { rejected = resolve; });
  t.after(release);
  let handling = 0, rejections = 0;
  const handle = StreamableHTTPServerTransport.prototype.handleRequest;
  t.mock.method(StreamableHTTPServerTransport.prototype, "handleRequest", async function (request, ...args) {
    if (request.method === "POST" && request.headers["mcp-session-id"] === undefined) {
      handling += 1;
      if (handling === 32) filled();
      await gate;
    }
    return handle.call(this, request, ...args);
  });
  const results = Promise.allSettled(Array.from({ length: 64 }, () => connect(postOnly).catch(error => {
    assert.equal(error.code, 429);
    rejections += 1;
    if (rejections === 32) rejected();
    throw error;
  })));
  await Promise.all([capacity, overflow]);
  assert.equal(handling, 32);
  assert.deepEqual(service.status(), { listening: true, sessions: 0, pending: 0 });
  release();
  const settled = await results;
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 32);
  assert.equal(settled.filter(result => result.status === "rejected").length, 32);
  assert.equal(service.status().sessions, 32);
});

test("concurrent pressure serializes a delayed retirement and preserves capacity on close failure", { timeout: 15_000 }, async t => {
  const { service, connect } = await fixture(t);
  const cached = [];
  for (let index = 0; index < 32; index += 1) cached.push(await connect(postOnly));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const retiring = new Promise(resolve => { entered = resolve; });
  t.after(release);
  const close = Server.prototype.close;
  let closings = 0;
  const mocked = t.mock.method(Server.prototype, "close", async function () {
    closings += 1;
    if (closings === 1) { entered(); await gate; }
    return close.call(this);
  });
  const admissions = Promise.all([connect(postOnly), connect(postOnly)]);
  await retiring;
  assert.equal(service.status().sessions, 32);
  assert.equal(closings, 1);
  await assert.rejects(cached[0].client.listTools(), error => error.code === 404);
  release();
  await admissions;
  assert.equal(service.status().sessions, 32);
  mocked.mock.restore();

  const failed = t.mock.method(Server.prototype, "close", async () => { throw new Error("synthetic close failure"); });
  await assert.rejects(connect(postOnly), error => error.code === 500);
  assert.equal(service.status().sessions, 32);
  assert.equal((await cached[2].client.listTools()).tools.length, 2);
  failed.mock.restore();
  await connect(postOnly);
  assert.equal(service.status().sessions, 32);
});

test("an initializer disconnected during admission releases its reservation without creating a stranded session", { timeout: 10_000 }, async t => {
  const { service, connect } = await fixture(t);
  const cached = [];
  for (let index = 0; index < 32; index += 1) cached.push(await connect(postOnly));
  let release, entered, received, disconnected, reservationClosed;
  const gate = new Promise(resolve => { release = resolve; });
  const retiring = new Promise(resolve => { entered = resolve; });
  const arrival = new Promise(resolve => { received = resolve; });
  const connectionClosed = new Promise(resolve => { disconnected = resolve; });
  const abandonedClosed = new Promise(resolve => { reservationClosed = resolve; });
  t.after(release);

  // Observe the real HTTP response close before releasing admission, without
  // consuming the initialize body that the SDK would otherwise process later.
  const emit = HttpServer.prototype.emit;
  t.mock.method(HttpServer.prototype, "emit", function (event, ...args) {
    const [request, response] = args;
    if (event === "request" && request.headers["x-abandoned-initializer"] === "1") {
      response.once("close", () => disconnected({ complete: request.complete, destroyed: response.destroyed }));
      received();
    }
    return emit.call(this, event, ...args);
  });
  const close = Server.prototype.close;
  let closing = 0;
  t.mock.method(Server.prototype, "close", async function () {
    if (++closing === 1) { entered(); await gate; }
    return close.call(this);
  });
  const initialize = Server.prototype.connect;
  let creating = 0;
  t.mock.method(Server.prototype, "connect", async function (...args) {
    if (++creating === 2) {
      const onclose = this.onclose;
      this.onclose = () => {
        const initialized = typeof this.transport?.sessionId === "string";
        onclose?.();
        reservationClosed({ initialized });
      };
    }
    return initialize.apply(this, args);
  });

  const replacement = connect(postOnly);
  await retiring;
  const body = JSON.stringify({ jsonrpc: "2.0", id: "abandoned-initialize", method: "initialize", params: {
    protocolVersion: cached[0].transport.protocolVersion, capabilities: {}, clientInfo: { name: "abandoned-client", version: "1.0.0" },
  } });
  const upload = httpRequest(service.url, { method: "POST", headers: {
    accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(body),
    "x-abandoned-initializer": "1",
  } });
  upload.on("error", () => {});
  t.after(() => upload.destroy());
  const uploaded = new Promise(resolve => upload.once("finish", resolve));
  upload.end(body);
  await Promise.all([arrival, uploaded]);
  upload.destroy();
  assert.deepEqual(await connectionClosed, { complete: true, destroyed: true });
  release();
  await replacement;
  assert.deepEqual(await abandonedClosed, { initialized: false }, "A disconnected initializer must be retired before the SDK can accept its body.");
  assert.deepEqual(service.status(), { listening: true, sessions: 31, pending: 0 });
  assert.equal((await (await connect(postOnly)).client.listTools()).tools.length, 2);
  assert.equal(service.status().sessions, 32, "The released slot remains available to a real client.");
});

test("failed SDK connection releases its initialization reservation", { timeout: 10_000 }, async t => {
  const { service, connect } = await fixture(t);
  const broken = t.mock.method(Server.prototype, "connect", async () => { throw new Error("synthetic connect failure"); });
  await assert.rejects(connect(postOnly), error => error.code === 500);
  assert.equal(service.status().sessions, 0);
  broken.mock.restore();
  assert.equal((await (await connect(postOnly)).client.listTools()).tools.length, 2);
  assert.equal(service.status().sessions, 1);
});

test("capability, method, origin, schema, and stale token failures cannot enqueue tools", { timeout: 10_000 }, async t => {
  const receipts = [];
  const { broker, service, connect } = await fixture(t, { onDiagnostic: receipt => receipts.push(receipt) });
  const turn = register(broker, "validation");
  const turnHash = createHash("sha256").update(turn.token).digest("hex");
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  assert.equal((await fetch(new URL("/wrong/mcp", service.url), { method: "POST", headers, body: "{}" })).status, 404);
  assert.equal((await fetch(service.url, { method: "PUT" })).status, 405);
  const origin = await fetch(service.url, { headers: { origin: "https://untrusted.example" } });
  assert.equal(origin.status, 403);
  assert.equal(origin.headers.get("access-control-allow-origin"), null);
  const { client } = await connect();
  for (const args of [
    { turn_token: turn.token, wire_name: "read", arguments: {}, input: "conflicting" },
    { turn_token: turn.token, wire_name: "read", arguments: "invalid" },
    { turn_token: turn.token, wire_name: "read", injected: "unexpected" },
    { turn_token: turn.token, wire_name: "x".repeat(1025) },
  ]) await assert.rejects(client.callTool({ name: "codex_tool_call", arguments: args }), /invalid arguments/iu);
  for (const query of ["", " ", 1, "x".repeat(1025)]) {
    await assert.rejects(client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token, query } }), /invalid arguments/iu);
  }
  assert.deepEqual(withoutDiagnosticTime(receipts), [
    ...Array.from({ length: 4 }, () => [
      { operation: "call", stage: "received", turnHash },
      { operation: "call", stage: "invalid-arguments", turnHash },
    ]).flat(),
    ...Array.from({ length: 4 }, () => [
      { operation: "list", stage: "received", turnHash },
      { operation: "list", stage: "invalid-arguments", turnHash },
    ]).flat(),
  ]);
  receipts.length = 0;
  await assert.rejects(client.callTool({ name: "private-unknown-operation", arguments: { turn_token: "private-malformed-token", secret: "private argument text" } }), /invalid arguments/iu);
  assert.deepEqual(withoutDiagnosticTime(receipts), [
    { operation: "unknown", stage: "received" },
    { operation: "unknown", stage: "unknown-operation" },
  ]);
  receipts.length = 0;
  const unknownDiscovery = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: "web_turn_00000000000000000000000000000000", query: "read" } });
  assert.equal(unknownDiscovery.isError, true);
  assert.deepEqual(unknownDiscovery.structuredContent, { error: { code: "web_tool_turn_closed" } });
  const unknown = await call(client, { token: "web_turn_00000000000000000000000000000000" }, "read");
  assert.equal(unknown.isError, true);
  const undeclared = await call(client, turn, "never_declared");
  assert.equal(undeclared.isError, true);
  assert.deepEqual(withoutDiagnosticTime(receipts).slice(-3), [
    { operation: "call", stage: "received", turnHash },
    { operation: "call", stage: "invoke-started", turnHash },
    { operation: "call", stage: "rejected", turnHash },
  ]);
  receipts.length = 0;
  const invoke = broker.invoke;
  broker.invoke = async () => { throw new Error(`private broker rejection ${turn.token} private error text`); };
  const rejected = await call(client, turn, "read", { arguments: { secret: "private argument text" } });
  broker.invoke = invoke;
  assert.equal(rejected.isError, true);
  assert.deepEqual(withoutDiagnosticTime(receipts), [
    { operation: "call", stage: "received", turnHash },
    { operation: "call", stage: "invoke-started", turnHash },
    { operation: "call", stage: "rejected", turnHash },
  ]);
  assert.equal(JSON.stringify(receipts).includes("private"), false);
  assert.equal(JSON.stringify(rejected).includes("private"), false);
  assert.deepEqual(broker.takeCalls(turn.token), []);
  assert.equal(service.status().pending, 0);
  assert.equal(finish(broker, turn.token), true);
  assert.equal((await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } })).isError, true);
});

test("retired-token discovery and calls fail before admission without affecting the current turn", { timeout: 10_000 }, async t => {
  const receipts = [];
  const { broker, service, connect } = await fixture(t, { onDiagnostic: receipt => receipts.push(receipt) });
  const retired = register(broker, "retired"), retiredHash = createHash("sha256").update(retired.token).digest("hex");
  assert.equal(finish(broker, retired.token), true);
  const current = register(broker, "current");
  const { client, transport } = await connect();
  const invoke = broker.invoke;
  let invocations = 0;
  broker.invoke = (...args) => { invocations += 1; return invoke(...args); };
  const discovery = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: retired.token } });
  const rejected = await call(client, retired, "read");
  assert.deepEqual(rejected, discovery);
  assert.equal(rejected.isError, true);
  assert.deepEqual(rejected.structuredContent, { error: { code: "web_tool_turn_closed" } });
  assert.match(rejected.content[0].text, /supplied turn_token is not active/u);
  assert.match(rejected.content[0].text, /request was not accepted/u);
  assert.match(rejected.content[0].text, /latest Codex message/u);
  assert.match(rejected.content[0].text, /Do not repeat uncertain, cancelled, or timed-out actions/u);
  assert.equal(invocations, 0);
  assert.equal(broker.hasClientActivity(current.token), false);
  assert.equal(broker.revision(current.token), 0);
  assert.deepEqual(broker.takeCalls(current.token), []);
  assert.equal(service.status().pending, 0);
  assert.deepEqual(withoutDiagnosticTime(receipts), [
    { operation: "list", stage: "received", turnHash: retiredHash },
    { operation: "list", stage: "turn-not-active", turnHash: retiredHash },
    { operation: "call", stage: "received", turnHash: retiredHash },
    { operation: "call", stage: "turn-not-active", turnHash: retiredHash },
  ]);
  const publicFailure = JSON.stringify({ rejected, receipts });
  for (const privateValue of [retired.token, current.token, service.url, transport.sessionId, createHash("sha256").update(current.token).digest("hex")]) {
    assert.equal(publicFailure.includes(privateValue), false);
  }
  const listed = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: current.token } });
  assert.deepEqual(discoveryPage(listed), broker.list(current.token));
  const pending = call(client, current, "read");
  const [native] = await nativeCalls(broker, current.token);
  broker.complete(current.token, [{ type: "function_call_output", call_id: native.call_id, output: "current native result" }]);
  assert.equal((await pending).content[0].text, "current native result");
  assert.equal(invocations, 1);
  assert.equal(finish(broker, current.token), true);
});

test("a failure after admission retains execution uncertainty even with a closed-turn error code", { timeout: 10_000 }, async t => {
  const receipts = [];
  const { broker, service, connect } = await fixture(t, { onDiagnostic: receipt => receipts.push(receipt) });
  const turn = register(broker, "admitted-failure"), turnHash = createHash("sha256").update(turn.token).digest("hex");
  const { client } = await connect();
  const invoke = broker.invoke;
  let invocations = 0;
  broker.invoke = (...args) => { invocations += 1; return invoke(...args); };
  const pending = call(client, turn, "read");
  const [native] = await nativeCalls(broker, turn.token);
  assert.equal(native.type, "function_call");
  assert.equal(broker.cancel(turn.token, Object.assign(new Error("private outcome is unknown"), { code: "web_tool_turn_closed" })), true);
  const rejected = await pending;
  assert.deepEqual(rejected, { isError: true, content: [{ type: "text", text: "Codex tool request failed or the turn is closed. Do not retry a cancelled or timed-out turn." }] });
  assert.equal(invocations, 1);
  assert.equal(service.status().pending, 0);
  assert.deepEqual(withoutDiagnosticTime(receipts), [
    { operation: "call", stage: "received", turnHash },
    { operation: "call", stage: "invoke-started", turnHash },
    { operation: "call", stage: "rejected", turnHash },
  ]);
  for (const privateValue of [turn.token, "private outcome is unknown"]) {
    assert.equal(JSON.stringify({ rejected, receipts }).includes(privateValue), false);
  }
});

test("SDK discovery holds activity and invalidates an earlier completion observation", { timeout: 10_000 }, async t => {
  const { broker, connect } = await fixture(t);
  const turn = register(broker, "discovery-fence");
  const { client } = await connect();
  const before = broker.beginCompletion(turn.token);
  const list = broker.list;
  let observed = false;
  broker.list = token => {
    observed = true;
    assert.equal(broker.beginCompletion(token), undefined);
    assert.equal(broker.finish(token, before), false);
    return list(token);
  };
  const discovered = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
  assert.equal(observed, true);
  assert.deepEqual(discoveryPage(discovered), list(turn.token));
  const after = broker.beginCompletion(turn.token);
  assert.equal(typeof after, "number");
  assert.notEqual(after, before);
  assert.equal(broker.finish(turn.token, before), false);
  assert.equal(broker.finish(turn.token, after), true);
  assert.equal((await call(client, turn, "read")).isError, true);
  assert.throws(() => broker.takeCalls(turn.token), { code: "web_tool_turn_closed" });
});

test("SDK invocation keeps completion fenced until its handler returns the actual native result", { timeout: 10_000 }, async t => {
  let diagnostics = 0;
  const { broker, service, connect } = await fixture(t, { onDiagnostic: () => {
    diagnostics += 1;
    if (diagnostics % 2) throw new Error("synchronous logger failure");
    return Promise.reject(new Error("asynchronous logger failure"));
  } });
  const turn = register(broker, "settlement-fence");
  const { client } = await connect();
  const before = broker.beginCompletion(turn.token);
  let entered, release;
  const settling = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  const invoke = broker.invoke;
  broker.invoke = async (...args) => {
    const result = await invoke(...args);
    entered();
    await held;
    return result;
  };
  const result = call(client, turn, "read", { arguments: { marker: "paired result" } });
  try {
    const [native] = await nativeCalls(broker, turn.token);
    assert.equal(broker.beginCompletion(turn.token), undefined);
    assert.equal(broker.finish(turn.token, before), false);
    broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "actual paired native result" }]);
    await settling;
    assert.deepEqual(broker.takeCalls(turn.token), []);
    assert.equal(service.status().pending, 1);
    assert.equal(broker.beginCompletion(turn.token), undefined);
    assert.equal(broker.finish(turn.token, before), false);
  } finally {
    release();
  }
  assert.deepEqual((await result).content, [{ type: "text", text: "actual paired native result" }]);
  assert.equal(diagnostics, 3);
  assert.equal(service.status().pending, 0);
  const after = broker.beginCompletion(turn.token);
  assert.equal(typeof after, "number");
  assert.notEqual(after, before);
  assert.equal(broker.finish(turn.token, before), false);
  assert.equal(broker.finish(turn.token, after), true);
  assert.equal((await call(client, turn, "read")).isError, true);
});

test("private observation wakes for real MCP discovery and native calls without losing earlier activity", { timeout: 10_000 }, async t => {
  const { broker, service, connect } = await fixture(t);
  const turn = register(broker, "observation");
  const { client } = await connect();
  const before = broker.revision(turn.token);
  const discovery = await beginObservation(broker, service, turn.token);
  const declarations = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
  assert.equal(discoveryPage(declarations).tools.length, 1);
  const discoveryResponse = await discovery.response;
  assert.equal(discoveryResponse.status, 200);
  const changed = await discoveryResponse.json();
  assert.equal(changed.closed, false);
  assert.ok(changed.revision > before);
  assert.equal(getEventListeners(discovery.signal, "abort").length, 0);

  // The activity already happened before HTTP subscription. It must still wake.
  const stale = await fetch(service.observationUrl(turn.token, before));
  assert.deepEqual(await stale.json(), { revision: broker.revision(turn.token), closed: false });
  const invocation = await beginObservation(broker, service, turn.token);
  const nativeResult = call(client, turn, "read", { arguments: { marker: "actual invocation" } });
  const invoked = await invocation.response;
  assert.equal(invoked.status, 200);
  assert.equal((await invoked.json()).closed, false);
  const [native] = await nativeCalls(broker, turn.token);
  assert.deepEqual(JSON.parse(native.arguments), { marker: "actual invocation" });
  broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "actual native result" }]);
  assert.equal((await nativeResult).content[0].text, "actual native result");
  const retirement = await beginObservation(broker, service, turn.token);
  const finalRevision = broker.revision(turn.token);
  assert.equal(finish(broker, turn.token), true);
  assert.deepEqual(await (await retirement.response).json(), { revision: finalRevision, closed: true });
  assert.deepEqual(await (await fetch(service.observationUrl(turn.token, finalRevision))).json(), { revision: finalRevision, closed: true });
});

test("observation disconnection and service shutdown unsubscribe without cancelling the native turn", { timeout: 10_000 }, async t => {
  const { broker, service } = await fixture(t);
  const turn = register(broker, "observation-disconnect");
  const controller = new AbortController();
  const first = await beginObservation(broker, service, turn.token, { signal: controller.signal });
  const disconnected = new Promise(resolve => first.signal.addEventListener("abort", resolve, { once: true }));
  const rejected = assert.rejects(first.response, /abort/iu);
  controller.abort();
  await Promise.all([rejected, disconnected]);
  assert.equal(getEventListeners(first.signal, "abort").length, 0);
  assert.equal(broker.list(turn.token).tools.length, 1);
  const second = await beginObservation(broker, service, turn.token);
  const stopped = assert.rejects(second.response, /fetch failed|socket|abort/iu);
  await service.close();
  await stopped;
  assert.equal(getEventListeners(second.signal, "abort").length, 0);
  assert.equal(broker.list(turn.token).tools.length, 1);
  assert.equal(finish(broker, turn.token), true);
});

test("an aborted observation can renew immediately before HTTP disconnect cleanup finishes", { timeout: 10_000 }, async t => {
  const { broker, service } = await fixture(t);
  const turn = register(broker, "observation-handoff");
  const controller = new AbortController();
  const previous = await beginObservation(broker, service, turn.token, { signal: controller.signal });
  const rejected = assert.rejects(previous.response, /abort/iu);
  controller.abort();
  // Start the replacement without awaiting the previous HTTP request's close.
  const next = await beginObservation(broker, service, turn.token);
  await rejected;
  broker.update(turn.token, { tools: [fn("changed_read")] });
  const response = await next.response;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1, closed: false });
  assert.equal(broker.list(turn.token).tools.length, 1);
  assert.equal(finish(broker, turn.token), true);
});

test("observation rejects foreign capabilities, origins, malformed revisions, and duplicate waits", { timeout: 10_000 }, async t => {
  const { broker, service } = await fixture(t);
  const turn = register(broker, "observation-validation");
  const url = service.observationUrl(turn.token, broker.revision(turn.token));
  assert.equal((await fetch(new URL(`/wrong/observe/${turn.token}?revision=0`, url))).status, 404);
  assert.equal((await fetch(url, { headers: { origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await fetch(url.replace(turn.token, "web_turn_00000000000000000000000000000000"))).status, 409);
  for (const query of ["", "revision=-1", "revision=01", "revision=1", "revision=0.5", "revision=9007199254740992", "revision=0&other=1"]) {
    const malformed = await fetch(url.slice(0, url.indexOf("?")) + (query ? `?${query}` : ""));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes(turn.token), false);
  }
  assert.throws(() => service.observationUrl("unknown", 0));
  assert.throws(() => service.observationUrl(turn.token, 1));
  const pending = await beginObservation(broker, service, turn.token);
  const handoff = await beginObservation(broker, service, turn.token);
  const duplicate = await fetch(url);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.headers.get("access-control-allow-origin"), null);
  assert.equal((await duplicate.text()).includes(turn.token), false);
  broker.cancel(turn.token);
  const response = await pending.response;
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { revision: 0, closed: true });
  assert.deepEqual(await (await handoff.response).json(), { revision: 0, closed: true });
});

test("observation capacity is bounded across turns and released when waits finish", { timeout: 10_000 }, async t => {
  const receipts = [];
  const { broker, service } = await fixture(t, { onDiagnostic: receipt => {
    receipts.push(receipt);
    if (receipts.length % 2) throw new Error("private synchronous logger failure");
    return Promise.reject(new Error("private asynchronous logger failure"));
  } });
  const turns = Array.from({ length: 33 }, (_, index) => register(broker, `observation-capacity-${index}`));
  const pending = [];
  for (const turn of turns.slice(0, 32)) {
    pending.push(await beginObservation(broker, service, turn.token));
    pending.push(await beginObservation(broker, service, turn.token));
  }
  const extra = turns.at(-1);
  const url = service.observationUrl(extra.token, broker.revision(extra.token));
  for (let index = 0; index < 2; index += 1) {
    const limited = await fetch(url, { headers: { authorization: "Bearer private-observation-header" } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.equal(limited.headers.get("retry-after"), null);
    assert.deepEqual(await limited.json(), { error: "MCP request rejected." });
  }
  assert.deepEqual(withoutDiagnosticTime(receipts), Array.from({ length: 2 }, () => ({
    operation: "http", stage: "admission-rejected", reason: "observation-capacity", httpStatus: 429, isError: true,
    sessions: 0, creating: 0, pending: 0, observations: 64,
  })));
  for (const privateValue of [url, service.url, ...turns.map(({ token }) => token), "private-"]) {
    assert.equal(JSON.stringify(receipts).includes(privateValue), false);
  }
  broker.cancel(turns[0].token);
  for (const wait of pending.splice(0, 2)) assert.equal((await (await wait.response).json()).closed, true);
  const admitted = await beginObservation(broker, service, extra.token);
  for (const turn of turns.slice(1)) broker.cancel(turn.token);
  for (const wait of [...pending, admitted]) assert.equal((await (await wait.response).json()).closed, true);
  assert.equal(receipts.length, 2);
});
