import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TARGET = "codex";
if (process.env.MODEL_ROUTER_TARGET && process.env.MODEL_ROUTER_TARGET !== TARGET) {
  throw new Error("MODEL_ROUTER_TARGET supports only codex.");
}

export const ROUTER_PLANE_TARGET = "codex";

const configuredSourceRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
if (configuredSourceRoot && !path.isAbsolute(configuredSourceRoot)) {
  throw new Error("CODEX_ROUTER_SOURCE_ROOT must be an absolute path.");
}
export const SOURCE_ROOT = configuredSourceRoot
  ? path.normalize(configuredSourceRoot)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CODEX_HOME =
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

function managedStateDir() {
  return (
    process.env.CODEX_ROUTER_STATE_DIR || path.join(CODEX_HOME, "codex-router")
  );
}

export const STATE_DIR = process.env.MODEL_ROUTER_STATE_DIR || managedStateDir();
export const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
export const MODELS_CACHE_PATH = path.join(CODEX_HOME, "models_cache.json");
export const CODEX_AGENTS_DIR = path.join(CODEX_HOME, "agents");
export const NATIVE_CATALOG_PATH = path.join(STATE_DIR, "native-models.json");
export const NATIVE_CATALOG_SOURCE_PATH = path.join(
  STATE_DIR,
  "native-catalog-source.json",
);
export const MERGED_CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");
export const ANNOUNCED_MODELS_PATH = path.join(STATE_DIR, "announced-models.json");
export const LITELLM_CONFIG_PATH = path.join(STATE_DIR, "litellm.yaml");
export const INTERNAL_SECRET_PATH = path.join(STATE_DIR, "internal-secret");
export const CALLER_SECRET_PATH = path.join(STATE_DIR, "caller-secret");
export const PROVIDER_SELECTION_PATH = path.join(STATE_DIR, "enabled-providers.json");
// Explicit, shared-plane consent for letting router-authenticated local clients
// use the ChatGPT session owned by this user's Codex installation. The file
// carries no credential; its presence records only the user's authorization.
export const NATIVE_SESSION_CONSENT_PATH = path.join(
  STATE_DIR,
  "native-session-consent.json",
);
// Last observed acceptance or rejection of the credential supplied by the
// running Codex desktop process. This file contains no credential or account
// identifier; its process generation prevents an old session from authorizing
// a later desktop launch.
export const NATIVE_AUTH_OBSERVATION_PATH = path.join(
  STATE_DIR,
  "native-auth-observation.json",
);
export const INSTALL_MANIFEST_PATH = path.join(STATE_DIR, "install-manifest.json");
export const SKILL_OWNERSHIP_PATH = path.join(STATE_DIR, "managed-skills.json");
export const LOG_PATH = path.join(STATE_DIR, "router.log");
export const SERVICE_PROCESS_STATE_PATH = path.join(STATE_DIR, "service-process.json");
export const BACKUP_PATH = path.join(CODEX_HOME, "config.toml.pre-codex-router");

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535.`);
  }
  return value;
}

const DEFAULT_PORTS = Object.freeze({
  gateway: 4200,
  router: 4202,
  api: 4203,
});

export const PORTS = {
  gateway: port(
    "MODEL_ROUTER_GATEWAY_PORT",
    process.env.CODEX_ROUTER_GATEWAY_PORT || DEFAULT_PORTS.gateway,
  ),
  router: port(
    "MODEL_ROUTER_PORT",
    process.env.CODEX_ROUTER_PORT || DEFAULT_PORTS.router,
  ),
  api: port(
    "MODEL_ROUTER_API_PORT",
    process.env.CODEX_ROUTER_API_PORT || DEFAULT_PORTS.api,
  ),
};

export function loopback(portNumber, suffix = "") {
  return `http://127.0.0.1:${portNumber}${suffix}`;
}
