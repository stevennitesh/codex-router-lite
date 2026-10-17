import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startWebMcp } from "../src/web-mcp.mjs";
import { createWebToolBroker } from "../src/web-tools.mjs";

const fn = name => ({ type: "function", name, description: "Native tool", parameters: { type: "object", properties: {} } });
const register = (broker, turnId, tools = [fn("read")]) => broker.register({ threadId: "native-thread", turnId, tools });
const call = (client, turn, wireName, args = {}) => client.callTool({ name: "codex_tool_call", arguments: { turn_token: turn.token, wire_name: wireName, ...args } });

async function fixture(t, options = {}) {
  const broker = createWebToolBroker({ invocationTimeoutMs: 5_000 });
  const service = await startWebMcp({ broker, ...options });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(({ client }) => client.close()));
    await service.close();
  });
  const connect = async () => {
    const client = new Client({ name: "native-web-bridge-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(service.url));
    clients.push({ client, transport });
    await client.connect(transport);
    return { client, transport };
  };
  return { broker, service, connect };
}

test("SDK HTTP client initializes, discovers current native tools, and waits for native execution", { timeout: 10_000 }, async t => {
  const { broker, service, connect } = await fixture(t);
  const turn = register(broker, "function", [{ type: "namespace", name: "mcp__files", tools: [fn("read")] }]);
  const { client, transport } = await connect();
  assert.match(transport.sessionId, /^[a-f0-9-]{36}$/u);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ["codex_tools_list", "codex_tool_call"]);
  assert.equal(listed.tools[1].annotations.readOnlyHint, false);
  assert.equal(listed.tools[1].annotations.destructiveHint, true);
  const declarations = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } });
  assert.deepEqual(declarations.structuredContent.tools, turn.tools);
  let resolved = false;
  const waiting = broker.waitForCalls(turn.token);
  const result = call(client, turn, "mcp__files__read", { arguments: { path: "native.txt" } });
  void result.then(() => { resolved = true; });
  const [native] = await waiting;
  assert.equal(native.type, "function_call");
  assert.equal(native.namespace, "mcp__files");
  assert.equal(native.name, "read");
  assert.deepEqual(JSON.parse(native.arguments), { path: "native.txt" });
  assert.equal(resolved, false);
  assert.equal(service.status().pending, 1);
  // Only the actual native caller may supply the output that resolves MCP.
  broker.complete(turn.token, [{ type: "function_call_output", call_id: native.call_id, output: "actual native result" }]);
  assert.deepEqual((await result).content, [{ type: "text", text: "actual native result" }]);
  assert.equal(broker.finish(turn.token), true);
  assert.equal(service.status().pending, 0);
});

test("concurrent ChatGPT sessions retain exact turn identity and raw custom input", { timeout: 10_000 }, async t => {
  const { broker, connect } = await fixture(t);
  const first = register(broker, "first");
  const second = register(broker, "second", [{ type: "namespace", name: "functions", tools: [
    { type: "custom", name: "exec", description: "Native code tool", format: { type: "text" } },
  ] }]);
  const [{ client: one }, { client: two }] = await Promise.all([connect(), connect()]);
  const waitingOne = broker.waitForCalls(first.token), waitingTwo = broker.waitForCalls(second.token);
  const input = "text('native caller executes this');\n$not_a_shell_command";
  const resultOne = call(one, first, "read", { arguments: { marker: "one" } });
  const resultTwo = call(two, second, second.tools[0].wireName, { input });
  const [[nativeOne], [nativeTwo]] = await Promise.all([waitingOne, waitingTwo]);
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
  assert.equal(broker.finish(first.token), true);
  assert.equal(broker.finish(second.token), true);
});

test("SDK cancellation retires only its native turn and notifies the generation owner", { timeout: 10_000 }, async t => {
  let cancelled;
  const observed = new Promise(resolve => { cancelled = resolve; });
  const { broker, service, connect } = await fixture(t, { onCancel: token => cancelled(token) });
  const first = register(broker, "cancel"), second = register(broker, "retained");
  const { client } = await connect();
  const waiting = broker.waitForCalls(first.token);
  const controller = new AbortController();
  const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: first.token, wire_name: "read" } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/iu);
  const [native] = await waiting;
  controller.abort(new Error("test cancellation"));
  await rejected;
  assert.equal(await observed, first.token);
  assert.throws(() => broker.list(first.token), { code: "web_tool_turn_closed" });
  assert.throws(() => broker.complete(first.token, [{ type: "function_call_output", call_id: native.call_id, output: "late" }]));
  assert.equal(broker.list(second.token).length, 1);
  await service.close();
  assert.equal(service.status().listening, false);
});

test("session termination and server close cancel unresolved native calls", { timeout: 10_000 }, async t => {
  const seen = [];
  const { broker, service, connect } = await fixture(t, { onCancel: token => { seen.push(token); } });
  const first = register(broker, "delete"), second = register(broker, "close");
  const [{ client: one, transport }, { client: two }] = await Promise.all([connect(), connect()]);
  const waitingOne = broker.waitForCalls(first.token), waitingTwo = broker.waitForCalls(second.token);
  const resultOne = call(one, first, "read"), resultTwo = call(two, second, "read");
  // A closed transport may reject the caller; either way it must retire native work.
  const settled = Promise.allSettled([resultOne, resultTwo]);
  await Promise.all([waitingOne, waitingTwo]);
  await transport.terminateSession();
  assert.throws(() => broker.list(first.token), { code: "web_tool_turn_closed" });
  assert.equal(broker.list(second.token).length, 1);
  await service.close();
  await settled;
  assert.throws(() => broker.list(second.token), { code: "web_tool_turn_closed" });
  assert.deepEqual(new Set(seen), new Set([first.token, second.token]));
  assert.deepEqual(service.status(), { listening: false, sessions: 0, pending: 0 });
});

test("capability, method, origin, schema, and stale token failures cannot enqueue tools", { timeout: 10_000 }, async t => {
  const { broker, service, connect } = await fixture(t);
  const turn = register(broker, "validation");
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
  const unknown = await call(client, { token: "web_turn_00000000000000000000000000000000" }, "read");
  assert.equal(unknown.isError, true);
  const undeclared = await call(client, turn, "never_declared");
  assert.equal(undeclared.isError, true);
  assert.deepEqual(broker.takeCalls(turn.token), []);
  assert.equal(service.status().pending, 0);
  assert.equal(broker.finish(turn.token), true);
  assert.equal((await client.callTool({ name: "codex_tools_list", arguments: { turn_token: turn.token } })).isError, true);
});
