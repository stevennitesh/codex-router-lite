import { readFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile, writePrivateFile } from "./file-security.mjs";
import { fileProbeErrorReason, probeRegularFile } from "./file-probe.mjs";
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

function fileCredential(provider, { lstat, readFile = readFileSync } = {}) {
  const target = primaryCredentialPath(provider);
  const probe = probeRegularFile(target, lstat ? { lstat } : {});
  if (probe.status !== "present") return { credential: undefined, ...probe };
  try {
    const value = readFile(target, "utf8").trim();
    return {
      credential: value
        ? { value, source: `protected file (${target})`, persistent: true }
        : undefined,
      status: value ? "present" : "empty",
    };
  } catch (error) {
    return {
      credential: undefined,
      status: fileProbeErrorReason(error),
      ...(error?.code ? { code: error.code } : {}),
    };
  }
}

export function resolveProviderCredential(providerOrId, options = {}) {
  const { persistent = false } = options;
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  if (provider?.id !== "openrouter") throw new Error("Only the OpenRouter credential is supported.");
  const stored = fileCredential(provider, options).credential;
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
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const stored = fileCredential(provider, options);
  const environmentValue = !options.persistent
    ? String(process.env.OPENROUTER_API_KEY || "").trim()
    : "";
  const resolved = stored.credential || (environmentValue
    ? { value: environmentValue, source: "environment (OPENROUTER_API_KEY)", persistent: false }
    : undefined);
  return {
    configured: Boolean(resolved?.value),
    persistent: resolved?.persistent === true,
    source: resolved?.source,
    fileStatus: stored.status,
    ...(stored.code ? { code: stored.code } : {}),
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
