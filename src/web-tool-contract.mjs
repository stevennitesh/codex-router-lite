// Native Responses vocabulary shared by the Web broker, runtime and framing.
export const webToolKinds = Object.freeze({
  function: Object.freeze({ callType: "function_call", outputType: "function_call_output", idPrefix: "fc" }),
  custom: Object.freeze({ callType: "custom_tool_call", outputType: "custom_tool_call_output", idPrefix: "ctc" }),
  tool_search: Object.freeze({ callType: "tool_search_call", outputType: "tool_search_output", idPrefix: "tsc" }),
});

// Namespace, name and kind together identify a declaration; wire names do not.
export const webToolIdentity = tool => JSON.stringify([tool.namespace ?? null, tool.name, tool.kind ?? tool.type]);
