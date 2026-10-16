import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { readJsonFile } from "./file-probe.mjs";
import { writePrivateFile, writePrivateJson } from "./file-security.mjs";
import { CONFIG_PATH, STATE_DIR } from "./paths.mjs";
import { MODEL_BY_SLUG, validateRoutedEffort } from "./routed-models.mjs";
import { webBridgeModels } from "./chatgpt-web.mjs";

const MULTI_AGENT_STATE_PATH =
  process.env.MODEL_ROUTER_MULTI_AGENT_STATE ||
  path.join(STATE_DIR, "multi-agent-settings.json");

const SUBAGENT_MODES = Object.freeze(["all", "selected", "proven"]);
const SUBAGENT_PROTOCOLS = Object.freeze(["v1", "v2"]);

function defaultSettings() {
  return { version: 2, mode: "proven", enabled: [], disabled: [] };
}

// Local selection filters routes already certified in the checked-in registry.
// It cannot manufacture a v2 claim for an unverified model.
export function readMultiAgentSettings() {
  const observed = readJsonFile(MULTI_AGENT_STATE_PATH);
  if (observed.status === "missing") return defaultSettings();
  const parsed = observed.value;
  const slugsValid = (value) => Array.isArray(value) && value.every((slug) => typeof slug === "string" && slug.length > 0);
  if (observed.status !== "present" || parsed?.version !== 2 || !SUBAGENT_MODES.includes(parsed.mode) ||
      !slugsValid(parsed.enabled) || !slugsValid(parsed.disabled) ||
      (parsed.protocol !== undefined && !SUBAGENT_PROTOCOLS.includes(parsed.protocol)) ||
      (parsed.efforts !== undefined && (!parsed.efforts || typeof parsed.efforts !== "object" || Array.isArray(parsed.efforts) ||
        !Object.entries(parsed.efforts).every(([slug, effort]) => slug && typeof effort === "string" && effort)))) {
    throw new Error(`Cannot read subagent settings (${observed.status === "present" ? "invalid" : observed.status}) at ${MULTI_AGENT_STATE_PATH}.`);
  }
  return parsed;
}

export function readSubagentProtocol() {
  return readMultiAgentSettings().protocol || "v2";
}

export function subagentSettingsSnapshot({ diagnostic = false } = {}) {
  let settings;
  try { settings = readMultiAgentSettings(); }
  catch (error) {
    if (!diagnostic) throw error;
    return { path: MULTI_AGENT_STATE_PATH, degraded: error.message };
  }
  return {
    ...settings,
    protocol: settings.protocol || "v2",
    protocolChangeRequiresRestart: true,
    protocolChangeRequiresNewConversation: true,
    all: settings.mode === "all",
    path: MULTI_AGENT_STATE_PATH,
    // Per-model reasoning depth applied only to child turns. Empty when the
    // operator has never set one, which is the common case.
    efforts: subagentEfforts(),
  };
}

function writeSettings(settings) {
  writePrivateJson(MULTI_AGENT_STATE_PATH, settings);
}

// Protocol changes are deliberate configuration edits, never a side effect of
// selecting a model. Keep the state and its owned native feature together under
// the same lock used by catalog publishers.
export async function setSubagentProtocol(protocol) {
  if (!SUBAGENT_PROTOCOLS.includes(protocol)) {
    throw new Error(`Unknown subagent protocol "${protocol}". Choose: ${SUBAGENT_PROTOCOLS.join(", ")}`);
  }
  return withCatalogPublicationLock(() => {
    const current = readMultiAgentSettings();
    const originals = [CONFIG_PATH, MULTI_AGENT_STATE_PATH].map(target => ({
      target, contents: existsSync(target) ? readFileSync(target) : undefined,
    }));
    try {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("./config-manager.mjs", import.meta.url)),
        "subagent-protocol", protocol,
      ], { env: process.env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
      if (result.error || result.status !== 0) {
        throw new Error(String(result.stderr || result.error?.message || "Could not update the managed subagent protocol.").trim());
      }
      writeSettings({ ...current, protocol });
      return { ...subagentSettingsSnapshot(), restartRequired: true, newConversationRequired: true };
    } catch (error) {
      const rollbackErrors = [];
      for (const { target, contents } of originals.reverse()) {
        try {
          const after = existsSync(target) ? readFileSync(target) : undefined;
          if (contents === undefined) {
            if (after !== undefined) unlinkSync(target);
          } else if (!after?.equals(contents)) writePrivateFile(target, contents);
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Subagent protocol update failed and its prior configuration could not be fully restored.");
      throw error;
    }
  });
}

export async function setMultiAgentMode(mode) {
  if (!SUBAGENT_MODES.includes(mode)) {
    throw new Error(`Unknown subagent mode "${mode}". Choose: ${SUBAGENT_MODES.join(", ")}`);
  }
  return withCatalogPublicationLock(() => {
    const current = readMultiAgentSettings();
    writeSettings(settingsForMode(current, mode));
    return subagentSettingsSnapshot();
  });
}

export function settingsForMode(current, mode) {
  if (!SUBAGENT_MODES.includes(mode)) {
    throw new Error(`Unknown subagent mode "${mode}". Choose: ${SUBAGENT_MODES.join(", ")}`);
  }
  if (mode === "all") {
    return { ...current, version: 2, mode, enabled: [], disabled: [] };
  }
  if (mode === "proven") {
    return { ...current, version: 2, mode, enabled: [] };
  }
  return { ...current, version: 2, mode };
}

export function setMultiAgentModel(slug, enabled) {
  return withCatalogPublicationLock(() => setMultiAgentModels([slug], enabled));
}

// Applies a provider-sized selection in one protected-state write. Besides
// being faster than one command per model, this prevents a half-cleared
// provider when the UI closes or a later catalog refresh fails.
function setMultiAgentModels(slugs, enabled) {
  const values = [...new Set(slugs.map((slug) => String(slug || "").trim()).filter(Boolean))];
  if (values.length === 0) throw new Error("At least one model slug is required.");
  const current = readMultiAgentSettings();
  const enabledSet = new Set(current.enabled);
  const disabledSet = new Set(current.disabled);
  for (const value of values) {
    if (enabled) {
      enabledSet.add(value);
      disabledSet.delete(value);
    } else {
      enabledSet.delete(value);
      disabledSet.add(value);
    }
  }
  const next = {
    ...current,
    version: 2,
    mode: current.mode === "proven" && enabled ? "selected" : current.mode,
    enabled: [...enabledSet].sort(),
    disabled: [...disabledSet].sort(),
  };
  writeSettings(next);
  return subagentSettingsSnapshot();
}

// Codex picks a subagent's model, but nothing lets an operator say how hard
// that subagent should think. A child auditing one file rarely needs the depth
// its parent is running at, and the reverse is true for a child doing the
// analysis the parent delegated precisely because it was expensive. Effort is
// per model rather than global: the useful setting is "when work lands on this
// model as a child, run it at this depth", and that answer differs by model.
//
// An absent entry means "leave the turn alone", which is not the same as
// recording the model's own default -- a default that later changes upstream
// should follow the model, not stay frozen at whatever it was when someone
// opened a settings page.
function subagentEfforts() {
  const efforts = readMultiAgentSettings().efforts;
  if (!efforts || typeof efforts !== "object" || Array.isArray(efforts)) return {};
  const clean = {};
  for (const [slug, effort] of Object.entries(efforts)) {
    if (typeof slug === "string" && typeof effort === "string" && slug && effort) {
      clean[slug] = effort;
    }
  }
  return clean;
}

export function subagentEffort(slug) {
  const key = String(slug || "");
  const effort = readMultiAgentSettings().efforts?.[key];
  return effort === undefined ? undefined : validateRoutedEffort(effortRoute(key), effort);
}

function effortRoute(slug) {
  const registered = MODEL_BY_SLUG.get(slug);
  if (registered) return registered;
  if (!slug.startsWith("chatgpt-web/")) return undefined;
  const row = webBridgeModels().find(model => model.slug === slug);
  return row && { ...row, defaultEffort: row.default_reasoning_level,
    reasoningLevels: row.supported_reasoning_levels };
}

// `effort` of undefined/null clears the override and restores the model's own
// default. Validation against the model's advertised levels belongs to the
// settings owner, using the registry's exact endpoint vocabulary.
export async function setSubagentEffort(slug, effort) {
  const key = String(slug || "").trim();
  if (!key) throw new Error("A model slug is required.");
  return withCatalogPublicationLock(() => {
    const value = validateRoutedEffort(effortRoute(key), effort);
    const current = readMultiAgentSettings();
    const efforts = { ...current.efforts };
    if (value === undefined) delete efforts[key];
    else efforts[key] = value;
    const next = { ...current, version: 2 };
    if (Object.keys(efforts).length) next.efforts = efforts;
    else delete next.efforts;
    writeSettings(next);
    return subagentSettingsSnapshot();
  });
}

// V2 retains the registry's certification boundary. V1 allows ordinary
// plaintext-handoff roles, including Web routes. Both respect local choices.
function applyMultiAgentSettings(models, settings, hidden = new Set()) {
  const disabled = new Set(settings.disabled || []);
  const enabled = new Set(settings.enabled || []);
  const mode = settings.mode || "proven";
  const protocol = settings.protocol || "v2";
  return models.map((model) => {
    const slug = String(model.slug || "");
    const excluded = hidden.has(slug) || disabled.has(slug) || (mode === "selected" && !enabled.has(slug));
    if (protocol === "v1") {
      return { ...model, multiAgentVersion: "v1", subagentEnabled: !excluded };
    }
    if (slug.startsWith("chatgpt-web/")) {
      return { ...model, multiAgentVersion: "v1", subagentEnabled: false };
    }
    if (
      model.multiAgentVersion === "v2" &&
      excluded
    ) {
      return { ...model, multiAgentVersion: "v1" };
    }
    return model;
  });
}

export function applyMultiAgentCapabilities(models, settings, { hidden = new Set() } = {}) {
  const configured = settings || readMultiAgentSettings();
  return applyMultiAgentSettings(models, configured, hidden);
}

// Return roles admitted by the selected protocol and local filtering.
export function subagentEligibleModels(models, settings) {
  const disabled = new Set(settings?.disabled || []);
  const enabled = new Set(settings?.enabled || []);
  const protocol = settings?.protocol || "v2";
  return models.filter(
    (model) =>
      (protocol === "v1" || (model.multiAgentVersion === "v2" && !String(model.slug).startsWith("chatgpt-web/"))) &&
      model.subagentEnabled !== false && !disabled.has(String(model.slug)) &&
      (settings?.mode !== "selected" || enabled.has(String(model.slug))),
  );
}
