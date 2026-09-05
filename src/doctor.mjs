import path from "node:path";
import { fileURLToPath } from "node:url";

import { codexAuthStatus, codexVersion, findCodexBinary } from "./codex-binary.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { routedCatalogConfigured } from "./catalog.mjs";
import { readControlHealth } from "./control-health.mjs";
import { providerSelectionStatus, selectedConfiguredListedModels } from "./provider-selection.mjs";
import { MODEL_BY_SLUG, PROVIDERS } from "./routed-models.mjs";
import { credentialStatus, primaryCredentialPath } from "./provider-credentials.mjs";
import { switchyardRuntimeStatus } from "./switchyard-runtime.mjs";
import { interpretWindowsTaskState, windowsScheduledTaskState } from "./windows-task-state.mjs";

const checks = [];
const add = (status, name, detail, fix) => checks.push({ status, name, detail, ...(fix ? { fix } : {}) });

export async function diagnose() {
  checks.length = 0;
  const binary = findCodexBinary();
  add(binary ? "ok" : "fail", "Codex binary", binary || "not found", "Install or update the Windows Codex app.");
  add(binary ? "ok" : "warn", "Codex version", binary ? codexVersion() : "unavailable");
  const auth = codexAuthStatus();
  add(
    auth.authenticated ? "ok" : auth.reason === "access-denied" ? "fail" : "warn",
    "Native Codex authentication",
    auth.authenticated ? "signed in" : auth.reason || "not signed in",
  );

  const openRouterRoutes = [...MODEL_BY_SLUG.values()].filter((model) => model.provider === "openrouter");
  const credential = credentialStatus("openrouter", { persistent: true });
  const credentialPath = primaryCredentialPath(PROVIDERS.get("openrouter"));
  const protectedCredential = credential.configured
    ? privateFileIsProtected(credentialPath)
    : false;
  const credentialDenied = credential.fileStatus === "access-denied" || credential.fileStatus === "probe-failed";
  add(
    credentialDenied ? "fail" : credential.configured && protectedCredential ? "ok" : credential.configured ? "fail" : "warn",
    "OpenRouter GLM credential",
    credentialDenied
      ? `credential file access denied or probe failed${credential.code ? ` (${credential.code})` : ""}`
      : credential.configured
        ? (protectedCredential ? "protected local file" : "credential file is not protected")
        : "not configured",
    credentialDenied
      ? `Inspect ownership and ACLs on ${credentialPath}; do not replace the credential to mask an access failure.`
      : "Run .\\model-router.ps1 provider-key openrouter set.",
  );

  for (const route of openRouterRoutes) {
    const policy = route.openRouterProviderPolicy;
    add(
      "ok",
      `OpenRouter provider policy (${route.slug})`,
      `${policy.only[0]}; exact endpoint; fallback disabled`,
    );
  }

  const switchyard = switchyardRuntimeStatus();
  add(
    switchyard.ready ? "ok" : switchyard.inaccessible.length ? "fail" : "warn",
    "Switchyard runtime",
    switchyard.ready
      ? switchyard.binary
      : switchyard.inaccessible.length
        ? `access denied or probe failed (${switchyard.inaccessible.map(({ target }) => target).join(", ")})`
        : `not installed (${[...switchyard.missing, ...switchyard.invalid].join(", ")})`,
  );

  if (process.platform === "win32") {
    const task = interpretWindowsTaskState(await windowsScheduledTaskState());
    add(task.healthy === true ? "ok" : "warn", "Windows scheduled task", task.detail);
  }

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
