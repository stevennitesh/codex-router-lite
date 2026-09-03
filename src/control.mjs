import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickerCommandArgs } from "./control-args.mjs";
import { readControlHealth } from "./control-health.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { chatGptSessionStatus, setChatGptSessionSharingFromControl } from "./chatgpt-session-control.mjs";
import {
  activateAntigravityProbe,
  discoveryDisabled,
  importIssue5ControlProviderModule,
  issue5ControlWorkerScript,
  USER_MODELS_PATH,
} from "./compat/retirement/issue5-control-provider-features.mjs";
import { PROVIDER_API_KEY_POOL_PATH, PROVIDER_CREDENTIAL_STORE_PATH, PROVIDER_SELECTION_PATH } from "./paths.mjs";
import { refreshTargetPickerIfInstalled } from "./target-integration.mjs";
import {
  boundedOperationChild,
  detachedOperationEnvironment,
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runOperationProcessTree,
} from "./process-tree.mjs";
import { inheritedProxyEnvironment } from "./proxy-environment.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";

// Restore the installed proxy decision before a network client builds its
// dispatcher so OAuth and provider refresh use the same connection path.
const restoredProxyEnvironment = inheritedProxyEnvironment();
for (const [name, value] of Object.entries(restoredProxyEnvironment)) {
  process.env[name] = value;
}
installStableFetchTransport();

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const TARGETS = ["codex"];
const args = process.argv.slice(2);
const boundedAntigravityOperation =
  (args[0] === "login" && args[1] === "antigravity-oauth") ||
  (args[0] === "probe-provider" && args[1] === "antigravity-oauth");
const restartBearingOverlayOperation = new Set([
  "set-apply",
  "credential",
  "auth-mode",
  "subagents",
  "picker",
  "vision-bridge",
  "local-models",
  "signed-routing",
]).has(args[0]);
const selfReplacingControl = args[0] === "maintenance";
// Restart-bearing overlay transactions may use two complete 640-second
// forward/rollback epochs. The control owner retains another ten seconds to
// retire the inner process tree before a desktop watchdog may intervene.
const maximumControlOperationMs = boundedAntigravityOperation
  ? 610_000
  : restartBearingOverlayOperation
    ? 1_310_000
    : 850_000;
if (!selfReplacingControl && !boundedOperationChild(process.env, {
  maximumMs: maximumControlOperationMs,
})) {
  // Every ordinary control invocation enters one separately terminable tree.
  // Its owner gets ten seconds beyond the cooperative child budget so it can
  // escalate a full process-group termination. Catalog desktop watchdogs keep
  // another ten seconds outside this boundary; shorter ordinary operations
  // retain the larger margin chosen by their UI runner.
  const deadline = operationDeadlineFromEnvironment(process.env, {
    timeoutMs: maximumControlOperationMs,
    maximumMs: maximumControlOperationMs,
  });
  const result = await runOperationProcessTree(process.execPath, [SELF, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    childEnvironment: {
      CODEX_ROUTER_OPERATION_CHILD: "1",
    },
    deadline,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function targetIsActive() {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src", "service.mjs"), "status"], { encoding: "utf8" });
  try {
    const status = JSON.parse(result.stdout);
    return Boolean(status.installed || status.loaded);
  } catch {
    return false;
  }
}
function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requestedControlTargets() {
  const requested = optionValue("--targets");
  if (requested && requested !== "codex") throw new Error("Only the codex target is supported.");
  return TARGETS;
}

async function emitProbeSet(provider, desired) {
  const { disableProvider, enableProvider } = await importIssue5ControlProviderModule("./provider-selection.mjs");
  const { PROVIDERS } = await importIssue5ControlProviderModule("./model-registry.mjs");
  if (!PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider}`);
  if (desired !== "on" && desired !== "off") throw new Error("state must be on or off");
  const next = desired === "on" ? enableProvider(provider) : disableProvider(provider);
  process.stdout.write(JSON.stringify({ target: "codex", enabledProviders: next }));
}

function setProviderSelectionForTargets(provider, desired, selected) {
  for (const target of selected) {
    const result = spawnSync(process.execPath, [SELF, "--probe-set", provider, desired], {
      env: { ...process.env, MODEL_ROUTER_TARGET: target },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`${target}: ${(result.stderr || "").trim() || "toggle failed"}`);
    }
  }
}

async function runSet(provider, desired) {
  // The child performs the read/modify/write, so the parent holds the shared
  // model-overlay lock around the update.
  const selected = requestedControlTargets();
  await withModelOverlayLock(() => setProviderSelectionForTargets(provider, desired, selected));
  process.stderr.write(
    `Set ${provider} ${desired} for: ${selected.join(", ")}. Run \`bin/control apply\` to make it live.\n`,
  );
}

function refreshActiveTarget() {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src", "catalog.mjs")], {
    env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("codex: refresh failed");
}

// Active routers read provider selection on each request, so only the Codex
// catalog needs refreshing. The full enable path is reserved for an inactive install.
async function applyProviderSelectionForTargets(selected, { activate = false } = {}) {
  const applied = [];
  const skipped = [];
  for (const target of selected) {
    if (!targetIsActive(target) && !activate) {
      skipped.push(target);
      continue;
    }
    if (targetIsActive(target)) {
      refreshActiveTarget(target);
    } else {
      const { currentCheckoutInstaller } = await import("./update.mjs");
      const enable = currentCheckoutInstaller("win32", "codex");
      const result = spawnSync(enable.command, enable.args, {
        cwd: REPO_ROOT,
        env: { ...process.env, MODEL_ROUTER_TARGET: target },
        stdio: "inherit",
      });
      if (result.status !== 0) throw new Error(`${target}: apply failed`);
    }
    applied.push(target);
  }
  return { applied, skipped };
}

async function runApply() {
  // Publication is the second half of the same transaction as the provider
  // selection write. Hold the model lock while the catalog child takes its
  // own inner catalog lock (model -> catalog is the sole lock ordering).
  const selected = requestedControlTargets();
  const result = await withModelOverlayLock(() => applyProviderSelectionForTargets(
    selected,
    { activate: args.includes("--activate") },
  ));
  process.stderr.write(
    `Applied: ${result.applied.join(", ") || "none"}. ` +
      `Skipped (not active): ${result.skipped.join(", ") || "none"}.\n`,
  );
}

// Holding one model-overlay transaction across both operations prevents a
// failed publication from restoring a snapshot taken before another process's
// successful selection change. Rollback restores the selection and republishes
// it before the lock is released.
async function runSetApply(provider, desired) {
  const selected = requestedControlTargets();
  const activate = args.includes("--activate");
  let publication;
  await transactModelOverlayMutation({
    files: [PROVIDER_SELECTION_PATH],
    mutate: () => setProviderSelectionForTargets(provider, desired, selected),
    // Selection belongs to the shared router plane. Republish every installed
    // client even when the initiating UI named only its own target.
    applyPublication: async () => {
      publication = await applyProviderSelectionForTargets(TARGETS, { activate });
      return publication;
    },
  });
  process.stderr.write(
    `Set ${provider} ${desired} for: ${selected.join(", ")}. ` +
      `Applied: ${publication.applied.join(", ") || "none"}. ` +
      `Skipped (not active): ${publication.skipped.join(", ") || "none"}.\n`,
  );
}

async function printAccountUsage() {
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
  const { readCodexAccountUsage } = await importIssue5ControlProviderModule("./codex-account-usage.mjs");
  const {
    ensureChatGPTProfileAccounts,
    selectedChatGPTUsageProfile,
  } = await importIssue5ControlProviderModule("./chatgpt-profile-switch.mjs");
  await ensureChatGPTProfileAccounts();
  const profile = selectedChatGPTUsageProfile();
  const usage = profile.home
    ? await readCodexAccountUsage({ codexHome: profile.home })
    : await readCodexAccountUsage();
  process.stdout.write(`${JSON.stringify({
    ...usage,
    accountSelection: profile.selection,
    accountEmail: profile.email || null,
    profilePending: profile.pending === true,
  }, null, 2)}\n`);
}

async function printProviderUsage() {
  const { providerUsageSnapshot } = await importIssue5ControlProviderModule("./provider-usage.mjs");
  process.stdout.write(`${JSON.stringify(await providerUsageSnapshot(), null, 2)}\n`);
}

async function printProviderOnboarding() {
  const { providerOnboardingSnapshot } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot(), null, 2)}\n`);
}

async function handleGenericProviders(...commandArgs) {
  // The control center and the provider CLI must cross the same publication
  // boundary. Calling the descriptor CRUD layer directly here can leave a
  // running route and every installed client's picker on the pre-mutation
  // registry until some unrelated later apply.
  const { runGenericCommand } = await importIssue5ControlProviderModule("./providers.mjs");
  await runGenericCommand(commandArgs);
}

async function installProviderCli(providerId) {
  const { installOauthCli, providerOnboardingSnapshot } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
  installOauthCli(providerId);
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function loginProvider(providerId) {
  const { loginOauthProvider, providerOnboardingSnapshot } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
  const deadline = operationDeadlineFromEnvironment(process.env, {
    timeoutMs: 10 * 60_000,
    maximumMs: 10 * 60_000,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("Provider sign-in exceeded its absolute deadline.");
    error.code = "router_operation_timeout";
    controller.abort(error);
  }, remainingOperationMs(deadline));
  timer.unref?.();
  try {
    await loginOauthProvider(providerId, { signal: controller.signal, deadline });
  } finally {
    clearTimeout(timer);
  }
  if (providerId === "antigravity-oauth") {
    // A re-login intentionally clears the previous live proof. Republish now
    // so installed clients cannot keep advertising the route while it is in
    // that fail-closed state; the provider selection itself is preserved.
    await withModelOverlayLock(() => refreshTargetPickerIfInstalled());
  }
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function probeProvider(providerId, flags) {
  if (providerId !== "antigravity-oauth") {
    throw new Error("Only antigravity-oauth has a router-managed live compatibility probe.");
  }
  const allowed = new Set(["--live", "--yes", "--provision-project"]);
  const unknown = flags.find((flag) => !allowed.has(flag));
  if (unknown) {
    throw new Error(
      `Unknown Antigravity probe option: ${unknown}. ` +
        "Usage: control probe-provider antigravity-oauth --live --yes [--provision-project]",
    );
  }
  const { probeAntigravity } = await importIssue5ControlProviderModule("./antigravity-oauth-probe.mjs");
  const { forgetProviderCatalogFamilyCache } = await importIssue5ControlProviderModule("./provider-catalogs.mjs");
  const deadline = operationDeadlineFromEnvironment(process.env, {
    timeoutMs: 10 * 60_000,
    maximumMs: 10 * 60_000,
  });
  const operationTimeoutMs = remainingOperationMs(deadline);
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => {
    const error = new Error(
      "Antigravity probe activation timed out before the live request, service readiness, and publication completed.",
    );
    error.code = "antigravity_activation_timeout";
    controller.abort(error);
  }, operationTimeoutMs);
  deadlineTimer.unref?.();
  const remainingLockWaitMs = (operationDeadline) =>
    Math.max(0, Math.min(120_000, operationDeadline - Date.now()));
  const refreshInstalledClients = ({
    signal = controller.signal,
    deadline: operationDeadline = deadline,
  } = {}) => withModelOverlayLock(async () => {
    signal?.throwIfAborted();
    await forgetProviderCatalogFamilyCache(providerId);
    signal?.throwIfAborted();
    return refreshTargetPickerIfInstalled({ signal, deadline: operationDeadline });
  }, { waitMs: remainingLockWaitMs(operationDeadline) });
  try {
    await activateAntigravityProbe({
      probe: probeAntigravity,
      probeOptions: {
        live: flags.includes("--live"),
        confirmed: flags.includes("--yes"),
        allowOnboard: flags.includes("--provision-project"),
      },
      withdraw: refreshInstalledClients,
      restart: restartRouterForLocalRoutes,
      publish: refreshInstalledClients,
      signal: controller.signal,
      deadline,
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
  const { providerOnboardingSnapshot } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function invalidateProviderCatalog(providerId) {
  const { providerOnboardingSnapshot } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
  const provider = providerOnboardingSnapshot().providers.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const { forgetProviderCatalogFamilyCache } = await importIssue5ControlProviderModule("./provider-catalogs.mjs");
  const cleared = await forgetProviderCatalogFamilyCache(providerId);
  process.stdout.write(`${JSON.stringify({ provider: providerId, cleared })}\n`);
}

async function readSecretFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("The provider credential is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function saveProviderCredential(providerId) {
  const { providerOnboardingSnapshot, saveApiCredential } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
  const value = await readSecretFromStdin();
  // The control-center sends this command before it refreshes its provider
  // snapshot. Keep credential persistence, selection, and target publication
  // together so a concurrent remove cannot create an enabled credentialless
  // provider between the child processes.
  await withModelOverlayLock(async () => {
    const { withProviderCatalogCacheTransaction } = await importIssue5ControlProviderModule("./model-catalog-cache.mjs");
    const { providerCatalogFamilyCacheIds } = await importIssue5ControlProviderModule("./provider-catalogs.mjs");
    await withProviderCatalogCacheTransaction((catalog) => {
      saveApiCredential(providerId, value);
      // One credential can expose several account catalogs. The same lock
      // discovery uses for snapshot+commit makes write+invalidation one
      // generation boundary rather than a race with an old in-flight fetch.
      catalog.forget(providerCatalogFamilyCacheIds(providerId));
    });
    const { enableProvider } = await importIssue5ControlProviderModule("./provider-selection.mjs");
    enableProvider(providerId);
    const { refreshTargetPickerIfInstalled } = await import("./target-integration.mjs");
    await refreshTargetPickerIfInstalled();
  });
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function deleteProviderCredential(providerId) {
  const { providerOnboardingSnapshot, removeApiCredential } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
  // Removing a managed credential also withdraws its provider selection. Keep
  // that low-level write under the same cross-process lock as the picker and
  // local-model mutations; status reads remain outside the lock.
  let removal;
  await withModelOverlayLock(async () => {
    const { withProviderCatalogCacheTransaction } = await importIssue5ControlProviderModule("./model-catalog-cache.mjs");
    const { providerCatalogFamilyCacheIds } = await importIssue5ControlProviderModule("./provider-catalogs.mjs");
    removal = await withProviderCatalogCacheTransaction(async (catalog) => {
      const result = await removeApiCredential(providerId);
      if (result.removedFiles) catalog.forget(providerCatalogFamilyCacheIds(providerId));
      return result;
    });
    if (removal.removedFiles || providerId === "antigravity-oauth") {
      const { refreshTargetPickerIfInstalled } = await import("./target-integration.mjs");
      await refreshTargetPickerIfInstalled();
    }
  });
  process.stdout.write(
    `${JSON.stringify({ ...providerOnboardingSnapshot(), removal })}\n`,
  );
}

async function handleProviderKeyPool(providerId, action, value) {
  const {
    addEnvironmentCredentialToPool,
    addStoredCredentialToPool,
    deleteStoredCredentialPool,
    removeStoredCredentialFromPool,
    setStoredCredentialPoolPolicy,
    setStoredCredentialPoolState,
    storedCredentialPoolUsesServiceEnvironment,
    storedCredentialRequiresServiceEnvironment,
    storedCredentialPoolStatus,
  } = await importIssue5ControlProviderModule("./provider-api-key-control.mjs");
  if (!action || action === "status") {
    // Status is deliberately lock-free and read-only. It must remain usable
    // while a catalog publication is slow or recovering an abandoned owner.
    process.stdout.write(`${JSON.stringify(storedCredentialPoolStatus(providerId), null, 2)}\n`);
    return;
  }
  let mutation;
  if (action === "add" && value) {
    mutation = () => addStoredCredentialToPool(providerId, value);
  } else if (action === "add-env" && value) {
    mutation = () => addEnvironmentCredentialToPool(providerId, value);
  } else if (action === "remove" && value) {
    mutation = () => removeStoredCredentialFromPool(providerId, value);
  } else if (action === "delete" && !value) {
    mutation = () => deleteStoredCredentialPool(providerId);
  } else if ((action === "pause" || action === "resume") && value) {
    mutation = () => setStoredCredentialPoolState(providerId, value, action === "pause");
  } else if (action === "policy" && value) {
    mutation = () => setStoredCredentialPoolPolicy(providerId, value);
  } else {
    throw new Error("Usage: control key-pool <provider> status|add|add-env|remove|delete|pause|resume|policy [credential-id|environment-name|strategy]");
  }
  const addition = action === "add" || action === "add-env";
  const removal = action === "remove" || action === "delete";
  let environmentBacked = false;
  let serviceEnvironmentStatus;
  let result;
  // Pool readiness decides whether this provider's models are routable. Treat
  // its two metadata files, the gateway, and every installed client as one
  // publication: a failed rebuild restores the exact previous pool/store and
  // republishes that state rather than leaving a half-adopted credential.
  const transact = (lock = true) => transactModelOverlayMutation({
    files: [PROVIDER_API_KEY_POOL_PATH, PROVIDER_CREDENTIAL_STORE_PATH],
    mutate: async () => { result = await mutation(); },
    lock,
  });
  if (addition || removal) {
    // Classify against the same pool/store generation the transaction will
    // change. In particular, a concurrent pause/remove must not turn an opaque
    // remove id from environment-backed into apparently ordinary metadata.
    await withModelOverlayLock(async () => {
      environmentBacked = action === "add-env" || (
        action === "add" && storedCredentialRequiresServiceEnvironment(providerId, value)
      ) || (
        removal && storedCredentialPoolUsesServiceEnvironment(providerId, {
          ...(action === "remove" ? { credentialId: value } : {}),
        })
      );
      if (!environmentBacked) {
        await transact(false);
        return;
      }

      // Keep lock ordering consistent with model-overlay operations that
      // restart the service: publication ownership first, service ownership
      // second. The service lock stays held through publication, serializing
      // both a new variable and removal of a retired one with service renders.
      const { withServiceOperationLock } = await import("./service-operation-lock.mjs");
      await withServiceOperationLock(async () => {
        const {
          environmentPoolMutationServiceStatus,
          routerServiceStatus,
        } = await import("./router-restart.mjs");
        serviceEnvironmentStatus = addition
          ? await environmentPoolMutationServiceStatus()
          : await routerServiceStatus();
        await transact(false);
      });
    });
  } else {
    await transact();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (environmentBacked) {
    if (removal) {
      const { environmentPoolRemovalReminder } = await import("./router-restart.mjs");
      process.stderr.write(environmentPoolRemovalReminder(serviceEnvironmentStatus));
    } else {
      process.stderr.write(
        serviceEnvironmentStatus.serviceReinstallRequired
          ? "Environment-backed pool entry staged. Rerun the installer from this same environment; a service restart alone will not persist the variable.\n"
          : "Environment-backed pool entry registered. Start the foreground router from this environment, or install the managed service from it.\n",
      );
    }
  }
}

async function setLoginFreeMode(desired) {
  if (desired !== "on" && desired !== "off") {
    throw new Error("Usage: control auth-mode <on|off>");
  }
  let loginFreeModel;
  if (desired === "on") {
    const { providerOnboardingSnapshot } = await importIssue5ControlProviderModule("./provider-onboarding.mjs");
    const { readProviderSelection, selectedListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
    const { MODEL_BY_SLUG } = await importIssue5ControlProviderModule("./model-registry.mjs");
    const { readNativeAliases } = await import("./native-alias.mjs");
    const selected = new Set(readProviderSelection());
    const readyProviders = new Set(
      providerOnboardingSnapshot().providers
        .filter((provider) => selected.has(provider.id) && provider.configured)
        .map((provider) => provider.id),
    );
    if (readyProviders.size === 0) {
      throw new Error(
        "Connect and enable at least one external provider before turning on login-free mode.",
      );
    }
    const currentModel = codexConfigSnapshot()?.model;
    const currentRoute =
      MODEL_BY_SLUG.get(currentModel) ??
      MODEL_BY_SLUG.get(readNativeAliases()[currentModel]);
    loginFreeModel =
      currentRoute && readyProviders.has(currentRoute.provider)
        ? currentRoute.slug
        : selectedListedModels().find((model) => readyProviders.has(model.provider))?.slug;
    if (!loginFreeModel) {
      throw new Error("No enabled model is available for the connected external providers.");
    }
  }
  const catalog = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "catalog.mjs")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_LOGIN_FREE: desired === "on" ? "1" : "0",
      },
      encoding: "utf8",
    },
  );
  if (catalog.status !== 0) {
    throw new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim());
  }
  if (loginFreeModel) {
    const { nativeAliasFor } = await import("./native-alias.mjs");
    loginFreeModel = nativeAliasFor(loginFreeModel) || loginFreeModel;
  }
  const command = desired === "on" ? "login-free-enable" : "login-free-disable";
  const commandArgs = [path.join(REPO_ROOT, "src", "config-manager.mjs"), command];
  if (loginFreeModel) commandArgs.push(loginFreeModel);
  const result = spawnSync(
    process.execPath,
    commandArgs,
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || "Codex provider mode could not be changed.").trim());
  }
  process.stdout.write(result.stdout);
}

async function setSignedRouting(desired) {
  if (desired !== "on" && desired !== "off") {
    throw new Error("Usage: control signed-routing <on|off>");
  }
  if (desired === "on") {
    const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
    if (selectedConfiguredListedModels().length === 0) {
      throw new Error(
        "Connect and enable at least one external provider before turning on signed routing.",
      );
    }
  }
  const command = desired === "on" ? "signed-enable" : "signed-disable";
  const runConfig = (configCommand = command) => spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "config-manager.mjs"), configCommand],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  const runCatalog = (routing = desired, { allowTestFault = true } = {}) => {
    const environment = {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_SIGNED_ROUTING: routing === "on" ? "1" : "0",
    };
    if (!allowTestFault) delete environment.MODEL_ROUTER_TEST_FAIL_AFTER_CATALOG_WRITE;
    return spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "src", "catalog.mjs")],
      {
      cwd: REPO_ROOT,
      env: environment,
      encoding: "utf8",
      },
    );
  };
  // Enabling routes the transport first, so a partially completed operation
  // can only hide external models. Disabling hides them first, so they can
  // never escape through the restored direct provider endpoint.
  let result;
  let catalog;
  if (desired === "on") {
    result = runConfig();
    if (result.status === 0) catalog = runCatalog();
  } else {
    catalog = runCatalog();
    if (catalog.status === 0) result = runConfig();
  }
  if (result && result.status !== 0) {
    throw new Error((result.stderr || "Signed router mode could not be changed.").trim());
  }
  if (catalog.status !== 0) {
    if (desired === "on") {
      // A catalog process can fail after replacing one of its files. Before
      // restoring the user's direct provider, prove that a clean native-only
      // rebuild succeeds. If it does not, keep the signed router transport in
      // place: external entries against the router are safer than sending one
      // through a provider endpoint we no longer own.
      const safeCatalog = runCatalog("off", { allowTestFault: false });
      if (safeCatalog.status !== 0) {
        throw new AggregateError(
          [
            new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim()),
            new Error((safeCatalog.stderr || "The native-only rollback catalog failed.").trim()),
          ],
          "Signed routing remains active because the catalog could not be rolled back safely.",
        );
      }
      const rollback = runConfig("signed-disable");
      if (rollback.status !== 0) {
        throw new AggregateError(
          [
            new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim()),
            new Error((rollback.stderr || "Signed router configuration rollback failed.").trim()),
          ],
          "The catalog was made native-only, but signed router configuration could not be restored.",
        );
      }
    }
    throw new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim());
  }
  if (!result) {
    throw new Error("Signed router mode could not be changed.");
  }
  process.stdout.write(result.stdout);
}

async function setLoginFreeModel(slug) {
  const value = String(slug || "").trim();
  if (!value) throw new Error("Usage: control model-set <model-slug>");
  const config = codexConfigSnapshot();
  if (!config?.login_free) {
    throw new Error("Switching the default model requires login-free mode.");
  }
  const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
  if (!selectedConfiguredListedModels().some((model) => model.slug === value)) {
    throw new Error(`${value} is not an enabled, authenticated external model.`);
  }
  const { nativeAliasFor } = await import("./native-alias.mjs");
  const configModel = nativeAliasFor(value) || value;
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "config-manager.mjs"), "login-free-enable", configModel],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || "The Codex model could not be changed.").trim());
  }
  process.stdout.write(result.stdout);
}

async function setRouterDefault(action, slug) {
  if (!["set", "clear"].includes(action)) {
    throw new Error("Usage: control router-default <set MODEL|clear>");
  }
  let value;
  if (action === "set") {
    value = String(slug || "").trim();
    if (!value) throw new Error("Usage: control router-default set MODEL");
    const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
    if (!selectedConfiguredListedModels().some((model) => model.slug === value)) {
      throw new Error(`${value} is not an enabled, authenticated external model.`);
    }
    const { modelPickerSnapshot } = await import("./model-picker-state.mjs");
    const picker = modelPickerSnapshot();
    const visible = picker.hasExplicitVisibility
      ? picker.visible.includes(value)
      : !picker.hidden.includes(value);
    if (!visible) {
      throw new Error(`${value} is not selected for the model picker. Show it before making it default.`);
    }
  }
  const command = action === "set" ? "router-default-set" : "router-default-clear";
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "config-manager.mjs"), command, ...(value ? [value] : [])],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || "The Codex router default could not be changed.").trim());
  }
  process.stdout.write(result.stdout);
}

async function updateAndVerifyCodex() {
  const { runCodexMaintenance } = await import("./codex-maintenance.mjs");
  process.stdout.write(`${JSON.stringify(runCodexMaintenance())}\n`);
}

function runDoctor(args) {
  const json = args.includes("--json");
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "doctor.mjs"), ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      stdio: json ? ["inherit", "pipe", "pipe"] : "inherit",
      ...(json ? { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 } : {}),
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (json) {
      try {
        const report = JSON.parse(String(result.stdout || ""));
        const failed = Array.isArray(report?.checks)
          ? report.checks.filter((check) => check.status === "fail").map((check) => check.name)
          : [];
        if (failed.length) throw new Error(`Doctor found problems: ${failed.join(", ")}.`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Doctor found problems:")) throw error;
      }
    }
    throw new Error(
      (result.stderr || "The Codex doctor could not finish.").trim(),
    );
  }
  if (json) {
    try {
      const report = JSON.parse(String(result.stdout || ""));
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } catch {
      throw new Error("The Codex doctor returned an unreadable report.");
    }
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

async function refreshModelSettingsCatalog() {
  // The router owns the model policy.  Rebuilding only merged-models.json
  // leaves a published DSH route with the previous picker state (and makes
  // Gemini look different again at its next process start).  The target
  // integration helper refreshes every installed client from this same state,
  // while preserving the Codex-only native catalog capture where applicable.
  try {
    return refreshTargetPickerIfInstalled();
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "The router model catalogs could not be refreshed.",
    );
  }
}

async function restartRouterForLocalRoutes({ signal, deadline } = {}) {
  // User-model routes live in files the running router only reads at startup,
  // so a local model toggle needs the same service reload curated-model apply
  // performs. Foreground/dev routers have no service and are skipped.
  const { restartRouterServiceIfInstalled } = await import("./router-restart.mjs");
  signal?.throwIfAborted();
  const restarted = await restartRouterServiceIfInstalled({ signal, deadline });
  signal?.throwIfAborted();
  if (restarted) {
    process.stderr.write("Router service restarted so routes with fresh process state are live.\n");
  }
  return restarted;
}

async function finalizeLocalModelPublication() {
  // Finalization runs in a separate process after a detached uninstall worker
  // has removed the weights. It still needs the same lock as a full mutation,
  // or it could publish a snapshot between another operation's state write and
  // its catalog publication.
  return withModelOverlayLock(() => applyModelOverlayPublication({
    warningOnly: true,
    restart: true,
    restartService: restartRouterForLocalRoutes,
  }));
}

// What this model says it supports, read from the merged catalog Codex reads
// so the answer matches what would actually be sent. An empty list means the
// catalog could not be read, and the caller treats that as "do not block".
async function modelReasoningLevels(slug) {
  try {
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    const entry = (parsed.models || []).find((model) => String(model.slug) === slug);
    const levels = entry?.supported_reasoning_levels;
    if (!Array.isArray(levels)) return [];
    return levels
      .map((level) => (typeof level === "string" ? level : level?.effort))
      .filter((level) => typeof level === "string" && level);
  } catch {
    return [];
  }
}

async function knownModelSlug(slug) {
  try {
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    if (
      Array.isArray(parsed.models) &&
      parsed.models.some((model) => String(model.slug) === slug)
    ) {
      return true;
    }
  } catch {
    // Fall back to the checked-in registry for fresh installs.
  }
  const { MODEL_BY_SLUG } = await importIssue5ControlProviderModule("./model-registry.mjs");
  return MODEL_BY_SLUG.has(slug);
}

async function knownModelSubagentVersion(slug) {
  // Routed-model certification belongs to the registry. The merged Codex
  // catalog deliberately serializes an unknown route as conservative v1, so
  // consulting it first would mislabel every still-uncertified route as a
  // reviewed v1 verdict and make the compatibility-test workflow unreachable.
  const { MODEL_BY_SLUG } = await importIssue5ControlProviderModule("./model-registry.mjs");
  const registryModel = MODEL_BY_SLUG.get(slug);
  if (registryModel) return registryModel.multiAgentVersion;

  // Native models do not live in the routed registry. Read their undemoted
  // capture before the merged catalog: a disabled certified route is
  // deliberately serialized there as v1, but the operator must still be able
  // to turn it back on. This helper also carries the repository-pinned Luna
  // certificate and the parent-only verdict for context variants.
  try {
    const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    const model = Array.isArray(parsed.models)
      ? parsed.models.find((candidate) => String(candidate?.slug) === slug)
      : undefined;
    // Finding the route is itself decisive: an omitted version is genuinely
    // unknown and must stay eligible for the compatibility workflow. Falling
    // through to the effective merged catalog would turn that unknown into
    // its conservative serialized v1 and make the UI's Test action fail.
    if (model) return nativeSubagentCertification(model);
  } catch {
    // Fall back to the merged catalog when the original capture is absent.
  }

  // Retain compatibility with installations that have a merged catalog but
  // no native capture. This is conservative: an effective v1 remains v1.
  try {
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    const model = Array.isArray(parsed.models)
      ? parsed.models.find((candidate) => String(candidate?.slug) === slug)
      : undefined;
    if (model?.multi_agent_version === "v1" || model?.multi_agent_version === "v2") {
      return model.multi_agent_version;
    }
  } catch {
    // A missing or damaged merged catalog proves no native v1/v2 verdict.
  }
  return undefined;
}

async function nativeCodexBaseSlugs() {
  const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
  if (!existsSync(NATIVE_CATALOG_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    return new Set(
      (Array.isArray(parsed.models) ? parsed.models : [])
        .map((model) => String(model?.slug || ""))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function handleSubagents(action, value, flag, rest = []) {
  const {
    replaceMultiAgentState,
    setMultiAgentMode,
    setMultiAgentModel,
    setSubagentEffort,
    setMultiAgentModels,
    subagentSettingsSnapshot,
  } = await import("./multi-agent-state.mjs");
  if (action === "status") {
    const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
    const { subagentAutoPolicySnapshot } = await importIssue5ControlProviderModule("./subagent-auto-policy.mjs");
    process.stdout.write(`${JSON.stringify({
      ...subagentSettingsSnapshot(),
      autoPolicies: subagentAutoPolicySnapshot(selectedConfiguredListedModels()),
    })}\n`);
    return;
  }
  if (action === "policy") {
    const [kind, selector, desired] = [value, flag, rest[2]];
    if (kind === "status" || !kind) {
      const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
      const { subagentAutoPolicySnapshot } = await importIssue5ControlProviderModule("./subagent-auto-policy.mjs");
      process.stdout.write(`${JSON.stringify(subagentAutoPolicySnapshot(selectedConfiguredListedModels()))}\n`);
      return;
    }
    if (!selector || !["on", "off"].includes(desired)) {
      throw new Error(
        "Usage: control subagents policy status|provider <provider-id> <on|off>|model <model-slug> <on|off>|family <name> <on|off>",
      );
    }
    const { setSubagentAutoPolicy, matchingSubagentAutoPolicyModels } = await importIssue5ControlProviderModule(
      "./subagent-auto-policy.mjs"
    );
    const policyState = setSubagentAutoPolicy(kind, selector, desired === "on");
    // Enabling a policy is explicit standing consent for its matching live
    // probes. Only models currently configured for this machine can spend it.
    if (desired === "on") {
      const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
      const matches = matchingSubagentAutoPolicyModels(
        selectedConfiguredListedModels().filter((model) => model.multiAgentVersion !== "v1"),
        policyState.policies,
      );
      const slugs = matches.map((model) => model.slug);
      if (slugs.length) {
        setMultiAgentModels(slugs, true);
        const { spawnDetachedVerification } = await importIssue5ControlProviderModule("./subagent-verify.mjs");
        spawnDetachedVerification(slugs);
      }
    }
    await refreshModelSettingsCatalog();
    process.stdout.write(`${JSON.stringify(policyState)}\n`);
    return;
  }
  if (action === "select-all") {
    replaceMultiAgentState({ mode: "all", enabled: [], disabled: [] });
  } else if (action === "unselect-all") {
    const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
    const { modelPickerSnapshot } = await import("./model-picker-state.mjs");
    const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
    const picker = modelPickerSnapshot();
    const hidden = new Set(picker.hidden);
    const visible = new Set(picker.visible);
    const visibleModels = [
      ...nativeCodexModels(NATIVE_CATALOG_PATH, hidden).map((model) => model.slug),
      ...selectedConfiguredListedModels()
        .filter((model) => !hidden.has(model.slug) && (
          !picker.hasExplicitVisibility || visible.has(model.slug)
        ))
        .map((model) => model.slug),
    ];
    replaceMultiAgentState({
      mode: "selected",
      enabled: [],
      disabled: visibleModels,
    });
  } else if (action === "mode") {
    setMultiAgentMode(value);
  } else if (action === "verify") {
    // Explicit re-research: probe the named slugs (or every enabled one) in
    // the foreground and print the verdicts. Spends ~2 live requests per
    // candidate on that model's own provider.
    const { verifySubagentCandidates } = await importIssue5ControlProviderModule("./subagent-verify.mjs");
    const targets = rest.filter(Boolean);
    const sweep = targets.length
      ? targets
      : subagentSettingsSnapshot().enabled;
    const verified = await verifySubagentCandidates(sweep, { force: targets.length > 0 });
    await refreshModelSettingsCatalog();
    process.stdout.write(`${JSON.stringify({ verified })}\n`);
    return;
  } else if (action === "certify") {
    // The whole five-check run, for one route or several. Unlike `verify`
    // above, whose two-request probe is diagnostic, a complete pass here
    // promotes the route on this machine. It spends real quota on each route's
    // own provider and on the native parent that delegates to it.
    //
    // The runs go in parallel because nothing about one route's checks touches
    // another's: separate credentials, separate ephemeral Codex homes,
    // separate application artifacts. What they do share is the proofs file
    // and the catalog, so the recording and the republish stay here, in one
    // process, after the fan-out -- two control processes racing
    // read-modify-write on the proofs file would silently drop a verdict.
    const slugs = [...new Set([value, ...rest].map((slug) => String(slug || "").trim()).filter(Boolean))];
    if (!slugs.length) throw new Error("Usage: control subagents certify <model-slug> [<model-slug> ...]");
    for (const slug of slugs) {
      if (!(await knownModelSlug(slug))) throw new Error(`Unknown model slug: ${slug}`);
    }
    const [
      { verifySubagentRoute, firstFailure, recordApplicationEvidence, runDeferred },
      { recordVerification, recordVerificationStarted, clearSubagentProof },
      { assertCallerSecret, callerBaseUrl },
      { CALLER_SECRET_PATH, PORTS },
      { findCodexBinary },
      { VERSION },
    ] = await Promise.all([
      import("./subagent-certify.mjs"),
      import("./subagent-proofs.mjs"),
      import("./caller-auth.mjs"),
      import("./paths.mjs"),
      import("./codex-binary.mjs"),
      import("./version.mjs"),
    ]);
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(CALLER_SECRET_PATH)) {
      throw new Error(
        "The local router caller key is missing; run ./bin/doctor --fix (.\\model-router.ps1 doctor --fix on Windows).",
      );
    }
    const secret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
    const codexBin = findCodexBinary();
    const baseUrl = callerBaseUrl(PORTS.router, secret);
    const { CODEX_HOME, MERGED_CATALOG_PATH } = await import("./paths.mjs");
    for (const slug of slugs) recordVerificationStarted(slug);
    const outcomes = await Promise.all(
      slugs.map(async (slug) => {
        try {
          return {
            slug,
            result: await verifySubagentRoute(slug, {
              baseUrl,
              secret,
              codexBin,
              codexHome: CODEX_HOME,
              catalogPath: MERGED_CATALOG_PATH,
              routerVersion: VERSION,
            }),
          };
        } catch (error) {
          // One route's crash is not a verdict on the others, and must not
          // reject the whole fan-out.
          return { slug, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const results = [];
    let promoted = false;
    for (const { slug, result, error } of outcomes) {
      if (!result) {
        recordVerification(slug, { checks: {}, routerVersion: VERSION, reason: error });
        results.push({ slug, certified: false, reason: error });
        continue;
      }
      // A run that only met a rate limit, an outage, or a missing entitlement
      // learned nothing about the route. Clearing the record leaves the switch
      // retryable instead of leaving "No" next to a model that was never
      // actually refused.
      if (!result.ok && runDeferred(result.checks)) {
        clearSubagentProof(slug);
        const detail = firstFailure(result.checks)?.detail;
        results.push({ slug, certified: false, deferred: true, reason: detail });
        continue;
      }
      recordVerification(slug, {
        checks: result.checks,
        routerVersion: VERSION,
        ...(result.ok ? {} : { reason: firstFailure(result.checks)?.detail }),
      });
      // A pass is evidence worth more than this machine. Filing it as a
      // v2_agent application is what lets a review promote the route for every
      // installer, so nobody -- including this operator on their next machine
      // -- pays to measure it again.
      let application;
      if (result.ok) {
        promoted = true;
        try {
          application = recordApplicationEvidence(slug, {
            checks: result.checks,
            routerVersion: VERSION,
            at: new Date().toISOString(),
          });
        } catch {
          // A read-only or relocated checkout must not turn a genuine pass
          // into a failure; the machine-local record already stands on its own.
        }
      }
      const failure = result.ok ? undefined : firstFailure(result.checks);
      results.push({
        slug,
        certified: result.ok,
        ...(application ? { application } : {}),
        ...(failure ? { failed: failure.check, failedLabel: failure.label, reason: failure.detail } : {}),
      });
    }
    // One republish for the whole fan-out, and only when something was
    // promoted: publication rewrites the merged catalog and the agents
    // directory, which is far too much work to repeat per failed route.
    if (promoted) await refreshModelSettingsCatalog();
    process.stdout.write(`${JSON.stringify({ results })}\n`);
    return;
  } else if (action === "set") {
    if (!["on", "off"].includes(flag)) {
      throw new Error("Usage: control subagents set <model-slug> <on|off>");
    }
    if (!(await knownModelSlug(value))) {
      throw new Error(`Unknown model slug: ${value}`);
    }
    if (flag === "on" && (await knownModelSubagentVersion(value)) === "v1") {
      throw new Error(
        `${value} is repository-certified v1 and cannot be enabled as a native v2 subagent.`,
      );
    }
    setMultiAgentModel(value, flag === "on");
    // Selection is the assignment: switching a model on hands it to the
    // compatibility probe. Detached, because this command answers a tray toggle
    // and cannot sit on a live network round-trip; the proofs snapshot shows
    // "checking" until the worker records a verdict and republishes.
    if (flag === "on") {
      const { spawnDetachedVerification } = await importIssue5ControlProviderModule("./subagent-verify.mjs");
      spawnDetachedVerification([value]);
    }
  } else if (action === "effort") {
    if (!(await knownModelSlug(value))) {
      throw new Error(`Unknown model slug: ${value}`);
    }
    const requested = String(flag || "").trim();
    // Validated against what this model advertises rather than a global list:
    // the ladders differ per model, and an effort the provider will reject is
    // better refused here, where the operator is watching, than mid-spawn.
    const levels = await modelReasoningLevels(value);
    if (requested && requested !== "default" && levels.length && !levels.includes(requested)) {
      throw new Error(
        `${value} does not support reasoning effort "${requested}". Supported: ${levels.join(", ")}`,
      );
    }
    setSubagentEffort(value, requested === "default" ? undefined : requested);
  } else if (action === "provider") {
    if (!["on", "off"].includes(flag)) {
      throw new Error("Usage: control subagents provider <provider-id> <on|off>");
    }
    const { canonicalProviderId, selectedConfiguredListedModels } = await importIssue5ControlProviderModule(
      "./provider-selection.mjs"
    );
    const provider = canonicalProviderId(String(value || "").trim());
    let slugs;
    if (provider === "openai") {
      const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
      slugs = nativeCodexModels(NATIVE_CATALOG_PATH)
        .filter((model) => model.subagentCertification !== "v1")
        .map((model) => model.slug);
    } else {
      slugs = selectedConfiguredListedModels()
        .filter(
          (model) =>
            canonicalProviderId(model.provider) === provider && model.multiAgentVersion !== "v1",
        )
        .map((model) => model.slug);
    }
    if (slugs.length === 0) {
      throw new Error(`No enabled models found for provider: ${value}`);
    }
    setMultiAgentModels(slugs, flag === "on");
    if (flag === "on") {
      const { spawnDetachedVerification } = await importIssue5ControlProviderModule("./subagent-verify.mjs");
      spawnDetachedVerification(slugs);
    }
  } else {
    throw new Error(
      "Usage: control subagents status|select-all|unselect-all|mode <all|selected|proven>|" +
        "set <model-slug> <on|off>|effort <model-slug> <level|default>|" +
        "provider <provider-id> <on|off>|verify [model-slug ...]|certify <model-slug>|" +
        "policy status|provider <provider-id> <on|off>|model <model-slug> <on|off>|family <name> <on|off>",
    );
  }
  await refreshModelSettingsCatalog();
  process.stdout.write(`${JSON.stringify(subagentSettingsSnapshot())}\n`);
}

const TOOL_RESULT_AGING_USAGE =
  "Usage: control tool-result-aging status|on|off|native <on|off>|ttl <days|off|default>|" +
  "purge [--yes] [--dry-run] [--expired]";

// Emptying the store deletes the only copy of bytes the model already saw, so
// the default is the report and not the deletion: an invocation without --yes
// says exactly what it would remove and removes nothing. --dry-run says the
// same thing on purpose rather than by omission, and outranks --yes so a
// wrapper that always passes consent can still preview.
//
// --expired removes only what the TTL has outlived. The store expires on the
// next write to it, so this is the same sweep run by hand: it is what an
// operator uses to reclaim a store that filled before the TTL existed, or one
// on an install where compaction is off and nothing is going to write again.
async function handleToolResultAgingPurge(flags) {
  const {
    describeRetentionAge,
    describeRetentionTtl,
    expireRetainedToolResults,
    formatRetentionBytes,
    purgeRetainedToolResults,
  } = await import("./tool-result-retention.mjs");
  const { retentionTtlMs } = await import("./tool-result-aging-state.mjs");
  const requested = new Set(flags);
  const previewOnly = requested.has("--dry-run") || !(requested.has("--yes") || requested.has("-y"));
  const expiredOnly = requested.has("--expired");
  const ttlMs = retentionTtlMs();
  if (expiredOnly && ttlMs === 0) {
    throw new Error(
      "Retained tool results have no TTL: this install was told to keep them. " +
        "Set one with ./bin/control tool-result-aging ttl <days>, or purge without --expired.",
    );
  }
  const result = expiredOnly
    ? expireRetainedToolResults({ dryRun: previewOnly, ttlMs })
    : purgeRetainedToolResults({ dryRun: previewOnly });
  const age =
    result.oldestAgeMs === undefined ? "" : `, oldest ${describeRetentionAge(result.oldestAgeMs)} old`;
  const scope = expiredOnly ? ` older than ${describeRetentionTtl(ttlMs)}` : "";
  if (!result.exists || result.files === 0) {
    process.stderr.write(`No retained tool results in ${result.path}; nothing to purge.\n`);
  } else if (expiredOnly && result.expired === 0) {
    process.stderr.write(
      `Nothing in ${result.path} is older than ${describeRetentionTtl(ttlMs)}` +
        ` (${result.results} retained result(s)${age}); nothing to purge.\n`,
    );
  } else if (previewOnly) {
    process.stderr.write(
      `Would remove ${result.removed} file(s)${scope} ` +
        `(${result.results} retained result(s)${age}) ` +
        `and reclaim ${formatRetentionBytes(result.reclaimedBytes)} from ${result.path}.\n` +
        `Nothing was deleted. Re-run with --yes to empty it: ` +
        `./bin/control tool-result-aging purge${expiredOnly ? " --expired" : ""} --yes\n`,
    );
  } else {
    process.stderr.write(
      `Removed ${result.removed} file(s)${scope} and reclaimed ` +
        `${formatRetentionBytes(result.reclaimedBytes)} from ${result.path}.\n`,
    );
  }
  if (result.foreign.length) {
    process.stderr.write(
      `Left ${result.foreign.length} entry/entries this store did not write in place: ` +
        `${result.foreign.slice(0, 5).join(", ")}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed.length) process.exitCode = 1;
}

async function handleToolResultAging(action, nativeAction, flags = []) {
  const {
    setNativeToolResultAgingEnabled,
    setRetentionTtlDays,
    setToolResultAgingEnabled,
    toolResultAgingSnapshot,
  } = await import("./tool-result-aging-state.mjs");
  const desired = action || "status";
  if (desired === "status") {
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired === "purge") {
    await handleToolResultAgingPurge(flags);
    return;
  }
  // How long a retained original lives. `off` is a real answer and is kept
  // verbatim -- an operator who wants the archive keeps it -- while `default`
  // clears the answer so a later release's number applies again.
  if (desired === "ttl") {
    const requested = String(nativeAction ?? "").trim();
    if (!requested) throw new Error(TOOL_RESULT_AGING_USAGE);
    if (requested === "default") {
      setRetentionTtlDays(undefined);
    } else if (requested === "off" || requested === "never") {
      setRetentionTtlDays(0);
    } else {
      setRetentionTtlDays(requested.replace(/d$/u, ""));
    }
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired === "native") {
    if (nativeAction !== "on" && nativeAction !== "off") {
      throw new Error(TOOL_RESULT_AGING_USAGE);
    }
    setNativeToolResultAgingEnabled(nativeAction === "on");
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired !== "on" && desired !== "off") {
    throw new Error(TOOL_RESULT_AGING_USAGE);
  }
  setToolResultAgingEnabled(desired === "on");
  process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
}

// Failover has one switch, one optional order, and one escape hatch. The
// escape hatch matters most: a cooldown is the router refusing to send to a
// provider, and an operator who believes it is wrong needs a way to say so
// without waiting out a window somebody else's clock chose.
async function handleFailover(action, ...rest) {
  const {
    clearAllProviderCooldowns,
    readFailoverSettings,
    readProviderCooldowns,
    setFailoverChain,
    setFailoverEnabled,
  } = await importIssue5ControlProviderModule("./model-failover.mjs");
  const snapshot = () => ({
    ...readFailoverSettings(),
    cooldowns: readProviderCooldowns(),
  });
  const desired = action || "status";
  if (desired === "status") {
    process.stdout.write(`${JSON.stringify(snapshot(), null, 2)}\n`);
    return;
  }
  if (desired === "on" || desired === "off") {
    setFailoverEnabled(desired === "on");
  } else if (desired === "chain") {
    setFailoverChain(rest);
  } else if (desired === "auto") {
    setFailoverChain([]);
  } else if (desired === "reset") {
    // Every recorded window at once. A provider is asked again on the very
    // next turn, and answers for itself.
    clearAllProviderCooldowns();
  } else {
    throw new Error(
      "Usage: control failover status|on|off|chain <model-slug,...>|auto|reset",
    );
  }
  process.stdout.write(`${JSON.stringify(snapshot(), null, 2)}\n`);
}

// The bridge changes what the picker advertises (image input on text-only
// models), so every mutation rebuilds the catalog the way the subagent and
// picker toggles do.
// The fewest-steps local path. Downloads nothing without consent: a vision
// model already served by a running runtime is pinned outright; a needed pull
// happens only with --yes; a missing runtime prints one install line and stops.
async function runVisionBridgeSetup({ consent }) {
  const { readVisionBridgeSettings, setVisionBridgeLocal, setVisionBridgeEnabled } =
    await importIssue5ControlProviderModule("./vision-bridge-state.mjs");
  const { suggestLocalVisionSetup, ollamaAvailable, pullOllamaModel, ollamaInstallMessage } =
    await importIssue5ControlProviderModule("./vision-host.mjs");

  const suggestion = await suggestLocalVisionSetup(readVisionBridgeSettings());
  const { chosen, baseUrl, needsPull, profile } = suggestion;

  // A runtime is already serving a vision model: pin it, no download.
  if (!needsPull) {
    setVisionBridgeLocal({ model: chosen, baseUrl });
    setVisionBridgeEnabled(true);
    process.stderr.write(
      `Vision bridge on: ${chosen} on ${suggestion.runningRuntimes.join(", ")} (already running, no download).\n`,
    );
    return;
  }

  // Nothing is serving one. Pulling is a multi-gigabyte download, so it needs
  // both a runtime and explicit consent.
  if (!ollamaAvailable() && !consent) {
    process.stderr.write(
      `No local vision runtime is running.\n` +
        `Recommended for this machine (${profile.memGib} GB ${profile.arch}): ${chosen}.\n` +
        `${ollamaInstallMessage()}\n` +
        `Prefer llama.cpp? Start it, then: ./bin/control vision-bridge local ${chosen} http://127.0.0.1:8080/v1\n`,
    );
    return;
  }
  if (!consent) {
    process.stderr.write(
      `Ready to download ${chosen} with Ollama (a few GB) for this ${profile.memGib} GB machine.\n` +
        `Re-run with --yes to download and enable it: ./bin/control vision-bridge setup --yes\n`,
    );
    return;
  }
  // Explicit consent also covers installing the missing runtime. The runtime
  // manager uses `ollama serve` detached, so this setup path never opens the
  // Ollama chat window.
  const { ensureOllamaHeadless } = await importIssue5ControlProviderModule("./ollama-runtime.mjs");
  await ensureOllamaHeadless({ install: true });
  process.stderr.write(`Downloading ${chosen} with Ollama…\n`);
  pullOllamaModel(chosen);
  setVisionBridgeLocal({ model: chosen, baseUrl });
  setVisionBridgeEnabled(true);
  process.stderr.write(`Vision bridge on: ${chosen} (local, via Ollama).\n`);
}

// "default" and an empty argument both mean "stop pinning a level", which is
// how every install behaved before the level was selectable.
function effortArgument(value, levels) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!effort || effort === "default" || effort === "auto") return null;
  if (!levels.includes(effort)) {
    throw new Error(`${effort} is not a reasoning effort. Choose one of: ${levels.join(", ")}, or "default".`);
  }
  return effort;
}

async function handleVisionBridge(action, value, extra) {
  const {
    readVisionBridgeSettings,
    setVisionBridgeEnabled,
    setVisionBridgeEffort,
    setVisionBridgeEngine,
    setVisionBridgeLocal,
    visionBridgeSnapshot,
    VISION_BRIDGE_STATE_PATH,
    VISION_EFFORT_LEVELS,
  } = await importIssue5ControlProviderModule("./vision-bridge-state.mjs");
  const {
    LOCAL_ENGINE_SLUG,
    rankVisionEngines,
    resolveVisionEngine,
    visionEngineEfforts,
  } = await importIssue5ControlProviderModule("./vision-bridge.mjs");
  const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
  const nativeEngines = await shippedNativeVisionEngines();
  const snapshot = () => {
    const candidates = [...selectedConfiguredListedModels(), ...nativeEngines];
    const settings = readVisionBridgeSettings();
    const resolved = resolveVisionEngine(() => candidates, settings);
    return {
      ...visionBridgeSnapshot(),
      // The local engine is a real answer even when no paid vision model is
      // enabled, so it is offered alongside the registry engines.
      resolvedEngine: resolved?.slug || null,
      resolvedEngineName: resolved?.displayName || null,
      availableEngines: [
        ...rankVisionEngines(candidates).map((model) => model.slug),
        LOCAL_ENGINE_SLUG,
      ],
      // What the engine now in force will actually accept. Empty means it
      // declares no levels, so the only honest answer is its own default.
      availableEfforts: resolved ? visionEngineEfforts(resolved) : [],
    };
  };
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(snapshot())}\n`);
    return;
  }
  if (action === "probe") {
    // Read-only: reports what the machine can run and what the local server
    // already has, without pulling, pinning, or spending anything.
    const { suggestLocalVisionSetup } = await importIssue5ControlProviderModule("./vision-host.mjs");
    const suggestion = await suggestLocalVisionSetup(readVisionBridgeSettings());
    process.stdout.write(`${JSON.stringify(suggestion)}\n`);
    return;
  }
  if (action === "models") {
    // The downloadable local-model picker: each curated model with its size,
    // whether it fits this machine, and whether it is already pulled.
    const { annotateLocalModels, hostVisionProfile, refreshVisionModelSizesIfStale } =
      await importIssue5ControlProviderModule("./vision-host.mjs");
    const { readBenchmarkResults } = await importIssue5ControlProviderModule("./vision-benchmark.mjs");
    await refreshVisionModelSizesIfStale();
    process.stdout.write(
      `${JSON.stringify({
        host: hostVisionProfile(),
        models: annotateLocalModels({ benchmarks: readBenchmarkResults() }),
      })}\n`,
    );
    return;
  }
  if (action === "pull") {
    // Downloads a local vision model (gigabytes) with Ollama. The caller — a
    // tray row that shows the size, or a deliberate CLI command — is the
    // consent. Gigabytes take minutes, so the worker runs detached and this
    // returns at once; progress is polled with `pull-status`. The model is
    // pinned by the worker only after it lands.
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control vision-bridge pull <model-tag>");
    const { ollamaAvailable, ollamaInstallMessage } = await importIssue5ControlProviderModule("./vision-host.mjs");
    if (!ollamaAvailable()) {
      throw new Error(`Ollama is not installed. ${ollamaInstallMessage()}`);
    }
    const {
      activeVisionDownloadResult,
      claimVisionDownloadStart,
      readVisionDownload,
      writeVisionDownload,
    } = await importIssue5ControlProviderModule("./vision-download.mjs");
    const claim = claimVisionDownloadStart();
    if (!claim.acquired) {
      const existing = activeVisionDownloadResult(readVisionDownload(), tag);
      if (existing) {
        process.stdout.write(`${JSON.stringify(existing)}\n`);
        return;
      }
      throw new Error("Another vision model download is starting. Try again shortly.");
    }
    try {
      const existing = activeVisionDownloadResult(readVisionDownload(), tag);
      if (existing) {
        process.stdout.write(`${JSON.stringify(existing)}\n`);
        return;
      }
      // Seeded here rather than in the worker so a poll that lands before the
      // child has started still sees the download, not a stale previous run.
      writeVisionDownload({
        version: 1,
        tag,
        status: "downloading",
        detail: "starting",
        percent: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        controllerPid: process.pid,
        workerPid: null,
      });
      const child = spawn(
        process.execPath,
        [issue5ControlWorkerScript("vision-download", REPO_ROOT), tag],
        // windowsHide matters more here than anywhere else: a detached child
        // gets its own console on Windows, and this one lives for the length of
        // a multi-gigabyte pull. The local-model worker below already hides.
        {
          detached: true,
          env: detachedOperationEnvironment(),
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.unref();
      const workerState = readVisionDownload({ persist: false });
      if (workerState?.status === "downloading" && workerState.tag === tag) {
        writeVisionDownload({
          ...workerState,
          controllerPid: null,
          workerPid: child.pid,
          updatedAt: Date.now(),
        });
      }
      process.stdout.write(`${JSON.stringify({ started: true, tag })}\n`);
      return;
    } finally {
      claim.release();
    }
  }
  if (action === "benchmark") {
    // Measures an installed model against the checked-in ground-truth image and
    // stores the result, so a model the operator downloaded themselves can earn
    // a label without touching the CLI or trusting a reputation.
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control vision-bridge benchmark <model-tag>");
    const { benchmarkModel, saveBenchmarkResult } = await importIssue5ControlProviderModule("./vision-benchmark.mjs");
    const { probeLocalServer } = await importIssue5ControlProviderModule("./vision-host.mjs");
    const server = await probeLocalServer();
    if (!server.reachable) {
      throw new Error(`No local runtime at ${server.baseUrl} (${server.error}).`);
    }
    const result = await benchmarkModel(tag, { baseUrl: server.baseUrl });
    if (!result.ok) throw new Error(result.error);
    // The transcript is only useful while debugging and would bloat the state
    // file with a page of text per model.
    const { transcript, ...stored } = result;
    saveBenchmarkResult(tag, stored);
    // No catalog rebuild: a score changes a label in this tray, not which
    // models Codex is offered, so this stays runnable from any checkout.
    process.stdout.write(`${JSON.stringify(stored)}\n`);
    return;
  }
  if (action === "pull-status") {
    const { readVisionDownload } = await importIssue5ControlProviderModule("./vision-download.mjs");
    process.stdout.write(`${JSON.stringify(readVisionDownload() || { status: "idle" })}\n`);
    return;
  }
  if (action === "setup") {
    // One command that gets a local vision model working with the fewest
    // steps. It downloads nothing without consent: a model already served by a
    // running runtime is pinned outright; a needed pull requires --yes; and a
    // missing runtime prints one install line rather than installing it.
    const consent = value === "--yes" || value === "-y" || extra === "--yes";
    await transactModelOverlayMutation({
      files: [VISION_BRIDGE_STATE_PATH],
      mutate: () => runVisionBridgeSetup({ consent }),
    });
    process.stdout.write(`${JSON.stringify(snapshot())}\n`);
    return;
  }
  let mutate;
  if (action === "on" || action === "off") {
    mutate = () => setVisionBridgeEnabled(action === "on");
  } else if (action === "local") {
    // control vision-bridge local [model] [baseUrl] -- pins a local model and
    // turns the bridge on in the same step. With no model, the machine picks
    // one: an already-pulled vision model, else the hardware recommendation.
    let model = String(value || "").trim();
    let baseUrl = String(extra || "").trim() || undefined;
    if (!model) {
      const { suggestLocalVisionSetup } = await importIssue5ControlProviderModule("./vision-host.mjs");
      const suggestion = await suggestLocalVisionSetup(readVisionBridgeSettings());
      model = suggestion.chosen;
      baseUrl = baseUrl || (suggestion.needsPull ? undefined : suggestion.baseUrl);
      const where = suggestion.runningRuntimes.length
        ? `on ${suggestion.runningRuntimes.join(", ")}`
        : "no local runtime detected";
      process.stderr.write(
        `Selected ${model} for ${suggestion.profile.memGib} GB ${suggestion.profile.arch} (${where})` +
          `${suggestion.needsPull ? ` — run: ${suggestion.pullCommand}` : " — already pulled"}\n`,
      );
    }
    mutate = () => {
      setVisionBridgeLocal({ model, baseUrl });
      setVisionBridgeEnabled(true);
    };
  } else if (action === "engine") {
    const slug = String(value || "").trim();
    if (slug && slug !== "auto" && slug !== LOCAL_ENGINE_SLUG) {
      // Must accept everything the picker offers. Validating against the routed
      // models alone rejected every native slug, so choosing one from the tray
      // silently left the previous engine in place.
      const available = rankVisionEngines([
        ...selectedConfiguredListedModels(),
        ...nativeEngines,
      ]);
      if (!available.some((model) => model.slug === slug)) {
        throw new Error(
          `${slug} is not an enabled model that reads images. Choose one of: ${
            available.map((model) => model.slug).join(", ") || "(none enabled)"
          }, or "local" for a local vision model, or "auto".`,
        );
      }
    }
    const engine = slug && slug !== "auto" ? slug : null;
    const effort = extra === undefined
      ? undefined
      : effortArgument(extra, VISION_EFFORT_LEVELS);
    // The tray picks an engine and a level in one click, so the level rides
    // along here. Left out, whatever was pinned before stays pinned.
    mutate = () => {
      setVisionBridgeEngine(engine);
      if (effort !== undefined) setVisionBridgeEffort(effort);
    };
  } else if (action === "effort") {
    const effort = effortArgument(value, VISION_EFFORT_LEVELS);
    mutate = () => setVisionBridgeEffort(effort);
  } else {
    throw new Error(
      "Usage: control vision-bridge status|probe|models|setup [--yes]|on|off|" +
        "engine <model-slug|local|auto> [effort]|effort <level|default>|" +
      "local [model] [baseUrl]|pull <model-tag>",
    );
  }
  await transactModelOverlayMutation({
    files: [VISION_BRIDGE_STATE_PATH],
    mutate,
  });
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
}

// Local models are managed as their own thing, not as a vision detail: the
// operator installs, checks, and removes them here, and the vision bridge is
// only one of the consumers.
async function handleLocalModels(action, value, ...rest) {
  // Variadic because `--yes` and `--force` answer different questions and an
  // install can need both: `--yes` consents to installing Ollama itself,
  // `--force` consents to a model this machine may not fit. A single flag slot
  // made that combination unexpressible.
  const options = rest.filter((item) => typeof item === "string");
  const flags = new Set(options.filter((item) => item.startsWith("--")));
  const positional = options.find((item) => !item.startsWith("--"));
  const {
    isLocalModelEnabled,
    LOCAL_MODELS_STATE_PATH,
    localModelsSnapshot,
    setLocalModelEnabled,
  } = await importIssue5ControlProviderModule("./local-models.mjs");
  const { readBenchmarkResults } = await importIssue5ControlProviderModule("./vision-benchmark.mjs");
  const { readLocalBenchmarks } = await importIssue5ControlProviderModule("./local-benchmark.mjs");
  const visionBenchmarks = readBenchmarkResults();
  const localBenchmarks = readLocalBenchmarks();
  const localAndVisionBenchmarks = Object.fromEntries(
    [...new Set([...Object.keys(visionBenchmarks), ...Object.keys(localBenchmarks)])]
      .map((tag) => [tag, { ...visionBenchmarks[tag], ...localBenchmarks[tag] }]),
  );
  // The LM Studio section rides along with every snapshot so the panel's one
  // `local_models` read covers both local runtimes. Its probe is a loopback
  // HTTP call with a short timeout, so an LM Studio that is simply off costs
  // the snapshot a bounded wait, not an error.
  const { lmstudioSnapshot } = await importIssue5ControlProviderModule("./lmstudio-models.mjs");
  const { localMlxUiSnapshot } = await importIssue5ControlProviderModule("./local-mlx-operation.mjs");
  const snapshot = async () => {
    const [lmstudio, mlx] = await Promise.all([lmstudioSnapshot(), localMlxUiSnapshot()]);
    return {
      ...localModelsSnapshot({ benchmarks: localAndVisionBenchmarks }),
      lmstudio,
      mlx,
    };
  };
  if (action === "list" || action === "status" || !action) {
    const current = await snapshot();
    // The tray and any script read JSON; a person at a terminal was handed a
    // single unbroken line, which only got worse once the snapshot grew a
    // download list. Explicit `--json` keeps the machine contract, and a bare
    // invocation is readable.
    if (value === "--json" || flags.has("--json") || !process.stdout.isTTY) {
      process.stdout.write(`${JSON.stringify(current)}\n`);
      return;
    }
    const { renderLocalModels } = await importIssue5ControlProviderModule("./local-models.mjs");
    process.stdout.write(`${renderLocalModels(current)}\n`);
    return;
  }
  if (action === "agent-check") {
    // Runs the real Codex client against the model. Slow by design: every
    // cheaper approximation tried here disagreed with reality.
    const { checkAgentCapability } = await importIssue5ControlProviderModule("./agent-check.mjs");
    const { readLocalModelSelection, saveAgentCheck } = await importIssue5ControlProviderModule("./local-models.mjs");
    const tags = value ? [String(value).trim()] : readLocalModelSelection().enabled;
    if (!tags.length) throw new Error("No local models are checked.");
    const results = [];
    for (const tag of tags) {
      const result = checkAgentCapability(`local/${tag}`);
      saveAgentCheck(tag, result);
      results.push({ tag, ...result });
    }
    process.stdout.write(`${JSON.stringify({ results })}\n`);
    return;
  }
  if (action === "inspect") {
    // Answers "can Codex drive this?" for a few kilobytes instead of a
    // multi-gigabyte download.
    // normalizeLocalModelTag throws on an empty or malformed reference, so
    // there is no separate emptiness check to make here.
    const { normalizeLocalModelTag } = await importIssue5ControlProviderModule("./local-model-ref.mjs");
    const tag = normalizeLocalModelTag(value);
    const {
      fetchRegistryCapabilities,
      fetchRegistryContext,
      describeMachine,
      detectMachine,
      rateDiskFit,
      rateModelFit,
    } = await importIssue5ControlProviderModule("./local-models.mjs");
    // Both are read from the model's own files rather than assumed: the chat
    // template says whether it can call tools, the GGUF header says how much
    // context it holds. One megabyte of ranged reads, no download.
    const [info, context] = await Promise.all([
      fetchRegistryCapabilities(tag),
      fetchRegistryContext(tag),
    ]);
    // Whether the machine can run it is as decisive as whether Codex can
    // drive it, and the manifest already carries the size.
    const capacity = detectMachine();
    process.stdout.write(
      `${JSON.stringify(
        info
          ? {
              ...info,
              context: context ?? null,
              fit: rateModelFit(info.sizeGb, capacity) ?? null,
              diskFit: rateDiskFit(info.sizeGb, capacity) ?? null,
              machine: describeMachine(capacity),
            }
          : { tag, unknown: true, context: context ?? null, machine: describeMachine(capacity) },
      )}\n`,
    );
    return;
  }
  if (action === "runtime") {
    const { localOllamaRuntimeSnapshot, ensureOllamaHeadless, updateOllamaRuntime } = await importIssue5ControlProviderModule(
      "./ollama-runtime.mjs"
    );
    const subcommand = String(value || "status").trim();
    if (subcommand === "status") {
      process.stdout.write(`${JSON.stringify(localOllamaRuntimeSnapshot())}\n`);
      return;
    }
    if (subcommand === "update") {
      if (!flags.has("--yes")) {
        throw new Error("Updating Ollama changes system software. Pass --yes to confirm.");
      }
      const result = updateOllamaRuntime();
      const running = await ensureOllamaHeadless({ install: false });
      process.stdout.write(`${JSON.stringify({ ...result, running: running.running })}\n`);
      return;
    }
    if (subcommand === "start") {
      const result = await ensureOllamaHeadless({ install: flags.has("--yes") });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    throw new Error("Usage: control local-models runtime status|start [--yes]|update --yes");
  }
  if (action === "benchmark") {
    const { benchmarkLocalModel } = await importIssue5ControlProviderModule("./local-benchmark.mjs");
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control local-models benchmark <model-tag>");
    const result = await benchmarkLocalModel(tag);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (action === "mlx-status") {
    process.stdout.write(`${JSON.stringify(await localMlxUiSnapshot())}\n`);
    return;
  }
  if (action === "mlx-install") {
    const { startLocalMlxOperation } = await importIssue5ControlProviderModule("./local-mlx-operation.mjs");
    const result = startLocalMlxOperation({ yes: value === "--yes" || flags.has("--yes") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (action === "mlx-cancel") {
    const { cancelLocalMlxOperation } = await importIssue5ControlProviderModule("./local-mlx-operation.mjs");
    process.stdout.write(`${JSON.stringify(cancelLocalMlxOperation())}\n`);
    return;
  }
  if (action === "cancel") {
    const { cancelLocalDownload } = await importIssue5ControlProviderModule("./local-download.mjs");
    const result = cancelLocalDownload(value);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (action === "install" || action === "install-and-use") {
    // Same detached-worker principle as the vision picker, but this worker is
    // for Codex chat models: successful completion checks the model on and
    // publishes the route automatically.
    const { normalizeLocalModelTag, splitLocalModelTag } = await importIssue5ControlProviderModule("./local-model-ref.mjs");
    const tag = normalizeLocalModelTag(value);
    const identity = splitLocalModelTag(tag);
    const {
      claimLocalOperation,
      isLocalOperationActive,
      readLocalDownload,
      writeLocalDownload,
    } = await importIssue5ControlProviderModule("./local-download.mjs");
    const startedAt = Date.now();
    const writePhase = (detail, extra = {}) => writeLocalDownload({
      version: 1,
      tag,
      status: "downloading",
      detail,
      percent: 0,
      startedAt,
      updatedAt: Date.now(),
      kind: "download",
      controllerPid: process.pid,
      workerPid: null,
      ...extra,
    });
    const claim = claimLocalOperation(tag, "download");
    if (!claim.acquired) {
      const active = readLocalDownload();
      if (isLocalOperationActive(active) && active.tag !== tag) {
        throw new Error(
          active.status === "uninstalling"
            ? `${active.tag} is already being removed.`
            : `${active.tag} is already downloading (${active.percent || 0}%).`,
        );
      }
      if (isLocalOperationActive(active) && active.tag === tag) {
        process.stdout.write(`${JSON.stringify({
          started: false,
          existing: true,
          tag,
          percent: active.percent || 0,
          detail: active.detail || "downloading",
          kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
        })}\n`);
        return;
      }
      throw new Error("Another local model operation is starting. Try again shortly.");
    }
    // Persist the optimistic state before any network lookup or runtime
    // installation. The tray may refresh while either one is in progress, and
    // the operator should still see that the click was accepted.
    try {
      const { isLocalMlxOperationActive, readLocalMlxOperation } = await importIssue5ControlProviderModule(
        "./local-mlx-operation.mjs"
      );
      const mlxOperation = readLocalMlxOperation();
      if (isLocalMlxOperationActive(mlxOperation)) {
        throw new Error(`The curated MLX model is already ${mlxOperation.status}.`);
      }
      const active = readLocalDownload();
      if (isLocalOperationActive(active) && active.tag !== tag) {
        throw new Error(
          active.status === "uninstalling"
            ? `${active.tag} is already being removed.`
            : `${active.tag} is already downloading (${active.percent || 0}%).`,
        );
      }
      if (isLocalOperationActive(active) && active.tag === tag) {
        process.stdout.write(`${JSON.stringify({
          started: false,
          existing: true,
          tag,
          percent: active.percent || 0,
          detail: active.detail || "downloading",
          kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
        })}\n`);
        return;
      }
      writePhase("Checking model and machine fit");
    } finally {
      claim.release();
    }
    const cancelled = () => readLocalDownload()?.status === "cancelled";
    try {
      const {
        EXPLORE_LOCAL_MODELS,
        fetchRegistryCapabilities,
        detectMachine,
        fitAdvisory,
        rateDiskFit,
        rateModelFit,
      } = await importIssue5ControlProviderModule("./local-models.mjs");
      // Hugging Face namespaced tags are pulled directly by Ollama and do not
      // have a registry.ollama.ai manifest. Their checked-in catalog size is
      // still authoritative enough for the safety gate: without this fallback
      // a 93-467 GB GLM download could bypass the explicit --force consent.
      const advertised = await fetchRegistryCapabilities(tag)
        || EXPLORE_LOCAL_MODELS.find((entry) => entry.tag === tag);
      if (cancelled()) return;
      // A missing tool template costs nothing to discover afterwards; gigabytes
      // that cannot run cost the download and the disk. So the tool note stays
      // advisory while a model too large for this machine is refused unless the
      // operator overrides it deliberately.
      const capacity = detectMachine();
      const fit = advertised ? rateModelFit(advertised.sizeGb, capacity) : undefined;
      const diskFit = advertised ? rateDiskFit(advertised.sizeGb, capacity) : undefined;
      if ((fit === "too-large" || diskFit === "too-large") && !flags.has("--force")) {
        throw new Error(
          `${fitAdvisory(tag, advertised.sizeGb, capacity) || `${tag} may not fit on this machine's free disk.`} Pass --force to download it anyway.`,
        );
      }
      if (cancelled()) return;
      writePhase("Preparing headless Ollama");
      const { ensureOllamaHeadless, ollamaCommand } = await importIssue5ControlProviderModule("./ollama-runtime.mjs");
      // One action installs both. `--yes` is the operator's consent to touch
      // system software: with it a missing Ollama is installed headlessly (the
      // Homebrew formula when available, otherwise the official installer with
      // OLLAMA_NO_START=1) and then started as a detached `ollama serve`. The
      // Ollama desktop app is never launched. Without `--yes`, say so plainly
      // rather than surfacing the runtime layer's generic "not installed".
      const installRuntime = flags.has("--yes");
      if (!installRuntime && !ollamaCommand()) {
        throw new Error(
          `Ollama is not installed. Re-run with --yes to install it headlessly and then download ${tag}.`,
        );
      }
      await ensureOllamaHeadless({ install: installRuntime });
      if (cancelled()) return;
      writePhase("Starting model download");
      const child = spawn(process.execPath, [issue5ControlWorkerScript("local-download", REPO_ROOT), tag], {
        detached: true,
        env: detachedOperationEnvironment(),
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      writeLocalDownload({
        ...readLocalDownload(),
        version: 1,
        kind: "download",
        tag,
        status: "downloading",
        detail: "Starting model download",
        percent: 0,
        startedAt,
        updatedAt: Date.now(),
        controllerPid: null,
        workerPid: child.pid,
      });
      // Advisory, never blocking: the operator may well want a vision-only
      // model, but they should know before the gigabytes land.
      process.stdout.write(
        `${JSON.stringify({
          started: true,
          tag,
          family: advertised?.family || identity.family,
          variant: advertised?.variant || identity.variant,
          tools: advertised?.tools ?? null,
          fit: fit ?? null,
          diskFit: diskFit ?? null,
          runtime: "headless",
        })}\n`,
      );
      const fitNote = advertised ? fitAdvisory(tag, advertised.sizeGb, capacity) : undefined;
      if (fitNote) process.stderr.write(`Note: ${fitNote}\n`);
      if (advertised && !advertised.tools) {
        process.stderr.write(
          `Note: ${tag} does not advertise tool calling, so Codex cannot use it as a chat model. ` +
            `It can still serve as a vision reader.\n`,
        );
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cancelled()) return;
      writeLocalDownload({
        ...readLocalDownload(),
        version: 1,
        kind: "download",
        tag,
        status: "error",
        detail: "failed",
        percent: readLocalDownload()?.percent || 0,
        startedAt,
        updatedAt: Date.now(),
        error: message,
      });
      throw error;
    }
  }
  if (action === "finalize-uninstall") {
    // Ollama removal has already completed by the time this cleanup step is
    // reached.  Catalog/gateway refresh and a service restart are follow-up
    // publication work: if either one is unavailable, report the warning but
    // do not turn a successfully removed model into a false removal failure.
    const warnings = await finalizeLocalModelPublication();
    process.stdout.write(`${JSON.stringify({
      finalized: true,
      tag: value || null,
      ...warnings,
    })}\n`);
    return;
  }
  if (action === "uninstall") {
    const rawTag = String(value || "").trim();
    if (!rawTag) throw new Error("Usage: control local-models uninstall <model-tag> --yes");
    if (!flags.has("--yes")) {
      throw new Error(`Removing ${rawTag} deletes it from disk. Pass --yes to confirm.`);
    }
    const { normalizeLocalModelTag } = await importIssue5ControlProviderModule("./local-model-ref.mjs");
    const tag = normalizeLocalModelTag(rawTag);
    const {
      claimLocalOperation,
      isLocalOperationActive,
      readLocalDownload,
      writeLocalDownload,
    } = await importIssue5ControlProviderModule("./local-download.mjs");
    const claim = claimLocalOperation(tag, "uninstall");
    if (!claim.acquired) {
      const active = readLocalDownload();
      if (isLocalOperationActive(active) && active.tag === tag) {
        process.stdout.write(`${JSON.stringify({
          started: false,
          existing: true,
          tag,
          kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
          status: active.status,
        })}\n`);
        return;
      }
      throw new Error("Another local model operation is starting. Try again shortly.");
    }
    try {
    const { isLocalMlxOperationActive, readLocalMlxOperation } = await importIssue5ControlProviderModule(
      "./local-mlx-operation.mjs"
    );
    const mlxOperation = readLocalMlxOperation();
    if (isLocalMlxOperationActive(mlxOperation)) {
      throw new Error(`The curated MLX model is already ${mlxOperation.status}.`);
    }
    const active = readLocalDownload();
    if (isLocalOperationActive(active) && active.tag !== tag) {
      throw new Error(
        active.status === "uninstalling"
          ? `${active.tag} is already being removed.`
          : `${active.tag} is already downloading (${active.percent || 0}%).`,
      );
    }
    if (isLocalOperationActive(active) && active.tag === tag) {
      process.stdout.write(`${JSON.stringify({
        started: false,
        existing: true,
        tag,
        kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
        status: active.status,
      })}\n`);
      return;
    }
    if (flags.has("--async")) {
      const startedAt = Date.now();
      writeLocalDownload({
        version: 1,
        kind: "uninstall",
        tag,
        status: "uninstalling",
        detail: "Starting model removal",
        percent: 0,
        startedAt,
        updatedAt: startedAt,
        controllerPid: process.pid,
        workerPid: null,
      });
      try {
        const child = spawn(
          process.execPath,
          [issue5ControlWorkerScript("local-uninstall", REPO_ROOT), tag],
          {
            detached: true,
            env: detachedOperationEnvironment(),
            stdio: "ignore",
            windowsHide: true,
          },
        );
        child.unref();
        writeLocalDownload({
          ...readLocalDownload(),
          controllerPid: null,
          workerPid: child.pid,
          updatedAt: Date.now(),
        });
      } catch (error) {
        writeLocalDownload({
          ...readLocalDownload(),
          status: "error",
          detail: "Removal failed to start",
          updatedAt: Date.now(),
          controllerPid: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      process.stdout.write(`${JSON.stringify({ started: true, tag, kind: "uninstall" })}\n`);
      return;
    }
    const { uninstallLocalModelTransaction } = await importIssue5ControlProviderModule("./local-uninstall.mjs");
    await uninstallLocalModelTransaction(tag, {
      restartService: restartRouterForLocalRoutes,
    });
    const warnings = await finalizeLocalModelPublication();
    const finishedAt = Date.now();
    writeLocalDownload({
      version: 1,
      kind: "uninstall",
      tag,
      status: "done",
      detail: warnings.catalogError
        ? "Model removed · catalog refresh needed"
        : warnings.restartError
          ? "Model removed · router restart needed"
          : "Model removed",
      percent: 100,
      startedAt: finishedAt,
      updatedAt: finishedAt,
      workerPid: null,
      controllerPid: null,
      ...(warnings.catalogError ? { catalogError: warnings.catalogError } : {}),
      ...(warnings.restartError ? { restartError: warnings.restartError } : {}),
      error: undefined,
    });
    } finally {
      claim.release();
    }
  } else if (action === "set") {
    if (!["on", "off"].includes(positional)) {
      throw new Error("Usage: control local-models set <model-tag> <on|off>");
    }
    const enabled = positional === "on";
    // Compared across spellings: the downloader stores `gemma3:latest` and a
    // hand-typed `gemma3` is the same model, so a raw string match here would
    // skip the router restart that publishes the route change.
    await transactModelOverlayMutation({
      files: [
        LOCAL_MODELS_STATE_PATH,
        USER_MODELS_PATH,
        PROVIDER_SELECTION_PATH,
      ],
      mutate: () => setLocalModelEnabled(value, enabled),
      // Evaluated after the transaction lock is held, so a queued toggle does
      // not make its restart decision from a stale pre-lock read.
      restart: () => isLocalModelEnabled(value) !== enabled,
      restartService: restartRouterForLocalRoutes,
    });
  } else if (action === "lmstudio-set") {
    if (!["on", "off"].includes(positional)) {
      throw new Error("Usage: control local-models lmstudio-set <model-id> <on|off>");
    }
    // The panel's checkbox for a model LM Studio serves. Publishing goes
    // through the same user-model overlay `curate-models lmstudio` writes,
    // and the same restart that makes an Ollama toggle live makes this one.
    const { isLmstudioModelEnabled, setLmstudioModelEnabled } = await importIssue5ControlProviderModule(
      "./lmstudio-models.mjs"
    );
    const enabled = positional === "on";
    await transactModelOverlayMutation({
      files: [USER_MODELS_PATH, PROVIDER_SELECTION_PATH],
      mutate: () => setLmstudioModelEnabled(value, enabled),
      restart: () => isLmstudioModelEnabled(value) !== enabled,
      restartService: restartRouterForLocalRoutes,
    });
  } else {
    throw new Error(
      "Usage: control local-models list [--json]|inspect <tag-or-url>|" +
        "install <tag-or-url> [--yes] [--force]|benchmark <tag>|" +
        "runtime status|runtime start [--yes]|runtime update --yes|" +
        "mlx-install --yes|mlx-status|mlx-cancel|" +
        "uninstall <tag> --yes|cancel [<tag>]|set <tag> <on|off>|" +
        "lmstudio-set <id> <on|off>\n" +
        "  --yes    consent to installing/starting Ollama itself (headless)\n" +
        "  --force  download a model rated too large for this machine anyway",
    );
  }
  process.stdout.write(`${JSON.stringify(await snapshot())}\n`);
}

async function handlePicker(action, value, flag) {
  const {
    modelPickerSnapshot,
    setAllModelsVisible,
    setModelVisible,
    setModelsVisible,
  } = await import("./model-picker-state.mjs");
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(modelPickerSnapshot())}\n`);
    return;
  }
  await withModelOverlayLock(async () => {
    const nativeBaseSlugs = await nativeCodexBaseSlugs();
    if (action === "all") {
      if (!["show", "hide"].includes(flag)) {
        throw new Error("Usage: control picker all <show|hide>");
      }
      // Do not use only merged-models.json here. That file belongs to the
      // Codex adapter and may not exist on a DSH/Gemini-only installation;
      // the router's selected registry plus the captured native catalog is
      // the complete local policy surface for every installed client.
      const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
      const { selectedConfiguredListedModels } = await importIssue5ControlProviderModule("./provider-selection.mjs");
      const slugs = new Set(selectedConfiguredListedModels().map((model) => String(model.slug)));
      // The router owns routed models; Codex owns its native picker entries.
      // Keep routed aliases/context variants from the last publication so a
      // refresh cannot lose a model merely because its native capture is
      // temporarily unavailable.
      if (existsSync(MERGED_CATALOG_PATH)) {
        try {
          const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
          for (const model of Array.isArray(parsed?.models) ? parsed.models : []) {
            if (model?.slug && !nativeBaseSlugs.has(String(model.slug))) {
              slugs.add(String(model.slug));
            }
          }
        } catch {
          // The next publication will repair the merged catalog. The shared
          // router model set above is still enough to persist this mutation.
        }
      }
      setAllModelsVisible([...slugs], flag === "show");
    } else if (action === "set") {
      if (!["show", "hide"].includes(flag)) {
        throw new Error("Usage: control picker set <model-slug> <show|hide>");
      }
      if (!(await knownModelSlug(value))) {
        throw new Error(`Unknown model slug: ${value}`);
      }
      if (nativeBaseSlugs.has(String(value))) {
        throw new Error(
          "Native Codex model visibility is managed by Codex and is not part of the router picker overlay.",
        );
      }
      setModelVisible(value, flag === "show");
    } else if (action === "provider") {
      if (!["show", "hide"].includes(flag)) {
        throw new Error("Usage: control picker provider <provider-id> <show|hide>");
      }
      const provider = String(value || "").trim();
      let slugs;
      if (provider === "openai") {
        throw new Error(
          "Native Codex model visibility is managed by Codex and is not part of the router picker overlay.",
        );
      } else {
        const { canonicalProviderId, selectedConfiguredListedModels } = await importIssue5ControlProviderModule(
          "./provider-selection.mjs",
        );
        const canonical = canonicalProviderId(provider);
        slugs = selectedConfiguredListedModels()
          .filter((model) => canonicalProviderId(model.provider) === canonical)
          .map((model) => model.slug);
      }
      if (slugs.length === 0) {
        throw new Error(`No enabled models found for provider: ${value}`);
      }
      setModelsVisible(slugs, flag === "show");
    } else {
      throw new Error(
        "Usage: control picker status|all <show|hide>|set <model-slug> <show|hide>|" +
          "provider <provider-id> <show|hide>",
      );
    }
    // The write above is the router's durable source of truth. Publish it to
    // Codex, DSH, and Gemini while the same model-overlay lock is held so a
    // second command cannot race a client snapshot between the two steps.
    await refreshModelSettingsCatalog();
  });
  process.stdout.write(`${JSON.stringify(modelPickerSnapshot())}\n`);
}

// The tray drives these two when it follows the Codex/ChatGPT desktop apps:
// `presence` records the mode so doctor can tell a deliberate shutdown from a
// crash, and `service` starts or stops the background service. Installing and
// uninstalling stay out of reach; the tray must not be able to unregister the
// LaunchAgent that owns the router.
const SERVICE_COMMANDS = ["status", "start", "stop", "restart"];

function handleService(action) {
  const value = action || "status";
  if (!SERVICE_COMMANDS.includes(value)) {
    throw new Error(`Usage: control service ${SERVICE_COMMANDS.join("|")}`);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "service.mjs"), value],
    { stdio: ["inherit", "pipe", "pipe"], env: process.env, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || `Background service ${value} failed with exit code ${result.status}.`).trim(),
    );
  }
  const output = String(result.stdout || "").trim();
  if (output) process.stdout.write(`${output}\n`);
  else process.stdout.write(`${JSON.stringify({ state: value === "stop" ? "stopped" : "running" })}\n`);
}

// Supervision for the tray companion. `disable` boots the agent out and stops
// the running tray too, so the Settings surface exposes it only behind its
// explicit confirmation dialog.
async function handleNativeRedirect(action, value) {
  const { clearNativeRedirect, nativeRedirectSnapshot, setNativeRedirect } = await import(
    "./native-redirect.mjs"
  );
  if (!action || action === "status") {
    process.stdout.write(`${JSON.stringify(nativeRedirectSnapshot())}\n`);
    return;
  }
  if (action === "clear") {
    process.stdout.write(`${JSON.stringify(clearNativeRedirect())}\n`);
    return;
  }
  if (action !== "set") {
    throw new Error("Usage: control native-redirect status|set <routed-model-slug>|clear");
  }
  if (!(await knownModelSlug(value))) {
    throw new Error(`Unknown routed model slug: ${value}`);
  }
  process.stdout.write(`${JSON.stringify(setNativeRedirect(value))}\n`);
}

// One action for "give me a working harness": install the CLI if it is absent,
// then publish the routed models into its own documents. Kept behind an
// explicit subcommand rather than folded into `apply`, because it installs a
// third-party package and that must never be a side effect of something else.
async function handleChatGptSession(action) {
  const desired = action || "status";
  if (desired === "status") {
    process.stdout.write(`${JSON.stringify(await chatGptSessionStatus())}\n`);
    return;
  }
  if (desired !== "enable" && desired !== "disable") {
    throw new Error("Usage: control chatgpt-session status|enable|disable");
  }
  process.stdout.write(
    `${JSON.stringify(await setChatGptSessionSharingFromControl(desired === "enable"))}\n`,
  );
}

function decodeChatGPTLoginLease(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("The ChatGPT login completion lease is invalid.");
  }
  let lease;
  try {
    lease = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("The ChatGPT login completion lease is invalid.", { cause: error });
  }
  if (
    !lease
    || typeof lease !== "object"
    || Array.isArray(lease)
    || ![2, 3].includes(lease.version)
    || typeof lease.leaseId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(lease.leaseId)
    || !Number.isSafeInteger(lease.pid)
    || lease.pid < 1
    || typeof lease.processIdentity !== "string"
    || !lease.processIdentity
    || !Number.isFinite(lease.createdAt)
    || (lease.version === 3 && !["reserved", "running"].includes(lease.phase))
    || (lease.version === 3 && lease.authDigestBefore !== null && !/^[0-9a-f]{64}$/.test(lease.authDigestBefore))
  ) {
    throw new Error("The ChatGPT login completion lease is invalid.");
  }
  return lease;
}

async function handleChatGptAccountSwitch(action, value, completionLease) {
  // Keep this boundary ahead of both dynamic imports. The Control Center polls
  // `status` automatically, and --no-discovery promises that even a background
  // read cannot inspect auth files, create first-run pool state, or migrate the
  // current Codex login into an isolated account home.
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
  const {
    chatGPTSubscriptionAccountHome,
    chatGPTSubscriptionAccountPoolSnapshot,
    createChatGPTSubscriptionAccount,
    readChatGPTAccountPoolState,
    refreshBoundedChatGPTSubscriptionAccounts,
    withChatGPTAccountPoolLock,
  } = await import("./chatgpt-account-pool.mjs");
  const {
    chatGPTProfileSwitchSnapshot,
    discardCompletedChatGPTProfileLogin,
    ensureChatGPTProfileAccounts,
    finalizeChatGPTProfileLogin,
    recoverCompletedChatGPTProfileLogins,
    reconcileChatGPTProfileSwitch,
    reconcileChatGPTProfileSwitchIfReady,
    removeChatGPTProfileAccount,
    selectChatGPTProfileAccount,
  } = await importIssue5ControlProviderModule("./chatgpt-profile-switch.mjs");

  if (!action || action === "status") {
    // This is the single production reconcile poll, owned by the Control
    // Center account view. It is read-only for settled state; after Codex has
    // closed it completes an explicit pending handoff or durable crash phase.
    const recovery = await recoverCompletedChatGPTProfileLogins();
    await reconcileChatGPTProfileSwitchIfReady();
    await ensureChatGPTProfileAccounts();
    const beforeRefresh = chatGPTSubscriptionAccountPoolSnapshot();
    await refreshBoundedChatGPTSubscriptionAccounts(beforeRefresh);
    const safe = chatGPTSubscriptionAccountPoolSnapshot();
    const profile = chatGPTProfileSwitchSnapshot();
    const loginAttempts = {};
    for (const failure of recovery.failures) {
      const account = safe.accounts?.[failure.accountId];
      if (!account) continue;
      account.subscription = {
        ...(account.subscription || {}),
        loginInProgress: false,
        attentionRequired: true,
      };
      const removable = profile.active !== failure.accountId && profile.desired !== failure.accountId;
      loginAttempts[failure.accountId] = {
        status: "failed",
        retryable: failure.code !== "finalization-failed",
        removable,
        error: failure.code === "identity-conflict"
          ? removable
            ? "This saved login conflicts with another account identity. Retry sign-in with the intended account or remove it."
            : "This active login conflicts with its saved account identity. Retry sign-in with the intended account; switch away before removing it."
          : failure.code === "invalid-auth"
            ? removable
              ? "The saved login is incomplete or invalid. Retry sign-in or remove this account."
              : "The active saved login is incomplete or invalid. Retry sign-in; switch away before removing it."
            : "The saved login could not be finalized safely. Resolve the profile error, then refresh.",
      };
    }
    for (const [accountId, account] of Object.entries(safe.accounts || {})) {
      if (account.subscription?.attentionRequired !== true || loginAttempts[accountId]) continue;
      loginAttempts[accountId] = {
        status: "failed",
        retryable: false,
        removable: false,
        error: "A previous sign-in may still be running. Verify that no Codex login process remains before manually clearing its saved ownership.",
      };
    }
    const { attachBoundedChatGPTAccountUsage } = await importIssue5ControlProviderModule("./codex-account-usage.mjs");
    await attachBoundedChatGPTAccountUsage(safe, {
      accountHome: (accountId) => chatGPTSubscriptionAccountHome(accountId),
    });
    process.stdout.write(`${JSON.stringify({
      ...safe,
      ...(Object.keys(loginAttempts).length ? { loginAttempts } : {}),
      profile,
      sessions: { count: Object.keys(safe.sessions || {}).length },
    })}\n`);
    return;
  }
  if (action === "add") {
    const account = await withChatGPTAccountPoolLock(
      () => createChatGPTSubscriptionAccount({ label: value }),
    );
    process.stdout.write(`${JSON.stringify({ account, loginRequired: true })}\n`);
    return;
  }
  if (action === "home") {
    const state = readChatGPTAccountPoolState();
    if (!value || !/^acct_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new Error("Account id is invalid.");
    if (!state.accounts[value]) throw new Error("Account id is not registered.");
    process.stdout.write(`${JSON.stringify({ accountId: value, home: chatGPTSubscriptionAccountHome(value) })}\n`);
    return;
  }
  if (action === "login-finalize") {
    if (!value || !/^acct_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new Error("Account id is invalid.");
    process.stdout.write(`${JSON.stringify(await finalizeChatGPTProfileLogin(value, {
      expectedLoginLease: decodeChatGPTLoginLease(completionLease),
    }))}\n`);
    return;
  }
  if (action === "login-reset") {
    if (!value || !/^acct_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new Error("Account id is invalid.");
    process.stdout.write(`${JSON.stringify({ reset: await discardCompletedChatGPTProfileLogin(value) })}\n`);
    return;
  }
  if (action === "remove") {
    const result = await removeChatGPTProfileAccount(value);
    process.stdout.write(`${JSON.stringify(result.removed)}\n`);
    return;
  }
  if (action === "select") {
    const selection = String(value || "").trim();
    if (!/^acct_[A-Za-z0-9_-]{8,80}$/.test(selection)) {
      throw new Error("Select a registered ChatGPT account id.");
    }
    const { pool, profile } = await selectChatGPTProfileAccount(selection);
    process.stdout.write(`${JSON.stringify({ ...pool, profile })}\n`);
    return;
  }
  if (action === "profile") {
    if (value === "reconcile") {
      process.stdout.write(`${JSON.stringify(await reconcileChatGPTProfileSwitch())}\n`);
      return;
    }
    if (!value || value === "status") {
      process.stdout.write(`${JSON.stringify(chatGPTProfileSwitchSnapshot())}\n`);
      return;
    }
  }
  throw new Error("Usage: control chatgpt-account-pool status|add [label]|home <acct_id>|login-finalize <acct_id> <lease>|remove <acct_id>|select <acct_id>|profile status|profile reconcile");
}

// The public `/health` leaf intentionally contains only the router summary and
// a closed set of degraded dependency names. Desktop surfaces need the richer
// local service view, but should not be handed the forwarders' credential
// metadata. Read the protected health leaf here, then project it to the small
// contract the tray and Control Center render.
async function printHealth() {
  process.stdout.write(`${JSON.stringify(await readControlHealth())}\n`);
}

// --- dispatch ---------------------------------------------------------------

if (args[0] === "--probe-set") {
  await emitProbeSet(args[1], args[2]);
} else if (args[0] === "set") {
  if (!args[1] || !args[2]) throw new Error("Usage: control set <provider> <on|off> [--targets ...]");
  await runSet(args[1], args[2]);
} else if (args[0] === "set-apply") {
  if (!args[1] || !args[2]) {
    throw new Error("Usage: control set-apply <provider> <on|off> [--targets ...] [--activate]");
  }
  await runSetApply(args[1], args[2]);
} else if (args[0] === "apply") {
  await runApply();
} else if (args[0] === "account") {
  await printAccountUsage();
} else if (args[0] === "provider-usage") {
  await printProviderUsage();
} else if (args[0] === "providers") {
  await printProviderOnboarding();
} else if (args[0] === "generic-providers") {
  await handleGenericProviders(...args.slice(1));
} else if (args[0] === "install-cli") {
  if (!args[1]) throw new Error("Usage: control install-cli <oauth-provider>");
  await installProviderCli(args[1]);
} else if (args[0] === "login") {
  if (!args[1]) throw new Error("Usage: control login <oauth-provider>");
  await loginProvider(args[1]);
} else if (args[0] === "probe-provider") {
  if (!args[1]) {
    throw new Error("Usage: control probe-provider antigravity-oauth --live --yes [--provision-project]");
  }
  await probeProvider(args[1], args.slice(2));
} else if (args[0] === "catalog-cache") {
  if (args[1] !== "invalidate" || !args[2]) {
    throw new Error("Usage: control catalog-cache invalidate <provider>");
  }
  await invalidateProviderCatalog(args[2]);
} else if (args[0] === "credential") {
  if (!args[1]) throw new Error("Usage: control credential <provider> [--remove]");
  if (args.includes("--remove")) {
    await deleteProviderCredential(args[1]);
  } else {
    await saveProviderCredential(args[1]);
  }
} else if (args[0] === "key-pool") {
  if (!args[1]) throw new Error("Usage: control key-pool <provider> status|add|add-env|remove|delete|pause|resume|policy [credential-id|environment-name|strategy]");
  await handleProviderKeyPool(args[1], args[2], args[3]);
} else if (args[0] === "auth-mode") {
  await setLoginFreeMode(args[1]);
} else if (args[0] === "signed-routing") {
  await setSignedRouting(args[1]);
} else if (args[0] === "model-set") {
  await setLoginFreeModel(args[1]);
} else if (args[0] === "router-default") {
  await setRouterDefault(args[1], args[2]);
} else if (args[0] === "subagents") {
  await handleSubagents(args[1], args[2], args[3], args.slice(2));
} else if (args[0] === "tool-result-aging") {
  await handleToolResultAging(args[1], args[2], args.slice(2));
} else if (args[0] === "local-models") {
  await handleLocalModels(args[1], args[2], ...args.slice(3));
} else if (args[0] === "vision-bridge") {
  await handleVisionBridge(args[1] || "status", args[2], args[3]);
} else if (args[0] === "failover") {
  await handleFailover(args[1], ...args.slice(2));
} else if (args[0] === "picker") {
  await handlePicker(...pickerCommandArgs(args));
} else if (args[0] === "service") {
  handleService(args[1]);
} else if (args[0] === "native-redirect") {
  await handleNativeRedirect(args[1], args[2]);
} else if (args[0] === "chatgpt-session") {
  if (args.length > 2) throw new Error("Usage: control chatgpt-session status|enable|disable");
  await handleChatGptSession(args[1]);
} else if (args[0] === "chatgpt-account-pool") {
  await handleChatGptAccountSwitch(args[1], args[2], args[3]);
} else if (args[0] === "health") {
  await printHealth();
} else if (args[0] === "maintenance") {
  await updateAndVerifyCodex();
} else if (args[0] === "doctor") {
  runDoctor(args.slice(1));
} else {
  throw new Error(`Unknown command: ${args[0] || "(none)"}`);
}
