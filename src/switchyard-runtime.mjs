import path from "node:path";
import { isIPv4 } from "node:net";

import {
  PROVIDERS,
  resolveProviderBaseUrl,
} from "./routed-models.mjs";
import { STATE_DIR } from "./paths.mjs";
import { probeRegularFile } from "./file-probe.mjs";

export const SWITCHYARD_CAPABILITY_ENV = "CODEX_ROUTER_SWITCHYARD_CAPABILITY";
export const SWITCHYARD_CAPABILITY_HEADER = "x-codex-router-switchyard-capability";
export const SWITCHYARD_OBSERVATION_HEADER = "x-codex-router-switchyard-observation";

export function switchyardHealthUrl({ env = process.env } = {}) {
  const provider = PROVIDERS.get("switchyard");
  const resolved = resolveProviderBaseUrl(provider, env);
  if (resolved.refusedOverride) {
    throw new Error("Managed Switchyard must bind to loopback; refusing configured address.");
  }
  const baseUrl = new URL(resolved.baseUrl);
  const host = baseUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || (isIPv4(host) && host.startsWith("127."));
  if (!loopback) {
    throw new Error(
      `Managed Switchyard must bind to loopback; refusing ${baseUrl.origin}.`,
    );
  }
  return `${baseUrl.origin}/health`;
}

export function switchyardRuntimeStatus({
  stateDir = STATE_DIR,
  env = process.env,
  exists,
  probe = probeRegularFile,
} = {}) {
  const codexHome = env.CODEX_HOME || path.dirname(stateDir);
  const runtimeRoot = env.CODEX_ROUTER_SWITCHYARD_ROOT || path.join(codexHome, "switchyard");
  const binary = env.CODEX_ROUTER_SWITCHYARD_BIN || path.join(
    runtimeRoot,
    "switchyard-server.exe",
  );
  const config = env.CODEX_ROUTER_SWITCHYARD_CONFIG || path.join(runtimeRoot, "routes.toml");
  const inspect = exists
    ? (target) => ({ status: exists(target) ? "present" : "missing" })
    : probe;
  const artifacts = [binary, config].map((target) => ({ target, ...inspect(target) }));
  const missing = artifacts.filter(({ status }) => status === "missing").map(({ target }) => target);
  const inaccessible = artifacts
    .filter(({ status }) => status === "access-denied" || status === "probe-failed")
    .map(({ target, status, code }) => ({ target, status, ...(code ? { code } : {}) }));
  const invalid = artifacts.filter(({ status }) => status === "invalid").map(({ target }) => target);
  return {
    ready: missing.length === 0 && inaccessible.length === 0 && invalid.length === 0,
    runtimeRoot,
    binary,
    config,
    missing,
    inaccessible,
    invalid,
  };
}

function switchyardRuntimeProblem(status) {
  const parts = [];
  if (status.missing.length) parts.push(`missing ${status.missing.join(", ")}`);
  if (status.inaccessible.length) {
    parts.push(`access denied or probe failed for ${status.inaccessible.map(({ target }) => target).join(", ")}`);
  }
  if (status.invalid.length) parts.push(`not regular files: ${status.invalid.join(", ")}`);
  return parts.join("; ");
}

export function switchyardSelectedForStartup(selection) {
  return selection?.explicit === true &&
    Array.isArray(selection.providers) &&
    selection.providers.includes("switchyard");
}

export function switchyardLaunch({
  selected,
  stateDir = STATE_DIR,
  env = process.env,
  exists,
  probe = probeRegularFile,
} = {}) {
  if (!selected) return undefined;
  const status = switchyardRuntimeStatus({ stateDir, env, exists, probe });
  if (!status.ready) {
    throw new Error(
      `Switchyard is enabled but its runtime is incomplete; ${switchyardRuntimeProblem(status)}.`,
    );
  }
  return switchyardLaunchFromStatus(status, env);
}

function switchyardLaunchFromStatus(status, env = process.env) {
  const { binary, config, runtimeRoot } = status;
  const provider = PROVIDERS.get("switchyard");
  const baseUrl = new URL(resolveProviderBaseUrl(provider, env).baseUrl);
  const healthUrl = switchyardHealthUrl({ env });
  const host = baseUrl.hostname.replace(/^\[|\]$/g, "");
  const port = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
  return {
    binary,
    config,
    runtimeRoot,
    healthUrl,
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
        `${switchyardRuntimeProblem(status)}`,
    );
    return undefined;
  }
  return switchyardLaunchFromStatus(status, runtimeOptions.env);
}
