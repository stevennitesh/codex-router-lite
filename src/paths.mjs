import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TARGET = "codex";
if (process.env.MODEL_ROUTER_TARGET && process.env.MODEL_ROUTER_TARGET !== TARGET) {
  throw new Error("MODEL_ROUTER_TARGET supports only codex.");
}

// The router *plane* -- service, ports, gateway, secrets, credentials, provider
// selection -- is one installation shared by every client integration, so the
// two targets are not two routers. `TARGET` selects which client's
// configuration this command writes; it must never fork the state directory or
// the service, or a user who installs both would be asked for every API key
// twice and would run two gateways against one set of provider quotas.
//
// A handful of environment aliases (`CODEX_ROUTER_*`, `KIMI_*`) are keyed on
// the plane rather than on the client, because they name the service's own
// process. They stay on `codex` whichever integration is being installed.
export const ROUTER_PLANE_TARGET = "codex";

export const TARGET_DISPLAY_NAME = "Codex Router";
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
    process.env.CODEX_ROUTER_STATE_DIR ||
    process.env.KIMI_CODEX_STATE_DIR ||
    path.join(CODEX_HOME, "codex-router")
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
export const NATIVE_ALIAS_PATH = path.join(STATE_DIR, "native-aliases.json");
export const ANNOUNCED_MODELS_PATH = path.join(STATE_DIR, "announced-models.json");
export const LITELLM_CONFIG_PATH = path.join(STATE_DIR, "litellm.yaml");
export const INTERNAL_SECRET_PATH = path.join(STATE_DIR, "internal-secret");
export const CALLER_SECRET_PATH = path.join(STATE_DIR, "caller-secret");
export const CODEX_PROVIDER_MODE_PATH = path.join(STATE_DIR, "codex-provider-mode.json");
export const LOGIN_FREE_REFRESH_JOURNAL_PATH = path.join(
  STATE_DIR,
  "login-free-refresh.json",
);
export const SIGNED_PROVIDER_MODE_PATH = path.join(STATE_DIR, "signed-provider-mode.json");
// An opt-in routed default for signed-in Codex. The router owns this small
// state file, while Codex continues to own the actual config document.
export const CODEX_DEFAULT_MODEL_PATH = path.join(STATE_DIR, "codex-default-model.json");
export const PROVIDER_SELECTION_PATH = path.join(STATE_DIR, "enabled-providers.json");
export const DISCOVERY_MODE_PATH = path.join(STATE_DIR, "discovery-mode.json");
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
// The last model list each provider published for itself. It is a convenience
// cache for the curation surfaces, never an authority: what is registered
// locally is always recomputed from the live registry.
export const PROVIDER_CATALOG_CACHE_PATH = path.join(STATE_DIR, "provider-catalog-cache.json");
export const PROVIDER_API_KEY_POOL_PATH =
  process.env.MODEL_ROUTER_API_KEY_POOL_PATH ||
  path.join(STATE_DIR, "provider-api-key-pools.json");
export const INSTALL_MANIFEST_PATH = path.join(STATE_DIR, "install-manifest.json");
export const SKILL_OWNERSHIP_PATH = path.join(STATE_DIR, "managed-skills.json");
// Provider credential metadata contains only opaque references. The actual
// token remains in the existing provider file/keychain/OAuth store.
export const PROVIDER_CREDENTIAL_STORE_PATH =
  process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE ||
  path.join(STATE_DIR, "provider-credentials.json");
// Account-pool policy contains only opaque account ids and routing metadata;
// native OAuth credentials stay owned by the Codex login implementation.
export const CHATGPT_ACCOUNT_POOL_PATH =
  process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_POOL ||
  path.join(STATE_DIR, "chatgpt-account-pool.json");
// Each ChatGPT subscription account gets its own Codex home.  The home keeps
// the OAuth refresh state under Codex's normal ownership boundary instead of
// copying a token into the router's pool metadata.  The account id is always
// validated before it is appended to this directory.
export const CHATGPT_ACCOUNT_HOMES_DIR =
  process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_HOMES ||
  path.join(STATE_DIR, "chatgpt-accounts");
export const CHATGPT_PROFILE_SWITCH_PATH = path.join(STATE_DIR, "chatgpt-profile-switch.json");
// User-defined OpenAI-compatible provider descriptors. The document contains
// no raw credentials; credentialRef values point to the provider-neutral store.
export const GENERIC_PROVIDERS_PATH =
  process.env.MODEL_ROUTER_GENERIC_PROVIDERS ||
  path.join(STATE_DIR, "generic-providers.json");
export const GENERIC_PROVIDER_CREDENTIALS_DIR = path.join(STATE_DIR, "generic-provider-credentials");
// Explicit Codex-only bindings from a routed model to a separately
// credentialed search provider. The document contains provider ids and policy
// bounds only; endpoints and secrets remain owned by generic provider state.
export const SEARCH_SIDECARS_PATH =
  process.env.MODEL_ROUTER_SEARCH_SIDECARS ||
  path.join(STATE_DIR, "search-sidecars.json");
export const SUPPORT_DIR = path.join(STATE_DIR, "support");
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

export const DEFAULT_PORTS = Object.freeze({
  gateway: 4200,
  router: 4202,
  api: 4203,
});

export const PORTS = {
  gateway: port(
    "MODEL_ROUTER_GATEWAY_PORT",
    process.env.CODEX_ROUTER_GATEWAY_PORT || process.env.KIMI_GATEWAY_PORT || DEFAULT_PORTS.gateway,
  ),
  router: port(
    "MODEL_ROUTER_PORT",
    process.env.CODEX_ROUTER_PORT || DEFAULT_PORTS.router,
  ),
  api: port(
    "MODEL_ROUTER_API_PORT",
    process.env.CODEX_ROUTER_API_PORT || process.env.KIMI_API_FORWARD_PORT || DEFAULT_PORTS.api,
  ),
};

export function loopback(portNumber, suffix = "") {
  return `http://127.0.0.1:${portNumber}${suffix}`;
}
