// Temporary adapter for doctor.mjs. Remove after issues #3, #4, and #5 retire
// excluded providers, clients, search and vision bridges, and legacy packaging.
export { grokCliPreflight } from "../../grok-cli.mjs";
export { detectLegacyInstallations } from "../../legacy-migration.mjs";
export {
  MODEL_BY_SLUG,
  MODELS,
  PROVIDERS,
  providerNeedsNoKey,
  RUNTIME_PROVIDERS,
  RUNTIME_PROVIDER_WARNINGS,
} from "../../model-registry.mjs";
export { grokOAuthStatus } from "../../grok-oauth-status.mjs";
export {
  antigravityOAuthHealth,
  repairAntigravityOAuthPermissions,
} from "../../antigravity-oauth-status.mjs";
export { kimiOAuthHealth } from "../../oauth-status.mjs";
export { serviceFollowsHostApps } from "../../presence-state.mjs";
export {
  CLAUDE_CATALOG_PATH,
  CLAUDE_LAUNCHER_PATH,
  CURSOR_CATALOG_PATH,
  CURSOR_LAUNCHER_PATH,
  CURSOR_PUBLIC_SECRET_PATH,
  CURSOR_STATE_DB_PATH,
  DSH_CATALOG_PATH,
  DSH_SETTINGS_PATH,
  GEMINI_CATALOG_PATH,
  GEMINI_ENV_PATH,
  OPENCLAW_CATALOG_PATH,
  SEARCH_SIDECARS_PATH,
} from "../../paths.mjs";
export { discoveryDisabled } from "../../discovery-mode.mjs";
export { credentialLabel } from "../../provider-credentials.mjs";
export { providerApiKeyPoolsSnapshot } from "../../provider-api-key-pool.mjs";
export {
  effectiveProviderCredentialStatus,
  resolveStoredCredential,
} from "../../provider-api-key-routing.mjs";
export { genericProviderConfigured } from "../../generic-provider-readiness.mjs";
export { trustedSearchProviderDescriptor } from "../../search-sidecar-policy.mjs";
export { readSearchSidecarState } from "../../search-sidecar-state.mjs";
export { providerNeedsCuration } from "../../provider-onboarding.mjs";
export {
  canonicalProviderId,
  providerSelectionStatus,
  selectedConfiguredListedModels,
} from "../../provider-selection.mjs";
export { resolveVisionEngine } from "../../vision-bridge.mjs";
export { installedNativeVisionEngines } from "../../vision-engines.mjs";
export {
  readVisionBridgeSettings,
  visionBridgeConfigured,
} from "../../vision-bridge-state.mjs";
export {
  failoverTierCounts,
  readFailoverSettings,
  readProviderCooldowns,
} from "../../model-failover.mjs";
export { isHomebrewManaged } from "../../dependency-repair.mjs";
