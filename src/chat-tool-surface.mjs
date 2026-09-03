import { mergeCodexAppTools } from "./codex-app-tools.mjs";
import { flattenNamespaceTools } from "./namespace-relay.mjs";

// OpenRouter GLM receives the complete deferred Codex app surface as ordinary
// functions. The response relay restores each namespace before Codex sees it.
export function chatProviderToolSurface(tools) {
  return flattenNamespaceTools(mergeCodexAppTools(tools).tools);
}
