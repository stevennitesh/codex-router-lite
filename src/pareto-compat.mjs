// This is the observed OpenRouter contract, not an inferred underlying family.
// Keep it separate from GLM repairs and OpenCode's unrelated Messages limits.
export function isParetoRoute(route) {
  return route?.slug === "openrouter/pareto" &&
    route.provider === "openrouter" && route.upstreamModel === "unbiased/pareto";
}

function prepareParetoText(text) {
  if (!text || typeof text !== "object" || Array.isArray(text)) return text;
  const next = { ...text };
  delete next.verbosity;
  if (next.format !== undefined) {
    const format = next.format;
    const plainText = format && typeof format === "object" && !Array.isArray(format) &&
      format.type === "text" && Object.keys(format).length === 1;
    if (!plainText) {
      const error = new Error("Pareto's exact Responses endpoint does not support the requested structured response format.");
      error.status = 400;
      error.code = "unsupported_response_format";
      throw error;
    }
    // An explicit plain-text format is semantically identical to the endpoint
    // default, while forwarding the redundant control fails endpoint routing.
    delete next.format;
  }
  return Object.keys(next).length ? next : undefined;
}

export function prepareParetoRequest(payload, route) {
  if (!isParetoRoute(route)) return payload;
  const choice = payload.tool_choice;
  if (choice !== undefined && !["auto", "none"].includes(choice)) {
    const error = new Error("Pareto supports automatic tool selection only; a forced tool call cannot be guaranteed.");
    error.status = 400;
    error.code = "unsupported_tool_choice";
    throw error;
  }
  const next = { ...payload };
  // These native controls cause OpenRouter's require_parameters filter to
  // reject the exact Unbiased endpoint. The catalog advertises only the
  // measured provider-controlled behavior.
  delete next.reasoning;
  delete next.reasoning_effort;
  next.text = prepareParetoText(next.text);
  if (next.text === undefined) delete next.text;
  // Removing available tools implements "none" without silently changing it
  // to "auto" (the endpoint rejects the literal none value).
  if (choice === "none") {
    delete next.tools;
    delete next.tool_choice;
  }
  return next;
}
