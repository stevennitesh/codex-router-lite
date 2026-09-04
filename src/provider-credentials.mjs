import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile, writePrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { PROVIDERS } from "./routed-models.mjs";

export function apiProvider(providerId) {
  if (providerId !== "openrouter") throw new Error(`Unknown API-key provider: ${providerId}`);
  return PROVIDERS.get("openrouter");
}

export function primaryCredentialPath(provider = apiProvider("openrouter")) {
  if (provider?.id !== "openrouter") throw new Error("Only the OpenRouter credential is supported.");
  return path.join(STATE_DIR, "openrouter-api-key.secret");
}

function fileCredential(provider) {
  const target = primaryCredentialPath(provider);
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const value = readFileSync(target, "utf8").trim();
    return value ? { value, source: `protected file (${target})`, persistent: true } : undefined;
  } catch {
    return undefined;
  }
}

export function resolveProviderCredential(providerOrId, { persistent = false } = {}) {
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  if (provider?.id !== "openrouter") throw new Error("Only the OpenRouter credential is supported.");
  const stored = fileCredential(provider);
  if (stored) return stored;
  if (!persistent) {
    const value = String(process.env.OPENROUTER_API_KEY || "").trim();
    if (value) return { value, source: "environment (OPENROUTER_API_KEY)", persistent: false };
  }
  return undefined;
}

function credentialSetupHint() {
  return ".\\model-router.ps1 codex provider-key openrouter set";
}

export function credentialStatus(providerOrId = "openrouter", options = {}) {
  const resolved = resolveProviderCredential(providerOrId, options);
  return {
    configured: Boolean(resolved?.value),
    persistent: resolved?.persistent === true,
    source: resolved?.source,
    setup: credentialSetupHint(),
  };
}

export function writeProviderCredential(providerOrId, value) {
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const secret = String(value || "").trim();
  if (!secret || /[\u0000-\u001f\u007f]/u.test(secret)) {
    throw new Error("OpenRouter API key is empty or contains control characters.");
  }
  const target = primaryCredentialPath(provider);
  writePrivateFile(target, `${secret}\n`);
  protectPrivateFile(target);
  return target;
}
