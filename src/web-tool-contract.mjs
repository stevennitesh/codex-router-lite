// Native Responses vocabulary shared by the Web broker, runtime and framing.
export const webToolKinds = Object.freeze({
  function: Object.freeze({ callType: "function_call", outputType: "function_call_output", idPrefix: "fc" }),
  custom: Object.freeze({ callType: "custom_tool_call", outputType: "custom_tool_call_output", idPrefix: "ctc" }),
  tool_search: Object.freeze({ callType: "tool_search_call", outputType: "tool_search_output", idPrefix: "tsc" }),
});

// Namespace, name and kind together identify a declaration; wire names do not.
export const webToolIdentity = tool => JSON.stringify([tool.namespace ?? null, tool.name, tool.kind ?? tool.type]);

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && Boolean(value.trim());

// Codex's client search accepts a nonempty query and an optional positive usize
// limit. The Web broker carries JSON numbers, so admit only exact safe integers.
// This native search limit is independent of the connector's discovery paging.
export const webToolSearchParameters = Object.freeze({
  type: "object",
  properties: Object.freeze({
    query: Object.freeze({ type: "string", minLength: 1, pattern: "\\S" }),
    limit: Object.freeze({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }),
  required: Object.freeze(["query"]),
  additionalProperties: false,
});

export function validWebToolSearchArguments(value) {
  return record(value) && nonempty(value.query)
    && Object.keys(value).every(key => key === "query" || key === "limit")
    && (value.limit === undefined || Number.isSafeInteger(value.limit) && value.limit > 0);
}

export function validWebToolSearchCall(item) {
  return record(item) && item.type === webToolKinds.tool_search.callType
    && item.execution === "client" && nonempty(item.call_id) && validWebToolSearchArguments(item.arguments);
}

// Search can load only native function/custom declarations or one namespace of
// those declarations. Validate the complete array before granting any entry.
export function validWebToolSearchTools(tools) {
  const identities = new Set();
  const valid = (tool, namespace) => {
    if (!record(tool) || !nonempty(tool.name)
      || tool.description !== undefined && typeof tool.description !== "string") return false;
    if (tool.type === "namespace") return namespace === undefined && Array.isArray(tool.tools)
      && tool.tools.every(child => valid(child, tool.name));
    const ownNamespace = tool.namespace ?? namespace;
    if (ownNamespace !== undefined && !nonempty(ownNamespace)) return false;
    const identity = webToolIdentity({ namespace: ownNamespace, name: tool.name, kind: tool.type });
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (tool.type === "function") return (tool.parameters === undefined || record(tool.parameters))
      && (tool.inputSchema === undefined || record(tool.inputSchema));
    return tool.type === "custom" && (tool.format === undefined || record(tool.format));
  };
  return Array.isArray(tools) && tools.every(tool => valid(tool));
}

function pairedWebToolSearchOutput(item, callId) {
  return record(item) && item.type === webToolKinds.tool_search.outputType
    && item.execution === "client" && nonempty(item.call_id)
    && (callId === undefined || nonempty(callId) && item.call_id === callId);
}

export function completedWebToolSearchOutput(item, callId) {
  return pairedWebToolSearchOutput(item, callId) && item.status === "completed"
    && item.isError !== true && validWebToolSearchTools(item.tools);
}

// A failed execution resolves its exact action but never grants declarations.
// Missing/incomplete statuses and malformed tool arrays remain unresolved.
export function terminalWebToolSearchOutput(item, callId) {
  return pairedWebToolSearchOutput(item, callId)
    && (item.status === "completed" && validWebToolSearchTools(item.tools)
      || item.status === "failed" && (item.tools === undefined || validWebToolSearchTools(item.tools)));
}
