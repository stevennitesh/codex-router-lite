import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { CODEX_HOME, SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { codexExecutableIdentity, assertCodexExecutableIdentity } from "./codex-binary.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";
import { privateFileIsProtected, writePrivateFile } from "./file-security.mjs";
import { webBridgeSettingsWithRuntime } from "./chatgpt-web.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";
import { prepareRouterServiceMutation, resumeRouterAdmission } from "./service-drain.mjs";
import { inspectWebStopAdapterRuntimeRefresh, ownedWebStopAdapterEntry, withWebStopAdapterRuntimeRefresh } from "./web-stop-adapter-install.mjs";

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const DISCOVERY_ERROR = "Current official Web runtime anchors are missing, stale or ambiguous; supply --manifest <path> with the current signed runtime manifest.";

function localPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f"]/u.test(value)
      || /^(?:\\\\|\/\/)/u.test(value)) throw new Error(DISCOVERY_ERROR);
  return path.resolve(value);
}

function readRegular(file, maximum = 1024 * 1024) {
  file = localPath(file);
  for (let current = file; ; current = path.dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || current === file && (!stat.isFile() || stat.size > maximum)) throw new Error("Runtime refresh requires a bounded regular local file.");
    if (path.dirname(current) === current) break;
  }
  const before = lstatSync(file), bytes = readFileSync(file), after = lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Runtime refresh input changed while being read.");
  return bytes;
}

// Only the configured official MCP launch anchors select a runtime cohort.
// Cache timestamps and directory enumeration cannot establish host authority.
export function discoverWebRuntimeAnchors(options = {}) {
  const dependencies = options.dependencies ?? {};
  try {
    const configPath = localPath(options.configPath ?? path.join(options.codexHome ?? CODEX_HOME, "config.toml"));
    const configBytes = readRegular(configPath), document = scanTomlDocument(configBytes.toString("utf8"));
    const table = ["mcp_servers", "node_repl"], environment = [...table, "env"];
    const configuredCommand = localPath(tomlStringValue(document, table, "command"));
    const node = localPath(tomlStringValue(document, environment, "NODE_REPL_NODE_PATH"));
    const officialNodeRepl = path.join(path.dirname(node), "node_repl.exe");
    const version = tomlStringValue(document, environment, "BROWSER_USE_CODEX_APP_VERSION");
    const services = JSON.parse(tomlStringValue(document, environment, "NODE_REPL_TRUSTED_SERVICES") ?? "null");
    if (!object(services) || typeof version !== "string" || !/^\d+(?:\.\d+){2,3}$/u.test(version)
        || path.basename(node) !== "node.exe") throw new Error(DISCOVERY_ERROR);
    if (configuredCommand !== officialNodeRepl && configuredCommand !== ownedWebStopAdapterEntry({
      stateDir: options.stateDir ?? STATE_DIR, codexHome: options.codexHome ?? CODEX_HOME,
      dependencies: dependencies.adapter ?? dependencies })) throw new Error(DISCOVERY_ERROR);
    const browserService = localPath(services.browser), scripts = path.dirname(browserService);
    if (path.basename(browserService) !== "browser-service.mjs" || path.basename(scripts) !== "scripts"
        || path.basename(path.dirname(scripts)) !== version || path.basename(path.dirname(path.dirname(scripts))) !== "browser") throw new Error(DISCOVERY_ERROR);
    readRegular(browserService, 16 * 1024 * 1024);
    const runtimeModule = path.join(scripts, "browser-client.mjs");
    readRegular(runtimeModule, 16 * 1024 * 1024);
    const identity = (dependencies.codexIdentity ?? codexExecutableIdentity)();
    const officialCli = localPath(identity.binary);
    (dependencies.assertCodexIdentity ?? assertCodexExecutableIdentity)(identity);
    const sdkPackageJson = localPath(path.join(options.sourceRoot ?? SOURCE_ROOT, "node_modules", "@modelcontextprotocol", "sdk", "package.json"));
    readRegular(sdkPackageJson);
    return { anchors: { node, officialCli, officialNodeRepl, runtimeModule, sdkPackageJson },
      assertCurrent() {
        if (hash(readRegular(configPath)) !== hash(configBytes)) throw new Error("Official MCP runtime configuration changed during refresh; retry.");
        (dependencies.assertCodexIdentity ?? assertCodexExecutableIdentity)(identity);
      } };
  } catch (cause) {
    throw Object.assign(new Error(DISCOVERY_ERROR, { cause }), { code: "ERR_WEB_RUNTIME_ANCHORS" });
  }
}

function context(options) {
  const dependencies = options.dependencies ?? {}, stateDir = localPath(options.stateDir ?? STATE_DIR);
  return { stateDir, settingsPath: path.join(stateDir, "chatgpt-web.json"),
    adapterOptions: { stateDir, codexHome: options.codexHome ?? CODEX_HOME,
      allowThreadScopeChange: options.replaceAdapter === true,
      dependencies: dependencies.adapter ?? dependencies },
    private: dependencies.isPrivate ?? privateFileIsProtected,
    write: dependencies.writePrivate ?? writePrivateFile,
    catalogLock: dependencies.catalogLock ?? (operation => withCatalogPublicationLock(operation, { stateDir })),
    serviceLock: dependencies.serviceLock ?? (operation => withServiceOperationLock(operation, { stateDir })),
    drain: dependencies.drain ?? prepareRouterServiceMutation,
    resume: dependencies.resume ?? resumeRouterAdmission,
    restart: dependencies.restart ?? (async () => (await import("./service.mjs")).runServiceCommandUnlocked("restart", ["restart"], { quiet: true })) };
}

function savedSettings(ctx) {
  const text = readRegular(ctx.settingsPath, 65_536).toString("utf8");
  if (!ctx.private(ctx.settingsPath)) throw new Error("Saved Web bridge settings are not private.");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Cannot refresh invalid Web bridge settings."); }
  if (value?.enabled !== true) throw new Error("Runtime refresh requires the configured enabled Web browser integration.");
  return { text, value };
}

function compareSettings(ctx, expected, next) {
  if (savedSettings(ctx).text !== expected) throw new Error("Saved Web bridge settings changed; foreign changes were preserved.");
  if (expected !== next) ctx.write(ctx.settingsPath, next);
  if (savedSettings(ctx).text !== next) throw new Error("Web runtime settings readback failed.");
}

function confirmedIdleDrain(drain) {
  if (drain?.status === "offline") return true;
  const state = drain?.webRuntime;
  return ["drained", "forced"].includes(drain?.status) && object(state) && state.known === true
    && [state.activeTurns, state.uncertainSends, state.unresolvedActions].every(count => Number.isSafeInteger(count) && count === 0);
}

function prepare(ctx, options) {
  const before = savedSettings(ctx);
  const discovery = options.manifestPath ? null : (options.dependencies?.discover ?? discoverWebRuntimeAnchors)(options);
  const adapter = inspectWebStopAdapterRuntimeRefresh({ ...ctx.adapterOptions,
    ...(options.manifestPath ? { manifestPath: localPath(options.manifestPath) } : { anchors: discovery.anchors }) });
  const nextValue = webBridgeSettingsWithRuntime(before.value, adapter.candidate.runtimeModule), nextText = json(nextValue);
  // Formatting and retired ignored fields alone do not require a rewrite.
  const settingsChanged = before.value.browser?.runtimeModule !== nextValue.browser.runtimeModule;
  const changed = settingsChanged || adapter.generation !== adapter.candidateGeneration || adapter.cliSelectionChanged;
  const plan = { mode: "plan", ready: true, changed,
    browserRuntimeChanged: settingsChanged, adapterGenerationChanged: adapter.generation !== adapter.candidateGeneration,
    cliSelectionChanged: adapter.cliSelectionChanged,
    currentAdapterGeneration: adapter.generation, candidateAdapterGeneration: adapter.candidateGeneration,
    currentBrowserRuntime: before.value.browser?.runtimeModule,
    candidate: { officialCli: adapter.candidate.officialCli.path, node: adapter.candidate.node.path,
      officialNodeRepl: adapter.candidate.officialNodeRepl.path, runtimeModule: adapter.candidate.runtimeModule,
      sdkPackageJson: adapter.candidate.sdkPackageJson },
    threadScope: adapter.candidate.threadIds === null ? "ordinary Web conversations" : "selected trial threads",
    routerRestartRequired: changed, codexRestartRequired: changed, hookDefinition: "preserved", tunnelConfiguration: "preserved",
    next: changed ? "Apply with --apply to drain Router work, refresh both runtime selections and reload Router; then fully quit and reopen Codex normally."
      : "Configured runtime selections match the current candidate; no refresh is needed." };
  return { before, nextText: settingsChanged ? nextText : before.text, adapter, discovery, plan };
}

export async function refreshWebRuntime(options = {}) {
  if (options.forceServiceReplacement === true && !options.apply) throw new Error("Forced service replacement requires --apply.");
  const ctx = context(options);
  let prepared;
  try { prepared = prepare(ctx, options); }
  catch (cause) { if (cause instanceof SyntaxError) throw new Error("Web runtime refresh metadata contains invalid JSON.", { cause }); throw cause; }
  if (!options.apply) return prepared.plan;
  if (!prepared.plan.changed) return { ...prepared.plan, mode: "applied", applied: false, routerReloaded: false };
  return ctx.serviceLock(async () => {
    // Fail before draining when another command changed any prepared authority.
    prepared.discovery?.assertCurrent();
    if (savedSettings(ctx).text !== prepared.before.text) throw new Error("Saved Web bridge settings changed; retry runtime refresh.");
    let drain, settingsAttempted = false, restartAttempted = false, settingsRestored = true, rollbackAllowed = true;
    try {
      drain = await ctx.drain({ force: options.forceServiceReplacement === true });
      if (!confirmedIdleDrain(drain)) throw new Error("Router did not confirm a known idle Web runtime; update and reload Router before applying runtime refresh. No runtime selection was changed.");
      const result = await withWebStopAdapterRuntimeRefresh({ ...ctx.adapterOptions,
        ...(options.manifestPath ? { manifestPath: localPath(options.manifestPath) } : { manifest: prepared.adapter.manifest }),
        expected: prepared.adapter }, async adapter => {
        try {
          prepared.discovery?.assertCurrent();
          await ctx.catalogLock(() => {
            settingsAttempted = true;
            compareSettings(ctx, prepared.before.text, prepared.nextText);
          });
          restartAttempted = true;
          if (await ctx.restart() !== 0) throw new Error("Router reload failed after runtime refresh.");
          if (savedSettings(ctx).text !== prepared.nextText) throw new Error("Web settings changed during Router reload; foreign changes were preserved.");
          const current = inspectWebStopAdapterRuntimeRefresh({ ...ctx.adapterOptions,
            ...(options.manifestPath ? { manifestPath: localPath(options.manifestPath) } : { manifest: prepared.adapter.manifest }) });
          if (current.generation !== prepared.adapter.candidateGeneration || current.candidateGeneration !== prepared.adapter.candidateGeneration) throw new Error("Adapter runtime ownership changed during Router reload.");
          prepared.discovery?.assertCurrent();
          return adapter;
        } catch (cause) {
          if (restartAttempted) {
            try {
              const recoveryDrain = await ctx.drain({ force: false });
              if (!confirmedIdleDrain(recoveryDrain)) throw new Error("Known idle Web runtime recovery drain was not confirmed.");
            } catch {
              rollbackAllowed = false;
              const failure = new Error("Router reload did not verify, and active or unknown work prevented rollback. The refreshed runtime was retained; retry after work finishes.", { cause });
              failure.runtimeRefreshRollbackAllowed = false;
              throw failure;
            }
          }
          if (settingsAttempted) {
            try {
              await ctx.catalogLock(() => {
                // A protected write can fail before publication. Recognize the
                // unchanged snapshot before deciding that compensation lost CAS.
                if (savedSettings(ctx).text !== prepared.before.text) compareSettings(ctx, prepared.nextText, prepared.before.text);
              });
            }
            catch { settingsRestored = false; }
          }
          if (!settingsRestored) {
            rollbackAllowed = false;
            const failure = new Error("Web runtime refresh failed; rollback incomplete because Web settings changed or could not be restored. The refreshed adapter and foreign settings were preserved.", { cause });
            failure.runtimeRefreshRollbackAllowed = false;
            throw failure;
          }
          throw cause;
        }
      });
      return { ...prepared.plan, mode: "applied", applied: true, routerRestartRequired: false,
        routerReloaded: true, adapterGeneration: path.basename(result.managedDirectory),
        next: "Fully quit and reopen Codex normally to load the refreshed adapter. Existing hook trust is retained; verify Stop and same-chat continuation." };
    } catch (cause) {
      let recovery = "not needed";
      if (!rollbackAllowed) recovery = "refreshed runtime retained; rollback deferred; admission not resumed";
      else if (restartAttempted && settingsRestored) {
        try { recovery = await ctx.restart() === 0 ? "prior runtime reloaded" : "prior runtime reload failed"; }
        catch { recovery = "prior runtime reload failed"; }
      } else if (["drained", "forced"].includes(drain?.status)) {
        try { await ctx.resume(); recovery = "admission resumed"; }
        catch { recovery = "admission resume failed"; }
      }
      const error = new Error(`Web runtime refresh failed. Router recovery: ${recovery}. ${cause.message}`, { cause });
      error.code = cause.code ?? "ERR_WEB_RUNTIME_REFRESH";
      throw error;
    }
  });
}
