import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { antigravityOAuthStatus } from "./antigravity-oauth-status.mjs";
import { LISTED_MODELS, PROVIDERS, providerNeedsNoKey } from "./model-registry.mjs";
import { ensureNodeDependencies, isNodeDependencyFailure } from "./node-dependency-install.mjs";
import { effectiveVisibleModels, setModelSelection } from "./model-picker-state.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { SOURCE_ROOT } from "./paths.mjs";
import { effectiveProviderCredentialStatus } from "./provider-api-key-routing.mjs";
import {
  installOauthCli,
  oauthCliPath,
  oauthLoginArgs,
  providerOnboardingSnapshot,
} from "./provider-onboarding.mjs";
import {
  renderModelChoices,
  renderProviderChoices,
  stepHeader,
  toggleSelection,
} from "./setup-ui.mjs";
import {
  canonicalProviderId,
  defaultProviderIds,
  selectedConfiguredListedModels,
  validateProviderIds,
  writeProviderSelection,
} from "./provider-selection.mjs";
import { writeDiscoveryMode } from "./discovery-mode.mjs";
import { resolveVisionEngine } from "./vision-bridge.mjs";
import {
  readVisionBridgeSettings,
  visionBridgeConfigured,
} from "./vision-bridge-state.mjs";
import {
  operationDeadlineFromEnvironment,
  remainingOperationMs,
} from "./process-tree.mjs";

const args = process.argv.slice(2);
const guided = args.includes("--guided");
const adoptNativeCatalog = args.includes("--adopt-native-catalog");
const runSmoke = args.includes("--smoke-test");
const selectionOnly = args.includes("--selection-only");
const noProvider = args.includes("--no-provider");
const noDiscovery = args.includes("--no-discovery");

const flagOptions = new Set([
  "--guided",
  "--auto",
  "--adopt-native-catalog",
  "--smoke-test",
  "--selection-only",
  "--no-provider",
  "--no-discovery",
  "--help",
]);
let setupArgumentError;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
    if (argument === "--providers") {
    if (!args[index + 1] || args[index + 1].startsWith("--")) {
      setupArgumentError = "--providers requires a comma-separated value.";
      break;
    }
    index += 1;
  } else if (!flagOptions.has(argument)) {
    setupArgumentError = `Unknown setup option: ${argument}`;
    break;
  }
}
// An idle install is exactly "no providers": naming providers, answering the
// guided picker, or pasting keys alongside it is a contradiction to report,
// not to guess about. And --no-discovery without --no-provider would select
// providers that can never authenticate, so the narrower flag requires the
// wider one.
if (!setupArgumentError && noProvider && (guided || args.includes("--providers"))) {
  setupArgumentError = `--no-provider cannot be combined with ${
    guided ? "--guided" : "--providers"
  }.`;
}
if (!setupArgumentError && noDiscovery && !noProvider) {
  setupArgumentError = "--no-discovery requires --no-provider.";
}
// Children (bin/install, the catalog build, the doctor) must honor the choice
// before the marker file exists -- and a re-run without the flag must clear a
// stale environment value just as writeDiscoveryMode clears the marker.
process.env.CODEX_ROUTER_NO_DISCOVERY = noDiscovery ? "1" : "0";
if (!setupArgumentError && process.platform !== "win32") {
  setupArgumentError = "Codex Router setup supports Windows only.";
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// The installers update the managed checkout before running setup and roll it
// back when setup fails, which protects the running service from half-applied
// code. A declined prompt or an unconfigured provider says nothing about the
// new code, so rolling back there strands the user on the old revision and
// discards the very fix they were updating for. Exit 2 marks "the checkout is
// healthy, configuration is unfinished" and the installers keep the update.
// Any other non-zero exit still rolls back, so an unrecognized failure keeps
// the conservative behaviour.
// Not exported: importing this module runs setup, so the value is asserted
// from the outside by spawning the script.
const SETUP_INCOMPLETE_EXIT = 2;

function incomplete(message) {
  return Object.assign(new Error(message), { setupExitCode: SETUP_INCOMPLETE_EXIT });
}

if (args.includes("--help")) {
  process.stdout.write(`Usage: setup [options]

Guided, credential-safe Codex Router setup.

Options:
  --guided             Ask provider and model questions interactively
  --auto               Use already configured credentials (default)
  --providers LIST     Comma-separated provider ids
  --adopt-native-catalog  Use an existing user-owned native Codex catalog as the merge base
  --smoke-test         Make one small live request per enabled provider
  --selection-only     Save provider selection without installing (development)
  --no-provider        Install idle, with no provider selected or configured
  --no-discovery       With --no-provider: never read credentials, the
                       Keychain, or other CLIs' sessions; refuse traffic locally
  --help               Show this help

Providers: ${[...PROVIDERS.values()].filter((provider) => !provider.variantOf).map((provider) => provider.id).join(", ")}
`);
  process.exit(0);
}

function promptLine(label, defaultValue = "") {
  if (process.platform === "win32") {
    const prompt = `${label}${defaultValue ? ` [${defaultValue}]` : ""}`;
    const script = "$answer = Read-Host $env:CODEX_ROUTER_PROMPT_LABEL; [Console]::Out.Write($answer)";
    let lastError;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        const answer = execFileSync(
          executable,
          ["-NoLogo", "-NoProfile", "-Command", script],
          {
            encoding: "utf8",
            env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: prompt },
            stdio: ["inherit", "pipe", "inherit"],
          },
        ).trim();
        return answer || defaultValue;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("PowerShell is required for guided setup on Windows.");
  }
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch {
    throw incomplete("Interactive setup requires a terminal; use --providers for automatic setup.");
  }
  try {
    writeSync(descriptor, `${label}${defaultValue ? ` [${defaultValue}]` : ""}: `);
    const chunks = [];
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      chunks.push(Buffer.from(byte));
    }
    writeSync(descriptor, "\n");
    return Buffer.concat(chunks).toString("utf8").trim() || defaultValue;
  } finally {
    closeSync(descriptor);
  }
}

function confirm(label, defaultYes = true) {
  const answer = promptLine(`${label} ${defaultYes ? "[Y/n]" : "[y/N]"}`).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function providerConfigured(provider) {
  if (provider.kind === "oauth") {
    if (provider.id === "kimi-oauth") return kimiOAuthStatus().configured;
    if (provider.id === "grok-oauth") return grokOAuthStatus().configured;
    if (provider.id === "antigravity-oauth") return antigravityOAuthStatus().configured;
    return false;
  }
  return providerNeedsNoKey(provider)
    ? true
    : effectiveProviderCredentialStatus(provider, { persistent: true }).configured;
}

const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function guidedSelection() {
  const snapshots = providerOnboardingSnapshot().providers;
  let selected = new Set(
    snapshots
      .map((snapshot, index) => (snapshot.action === "ready" ? index + 1 : undefined))
      .filter(Boolean),
  );
  if (selected.size === 0) selected = new Set([1]);
  process.stdout.write("\nChoose the providers to show in Codex:\n");
  for (;;) {
    process.stdout.write(`${renderProviderChoices(snapshots, selected, colorEnabled)}\n`);
    const raw = promptLine("Toggle numbers (comma-separated), a=all, n=none; Enter to continue");
    const result = toggleSelection(selected, raw, snapshots.length);
    selected = result.selected;
    if (result.error) {
      process.stdout.write(`${result.error}\n`);
    } else if (result.done) {
      break;
    }
  }
  return validateProviderIds(
    [...selected].sort((a, b) => a - b).map((position) => snapshots[position - 1].id),
  );
}

function requestedSelection() {
  // The idle install asks for nothing, so nothing is scanned to find it: the
  // defaultProviderIds() fallback below is itself a full credential sweep.
  if (noProvider) return [];
  const requested = option("--providers");
  if (requested) {
    if (requested === "configured") return defaultProviderIds();
    if (requested === "all") return [...PROVIDERS.keys()];
    return validateProviderIds(requested.split(","));
  }
  return guided ? guidedSelection() : defaultProviderIds();
}

function guidedModelSelection(providers) {
  const selectedProviders = new Set(providers);
  const models = LISTED_MODELS.filter((model) =>
    selectedProviders.has(canonicalProviderId(model.provider))
  );
  if (models.length === 0) {
    process.stdout.write("\nThe selected providers have no preselected models.\n");
    return { models, selectedSlugs: [] };
  }

  // Pre-check what the picker is showing right now, which on a machine that
  // has never had one is nothing: router models are opt-in, and enabling a
  // provider must not put its whole catalog in the picker on one keystroke
  // (the policy `src/catalog.mjs` states at its `seedModelsHidden` call). On a
  // re-run this is instead the operator's existing picker, so pressing Enter
  // through this step changes nothing.
  const visible = effectiveVisibleModels(models.map((model) => model.slug));
  let selected = new Set(
    models
      .map((model, index) => (visible.has(model.slug) ? index + 1 : undefined))
      .filter(Boolean),
  );
  process.stdout.write("\nChoose models from the selected providers:\n");
  for (;;) {
    process.stdout.write(`${renderModelChoices(models, selected)}\n`);
    const raw = promptLine(
      "Toggle model numbers (comma-separated), a=all, n=none; Enter to continue",
    );
    const result = toggleSelection(selected, raw, models.length, { allowEmpty: true });
    selected = result.selected;
    if (result.error) {
      process.stdout.write(`${result.error}\n`);
    } else if (result.done) {
      break;
    }
  }
  return {
    models,
    selectedSlugs: [...selected]
      .sort((a, b) => a - b)
      .map((position) => models[position - 1].slug),
  };
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${path.basename(command)} exited with status ${result.status}.`);
  }
  return result.status ?? 1;
}

function oauthSetupHint(provider) {
  if (provider.id === "grok-oauth") return "run `grok login --oauth`";
  if (provider.id === "antigravity-oauth") {
    const command = process.platform === "win32"
      ? ".\\model-router.ps1 providers login antigravity-oauth"
      : "./bin/providers login antigravity-oauth";
    const probe = process.platform === "win32"
      ? ".\\model-router.ps1 providers probe antigravity-oauth --live --yes"
      : "./bin/providers probe antigravity-oauth --live --yes";
    return `run \`${command}\`, then explicitly run \`${probe}\` after reviewing its quota cost`;
  }
  return "run `kimi login`";
}

async function configureProvider(provider) {
  if (providerConfigured(provider)) return;
  if (!guided) {
    const setup =
      provider.kind === "oauth"
        ? oauthSetupHint(provider)
        : `run \`./bin/provider-key ${provider.id} set\``;
    throw incomplete(`${provider.displayName} is selected but not configured; ${setup} first.`);
  }
  if (provider.kind === "oauth") {
    if (provider.id === "antigravity-oauth") {
      if (!confirm(`Open a browser to sign in to ${provider.displayName} now?`)) {
        throw incomplete(`${provider.displayName} sign-in was cancelled.`);
      }
      const deadline = operationDeadlineFromEnvironment(process.env, {
        timeoutMs: 10 * 60_000,
        maximumMs: 10 * 60_000,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => {
        const error = new Error("Antigravity OAuth setup exceeded its absolute deadline.");
        error.code = "router_operation_timeout";
        controller.abort(error);
      }, remainingOperationMs(deadline));
      timer.unref?.();
      try {
        // Dependency setup and the browser callback share one deadline so a
        // wedged npm child cannot consume an unbounded pre-auth phase or fail
        // the setup only after the operator has authorized Google.
        await ensureNodeDependencies({ signal: controller.signal, deadline });
        const { signInAntigravity } = await import("./antigravity-oauth-onboarding.mjs");
        await signInAntigravity({ signal: controller.signal, deadline });
      } finally {
        clearTimeout(timer);
      }
      const status = antigravityOAuthStatus();
      if (!status.signedIn) {
        throw incomplete(`${provider.displayName} sign-in did not produce a usable credential.`);
      }
      if (!status.configured) {
        const probe = process.platform === "win32"
          ? ".\\model-router.ps1 providers probe antigravity-oauth --live --yes"
          : "./bin/providers probe antigravity-oauth --live --yes";
        throw incomplete(
          `${provider.displayName} is signed in but remains disabled until the explicit live compatibility test succeeds; run \`${probe}\` after reviewing its quota cost.`,
        );
      }
      return;
    }
    let cli = oauthCliPath(provider.id);
    if (!cli) {
      if (!confirm(`Install the official ${provider.displayName} CLI with npm now?`)) {
        throw incomplete(
          `${provider.displayName} needs its official CLI; install it and run setup again.`,
        );
      }
      installOauthCli(provider.id);
      cli = oauthCliPath(provider.id);
    }
    if (!confirm(`Sign in to ${provider.displayName} now?`)) {
      throw incomplete(`${provider.displayName} sign-in was cancelled.`);
    }
    run(cli, oauthLoginArgs(provider.id));
    if (!providerConfigured(provider)) {
      throw incomplete(`${provider.displayName} sign-in did not produce a usable credential.`);
    }
  } else {
    if (["anonymous", "per-model"].includes(provider.authMode)) return;
    const prompt = provider.credential?.prompt || `${provider.displayName} API key`;
    if (!confirm(`Enter ${prompt} securely now?`)) {
      throw incomplete(`${provider.displayName} setup was cancelled.`);
    }
    await ensureNodeDependencies();
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "provider-key.mjs"), provider.id, "set"]);
  }
}

async function main() {
  if (setupArgumentError) throw incomplete(setupArgumentError);
  const stepTitles = ["Choose providers"];
  if (guided) stepTitles.push("Choose models");
  stepTitles.push("Connect credentials");
  stepTitles.push("Review and install");
  let stepIndex = 0;
  const nextStep = (title) => {
    stepIndex += 1;
    if (guided) process.stdout.write(stepHeader(stepIndex, stepTitles.length, title));
  };

  nextStep("Choose providers");
  // A bad --providers value is a mistake in the invocation, not in the code
  // that was just pulled.
  let providers;
  try {
    providers = requestedSelection();
  } catch (error) {
    throw error?.setupExitCode
      ? error
      : incomplete(error instanceof Error ? error.message : String(error));
  }
  if (providers.length === 0 && !noProvider) {
    throw incomplete(
      "No configured provider was found. Run `./bin/setup --guided` or pass `--providers` after configuring credentials.",
    );
  }
  let modelChoices = [];
  let selectedModelSlugs = [];
  if (guided) {
    nextStep("Choose models");
    ({ models: modelChoices, selectedSlugs: selectedModelSlugs } =
      guidedModelSelection(providers));
  }
  nextStep("Connect credentials");
  // Credentials are addable after the install, and the router already reports
  // an unconfigured provider clearly at request time. A declined prompt -- or
  // a prompt that is itself broken, which is how a Windows key-entry bug took
  // whole installations down -- must not abort the install and hand the
  // checkout back to the rollback. Guided runs collect the gaps and report
  // them; scripted runs stay strict so automation still fails loudly.
  const pendingCredentials = [];
  for (const id of providers) {
    const provider = PROVIDERS.get(id);
    try {
      await configureProvider(provider);
    } catch (error) {
      if (!guided) throw error;
      // The leniency above is about credential prompts. A dependency install
      // that failed has emptied node_modules, so nothing later in this run
      // works and no key the user could add afterwards would fix it; reporting
      // it as "this provider still needs a credential" sends them after the
      // wrong thing. Let it out so the installer restores the checkout.
      if (isNodeDependencyFailure(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      pendingCredentials.push({
        provider,
        reason,
        // A normal API provider can remain selected while waiting for a key;
        // Antigravity cannot: sign-in alone is deliberately insufficient and
        // its explicit quota-consuming proof has deterministically not passed.
        withdrawn: provider.id === "antigravity-oauth",
      });
      process.stderr.write(`\nWarning: ${provider.displayName} was not configured (${reason})\n`);
      if (provider.id === "antigravity-oauth") {
        process.stderr.write(
          "Antigravity remains unselected until its explicit live proof succeeds and the router confirms its forwarder.\n",
        );
      }
    }
  }
  const withdrawnProviders = new Set(
    pendingCredentials.filter(({ withdrawn }) => withdrawn).map(({ provider }) => provider.id),
  );
  if (withdrawnProviders.size) {
    providers = providers.filter((id) => !withdrawnProviders.has(id));
    const withdrawnModelSlugs = new Set(
      modelChoices
        .filter((model) => withdrawnProviders.has(canonicalProviderId(model.provider)))
        .map((model) => model.slug),
    );
    selectedModelSlugs = selectedModelSlugs.filter((slug) => !withdrawnModelSlugs.has(slug));
  }
  writeProviderSelection(providers);
  // Written on every run, not only idle ones: re-running setup without
  // --no-discovery is the exit path from idle mode, so a normal install must
  // clear the marker just as an idle install sets it.
  writeDiscoveryMode(noDiscovery);

  // Pasted images just work for text-only models: the bridge is on by default,
  // so the installer no longer writes anything here. It used to auto-enable
  // once when a vision-capable provider happened to be selected, which both
  // left the state file's mere presence meaning "the installer ran" and left
  // every other install needing a command nobody knew about. Reporting is all
  // that is left to do -- and only for an install that has not answered the
  // question itself, so a re-run never claims credit for a machine the operator
  // already configured.
  const visionBridge = visionBridgeConfigured()
    ? undefined
    : {
        enabled: readVisionBridgeSettings().enabled,
        engine:
          resolveVisionEngine(
            () => selectedConfiguredListedModels(),
            readVisionBridgeSettings(),
          )?.slug || null,
      };

  if (selectionOnly) {
    process.stdout.write(
      `${JSON.stringify({ providers, ...(guided ? { models: selectedModelSlugs } : {}) }, null, 2)}\n`,
    );
    return;
  }

  nextStep("Review and install");
  if (guided) {
    process.stdout.write(
      `\nReady to install:\n` +
        `  Providers: ${providers.length ? providers.join(", ") : "none (idle install)"}\n` +
        `  Models: ${selectedModelSlugs.length ? selectedModelSlugs.join(", ") : "none"}\n` +
        `  Native catalog: ${adoptNativeCatalog ? "adopt existing user catalog" : "capture from Codex"}\n` +
        `  Changes: Windows per-user background service and the managed Codex config block\n`,
    );
    if (!confirm("Proceed?")) {
      throw incomplete("Setup was cancelled before installing the service.");
    }
  }

  // Below the confirmation, and below the `--selection-only` return above it:
  // model visibility is the operator's existing configuration, so a cancelled
  // setup and a selection-only run must both leave `model-picker.json` exactly
  // as they found it. Steps that only report a choice may run before the
  // answer; the step that rewrites protected state may not.
  if (guided) {
    setModelSelection(modelChoices.map((model) => model.slug), selectedModelSlugs);
  }

  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(SOURCE_ROOT, "install.ps1"),
    "-CheckoutInstall",
    ...(adoptNativeCatalog ? ["-AdoptNativeCatalog"] : []),
  ]);

  if (runSmoke || (guided && confirm("Run one small live request per enabled provider?", false))) {
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "smoke-test.mjs"), "--yes"]);
  }
  run(process.execPath, [path.join(SOURCE_ROOT, "src", "doctor.mjs")]);
  const providerSummary = providers.length
    ? providers.join(", ")
    : "no providers (idle install; traffic gets a local error until one is enabled)";
  process.stdout.write(
    `\nCodex Router is ready with: ${providerSummary}\nFully quit Codex, reopen it, and start a new task.\n`,
  );
  if (visionBridge?.enabled && visionBridge.engine) {
    process.stdout.write(
      `\nVision: text-only models can now read pasted images, via ${visionBridge.engine}.\n` +
        `  It spends that provider's quota. Turn it off with: ./bin/control vision-bridge off\n`,
    );
  } else if (visionBridge?.enabled) {
    process.stdout.write(
      `\nVision: no enabled provider offers a model that reads images.\n` +
        `  Signed in to ChatGPT? Codex's own vision model will read them, on the plan you already pay for.\n` +
        `  Otherwise, free local option: ./bin/control vision-bridge setup   (uses a small local model)\n`,
    );
  }
  if (pendingCredentials.length) {
    const retainedPending = pendingCredentials.filter(({ withdrawn }) => !withdrawn);
    const withdrawnPending = pendingCredentials.filter(({ withdrawn }) => withdrawn);
    process.stdout.write(
      `\nStill needs provider setup:\n` +
        pendingCredentials
          .map(({ provider }) => {
            if (provider.kind === "oauth") {
              return `  ${provider.displayName}: ${oauthSetupHint(provider)}\n`;
            }
            const key = `./bin/provider-key ${provider.id} set`;
            return `  ${provider.displayName}: ${key}\n`;
          })
          .join("") +
        (retainedPending.length
          ? "Providers waiting only for a credential stay selected and start working as soon as it is stored.\n"
          : "") +
        (withdrawnPending.length
          ? "Antigravity remains unselected until its explicit live proof succeeds and the router confirms its forwarder.\n"
          : ""),
    );
  }
}

main().catch((error) => {
  console.error(`codex-router setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error?.setupExitCode || 1);
});
