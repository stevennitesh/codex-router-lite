import { existsSync } from "node:fs";
import path from "node:path";

import { PROVIDERS, resolveProviderBaseUrl } from "./model-registry.mjs";
import { STATE_DIR } from "./paths.mjs";

export function switchyardRuntimeStatus({
  stateDir = STATE_DIR,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const codexHome = env.CODEX_HOME || path.dirname(stateDir);
  const runtimeRoot = env.CODEX_ROUTER_SWITCHYARD_ROOT || path.join(codexHome, "switchyard");
  const binary = env.CODEX_ROUTER_SWITCHYARD_BIN || path.join(
    runtimeRoot,
    platform === "win32" ? "switchyard-server.exe" : "switchyard-server",
  );
  const config = env.CODEX_ROUTER_SWITCHYARD_CONFIG || path.join(runtimeRoot, "routes.toml");
  const missing = [
    ...(!exists(binary) ? [binary] : []),
    ...(!exists(config) ? [config] : []),
  ];
  return {
    ready: missing.length === 0,
    runtimeRoot,
    binary,
    config,
    missing,
  };
}

export function switchyardLaunch({
  selected,
  stateDir = STATE_DIR,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (!selected) return undefined;
  const status = switchyardRuntimeStatus({ stateDir, env, platform, exists });
  if (!status.ready) {
    throw new Error(
      `Switchyard is enabled but its runtime is incomplete; missing ${status.missing.join(", ")}.`,
    );
  }
  const { binary, config, runtimeRoot } = status;
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

export function installedSwitchyardLaunch({
  selected,
  warn = console.error,
  runtimeOptions = {},
} = {}) {
  if (!selected) return undefined;
  const status = switchyardRuntimeStatus(runtimeOptions);
  if (!status.ready) {
    warn(
      `[model-router] Switchyard is selected but unavailable; continuing without it. ` +
        `Missing: ${status.missing.join(", ")}`,
    );
    return undefined;
  }
  return switchyardLaunch({ selected: true, ...runtimeOptions });
}
