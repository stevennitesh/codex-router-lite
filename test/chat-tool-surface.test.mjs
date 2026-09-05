import assert from "node:assert/strict";
import test from "node:test";
import { chatProviderToolSurface } from "../src/chat-tool-surface.mjs";
import { buildNamespaceLookups, rewriteNamespaceFunctionCall } from "../src/namespace-relay.mjs";

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
