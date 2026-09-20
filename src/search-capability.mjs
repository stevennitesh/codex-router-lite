import { safeLocalHttpError } from "./http-utils.mjs";

// Search is available only when the checked-in route declares how it runs.
export function routedModelSearchMode(model) {
  if (["hosted", "standalone"].includes(model?.searchTool?.mode)) {
    return model.searchTool.mode;
  }
  return undefined;
}

export function routedModelPreservesSearchContract(
  model,
  { requiredMode, hasSearchHistory = false } = {},
) {
  if (hasSearchHistory && !requiredMode) {
    return model?.supportsSearchHistory === true;
  }
  return searchModePreservesSearchContract(
    routedModelSearchMode(model),
    { requiredMode },
  );
}

export function searchModePreservesSearchContract(
  searchMode,
  { requiredMode } = {},
) {
  return !requiredMode || searchMode === requiredMode;
}

const HOSTED_SEARCH_TOOL_TYPES = new Set(["web_search", "web_search_preview"]);

function hostedSearchTool(tool) {
  return HOSTED_SEARCH_TOOL_TYPES.has(tool?.type);
}

function unsupportedSearchError(message) {
  return safeLocalHttpError(message, {
    status: 400,
    code: "model_search_not_supported",
  });
}

export function unsupportedSearchContractError(model) {
  const label = model ? `Model ${model}` : "The selected model";
  return unsupportedSearchError(
    `${label} can no longer preserve this turn's web-search execution contract.`,
  );
}

// Codex can attach provider-hosted search fields to a routed turn even when
// the selected catalog entry advertises supports_search_tool=false. Remove
// only those ambient hosted-search extensions. Function tools -- including a
// function literally named web_search -- are ordinary caller-owned tools and
// remain byte-for-byte intact.
export function stripUnsupportedHostedSearch(payload, { model } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
  const strippedTools = tools?.filter((tool) => !hostedSearchTool(tool));
  const removedTools = Boolean(tools && strippedTools.length !== tools.length);
  const include = Array.isArray(payload.include) ? payload.include : undefined;
  const strippedInclude = include?.filter(
    (entry) => typeof entry !== "string" || !entry.startsWith("web_search_call."),
  );
  const removedInclude = Boolean(include && strippedInclude.length !== include.length);
  const removedOptions = payload.web_search_options !== undefined;
  const explicitHostedChoice = hostedSearchTool(payload.tool_choice);
  if (!removedTools && !removedInclude && !removedOptions && !explicitHostedChoice) return payload;

  const label = model ? `Model ${model}` : "The selected model";
  if (explicitHostedChoice) {
    throw unsupportedSearchError(
      `${label} does not advertise web search, but tool_choice explicitly selects it.`,
    );
  }
  if (removedTools && payload.tool_choice === "required" && strippedTools.length === 0) {
    throw unsupportedSearchError(
      `${label} does not advertise web search, and no supported tool remains for tool_choice required.`,
    );
  }

  const next = { ...payload };
  delete next.web_search_options;
  if (removedTools) {
    if (strippedTools.length) next.tools = strippedTools;
    else delete next.tools;
  }
  if (removedInclude) {
    if (strippedInclude.length) next.include = strippedInclude;
    else delete next.include;
  }
  if (
    removedTools &&
    strippedTools.length === 0 &&
    ["auto", "none"].includes(next.tool_choice)
  ) {
    delete next.tool_choice;
  }
  return next;
}
