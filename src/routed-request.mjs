import {
  aliasHistoricalFunctionNames, bridgeCustomTools, flattenNamespaceTools,
  flattenNamespacedHistory, flattenNamespacedToolChoice, flattenToolSearchHistory,
  restorePreflattenedToolNamespaces,
} from "./namespace-relay.mjs";
import { isParetoRoute, prepareParetoRequest } from "./pareto-compat.mjs";
import { routedModelSearchMode, stripUnsupportedHostedSearch } from "./search-capability.mjs";
import { prepareOpenRouterHostedSearchRequest } from "./openrouter-hosted-search.mjs";
import { routedTransport } from "./routed-models.mjs";

export function routedSearchCompatibility(payload, route) {
  const searchMode = routedModelSearchMode(route);
  const stripsUnsupportedSearch = route.requestProfile === "glm-5.3-flash" || isParetoRoute(route);
  return {
    payload: stripsUnsupportedSearch && searchMode === undefined
      ? stripUnsupportedHostedSearch(payload, { model: route.slug }) : payload,
    searchMode,
  };
}

export function payloadHasHostedSearchIntent(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const include = Array.isArray(payload?.include) ? payload.include : [];
  return Boolean(
    payload?.web_search_options !== undefined ||
    tools.some((tool) => ["web_search", "web_search_preview"].includes(tool?.type)) ||
    ["web_search", "web_search_preview"].includes(payload?.tool_choice?.type) ||
    include.some(
      (entry) => typeof entry === "string" && entry.startsWith("web_search_call."),
    )
  );
}

/**
 * Builds one request-local provider bundle. The returned namespace context must
 * accompany the payload into response restoration; it cannot be reconstructed
 * safely from a later request. This function has no network or persistent state.
 */
export function prepareRoutedRequest(payload, route, {
  input = payload.input, compaction = false, compactionMessages = [], childEffort,
} = {}) {
  const transport = routedTransport(route);
  if (transport === "native") throw new Error("Native requests do not use external request preparation.");
  const search = routedSearchCompatibility(payload, route);
  payload = search.payload;
  const hostedSearch = !compaction && search.searchMode === "hosted" && payloadHasHostedSearchIntent(payload);
  input = normalizeProviderAppToolOutputs(input);
  const clientTools = compaction ? [] : restorePreflattenedToolNamespaces(payload.tools, payload.client_metadata);
  const flat = compaction
    ? { tools: [], namespaces: new Map(), flattened: false }
    : flattenNamespaceTools(clientTools, { aliasCollisions: true });
  const history = flattenToolSearchHistory(input, flat.tools, flat.namespaces, {
    recoverWithoutRelay: compaction, toolChoice: compaction ? undefined : payload.tool_choice,
  });
  input = compaction || flat.flattened || history.flattened
    ? flattenNamespacedHistory(history.input, flat.namespaces) : history.input;
  let tools = history.tools;
  let toolChoice = compaction ? undefined : flattenNamespacedToolChoice(payload.tool_choice, flat.namespaces);
  if (isParetoRoute(route)) {
    const bridged = bridgeCustomTools(tools, input, flat.namespaces, toolChoice, [], { bridgeAll: true });
    tools = bridged.tools;
    input = aliasHistoricalFunctionNames(bridged.input, flat.namespaces);
    toolChoice = bridged.toolChoice;
  }
  let prepared = { ...payload, model: route.gatewayModel, tools, input, tool_choice: toolChoice };
  delete prepared.client_metadata;
  if (compaction) {
    prepared = { ...prepared, stream: false, tools: [], input: [...input, ...compactionMessages] };
    delete prepared.tool_choice;
    delete prepared.previous_response_id;
  } else if (childEffort) {
    prepared.reasoning_effort = childEffort;
    prepared.reasoning = { ...(prepared.reasoning || {}), effort: childEffort };
  }
  prepared = prepareParetoRequest(prepared, route);
  if (hostedSearch) prepared = prepareOpenRouterHostedSearchRequest(prepared, route);
  return {
    payload: prepared, namespaces: flat.namespaces,
    transport: hostedSearch ? "responses" : transport,
    searchMode: search.searchMode, hostedSearch,
  };
}

function messageItem(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function normalizeOrphanAppToolOutput(item) {
  if (
    item?.type !== "function_call_output" ||
    !["codex_app", "mcp__codex_app"].includes(item.namespace) ||
    typeof item.name !== "string" ||
    !item.name ||
    (typeof item.call_id === "string" && item.call_id) ||
    item.output === undefined
  ) {
    return item;
  }
  // Codex app-server can persist a standalone app-tool result without the
  // originating call. A synthetic call_id would still have no matching call,
  // while strict Responses providers reject the original item outright.
  // Preserve the result as ordinary readable history instead. Scope the
  // recovery to named codex_app outputs so every other malformed tool item
  // continues to fail closed at the provider adapter.
  const output =
    typeof item.output === "string" ? item.output : JSON.stringify(item.output);
  return messageItem(`[Codex app tool result: ${item.namespace}.${item.name}]\n${output}`);
}

function normalizeProviderAppToolOutputs(input) {
  if (!Array.isArray(input)) return input;
  return input.map(normalizeOrphanAppToolOutput);
}
