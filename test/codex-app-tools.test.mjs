import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_APP_TOOL_SNAPSHOT,
  CODEX_APP_TOOL_NAMES,
  CODEX_APP_TOOLS,
  splitFlatCodexAppName,
} from "../src/codex-app-tools.mjs";

test("the app tool snapshot records its paired Windows and Codex builds", () => {
  assert.match(CODEX_APP_TOOL_SNAPSHOT.windowsAppVersion, /^\d+(?:\.\d+){3}$/u);
  assert.match(CODEX_APP_TOOL_SNAPSHOT.codexVersion, /^codex-cli \d+\.\d+\.\d+/u);
  assert.match(CODEX_APP_TOOL_SNAPSHOT.capturedAt, /^\d{4}-\d{2}-\d{2}$/u);
});

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
    .find((entry) => entry.name === "mcp__codex_app")
    ?.tools.find((tool) => tool.name === name);
}

const CURRENT_CODEX_APP_TOOLS = [
  "automation_update",
  "capture_screen_context",
  "complete_conversational_onboarding_task",
  "complete_sidebar_onboarding_checklist_task",
  "consume_usage_reset",
  "create_sidebar_section",
  "create_thread",
  "delete_sidebar_section",
  "end_realtime_voice_call",
  "fire_confetti",
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
  "request_onboarding_input",
  "request_option_picker",
  "rename_sidebar_section",
  "reorder_section",
  "reorder_sidebar_projects",
  "reorder_sidebar_sections",
  "send_message_to_thread",
  "setup_codex_step",
  "set_thread_archived",
  "set_thread_title",
  "share_thread",
  "transfer_voice_call",
  "wait_threads",
].sort();

test("snapshot exactly matches the current native codex_app tool inventory", () => {
  assert.deepEqual(fullAppToolNames("mcp__codex_app").sort(), CURRENT_CODEX_APP_TOOLS);
  for (const name of CURRENT_CODEX_APP_TOOLS) {
    assert.ok(CODEX_APP_TOOL_NAMES.has(name), `snapshot must carry ${name}`);
  }
  assert.equal(CODEX_APP_TOOL_NAMES.size, CURRENT_CODEX_APP_TOOLS.length);
});

test("snapshot carries current task, sidebar, and routed-model contracts", () => {
  const reset = appTool("consume_usage_reset");
  assert.match(reset.description, /explicit user confirmation for each credit/);
  assert.match(reset.description, /10% or less remaining/);
  assert.deepEqual(reset.inputSchema.required, ["idempotencyKey"]);
  const browser = appTool("open_in_codex").inputSchema.properties.target.anyOf.find(
    (target) => target.properties.type.const === "browser",
  );
  assert.match(browser.properties.url.description, /codex:\/\/review/);
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
  assert.match(worktree.properties.startingState.description, /To create a user-requested branch/);
  assert.doesNotMatch(worktree.properties.startingState.description, /Do not use this to name a new branch/);
  assert.match(branch.properties.branchName.description, /user requested that exact name/);
  assert.match(branch.properties.onMissing.description, /Omission is equivalent to "error"/);
  assert.match(branch.properties.onMissing.description, /created from the project default branch/);

  const modelDescription = createThread.inputSchema.properties.model.description;
  assert.match(modelDescription, /uses the user's configured default model/);
  assert.doesNotMatch(modelDescription, /gpt-5|switchyard|openrouter/);
  assert.doesNotMatch(modelDescription, /validated on the destination host/);

  const moveThread = appTool("move_thread_to_sidebar_section");
  assert.ok(moveThread.inputSchema.required.includes("sectionId"));
  assert.deepEqual(
    moveThread.inputSchema.properties.sectionId.anyOf.map((schema) => schema.type),
    ["string", "null"],
  );

  const sendMessage = appTool("send_message_to_thread");
  assert.match(sendMessage.description, /user-visible message/);
  assert.equal(sendMessage.inputSchema.properties.model.description, "Optional model override.");

  assert.deepEqual(
    appTool("setup_codex_step").inputSchema.properties.step.enum,
    ["role", "task", "complete"],
  );
  assert.equal(
    appTool("transfer_voice_call").inputSchema.oneOf[1].properties.return.const,
    true,
  );
  assert.equal(
    appTool("complete_conversational_onboarding_task").inputSchema.oneOf[0]
      .properties.outcome.const,
    "completed",
  );

  const reorderSections = appTool("reorder_sidebar_sections");
  assert.match(reorderSections.description, /built-in sections/);
  assert.match(
    reorderSections.inputSchema.properties.sectionIds.description,
    /"pinned".*"agents".*"chats".*"projects"/,
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
