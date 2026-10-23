export const webMcpNames = Object.freeze({ list: "codex_tools_list", call: "codex_tool_call" });
export const webMcpQueryLimit = 1024;
export const webMcpDiscoveryGuidance = `Discover needed current tool definitions with ${webMcpNames.list} using a focused query, then request them with ${webMcpNames.call} using the returned complete parameters or raw custom-tool format and exact wireName. Omit query when the full catalog is needed. Native Codex performs tool execution and approvals.`;
