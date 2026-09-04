import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

const MULTI_AGENT_STATE_PATH =
  process.env.MODEL_ROUTER_MULTI_AGENT_STATE ||
  path.join(STATE_DIR, "multi-agent-settings.json");

const SUBAGENT_MODES = Object.freeze(["all", "selected", "proven"]);

function defaultSettings() {
  return { version: 2, mode: "proven", enabled: [], disabled: [] };
}

// Local selection filters routes already certified in the checked-in registry.
// It cannot manufacture a v2 claim for an unverified model.
export function readMultiAgentSettings() {
  if (existsSync(MULTI_AGENT_STATE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(MULTI_AGENT_STATE_PATH, "utf8"));
      if (
        parsed?.version === 2 &&
        SUBAGENT_MODES.includes(parsed.mode) &&
        Array.isArray(parsed.enabled) &&
        Array.isArray(parsed.disabled)
      ) {
        return parsed;
      }
    } catch {
      // Invalid local state cannot expand capability; use the safe default.
    }
  }
  return defaultSettings();
}

export function subagentSettingsSnapshot() {
  const settings = readMultiAgentSettings();
  return {
    ...settings,
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

export function setMultiAgentMode(mode) {
  if (!SUBAGENT_MODES.includes(mode)) {
    throw new Error(`Unknown subagent mode "${mode}". Choose: ${SUBAGENT_MODES.join(", ")}`);
  }
  const current = readMultiAgentSettings();
  const next =
    mode === "all"
      ? { ...current, version: 2, mode, disabled: [] }
      : { ...current, version: 2, mode };
  writeSettings(next);
  return subagentSettingsSnapshot();
}

export function setMultiAgentModel(slug, enabled) {
  return setMultiAgentModels([slug], enabled);
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
    version: 2,
    mode: current.mode === "proven" && enabled ? "selected" : current.mode,
    enabled: [...enabledSet].sort(),
    disabled: [...disabledSet].sort(),
    // Rebuilt literally rather than spread, so every writer has to carry the
    // effort map forward by hand or silently drop a user's choices.
    ...(current.efforts ? { efforts: current.efforts } : {}),
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
  return subagentEfforts()[String(slug || "")];
}

// `effort` of undefined/null clears the override and restores the model's own
// default. Validation against the model's advertised levels belongs to the
// caller, which is the layer that can see the registry.
export function setSubagentEffort(slug, effort) {
  const key = String(slug || "").trim();
  if (!key) throw new Error("A model slug is required.");
  const current = readMultiAgentSettings();
  const efforts = { ...subagentEfforts() };
  if (effort === undefined || effort === null || effort === "") delete efforts[key];
  else efforts[key] = String(effort).trim();
  const next = { ...current, version: 2 };
  if (Object.keys(efforts).length) next.efforts = efforts;
  else delete next.efforts;
  writeSettings(next);
  return subagentSettingsSnapshot();
}

// `proven` and `all` keep every certified route unless it is disabled.
// `selected` keeps only certified routes the operator explicitly enabled.
function applyMultiAgentSettings(models, settings, hidden = new Set()) {
  const disabled = new Set(settings.disabled || []);
  const enabled = new Set(settings.enabled || []);
  const mode = settings.mode || "proven";
  return models.map((model) => {
    const slug = String(model.slug || "");
    if (
      model.multiAgentVersion === "v2" &&
      (hidden.has(slug) || disabled.has(slug) || (mode === "selected" && !enabled.has(slug)))
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

// Return the certified routes that remain after local filtering.
export function subagentEligibleModels(models, settings) {
  const disabled = new Set(settings?.disabled || []);
  return models.filter(
    (model) =>
      model.multiAgentVersion === "v2" && !disabled.has(String(model.slug)),
  );
}
