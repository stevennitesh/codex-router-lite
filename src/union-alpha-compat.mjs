// This is the observed OpenRouter contract, not an inferred underlying family.
// Keep it separate from GLM repairs and OpenCode's unrelated Messages limits.
export function isUnionAlphaRoute(route) {
  return route?.slug === "openrouter/union-alpha" &&
    route.provider === "openrouter" && route.upstreamModel === "stealth/union-alpha";
}

export function prepareUnionAlphaRequest(payload, route) {
  if (!isUnionAlphaRoute(route)) return payload;
  const choice = payload.tool_choice;
  if (choice !== undefined && !["auto", "none"].includes(choice)) {
    const error = new Error("Union Alpha supports automatic tool selection only; a forced tool call cannot be guaranteed.");
    error.status = 400;
    error.code = "unsupported_tool_choice";
    throw error;
  }
  const next = { ...payload };
  // Native settings cause OpenRouter's require_parameters filter to reject
  // this endpoint. The catalog advertises provider-controlled reasoning.
  delete next.reasoning;
  delete next.reasoning_effort;
  if (next.text && typeof next.text === "object") {
    next.text = { ...next.text };
    delete next.text.verbosity;
    if (!Object.keys(next.text).length) delete next.text;
  }
  // Removing available tools implements "none" without silently changing it
  // to "auto" (the endpoint rejects the literal none value).
  if (choice === "none") {
    delete next.tools;
    delete next.tool_choice;
  }
  return next;
}
