import assert from "node:assert/strict";
import test from "node:test";
import { providerToolSchema, hasObjectRoot } from "../src/tool-schema-root.mjs";
import { prepareRoutedRequest } from "../src/routed-request.mjs";
import { prepareOpenRouterRequest } from "../src/openrouter-request.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { buildNamespaceLookups, flattenNamespaceTools, rewriteNamespaceFunctionCall } from "../src/namespace-relay.mjs";

function modeSchema(keyword = "oneOf") {
  return { description: "Synthetic action modes.", [keyword]: [
    { type: "object", properties: { mode: { type: "string", const: "create" }, name: { type: "string" }, payload: { type: "string" } }, required: ["mode", "name", "payload"], additionalProperties: false },
    { type: "object", properties: { mode: { type: "string", enum: ["update"] }, id: { type: "string" }, payload: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false } }, required: ["mode", "id", "payload"], additionalProperties: false },
    { type: "object", properties: { mode: { type: "string", const: "view" }, id: { type: "string" } }, required: ["mode", "id"], additionalProperties: false },
    { type: "object", properties: { mode: { type: "string", enum: ["delete"] }, id: { type: "string" } }, required: ["mode", "id"], additionalProperties: false },
  ] };
}

const routes = ["openrouter/glm-5.3-flash-streamlake", "openrouter/glm-5.3-flash-together", "openrouter/deepseek-v4.1-flash-together", "openrouter/deepseek-v4.1-flash-deepinfra", "openrouter/pareto"];
const legalCalls = [
  { mode: "create", name: "new", payload: "text" },
  { mode: "update", id: "x", payload: { enabled: true } },
  { mode: "view", id: "x" },
  { mode: "delete", id: "x" },
];

test("object union branches retain every mode, required field, and duplicate property shape through external preparation and replay", () => {
  for (const keyword of ["oneOf", "anyOf"]) {
    const schema = modeSchema(keyword);
    const ordinary = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
    const tools = [{ type: "namespace", name: "synthetic", tools: [
      { type: "function", name: "action", inputSchema: schema },
      { type: "function", name: "ordinary", parameters: ordinary },
    ] }];
    const original = structuredClone(tools);
    for (const slug of routes) {
      const route = MODEL_BY_SLUG.get(slug);
      for (const hosted of route.searchTool ? [false, true] : [false]) {
        const payload = { input: [], tools: hosted ? [...tools, { type: "web_search" }] : tools };
        const prepared = prepareRoutedRequest(payload, route);
        const final = prepareOpenRouterRequest(prepared.payload);
        assert.equal(prepared.transport, hosted || route.requestProfile !== "glm-5.3-flash" ? "responses" : "chat");
        assert.deepEqual(final.tools[0].parameters, { ...original[0].tools[0].inputSchema, type: "object" });
        assert.equal(Object.hasOwn(final.tools[0], "inputSchema"), false);
        assert.equal(tools[0].tools[0].inputSchema, schema);
        assert.equal(final.tools[1].parameters, ordinary);
        assert.equal(final.tools[0].parameters[keyword][0].properties.mode.const, "create");
        assert.deepEqual(final.tools[0].parameters[keyword][1].properties.mode.enum, ["update"]);
        assert.deepEqual(final.tools[0].parameters[keyword].map(branch => branch.required), [["mode", "name", "payload"], ["mode", "id", "payload"], ["mode", "id"], ["mode", "id"]]);
        assert.equal(final.tools[0].parameters[keyword][0].properties.payload.type, "string");
        assert.equal(final.tools[0].parameters[keyword][1].properties.payload.type, "object");
        assert.ok(final.tools[0].parameters[keyword].every(branch => branch.additionalProperties === false));
        for (const args of legalCalls) {
          const argumentsText = JSON.stringify(args);
          const native = { type: "function_call", name: "action", namespace: "synthetic", call_id: `call_${args.mode}`, arguments: argumentsText };
          const restored = rewriteNamespaceFunctionCall({ type: "response.output_item.done", item: { ...native, name: final.tools[0].name, namespace: undefined } }, buildNamespaceLookups(prepared.namespaces));
          assert.deepEqual(restored.item, native);
          const replay = prepareRoutedRequest({ ...payload, input: [restored.item, { type: "function_call_output", call_id: native.call_id, output: "synthetic result" }] }, route);
          assert.equal(replay.payload.input[0].name, final.tools[0].name);
          assert.equal(replay.payload.input[0].call_id, native.call_id);
          assert.equal(replay.payload.input[0].arguments, argumentsText);
          assert.equal(replay.payload.input[1].call_id, native.call_id);
          assert.deepEqual(prepareOpenRouterRequest(replay.payload).tools[0].parameters, final.tools[0].parameters);
        }
      }
    }
    assert.deepEqual(tools, original);
  }
});

test("allOf conjunction and root constraints survive external preparation", () => {
  const schema = { title: "Conjunction", minProperties: 2, propertyNames: { pattern: "^[a-z]+$" },
    properties: { left: { type: "string" }, right: { type: "number" } }, required: ["left"], additionalProperties: false, allOf: [
    { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
    { type: "object", properties: { right: { type: "number" } }, required: ["right"] },
  ] };
  for (const slug of routes) {
    const prepared = prepareRoutedRequest({ input: [], tools: [{ type: "function", name: "conjunction", parameters: schema }] }, MODEL_BY_SLUG.get(slug));
    assert.deepEqual(prepareOpenRouterRequest(prepared.payload).tools[0].parameters, { ...schema, type: "object" });
  }
  assert.equal(schema.type, undefined);
});

test("referenced object unions preserve local refs, definitions, and root constraints without reconstruction", () => {
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Referenced modes", minProperties: 1,
    $defs: { create: modeSchema().oneOf[0] }, definitions: { "view/path~": modeSchema().oneOf[2] },
    oneOf: [{ $ref: "#/$defs/create" }, { $ref: "#/definitions/view~1path~0" }],
    not: { required: ["forbidden"] },
  };
  const expected = { ...structuredClone(schema), type: "object" };
  for (const slug of routes) {
    const prepared = prepareRoutedRequest({ input: [], tools: [{ type: "namespace", name: "synthetic", tools: [{ type: "function", name: "refs", inputSchema: schema }] }] }, MODEL_BY_SLUG.get(slug));
    assert.deepEqual(prepareOpenRouterRequest(prepared.payload).tools[0].parameters, expected);
  }
  assert.equal(schema.type, undefined);
  const explicit = { ...schema, type: "object" };
  assert.equal(providerToolSchema(explicit), explicit);
  assert.equal(hasObjectRoot(explicit), true);
});

test("plain, nested function, client tool-search, and discovered declarations share union preservation", () => {
  const schema = modeSchema();
  const expected = { ...structuredClone(schema), type: "object" };
  const plain = { type: "function", name: "plain_action", parameters: schema };
  const nested = { type: "function", function: { name: "nested_action", parameters: schema } };
  assert.deepEqual(flattenNamespaceTools([nested]).tools[0].function.parameters, expected);
  for (const slug of routes) {
    const route = MODEL_BY_SLUG.get(slug);
    const initial = prepareRoutedRequest({ input: [], tools: [plain, { type: "tool_search", execution: "client", parameters: schema }] }, route);
    const final = prepareOpenRouterRequest(initial.payload);
    assert.deepEqual(final.tools[0].parameters, expected);
    assert.deepEqual(final.tools[1].parameters, expected);
    const discovery = prepareRoutedRequest({ tools: [{ type: "tool_search", execution: "client" }], input: [
      { type: "tool_search_call", call_id: "search", execution: "client", arguments: { query: "synthetic" } },
      { type: "tool_search_output", call_id: "search", execution: "client", status: "completed", tools: [
        { type: "namespace", name: "discovered", tools: [{ type: "function", name: "action", inputSchema: schema }] },
        { type: "function", name: "discovered_plain", parameters: schema },
      ] },
    ] }, route);
    const discovered = prepareOpenRouterRequest(discovery.payload).tools.filter(tool => tool.name !== "tool_search");
    assert.equal(discovered.length, 2);
    for (const tool of discovered) {
      assert.deepEqual(tool.parameters, expected);
      assert.equal(Object.hasOwn(tool, "inputSchema"), false);
    }
    const args = JSON.stringify(legalCalls[1]);
    const restored = rewriteNamespaceFunctionCall({ type: "response.output_item.done", item: { type: "function_call", name: "discovered__action", call_id: "update", arguments: args } }, buildNamespaceLookups(discovery.namespaces));
    assert.deepEqual(restored.item, { type: "function_call", namespace: "discovered", name: "action", call_id: "update", arguments: args });
  }
});

test("primitive-only, explicitly nonobject, and unresolved unions are not promoted", () => {
  for (const schema of [
    { oneOf: [{ type: "string" }, { type: "number" }] },
    { anyOf: [{ type: "string", properties: { misleading: {} } }, { type: "null" }] },
    { type: "string", oneOf: [{ type: "object" }] },
    { type: ["string", "null"], anyOf: [{ type: "object" }] },
    { oneOf: [{ $ref: "#/missing" }] },
    { oneOf: [{ $ref: "#anchor" }] },
    { $defs: { loop: { $ref: "#/$defs/loop" } }, oneOf: [{ $ref: "#/$defs/loop" }] },
    { oneOf: [{ $dynamicRef: "#object" }] },
  ]) assert.equal(providerToolSchema(schema), schema);
  const untyped = { anyOf: [{ properties: { name: { type: "string" } } }] };
  assert.deepEqual(providerToolSchema(untyped), { ...untyped, type: "object" });
  const nullableBranch = { oneOf: [{ type: ["object", "null"], properties: {} }] };
  assert.deepEqual(providerToolSchema(nullableBranch), { ...nullableBranch, type: "object" });
});

test("ordinary object identity, nullable-object narrowing, and contradictory literal normalization remain scoped", () => {
  const ordinary = { type: "object", properties: { enabled: { type: "boolean", enum: [true, false] } }, additionalProperties: false };
  assert.equal(providerToolSchema(ordinary), ordinary);
  const nullable = { ...ordinary, type: ["object", "null"], required: ["enabled"], title: "Nullable", allOf: [{ properties: { enabled: { const: true } } }] };
  assert.deepEqual(providerToolSchema(nullable), { ...nullable, type: "object" });
  assert.deepEqual(nullable.type, ["object", "null"]);
  const contradictory = { type: "object", properties: { enabled: { type: "boolean", enum: [true, "false"] }, count: { type: "number", const: "2" } } };
  const snapshot = structuredClone(contradictory);
  assert.deepEqual(providerToolSchema(contradictory), { type: "object", properties: { enabled: { type: "boolean", enum: [true] }, count: { type: "number" } } });
  assert.deepEqual(contradictory, snapshot);
});

test("promoted and narrowed object roots align literals with their resulting type", () => {
  const legal = { enabled: true };
  const base = { properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false, enum: [null, legal] };
  const nullable = { ...base, type: ["object", "null"] };
  const explicit = { ...base, type: "object" };
  const nullableSnapshot = structuredClone(nullable);
  const explicitSnapshot = structuredClone(explicit);
  const expected = { ...base, type: "object", enum: [legal] };
  assert.deepEqual(providerToolSchema(nullable), expected);
  assert.deepEqual(providerToolSchema(explicit), expected);
  assert.deepEqual(nullable, nullableSnapshot);
  assert.deepEqual(explicit, explicitSnapshot);

  const union = { oneOf: [{ type: "object", properties: base.properties, required: base.required, additionalProperties: false }], enum: [null, "primitive", legal], const: null };
  const unionSnapshot = structuredClone(union);
  const promoted = providerToolSchema(union);
  assert.deepEqual(promoted, { oneOf: union.oneOf, enum: [legal], type: "object" });
  assert.deepEqual(union, unionSnapshot);
  assert.equal(promoted.oneOf, union.oneOf);
  const legalConst = { ...union, const: legal };
  assert.deepEqual(providerToolSchema(legalConst), { ...promoted, const: legal });
  assert.equal(providerToolSchema(promoted), promoted);
});
