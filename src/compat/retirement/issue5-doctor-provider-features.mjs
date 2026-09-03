// Temporary provider boundary for doctor.mjs. Issue #5 replaces this broad
// provider inventory with the retained GLM and Switchyard implementation.
export { grokCliPreflight } from "../../grok-cli.mjs";
export { MODEL_BY_SLUG, MODELS, PROVIDERS, providerNeedsNoKey, RUNTIME_PROVIDERS, RUNTIME_PROVIDER_WARNINGS } from "../../model-registry.mjs";
export { grokOAuthStatus } from "../../grok-oauth-status.mjs";
export { antigravityOAuthHealth, repairAntigravityOAuthPermissions } from "../../antigravity-oauth-status.mjs";
export { kimiOAuthHealth } from "../../oauth-status.mjs";
export { discoveryDisabled } from "../../discovery-mode.mjs";
export { credentialLabel } from "../../provider-credentials.mjs";
export { providerApiKeyPoolsSnapshot } from "../../provider-api-key-pool.mjs";
export { effectiveProviderCredentialStatus, resolveStoredCredential } from "../../provider-api-key-routing.mjs";
export { genericProviderConfigured } from "../../generic-provider-readiness.mjs";
export { trustedSearchProviderDescriptor } from "../../search-sidecar-policy.mjs";
export { readSearchSidecarState } from "../../search-sidecar-state.mjs";
export { providerNeedsCuration } from "../../provider-onboarding.mjs";
export { canonicalProviderId, providerSelectionStatus, selectedConfiguredListedModels } from "../../provider-selection.mjs";
export { resolveVisionEngine } from "../../vision-bridge.mjs";
export { installedNativeVisionEngines } from "../../vision-engines.mjs";
export { readVisionBridgeSettings, visionBridgeConfigured } from "../../vision-bridge-state.mjs";
export { failoverTierCounts, readFailoverSettings, readProviderCooldowns } from "../../model-failover.mjs";
