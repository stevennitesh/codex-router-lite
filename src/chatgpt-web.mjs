import { lstatSync } from "node:fs";
import path from "node:path";

import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { readJsonFile } from "./file-probe.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR, PORTS } from "./paths.mjs";
import { buildWebBridgeModels } from "./web-models.mjs";

export { buildWebBridgeModels } from "./web-models.mjs";

const settingsPath = path.join(STATE_DIR, "chatgpt-web.json");
export const WEB_BRIDGE_TUNNEL_KEY_PATH = path.join(STATE_DIR, "chatgpt-web-runtime-key.secret");
export function isWebBridgeModel(slug) { return typeof slug === "string" && slug.startsWith("chatgpt-web/"); }

function requireFields(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`Invalid ${label}; only the documented safe fields are accepted.`);
  }
}

function safeLabel(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}; supply the exact nonempty observed value without control characters.`);
  }
  return value;
}

function existingAbsoluteFile(value, extensions, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)
      || !extensions.includes(path.extname(value).toLowerCase())) {
    throw new Error(`Invalid ${label}; supply an absolute path to an existing ${extensions.join(" or ")} file.`);
  }
  let observed;
  try { observed = lstatSync(value); } catch { /* The configuration error below keeps file diagnostics bounded. */ }
  if (!observed?.isFile() || observed.isSymbolicLink()) throw new Error(`Invalid ${label}; the configured file is missing or is not a regular file.`);
  return path.normalize(value);
}

function inAppConfiguration(value) {
  requireFields(value, ["runtimeModule", "pluginName", "pluginAppId", "pluginSelectionButtonName", "tunnelId", "tunnelClientPath", "capabilities", "mcpPort"], "in-app Web configuration");
  requireFields(value.capabilities, ["solAvailable", "extraHighAvailable", "proAvailable"], "Web account capabilities");
  buildWebBridgeModels(value.capabilities);
  if (typeof value.pluginAppId !== "string" || !/^asdk_app_[a-zA-Z0-9_-]+$/u.test(value.pluginAppId)) {
    throw new Error("Invalid pluginAppId; supply the observed asdk_app_ identity.");
  }
  if (typeof value.tunnelId !== "string" || !/^tunnel_[a-zA-Z0-9_-]+$/u.test(value.tunnelId)) {
    throw new Error("Invalid tunnelId; supply the observed tunnel_ identity.");
  }
  if (value.mcpPort !== undefined && (!Number.isInteger(value.mcpPort) || value.mcpPort < 1 || value.mcpPort > 65_535
      || Object.values(PORTS).includes(value.mcpPort))) {
    throw new Error("Invalid mcpPort; supply a dedicated loopback TCP port separate from Router.");
  }
  return {
    capabilities: Object.fromEntries(["solAvailable", "extraHighAvailable", "proAvailable"].map(key => [key, value.capabilities[key]])),
    browser: {
      runtimeModule: existingAbsoluteFile(value.runtimeModule, [".mjs", ".js"], "official public browser runtime module"),
      pluginName: safeLabel(value.pluginName, "pluginName", 128),
      pluginAppId: value.pluginAppId,
      pluginSelectionButtonName: safeLabel(value.pluginSelectionButtonName, "pluginSelectionButtonName"),
    },
    tunnel: { id: value.tunnelId, executable: existingAbsoluteFile(value.tunnelClientPath, [".exe"], "tunnel client executable") },
    ...(value.mcpPort === undefined ? {} : { mcpPort: value.mcpPort }),
  };
}

function readInAppConfiguration(value) {
  if (!value.browser || !value.tunnel) throw new Error("Web settings require an in-app browser and tunnel; reconfigure with codex web browser.");
  requireFields(value.browser, ["runtimeModule", "pluginName", "pluginAppId", "pluginSelectionButtonName"], "in-app browser settings");
  requireFields(value.tunnel, ["id", "executable"], "in-app tunnel settings");
  return inAppConfiguration({ runtimeModule: value.browser.runtimeModule, pluginName: value.browser.pluginName,
    pluginAppId: value.browser.pluginAppId, pluginSelectionButtonName: value.browser.pluginSelectionButtonName, capabilities: value.capabilities,
    tunnelId: value.tunnel.id, tunnelClientPath: value.tunnel.executable, ...(value.mcpPort === undefined ? {} : { mcpPort: value.mcpPort }) });
}

export function readWebBridgeSettings() {
  const observed = readJsonFile(settingsPath);
  if (observed.status === "missing") return { version: 1, enabled: false, models: [] };
  const value = observed.value;
  if (observed.status !== "present" || value?.version !== 1 || typeof value.enabled !== "boolean") {
    throw new Error("Cannot read Web bridge settings; existing invalid state is not a disabled bridge.");
  }
  // Existing in-app settings may contain retired launcher fields. Project only
  // supported configuration; those extras cannot choose a transport or model.
  const inApp = readInAppConfiguration(value);
  return { version: 1, enabled: value.enabled, capabilities: inApp.capabilities, browser: inApp.browser,
    tunnel: inApp.tunnel, ...(inApp.mcpPort === undefined ? {} : { mcpPort: inApp.mcpPort }),
    models: buildWebBridgeModels(inApp.capabilities) };
}
export function webBridgeModels() {
  const settings = readWebBridgeSettings();
  return settings.enabled ? settings.models : [];
}
export function webBridgeStatus() {
  const { enabled, models, browser, tunnel, mcpPort } = readWebBridgeSettings();
  return { enabled, localToolsConfigured: enabled, models: models.map(({ slug, displayName, supported_reasoning_levels }) => ({ slug, displayName, efforts: supported_reasoning_levels })),
    ...(browser ? { browser, tunnel, ...(mcpPort === undefined ? {} : { mcpPort }) } : {}),
    browserReadiness: "Verify ChatGPT sign-in, the exact selected model and the selected MCP connector in the Codex in-app browser; configuration alone does not prove browser or tool readiness." };
}

export async function configureInAppWebBridge(config) {
  const safeConfiguration = inAppConfiguration(config);
  return withCatalogPublicationLock(() => {
    writePrivateJson(settingsPath, { version: 1, enabled: true, ...safeConfiguration });
    return webBridgeStatus();
  });
}

export function disconnectWebBridge() {
  return withCatalogPublicationLock(() => {
    const { models: _models, ...settings } = readWebBridgeSettings();
    if (settings.browser) writePrivateJson(settingsPath, { ...settings, enabled: false });
    return webBridgeStatus();
  });
}

let inAppBridge;
export async function closeWebBridge() { await inAppBridge?.closeInAppWebBridge(); }
export async function startWebBridge() {
  const settings = readWebBridgeSettings();
  if (!settings.enabled) return;
  inAppBridge ??= await import("./web-runtime.mjs");
  return inAppBridge.startInAppWebBridge(settings);
}

export async function requestWebBridge(payload, { compact = false, compactV2 = false, signal, headers = {} } = {}) {
  const settings = readWebBridgeSettings();
  if (!settings.enabled) throw Object.assign(new Error("ChatGPT Web bridge is disabled. Configure the in-app browser first."), { status: 409 });
  const model = settings.models.find(row => row.slug === payload.model);
  if (!model) throw Object.assign(new Error("This exact Web model is not available in the connected account profile."), { status: 400 });
  const effort = payload.reasoning?.effort ?? model.defaultEffort;
  if (!model.supported_reasoning_levels.some(row => row.effort === effort)) {
    throw Object.assign(new Error(`Unsupported Web effort for ${model.slug}; choose ${model.supported_reasoning_levels.map(row => row.effort).join(", ")}.`), { status: 400 });
  }
  // The bridge owns tool/history conversion and local compaction. Do not run
  // OpenRouter translation or a native encrypted-payload inference relay here.
  const forwardedHeaders = { "Content-Type": "application/json", Accept: payload.stream ? "text/event-stream" : "application/json" };
  // Thread metadata needed by the bridge's exact-turn authority. Never forward
  // Authorization, native account/residency headers or Router capabilities.
  if (typeof headers["x-codex-turn-metadata"] === "string") forwardedHeaders["x-codex-turn-metadata"] = headers["x-codex-turn-metadata"];
  const validatedPayload = { ...payload, reasoning: { ...payload.reasoning, effort } };
  inAppBridge ??= await import("./web-runtime.mjs");
  return inAppBridge.requestInAppWebBridge(validatedPayload, { compact: compact || compactV2, compactV2, signal, headers: forwardedHeaders, settings });
}
