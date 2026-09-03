import path from "node:path";

// Temporary adapter for control.mjs. Remove after issues #3, #4, and #5 retire
// excluded providers, client integrations, and the legacy control UI.
export {
  CLAUDE_CATALOG_PATH,
  CURSOR_CATALOG_PATH,
  DSH_CATALOG_PATH,
  GEMINI_CATALOG_PATH,
  OPENCLAW_CATALOG_PATH,
} from "../../paths.mjs";
export { harnessSnapshotWithWeb } from "../../dsh-install.mjs";
export { USER_MODELS_PATH } from "../../user-models.mjs";
export { refreshTargetPickerIfInstalled } from "../../target-integration.mjs";
export { activateAntigravityProbe } from "../../antigravity-probe-activation.mjs";
export {
  chatGptSessionStatus,
  setChatGptSessionSharingFromControl,
} from "../../chatgpt-session-control.mjs";
export { discoveryDisabled } from "../../discovery-mode.mjs";
export { presenceSnapshot } from "../../presence-state.mjs";

// Keep every lazy legacy dependency literal and auditable. The caller cannot
// turn this into an arbitrary module loader.
export function importLegacyControlModule(specifier) {
  switch (specifier) {
    case "./agent-check.mjs": return import("../../agent-check.mjs");
    case "./antigravity-oauth-probe.mjs": return import("../../antigravity-oauth-probe.mjs");
    case "./chatgpt-account-pool.mjs": return import("../../chatgpt-account-pool.mjs");
    case "./chatgpt-profile-switch.mjs": return import("../../chatgpt-profile-switch.mjs");
    case "./client-exports.mjs": return import("../../client-exports.mjs");
    case "./codex-account-usage.mjs": return import("../../codex-account-usage.mjs");
    case "./cursor-config-manager.mjs": return import("../../cursor-config-manager.mjs");
    case "./dsh-install.mjs": return import("../../dsh-install.mjs");
    case "./dsh-web.mjs": return import("../../dsh-web.mjs");
    case "./lmstudio-models.mjs": return import("../../lmstudio-models.mjs");
    case "./local-benchmark.mjs": return import("../../local-benchmark.mjs");
    case "./local-download.mjs": return import("../../local-download.mjs");
    case "./local-mlx-operation.mjs": return import("../../local-mlx-operation.mjs");
    case "./local-model-ref.mjs": return import("../../local-model-ref.mjs");
    case "./local-models.mjs": return import("../../local-models.mjs");
    case "./local-uninstall.mjs": return import("../../local-uninstall.mjs");
    case "./model-catalog-cache.mjs": return import("../../model-catalog-cache.mjs");
    case "./model-failover.mjs": return import("../../model-failover.mjs");
    case "./model-registry.mjs": return import("../../model-registry.mjs");
    case "./ollama-runtime.mjs": return import("../../ollama-runtime.mjs");
    case "./presence-state.mjs": return import("../../presence-state.mjs");
    case "./provider-api-key-control.mjs": return import("../../provider-api-key-control.mjs");
    case "./provider-catalogs.mjs": return import("../../provider-catalogs.mjs");
    case "./provider-onboarding.mjs": return import("../../provider-onboarding.mjs");
    case "./provider-selection.mjs": return import("../../provider-selection.mjs");
    case "./provider-usage.mjs": return import("../../provider-usage.mjs");
    case "./providers.mjs": return import("../../providers.mjs");
    case "./router-dashboard.mjs": return import("../../router-dashboard.mjs");
    case "./subagent-auto-policy.mjs": return import("../../subagent-auto-policy.mjs");
    case "./subagent-verify.mjs": return import("../../subagent-verify.mjs");
    case "./target-integration.mjs": return import("../../target-integration.mjs");
    case "./vision-benchmark.mjs": return import("../../vision-benchmark.mjs");
    case "./vision-bridge-state.mjs": return import("../../vision-bridge-state.mjs");
    case "./vision-bridge.mjs": return import("../../vision-bridge.mjs");
    case "./vision-download.mjs": return import("../../vision-download.mjs");
    case "./vision-engines.mjs": return import("../../vision-engines.mjs");
    case "./vision-host.mjs": return import("../../vision-host.mjs");
    default: throw new Error(`Unsupported legacy control module: ${specifier}`);
  }
}

export function legacyControlScript(repoRoot, key) {
  switch (key) {
    case "vision-download-worker": return path.join(repoRoot, "src", "vision-download.mjs");
    case "local-download-worker": return path.join(repoRoot, "src", "local-download.mjs");
    case "local-uninstall-worker": return path.join(repoRoot, "src", "local-uninstall.mjs");
    case "tray-service-command": return path.join(repoRoot, "src", "tray-service.mjs");
    default: throw new Error(`Unsupported legacy control script: ${key}`);
  }
}
