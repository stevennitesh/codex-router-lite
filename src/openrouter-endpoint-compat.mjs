import { safeLocalHttpError } from "./http-utils.mjs";
import { supportedRoutedEfforts } from "./routed-models.mjs";

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
  // The primary object wins even when it intentionally omits an effort.
  // Remove its alias before translation or final send: OpenRouter forbids
  // simultaneous reasoning.effort and reasoning_effort values that differ.
  if (next.reasoning !== undefined) delete next.reasoning_effort;
  const effort = next.reasoning !== undefined
    ? next.reasoning?.effort
    : next.reasoning_effort && typeof next.reasoning_effort === "object"
      ? next.reasoning_effort.effort
      : next.reasoning_effort;
  const levels = supportedRoutedEfforts(route);
  if (effort !== undefined && !levels.includes(effort)) {
    throw safeLocalHttpError(`${route.displayName} supports reasoning efforts: ${levels.join(", ")}.`, {
      status: 400, code: "unsupported_reasoning_effort",
    });
  }
  for (const [key, value] of Object.entries(route.defaultSampling || {})) {
    if (next[key] === undefined) next[key] = value;
  }
  if (route.defaultSampling && next.reasoning === undefined && next.reasoning_effort === undefined) {
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
  if (!present.length && route.defaultMaxOutputTokens !== undefined) {
    // The final payload shape distinguishes translated Chat from direct Responses,
    // including GLM's hosted-search path, which also uses Responses.
    next[Array.isArray(next.messages) ? "max_tokens" : "max_output_tokens"] = route.defaultMaxOutputTokens;
  }
  return next;
}
