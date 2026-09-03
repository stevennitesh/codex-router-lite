import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_APP_TOOL_SNAPSHOT,
  CODEX_APP_TOOL_NAMES,
  CODEX_APP_TOOLS,
  mergeCodexAppTools,
  splitFlatCodexAppName,
} from "../src/codex-app-tools.mjs";

test("the app tool snapshot records its paired Windows and Codex builds", () => {
  assert.match(CODEX_APP_TOOL_SNAPSHOT.windowsAppVersion, /^\d+(?:\.\d+){3}$/u);
  assert.match(CODEX_APP_TOOL_SNAPSHOT.codexVersion, /^codex-cli \d+\.\d+\.\d+/u);
  assert.match(CODEX_APP_TOOL_SNAPSHOT.capturedAt, /^\d{4}-\d{2}-\d{2}$/u);
});

// The reduced codex_app namespace the client actually sends on routed requests
// (captured live: load_workspace_dependencies, navigate_to_codex_page,
// read_thread_terminal).
function clientRoutedTools() {
  return [
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
        { type: "function", name: "load_workspace_dependencies" },
        { type: "function", name: "navigate_to_codex_page" },
        { type: "function", name: "read_thread_terminal" },
      ],
    },
  ];
}

function fullAppToolNames(namespace) {
  const names = [];
  for (const entry of CODEX_APP_TOOLS) {
    if (namespace && entry.name !== namespace) continue;
    for (const fn of entry.tools || []) names.push(fn.name);
  }
  return names;
}

function appTool(name) {
  return CODEX_APP_TOOLS
    .find((entry) => entry.name === "codex_app")
    ?.tools.find((tool) => tool.name === name);
}

const CURRENT_CODEX_APP_TOOLS = [
  "automation_update",
  "capture_screen_context",
  "consume_usage_reset",
  "create_sidebar_section",
  "create_thread",
  "delete_sidebar_section",
  "end_realtime_voice_call",
  "fork_thread",
  "get_handoff_status",
  "get_usage_limits",
  "handoff_thread",
  "list_archived_threads",
  "list_projects",
  "list_threads",
  "load_workspace_dependencies",
  "move_project_to_sidebar_section",
  "move_thread_to_sidebar_section",
  "navigate_to_codex_page",
  "open_in_codex",
  "read_thread",
  "read_thread_terminal",
  "rename_sidebar_section",
  "reorder_section",
  "reorder_sidebar_projects",
  "reorder_sidebar_sections",
  "send_message_to_thread",
  "set_thread_archived",
  "set_thread_title",
  "share_thread",
  "wait_threads",
].sort();

test("snapshot exactly matches the current native codex_app tool inventory", () => {
  assert.deepEqual(fullAppToolNames("codex_app").sort(), CURRENT_CODEX_APP_TOOLS);
  for (const name of CURRENT_CODEX_APP_TOOLS) {
    assert.ok(CODEX_APP_TOOL_NAMES.has(name), `snapshot must carry ${name}`);
  }
  assert.equal(CODEX_APP_TOOL_NAMES.size, CURRENT_CODEX_APP_TOOLS.length);
});

test("snapshot carries current task, sidebar, and routed-model contracts", () => {
  const createThread = appTool("create_thread");
  assert.match(createThread.description, /user-visible message/);
  const project = createThread.inputSchema.properties.target.anyOf.find(
    (target) => target.properties.type.enum.includes("project"),
  );
  const worktree = project.properties.environment.anyOf.find(
    (environment) => environment.properties.type.enum.includes("worktree"),
  );
  const branch = worktree.properties.startingState.anyOf.find(
    (state) => state.properties.type.enum.includes("branch"),
  );
  assert.deepEqual(branch.properties.onMissing.enum, ["error", "create-branch"]);

  const modelDescription = createThread.inputSchema.properties.model.description;
  assert.match(modelDescription, /validated on the destination host/);
  assert.doesNotMatch(modelDescription, /gpt-5|switchyard|openrouter/);

  const moveThread = appTool("move_thread_to_sidebar_section");
  assert.ok(moveThread.inputSchema.required.includes("sectionId"));
  assert.deepEqual(
    moveThread.inputSchema.properties.sectionId.anyOf.map((schema) => schema.type),
    ["string", "null"],
  );

  const sendMessage = appTool("send_message_to_thread");
  assert.match(sendMessage.description, /user-visible message/);
  assert.match(
    sendMessage.inputSchema.properties.model.description,
    /validated on the target host/,
  );

});

test("merge fills the deferred app tools into the reduced client namespace", () => {
  const { tools, merged } = mergeCodexAppTools(clientRoutedTools());
  assert.equal(merged, true);
  const codexApp = tools.find((tool) => tool?.type === "namespace" && tool.name === "codex_app");
  assert.ok(codexApp, "codex_app namespace present after merge");
  const names = codexApp.tools.map((fn) => fn.name);
  for (const name of fullAppToolNames("codex_app")) {
    assert.ok(names.includes(name), `merged codex_app must include ${name}`);
  }
  // Nothing the client sent is dropped.
  assert.ok(names.includes("load_workspace_dependencies"));
  assert.ok(names.includes("navigate_to_codex_page"));
  assert.ok(names.includes("read_thread_terminal"));
  // Non-app tools are untouched.
  assert.ok(tools.some((tool) => tool.name === "exec_command"));
  assert.ok(
    tools.some(
      (tool) =>
        tool?.type === "namespace" &&
        tool.name === "collaboration" &&
        tool.tools.some((fn) => fn.name === "spawn_agent"),
    ),
  );
});

test("merge appends the full app namespaces when the client omits them", () => {
  const { tools, merged } = mergeCodexAppTools([
    { type: "function", name: "exec_command" },
  ]);
  assert.equal(merged, true);
  const codexApp = tools.find((tool) => tool?.type === "namespace" && tool.name === "codex_app");
  assert.ok(codexApp, "codex_app appended when absent");
  for (const name of fullAppToolNames("codex_app")) {
    assert.ok(
      codexApp.tools.some((fn) => fn.name === name),
      `appended codex_app must include ${name}`,
    );
  }
});

test("merge preserves client-provided tool definitions", () => {
  const clientTools = clientRoutedTools();
  const clientDefinition = clientTools
    .find((tool) => tool?.type === "namespace" && tool.name === "codex_app")
    .tools.find((tool) => tool.name === "load_workspace_dependencies");
  clientDefinition.description = "client-owned definition";
  clientDefinition.inputSchema = {
    type: "object",
    properties: { refresh: { type: "boolean" } },
    required: ["refresh"],
  };
  const { tools, merged } = mergeCodexAppTools(clientTools);
  assert.equal(merged, true);
  const codexApp = tools.find(
    (tool) => tool?.type === "namespace" && tool.name === "codex_app",
  );
  assert.strictEqual(
    codexApp.tools.find((tool) => tool.name === "load_workspace_dependencies"),
    clientDefinition,
  );
});

test("splitFlatCodexAppName parses flattened names only", () => {
  assert.deepEqual(splitFlatCodexAppName("codex_app__create_thread"), {
    namespace: "codex_app",
    name: "create_thread",
  });
  assert.equal(splitFlatCodexAppName("exec_command"), undefined);
  assert.equal(splitFlatCodexAppName("codex_app__"), undefined);
});
