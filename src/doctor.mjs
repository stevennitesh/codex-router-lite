import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { codexAuthStatus, codexVersion, findCodexBinary } from "./codex-binary.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { routedCatalogConfigured } from "./catalog.mjs";
import { readControlHealth } from "./control-health.mjs";
import { providerSelectionStatus, selectedConfiguredListedModels } from "./provider-selection.mjs";
import { MODEL_BY_SLUG, PROVIDERS } from "./routed-models.mjs";
import { primaryCredentialPath, resolveProviderCredential } from "./provider-credentials.mjs";
import { switchyardRuntimeStatus } from "./switchyard-runtime.mjs";

const checks = [];
const add = (status, name, detail, fix) => checks.push({ status, name, detail, ...(fix ? { fix } : {}) });

async function diagnose() {
  const binary = findCodexBinary();
  add(binary ? "ok" : "fail", "Codex binary", binary || "not found", "Install or update the Windows Codex app.");
  add(binary ? "ok" : "warn", "Codex version", binary ? codexVersion() : "unavailable");
  const auth = codexAuthStatus();
  add(auth.authenticated ? "ok" : "warn", "Native Codex authentication", auth.authenticated ? "signed in" : auth.reason || "not signed in");

  const openRouter = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");
  const credential = resolveProviderCredential("openrouter", { persistent: true });
  const credentialPath = primaryCredentialPath(PROVIDERS.get("openrouter"));
  const protectedCredential = credential?.value && existsSync(credentialPath)
    ? privateFileIsProtected(credentialPath)
    : false;
  add(
    credential?.value && protectedCredential ? "ok" : credential?.value ? "fail" : "warn",
    "OpenRouter GLM credential",
    credential?.value ? (protectedCredential ? "protected local file" : "credential file is not protected") : "not configured",
    "Run .\\model-router.ps1 provider-key openrouter set.",
  );

  const policy = openRouter.openRouterProviderPolicy;
  const endpoint = policy.only[0];
  add(
    "ok",
    "OpenRouter provider policy",
    `${endpoint}; exact endpoint; fallback disabled`,
  );

  const switchyard = switchyardRuntimeStatus();
  add(
    switchyard.ready ? "ok" : "warn",
    "Switchyard runtime",
    switchyard.ready ? switchyard.binary : `not installed (${switchyard.missing.join(", ")})`,
  );

  const selected = providerSelectionStatus();
  add("ok", "Routed providers", selected.providers.join(", ") || "none selected");
  add(
    routedCatalogConfigured() ? "ok" : "warn",
    "Codex routed catalog",
    routedCatalogConfigured() ? "configured" : "not configured",
  );
  const models = selectedConfiguredListedModels().map((model) => model.slug);
  add("ok", "Published routed models", models.join(", ") || "none");

  try {
    const health = await readControlHealth();
    add(health?.status === "ok" || health?.ok === true ? "ok" : "warn", "Router runtime", health?.status || (health?.ok ? "ok" : "unavailable"));
  } catch (error) {
    add("warn", "Router runtime", error instanceof Error ? error.message : String(error));
  }
  return checks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--fix")) {
    console.error("This reduced doctor is diagnostic-only; use install.ps1 for an authorized repair.");
    process.exitCode = 2;
  } else {
    const results = await diagnose();
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    else for (const check of results) process.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
    if (results.some((check) => check.status === "fail")) process.exitCode = 1;
  }
}
