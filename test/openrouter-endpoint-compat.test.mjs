import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_BY_SLUG, validateOpenRouterRoute } from "../src/routed-models.mjs";
import { prepareRoutedRequest } from "../src/routed-request.mjs";
import { prepareOpenRouterRequest } from "../src/openrouter-request.mjs";
import { buildNamespaceLookups, rewriteNamespaceFunctionCall } from "../src/namespace-relay.mjs";

const streamlake = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash-streamlake");
const deepseeks = ["together", "deepinfra"].map(id => MODEL_BY_SLUG.get(`openrouter/deepseek-v4.1-flash-${id}`));
const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];

test("StreamLake implements none without available tools and rejects forced choices at both boundaries", () => {
  const input = [{ type: "function_call", name: "lookup", call_id: "call", arguments: "{}" },
    { type: "function_call_output", call_id: "call", output: "42" }];
  const original = { model: streamlake.slug, input, tools, tool_choice: "none" };
  const saved = structuredClone(original);
  const front = prepareRoutedRequest(original, streamlake).payload;
  const sent = prepareOpenRouterRequest(original);
  for (const output of [front, sent]) {
    assert.equal(output.tools, undefined);
    assert.equal(output.tool_choice, undefined);
    assert.deepEqual(output.input, input);
  }
  assert.deepEqual(original, saved);
  for (const tool_choice of ["required", { type: "function", name: "lookup" },
    { type: "allowed_tools", mode: "required", tools }]) {
    const body = { ...original, tool_choice };
    for (const prepare of [p => prepareRoutedRequest(p, streamlake), prepareOpenRouterRequest]) {
      assert.throws(() => prepare(body), e => e.status === 400 && e.code === "unsupported_tool_choice");
    }
  }
  const together = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash-together");
  assert.equal(prepareOpenRouterRequest({ model: together.slug, tools, tool_choice: "required" }).tool_choice, "required");
});

test("reasoning route defaults respect explicit settings and reject output limits beyond the exact route", () => {
  for (const route of [streamlake, MODEL_BY_SLUG.get("openrouter/glm-5.3-flash-together"), ...deepseeks]) {
    const defaults = prepareOpenRouterRequest({ model: route.slug, input: "synthetic" });
    assert.equal(defaults.temperature, 1);assert.equal(defaults.top_p, .95);
    assert.equal(defaults.reasoning.effort, route.defaultEffort);
    assert.equal(defaults.max_output_tokens, 128000);
    const front = prepareRoutedRequest({ input: "synthetic" }, route).payload;
    assert.equal(front.temperature, 1);assert.equal(front.top_p, .95);
    assert.equal(front.max_output_tokens, 128000);
    const chat = prepareOpenRouterRequest({ model: route.slug, messages: [] });
    assert.equal(chat.max_tokens, 128000);assert.equal(chat.max_output_tokens, undefined);
    const explicit = prepareOpenRouterRequest({ model: route.slug, temperature: .3, top_p: .8,
      reasoning: { effort: "low" }, max_output_tokens: 4096 });
    assert.equal(explicit.temperature, .3);assert.equal(explicit.top_p, .8);
    assert.equal(explicit.reasoning.effort, "low");assert.equal(explicit.max_output_tokens, 4096);
    for (const limit of [0, -1, 2.5, route.maxOutputTokens + 1]) {
      assert.throws(() => prepareOpenRouterRequest({ model: route.slug, max_output_tokens: limit }),
        e => e.code === "unsupported_output_limit");
    }
    assert.throws(() => validateOpenRouterRoute({ ...route, autoCompact: route.contextWindow - 1 }), /headroom/);
  }
  const pareto = prepareOpenRouterRequest({ model: "openrouter/pareto", input: "synthetic" });
  assert.equal(pareto.reasoning, undefined);assert.equal(pareto.temperature, undefined);
  assert.equal(pareto.max_output_tokens, undefined);
});

test("external profiles retain produced reasoning and bridge custom tool history reversibly", () => {
  for (const route of [streamlake, MODEL_BY_SLUG.get("openrouter/glm-5.3-flash-together"), ...deepseeks]) {
    const reasoning = { type: "reasoning", id: "rs_synthetic", summary: [{ type: "summary_text", text: "Preserved reasoning 42." }] };
    const custom = { type: "custom", name: "patch", description: "Synthetic patch", format: { type: "text" } };
    const call = { type: "custom_tool_call", call_id: "call_synthetic", name: "patch", input: "synthetic payload" };
    const input = [reasoning, call, { type: "custom_tool_call_output", call_id: call.call_id, output: "42" }];
    const original = { input, tools: [custom], reasoning: { effort: "high" } };
    const saved = structuredClone(original);
    const prepared = prepareRoutedRequest(original, route);
    assert.equal(prepared.transport, route.requestProfile === "glm-5.3-flash" ? "chat" : "responses");assert.equal(prepared.payload.tools[0].type, "function");
    const sent = prepareOpenRouterRequest(prepared.payload);
    assert.deepEqual(sent.input[0], reasoning);
    assert.equal(sent.input[1].type, "function_call");
    assert.equal(sent.input[1].call_id, call.call_id);
    assert.equal(JSON.parse(sent.input[1].arguments).input, call.input);
    assert.equal(sent.input[2].type, "function_call_output");assert.equal(sent.input[2].output, "42");
    const restored = rewriteNamespaceFunctionCall({ type: "response.output_item.done", item: sent.input[1] }, buildNamespaceLookups(prepared.namespaces));
    assert.equal(restored.item.type, "custom_tool_call");assert.equal(restored.item.input, call.input);
    assert.deepEqual(original, saved);
    const compact = prepareRoutedRequest(original, route, { compaction: true });
    assert.deepEqual(compact.payload.input[0], reasoning);assert.deepEqual(compact.payload.tools, []);
    assert.throws(() => validateOpenRouterRoute({ ...route, openRouterProviderPolicy: { ...route.openRouterProviderPolicy, allow_fallbacks: true } }), /endpoint/);
  }
});
