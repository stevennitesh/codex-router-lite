import { flattenNamespaceTools } from "./namespace-relay.mjs";

// Codex owns tool availability, discovery, and native execution. Translate only
// the current request; a reference snapshot cannot grant callable capabilities.
export function chatProviderToolSurface(tools) {
  // A literal plain name can equal a namespace's flattened spelling. Keep
  // those native identities distinct through declaration, response, and replay.
  return flattenNamespaceTools(tools, { aliasCollisions: true });
}
