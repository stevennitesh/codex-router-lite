import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { readJsonFile } from "./file-probe.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { CODEX_HOME, STATE_DIR, PORTS } from "./paths.mjs";
import { readResponseBody } from "./http-utils.mjs";

const settingsPath = path.join(STATE_DIR, "chatgpt-web.json");
const privateRoot = path.join(STATE_DIR, "web-bridge");
export const WEB_BRIDGE_HOME = path.join(privateRoot, "bridge");
export const WEB_BRIDGE_CODEX_HOME = path.join(privateRoot, "codex");
export const WEB_BRIDGE_BROWSER_HOME = path.join(privateRoot, "browser");
const defaultBaseUrl = "http://127.0.0.1:17841/v1";
// Exact current routes from codex-chatgpt-web 6.1.9, f137c2f. Backend transport
// names are NOT serving identities. The browser independently verifies family.
const definitions = [
  ["gpt-6-sol-instant", "GPT-6 Sol Instant (Web)", ["low"]],
  ["gpt-6-sol", "GPT-6 Sol (Web)", ["medium", "high", "xhigh"]],
  ["gpt-5.6-sol-instant", "GPT-5.6 Sol Instant (Web)", ["low"]],
  ["gpt-5.6-sol", "GPT-5.6 Sol (Web)", ["medium", "high", "xhigh"]],
  ["gpt-5.6-pro", "GPT-5.6 Sol Pro (Web)", ["max"]],
  ["gpt-6-pro", "GPT-6 Astra Pro (Web)", ["max"]],
  ["gpt-5.6-luna", "ChatGPT Luna / Think (Web; version unverified)", ["low", "medium"]],
];
const labels = { low: "Instant", medium: "Medium", high: "High", xhigh: "Extra High", max: "Pro" };
export function isWebBridgeModel(slug) { return typeof slug === "string" && slug.startsWith("chatgpt-web/"); }

export function validateWebBridgeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
      || url.search || url.hash || !["/v1", "/v1/"].includes(url.pathname)
      || Object.values(PORTS).includes(Number(url.port || 80))) {
    throw new Error("Web bridge requires its own http://127.0.0.1:<port>/v1 address, without credentials or query.");
  }
  return url.href.replace(/\/$/u, "");
}

export function buildWebBridgeModels(capabilities, { mode = "full" } = {}) {
  if (!["full", "browser-only"].includes(mode)) throw new Error("Unknown Web bridge mode.");
  if (!capabilities || !["solAvailable", "extraHighAvailable", "proAvailable"].every(key => typeof capabilities[key] === "boolean")) {
    throw new Error("Web bridge account capabilities are missing or invalid; finish isolated launcher setup and reconnect.");
  }
  return definitions.filter(([id]) => capabilities.solAvailable ? !id.endsWith("luna")
    && (!id.endsWith("pro") || capabilities.proAvailable) : id.endsWith("luna"))
    .map(([id, displayName, supported]) => {
      const luna = id.endsWith("luna"), pro = id.endsWith("pro");
      const efforts = supported.filter(effort => effort !== "xhigh" || capabilities.extraHighAvailable);
      const window = luna ? 1_050_000 : capabilities.proAvailable ? pro ? 112_193 : 111_193 : efforts[0] === "low" ? 41_000 : 90_000;
      const compact = luna ? window : capabilities.proAvailable ? 95_000 : efforts[0] === "low" ? 32_000 : 80_000;
      const levels = efforts.map(effort => ({ effort, description: luna ? effort === "low" ? "Ordinary Luna" : "Think" : labels[effort] }));
      return { slug: `chatgpt-web/${id}`, provider: "chatgpt-web", displayName, display_name: displayName,
        description: `${displayName}. ${mode === "browser-only" ? "Browser-only: local coding tools are unavailable." : "Full harness: local tools use the configured MCP connector."} Account model availability is verified by the bridge before sending.`,
        supportsSubagents: mode === "full",
        defaultEffort: efforts[0], default_reasoning_level: efforts[0], reasoningLevels: levels, supported_reasoning_levels: levels,
        multiAgentVersion: "v1", multi_agent_version: "v1", visibility: "list", supported_in_api: true,
        context_window: window, max_context_window: window, effective_context_window_percent: 100,
        auto_compact_token_limit: compact, tool_mode: null, upgrade: null,
        additional_speed_tiers: [], service_tiers: [], default_service_tier: null };
    });
}

export function readWebBridgeSettings() {
  const observed = readJsonFile(settingsPath);
  if (observed.status === "missing") return { version: 1, enabled: false, baseUrl: defaultBaseUrl, models: [] };
  const value = observed.value;
  if (observed.status !== "present" || value?.version !== 1 || typeof value.enabled !== "boolean") {
    throw new Error("Cannot read Web bridge settings; existing invalid state is not a disabled bridge.");
  }
  const baseUrl = validateWebBridgeBaseUrl(value.baseUrl);
  const mode = value.mode ?? "full";
  if (!["full", "browser-only"].includes(mode)) throw new Error("Unknown Web bridge mode in settings.");
  return { ...value, baseUrl, mode, models: value.capabilities ? buildWebBridgeModels(value.capabilities, { mode }) : [] };
}
export function webBridgeModels() {
  const settings = readWebBridgeSettings();
  return settings.enabled ? settings.models : [];
}
export function webBridgeStatus() {
  const { enabled, baseUrl, mode, models, connectedAt, bridgeVersion } = readWebBridgeSettings();
  return { enabled, baseUrl, mode, localToolsConfigured: enabled && mode === "full", models: models.map(({ slug, displayName, supported_reasoning_levels }) => ({ slug, displayName, efforts: supported_reasoning_levels })),
    connectedAt, bridgeVersion, browserReadiness: "Run the isolated launcher's browser and MCP verification; listener health alone does not prove login or tool access.",
    home: WEB_BRIDGE_HOME, codexHome: WEB_BRIDGE_CODEX_HOME };
}

export async function connectWebBridge(baseUrl = defaultBaseUrl) {
  const normalized = validateWebBridgeBaseUrl(baseUrl);
  const observed = readJsonFile(path.join(WEB_BRIDGE_HOME, "config.json"));
  const config = observed.value;
  if (observed.status !== "present" || config?.version !== 3 || !["full", "browser-only"].includes(config.mode)
      || config.browserInteractionMode !== "automatic" || config.experimentalBiggerContext === true
      || config.purpose === "dev-harness" || config.host !== "127.0.0.1"
      || Number(new URL(normalized).port || 80) !== config.port) {
    throw new Error("Finish isolated production launcher setup in Automatic mode with Bigger Context off, using the matching loopback port, then reconnect.");
  }
  // Read selected public capability observations only. Never copy tunnel keys,
  // browser state, control tokens, or Codex credentials into Router settings.
  const capabilities = { solAvailable: config.solAvailable, extraHighAvailable: config.extraHighAvailable === true, proAvailable: config.proAvailable };
  buildWebBridgeModels(capabilities);
  const response = await fetch(`${new URL(normalized).origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  const health = JSON.parse((await readResponseBody(response, { maxBytes: 64 * 1024 })).toString("utf8"));
  if (!response.ok || health.service !== "codex-chatgpt-web" || health.status !== "ok" || health.mode !== config.mode || health.accepting_turns !== true) {
    throw new Error("The selected listener is not an accepting ChatGPT Web bridge matching its configured mode.");
  }
  return withCatalogPublicationLock(() => {
    writePrivateJson(settingsPath, { version: 1, enabled: true, baseUrl: normalized, mode: config.mode, capabilities,
      connectedAt: new Date().toISOString(), bridgeVersion: health.version });
    return webBridgeStatus();
  });
}
export function disconnectWebBridge() {
  return withCatalogPublicationLock(() => {
    const { models: _models, ...settings } = readWebBridgeSettings();
    writePrivateJson(settingsPath, { ...settings, enabled: false });
    return webBridgeStatus();
  });
}

export async function launchWebBridge(executable) {
  if (!path.isAbsolute(executable || "") || !existsSync(executable) || path.extname(executable).toLowerCase() !== ".exe") {
    throw new Error("Supply the absolute path to the installed codex-chatgpt-web launcher .exe.");
  }
  for (const directory of [WEB_BRIDGE_HOME, WEB_BRIDGE_CODEX_HOME, WEB_BRIDGE_BROWSER_HOME]) mkdirSync(directory, { recursive: true });
  // Full harness authenticates resumed turns and V1 child environments against
  // canonical native rollouts. Expose only that existing directory, not auth or
  // real config. The bridge follows a sessions-root junction by design.
  const sourceSessions = path.join(CODEX_HOME, "sessions");
  const isolatedSessions = path.join(WEB_BRIDGE_CODEX_HOME, "sessions");
  if (existsSync(sourceSessions)) {
    let existing;
    try { existing = lstatSync(isolatedSessions); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing) {
      if (!existing.isSymbolicLink() || realpathSync(isolatedSessions).toLowerCase() !== realpathSync(sourceSessions).toLowerCase()) {
        throw new Error("Isolated bridge sessions path already exists and is not the expected native-rollout junction.");
      }
    } else symlinkSync(sourceSessions, isolatedSessions, "junction");
  }
  // detached/unref only releases Node's handle. On Windows a tool's child still
  // belongs to Codex's process tree/job and closes with the app. A local WMI
  // provider creates the launcher independently, with an explicit environment.
  const environment = { CODEX_HOME: WEB_BRIDGE_CODEX_HOME, CODEX_CHATGPT_WEB_HOME: WEB_BRIDGE_HOME,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: WEB_BRIDGE_BROWSER_HOME };
  for (const name of ["SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATHEXT", "PATH", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "ProgramData", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
    "PUBLIC", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helper = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", fileURLToPath(new URL("./web-bridge-launch.ps1", import.meta.url))],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000 });
  const receipt = await new Promise((resolve, reject) => {
    let output = "", failure = "";
    helper.stdout.setEncoding("utf8").on("data", value => { output += value; });
    helper.stderr.setEncoding("utf8").on("data", value => { failure += value; });
    helper.once("error", reject);
    helper.once("close", code => {
      if (code !== 0) return reject(new Error(`Independent Web launcher failed (${code ?? "terminated"}): ${failure.trim()}`));
      try {
        const result = JSON.parse(output);
        if (!Number.isInteger(result.processId) || result.processId <= 0) throw new Error("No launcher process identity was returned.");
        resolve(result);
      } catch (error) { reject(error); }
    });
    helper.stdin.on("error", reject);
    helper.stdin.end(JSON.stringify({ executable, environment }));
  });
  return { launched: true, processId: receipt.processId, isolatedCodexHome: WEB_BRIDGE_CODEX_HOME,
    next: "Complete ChatGPT sign-in, Full harness MCP setup, browser smoke test and Verify runtime in the launcher; then run codex web connect and refresh-catalog. Real Codex configuration stays Router-owned." };
}

export async function requestWebBridge(payload, { compact = false, signal, headers = {} } = {}) {
  const settings = readWebBridgeSettings();
  if (!settings.enabled) throw Object.assign(new Error("ChatGPT Web bridge is disabled. Connect the isolated launcher first."), { status: 409 });
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
  for (const name of ["session_id", "session-id", "x-codex-thread-id", "x-codex-turn-id", "x-codex-parent-thread-id", "x-codex-client-metadata", "x-codex-turn-metadata", "x-codex-session-id"]) {
    if (typeof headers[name] === "string") forwardedHeaders[name] = headers[name];
  }
  return fetch(`${settings.baseUrl}/responses${compact ? "/compact" : ""}`, {
    method: "POST", redirect: "error", signal, headers: forwardedHeaders,
    body: JSON.stringify({ ...payload, reasoning: { ...payload.reasoning, effort } }),
  });
}
