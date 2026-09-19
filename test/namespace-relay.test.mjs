import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  NamespaceToolCallTransform,
  aliasHistoricalFunctionNames,
  bridgeCustomTools,
  buildNamespaceLookups,
  flattenNamespaceTools,
  rewriteNamespaceResponsePayload,
  restorePreflattenedToolNamespaces,
} from "../src/namespace-relay.mjs";
import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";

test("ordinary empty-call diagnostics locate the boundary without inventing arguments or logging content", async () => {
  const flat = flattenNamespaceTools([{ type: "namespace", name: "collaboration", tools: [
    { type: "function", name: "send_message", parameters: { type: "object" } },
  ] }]);
  for (const [streamed, completed] of [["", ""], ['{"message":"PRIVATE_FIXTURE"}', ""], ['{"message":"PRIVATE_FIXTURE"}', '{"message":"PRIVATE_FIXTURE"}']]) {
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: flat.tools[0].name, arguments: "" };
    const events = [
      { type: "response.output_item.added", item: call },
      { type: "response.function_call_arguments.delta", item_id: call.id, delta: streamed },
      { type: "response.function_call_arguments.done", item_id: call.id, arguments: streamed },
      { type: "response.output_item.done", item: { ...call, arguments: completed } },
    ];
    const wire = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const transform = new NamespaceToolCallTransform(flat.namespaces, "text/event-stream");
    const diagnostics = [];
    transform.on("diagnostic", diagnostic => diagnostics.push(diagnostic));
    const output = await collect(Readable.from([...Buffer.from(wire)].map(b => Buffer.from([b]))).pipe(transform));
    const restored = output.trim().split("\n\n").map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data:")).slice(5)));
    assert.equal(restored.at(-1).item.arguments, completed);
    assert.equal(restored.at(-1).item.namespace, "collaboration");
    assert.equal(diagnostics.length, completed ? 0 : 1);
    if (!completed) assert.deepEqual(diagnostics[0], { code: "empty_function_arguments", sourceCharacters: 0,
      restoredCharacters: 0, deltaCharacters: streamed.length, doneCharacters: streamed.length });
    assert.ok(!JSON.stringify(diagnostics).includes("PRIVATE_FIXTURE"));
  }
});

test("invalid historical function names retain rejected calls, results, and reversible identity without granting tools", () => {
  const flat = flattenNamespaceTools([{ type: "function", name: "available", parameters: {} }], { maxNameLength: 64 });
  const call = { type: "function_call", name: "desktop_probe.list_projects", arguments: "{}", call_id: "rejected" };
  const result = { type: "function_call_output", call_id: "rejected", output: "unsupported call: desktop_probe.list_projects" };
  const first = aliasHistoricalFunctionNames([call, result], flat.namespaces);
  assert.match(first[0].name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(first[0].call_id, call.call_id);
  assert.equal(first[0].arguments, call.arguments);
  assert.equal(first[1], result);
  assert.deepEqual(flat.tools.map(t => t.name), ["available"]);
  assert.equal(call.name, "desktop_probe.list_projects");
  const restored = rewriteNamespaceResponsePayload({ output: [{ ...first[0], call_id: "new-attempt" }] }, buildNamespaceLookups(flat.namespaces));
  assert.equal(restored.output[0].name, call.name);
  assert.equal(restored.output[0].call_id, "new-attempt");
  assert.equal(aliasHistoricalFunctionNames(first, flat.namespaces), first);
  const occupied = flattenNamespaceTools([{ type: "function", name: first[0].name, parameters: {} }]);
  const collision = aliasHistoricalFunctionNames([call, result, { ...call, name: first[0].name, call_id: "valid" }], occupied.namespaces);
  assert.notEqual(collision[0].name, first[0].name);
  assert.equal(collision[2].name, first[0].name);
  const declaredOnly = flattenNamespaceTools([{ type: "function", name: first[0].name, parameters: {} }]);
  assert.notEqual(aliasHistoricalFunctionNames([call, result], declaredOnly.namespaces)[0].name, first[0].name);
});

test("preflattened identities require a unique declared tool and preserve literal plain names", () => {
  const declaration = { type: "custom", name: "harness__exec", format: { type: "text" } };
  const metadata = (ordinary = {}) => ({ "x-codex-turn-metadata": JSON.stringify({ tool_namespaces_info: {
    harness: { name: "harness", functions: {
      exec: { name: "exec", direct: true, source: { kind: "harness" } },
      absent: { name: "absent", direct: true, source: { kind: "harness" } },
    } },
    functions: { name: "functions", functions: ordinary },
  } }) });
  assert.deepEqual(restorePreflattenedToolNamespaces([declaration], metadata()), [
    { type: "namespace", name: "harness", tools: [{ ...declaration, name: "exec" }] },
  ]);
  const tools = [declaration];
  assert.equal(restorePreflattenedToolNamespaces(tools, metadata({ "harness__exec": { name: "harness__exec" } })), tools);
  const duplicates = [declaration, { type: "function", name: declaration.name, parameters: {} }];
  assert.equal(restorePreflattenedToolNamespaces(duplicates, metadata()), duplicates);
  assert.deepEqual(restorePreflattenedToolNamespaces([], metadata()), []);
  assert.equal(restorePreflattenedToolNamespaces(tools, {}), tools);
});

function collect(stream) {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    stream.on("end", () => resolve(output));
    stream.on("error", reject);
  });
}

function collectBuffer(stream) {
  return new Promise((resolve, reject) => {
    const output = [];
    stream.on("data", (chunk) => output.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(output)));
    stream.on("error", reject);
  });
}

async function collectUntilPipelineError(chunks, transform) {
  const output = [];
  let error;
  try {
    await pipeline(
      Readable.from(chunks),
      transform,
      new Writable({
        write(chunk, _encoding, callback) {
          output.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "the transform should fail after committing semantic output");
  return { output: Buffer.concat(output), error };
}

// The reduced codex_app namespace the client actually sends on routed requests
// (captured live: load_workspace_dependencies, navigate_to_codex_page,
// read_thread_terminal), plus the collaboration and MCP namespaces that
// LiteLLM's Responses -> Chat Completions bridge drops unless flattened.
function clientRoutedTools() {
  return [
    { type: "function", name: "exec_command" },
    { type: "function", name: "view_image" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          inputSchema: {
            type: "object",
            properties: {
              model: {
                anyOf: [
                  { type: "string", enum: ["gpt-5.6-sol", "gpt-5.6-terra"] },
                  { type: "null" },
                ],
              },
            },
          },
        },
        { type: "function", name: "wait_agent" },
      ],
    },
    {
      type: "namespace",
      name: "codex_app",
      tools: [
        { type: "function", name: "load_workspace_dependencies" },
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
      tools: [{ type: "function", name: "fetch_issue" }],
    },
  ];
}

function clientToolSearchControl() {
  return {
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
  };
}

test("flattenNamespaceTools flattens every namespace, including MCP ones", () => {
  const { tools, flattened, namespaces } = flattenNamespaceTools(clientRoutedTools());
  assert.equal(flattened, true);
  const names = tools.map((tool) => tool.name);
  // Plain tools untouched.
  assert.ok(names.includes("exec_command"));
  assert.ok(names.includes("view_image"));
  // Collaboration flattened.
  assert.ok(names.includes("collaboration__spawn_agent"));
  assert.ok(names.includes("collaboration__wait_agent"));
  // App tools flattened.
  assert.ok(names.includes("codex_app__load_workspace_dependencies"));
  assert.ok(names.includes("codex_app__navigate_to_codex_page"));
  assert.ok(names.includes("codex_app__read_thread_terminal"));
  // MCP namespaces flattened -- the browser/computer-use runtime (node_repl
  // js) and MCP servers whose namespace names themselves contain the
  // delimiter.
  assert.ok(names.includes("mcp__node_repl__js"));
  assert.ok(names.includes("mcp__node_repl__js_reset"));
  assert.ok(names.includes("mcp__codex_apps__github__fetch_issue"));
  // No namespace entries survive.
  assert.ok(tools.every((tool) => tool?.type !== "namespace"), "no namespace entries remain");
  // The map records exactly the flattened namespaces and their tools.
  assert.deepEqual([...namespaces.get("collaboration")].sort(), ["spawn_agent", "wait_agent"]);
  assert.deepEqual([...namespaces.get("mcp__node_repl")].sort(), ["js", "js_reset"]);
  assert.deepEqual([...namespaces.get("mcp__codex_apps__github")], ["fetch_issue"]);
});

test("full inventory survives merge + flatten with nothing dropped", () => {
  const asyncUserInput = {
    type: "function",
    name: "request_user_input_async",
    description: "Ask questions without ending the turn.",
    parameters: {
      type: "object",
      properties: {
        questions: { type: "array", items: { type: "object" } },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  };
  const inventory = [
    ...clientRoutedTools(),
    { type: "function", name: "write_stdin" },
    { type: "function", name: "update_plan" },
    { type: "function", name: "request_user_input" },
    asyncUserInput,
    { type: "function", name: "apply_patch" },
    { type: "function", name: "web_search" },
  ];
  const { tools, flattened } = flattenNamespaceTools([...inventory, ...CODEX_APP_TOOLS]);
  assert.equal(flattened, true);
  const names = tools.map((tool) => tool.name);
  // Nothing standard dropped.
  for (const name of [
    "exec_command",
    "write_stdin",
    "update_plan",
    "request_user_input",
    "request_user_input_async",
    "apply_patch",
    "view_image",
    "web_search",
  ]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  assert.deepEqual(
    tools.find((tool) => tool.name === "request_user_input_async"),
    asyncUserInput,
    "the catalog-gated async input schema must pass through unchanged",
  );
  // Agent tools present (flattened).
  for (const name of ["collaboration__spawn_agent", "collaboration__wait_agent"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // Explicitly supplied app tools remain available after flattening.
  for (const name of ["mcp__codex_app__create_thread", "mcp__codex_app__list_threads", "mcp__codex_app__automation_update", "mcp__codex_app__read_thread"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // MCP namespaces flattened too -- the old relay left them to the bridge,
  // which dropped them, so routed models never saw node_repl (the in-app
  // browser and computer-use runtime) or any other MCP server.
  assert.ok(names.includes("mcp__node_repl__js"), "mcp__node_repl__js must survive");
});

test("response transform restores flattened calls to the native namespace shape", async () => {
  const { namespaces } = flattenNamespaceTools([...clientRoutedTools(), ...CODEX_APP_TOOLS.map(tool => ({ ...tool, name: "codex_app" }))]);
  const events = [
    { type: "response.created" },
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_1",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_2",
        arguments: "{}",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_3",
        arguments: "{}",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__codex_apps__github__fetch_issue",
        call_id: "call_4",
        arguments: "{}",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "request_user_input_async",
        call_id: "call_5",
        arguments: '{"questions":[]}',
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new NamespaceToolCallTransform(namespaces);
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
  assert.match(output, /"name":"create_thread"/);
  assert.match(output, /"namespace":"codex_app"/);
  assert.match(output, /"name":"js"/);
  assert.match(output, /"namespace":"mcp__node_repl"/);
  assert.match(output, /"name":"fetch_issue"/);
  assert.match(output, /"namespace":"mcp__codex_apps__github"/);
  assert.match(output, /"name":"request_user_input_async"/);
  assert.doesNotMatch(output, /"name":"request_user_input_async","namespace"/);
  assert.doesNotMatch(output, /collaboration__spawn_agent|codex_app__create_thread|mcp__node_repl__js/);
});

test("response identity survives an unsupported function-call envelope", async () => {
  const payload = {
    id: "response_1",
    model: "gpt-6-astra",
    output: [{
      type: "function_call",
      call_id: "call_1",
      name: "unsupported_tool",
      arguments: "not valid JSON",
    }],
  };
  const transform = new NamespaceToolCallTransform(
    new Map(),
    "application/json",
    "switchyard/auto",
    { responseModel: "switchyard/auto" },
  );
  const output = await collect(Readable.from([JSON.stringify(payload)]).pipe(transform));
  const rewritten = JSON.parse(output.toString("utf8"));
  assert.equal(rewritten.model, "switchyard/auto");
  assert.deepEqual(rewritten.output, payload.output);
});

test("SSE identity restoration continues after an unsupported function-call envelope", async () => {
  const events = [
    { type: "response.created", response: { id: "r", model: "gpt-6-astra" } },
    {
      type: "response.in_progress",
      response: {
        id: "r",
        model: "gpt-6-astra",
        output: [{ type: "function_call", name: "unsupported", arguments: "not JSON" }],
      },
    },
    { type: "response.completed", response: { id: "r", model: "gpt-6-astra", output: [] } },
  ];
  const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const chunkings = [
    [wire],
    [...Buffer.from(wire)].map((byte) => Buffer.from([byte])),
  ];
  for (const chunks of chunkings) {
    const transform = new NamespaceToolCallTransform(
      new Map(),
      "text/event-stream",
      "switchyard/auto",
      { responseModel: "switchyard/auto" },
    );
    const output = await collect(Readable.from(chunks).pipe(transform));
    const payloads = output.trim().split("\n\n")
      .map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
    assert.deepEqual(payloads.map((event) => event.response.model), [
      "switchyard/auto",
      "switchyard/auto",
      "switchyard/auto",
    ]);
    assert.deepEqual(payloads[1].response.output, events[1].response.output);
  }
});

test("unsupported SSE envelopes fail closed after a tool rewrite was committed", async () => {
  const { tools, namespaces } = flattenNamespaceTools([{
    type: "namespace",
    name: "collaboration",
    tools: [{ type: "function", name: "send_message", parameters: { type: "object" } }],
  }]);
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: tools[0].name,
        arguments: "{}",
      },
    },
    {
      type: "response.in_progress",
      response: {
        id: "r",
        model: "gpt-6-astra",
        output: [{ type: "function_call", name: "unsupported", arguments: "not JSON" }],
      },
    },
  ];
  const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  let error;
  try {
    await collect(Readable.from(wire).pipe(new NamespaceToolCallTransform(
      namespaces,
      "text/event-stream",
      "switchyard/auto",
      { responseModel: "switchyard/auto" },
    )));
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.match(error.message, /ambiguous function arguments/u);
});

test("response transform drops a spawn-agent model override not offered by the tool schema", async () => {
  const { namespaces } = flattenNamespaceTools(clientRoutedTools());
  const lookups = buildNamespaceLookups(namespaces);
  const invalid = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "collaboration__spawn_agent",
          arguments: JSON.stringify({ message: "verify", model: "gpt-5.6-luna" }),
        },
      ],
    },
    lookups,
  );
  assert.deepEqual(JSON.parse(invalid.output[0].arguments), { message: "verify" });

  const valid = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "collaboration__spawn_agent",
          arguments: JSON.stringify({ message: "verify", model: "gpt-5.6-terra" }),
        },
      ],
    },
    lookups,
  );
  assert.deepEqual(JSON.parse(valid.output[0].arguments), {
    message: "verify",
    model: "gpt-5.6-terra",
  });
});

test("every flattened app tool reaches the provider with an object root", async () => {
  const { hasObjectRoot } = await import("../src/tool-schema-root.mjs");

  const { tools } = flattenNamespaceTools(CODEX_APP_TOOLS);

  const unionRooted = tools
    .filter((tool) => tool.parameters && !hasObjectRoot(tool.parameters))
    .map((tool) => tool.name);
  assert.deepEqual(unionRooted, [], "a union root fails the whole request, not the one tool");

  const automationUpdate = tools.find((tool) => tool.name === "mcp__codex_app__automation_update");
  assert.ok(automationUpdate, "automation_update is still relayed");
  assert.equal(automationUpdate.parameters.type, "object");
  assert.ok(
    Array.isArray(automationUpdate.inputSchema.oneOf),
    "inputSchema keeps the client's native union for responses-native routes",
  );
});

const V4A_GRAMMAR = [
  "start: begin_patch hunk+ end_patch",
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  "",
  "hunk: add_hunk | delete_hunk | update_hunk",
  'add_hunk: "*** Add File: " filename LF add_line+',
  'delete_hunk: "*** Delete File: " filename LF',
  'update_hunk: "*** Update File: " filename LF change_move? change?',
  "filename: /(.+)/",
  'add_line: "+" /(.+)/ LF -> line',
  "",
  'change_move: "*** Move to: " filename LF',
  "change: (change_context | change_line)+ eof_line?",
  'change_context: ("@@" | "@@ " /(.+)/) LF',
  'change_line: ("+" | "-" | " ") /(.+)/ LF',
  'eof_line: "*** End of File" LF',
  "",
  "%import common.LF",
].join("\n");

test("custom-tool bridge maps apply_patch definitions and paired history losslessly", () => {
  const namespaces = new Map();
  const patch = "*** Begin Patch\n*** Update File: seed.txt\n@@\n-before\n+after\n*** End Patch";
  const ordinary = { type: "function", name: "read_file", parameters: { type: "object" } };
  const unrelatedCall = {
    type: "function_call",
    name: "read_file",
    call_id: "call_read",
    arguments: '{"path":"seed.txt"}',
  };
  const bridged = bridgeCustomTools(
    [
      {
        type: "custom",
        name: "apply_patch",
        format: { type: "grammar", syntax: "lark", definition: V4A_GRAMMAR },
      },
      ordinary,
    ],
    [
      {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_patch_1",
        name: "apply_patch",
        input: patch,
      },
      {
        type: "custom_tool_call_output",
        id: "ctco_1",
        call_id: "call_patch_1",
        output: "Done!",
      },
      unrelatedCall,
    ],
    namespaces,
    { type: "custom", name: "apply_patch" },
  );
  assert.deepEqual(bridged.tools[0].parameters.required, ["input"]);
  assert.equal(bridged.tools[0].format, undefined);
  // A function tool has no grammar slot, so the definition has to survive in
  // the description or the model is told nothing about the patch format.
  assert.ok(bridged.tools[0].description.includes(V4A_GRAMMAR));
  assert.match(bridged.tools[0].description, /lark grammar/);
  assert.deepEqual(bridged.tools[1], ordinary);
  assert.deepEqual(bridged.toolChoice, { type: "function", name: "apply_patch" });
  assert.deepEqual(bridged.input[0], {
    call_id: "call_patch_1",
    type: "function_call",
    name: "apply_patch",
    arguments: JSON.stringify({ input: patch }),
  });
  assert.deepEqual(bridged.input[1], {
    type: "function_call_output",
    call_id: "call_patch_1",
    output: "Done!",
  });
  assert.deepEqual(bridged.input[2], unrelatedCall);
  assert.deepEqual(buildNamespaceLookups(namespaces).customTools.get("apply_patch"), { name: "apply_patch" });
});

test("custom-tool bridge preserves function-compatible item ids", () => {
  const namespaces = new Map();
  const bridged = bridgeCustomTools(
    [{ type: "custom", name: "apply_patch" }],
    [
      {
        type: "custom_tool_call",
        id: "fc_keep",
        call_id: "call_keep",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "custom_tool_call_output",
        id: "fc_keep_output",
        call_id: "call_keep",
        output: "Done!",
      },
    ],
    namespaces,
  );
  assert.equal(bridged.input[0].id, "fc_keep");
  assert.equal(bridged.input[1].id, "fc_keep_output");
});

test("namespaced freeform tools retain native identity through collisions and produced-history replay", async () => {
  const tools = [
    { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] },
    { type: "namespace", name: "other", tools: [{ type: "custom", name: "exec" }] },
    { type: "custom", name: "exec" },
    { type: "function", name: "functions__exec", parameters: { type: "object" } },
  ];
  const flat = flattenNamespaceTools(tools);
  const bridged = bridgeCustomTools(flat.tools, [], flat.namespaces, undefined, [], { bridgeAll: true });
  assert.equal(new Set(bridged.tools.map(tool => tool.name)).size, 4);
  const input = 'text("你好 🌙");\n';
  const calls = bridged.tools.slice(0, 3).map((tool, i) => ({
    type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name: tool.name,
    namespace: null, arguments: JSON.stringify({ input }),
  }));
  const json = JSON.parse(await collect(Readable.from([JSON.stringify({ status: "completed", output: calls })])
    .pipe(new NamespaceToolCallTransform(flat.namespaces, "application/json"))));
  assert.deepEqual(json.output.map(item => [item.type, item.namespace, item.name, item.input]), [
    ["custom_tool_call", "functions", "exec", input],
    ["custom_tool_call", "other", "exec", input],
    ["custom_tool_call", undefined, "exec", input],
  ]);
  const history = json.output.flatMap(item => [item,
    { type: "custom_tool_call_output", call_id: item.call_id, output: "OK" }]);
  const next = flattenNamespaceTools(tools);
  const replay = bridgeCustomTools(next.tools, history, next.namespaces, undefined, [], { bridgeAll: true });
  for (let i = 0; i < calls.length; i++) {
    assert.equal(replay.input[i * 2].name, bridged.tools[i].name);
    assert.equal(replay.input[i * 2].namespace, undefined);
    assert.equal(replay.input[i * 2].arguments, JSON.stringify({ input }));
    assert.equal(replay.input[i * 2 + 1].type, "function_call_output");
    assert.equal(replay.input[i * 2 + 1].call_id, calls[i].call_id);
  }
});

test("native default-namespace freeform history cites its declared provider tool", () => {
  const flat = flattenNamespaceTools([{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }]);
  const history = [{ type: "custom_tool_call", name: "exec", call_id: "native", input: "text(42);" }, { type: "custom_tool_call_output", call_id: "native", output: "42" }];
  const result = bridgeCustomTools(flat.tools, history, flat.namespaces, undefined, [], { bridgeAll: true });
  assert.equal(result.input[0].name, result.tools[0].name);
  assert.equal(result.input[0].name, "functions__exec");
  assert.equal(result.input[1].call_id, "native");
  assert.equal(history[0].namespace, undefined);
  const other = flattenNamespaceTools([{ type: "namespace", name: "other", tools: [{ type: "custom", name: "exec" }] }]);
  const unrelated = bridgeCustomTools(other.tools, history, other.namespaces, undefined, [], { bridgeAll: true });
  assert.equal(unrelated.input[0].name, "exec");
});

test("fragmented freeform streams preserve namespace and reject identity changes", async () => {
  const flat = flattenNamespaceTools([{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }]);
  const bridged = bridgeCustomTools(flat.tools, [], flat.namespaces, undefined, [], { bridgeAll: true });
  const input = 'text("quoted \\\"value\\\" 🌙");\n';
  const item = { type: "function_call", id: "fc_stream", call_id: "stream", name: bridged.tools[0].name, arguments: JSON.stringify({ input }) };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    ...[...item.arguments].map(delta => ({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta })),
    { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item] } },
  ];
  const wire = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const output = await collect(Readable.from([...Buffer.from(wire)].map(b => Buffer.from([b])))
    .pipe(new NamespaceToolCallTransform(flat.namespaces, "text/event-stream")));
  const parsed = output.trim().split(/\n\n/).map(block => JSON.parse(block.split("\n").find(l => l.startsWith("data: ")).slice(6)));
  const restored = parsed.find(e => e.type === "response.output_item.done").item;
  assert.equal(restored.namespace, "functions");
  assert.equal(restored.name, "exec");
  assert.equal(restored.input, input);
  assert.equal(parsed.filter(e => e.type === "response.custom_tool_call_input.delta").map(e => e.delta).join(""), input);
  assert.deepEqual(parsed.at(-1).response.output, [restored]);
  // Once a bridged opening has been emitted, a provider cannot change owners
  // in the closing event. Untouched native streams remain native-owned.
  const changed = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: { ...item, namespace: "other" } },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  await assert.rejects(collect(Readable.from([changed]).pipe(new NamespaceToolCallTransform(flat.namespaces, "text/event-stream"))), /unsafe|identity|namespace/i);
});

test("native custom-tool streams accept LiteLLM content-wrapped legacy argument events", async () => {
  const input = "console.log(6 * 7);\n";
  const argumentsText = JSON.stringify({ content: input });
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "call_native_custom",
        call_id: "call_native_custom",
        name: "exec",
        status: "in_progress",
        input: "",
      },
    },
    ...[...argumentsText].map((delta) => ({
      type: "response.function_call_arguments.delta",
      item_id: "call_native_custom",
      output_index: 0,
      delta,
    })),
    {
      type: "response.function_call_arguments.done",
      item_id: "call_native_custom",
      output_index: 0,
      arguments: argumentsText,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "call_native_custom",
        call_id: "call_native_custom",
        name: "exec",
        status: "completed",
        input,
      },
    },
  ];
  const source = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const transform = new NamespaceToolCallTransform(new Map(), "text/event-stream");
  const output = await collect(Readable.from([source]).pipe(transform));
  const payloads = output.split(/\n\n/).filter(Boolean).map((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data.slice(6));
  });
  assert.equal(payloads[0].item.type, "custom_tool_call");
  assert.equal(
    payloads.filter((event) => event.type === "response.custom_tool_call_input.delta")
      .map((event) => event.delta).join(""),
    input,
  );
  assert.equal(
    payloads.find((event) => event.type === "response.custom_tool_call_input.done")?.input,
    input,
  );
  assert.equal(payloads.at(-1).item.input, input);
  assert.doesNotMatch(output, /response\.function_call_arguments/u);
});

function litellmNativeCustomEvents(id, argumentsText, completedInput, chunkSize = 1) {
  const deltas = [];
  for (let index = 0; index < argumentsText.length; index += chunkSize) {
    deltas.push(argumentsText.slice(index, index + chunkSize));
  }
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "custom_tool_call", id, call_id: id, name: "apply_patch", status: "in_progress", input: "" },
    },
    ...deltas.map((delta) => ({
      type: "response.function_call_arguments.delta",
      item_id: id,
      output_index: 0,
      delta,
    })),
    { type: "response.function_call_arguments.done", item_id: id, output_index: 0, arguments: argumentsText },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "custom_tool_call", id, call_id: id, name: "apply_patch", status: "completed", input: completedInput },
    },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// LiteLLM 1.96 unwrap_custom_tool_arguments(): a string `content` from a JSON
// object, otherwise the provider arguments verbatim. Each case pairs the
// provider arguments with the input LiteLLM puts on the completed item.
const PATCH_FIXTURE = "*** Begin Patch\n*** Update File: src/a.js\n@@\n-const a = 1;\n+const re = /\\d+/;\n*** End Patch";

test("native custom-tool arguments LiteLLM keeps verbatim relay as its completed input", async () => {
  for (const [name, argumentsText, completedInput] of [
    ["content after another key", JSON.stringify({ path: "src/a.js", content: PATCH_FIXTURE }), PATCH_FIXTURE],
    ["input key instead of content", JSON.stringify({ input: PATCH_FIXTURE }), JSON.stringify({ input: PATCH_FIXTURE })],
    ["empty object", "{}", "{}"],
    ["raw patch text", PATCH_FIXTURE, PATCH_FIXTURE],
    ["bare JSON string", JSON.stringify(PATCH_FIXTURE), JSON.stringify(PATCH_FIXTURE)],
  ]) {
    const id = `call_${name.replaceAll(" ", "_")}`;
    const output = await collect(
      Readable.from(litellmNativeCustomEvents(id, argumentsText, completedInput))
        .pipe(new NamespaceToolCallTransform(new Map(), "text/event-stream")),
    );
    const payloads = output.split(/\n\n/).filter(Boolean)
      .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
    assert.equal(
      payloads.find((event) => event.type === "response.custom_tool_call_input.done")?.input,
      completedInput,
      name,
    );
    assert.equal(payloads.at(-1).item.input, completedInput, name);
    // The decoder follows only a leading content wrapper; nothing it could not
    // decode reaches the client as streamed input.
    assert.equal(
      payloads.some((event) => event.type === "response.custom_tool_call_input.delta"),
      false,
      name,
    );
    assert.doesNotMatch(output, /response\.function_call_arguments/u, name);
  }
});

test("native custom input follows LiteLLM's code-point size limit", async () => {
  for (const content of ["x".repeat(1_000_001), "😀".repeat(500_001)]) {
    const args = JSON.stringify({ path: "x", content });
    const expected = [...args].length > 1_000_000 ? args : content;
    const output = await collect(Readable.from(litellmNativeCustomEvents("large", args, expected, 65536))
      .pipe(new NamespaceToolCallTransform(new Map(), "text/event-stream")));
    assert.ok(output.includes(JSON.stringify(expected)));
  }
});

test("native custom-tool arguments still fail closed where LiteLLM's input cannot be matched", async () => {
  for (const [name, argumentsText, completedInput, reason] of [
    // Python str() of a non-string content has no faithful JavaScript form.
    ["non-string content", JSON.stringify({ content: null }), "None", /invalid custom tool arguments done/u],
    // The completed item must carry the input the relay already committed.
    ["completed item disagrees", JSON.stringify({ input: "one" }), "two", /custom tool call input changed before close/u],
    // Decoded text already streamed cannot be contradicted by the final input.
    ["streamed text then invalid", '{"content": "*** Begin Patch"}', '{"content": "*** Begin Patch"}',
      /incomplete custom tool argument delta sequence/u],
  ]) {
    let error;
    try { await collect(Readable.from(litellmNativeCustomEvents(`call_${name.replaceAll(" ", "_")}`, argumentsText, completedInput))
      .pipe(new NamespaceToolCallTransform(new Map(), "text/event-stream"))); }
    catch (caught) { error = caught; }
    assert.equal(error?.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM", name);
    assert.match(error.message, reason, name);
  }
});

test('new app worktree and artifact calls retain arguments and native namespaces', () => {
  const {tools, namespaces} = flattenNamespaceTools(CODEX_APP_TOOLS);
  const fixtures = {
    create_worktree: {name: 'synthetic-review', ref: 'HEAD'},
    attach_artifact: {artifact_type: 'pull_request', url: 'https://github.com/example/repo/pull/1'},
    list_artifacts: {},
    remove_artifact: {artifact_type: 'pull_request', url: 'https://github.com/example/repo/pull/1'},
  };
  for (const [name, args] of Object.entries(fixtures)) {
    const flat = tools.find(tool => tool.name === `mcp__codex_app__${name}`);
    assert.ok(flat);
    for (const key of Object.keys(args)) assert.ok(flat.parameters.properties[key]);
    const result = rewriteNamespaceResponsePayload({type: 'response.output_item.done', item: {
      type: 'function_call', name: flat.name, call_id: `call_${name}`, arguments: JSON.stringify(args),
    }}, buildNamespaceLookups(namespaces));
    assert.equal(result.item.name, name);
    assert.equal(result.item.namespace, 'mcp__codex_app');
    assert.deepEqual(JSON.parse(result.item.arguments), args);
  }
});
