import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";

// End-to-end proof of the namespace relay through the REAL router: a routed
// request carrying the client's namespace toolset must reach the (mock)
// gateway with every namespace flattened into plain functions -- including the
// MCP namespaces (mcp__node_repl__js and friends) that LiteLLM's bridge drops
// when left as namespace entries -- and function calls streaming back must be
// restored to the client's native { name, namespace } shape. The router must
// not execute any app tool itself. The whole scenario runs twice and must
// produce byte-identical outgoing and incoming bodies (determinism).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const IMAGE =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, port: address.port };
}

function run(script, env) {
  const stateIsolation =
    env?.MODEL_ROUTER_STATE_DIR || env?.CODEX_ROUTER_STATE_DIR
      ? {}
      : { MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "relay-routing-state-")) };
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root,
    env: {
      ...process.env,
      ...stateIsolation,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

// The namespace inventory the Codex client actually sends on routed requests
// (legacy namespace with explicit schemas): plain tools, collaboration, codex_app, and MCP
// namespaces -- including mcp__node_repl, the in-app browser / computer-use
// runtime, and a server whose namespace name contains the delimiter.
function routedRequestPayload(stream = true, model = "openrouter/glm-5.3-flash") {
  return {
    model,
    stream,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_hist",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_hist", output: "{}" },
    ],
    tools: [
      {
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      { type: "function", name: "exec_command" },
      { type: "function", name: "view_image" },
      {
        type: "namespace",
        name: "collaboration",
        tools: [
          { type: "function", name: "spawn_agent" },
          { type: "function", name: "wait_agent" },
        ],
      },
      {
        type: "namespace",
        name: "codex_app",
        tools: [
          ...CODEX_APP_TOOLS[0].tools,
          { type: "function", name: "navigate_to_codex_page" },
          { type: "function", name: "read_thread_terminal" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__node_repl",
        tools: [
          { type: "function", name: "js" },
          { type: "function", name: "js_reset" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__codex_apps__github",
        tools: [
          {
            type: "function",
            name: "fetch_issue",
            inputSchema: {
              type: "object",
              properties: {
                owner: { type: "string" },
                repo: { type: "string" },
                issue_number: { type: "integer", minimum: 1 },
              },
              required: ["owner", "repo", "issue_number"],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  };
}

// Reproduce the reported Codex 0.149.1 custom-provider shape: namespace tools
// are already flat when they reach the router, while canonical turn metadata
// still carries the native identity Codex will use for dispatch.
function routedToolSearchHistoryPayload(
  stream = true,
  model = "openrouter/glm-5.3-flash",
) {
  const payload = routedRequestPayload(stream, model);
  payload.tools.push({
    type: "function",
    name: "mcp__calendar__create_event",
    description: "Current live schema.",
    parameters: {
      type: "object",
      properties: { live: { type: "boolean" } },
    },
  });
  payload.input.push(
    {
      type: "tool_search_call",
      call_id: "search-history-1",
      execution: "client",
      arguments: { query: "calendar", limit: 2 },
    },
    {
      type: "tool_search_call",
      call_id: "search-history-2",
      execution: "client",
      arguments: { query: "mail", limit: 1 },
    },
    {
      type: "tool_search_output",
      call_id: "search-history-1",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__calendar",
          description: "Calendar tools.",
          tools: [
            {
              type: "function",
              name: "create_event",
              parameters: {
                type: "object",
                properties: { stale: { type: "string" } },
              },
            },
            {
              type: "function",
              name: "delete_event",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    },
    {
      type: "tool_search_output",
      call_id: "search-history-2",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "function",
          name: "list_messages",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    },
  );
  return payload;
}

function sseEvent(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// The gateway answers with an SSE stream carrying function calls in the
// flattened form a chat-completions bridge would emit, plus one ordinary call.
function gatewaySseBody() {
  return [
    sseEvent({ type: "response.created" }),
    sseEvent({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_thread",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_explicit_thread",
        arguments: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__send_message_to_thread",
        call_id: "call_followup",
        arguments: JSON.stringify({ threadId: "thread_1", prompt: "continue" }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_cloud_thread",
        arguments: JSON.stringify({
          prompt: "cloud",
          target: { type: "chatgptWorkCloud" },
        }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_agent",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "tool_search",
        call_id: "call_search",
        arguments: JSON.stringify({ query: "calendar", limit: 2 }),
      },
    }),
    sseEvent({ type: "response.completed" }),
    "data: [DONE]\n\n",
  ].join("");
}

function gatewayJsonBody() {
  return {
    id: "resp_json",
    output: [
      {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_thread",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_explicit_thread",
        arguments: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
      {
        type: "function_call",
        name: "codex_app__send_message_to_thread",
        call_id: "call_followup",
        arguments: JSON.stringify({ threadId: "thread_1", prompt: "continue" }),
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_cloud_thread",
        arguments: JSON.stringify({
          prompt: "cloud",
          target: { type: "chatgptWorkCloud" },
        }),
      },
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "tool_search",
        call_id: "call_search",
        arguments: JSON.stringify({ query: "calendar", limit: 2 }),
      },
    ],
  };
}

function responseItemsFromSse(body) {
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.item) items.push(event.item);
  }
  return items;
}

function functionCallsFromSse(body) {
  const calls = new Map();
  for (const item of responseItemsFromSse(body)) {
    if (item?.type === "function_call") calls.set(item.call_id, item);
  }
  return calls;
}

async function scenario(
  stream = true,
  {
    endpoint = "/responses",
    model = "openrouter/glm-5.3-flash",
    sseBody = gatewaySseBody,
    jsonBody = gatewayJsonBody,
    requestPayload = routedRequestPayload,
    routerEnv = {},
    prepareRouterEnv,
    expectedStatus = 200,
  } = {},
) {
  const gatewayBodies = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.url === "/v1/responses") {
      const gatewayBody = await bodyJson(request);
      gatewayBodies.push(gatewayBody);
      if (gatewayBody.stream === false) {
        json(response, 200, jsonBody(gatewayBody));
        return;
      }
      const body = Buffer.from(sseBody(gatewayBody), "utf8");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Content-Length": String(body.length),
      });
      response.end(body);
      return;
    }
    json(response, 404, { error: { message: `unexpected ${request.url}` } });
  });
  const routerPort = await openPort();
  const preparedRouterEnv = prepareRouterEnv
    ? prepareRouterEnv({ gatewayPort: gateway.port })
    : {};
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
    ...routerEnv,
    ...preparedRouterEnv,
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload(stream, model)),
    });
    assert.equal(response.status, expectedStatus, `router status ${response.status}`);
    const clientBody = await response.text();
    return { gatewayBodies, clientBody, router, status: response.status };
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
}

test("routed request flattens every namespace to the gateway and restores calls to the client", async () => {
  const first = await scenario();
  const outgoing = first.gatewayBodies[0];
  assert.equal(outgoing.model, "openrouter-glm-5-3-flash");
  const names = outgoing.tools.map((tool) => tool.name);

  // The full native toolset reaches the provider in the flattened form,
  // including the MCP namespaces the bridge drops when left as namespace
  // entries.
  assert.ok(names.includes("collaboration__spawn_agent"), "collaboration flattened");
  assert.ok(names.includes("codex_app__create_thread"), "supplied codex_app tool flattened");
  assert.ok(names.includes("mcp__node_repl__js"), "node_repl js flattened");
  assert.ok(names.includes("mcp__node_repl__js_reset"), "node_repl js_reset flattened");
  assert.ok(names.includes("tool_search"), "native tool_search exposed as a function");
  assert.ok(
    names.includes("mcp__codex_apps__github__fetch_issue"),
    "nested-namespace MCP tool flattened",
  );
  assert.ok(names.includes("exec_command"), "plain tools untouched");
  assert.ok(
    outgoing.tools.every((tool) => tool?.type !== "namespace"),
    "no namespace entries reach the gateway",
  );
  assert.ok(
    outgoing.tools.every((tool) => tool?.type !== "tool_search"),
    "native deferred-search controls do not reach a function-only provider",
  );
  const toolSearch = outgoing.tools.find((tool) => tool.name === "tool_search");
  assert.equal(toolSearch.type, "function");
  assert.deepEqual(toolSearch.parameters.required, ["query"]);
  // The supplied codex_app tool definitions keep their schema.
  const createThread = outgoing.tools.find((tool) => tool.name === "codex_app__create_thread");
  assert.ok(createThread?.inputSchema, "create_thread schema survives the relay");
  assert.equal(createThread.inputSchema.type, "object");
  const fetchIssue = outgoing.tools.find(
    (tool) => tool.name === "mcp__codex_apps__github__fetch_issue",
  );
  assert.deepEqual(fetchIssue?.parameters, {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      issue_number: { type: "integer", minimum: 1 },
    },
    required: ["owner", "repo", "issue_number"],
    additionalProperties: false,
  });

  // Stored namespaced calls in the input history are renamed to match the
  // flattened tool list the model sees.
  const historyCall = outgoing.input.find((item) => item?.type === "function_call");
  assert.equal(historyCall.name, "codex_app__create_thread");
  assert.equal(historyCall.namespace, undefined);
  // Historical calls are evidence, not fresh outbound actions. Rewriting
  // their model would change the transcript the provider is meant to see.
  assert.deepEqual(JSON.parse(historyCall.arguments), {});

  // Function calls streaming back are restored to the client's native
  // namespace shape so the app dispatches them itself.
  const calls = functionCallsFromSse(first.clientBody);
  assert.deepEqual(
    { name: calls.get("call_browser").name, namespace: calls.get("call_browser").namespace },
    { name: "js", namespace: "mcp__node_repl" },
  );
  assert.deepEqual(
    { name: calls.get("call_thread").name, namespace: calls.get("call_thread").namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(calls.get("call_thread").arguments), {
    model: "openrouter/glm-5.3-flash",
  });
  assert.deepEqual(JSON.parse(calls.get("call_explicit_thread").arguments), {
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(JSON.parse(calls.get("call_followup").arguments), {
    threadId: "thread_1",
    prompt: "continue",
  });
  assert.deepEqual(JSON.parse(calls.get("call_cloud_thread").arguments), {
    prompt: "cloud",
    target: { type: "chatgptWorkCloud" },
  });
  assert.deepEqual(
    { name: calls.get("call_agent").name, namespace: calls.get("call_agent").namespace },
    { name: "spawn_agent", namespace: "collaboration" },
  );
  // Ordinary calls pass through untouched -- no namespace invented.
  assert.equal(calls.get("call_exec").name, "exec_command");
  assert.equal(calls.get("call_exec").namespace, undefined);
  const searchCall = responseItemsFromSse(first.clientBody).find(
    (item) => item.call_id === "call_search",
  );
  assert.deepEqual(searchCall, {
    type: "tool_search_call",
    call_id: "call_search",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
  // The router never executed any app tool: the gateway saw exactly one
  // request and the client saw exactly the relayed calls.
  assert.equal(first.gatewayBodies.length, 1);
});

test("non-streaming routed responses restore namespace calls before client dispatch", async () => {
  const result = await scenario(false);
  assert.equal(result.gatewayBodies.length, 1);
  assert.equal(result.gatewayBodies[0].stream, false);

  const client = JSON.parse(result.clientBody);
  assert.deepEqual(
    { name: client.output[0].name, namespace: client.output[0].namespace },
    { name: "js", namespace: "mcp__node_repl" },
  );
  assert.deepEqual(
    { name: client.output[1].name, namespace: client.output[1].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[1].arguments), {
    model: "openrouter/glm-5.3-flash",
  });
  assert.deepEqual(JSON.parse(client.output[2].arguments), {
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(
    { name: client.output[2].name, namespace: client.output[2].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[3].arguments), {
    threadId: "thread_1",
    prompt: "continue",
  });
  assert.deepEqual(
    { name: client.output[3].name, namespace: client.output[3].namespace },
    { name: "send_message_to_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[4].arguments), {
    prompt: "cloud",
    target: { type: "chatgptWorkCloud" },
  });
  assert.deepEqual(
    { name: client.output[4].name, namespace: client.output[4].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.equal(client.output[5].name, "exec_command");
  assert.equal(client.output[5].namespace, undefined);
  assert.deepEqual(client.output[6], {
    type: "tool_search_call",
    call_id: "call_search",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
});

test("routed tool_search history declares discovered tools and restores their calls", async () => {
  const searchedCall = {
    type: "function_call",
    name: "mcp__calendar__delete_event",
    call_id: "delete-1",
    arguments: JSON.stringify({ id: "evt-1" }),
  };
  const options = {
    requestPayload: routedToolSearchHistoryPayload,
    sseBody: () =>
      [
        sseEvent({ type: "response.output_item.done", item: searchedCall }),
        sseEvent({
          type: "response.completed",
          response: { id: "resp-search", output: [searchedCall] },
        }),
        "data: [DONE]\n\n",
      ].join(""),
    jsonBody: () => ({ id: "resp-search-json", output: [searchedCall] }),
  };

  for (const stream of [true, false]) {
    const result = await scenario(stream, options);
    const outgoing = result.gatewayBodies[0];
    const historyCall = outgoing.input.find(
      (item) => item.call_id === "search-history-1" && item.type === "function_call",
    );
    assert.deepEqual(historyCall, {
      type: "function_call",
      name: "tool_search",
      call_id: "search-history-1",
      arguments: '{"query":"calendar","limit":2}',
    });
    assert.deepEqual(
      outgoing.input.find(
        (item) => item.call_id === "search-history-2" && item.type === "function_call",
      ),
      {
        type: "function_call",
        name: "tool_search",
        call_id: "search-history-2",
        arguments: '{"query":"mail","limit":1}',
      },
    );
    const historyOutput = outgoing.input.find(
      (item) =>
        item.call_id === "search-history-1" && item.type === "function_call_output",
    );
    const discovered = JSON.parse(historyOutput.output).tools;
    assert.equal(discovered.length, 2, "a distinct namespaced identity cannot be shadowed by a plain wire spelling");
    assert.notEqual(discovered[0].name, "mcp__calendar__create_event");
    assert.equal(discovered[1].name, "mcp__calendar__delete_event");
    assert.ok(outgoing.tools.some(tool => tool.name === discovered[0].name));
    const secondHistoryOutput = outgoing.input.find(
      (item) =>
        item.call_id === "search-history-2" && item.type === "function_call_output",
    );
    assert.deepEqual(
      JSON.parse(secondHistoryOutput.output).tools.map((tool) => tool.name),
      ["list_messages"],
    );
    assert.equal(
      outgoing.input.some(
        (item) => item.type === "tool_search_call" || item.type === "tool_search_output",
      ),
      false,
      "batched native search history never leaks to a chat-completions provider",
    );
    assert.equal(
      outgoing.tools.filter((tool) => tool.name === "mcp__calendar__create_event").length,
      1,
      "the live plain schema retains its name beside the distinct discovered namespace identity",
    );
    assert.ok(
      outgoing.tools.some((tool) => tool.name === "mcp__calendar__delete_event"),
      "the searched tool is declared to the chat-completions provider",
    );
    assert.ok(outgoing.tools.some((tool) => tool.name === "list_messages"));

    const clientCall = stream
      ? responseItemsFromSse(result.clientBody).find((item) => item.call_id === "delete-1")
      : JSON.parse(result.clientBody).output[0];
    assert.deepEqual(clientCall, {
      type: "function_call",
      name: "delete_event",
      namespace: "mcp__calendar",
      call_id: "delete-1",
      arguments: '{"id":"evt-1"}',
    });
  }
});

// Live Codex 0.153.4 / LiteLLM regression: reasoning and assistant text reuse
// one id, followed by a current app call. Preserve strict namespace validation.
test("GLM message identity repair keeps current app calls dispatchable and never injects interrupts", async () => {
  for (const model of ["openrouter/glm-5.3-flash", "openrouter/glm-5.3-flash-gmicloud"]) {
    const message = { id: "shared", type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] };
    const reasoning = { id: "shared", type: "reasoning", summary: [] };
    const call = { id: "fc_app", type: "function_call", call_id: "call_app", name: "mcp__codex_app__list_projects", arguments: "{}" };
    const followup = { id: "fc_followup", type: "function_call", call_id: "call_followup", name: "collaboration__followup_task", arguments: '{"target":"child","message":"continue"}' };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "shared", delta: "Checking." },
      { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "shared", text: "Checking." },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
      { type: "response.output_item.done", output_index: 2, item: call },
      { type: "response.output_item.added", output_index: 3, item: { ...followup, arguments: "" } },
      { type: "response.output_item.done", output_index: 3, item: followup },
      { type: "response.completed", response: { status: "completed", output: [reasoning, message, call, followup] } },
    ];
    const result = await scenario(true, {
      model,
      sseBody: () => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      requestPayload: (stream, model) => ({ model, stream,
        input: [{ type: "agent_message", content: "Message Type: FINAL_ANSWER\nSender: /root/child\nPayload: done" }],
        tools: [
          { type: "namespace", name: "mcp__codex_app", tools: [{ type: "function", name: "list_projects", parameters: { type: "object", properties: {} } }] },
          { type: "namespace", name: "collaboration", tools: ["followup_task", "interrupt_agent"].map(name => ({ type: "function", name, parameters: { type: "object" } })) },
        ],
      }),
    });
    assert.deepEqual(result.gatewayBodies[0].tools.map(tool => tool.name), ["mcp__codex_app__list_projects", "collaboration__followup_task", "collaboration__interrupt_agent"]);
    const received = result.clientBody.split("\n\n").filter(Boolean).map(block => JSON.parse(block.slice(6)));
    const restored = received.filter(event => event.type === "response.output_item.done").map(event => event.item);
    assert.equal(restored[0].id, "shared");
    assert.notEqual(restored[1].id, "shared");
    for (const event of received.filter(event => event.item_id && !event.type.includes("function_call"))) assert.equal(event.item_id, restored[1].id);
    assert.equal(restored[2].namespace, "mcp__codex_app");
    assert.equal(restored[2].name, "list_projects");
    assert.equal(restored[3].name, "followup_task");
    assert.equal(restored[3].namespace, "collaboration");
    assert.deepEqual(received.at(-1).response.output, restored);
    assert.doesNotMatch(result.clientBody, /interrupt_agent/);
  }
});
