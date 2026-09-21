// Final external-send policy. This module has no listener, credentials or network effects.
// Internal gateway callers must pass the same validation as front-Router callers.
import { OPENROUTER_MODELS as routes, CANONICAL_OPENROUTER_ROUTE as defaultRoute, MODEL_BY_GATEWAY_ID, MODEL_BY_SLUG } from "./routed-models.mjs";
import { prepareParetoRequest } from "./pareto-compat.mjs";
import { safeLocalHttpError } from "./http-utils.mjs";

function hasNativeSearch(payload) {
  return payload?.web_search_options !== undefined ||
    (Array.isArray(payload?.tools) && payload.tools.some((tool) =>
      ["web_search", "web_search_preview"].includes(tool?.type))) ||
    ["web_search", "web_search_preview"].includes(payload?.tool_choice?.type);
}

function validHostedSearchTool(tool, route) {
  if (route.searchTool?.mode !== "hosted") return false;
  const parameters = tool?.parameters;
  const limits = route.searchTool.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return false;
  if (parameters.engine !== limits.engine || parameters.mode !== limits.mode) return false;
  if (!Number.isInteger(parameters.max_results) || parameters.max_results < 1 || parameters.max_results > limits.max_results) return false;
  if (
    !Number.isInteger(parameters.max_total_results) ||
    parameters.max_total_results < parameters.max_results ||
    parameters.max_total_results > limits.max_total_results
  ) return false;
  if (!Number.isInteger(parameters.max_uses) || parameters.max_uses < 1 || parameters.max_uses > limits.max_uses) return false;
  if (
    parameters.search_context_size !== undefined &&
    !["low", "medium", "high"].includes(parameters.search_context_size)
  ) return false;
  if (
    parameters.user_location !== undefined &&
    (!parameters.user_location ||
      typeof parameters.user_location !== "object" ||
      Array.isArray(parameters.user_location))
  ) return false;
  return Object.keys(parameters).every((key) => [
    "engine",
    "mode",
    "max_results",
    "max_total_results",
    "max_uses",
    "search_context_size",
    "user_location",
  ].includes(key));
}

export function prepareOpenRouterRequest(payload) {
  const selected = MODEL_BY_GATEWAY_ID.get(payload?.model) ||
    MODEL_BY_SLUG.get(payload?.model) ||
    (payload?.model === defaultRoute.upstreamModel ? defaultRoute : undefined);
  if (!routes.includes(selected)) {
    throw new Error(`Only ${routes.map((route) => route.slug).join(" and ")} are supported.`);
  }
  payload = prepareParetoRequest(payload, selected);
  if (hasNativeSearch(payload)) {
    throw safeLocalHttpError(
      "Codex hosted-search fields must be translated before the OpenRouter hop.",
      { status: 400, code: "model_search_not_supported" },
    );
  }
  const serverSearchTools = Array.isArray(payload?.tools)
    ? payload.tools.filter((tool) => tool?.type === "openrouter:web_search")
    : [];
  if (
    serverSearchTools.length > 1 ||
    serverSearchTools.some((tool) => !validHostedSearchTool(tool, selected)) ||
    (serverSearchTools.length > 0 &&
      (!Number.isInteger(payload.max_tool_calls) ||
        payload.max_tool_calls < 0 ||
        payload.max_tool_calls > selected.searchTool.maxToolCalls)) ||
    (Array.isArray(payload?.tools) && payload.tools.some((tool) =>
      typeof tool?.type === "string" &&
      tool.type.startsWith("openrouter:") &&
      tool.type !== "openrouter:web_search"))
  ) {
    throw safeLocalHttpError(
      "OpenRouter hosted search must use the checked-in bounded route contract.",
      { status: 400, code: "model_search_not_supported" },
    );
  }
  const {
    client_metadata: _clientMetadata,
    prompt_cache_retention: _promptCacheRetention,
    ...clean
  } = payload;
  // Endpoint quirks belong to the selected and certified endpoint record. A
  // provider change must update this flag and refresh exact-route proof rather
  // than inheriting Novita's measured behavior by accident.
  if (selected.openRouterEndpointCompatibility.dropParallelToolCalls) {
    delete clean.parallel_tool_calls;
  }
  // Codex sends an empty tool list on compaction and plain turns. Omitting it
  // has the same meaning and avoids strict OpenAI-compatible validators that
  // reject `tools: []`. Only non-forcing choices are redundant with that list;
  // a request that never sent tools keeps its original choice contract.
  if (Array.isArray(clean.tools) && clean.tools.length === 0) {
    if (clean.tool_choice !== undefined && !["auto", "none"].includes(clean.tool_choice)) {
      throw safeLocalHttpError("A forced tool choice requires a non-empty tool list.", {
        status: 400,
        code: "unsupported_tool_choice",
      });
    }
    delete clean.tools;
    delete clean.tool_choice;
  }
  return {
    ...clean,
    model: selected.upstreamModel,
    provider: selected.openRouterProviderPolicy,
  };
}
