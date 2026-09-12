import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  NamespaceToolCallTransform,
  bridgeCustomTools,
  buildNamespaceLookups,
  flattenNamespaceTools,
  rewriteNamespaceResponsePayload,
  restorePreflattenedToolNamespaces,
} from "../src/namespace-relay.mjs";
import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";

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
      { type: "custom_tool_call_output", call_id: "call_patch_1", output: "Done!" },
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
    id: "ctc_1",
    call_id: "call_patch_1",
    type: "function_call",
    name: "apply_patch",
    arguments: JSON.stringify({ input: patch }),
  });
  assert.equal(bridged.input[1].type, "function_call_output");
  assert.deepEqual(bridged.input[2], unrelatedCall);
  assert.equal(buildNamespaceLookups(namespaces).customTools.get("apply_patch"), "apply_patch");
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
