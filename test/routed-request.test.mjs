import assert from "node:assert/strict";
import test from "node:test";
import { prepareRoutedRequest } from "../src/routed-request.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
const route = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");
function chatProviderToolSurface(tools) {
  const prepared = prepareRoutedRequest({ tools, input: [] }, route);
  return { tools: prepared.payload.tools, namespaces: prepared.namespaces };
}
import { buildNamespaceLookups, rewriteNamespaceFunctionCall } from "../src/namespace-relay.mjs";

test("one request preparer preserves profile-specific turns and tool-disabled compaction without mutation", () => {
  for (const slug of ["openrouter/glm-5.3-flash", "openrouter/glm-5.3-flash-gmicloud", "openrouter/union-alpha"]) {
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
    assert.equal(turn.transport, slug.includes("union") ? "responses" : "chat");
    assert.equal(compact.transport, turn.transport);
    assert.deepEqual(turn.payload.tools.map(tool => tool.name), ["app__read"]);
    assert.deepEqual(compact.payload.tools, []);
    assert.equal(compact.payload.previous_response_id, undefined);
    assert.equal(compact.payload.tool_choice, undefined);
    assert.equal(compact.payload.stream, false);
    assert.deepEqual(compact.payload.input.slice(0, 2), original.input);
    assert.equal(turn.payload.client_metadata, undefined);
    if (slug.includes("union")) {
      assert.deepEqual(turn.payload.input, original.input);
      assert.equal(turn.payload.reasoning, undefined);
    } else {
      assert.equal(turn.payload.reasoning.effort, "max");
      assert.equal(turn.payload.input[1].content[0].type, "thinking");
      assert.equal(compact.payload.reasoning.effort, "high");
    }
  }
  assert.throws(() => prepareRoutedRequest({ input: [] }, MODEL_BY_SLUG.get("switchyard/auto")), /Native requests/);
});

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
    } }, buildNamespaceLookups(surface.namespaces), "openrouter/glm-5.3-flash");
    assert.deepEqual(JSON.parse(restored.item.arguments), args.model || args.target.type === "chatgptWorkCloud"
      ? args : { ...args, model: "openrouter/glm-5.3-flash" });
  }
});
