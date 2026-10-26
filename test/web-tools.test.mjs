import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { collectWebTools } from "../src/web-runtime.mjs";
import { createWebToolBroker } from "../src/web-tools.mjs";

const fn = (name, extra = {}) => ({ type: "function", name, description: `${name} tool`, parameters: { type: "object", properties: {} }, ...extra });
const custom = name => ({ type: "custom", name, description: "Raw patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } });
const search = { type: "tool_search", execution: "client" };
const register = (broker, tools, extra = {}) => broker.register({ threadId: "thread", turnId: "turn", tools, ...extra });
const finish = (broker, token) => broker.finish(token, broker.beginCompletion(token));
const output = (call, value, extra = {}) => ({ type: call.type === "custom_tool_call" ? "custom_tool_call_output" : call.type === "tool_search_call" ? "tool_search_output" : "function_call_output",
  call_id: call.call_id, ...(call.type === "tool_search_call" ? { tools: value, execution: "client", status: "completed" } : { output: value }), ...extra });

test("MCP invocation waits for actual native Codex output and retains namespaced identity", async () => {
  const broker = createWebToolBroker();
  const original = [{ type: "namespace", name: "mcp__files", tools: [fn("read", { inputSchema: { type: "object", properties: { path: { type: "string" } } }, parameters: undefined })] }];
  const before = structuredClone(original);
  const { token } = register(broker, original);
  const tools = broker.list(token).tools;
  assert.equal(tools[0].wireName, "mcp__files__read");
  assert.deepEqual(tools[0].parameters, original[0].tools[0].inputSchema);
  const args = { path: "actual.txt" };
  const result = broker.invoke(token, { wireName: tools[0].wireName, arguments: args });
  args.path = "mutated.txt";
  let settled = false;
  void result.then(() => { settled = true; });
  const [call] = broker.takeCalls(token);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(call.type, "function_call");
  assert.equal(call.name, "read");
  assert.equal(call.namespace, "mcp__files");
  assert.deepEqual(JSON.parse(call.arguments), { path: "actual.txt" });
  assert.equal(finish(broker, token), false);
  assert.deepEqual(broker.takeCalls(token), [call]);
  broker.complete(token, [output(call, "file contents")]);
  assert.deepEqual(await result, { content: [{ type: "text", text: "file contents" }] });
  assert.deepEqual(original, before);
  assert.equal(finish(broker, token), true);
  await assert.rejects(broker.invoke(token, { wireName: tools[0].wireName }), { code: "web_tool_turn_closed" });
});

test("function, namespaced custom exec, and search retain distinct native call shapes", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read"), { type: "namespace", name: "functions", tools: [custom("exec")] }, search]);
  const tools = broker.list(token).tools;
  const raw = "text('literal `$ value');\n";
  const calls = tools.map(tool => broker.invoke(token, { wireName: tool.wireName, ...(tool.kind === "custom" ? { input: raw } : { arguments: { query: "files" } }) }));
  const items = broker.takeCalls(token);
  assert.equal(items[0].type, "function_call");
  assert.equal(items[0].namespace, undefined);
  assert.equal(items[1].type, "custom_tool_call");
  assert.equal(items[1].namespace, "functions");
  assert.equal(items[1].name, "exec");
  assert.equal(items[1].input, raw);
  assert.equal(items[1].arguments, undefined);
  assert.equal(items[2].type, "tool_search_call");
  assert.equal(items[2].execution, "client");
  assert.deepEqual(items[2].arguments, { query: "files" });
  broker.complete(token, items.map(item => output(item, item.type === "tool_search_call" ? [fn("new_tool")] : "ok")));
  const results = await Promise.all(calls);
  assert.deepEqual(JSON.parse(results[2].content[0].text).tools, [fn("new_tool")]);
  assert.equal(results[2].structuredContent, undefined);
  assert.equal(finish(broker, token), true);
});

test("collected declarations retain wire names, native schemas, and call identity across namespace, kind, and discovery collisions", async () => {
  const broker = createWebToolBroker();
  const parameters = { anyOf: [{ type: "object", properties: { count: { type: "integer", enum: ["1"] } } }] };
  const collected = collectWebTools({ tools: [
    fn("a__b", { parameters }), { type: "namespace", name: "a", tools: [fn("b")] },
    fn("tool_search"), search, { type: "namespace", name: "a", tools: [custom("b")] },
    fn("codex_custom_tool_search"), custom("tool_search"), custom("a__b"),
  ] });
  assert.equal(collected.filter(tool => tool.type === "namespace" && tool.name === "a").length, 1);
  const { token } = register(broker, collected);
  const tools = broker.list(token).tools;
  assert.deepEqual(tools.map(tool => tool.wireName), [
    "a__b_6d90aa992468", "a__b_20826aea0401", "a__b", "tool_search", "codex_tool_search_1",
    "codex_custom_tool_search", "codex_custom_tool_search_1", "codex_custom_a__b",
  ]);
  assert.deepEqual(tools[0].parameters, parameters);
  assert.deepEqual(tools[2].format, custom("b").format);
  assert.deepEqual(broker.list(token, { names: ["a__b"] }).tools, [tools[2]], "Exact wire names take precedence over colliding native aliases.");
  assert.deepEqual(broker.list(token, { query: "a__b" }).tools, [tools[2]]);
  assert.deepEqual(broker.list(token, { names: ["a.b"] }).tools, [tools[1], tools[2]], "A native-qualified identity may retain distinct function and custom kinds.");
  const results = tools.map(tool => broker.invoke(token, { wireName: tool.wireName, ...(tool.kind === "custom" ? { input: "raw" } : {}) }));
  const items = broker.takeCalls(token);
  assert.deepEqual(items.map(item => [item.type, item.name, item.namespace]), [
    ["function_call", "a__b", undefined], ["function_call", "b", "a"], ["custom_tool_call", "b", "a"],
    ["function_call", "tool_search", undefined], ["tool_search_call", undefined, undefined],
    ["function_call", "codex_custom_tool_search", undefined], ["custom_tool_call", "tool_search", undefined],
    ["custom_tool_call", "a__b", undefined],
  ]);
  broker.complete(token, items.map(item => output(item, item.type === "tool_search_call" ? [] : "ok")));
  await Promise.all(results);
  finish(broker, token);
});

test("invalid, duplicate, partial, or wrong-kind output cannot partially settle a batch", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read")]);
  const first = broker.invoke(token, { wireName: "read" });
  const second = broker.invoke(token, { wireName: "read" });
  assert.throws(() => broker.complete(token, [{ type: "function_call_output", call_id: "not-delivered", output: "premature" }]));
  const items = broker.takeCalls(token);
  for (const bad of [
    [output(items[0], "one")],
    [output(items[0], "one"), output(items[0], "duplicate")],
    [output(items[0], "one"), { ...output(items[1], "two"), call_id: "unknown" }],
    [output(items[0], "one"), { ...output(items[1], "two"), type: "custom_tool_call_output" }],
    [output(items[0], "one"), output(items[1], undefined)],
  ]) {
    assert.throws(() => broker.complete(token, bad));
    assert.deepEqual(broker.takeCalls(token), items);
  }
  broker.complete(token, items.map(item => output(item, "ok")));
  await Promise.all([first, second]);
  assert.throws(() => broker.complete(token, [output(items[0], "late duplicate")]));
  finish(broker, token);
});

test("a delivered batch is stable while a later MCP call queues for the next native round", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read")]);
  const first = broker.invoke(token, { wireName: "read", arguments: { n: 1 } });
  const [one] = broker.takeCalls(token);
  const second = broker.invoke(token, { wireName: "read", arguments: { n: 2 } });
  assert.deepEqual(broker.takeCalls(token), [one]);
  broker.complete(token, [output(one, "one")]);
  assert.deepEqual(await first, { content: [{ type: "text", text: "one" }] });
  const [two] = broker.takeCalls(token);
  assert.notEqual(two.call_id, one.call_id);
  broker.complete(token, [output(two, "two")]);
  await second;
  finish(broker, token);
});

test("only current declarations authorize dynamic discovery and wire identities stay stable", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [search]);
  await assert.rejects(broker.invoke(token, { wireName: "new_tool" }), /not declared/);
  const result = broker.invoke(token, { wireName: "tool_search", arguments: { query: "new tool" } });
  const [call] = broker.takeCalls(token);
  assert.throws(() => broker.update(token, { tools: [fn("new_tool")] }), { code: "web_tools_pending" });
  broker.complete(token, [output(call, [fn("new_tool")])]);
  await result;
  // Discovery content alone does not manufacture a callable declaration.
  await assert.rejects(broker.invoke(token, { wireName: "new_tool" }), /not declared/);
  broker.update(token, { tools: [fn("a__b"), fn("new_tool")] });
  const firstRegistry = broker.list(token).tools;
  const old = firstRegistry.find(tool => tool.name === "a__b");
  broker.update(token, { tools: [{ type: "namespace", name: "a", tools: [fn("b")] }, fn("new_tool")] });
  const nextRegistry = broker.list(token).tools;
  assert.notEqual(nextRegistry.find(tool => tool.name === "b").wireName, old.wireName);
  await assert.rejects(broker.invoke(token, { wireName: old.wireName }), /not declared/);
  const next = broker.invoke(token, { wireName: "new_tool" });
  const [actual] = broker.takeCalls(token);
  broker.complete(token, [output(actual, "discovered result")]);
  await next;
  finish(broker, token);
});

test("tool choice blocks unauthorized tools and required choices prevent a no-tool final", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read"), fn("write")], { toolChoice: { type: "function", name: "read" } });
  const tools = broker.list(token).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["read"]);
  assert.equal(finish(broker, token), false);
  await assert.rejects(broker.invoke(token, { wireName: "write" }), /not declared and allowed/);
  const result = broker.invoke(token, { wireName: "read" });
  const [call] = broker.takeCalls(token);
  broker.complete(token, [output(call, "ok")]);
  await result;
  assert.equal(finish(broker, token), true);
  const none = register(broker, [fn("read")], { toolChoice: "none" });
  assert.deepEqual(broker.list(none.token).tools, []);
  await assert.rejects(broker.invoke(none.token, { wireName: "read" }));
  finish(broker, none.token);
  assert.throws(() => register(broker, [], { toolChoice: "required" }), { code: "unsupported_tool_choice" });
  assert.throws(() => register(broker, [fn("read")], { toolChoice: { type: "function", name: "missing" } }), { code: "unsupported_tool_choice" });
});

test("unchanged registries reevaluate mutable current policy and preserve pending-call and revision fences", async () => {
  const broker = createWebToolBroker();
  const declarations = [fn("read"), fn("write")], policy = { type: "function", name: "read" };
  const { token } = register(broker, declarations, { toolChoice: policy });
  const before = broker.beginCompletion(token);
  policy.name = "write";
  broker.update(token, { tools: structuredClone(declarations), toolChoice: policy });
  assert.equal(broker.revision(token), before + 1);
  assert.equal(broker.finish(token, before), false);
  assert.deepEqual(broker.list(token).tools.map(tool => tool.name), ["write"]);
  await assert.rejects(broker.invoke(token, { wireName: "read" }), /not declared and allowed/u);
  assert.equal(finish(broker, token), false, "Required policy still applies on the unchanged declaration path.");
  const result = broker.invoke(token, { wireName: "write" });
  assert.throws(() => broker.update(token, { tools: declarations, toolChoice: "none" }), { code: "web_tools_pending" });
  const [call] = broker.takeCalls(token);
  assert.equal(call.name, "write");
  broker.complete(token, [output(call, "actual write result")]);
  await result;
  const revision = broker.revision(token);
  assert.throws(() => broker.update(token, { tools: declarations, toolChoice: { type: "function", name: "missing" } }), { code: "unsupported_tool_choice" });
  assert.equal(broker.revision(token), revision);
  assert.deepEqual(broker.list(token).tools.map(tool => tool.name), ["write"]);
  broker.update(token, { tools: declarations, toolChoice: "none" });
  assert.deepEqual(broker.list(token).tools, []);
  assert.equal(finish(broker, token), true);
});

test("caller and discovery mutations cannot change accepted schemas until a successful current update", () => {
  const broker = createWebToolBroker();
  const declarations = [{ type: "namespace", name: "functions", tools: [custom("exec"), fn("read", {
    parameters: { type: "object", properties: { marker: { enum: ["original"] } } },
  })] }];
  const original = structuredClone(declarations);
  const { token } = register(broker, declarations);
  const before = broker.list(token).tools;
  broker.update(token, { tools: structuredClone(original) });
  declarations[0].tools[0].format.definition = "start: /changed/";
  declarations[0].tools[1].parameters.properties.marker.enum[0] = "changed";
  assert.deepEqual(broker.list(token).tools, before, "Input mutation cannot alter the private accepted snapshot.");
  broker.update(token, { tools: declarations });
  const changed = broker.list(token).tools;
  assert.deepEqual(changed.map(tool => tool.wireName), before.map(tool => tool.wireName));
  assert.equal(changed[0].format.definition, "start: /changed/");
  assert.deepEqual(changed[1].parameters.properties.marker.enum, ["changed"]);
  changed[0].format.definition = "start: /discovery mutation/";
  changed[1].parameters.properties.marker.enum[0] = "discovery mutation";
  broker.update(token, { tools: structuredClone(declarations) });
  assert.equal(broker.list(token).tools[0].format.definition, "start: /changed/");
  assert.deepEqual(broker.list(token).tools[1].parameters.properties.marker.enum, ["changed"]);
  declarations[0].tools[1].parameters.properties.marker.enum[0] = "unaccepted";
  assert.throws(() => broker.update(token, { tools: declarations, toolChoice: { type: "function", name: "missing" } }), { code: "unsupported_tool_choice" });
  assert.deepEqual(broker.list(token).tools[1].parameters.properties.marker.enum, ["changed"]);
  assert.equal(finish(broker, token), true);
});

test("allowed_tools resolves exact namespaces and excludes sibling tools", async () => {
  const broker = createWebToolBroker();
  const declarations = [{ type: "namespace", name: "one", tools: [fn("read")] }, { type: "namespace", name: "two", tools: [fn("read")] }];
  const { token } = register(broker, declarations, { toolChoice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read", namespace: "two" }] } });
  const tools = broker.list(token).tools;
  assert.deepEqual(tools.map(tool => tool.namespace), ["two"]);
  await assert.rejects(broker.invoke(token, { wireName: "one__read" }));
  finish(broker, token);
  assert.throws(() => register(broker, declarations, { toolChoice: { type: "function", name: "read" } }), { code: "unsupported_tool_choice" });
});

test("focused discovery excludes the fuzzy tail after exact matches and retains complete declarations", () => {
  const broker = createWebToolBroker();
  const parameters = { type: "object", properties: { path: { type: "string", enum: ["native.txt"] } }, required: ["path"], additionalProperties: false };
  const { token } = register(broker, [
    fn("alpha", { description: "Read a file from native storage" }), fn("pre_read"), fn("reader"), fn("read", { parameters }), fn("read_more"),
    { type: "namespace", name: "mcp__read", tools: [fn("fetch")] },
    { type: "namespace", name: "functions", tools: [custom("exec")] },
  ]);
  const tools = broker.list(token).tools;
  assert.deepEqual(broker.list(token, { query: " ReAd " }).tools.map(tool => tool.name), ["read"]);
  assert.deepEqual(broker.list(token, { query: "rea" }).tools.map(tool => tool.name), ["reader", "read", "read_more", "pre_read", "fetch", "alpha"]);
  assert.deepEqual(broker.list(token, { query: "MCP__READ" }).tools.map(tool => tool.wireName), ["mcp__read__fetch"]);
  assert.deepEqual(broker.list(token, { query: "MCP__READ__FETCH" }).tools, tools.filter(tool => tool.name === "fetch"));
  const [read] = broker.list(token, { query: "read" }).tools;
  assert.deepEqual(read.parameters, parameters);
  read.parameters.properties.path.enum[0] = "mutated";
  assert.deepEqual(broker.list(token, { query: "read" }).tools[0].parameters, parameters);
  assert.deepEqual(broker.list(token, { query: "ExEc" }).tools[0].format, custom("exec").format);
  assert.deepEqual(broker.list(token, { query: "missing" }).tools, []);
  assert.deepEqual(broker.list(token).tools, tools);
  for (const query of ["", " ", 1, "x".repeat(1025)]) assert.throws(() => broker.list(token, { query }).tools, { code: "invalid_web_tool_call" });
  assert.equal(finish(broker, token), true);
});

test("discovery bounds catalog pages, reports honest totals, and batches exact identities without fuzzy matches", t => {
  const broker = createWebToolBroker();
  const parameters = { type: "object", properties: Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`field_${index}`, { type: "string", description: `Complete native field ${index}` }])) };
  const declarations = [...Array.from({ length: 70 }, (_, index) => fn(`read_${index}`, { parameters })),
    { type: "namespace", name: "functions", tools: [custom("exec")] }];
  const { token } = register(broker, declarations);
  const first = broker.list(token);
  assert.equal(first.tools.length, 8);
  assert.equal(first.total, 71);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.nextCursor.includes(token), false, "A cursor must not expose turn authority.");
  const all = [...first.tools];
  let cursor = first.nextCursor;
  while (cursor !== undefined) {
    const page = broker.list(token, { cursor, limit: 32 });
    assert.equal(page.total, 71);
    assert.ok(page.tools.length <= 32);
    all.push(...page.tools);
    cursor = page.nextCursor;
  }
  assert.deepEqual(all.map(tool => tool.name), [...Array.from({ length: 70 }, (_, index) => `read_${index}`), "exec"]);
  assert.deepEqual(all[69].parameters, parameters, "A page limit never truncates a selected schema.");
  assert.deepEqual(all[70].format, custom("exec").format);
  const exactQuery = broker.list(token, { query: "read_1" });
  assert.deepEqual(exactQuery.tools.map(tool => tool.name), ["read_1"]);
  const bodyBytes = result => Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), "utf8");
  const mirrored = tools => ({ content: [{ type: "text", text: JSON.stringify({ tools }) }], structuredContent: { tools } });
  const canonical = page => ({ content: [{ type: "text", text: JSON.stringify(page) }] });
  const oldExact = all.filter(tool => tool.name.includes("read_1"));
  const catalogBefore = bodyBytes(mirrored(all)), catalogAfter = bodyBytes(canonical(first));
  const exactBefore = bodyBytes(mirrored(oldExact)), exactAfter = bodyBytes(canonical(exactQuery));
  assert.ok(catalogAfter < catalogBefore);
  assert.ok(exactAfter < exactBefore);
  t.diagnostic(`Synthetic JSON-RPC discovery body, 70 functions with 45 schema properties each plus one custom grammar: catalog mirrored all 71=${catalogBefore} bytes; canonical page 8 of 71=${catalogAfter} bytes; query read_1 mirrored 11 fuzzy/exact=${exactBefore} bytes; canonical exact 1=${exactAfter} bytes.`);
  const exact = broker.list(token, { names: ["READ_1", "functions.exec", "read_4", "not_declared"] });
  assert.deepEqual(exact.tools.map(tool => tool.name), ["read_1", "read_4", "exec"]);
  assert.equal(exact.total, 3);
  assert.equal(exact.nextCursor, undefined);
  assert.deepEqual(broker.list(token, { names: [all[70].wireName] }).tools, [all[70]]);
  const fuzzy = broker.list(token, { query: "read_" });
  assert.equal(fuzzy.tools.length, 8);
  assert.equal(fuzzy.total, 70);
  for (const options of [
    { limit: 0 }, { limit: 33 }, { limit: 1.5 }, { limit: "8" },
    { names: [] }, { names: "read_1" }, { names: [""] }, { names: [null] },
    { names: ["x".repeat(1025)] }, { names: Array(33).fill("read_1") }, { names: ["read_1"], query: "read" },
  ]) assert.throws(() => broker.list(token, options), { code: "invalid_web_tool_call" });
  assert.equal(finish(broker, token), true);
});

test("discovery cursors survive activity and unchanged updates but reject other selections, turns, and accepted changes", async () => {
  const broker = createWebToolBroker();
  const declarations = Array.from({ length: 12 }, (_, index) => fn(`read_${index}`));
  const { token } = register(broker, declarations);
  const options = { query: "read_", limit: 2 };
  const first = broker.list(token, options), cursor = first.nextCursor;
  const expected = broker.list(token, { ...options, cursor });
  const release = broker.beginActivity(token);
  release();
  const result = broker.invoke(token, { wireName: "read_0" });
  const [call] = broker.takeCalls(token);
  broker.complete(token, [output(call, "unchanged catalog")]);
  await result;
  broker.update(token, { tools: structuredClone(declarations), toolChoice: "auto" });
  assert.deepEqual(broker.list(token, { query: " READ_ ", limit: 2, cursor }), expected);
  assert.deepEqual(broker.list(token, options), first, "An unchanged update retains the exact pagination version.");
  const other = broker.register({ threadId: "other", turnId: "turn", tools: declarations });
  for (const [current, selection] of [
    [token, { query: "read" }], [token, {}], [token, { names: ["read_0", "read_1"] }], [other.token, options],
  ]) assert.throws(() => broker.list(current, { ...selection, cursor }), { code: "invalid_web_tool_cursor" });
  for (const malformed of [null, "", 1, "0.invalid", `${cursor}x`, `999${cursor}`, cursor.replace(/.$/u, "!")]) {
    assert.throws(() => broker.list(token, { ...options, cursor: malformed }), { code: "invalid_web_tool_cursor" });
  }
  const exact = { names: ["read_0", "read_1", "read_2"], limit: 1 };
  const exactFirst = broker.list(token, exact);
  assert.deepEqual(broker.list(token, { names: ["READ_2", "read_0", "read_1"], limit: 1, cursor: exactFirst.nextCursor }).tools.map(tool => tool.name), ["read_1"]);
  assert.throws(() => broker.list(token, { names: ["read_0", "read_2"], cursor: exactFirst.nextCursor }), { code: "invalid_web_tool_cursor" });
  const changed = structuredClone(declarations);
  changed[10].parameters.properties.updated = { const: true };
  broker.update(token, { tools: changed });
  assert.throws(() => broker.list(token, { ...options, cursor }), { code: "invalid_web_tool_cursor" });
  broker.update(token, { tools: declarations });
  assert.throws(() => broker.list(token, { ...options, cursor }), { code: "invalid_web_tool_cursor" }, "Restoring a prior catalog does not revive its old cursors.");
  const auto = broker.list(token, options);
  broker.update(token, { tools: declarations, toolChoice: "required" });
  assert.throws(() => broker.list(token, { ...options, cursor: auto.nextCursor }), { code: "invalid_web_tool_cursor" });
  broker.update(token, { tools: changed });
  const revised = broker.list(token, options);
  broker.update(token, { tools: changed, toolChoice: { type: "allowed_tools", mode: "auto", tools: [
    { type: "function", name: "read_1" }, { type: "function", name: "read_2" },
  ] } });
  assert.throws(() => broker.list(token, { ...options, cursor: revised.nextCursor }), { code: "invalid_web_tool_cursor" });
  assert.deepEqual(broker.list(token, { names: ["read_0", "read_1"] }).tools.map(tool => tool.name), ["read_1"]);
  assert.equal(broker.list(token).total, 2);
  assert.equal(finish(broker, token), true);
  const replacement = register(broker, declarations);
  assert.throws(() => broker.list(token, { ...options, cursor }), { code: "web_tool_turn_closed" });
  assert.throws(() => broker.list(replacement.token, { ...options, cursor }), { code: "invalid_web_tool_cursor" });
  assert.deepEqual(broker.takeCalls(replacement.token), []);
  finish(broker, replacement.token);
  finish(broker, other.token);
});

test("active-turn checks expose only whether the exact capability is still alive", () => {
  const broker = createWebToolBroker();
  const first = register(broker, [fn("read")]);
  assert.equal(broker.isActive(first.token), true);
  assert.equal(broker.isActive("unknown"), false);
  assert.equal(broker.isActive(undefined), false);
  finish(broker, first.token);
  assert.equal(broker.isActive(first.token), false);
  const replacement = register(broker, [fn("read")]);
  assert.equal(broker.isActive(replacement.token), true);
  broker.cancel(replacement.token);
  assert.equal(broker.isActive(replacement.token), false);
});

test("focused discovery uses current allowed schemas and cannot authorize a removed or replacement turn tool", async () => {
  const broker = createWebToolBroker();
  const first = register(broker, [fn("read"), fn("write")], { toolChoice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read" }] } });
  assert.deepEqual(broker.list(first.token, { query: "write" }).tools, []);
  const [old] = broker.list(first.token, { query: "read" }).tools;
  const parameters = { type: "object", properties: { revision: { const: 2 } }, required: ["revision"] };
  broker.update(first.token, { tools: [fn("read", { parameters })] });
  assert.equal(broker.list(first.token, { query: "read" }).tools[0].wireName, old.wireName);
  assert.deepEqual(broker.list(first.token, { query: "read" }).tools[0].parameters, parameters);
  broker.update(first.token, { tools: [fn("write")] });
  assert.deepEqual(broker.list(first.token, { query: "read" }).tools, []);
  await assert.rejects(broker.invoke(first.token, { wireName: old.wireName }), /not declared and allowed/);
  assert.equal(finish(broker, first.token), true);
  const replacement = register(broker, [fn("write")]);
  assert.throws(() => broker.list(first.token, { query: "write" }).tools, { code: "web_tool_turn_closed" });
  assert.throws(() => broker.list("unknown", { query: "write" }).tools, { code: "web_tool_turn_closed" });
  await assert.rejects(broker.invoke(replacement.token, { wireName: old.wireName }), /not declared and allowed/);
  assert.deepEqual(broker.takeCalls(replacement.token), []);
  assert.equal(finish(broker, replacement.token), true);
});

test("normal tool errors and multimodal native outputs return through MCP without execution", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read")]);
  const result = broker.invoke(token, { wireName: "read" });
  const [call] = broker.takeCalls(token);
  broker.complete(token, [output(call, JSON.stringify({ content: [
    { type: "text", text: "operation denied" }, { type: "input_image", image_url: "data:image/png;base64,YWJj" },
    { type: "image", data: "ZGVm", mimeType: "image/jpeg" },
  ], structuredContent: { changed: false }, isError: true, _meta: { detail: "approval rejected" } }))]);
  assert.deepEqual(await result, { content: [
    { type: "text", text: "operation denied" }, { type: "image", data: "YWJj", mimeType: "image/png" },
    { type: "image", data: "ZGVm", mimeType: "image/jpeg" },
  ], structuredContent: { changed: false }, isError: true, _meta: { detail: "approval rejected" } });
  const typedResult = broker.invoke(token, { wireName: "read" });
  const [typedCall] = broker.takeCalls(token);
  broker.complete(token, [output(typedCall, [
    { type: "input_text", text: "native text" },
    { type: "input_image", image_url: "https://example.invalid/native.png" },
    { type: "audio", data: "YWJj", mimeType: "audio/wav" },
  ], { isError: true })]);
  assert.deepEqual(await typedResult, { content: [
    { type: "text", text: "native text" },
    { type: "resource_link", uri: "https://example.invalid/native.png", name: "Native tool image", mimeType: "image/*" },
    { type: "audio", data: "YWJj", mimeType: "audio/wav" },
  ], isError: true });
  finish(broker, token);
});

test("Router-created object and search results use one complete JSON representation while upstream MCP envelopes retain their meaning", async t => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read"), search]);
  const value = { rows: Array.from({ length: 20 }, (_, index) => ({ index, text: `Complete synthetic row ${index} 🌙`, details: "x".repeat(100) })), isError: true };
  const result = broker.invoke(token, { wireName: "read" });
  const [call] = broker.takeCalls(token);
  broker.complete(token, [output(call, JSON.stringify(value))]);
  const canonical = await result;
  assert.deepEqual(canonical, { content: [{ type: "text", text: JSON.stringify(value) }], isError: true });
  assert.deepEqual(CallToolResultSchema.parse(canonical), canonical, "The current SDK accepts the canonical text-only result.");
  const protocolBody = payload => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), "utf8");
  const duplicatedBytes = protocolBody({ ...canonical, structuredContent: value }).byteLength;
  const canonicalBytes = protocolBody(canonical).byteLength;
  assert.ok(canonicalBytes < duplicatedBytes);
  t.diagnostic(`Synthetic JSON-RPC object result body, 20 rows each with index, Unicode text and 100-byte details: mirrored=${duplicatedBytes} bytes; canonical=${canonicalBytes} bytes.`);
  const searchResult = broker.invoke(token, { wireName: "tool_search" });
  const [searchCall] = broker.takeCalls(token);
  const searchOutput = output(searchCall, [fn("discovered")]);
  broker.complete(token, [searchOutput]);
  const searched = await searchResult;
  assert.deepEqual(searched, { content: [{ type: "text", text: JSON.stringify(searchOutput) }] });
  assert.deepEqual(CallToolResultSchema.parse(searched), searched);
  const envelopes = [
    { content: [{ type: "text", text: "Human explanation differs from structured data." }], structuredContent: { code: "denied" }, isError: true, _meta: { audit: "native" } },
    { structuredContent: { actual: "structured-only native result" }, _meta: { audit: "native" } },
  ];
  for (const envelope of envelopes) {
    const upstream = broker.invoke(token, { wireName: "read" });
    const [upstreamCall] = broker.takeCalls(token);
    broker.complete(token, [output(upstreamCall, envelope)]);
    const received = await upstream;
    assert.deepEqual(received, { content: [], ...envelope });
    assert.deepEqual(CallToolResultSchema.parse(received), received);
  }
  const ordinary = { structuredContent: { schema: "ordinary native data" }, rows: [1, 2], description: "keep sibling fields" };
  const ordinaryResult = broker.invoke(token, { wireName: "read" });
  const [ordinaryCall] = broker.takeCalls(token);
  broker.complete(token, [output(ordinaryCall, ordinary)]);
  assert.deepEqual(await ordinaryResult, { content: [{ type: "text", text: JSON.stringify(ordinary) }] });
  finish(broker, token);
});

test("cancellation revokes pending and queued calls while other turns continue", async () => {
  const broker = createWebToolBroker();
  const first = register(broker, [fn("read")]);
  const other = broker.register({ threadId: "other", turnId: "turn", tools: [fn("read")] });
  const a = broker.invoke(first.token, { wireName: "read" });
  const rejectedA = assert.rejects(a, /stop this turn/);
  const b = broker.invoke(first.token, { wireName: "read" });
  const rejectedB = assert.rejects(b, /stop this turn/);
  const [delivered] = broker.takeCalls(first.token);
  assert.equal(broker.cancel(first.token, new Error("stop this turn")), true);
  await Promise.all([rejectedA, rejectedB]);
  assert.equal(broker.cancel(first.token), false);
  await assert.rejects(broker.invoke(first.token, { wireName: "read" }), { code: "web_tool_turn_closed" });
  assert.throws(() => broker.complete(first.token, [output(delivered, "late")]), { code: "web_tool_turn_closed" });
  const replacement = register(broker, [fn("read")]);
  assert.notEqual(replacement.token, first.token);
  finish(broker, replacement.token);
  const live = broker.invoke(other.token, { wireName: "read" });
  const [call] = broker.takeCalls(other.token);
  broker.complete(other.token, [output(call, "other result")]);
  await live;
  finish(broker, other.token);
});

test("MCP cancellation or timeout retires the whole capability without late dispatch", async () => {
  const broker = createWebToolBroker({ invocationTimeoutMs: 15 });
  const { token } = register(broker, [fn("read")]);
  const result = broker.invoke(token, { wireName: "read" });
  await assert.rejects(result, { code: "web_tool_timeout" });
  assert.throws(() => broker.takeCalls(token), { code: "web_tool_turn_closed" });
  const second = register(broker, [fn("read")]);
  const controller = new AbortController();
  const cancelled = broker.invoke(second.token, { wireName: "read" }, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, /MCP consumer left/);
  controller.abort(new Error("MCP consumer left"));
  await rejected;
  await assert.rejects(broker.invoke(second.token, { wireName: "read" }), { code: "web_tool_turn_closed" });
  const third = register(broker, [fn("read")]);
  await assert.rejects(broker.invoke(third.token, { wireName: "read" }, { signal: controller.signal }), /MCP consumer left/);
  assert.throws(() => broker.takeCalls(third.token), { code: "web_tool_turn_closed" });
});

test("invalid invocation shapes cannot queue tools, and tool lists are isolated snapshots", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read"), custom("patch")]);
  const snapshot = broker.list(token).tools;
  snapshot[0].name = "write";
  assert.equal(broker.list(token).tools[0].name, "read");
  for (const payload of [
    { wireName: "missing" }, { wireName: "read", input: "raw" }, { wireName: "read", arguments: [] },
    { wireName: "read", arguments: new Date(0) },
    { wireName: "patch", arguments: {} }, { wireName: "patch", input: "raw", arguments: {} },
  ]) await assert.rejects(broker.invoke(token, payload));
  assert.deepEqual(broker.takeCalls(token), []);
  assert.throws(() => register(broker, [fn("read")]), { code: "web_tool_turn_active" });
  finish(broker, token);
});

test("client acceptance is independent of registration and declaration revisions", () => {
  const broker = createWebToolBroker(), { token } = register(broker, [fn("read")]);
  assert.equal(broker.hasClientActivity(token), false);
  broker.list(token).tools;
  broker.update(token, { tools: [fn("read")], toolChoice: "auto" });
  assert.ok(broker.revision(token) > 0);
  assert.equal(broker.hasClientActivity(token), false);
  const release = broker.beginActivity(token);
  assert.equal(broker.hasClientActivity(token), true);
  release();
  assert.equal(broker.hasClientActivity(token), true);
  broker.cancel(token);
  assert.equal(broker.hasClientActivity(token), true, "Retirement cannot erase authentic acceptance evidence.");
});

test("completion fences reject activity that starts and settles during a browser observation", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read")]);
  const before = broker.beginCompletion(token);
  assert.equal(typeof before, "number");
  assert.equal(broker.finish(token), false);
  const release = broker.beginActivity(token);
  assert.equal(broker.beginCompletion(token), undefined);
  assert.equal(broker.finish(token, before), false);
  release();
  release();
  const after = broker.beginCompletion(token);
  assert.equal(typeof after, "number");
  assert.notEqual(after, before);
  assert.equal(broker.finish(token, before), false);

  // Even a rejected direct invocation is new turn activity. It must not make
  // an older browser observation safe merely because no native call queued.
  await assert.rejects(broker.invoke(token, { wireName: "undeclared" }), /not declared and allowed/);
  assert.deepEqual(broker.takeCalls(token), []);
  assert.notEqual(broker.beginCompletion(token), after);
  assert.equal(broker.finish(token, after), false);
  const current = broker.beginCompletion(token);
  assert.equal(broker.finish(token, current), true);
  assert.equal(broker.beginCompletion(token), undefined);
  assert.throws(() => broker.beginActivity(token), { code: "web_tool_turn_closed" });
  await assert.rejects(broker.invoke(token, { wireName: "read" }), { code: "web_tool_turn_closed" });
  assert.equal(broker.finish(token, current), true);
  assert.equal(broker.finish(token, current + 1), false);
  assert.equal(broker.finish(token), false);
});

test("native output does not make a completion fence available before invocation settlement", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read")]);
  const before = broker.beginCompletion(token);
  const result = broker.invoke(token, { wireName: "read", arguments: { marker: "exact native call" } });
  assert.equal(broker.beginCompletion(token), undefined);
  assert.equal(broker.finish(token, before), false);
  const [call] = broker.takeCalls(token);
  broker.complete(token, [output(call, "actual native output")]);
  assert.deepEqual(broker.takeCalls(token), []);
  assert.equal(broker.beginCompletion(token), undefined);
  assert.equal(broker.finish(token, before), false);
  assert.deepEqual(await result, { content: [{ type: "text", text: "actual native output" }] });
  assert.equal(broker.finish(token, before), false);
  assert.equal(finish(broker, token), true);
});

test("declaration changes invalidate completion and retired activity cannot affect a replacement", () => {
  const broker = createWebToolBroker();
  const first = register(broker, [fn("read")]);
  const before = broker.beginCompletion(first.token);
  broker.update(first.token, { tools: [fn("write")] });
  assert.equal(broker.finish(first.token, before), false);
  const release = broker.beginActivity(first.token);
  broker.cancel(first.token);
  const replacement = register(broker, [fn("read")]);
  const current = broker.beginCompletion(replacement.token);
  release();
  assert.equal(broker.beginCompletion(replacement.token), current);
  assert.equal(broker.finish(first.token, before), false);
  assert.equal(broker.finish(replacement.token, current), true);
});

test("turn observation cannot lose a revision change and wakes only for its own activity", async () => {
  const broker = createWebToolBroker();
  const first = register(broker, [fn("read")]);
  const other = broker.register({ threadId: "other", turnId: "turn", tools: [] });
  const before = broker.revision(first.token);
  broker.update(first.token, { tools: [fn("write")] });
  assert.deepEqual(await broker.waitForChange(first.token, before), { revision: before + 1, closed: false });
  let resolved = false;
  const pending = broker.waitForChange(first.token, broker.revision(first.token));
  void pending.then(() => { resolved = true; });
  broker.update(other.token, { tools: [fn("other")] });
  await Promise.resolve();
  assert.equal(resolved, false);
  const release = broker.beginActivity(first.token);
  assert.deepEqual(await pending, { revision: before + 2, closed: false });
  const released = broker.waitForChange(first.token, broker.revision(first.token));
  release();
  assert.deepEqual(await released, { revision: before + 3, closed: false });
  finish(broker, first.token);
  finish(broker, other.token);
});

test("observation cancellation and deadline remove their subscription without retiring native work", async () => {
  const broker = createWebToolBroker();
  const { token } = register(broker, [fn("read")]);
  const revision = broker.revision(token);
  const controller = new AbortController();
  const pending = broker.waitForChange(token, revision, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const rejected = assert.rejects(pending, /observer left/u);
  controller.abort(new Error("observer left"));
  await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(broker.waitForChange(token, revision, { signal: controller.signal }), /observer left/u);
  const deadline = new AbortController();
  assert.deepEqual(await broker.waitForChange(token, revision, { signal: deadline.signal, timeoutMs: 1 }), { revision, closed: false });
  assert.equal(getEventListeners(deadline.signal, "abort").length, 0);
  const wake = new AbortController();
  const changed = broker.waitForChange(token, revision, { signal: wake.signal });
  broker.update(token, { tools: [fn("read")] });
  assert.deepEqual(await changed, { revision: revision + 1, closed: false });
  assert.equal(getEventListeners(wake.signal, "abort").length, 0);
  assert.equal(finish(broker, token), true);
});

test("actionable observations coalesce repeated discovery while retaining raw completion and ordinary observation fences", async () => {
  const broker = createWebToolBroker(), { token } = register(broker, [fn("read")]);
  const initial = broker.waitForChange(token, 0, { actionableOnly: true });
  const firstRelease = broker.beginActivity(token);
  assert.deepEqual(await initial, { revision: 1, closed: false }, "First authentic acceptance always wakes observation.");
  firstRelease();
  const before = broker.revision(token);
  let woke = false;
  const pending = broker.waitForChange(token, before, { actionableOnly: true });
  void pending.then(() => { woke = true; });
  const ordinary = broker.waitForChange(token, before);
  for (let index = 0; index < 8; index += 1) {
    const release = broker.beginActivity(token);
    broker.list(token);
    release();
  }
  await Promise.resolve();
  assert.equal(woke, false);
  assert.equal(broker.revision(token), before + 16);
  assert.deepEqual(await ordinary, { revision: before + 1, closed: false });
  assert.deepEqual(broker.takeCalls(token), []);
  const invoked = broker.invoke(token, { wireName: "read" });
  assert.deepEqual(await pending, { revision: before + 18, closed: false }, "A real native enqueue must wake after coalesced discovery.");
  const [call] = broker.takeCalls(token);
  broker.complete(token, [output(call, "actual output")]);
  await invoked;
  const fence = broker.beginCompletion(token);
  const release = broker.beginActivity(token);
  assert.equal(broker.beginCompletion(token), undefined);
  release();
  assert.equal(broker.finish(token, fence), false, "A discovery spanning a completed-page snapshot still requires a new quiet read.");
  assert.equal(broker.finish(token, undefined), false);
  assert.notEqual(broker.beginCompletion(token), fence);
  assert.equal(finish(broker, token), true);
});

test("actionable observations cannot lose earlier actions and retain cancellation, deadline, catalog and retirement semantics", async () => {
  const broker = createWebToolBroker(), { token } = register(broker, [fn("read")]);
  const release = broker.beginActivity(token);
  release();
  assert.deepEqual(await broker.waitForChange(token, 0, { actionableOnly: true }), { revision: 2, closed: false });
  const before = broker.revision(token);
  const deadline = broker.waitForChange(token, before, { actionableOnly: true, timeoutMs: 1 });
  const repeated = broker.beginActivity(token);
  repeated();
  assert.deepEqual(await deadline, { revision: before, closed: false }, "A coalesced revision must still be reported as a deadline.");
  const controller = new AbortController();
  controller.abort(new Error("observer left"));
  await assert.rejects(broker.waitForChange(token, before, { actionableOnly: true, signal: controller.signal }), /observer left/u);
  const pending = broker.waitForChange(token, before, { actionableOnly: true });
  broker.update(token, { tools: [fn("write")] });
  assert.deepEqual(await pending, { revision: before + 3, closed: false }, "An accepted catalog change remains actionable.");
  const current = broker.revision(token);
  const closed = broker.waitForChange(token, current, { actionableOnly: true });
  finish(broker, token);
  assert.deepEqual(await closed, { revision: current, closed: true });
  assert.deepEqual(await broker.waitForChange(token, current, { actionableOnly: true }), { revision: current, closed: true });
  assert.throws(() => broker.waitForChange(token, current, { actionableOnly: "yes" }), { code: "invalid_web_tool_call" });
});

test("retirement wakes observers and old observers cannot bind to a replacement turn", async () => {
  const broker = createWebToolBroker();
  const first = register(broker, []);
  const revision = broker.revision(first.token);
  const pending = broker.waitForChange(first.token, revision);
  assert.equal(finish(broker, first.token), true);
  assert.deepEqual(await pending, { revision, closed: true });
  assert.deepEqual(await broker.waitForChange(first.token, revision), { revision, closed: true });
  assert.equal(broker.revision(first.token), revision);
  const replacement = register(broker, []);
  const cancelled = broker.waitForChange(replacement.token, broker.revision(replacement.token));
  broker.cancel(replacement.token);
  assert.deepEqual(await cancelled, { revision: 0, closed: true });
  assert.throws(() => broker.revision("unknown"), { code: "web_tool_turn_closed" });
  assert.throws(() => broker.waitForChange("unknown", 0), { code: "web_tool_turn_closed" });
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    assert.throws(() => broker.waitForChange(first.token, value), { code: "invalid_web_tool_call" });
  }
  assert.throws(() => broker.waitForChange(first.token, revision + 1), { code: "invalid_web_tool_call" });
  for (const timeoutMs of [0, -1, 25_001, 0.5, NaN]) {
    assert.throws(() => broker.waitForChange(first.token, revision, { timeoutMs }), { code: "invalid_web_tool_call" });
  }
});
