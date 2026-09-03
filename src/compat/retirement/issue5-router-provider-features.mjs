// Temporary provider boundary for router.mjs. Issue #5 narrows routing to GLM
// and Switchyard and removes this aggregate export.
export { MODEL_BY_SLUG, RUNTIME_PROVIDERS, providerForModel, resolveProviderBaseUrl } from "../../model-registry.mjs";
export { discoveryDisabled } from "../../discovery-mode.mjs";
export { executeSearchSidecar, SearchSidecarError } from "../../search-sidecar.mjs";
export { searchSidecarBindingForModel } from "../../search-sidecar-state.mjs";
export { routedModelPreservesSearchContract, routedModelSearchMode, searchModePreservesSearchContract, stripUnsupportedHostedSearch, unsupportedSearchContractError } from "../../search-capability.mjs";
export { canonicalProviderId, providerRuntimeAvailable, readProviderSelection, selectedConfiguredListedModels } from "../../provider-selection.mjs";
export { FAILOVER_BUDGET_MS, MAX_FAILOVER_HOPS, classifyRoutedFailure, clearProviderCooldown, providerCooldown, rankFailoverCandidates, readFailoverSettings, recordProviderCooldown } from "../../model-failover.mjs";
export { cooldownScope } from "../../provider-cooldown.mjs";
export { describeImage, evidenceCache, hasNativeSession, inputHasImage, nativeAccountKey, resolveVisionEngines, stripImages, substituteImages, supportsImageInput } from "../../vision-bridge.mjs";
export { readVisionBridgeSettings } from "../../vision-bridge-state.mjs";
export { installedNativeVisionEngines } from "../../vision-engines.mjs";
