// Temporary adapter for catalog.mjs. Remove after issue #5 retires the excluded
// catalog features and replaces broad registry access with the exact retained
// GLM and Switchyard registry.
export { readUserModels } from "../../user-models.mjs";
export { MODEL_BY_SLUG, MODEL_SLUG_ALIASES } from "../../model-registry.mjs";
export {
  configuredProviderIds,
  selectedConfiguredListedModels,
} from "../../provider-selection.mjs";
export { applyVisionBridge, resolveVisionEngine } from "../../vision-bridge.mjs";
export { readVisionBridgeSettings } from "../../vision-bridge-state.mjs";
export { nativeVisionEngines } from "../../vision-engines.mjs";
export { discoveryDisabled } from "../../discovery-mode.mjs";
export { routedModelSearchAvailable } from "../../search-capability.mjs";
