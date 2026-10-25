import assert from "node:assert/strict";
import test from "node:test";
import { prepareRoutedRequest } from "../src/routed-request.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
const route = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash-streamlake");
const externalSlugs = ["openrouter/glm-5.3-flash-streamlake", "openrouter/glm-5.3-flash-together", "openrouter/deepseek-v4.1-flash-together", "openrouter/deepseek-v4.1-flash-deepinfra", "openrouter/pareto"];
function chatProviderToolSurface(tools) {
  const prepared = prepareRoutedRequest({ tools, input: [] }, route);
  return { tools: prepared.payload.tools, namespaces: prepared.namespaces };
}
import { buildNamespaceLookups, rewriteNamespaceFunctionCall } from "../src/namespace-relay.mjs";

test("one request preparer preserves profile-specific turns and tool-disabled compaction without mutation", () => {
  for (const slug of externalSlugs) {
    const selected = MODEL_BY_SLUG.get(slug);
    const original = { input: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "Earlier reasoning" }] },
      { type: "message", role: "assistant", content: "Earlier answer" },
    ], tools: [{ type: "namespace", name: "app", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }],
    reasoning: { effort: "high" }, previous_response_id: "previous", client_metadata: { unused: "metadata" } };
    const saved = structuredClone(original);
    const turn = prepareRoutedRequest(original, selected, { childEffort: "max" });
    const compact = prepareRoutedRequest(original, selected, { compaction: true, compactionMessages: [{ role: "user", content: "Summarize" }] });
    assert.deepEqual(original, saved);
    assert.equal(turn.transport, slug.includes("glm-") ? "chat" : "responses");
    assert.equal(compact.transport, turn.transport);
    assert.deepEqual(turn.payload.tools.map(tool => tool.name), ["app__read"]);
    assert.deepEqual(compact.payload.tools, []);
    assert.equal(compact.payload.previous_response_id, undefined);
    assert.equal(compact.payload.tool_choice, undefined);
    assert.equal(compact.payload.stream, false);
    assert.deepEqual(compact.payload.input.slice(0, 2), original.input);
    assert.equal(turn.payload.client_metadata, undefined);
    if (slug.includes("pareto")) {
      assert.deepEqual(turn.payload.input, original.input);
      assert.equal(turn.payload.reasoning, undefined);
    } else {
      assert.equal(turn.payload.reasoning.effort, "max");
      assert.deepEqual(turn.payload.input, original.input);
      assert.equal(compact.payload.reasoning.effort, "high");
    }
  }
  const native = { input: [{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "native_tool" }] }] };
  const nativeSaved = structuredClone(native);
  assert.throws(() => prepareRoutedRequest(native, MODEL_BY_SLUG.get("switchyard/auto")), /Native requests/);
  assert.deepEqual(native, nativeSaved);
});

for (const slug of externalSlugs) {
  test(`native model-switch tool history is consumed without granting capabilities for ${slug}`, () => {
    const selected = MODEL_BY_SLUG.get(slug);
    const currentTools = [
      { type: "function", name: "read", description: "Current schema.", parameters: {
        type: "object", properties: { current: { type: "boolean" } }, required: ["current"], additionalProperties: false,
      } },
      { type: "namespace", name: "mcp__fixture", tools: [{ type: "function", name: "inspect", parameters: {
        type: "object", properties: { id: { type: "string" } }, required: ["id"],
      } }] },
    ];
    const ordinaryHistory = [
      { type: "message", role: "user", content: "Earlier native turn." },
      { type: "message", role: "assistant", content: "Earlier answer." },
      { type: "function_call", call_id: "call_read", name: "read", arguments: '{"current":true}' },
      { type: "function_call_output", call_id: "call_read", output: "Synthetic result." },
      { type: "message", role: "developer", content: "Keep this ordinary instruction." },
      { type: "message", role: "user", content: "Continue with the external model." },
    ];
    const history = [
      ordinaryHistory[0],
      { type: "additional_tools", role: "developer", tools: [
        { type: "function", name: "read", description: "Stale schema.", parameters: { type: "object", properties: { stale: { type: "string" } } } },
      ] },
      ...ordinaryHistory.slice(1, 4),
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "historical_only" }] },
      ...ordinaryHistory.slice(4),
    ];
    for (const tools of [currentTools, [], undefined]) {
      for (const compaction of [false, true]) {
        const original = { input: history, tools, stream: true, previous_response_id: "native_previous" };
        const saved = structuredClone(original);
        const options = compaction ? { compaction: true, input: history, compactionMessages: [{ role: "user", content: "Summarize." }] } : {};
        const expected = prepareRoutedRequest({ ...original, input: ordinaryHistory }, selected,
          compaction ? { ...options, input: ordinaryHistory } : options);
        const actual = prepareRoutedRequest(original, selected, options);
        assert.equal(actual.payload.input.some(item => item.type === "additional_tools"), false);
        assert.deepEqual(actual.payload.input, expected.payload.input, "ordinary messages, calls, results and order survive");
        assert.deepEqual(actual.payload.tools, expected.payload.tools, "historical schemas cannot alter current declarations");
        if (!compaction && tools === undefined) assert.equal(actual.payload.tools, undefined);
        else assert.deepEqual(actual.payload.tools.map(tool => tool.name), !compaction && tools === currentTools ? ["read", "mcp__fixture__inspect"] : []);
        assert.deepEqual(original, saved, "the caller's history and full current tools stay unchanged");
      }
    }
  });
}

test("current app tools use the caller's namespace and schema without snapshot additions", () => {
  const parameters = { type: "object", properties: { live: { type: "boolean" } } };
  const input = [{ type: "namespace", name: "mcp__codex_app", tools: [
    { type: "function", name: "list_projects", parameters },
  ] }];
  const surface = chatProviderToolSurface(input);
  assert.deepEqual(surface.tools.map(tool => tool.name), ["mcp__codex_app__list_projects"]);
  assert.deepEqual(surface.tools[0].parameters, parameters);
  const restored = rewriteNamespaceFunctionCall({ type: "response.output_item.done", item: {
    type: "function_call", name: surface.tools[0].name, call_id: "call", arguments: "{}",
  } }, buildNamespaceLookups(surface.namespaces));
  assert.equal(restored.item.namespace, "mcp__codex_app");
  assert.equal(restored.item.name, "list_projects");
  assert.equal(input[0].tools.length, 1);
});

test("an absent or reduced app surface does not grant undeclared capabilities", () => {
  assert.deepEqual(chatProviderToolSurface([]).tools, []);
  const tools = chatProviderToolSurface([{ type: "namespace", name: "codex_app", tools: [
    { type: "function", name: "read_thread_terminal" },
  ] }]).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["codex_app__read_thread_terminal"]);
});

test("current app task calls retain local model inheritance and explicit/cloud choices", () => {
  const surface = chatProviderToolSurface([{ type: "namespace", name: "mcp__codex_app", tools: [
    { type: "function", name: "create_thread", parameters: { type: "object" } },
  ] }]);
  for (const args of [
    { prompt: "new", target: { type: "projectless" } },
    { prompt: "new", target: { type: "projectless" }, model: "gpt-5.6-sol" },
    { prompt: "new", target: { type: "chatgptWorkCloud" } },
  ]) {
    const restored = rewriteNamespaceFunctionCall({ type: "response.output_item.done", item: {
      type: "function_call", name: "mcp__codex_app__create_thread", call_id: "new-task", arguments: JSON.stringify(args),
    } }, buildNamespaceLookups(surface.namespaces), "openrouter/glm-5.3-flash-streamlake");
    assert.deepEqual(JSON.parse(restored.item.arguments), args.model || args.target.type === "chatgptWorkCloud"
      ? args : { ...args, model: "openrouter/glm-5.3-flash-streamlake" });
  }
});
