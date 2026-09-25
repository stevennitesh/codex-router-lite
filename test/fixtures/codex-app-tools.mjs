// Synthetic Codex app namespace used only to exercise Router's generic
// namespace/schema relay. It is deliberately not a snapshot of any Desktop
// build; runtime always uses the caller's request-local tool definitions.
export const CODEX_APP_TOOL_FIXTURE = Object.freeze([
  {
    type: "namespace",
    name: "mcp__codex_app",
    description: "Synthetic Codex app tools for relay tests.",
    tools: [
      {
        type: "function",
        name: "create_worktree",
        description: "Fixture managed-worktree tool.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            ref: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "attach_artifact",
        description: "Fixture artifact attachment tool.",
        inputSchema: {
          type: "object",
          properties: {
            artifact_type: { type: "string" },
            url: { type: "string" },
          },
          required: ["artifact_type", "url"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "list_artifacts",
        description: "Fixture artifact listing tool.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "remove_artifact",
        description: "Fixture artifact removal tool.",
        inputSchema: {
          type: "object",
          properties: {
            artifact_type: { type: "string" },
            url: { type: "string" },
          },
          required: ["artifact_type", "url"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "create_thread",
        description: "Fixture create-thread tool.",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "list_threads",
        description: "Fixture list-threads tool.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "automation_update",
        description: "Fixture union-root app tool.",
        inputSchema: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { type: "string", const: "create" },
                name: { type: "string" },
              },
              required: ["mode", "name"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                mode: { type: "string", const: "delete" },
                id: { type: "string" },
              },
              required: ["mode", "id"],
              additionalProperties: false,
            },
          ],
        },
      },
      {
        type: "function",
        name: "read_thread",
        description: "Fixture read-thread tool.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
          },
          required: ["threadId"],
          additionalProperties: false,
        },
      },
    ],
  },
]);
