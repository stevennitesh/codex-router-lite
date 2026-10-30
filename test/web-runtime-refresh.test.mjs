import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installWebStopAdapter, rollbackWebStopAdapter } from "../src/web-stop-adapter-install.mjs";
import { discoverWebRuntimeAnchors, refreshWebRuntime, inspectWebRuntimeMaintenance } from "../src/web-runtime-refresh.mjs";
import { createAdapterHook } from "../src/web-stop-contract.mjs";
import { runWebMaintenance } from "../maintenance/web-runtime-maintenance.mjs";

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash("sha256").update(value).digest("hex");
const signature = { status: "Valid", signerSubject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"', signerThumbprint: "fixture-signer" };
const idleDrain = (status = "drained") => ({ status, webRuntime: { known: true, activeTurns: 0, uncertainSends: 0, unresolvedActions: 0 } });

function fixture(t, { threadIds = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-web-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
  const stateDir = path.join(root, "state"), codexHome = path.join(root, "codex-home"), sourceDir = path.join(root, "src");
  for (const directory of [stateDir, codexHome, sourceDir]) mkdirSync(directory);
  for (const [name, contents] of Object.entries({
    "web-stop-adapter.mjs": 'import "./web-browser.mjs"; import "./web-stop-hook.mjs"; import "./web-stop-contract.mjs";\n',
    "web-browser.mjs": 'import "./web-browser-state.mjs"; export const browser = true;\n',
    "web-stop-hook.mjs": 'import "./web-browser-state.mjs"; export const hook = true;\n',
    "web-browser-state.mjs": "export const state = true;\n",
    "web-stop-contract.mjs": "export const contract = true;\n",
    "web-stop-adapter-entry.cs": 'class Entry { string Node = @"@@NODE@@", Adapter = @"@@ADAPTER@@", Config = @"@@CONFIG@@"; }\n',
  })) write(path.join(sourceDir, name), contents);
  const runtime = name => {
    const directory = path.join(root, name), manifest = { version: 1, threadIds };
    for (const [field, basename] of [["node", "node.exe"], ["officialCli", "codex.exe"], ["officialNodeRepl", "node_repl.exe"]]) {
      const file = path.join(directory, "bin", basename), contents = `signed ${name} ${basename}`;
      write(file, contents); manifest[field] = { path: file, sha256: hash(contents), authenticode: signature };
    }
    manifest.runtimeModule = path.join(directory, "browser", name === "old" ? "26.1001.1" : "26.1016.1", "scripts", "browser-client.mjs");
    write(manifest.runtimeModule, `export const ${name} = true;\n`);
    write(path.join(path.dirname(manifest.runtimeModule), "browser-service.mjs"), "export const service = true;\n");
    manifest.sdkPackageJson = path.join(root, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
    write(manifest.sdkPackageJson, json({ name: "@modelcontextprotocol/sdk", version: "fixture" }));
    return manifest;
  };
  const old = runtime("old"), current = runtime("current"), effects = [];
  const environment = { values: { CODEX_CLI_PATH: null, CODEX_NODE_REPL_PATH: null },
    readPair() { return structuredClone(this.values); },
    compareExchangePair(expected, values) {
      assert.deepEqual(this.values, expected); effects.push("environment"); this.values = structuredClone(values);
      return { broadcast: true };
    } };
  const adapter = { sourceDir, environment, isPrivate: () => true,
    inspectSignatures: paths => paths.map(file => ({ path: file, ...signature })),
    compileEntry(_source, output) { effects.push("compile"); write(output, "unsigned fixture launcher"); },
    writePrivate(file, contents) { effects.push(`adapter:${path.basename(file)}`); write(file, contents); } };
  const oldManifestPath = path.join(root, "old-manifest.json"), manifestPath = path.join(root, "current-manifest.json");
  write(oldManifestPath, json(old)); write(manifestPath, json(current));
  const adapterOptions = { stateDir, codexHome, dependencies: adapter };
  installWebStopAdapter({ ...adapterOptions, manifestPath: oldManifestPath });
  const receiptPath = path.join(stateDir, "web-stop-adapter", "ownership.json"), hooksPath = path.join(codexHome, "hooks.json");
  const configPath = path.join(codexHome, "config.toml");
  const saveConfig = ({ node = current.node.path, server = current.officialNodeRepl.path, version = "26.1016.1",
    service = path.join(path.dirname(current.runtimeModule), "browser-service.mjs") } = {}) => write(configPath,
    `[mcp_servers.node_repl]\ncommand = '${server}'\n[mcp_servers.node_repl.env]\nNODE_REPL_NODE_PATH = '${node}'\nBROWSER_USE_CODEX_APP_VERSION = '${version}'\nNODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({ browser: service.replaceAll("\\", "/") })}'\n`);
  saveConfig();
  const settings = { version: 1, enabled: true, capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: true },
    browser: { runtimeModule: old.runtimeModule, pluginName: "Private fixture connector", pluginAppId: "asdk_app_fixture", pluginSelectionButtonName: "Fixture connector, Connectors" },
    tunnel: { id: "tunnel_fixture", executable: path.join(root, "tunnel.exe") }, mcpPort: 25999 };
  write(settings.tunnel.executable, "inert tunnel fixture");
  const settingsPath = path.join(stateDir, "chatgpt-web.json"), keyPath = path.join(stateDir, "chatgpt-web-runtime-key.secret");
  write(settingsPath, json(settings)); write(keyPath, "private-fixture-key\n");
  // The supported repair must not inspect deleted old official app files.
  rmSync(path.join(root, "old"), { recursive: true });
  let serviceHeld = false, catalogHeld = false;
  const dependencies = { adapter, isPrivate: () => true,
    assertProcessesAbsent() {}, // Policy fixtures; real Windows census has separate coverage.
    async assertClosedAdmission() {},
    writePrivate(file, contents) { effects.push("settings"); write(file, contents); },
    codexIdentity: () => ({ binary: current.officialCli.path, version: "fixture", fingerprint: "fixture-fingerprint" }),
    assertCodexIdentity(identity) { assert.equal(identity.binary, current.officialCli.path); },
    async serviceLock(operation) { assert.equal(serviceHeld, false); serviceHeld = true; try { return await operation(); } finally { serviceHeld = false; } },
    async catalogLock(operation) { assert.equal(catalogHeld, false); catalogHeld = true; try { return await operation(); } finally { catalogHeld = false; } },
    async drain({ force }) { assert.equal(serviceHeld, true); assert.equal(force, false); effects.push("drain"); return idleDrain(); },
    async restart() { assert.equal(catalogHeld, false, "release catalog publication before Router startup"); assert.equal(serviceHeld, true); effects.push("restart"); return 0; },
    async resume() { effects.push("resume"); } };
  const options = { stateDir, codexHome, sourceRoot: root, dependencies };
  const snapshot = () => ({ settings: readFileSync(settingsPath, "utf8"), receipt: readFileSync(receiptPath, "utf8"), hooks: readFileSync(hooksPath, "utf8"),
    environment: structuredClone(environment.values), key: readFileSync(keyPath, "utf8") });
  return { root, stateDir, codexHome, sourceDir, configPath, settingsPath, receiptPath, hooksPath, keyPath, current, old, manifestPath, settings, options,
    adapterOptions, dependencies, environment, effects, write, saveConfig, snapshot };
}

function retainLegacyHook(f) {
  const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8")), hooks = JSON.parse(readFileSync(f.hooksPath, "utf8"));
  const hook = { ...createAdapterHook(), timeout: 10 };
  receipt.hook = hook; hooks.hooks.Interrupt[0].hooks[0] = hook;
  f.write(f.receiptPath, json(receipt)); f.write(f.hooksPath, json(hooks));
}

test("runtime refresh plans from exact official MCP anchors with no mutation even when old app files are deleted", async t => {
  const f = fixture(t), before = f.snapshot(), effects = [...f.effects], generations = readdirSync(path.dirname(f.receiptPath));
  const plan = await refreshWebRuntime(f.options);
  assert.equal(plan.mode, "plan"); assert.equal(plan.changed, true); assert.equal(plan.browserRuntimeChanged, true);
  assert.equal(plan.candidate.runtimeModule, f.current.runtimeModule); assert.equal(plan.candidate.node, f.current.node.path);
  assert.equal(plan.threadScope, "ordinary Web conversations");
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.effects, effects);
  assert.deepEqual(readdirSync(path.dirname(f.receiptPath)), generations);
  assert.equal(JSON.stringify(plan).includes("private-fixture-key"), false);
  assert.equal(JSON.stringify(plan).includes("asdk_app_fixture"), false);
});

test("configured browser assets can exceed configuration size bounds without weakening those bounds", async t => {
  const f = fixture(t), before = f.snapshot();
  const service = path.join(path.dirname(f.current.runtimeModule), "browser-service.mjs");
  f.write(service, Buffer.alloc(1_606_646, 32));
  const plan = await refreshWebRuntime(f.options);
  assert.equal(plan.ready, true); assert.equal(plan.candidate.runtimeModule, f.current.runtimeModule);
  assert.deepEqual(f.snapshot(), before);
  f.write(f.configPath, `${readFileSync(f.configPath, "utf8")}\n#${" ".repeat(1024 * 1024)}`);
  await assert.rejects(refreshWebRuntime(f.options), /supply --manifest/u);
  f.saveConfig(); f.write(service, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  await assert.rejects(refreshWebRuntime(f.options), /supply --manifest/u);
});

test("owned adapter command metadata resolves the current Node sibling rather than a stale retained server", async t => {
  const f = fixture(t), before = f.snapshot(), receipt = JSON.parse(before.receipt);
  f.saveConfig({ server: receipt.entryPath });
  const plan = await refreshWebRuntime(f.options);
  assert.equal(plan.candidate.officialNodeRepl, f.current.officialNodeRepl.path);
  assert.notEqual(plan.candidate.officialNodeRepl, f.old.officialNodeRepl.path);
  assert.deepEqual(f.snapshot(), before);
  f.saveConfig({ server: path.join(f.root, "foreign", "entry.exe") });
  await assert.rejects(refreshWebRuntime(f.options), /supply --manifest/u);
  f.saveConfig({ server: receipt.entryPath });
  f.write(path.join(receipt.managedDirectory, "entry.exe"), "changed managed entry");
  await assert.rejects(refreshWebRuntime(f.options), /supply --manifest/u);
});

test("closed-app maintenance retains verified cached-command discovery through replacement, deployment and final readback", async t => {
  for (const branch of ["unchanged-final", "changed-final", "managed-upgrade", "publication-edit", "publication-anchor", "foreign-command", "foreign-node", "unrelated-config", "runtime-bytes", "missing-service", "signature", "environment", "protected-entry"]) {
    await t.test(branch, async subtest => {
      const f = fixture(subtest), prior = JSON.parse(readFileSync(f.receiptPath, "utf8"));
      f.saveConfig({ server: prior.entryPath });
      const ownerUpgrade = ["managed-upgrade", "publication-edit"].includes(branch);
      const manager = (command, args = []) => {
        const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../src/config-manager.mjs"), command, ...args], {
          encoding: "utf8", windowsHide: true, timeout: 20_000,
          env: { ...process.env, CODEX_HOME: f.codexHome, MODEL_ROUTER_STATE_DIR: f.stateDir, CODEX_ROUTER_STATE_DIR: f.stateDir, CODEX_BIN: process.execPath },
        });
        assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
      };
      if (ownerUpgrade) {
        f.write(path.join(f.stateDir, "caller-secret"), "a".repeat(48));
        const priorFeature = readFileSync(path.resolve(import.meta.dirname, "fixtures/managed-multi-agent-v2-before-routing.txt"), "utf8").trim();
        f.write(f.configPath, `[features]\napps = true # retained user feature\n# BEGIN codex-router-multi-agent-v2-managed\n${priorFeature}\n# END codex-router-multi-agent-v2-managed\n\n${readFileSync(f.configPath, "utf8")}`);
      }
      const configBytes = readFileSync(f.configPath), expectedCommit = "a".repeat(40), expectedBinarySha256 = "d".repeat(64);
      const changedAnchors = configBytes.toString("utf8").replace(prior.entryPath, path.join(f.root, "foreign-entry.exe"));
      let publication;
      const options = { expectedCommit, expectedBinarySha256, expectedCandidateSha256: "b".repeat(64),
        candidateBinary: path.join(f.root, "switchyard.exe"), deploymentAcceptancePath: path.join(f.root, "acceptance.json"), timeoutMs: 1000 };
      const deployed = { version: 1, accepted: true, deployed: true, routerCommit: expectedCommit, switchyardBinarySha256: expectedBinarySha256,
        switchyardCommit: "a".repeat(40), switchyardRoutesSha256: "b".repeat(64),
        rollbackRoot: path.join(f.root, "switchyard-rollback"), rollbackRouterRoot: path.join(f.root, "router-rollback"),
        checks: Object.fromEntries(["switchyardHealth", "taskIdentity", "routerFullHealth", "cleanCandidate", "installManifest", "doctor",
          "protectedEndpoints", "processIdentity", "provenance", "installedHashes", "installedCatalog"].map(name => [name, true])) };
      const inspect = extra => inspectWebRuntimeMaintenance({ ...f.options,
        dependencies: { ...f.dependencies, ...extra.dependencies } });
      let finalRefreshes = 0, acceptances = 0;
      f.dependencies.drain = async ({ force }) => { assert.equal(force, true); return idleDrain("forced"); };
      const maintenance = runWebMaintenance(options, {
        prepare(_commit, _binary, _hash, { discover }) {
          return { ...inspect({ dependencies: { discover } }), candidateSha256: options.expectedCandidateSha256 };
        },
        async wait() {}, absent() {}, ledger: () => [], unchanged() {}, source() {},
        refresh: value => refreshWebRuntime({ ...f.options, ...value }),
        planConfigurationPublication() {
          publication = ownerUpgrade ? manager("validate-enable", ["--publication-plan"])
            : { beforeSha256: hash(configBytes), afterSha256: hash(branch === "publication-anchor" ? changedAnchors : configBytes) };
          return publication;
        },
        async deploy() {
          const installed = JSON.parse(readFileSync(f.receiptPath, "utf8"));
          assert.notEqual(installed.entryPath, prior.entryPath);
          assert.equal(f.environment.values.CODEX_NODE_REPL_PATH, installed.entryPath);
          assert.deepEqual(readFileSync(f.configPath), configBytes, "refresh leaves app-owned config cached at the prior owned entry");
          assert.throws(() => discoverWebRuntimeAnchors(f.options), { code: "ERR_WEB_RUNTIME_ANCHORS" }, "standalone discovery still rejects the obsolete command");
          if (ownerUpgrade) {
            manager("enable"); // Activation canonicalizes before stopping Router.
            assert.equal(hash(readFileSync(f.configPath)), publication.afterSha256);
            manager("enable"); // The installer publishes the same managed config again.
            assert.notEqual(publication.beforeSha256, publication.afterSha256);
            assert.equal(hash(readFileSync(f.configPath)), publication.afterSha256);
          }
          if (branch === "publication-edit") f.write(f.configPath, `${readFileSync(f.configPath, "utf8")}\n# unrelated concurrent edit\n`);
          if (branch === "publication-anchor") f.write(f.configPath, changedAnchors);
          if (branch === "changed-final") f.write(path.join(f.sourceDir, "web-browser-state.mjs"), "export const updatedState = true;\n");
          if (branch === "foreign-command") f.saveConfig({ server: path.join(f.root, "foreign-entry.exe") });
          if (branch === "foreign-node") f.saveConfig({ server: prior.entryPath, node: f.old.node.path });
          if (branch === "unrelated-config") f.write(f.configPath, Buffer.concat([configBytes, Buffer.from("\n# unrelated concurrent edit\n")]));
          if (branch === "runtime-bytes") f.write(f.current.runtimeModule, "export const changedRuntime = true;\n");
          if (branch === "missing-service") rmSync(path.join(path.dirname(f.current.runtimeModule), "browser-service.mjs"));
          if (branch === "signature") f.adapterOptions.dependencies.inspectSignatures = paths => paths.map(file => ({ path: file, ...signature, status: "NotSigned" }));
          if (branch === "environment") f.environment.values.CODEX_NODE_REPL_PATH = path.join(f.root, "foreign-selection.exe");
          if (branch === "protected-entry") f.write(installed.entryPath, "changed protected entry");
          return { receipt: deployed, resultPath: path.join(f.root, "deployment-result.json") };
        },
        async accept() { acceptances++; },
        inspectFinal: inspect, inspectActual: inspect,
        async refreshFinal(value) {
          finalRefreshes++;
          return refreshWebRuntime({ ...f.options, ...value, dependencies: { ...f.dependencies, ...value.dependencies } });
        },
      });
      if (["unchanged-final", "changed-final", "managed-upgrade"].includes(branch)) {
        const receipt = await maintenance;
        assert.equal(receipt.accepted, true); assert.equal(acceptances, 2);
        assert.equal(finalRefreshes, branch === "changed-final" ? 1 : 0);
        assert.equal(receipt.finalAdapter.generation, JSON.parse(readFileSync(f.receiptPath, "utf8")).generation);
        assert.equal(hash(readFileSync(f.configPath)), publication.afterSha256);
        assert.deepEqual(receipt.configurationPublication, publication);
        assert.throws(() => discoverWebRuntimeAnchors(f.options), { code: "ERR_WEB_RUNTIME_ANCHORS" }, "transaction authority does not escape to a later standalone operation");
      } else {
        const failure = ["foreign-command", "foreign-node", "unrelated-config", "publication-edit"].includes(branch) ? /publication changed/u
          : branch === "publication-anchor" ? /changed the official MCP runtime anchors/u
          : branch === "runtime-bytes" ? /reviewed official cohort/u
            : branch === "missing-service" ? /ENOENT/u
              : branch === "signature" ? /Invalid signed adapter runtime identity/u
                : branch === "environment" ? /environment changed/u : /file identity mismatch/u;
        await assert.rejects(maintenance, failure);
        const rejectedPublication = ["foreign-command", "foreign-node", "unrelated-config", "publication-edit", "publication-anchor"].includes(branch);
        assert.equal(finalRefreshes, 0); assert.equal(acceptances, rejectedPublication ? 0 : 1, "post-deployment changes withhold final maintenance acceptance");
      }
    });
  }
});

test("coordinated refresh preserves connector, capabilities, tunnel/key, baseline User CLI and hook bytes", async t => {
  const f = fixture(t), before = f.snapshot();
  const result = await refreshWebRuntime({ ...f.options, apply: true });
  assert.equal(result.applied, true); assert.equal(result.routerReloaded, true); assert.equal(result.codexRestartRequired, true);
  assert.equal(result.routerRestartRequired, false);
  assert.equal(result.hookDefinitionChanged, false); assert.equal(result.hookDefinition, "preserved");
  assert.match(result.next, /Existing hook trust is retained/u);
  const settings = JSON.parse(readFileSync(f.settingsPath, "utf8"));
  assert.deepEqual(settings, { ...f.settings, browser: { ...f.settings.browser, runtimeModule: f.current.runtimeModule } });
  assert.equal(readFileSync(f.keyPath, "utf8"), before.key); assert.equal(readFileSync(f.hooksPath, "utf8"), before.hooks);
  const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
  assert.notEqual(receipt.generation, JSON.parse(before.receipt).generation);
  assert.equal(result.adapterGeneration, receipt.generation);
  assert.equal(f.environment.values.CODEX_CLI_PATH, null); assert.equal(f.environment.values.CODEX_NODE_REPL_PATH, receipt.entryPath);
  assert.deepEqual(receipt.previousEnvironment, { CODEX_CLI_PATH: null, CODEX_NODE_REPL_PATH: null });
  assert.deepEqual(f.effects.filter(value => ["drain", "settings", "restart"].includes(value)), ["drain", "settings", "restart"]);
});

test("legacy hook migration is planned even with current runtimes and requires a fresh trust review", async t => {
  const f = fixture(t); await refreshWebRuntime({ ...f.options, apply: true }); retainLegacyHook(f);
  const before = f.snapshot(), plan = await refreshWebRuntime(f.options);
  assert.equal(plan.changed, true); assert.equal(plan.browserRuntimeChanged, false); assert.equal(plan.adapterGenerationChanged, false);
  assert.equal(plan.hookDefinitionChanged, true); assert.equal(plan.hookDefinition, "modified");
  assert.match(plan.next, /Review and trust the modified Router Interrupt hook/u);
  assert.deepEqual(f.snapshot(), before);
  const result = await refreshWebRuntime({ ...f.options, apply: true });
  assert.equal(result.applied, true); assert.equal(result.routerReloaded, true); assert.equal(result.codexRestartRequired, true);
  assert.equal(result.hookDefinitionChanged, true); assert.equal(result.hookDefinition, "modified");
  assert.match(result.next, /Review and trust the modified Router Interrupt hook/u);
  assert.doesNotMatch(result.next, /trust is retained/u);
  const hook = JSON.parse(readFileSync(f.hooksPath, "utf8")).hooks.Interrupt[0].hooks[0];
  assert.deepEqual(hook, createAdapterHook()); assert.equal(Object.hasOwn(hook, "trusted"), false);
  assert.deepEqual(f.environment.values, before.environment);
  assert.deepEqual(JSON.parse(readFileSync(f.receiptPath, "utf8")).previousEnvironment, JSON.parse(before.receipt).previousEnvironment);
});

test("a coordinated refresh failure restores exact legacy hook bytes and ownership", async t => {
  const f = fixture(t); retainLegacyHook(f); const before = f.snapshot();
  f.dependencies.writePrivate = () => { throw new Error("fixture migration settings failure"); };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /fixture migration settings failure/u);
  assert.deepEqual(f.snapshot(), before);
});

test("failed legacy-hook refresh preserves a concurrent hooks edit during compensation", async t => {
  const f = fixture(t); retainLegacyHook(f); let foreignHooks, restarts = 0;
  f.dependencies.restart = async () => {
    if (++restarts !== 1) return 0;
    const hooks = JSON.parse(readFileSync(f.hooksPath, "utf8")); hooks.foreign = "concurrent hooks edit";
    foreignHooks = json(hooks); f.write(f.hooksPath, foreignHooks); return 1;
  };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /rollback incomplete: Foreign hooks changes preserved/u);
  assert.equal(readFileSync(f.hooksPath, "utf8"), foreignHooks);
});

test("explicit forced refresh uses the coordinated drain and reloads only with known idle Web work", async t => {
  const f = fixture(t), before = f.snapshot();
  f.dependencies.drain = async ({ force }) => { assert.equal(force, true); f.effects.push("drain"); return idleDrain("forced"); };
  const result = await refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true });
  assert.equal(result.applied, true); assert.equal(result.routerReloaded, true);
  assert.equal(JSON.parse(readFileSync(f.settingsPath, "utf8")).browser.runtimeModule, f.current.runtimeModule);
  assert.notEqual(readFileSync(f.receiptPath, "utf8"), before.receipt);
  assert.deepEqual(f.effects.filter(value => ["drain", "settings", "restart", "resume"].includes(value)), ["drain", "settings", "restart"]);
});

test("failed runtime planning leaves admission untouched, including before an authorized forced apply", async t => {
  const f = fixture(t), before = f.snapshot(), effects = [...f.effects];
  f.dependencies.adapter.inspectSignatures = () => { throw new Error("fixture signature helper permission denied"); };
  await assert.rejects(refreshWebRuntime(f.options), /signature helper permission denied/u);
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true }), /signature helper permission denied/u);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.effects, effects);
  await assert.rejects(refreshWebRuntime({ ...f.options, forceServiceReplacement: true }), /requires --apply/u);
});

test("explicit adapter replacement promotes a trial through the coordinated transaction while ordinary refresh preserves scope", async t => {
  const f = fixture(t, { threadIds: ["01a14b65-a7a8-7b41-bd33-7c19d3c6df82"] });
  const before = f.snapshot(), manifest = { ...f.current, threadIds: null };
  f.write(f.manifestPath, json(manifest));
  await assert.rejects(refreshWebRuntime({ ...f.options, manifestPath: f.manifestPath }), /preserve the installed adapter thread scope/u);
  assert.deepEqual(f.snapshot(), before);
  const result = await refreshWebRuntime({ ...f.options, manifestPath: f.manifestPath, apply: true, replaceAdapter: true });
  assert.equal(result.applied, true); assert.equal(result.routerReloaded, true);
  assert.equal(result.threadScope, "ordinary Web conversations");
  const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
  assert.equal(receipt.threadIds, null);
  assert.deepEqual(receipt.previousEnvironment, JSON.parse(before.receipt).previousEnvironment);
  assert.equal(readFileSync(f.hooksPath, "utf8"), before.hooks);
  assert.equal(readFileSync(f.keyPath, "utf8"), before.key);
  assert.equal(JSON.parse(readFileSync(f.settingsPath, "utf8")).browser.runtimeModule, f.current.runtimeModule);
  assert.deepEqual(f.effects.filter(value => ["drain", "settings", "restart"].includes(value)), ["drain", "settings", "restart"]);
});

test("matching configured selections plan and apply without staging, drain or restart", async t => {
  const f = fixture(t);
  await refreshWebRuntime({ ...f.options, apply: true });
  const before = f.snapshot(), effects = [...f.effects];
  const plan = await refreshWebRuntime(f.options);
  assert.equal(plan.changed, false); assert.equal(plan.routerRestartRequired, false); assert.equal(plan.codexRestartRequired, false);
  const applied = await refreshWebRuntime({ ...f.options, apply: true });
  assert.equal(applied.applied, false); assert.equal(applied.routerReloaded, false);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.effects, effects);
});

test("ambiguous, conflicting or stale discovered anchors require an explicit manifest without mutation", async t => {
  for (const branch of ["missing", "version", "node-pair", "service", "duplicate", "stale"]) await t.test(branch, async subtest => {
    const f = fixture(subtest), before = f.snapshot(), effects = [...f.effects];
    if (branch === "missing") f.write(f.configPath, "[mcp_servers.node_repl]\n");
    if (branch === "version") f.saveConfig({ version: "26.1.1" });
    if (branch === "node-pair") f.saveConfig({ node: path.join(f.root, "unrelated", "node.exe") });
    if (branch === "service") f.saveConfig({ service: f.current.runtimeModule });
    if (branch === "duplicate") f.write(f.configPath, `${readFileSync(f.configPath, "utf8")}NODE_REPL_NODE_PATH = '${f.current.node.path}'\n`);
    if (branch === "stale") rmSync(path.join(path.dirname(f.current.runtimeModule), "browser-service.mjs"));
    await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /supply --manifest/u);
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.effects, effects);
    const explicit = await refreshWebRuntime({ ...f.options, manifestPath: f.manifestPath });
    assert.equal(explicit.ready, true);
  });
});

test("explicit manifest cannot change installed trial scope or mix Node runtime cohorts", async t => {
  for (const branch of ["scope", "cohort", "signature", "hash"]) await t.test(branch, async subtest => {
    const f = fixture(subtest), manifest = structuredClone(f.current), before = f.snapshot(), effects = [...f.effects];
    if (branch === "scope") manifest.threadIds = ["01a14b65-a7a8-7b41-bd33-7c19d3c6df82"];
    if (branch === "cohort") { const target = path.join(f.root, "another", "node.exe"); f.write(target, readFileSync(manifest.node.path)); manifest.node.path = target; }
    if (branch === "signature") f.dependencies.adapter.inspectSignatures = paths => paths.map(file => ({ path: file, ...signature, status: "NotSigned" }));
    if (branch === "hash") f.write(manifest.node.path, "unexpected runtime bytes");
    f.write(f.manifestPath, json(manifest));
    await assert.rejects(refreshWebRuntime({ ...f.options, manifestPath: f.manifestPath, apply: true }));
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.effects, effects);
  });
});

test("pending Router or Web work defers refresh before global mutation", async t => {
  const f = fixture(t), before = f.snapshot();
  f.dependencies.drain = async () => { throw Object.assign(new Error("active Web generation"), { code: "ERR_ROUTER_DRAIN_DEFERRED" }); };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), error => error.code === "ERR_ROUTER_DRAIN_DEFERRED");
  assert.deepEqual(f.snapshot(), before); assert.equal(f.effects.includes("settings"), false); assert.equal(f.effects.includes("restart"), false);
});

test("online refresh requires explicit known zero Web activity and resumes a legacy or invalid closed drain", async t => {
  for (const status of ["drained", "forced"]) for (const [label, webRuntime] of [
    ["legacy", undefined], ["unknown", { known: false, activeTurns: 0, uncertainSends: 0, unresolvedActions: 0 }],
    ["missing-count", { known: true, activeTurns: 0, uncertainSends: 0 }],
    ["active", { known: true, activeTurns: 1, uncertainSends: 0, unresolvedActions: 0 }],
    ["uncertain", { known: true, activeTurns: 0, uncertainSends: 1, unresolvedActions: 0 }],
    ["unresolved", { known: true, activeTurns: 0, uncertainSends: 0, unresolvedActions: 1 }],
    ["malformed", { known: true, activeTurns: 0, uncertainSends: 0, unresolvedActions: "0" }],
  ]) await t.test(`${status}: ${label}`, async subtest => {
    const f = fixture(subtest), before = f.snapshot(), effects = f.effects.length;
    f.dependencies.drain = async ({ force }) => {
      assert.equal(force, status === "forced");
      return { status, ...(webRuntime === undefined ? {} : { webRuntime }) };
    };
    await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: status === "forced" }), /known idle Web runtime/u);
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.effects.slice(effects), ["resume"]);
  });
});

test("an offline Router permits coordinated refresh without online Web activity proof", async t => {
  const f = fixture(t);
  f.dependencies.drain = async () => ({ status: "offline" });
  const result = await refreshWebRuntime({ ...f.options, apply: true });
  assert.equal(result.applied, true); assert.equal(result.routerReloaded, true);
});

function uncertainLedger(f) {
  const threadId = "01a156bc-82f7-7b91-9b78-367425c87efe", turnId = "01a1473b-9b4e-7302-a80c-2f3dd5e3d2a0";
  const ledgerPath = path.join(f.stateDir, "web-in-app", "conversations", `${threadId}.json`);
  f.write(ledgerPath, json({ version: 1, threadId, bindingId: "bfixture", browserOwnerTurnIds: [turnId],
    uncertainSend: true, unresolvedCoding: [], lastTurn: { turnId, sendState: "uncertain", completed: false } }));
  return ledgerPath;
}

const settledForce = () => ({ status: "forced", state: "closed", activeRequests: 0,
  webRuntime: { known: true, activeTurns: 0, uncertainSends: 1, unresolvedActions: 0 } });

test("forced maintenance preserves durable uncertain Send bytes and forwards force to the closed-admission restart", async t => {
  const f = fixture(t), ledgerPath = uncertainLedger(f), bytes = readFileSync(ledgerPath), before = f.snapshot();
  const sidecar = path.join(path.dirname(ledgerPath), "retained-recovery-copy.json"), sidecarBytes = Buffer.from('{"unresolvedCoding":"opaque historical copy"}');
  f.write(sidecar, sidecarBytes);
  let proofs = 0, restarts = 0;
  f.dependencies.drain = async ({ force }) => { assert.equal(force, true); return settledForce(); };
  f.dependencies.assertProcessesAbsent = adapter => {
    proofs++; assert.equal(adapter.currentRuntime.node.path, f.old.node.path);
    assert.equal(adapter.candidate.node.path, f.current.node.path);
    assert.equal(existsSync(adapter.currentRuntime.node.path), false, "old protected manifest retains removed anchors");
  };
  f.dependencies.restart = async options => {
    assert.equal(options.force, true); assert.deepEqual(options.closedAdmission, settledForce());
    assert.equal(typeof options.beforeMutation, "function"); options.beforeMutation(); restarts++; return 0;
  };
  const result = await refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true });
  assert.equal(result.applied, true); assert.equal(restarts, 1); assert.ok(proofs >= 4);
  assert.deepEqual(readFileSync(ledgerPath), bytes);
  assert.deepEqual(readFileSync(sidecar), sidecarBytes);
  assert.equal(readFileSync(f.keyPath, "utf8"), before.key);
  assert.equal(JSON.parse(readFileSync(ledgerPath)).uncertainSend, true, "the replay blocker remains set");
});

test("forced uncertainty rejects incomplete work, missing evidence and failed process proof before mutation", async t => {
  for (const branch of ["active", "unresolved", "unknown", "negative", "infinite", "missing-count", "active-request", "open-admission", "no-ledger", "invalid-ledger", "unprotected-ledger", "live-or-unknown-process"]) {
    await t.test(branch, async subtest => {
      const f = fixture(subtest), file = uncertainLedger(f), before = f.snapshot(), drain = settledForce();
      if (branch === "active") drain.webRuntime.activeTurns = 1;
      if (branch === "unresolved") drain.webRuntime.unresolvedActions = 1;
      if (branch === "unknown") drain.webRuntime.known = false;
      if (branch === "negative") drain.webRuntime.uncertainSends = -1;
      if (branch === "infinite") drain.webRuntime.uncertainSends = Infinity;
      if (branch === "missing-count") delete drain.webRuntime.unresolvedActions;
      if (branch === "active-request") drain.activeRequests = 1;
      if (branch === "open-admission") drain.state = "open";
      if (branch === "no-ledger") rmSync(file);
      if (branch === "invalid-ledger") f.write(file, '{"uncertainSend":true}');
      if (branch === "unprotected-ledger") f.dependencies.isPrivate = target => target !== file;
      if (branch === "live-or-unknown-process") f.dependencies.assertProcessesAbsent = () => { throw new Error("live or unreadable process"); };
      f.dependencies.drain = async () => drain;
      await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true }));
      assert.deepEqual(f.snapshot(), before); assert.equal(f.effects.includes("restart"), false);
    });
  }
});

test("forced maintenance fences an early reopen and ledger changes at selection mutation", async t => {
  for (const branch of ["reopen", "ledger-change"]) await t.test(branch, async subtest => {
    const f = fixture(subtest), file = uncertainLedger(f), before = f.snapshot(); let proofs = 0;
    f.dependencies.drain = async () => settledForce();
    f.dependencies.assertProcessesAbsent = () => {
      if (++proofs === 3) {
        if (branch === "reopen") throw new Error("new host generation");
        f.write(file, `${readFileSync(file, "utf8")}\n`);
      }
    };
    await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true }));
    assert.deepEqual(f.snapshot(), before); assert.equal(f.effects.includes("restart"), false);
    assert.equal(f.effects.at(-1), "resume", "unchanged protected selections allow admission recovery");
  });
});

test("forced maintenance keeps recovery strict when a restart fails with retained uncertainty", async t => {
  const f = fixture(t), file = uncertainLedger(f), bytes = readFileSync(file); let drains = 0;
  f.dependencies.drain = async ({ force }) => {
    if (++drains === 1) { assert.equal(force, true); return settledForce(); }
    assert.equal(force, false); throw new Error("uncertain Web workflow");
  };
  f.dependencies.restart = async () => 1;
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true }), /rollback deferred/u);
  assert.equal(drains, 2); assert.deepEqual(readFileSync(file), bytes);
  assert.equal(f.effects.includes("resume"), false);
});

test("forced maintenance rejects durable unloaded native actions even when serving counters are all zero", async t => {
  for (const uncertainSends of [0, 1]) await t.test(`serving uncertainty: ${uncertainSends}`, async subtest => {
    const f = fixture(subtest), file = uncertainLedger(f), value = JSON.parse(readFileSync(file));
    value.unresolvedCoding = [{ callId: "retained-native-call", outputType: "function_call_output" }];
    f.write(file, json(value));
    const bytes = readFileSync(file), before = f.snapshot(), drain = settledForce(); drain.webRuntime.uncertainSends = uncertainSends;
    f.dependencies.drain = async () => drain;
    await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true }), /no unresolved native action/u);
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(readFileSync(file), bytes); assert.equal(f.effects.includes("restart"), false);
  });
});

test("independent maintenance binds the reviewed candidate through internal planning before any forced drain", async t => {
  const f = fixture(t), expectedMaintenance = inspectWebRuntimeMaintenance(f.options), before = f.snapshot();
  f.write(f.current.runtimeModule, "export const current = 'new valid runtime bytes';\n");
  let drains = 0; f.dependencies.drain = async () => { drains++; return settledForce(); };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true, expectedMaintenance }), /candidate changed/u);
  assert.equal(drains, 0); assert.deepEqual(f.snapshot(), before);
});

test("forced maintenance checks process absence again after candidate compilation and before launch selection publication", async t => {
  const f = fixture(t), file = uncertainLedger(f), bytes = readFileSync(file), before = f.snapshot(); let reopened = false;
  f.dependencies.drain = async () => settledForce();
  f.dependencies.adapter.compileEntry = (_source, output) => { f.write(output, "unsigned fixture launcher"); reopened = true; };
  f.dependencies.assertProcessesAbsent = () => { if (reopened) throw new Error("new native host during compilation"); };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true }), /new native host/u);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(readFileSync(file), bytes);
  assert.equal(f.effects.includes("restart"), false);
  assert.equal(f.effects.at(-1), "resume", "an abort before selection publication restores admission");
});

test("failure after settings publication restores exact prior generation and settings without resetting original baseline", async t => {
  const f = fixture(t), before = f.snapshot(), write = f.dependencies.writePrivate;
  let failed = false;
  f.dependencies.writePrivate = (file, contents) => { write(file, contents); if (!failed) { failed = true; throw new Error("fixture write failed after publication"); } };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /fixture write failed/u);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.effects.includes("restart"), false); assert.equal(f.effects.at(-1), "resume");
});

test("settings failure before publication restores prior adapter instead of treating unchanged settings as foreign", async t => {
  const f = fixture(t), before = f.snapshot();
  f.dependencies.writePrivate = () => { throw new Error("fixture write failed before publication"); };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /fixture write failed before publication/u);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.effects.includes("restart"), false); assert.equal(f.effects.at(-1), "resume");
});

test("candidate staging, partial activation and final receipt faults retain the exact previously active generation", async t => {
  for (const branch of ["compile", "partial-environment", "receipt"]) await t.test(branch, async subtest => {
    const f = fixture(subtest), before = f.snapshot(); let failed = false;
    if (branch === "compile") f.dependencies.adapter.compileEntry = () => { throw new Error("fixture compile failure"); };
    if (branch === "partial-environment") {
      const exchange = f.environment.compareExchangePair.bind(f.environment);
      f.environment.compareExchangePair = (expected, values) => {
        if (!failed) { failed = true; f.environment.values.CODEX_NODE_REPL_PATH = values.CODEX_NODE_REPL_PATH; throw new Error("fixture partial activation"); }
        return exchange(expected, values);
      };
    }
    if (branch === "receipt") {
      const write = f.dependencies.adapter.writePrivate;
      f.dependencies.adapter.writePrivate = (file, contents) => {
        write(file, contents);
        if (!failed && file === f.receiptPath && JSON.parse(contents).state === "installed") { failed = true; throw new Error("fixture receipt failure after write"); }
      };
    }
    await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /fixture/u);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.effects.includes("settings"), false); assert.equal(f.effects.includes("restart"), false);
  });
});

test("installer failure after an explicit forced drain restores admission before any Router restart", async t => {
  const f = fixture(t), before = f.snapshot(), effects = f.effects.length;
  f.dependencies.drain = async ({ force }) => { assert.equal(force, true); f.effects.push("drain"); return idleDrain("forced"); };
  f.dependencies.adapter.compileEntry = () => { throw new Error("fixture compile failure after forced drain"); };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement: true }), /admission resumed.*compile failure/u);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.effects.slice(effects).filter(value => ["drain", "environment", "settings", "restart", "resume"].includes(value)), ["drain", "resume"]);
});

test("reload failure restores exact previous generation then reloads it after a fresh idle drain", async t => {
  for (const forceServiceReplacement of [false, true]) await t.test(`initial force: ${forceServiceReplacement}`, async subtest => {
    const f = fixture(subtest), before = f.snapshot(); let calls = 0, drains = 0;
    f.dependencies.drain = async ({ force }) => {
      assert.equal(force, ++drains === 1 && forceServiceReplacement);
      f.effects.push("drain"); return idleDrain(force ? "forced" : "drained");
    };
    f.dependencies.restart = async () => { f.effects.push("restart"); return ++calls === 1 ? 1 : 0; };
    await assert.rejects(refreshWebRuntime({ ...f.options, apply: true, forceServiceReplacement }), /prior runtime reloaded/u);
    assert.deepEqual(f.snapshot(), before); assert.equal(calls, 2);
    assert.deepEqual(f.effects.filter(value => ["drain", "settings", "restart"].includes(value)), ["drain", "settings", "restart", "drain", "settings", "restart"]);
  });
});

test("new work after reload prevents compensation and retains the refreshed generation", async t => {
  const f = fixture(t), before = f.snapshot(); let drains = 0, restarts = 0;
  f.dependencies.drain = async () => { if (++drains === 1) return idleDrain(); throw new Error("active Web work"); };
  f.dependencies.restart = async () => { restarts++; return 1; };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /refreshed runtime retained; rollback deferred/u);
  assert.equal(restarts, 1); assert.notEqual(readFileSync(f.receiptPath, "utf8"), before.receipt);
  assert.equal(JSON.parse(readFileSync(f.settingsPath, "utf8")).browser.runtimeModule, f.current.runtimeModule);
  assert.notEqual(f.environment.values.CODEX_NODE_REPL_PATH, before.environment.CODEX_NODE_REPL_PATH);
});

test("legacy recovery drain proof withholds compensation and retains the fresh runtime", async t => {
  const f = fixture(t), before = f.snapshot(); let drains = 0, restarts = 0;
  f.dependencies.drain = async () => ++drains === 1 ? idleDrain() : { status: "drained" };
  f.dependencies.restart = async () => { restarts++; return 1; };
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /refreshed runtime retained; rollback deferred/u);
  assert.equal(drains, 2); assert.equal(restarts, 1);
  assert.notEqual(readFileSync(f.receiptPath, "utf8"), before.receipt);
  assert.equal(JSON.parse(readFileSync(f.settingsPath, "utf8")).browser.runtimeModule, f.current.runtimeModule);
  assert.notEqual(f.environment.values.CODEX_NODE_REPL_PATH, before.environment.CODEX_NODE_REPL_PATH);
  assert.equal(f.effects.includes("resume"), false);
});

test("foreign settings and environment edits survive rollback and are reported", async t => {
  for (const branch of ["settings", "environment"]) await t.test(branch, async subtest => {
    const f = fixture(subtest), before = f.snapshot();
    f.dependencies.restart = async () => {
      if (branch === "settings") f.write(f.settingsPath, json({ ...f.settings, browser: { ...f.settings.browser, runtimeModule: f.current.runtimeModule }, mcpPort: 25998 }));
      else f.environment.values.CODEX_CLI_PATH = "foreign CLI selection";
      return 1;
    };
    await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /rollback incomplete/u);
    if (branch === "settings") {
      assert.equal(JSON.parse(readFileSync(f.settingsPath, "utf8")).mcpPort, 25998);
      assert.notEqual(readFileSync(f.receiptPath, "utf8"), before.receipt, "retain the matching refreshed adapter when foreign settings prevent coordinated rollback");
      assert.notEqual(f.environment.values.CODEX_NODE_REPL_PATH, before.environment.CODEX_NODE_REPL_PATH);
      assert.equal(f.effects.includes("resume"), false);
    }
    else assert.equal(f.environment.values.CODEX_CLI_PATH, "foreign CLI selection");
    assert.equal(readFileSync(f.hooksPath, "utf8"), before.hooks); assert.equal(readFileSync(f.keyPath, "utf8"), before.key);
  });
});

test("installer atomic lock cannot replace a generation during coordinated async reload", async t => {
  const f = fixture(t); let checked = false;
  f.dependencies.restart = async () => {
    const before = f.snapshot();
    assert.throws(() => rollbackWebStopAdapter(f.adapterOptions), /Timed out waiting for state lock/u);
    assert.deepEqual(f.snapshot(), before); checked = true; return 0;
  };
  await refreshWebRuntime({ ...f.options, apply: true }); assert.equal(checked, true);
});

test("foreign plan changes are rejected through compare-and-exchange before replacing adapter ownership", async t => {
  const f = fixture(t), before = f.snapshot();
  f.dependencies.serviceLock = async operation => {
    f.environment.values.CODEX_CLI_PATH = "foreign CLI selection";
    return operation();
  };
  f.dependencies.drain = async () => idleDrain();
  await assert.rejects(refreshWebRuntime({ ...f.options, apply: true }), /foreign value|plan changed/u);
  assert.equal(readFileSync(f.settingsPath, "utf8"), before.settings); assert.equal(readFileSync(f.receiptPath, "utf8"), before.receipt);
  assert.equal(f.environment.values.CODEX_CLI_PATH, "foreign CLI selection");
});

test("official MCP configuration is fenced across apply and malformed private JSON stays bounded", async t => {
  const f = fixture(t), anchors = discoverWebRuntimeAnchors(f.options);
  f.saveConfig({ version: "26.1.2" }); assert.throws(() => anchors.assertCurrent(), /configuration changed/u);
  f.write(f.settingsPath, "private-settings-canary-invalid-json");
  await assert.rejects(refreshWebRuntime(f.options), error => !error.message.includes("private-settings-canary"));
  assert.equal(existsSync(f.keyPath), true);
});
