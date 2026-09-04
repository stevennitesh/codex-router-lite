import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import { PROVIDER_SELECTION_PATH } from "./paths.mjs";
import { LISTED_MODELS, PROVIDERS } from "./routed-models.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { switchyardRuntimeStatus } from "./switchyard-runtime.mjs";

const PROVIDER_IDS = Object.freeze(["openrouter", "switchyard"]);

export function canonicalProviderId(id) {
  return String(id || "").trim();
}

function validateProviderIds(values) {
  const result = [];
  for (const value of values || []) {
    const id = canonicalProviderId(value);
    if (!PROVIDERS.has(id)) throw new Error(`Unknown provider: ${id}`);
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function configuredProviderIds() {
  const configured = [];
  const openRouter = resolveProviderCredential("openrouter", { persistent: true });
  if (openRouter?.value) configured.push("openrouter");
  if (switchyardRuntimeStatus().ready) configured.push("switchyard");
  return configured;
}

export function providerRuntimeAvailable(providerId, { switchyardStatus } = {}) {
  if (canonicalProviderId(providerId) !== "switchyard") return providerId === "openrouter";
  return (switchyardStatus || switchyardRuntimeStatus()).ready === true;
}

function defaultProviderIds() {
  return configuredProviderIds().filter((id) => id === "openrouter");
}

function readProviderSelectionDetail() {
  if (!existsSync(PROVIDER_SELECTION_PATH)) {
    return { providers: [...PROVIDER_IDS], ignored: [], degraded: undefined };
  }
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.providers)) {
      throw new Error("version/providers are invalid");
    }
    const known = [];
    const ignored = [];
    for (const value of parsed.providers) {
      const id = canonicalProviderId(value);
      if (PROVIDERS.has(id)) {
        if (!known.includes(id)) known.push(id);
      } else if (id && !ignored.includes(id)) {
        ignored.push(id);
      }
    }
    return {
      providers: known,
      ignored,
      ...(ignored.length
        ? { degraded: `Provider selection ignores unsupported providers: ${ignored.join(", ")}` }
        : {}),
    };
  } catch (error) {
    return {
      providers: [...PROVIDER_IDS],
      ignored: [],
      degraded: `Unreadable provider selection: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function readProviderSelection() {
  return readProviderSelectionDetail().providers;
}

export function writeProviderSelection(values) {
  const providers = validateProviderIds(values);
  writePrivateJson(PROVIDER_SELECTION_PATH, { version: 1, providers });
  return providers;
}

export function enableProvider(providerId) {
  const id = validateProviderIds([providerId])[0];
  if (id === "switchyard") {
    const runtime = switchyardRuntimeStatus();
    if (!runtime.ready) {
      throw new Error(`Switchyard cannot be enabled; missing: ${runtime.missing.join(", ")}`);
    }
  }
  return writeProviderSelection([...readProviderSelection(), id]);
}

export function disableProvider(providerId) {
  const id = validateProviderIds([providerId])[0];
  return writeProviderSelection(readProviderSelection().filter((entry) => entry !== id));
}

function selectedListedModels() {
  const selected = new Set(readProviderSelection());
  return LISTED_MODELS.filter((model) => selected.has(model.provider));
}

export function selectedConfiguredListedModels() {
  const configured = new Set(configuredProviderIds());
  return selectedListedModels().filter((model) => configured.has(model.provider));
}

export function providerSelectionStatus() {
  const detail = readProviderSelectionDetail();
  return {
    path: PROVIDER_SELECTION_PATH,
    explicit: existsSync(PROVIDER_SELECTION_PATH),
    providers: detail.providers,
    ignored: detail.ignored,
    ...(detail.degraded ? { degraded: detail.degraded } : {}),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || "status";
    if (command === "status") {
      process.stdout.write(`${JSON.stringify(providerSelectionStatus(), null, 2)}\n`);
    } else if (command === "set") {
      process.stdout.write(
        `${JSON.stringify({ providers: writeProviderSelection(process.argv.slice(3).flatMap((value) => value.split(","))) }, null, 2)}\n`,
      );
    } else if (command === "ensure-configured") {
      const explicit = existsSync(PROVIDER_SELECTION_PATH);
      const providers = explicit ? readProviderSelection() : writeProviderSelection(defaultProviderIds());
      const configured = new Set(configuredProviderIds());
      const missing = providers.filter((provider) => !configured.has(provider));
      if (missing.length) throw new Error(`Selected providers are unavailable: ${missing.join(", ")}.`);
      process.stdout.write(`${JSON.stringify({ providers, idle: providers.length === 0 }, null, 2)}\n`);
    } else {
      throw new Error("Usage: provider-selection.mjs status|set [openrouter,switchyard]|ensure-configured");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
