import {
  aliasHistoricalFunctionNames, bridgeCustomTools, flattenNamespaceTools,
  flattenNamespacedHistory, flattenNamespacedToolChoice, flattenToolSearchHistory,
  restorePreflattenedToolNamespaces,
} from "./namespace-relay.mjs";
import { isUnionAlphaRoute, prepareUnionAlphaRequest } from "./union-alpha-compat.mjs";
import { routedModelSearchMode, stripUnsupportedHostedSearch } from "./search-capability.mjs";
import { prepareOpenRouterHostedSearchRequest } from "./openrouter-hosted-search.mjs";
import { routedTransport } from "./routed-models.mjs";

export function routedSearchCompatibility(payload, route) {
  const searchMode = routedModelSearchMode(route);
  const stripsUnsupportedSearch = route.requestProfile === "glm-5.3-flash" || isUnionAlphaRoute(route);
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

// Request-local preparation has no network, credentials, or persistent state.
// Its namespace context must accompany the payload into response restoration.
// Compaction reuses history conversion but never enables discovered tools or
// carries GLM thinking into assistant messages; those are turn-only behaviors.
export function prepareRoutedRequest(payload, route, {
  input = payload.input, compaction = false, compactionMessages = [], childEffort,
} = {}) {
  const transport = routedTransport(route);
  if (transport === "native") throw new Error("Native requests do not use external request preparation.");
  const search = routedSearchCompatibility(payload, route);
  payload = search.payload;
  const hostedSearch = !compaction && search.searchMode === "hosted" && payloadHasHostedSearchIntent(payload);
  input = normalizeProviderAppToolOutputs(input);
  if (!compaction && !hostedSearch && transport === "chat") carryReasoningThroughInput(input);
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
  if (isUnionAlphaRoute(route)) {
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
  prepared = prepareUnionAlphaRequest(prepared, route);
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

// LiteLLM's Responses-to-chat translation drops `reasoning`
// input items entirely (`_transform_responses_api_input_item_to_chat_completion_message`
// returns nothing for an item whose `content` is null, which is the shape
// Codex stores), so the reasoning text never reaches the provider at all.
// Carry each run of reasoning items onto the assistant turn it belongs to, and
// the translation keeps it as that message's content. In-place, no-op when
// there is nothing to carry.
//
// Every assistant turn needs covering, not only the ones that call a tool.
// This used to carry the reasoning solely into a following `function_call` or
// an empty assistant filler, which is the shape of a tool loop -- so a turn
// that answers in prose lost its reasoning, and the provider refused the
// next request because its reasoning history is missing.
function carryReasoningThroughInput(input) {
  if (!Array.isArray(input) || input.length < 2) return;
  for (let index = 0; index < input.length - 1; index += 1) {
    if (input[index]?.type !== "reasoning") continue;
    // One assistant turn can emit several reasoning items in a row, and they
    // all belong to the turn that follows. Carrying only the item nearest the
    // turn dropped everything the model thought before it.
    let end = index;
    const texts = [];
    while (end < input.length && input[end]?.type === "reasoning") {
      const text = reasoningItemText(input[end]);
      if (text) texts.push(text);
      end += 1;
    }
    const text = texts.join("\n");
    const next = input[end];
    // Only the last item of the run is rewritten. The earlier ones stay
    // `reasoning` items, which the translation drops -- their text is already
    // in the joined value, and leaving them in place keeps the array the same
    // length for every other pass over it.
    if (text && next) {
      if (next.type === "function_call" || next.type === "custom_tool_call") {
        input[end - 1] = assistantTextItem(text);
      } else if (next.type === "message" && next.role === "assistant") {
        // Merged into the assistant message rather than inserted in front of
        // it. A separate message would put two assistant turns back to back,
        // which the same strict chat-completions providers reject outright --
        // and the tool-call branch above ends up merged anyway, because
        // LiteLLM folds a following function_call into the assistant message
        // it already emitted.
        input[end] = mergeAssistantText(next, text);
      }
    }
    index = end - 1;
  }
}

function assistantTextItem(text) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "thinking", text }],
  };
}

// The reasoning goes in front of the answer it produced. `content` is an array
// of parts on everything Codex stores, but a bare string is equally legal on
// the Responses API, so both shapes are handled rather than assumed away.
function mergeAssistantText(item, text) {
  const part = { type: "thinking", text };
  if (typeof item.content === "string") {
    return {
      ...item,
      content: item.content
        ? [part, { type: "output_text", text: item.content }]
        : [part],
    };
  }
  return {
    ...item,
    content: [part, ...(Array.isArray(item.content) ? item.content : [])],
  };
}

function reasoningItemText(item) {
  const summary = item.summary;
  if (typeof summary === "string" && summary) return summary;
  if (Array.isArray(summary)) {
    const text = summary
      .map((part) => (part && typeof part.text === "string" ? part.text : undefined))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  const content = item.content;
  if (typeof content === "string" && content) return content;
  // Reasoning may use an array of output_text parts rather than a summary string.
  // Without this, the reasoning never reaches the chat history and the
  // following tool-call turn 400s for missing `reasoning_content`.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part.text === "string" ? part.text : undefined))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return undefined;
}
