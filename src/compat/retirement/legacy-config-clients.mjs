// Temporary adapter for config-manager.mjs. Remove after issues #3 and #4
// retire legacy state and client refresh for the local caller capability.
export {
  refreshCodexCallerCapabilityContents,
  refreshCodexCallerCapabilityState,
} from "../../caller-key-client-refresh.mjs";
