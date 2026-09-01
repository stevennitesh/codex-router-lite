import { existsSync } from "node:fs";
import path from "node:path";

import { PROVIDERS, resolveProviderBaseUrl } from "./model-registry.mjs";
import { PROVIDER_SELECTION_PATH, STATE_DIR } from "./paths.mjs";
import { readProviderSelection } from "./provider-selection.mjs";

export function switchyardLaunch({
  selected,
  stateDir = STATE_DIR,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (!selected) return undefined;
  const codexHome = env.CODEX_HOME || path.dirname(stateDir);
  const runtimeRoot = env.CODEX_ROUTER_SWITCHYARD_ROOT || path.join(codexHome, "switchyard");
  const binary = env.CODEX_ROUTER_SWITCHYARD_BIN || path.join(
    runtimeRoot,
    platform === "win32" ? "switchyard-server.exe" : "switchyard-server",
  );
  const config = env.CODEX_ROUTER_SWITCHYARD_CONFIG || path.join(runtimeRoot, "routes.toml");
  if (!exists(binary)) {
    throw new Error(`Switchyard is enabled but its server is missing at ${binary}.`);
  }
  if (!exists(config)) {
    throw new Error(`Switchyard is enabled but its route config is missing at ${config}.`);
  }
  const provider = PROVIDERS.get("switchyard");
  const baseUrl = new URL(resolveProviderBaseUrl(provider, env).baseUrl);
  const host = baseUrl.hostname.replace(/^\[|\]$/g, "");
  const port = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
  return {
    binary,
    config,
    runtimeRoot,
    healthUrl: `${baseUrl.origin}/health`,
    args: [
      "--config",
      config,
      "--host",
      host,
      "--port",
      port,
      "--routing-log-file",
      path.join(runtimeRoot, "routing.jsonl"),
    ],
  };
}

export function installedSwitchyardLaunch() {
  const selected = existsSync(PROVIDER_SELECTION_PATH) &&
    readProviderSelection().includes("switchyard");
  return switchyardLaunch({ selected });
}
