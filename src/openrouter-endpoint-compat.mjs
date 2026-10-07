import { safeLocalHttpError } from "./http-utils.mjs";

// Measured endpoint differences apply both before translation and at final send.
export function prepareOpenRouterEndpointRequest(payload, route) {
  if (route?.provider !== "openrouter") return payload;
  const next = { ...payload };
  if (route.openRouterEndpointCompatibility?.autoToolChoiceOnly) {
    const choice = next.tool_choice;
    if (choice !== undefined && !["auto", "none"].includes(choice)) {
      throw safeLocalHttpError(`${route.displayName} supports automatic tool selection only.`, {
        status: 400, code: "unsupported_tool_choice",
      });
    }
    // Omitting all available tools implements none, including on history replay.
    if (choice === "none") {
      delete next.tools;
      delete next.tool_choice;
    }
  }
  if (!route.defaultSampling) return next;
  for (const [key, value] of Object.entries(route.defaultSampling)) {
    if (next[key] === undefined) next[key] = value;
  }
  if (next.reasoning === undefined && next.reasoning_effort === undefined) {
    next.reasoning = { effort: route.defaultEffort };
  }
  const outputFields = ["max_output_tokens", "max_tokens", "max_completion_tokens"];
  const present = outputFields.filter(key => next[key] !== undefined);
  for (const key of present) {
    if (!Number.isInteger(next[key]) || next[key] <= 0 || next[key] > route.maxOutputTokens) {
      throw safeLocalHttpError(`${key} must be between 1 and ${route.maxOutputTokens} for ${route.displayName}.`, {
        status: 400, code: "unsupported_output_limit",
      });
    }
  }
  if (!present.length) {
    // The final payload shape distinguishes translated Chat from direct Responses,
    // including GLM's hosted-search path, which also uses Responses.
    next[Array.isArray(next.messages) ? "max_tokens" : "max_output_tokens"] = route.defaultMaxOutputTokens;
  }
  return next;
}
