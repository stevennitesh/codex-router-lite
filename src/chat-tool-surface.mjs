import { flattenNamespaceTools } from "./namespace-relay.mjs";

// Codex owns tool availability, discovery, and native execution. Translate only
// the current request; a reference snapshot cannot grant callable capabilities.
export function chatProviderToolSurface(tools) {
  return flattenNamespaceTools(tools);
}
