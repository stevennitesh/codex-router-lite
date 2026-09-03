// Temporary provider boundary for control.mjs. Its exact allowlist keeps issue
// #5 provider breadth available without reconnecting removed issue #4 clients.
import path from "node:path";

export { activateAntigravityProbe } from "../../antigravity-probe-activation.mjs";
export { discoveryDisabled } from "../../discovery-mode.mjs";
export { USER_MODELS_PATH } from "../../user-models.mjs";

export function issue5ControlWorkerScript(selector, repoRoot) {
  switch (selector) {
    case "vision-download": return path.join(repoRoot, "src", "vision-download.mjs");
    case "local-download": return path.join(repoRoot, "src", "local-download.mjs");
    case "local-uninstall": return path.join(repoRoot, "src", "local-uninstall.mjs");
    default: throw new Error(`Unsupported issue #5 worker: ${selector}`);
  }
}

export function importIssue5ControlProviderModule(specifier) {
  switch (specifier) {
    case "./agent-check.mjs": return import("../../agent-check.mjs");
    case "./antigravity-oauth-probe.mjs": return import("../../antigravity-oauth-probe.mjs");
    case "./codex-account-usage.mjs": return import("../../codex-account-usage.mjs");
    case "./chatgpt-profile-switch.mjs": return import("../../chatgpt-profile-switch.mjs");
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
    case "./provider-api-key-control.mjs": return import("../../provider-api-key-control.mjs");
    case "./provider-catalogs.mjs": return import("../../provider-catalogs.mjs");
    case "./provider-onboarding.mjs": return import("../../provider-onboarding.mjs");
    case "./provider-selection.mjs": return import("../../provider-selection.mjs");
    case "./provider-usage.mjs": return import("../../provider-usage.mjs");
    case "./providers.mjs": return import("../../providers.mjs");
    case "./subagent-auto-policy.mjs": return import("../../subagent-auto-policy.mjs");
    case "./subagent-verify.mjs": return import("../../subagent-verify.mjs");
    case "./vision-benchmark.mjs": return import("../../vision-benchmark.mjs");
    case "./vision-bridge-state.mjs": return import("../../vision-bridge-state.mjs");
    case "./vision-bridge.mjs": return import("../../vision-bridge.mjs");
    case "./vision-download.mjs": return import("../../vision-download.mjs");
    case "./vision-host.mjs": return import("../../vision-host.mjs");
    default: throw new Error(`Unsupported issue #5 provider module: ${specifier}`);
  }
}
