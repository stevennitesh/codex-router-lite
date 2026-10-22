import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(path.join(os.tmpdir(), "router-web-config-"));
const home = path.join(root, "codex");
mkdirSync(home);
process.env.CODEX_HOME = home;
process.env.MODEL_ROUTER_STATE_DIR = root;
process.env.MODEL_ROUTER_MODEL_PICKER_STATE = path.join(root, "model-picker.json");
process.env.MODEL_ROUTER_MULTI_AGENT_STATE = path.join(root, "multi-agent-settings.json");
const web = await import("../src/chatgpt-web.mjs");
const { withCatalogPublicationLock } = await import("../src/catalog-publication-lock.mjs");
assert.equal(web.WEB_BRIDGE_TUNNEL_KEY_PATH, path.join(root, "chatgpt-web-runtime-key.secret"),
  "Web configuration fixtures must own their state paths before any operation.");
const settingsPath = path.join(root, "chatgpt-web.json");
const runtimeModule = path.join(root, "browser-runtime.mjs");
const tunnelClientPath = path.join(root, "tunnel-client.exe");
writeFileSync(runtimeModule, "// Synthetic browser-runtime path; configuration must not execute it.\n", "utf8");
writeFileSync(tunnelClientPath, "synthetic executable path; never launched by configuration", "utf8");
const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };
const config = { runtimeModule, pluginName: "Router local tools", pluginAppId: "asdk_app_fixture",
  pluginSelectionButtonName: "Router local tools, Connectors", tunnelId: "tunnel_fixture", tunnelClientPath, capabilities };
after(() => rmSync(root, { recursive: true, force: true }));

function savedSettings() { return JSON.parse(readFileSync(settingsPath, "utf8")); }
function saveSettings(value) { writeFileSync(settingsPath, JSON.stringify(value), "utf8"); }
function control(args, { preload, env = {} } = {}) {
  const result = spawnSync(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []),
    path.resolve(import.meta.dirname, "../src/control.mjs"), ...args], {
    cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, ...env },
    encoding: "utf8", windowsHide: true, timeout: 45_000,
  });
  assert.equal(result.error, undefined);
  return result;
}
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("first use is disabled without creating saved settings", async () => {
  assert.deepEqual(web.readWebBridgeSettings(), { version: 1, enabled: false, models: [] });
  assert.equal(web.webBridgeConfigurationStatus().runtimeStatus, "unavailable");
  assert.equal((await web.disconnectWebBridge()).enabled, false);
  assert.equal(await web.startWebBridge(), undefined);
  assert.equal(existsSync(settingsPath), false);
});

test("in-app setup stores only the explicit safe configuration and advertises native browser verification", async () => {
  const status = await web.configureInAppWebBridge(config);
  assert.deepEqual(savedSettings(), {
    version: 1, enabled: true, capabilities,
    browser: { runtimeModule, pluginName: config.pluginName, pluginAppId: config.pluginAppId,
      pluginSelectionButtonName: config.pluginSelectionButtonName },
    tunnel: { id: config.tunnelId, executable: tunnelClientPath },
  });
  assert.equal(status.localToolsConfigured, true);
  assert.deepEqual(web.webBridgeConfigurationStatus(), { ...status, runtimeStatus: "current", runtimeIssues: [] });
  assert.equal(web.webBridgeModels().length, 6);
  await web.disconnectWebBridge();
  assert.equal(savedSettings().enabled, false);
  assert.deepEqual(web.webBridgeModels(), []);
});

test("invalid in-app configuration cannot overwrite a previously valid setup", async () => {
  await web.configureInAppWebBridge({ ...config, mcpPort: 17843 });
  const before = readFileSync(settingsPath, "utf8");
  const invalid = [null, [], { ...config, runtimeModule: "relative.mjs" }, { ...config, runtimeModule: root },
    { ...config, runtimeModule: path.join(root, "missing.mjs") }, { ...config, tunnelClientPath: runtimeModule },
    { ...config, pluginName: "" }, { ...config, pluginSelectionButtonName: "label\nwith control" },
    { ...config, pluginAppId: "plugin_fixture" }, { ...config, tunnelId: "https://remote.invalid/tunnel" },
    { ...config, capabilities: { ...capabilities, proAvailable: "yes" } },
    { ...config, capabilities: { ...capabilities, token: "must-never-be-persisted" } },
    { ...config, tunnelKey: "must-never-be-persisted" },
    ...[0, 65536, 1.5, "17843", 4200, 4202, 4203].map(mcpPort => ({ ...config, mcpPort }))];
  for (const value of invalid) {
    await assert.rejects(web.configureInAppWebBridge(value), Error);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
  }
});

test("persisted settings project supported fields and require valid browser and tunnel configuration", async () => {
  await web.configureInAppWebBridge(config);
  const valid = savedSettings();
  const extras = { backend: "in-app", mode: "full", baseUrl: "http://127.0.0.1:17841/v1", secret: "private-canary",
    connectedAt: "historical", bridgeVersion: "historical", models: [{ slug: "chatgpt-web/invented" }] };
  saveSettings({ ...valid, ...extras });
  const read = web.readWebBridgeSettings();
  const { models: _models, ...projected } = read;
  assert.deepEqual(projected, valid);
  assert.equal(read.models.some(row => row.slug === "chatgpt-web/invented"), false);
  assert.equal(JSON.stringify(web.webBridgeStatus()).includes("private-canary"), false);
  await web.disconnectWebBridge();
  assert.deepEqual(savedSettings(), { ...valid, enabled: false }, "canonical writes drop retired fields");
  for (const value of [{ ...valid, browser: { ...valid.browser, token: "private-canary" } },
    { ...valid, tunnel: { ...valid.tunnel, key: "private-canary" } }, { ...valid, browser: undefined },
    { ...valid, capabilities: undefined }, { ...valid, capabilities: { ...capabilities, proAvailable: "yes" } },
    { ...valid, capabilities: { ...capabilities, token: "private-canary" } },
    { ...valid, browser: { ...valid.browser, runtimeModule: "relative.mjs" } },
    { ...valid, browser: { ...valid.browser, runtimeModule: path.join(root, "invalid.txt") } },
    { ...valid, browser: { ...valid.browser, pluginName: "bad\nlabel" } },
    { ...valid, browser: { ...valid.browser, pluginAppId: "invalid" } },
    { ...valid, tunnel: { ...valid.tunnel, id: "invalid" } },
    { ...valid, tunnel: { ...valid.tunnel, executable: "relative.exe" } }, { ...valid, mcpPort: 4200 }]) {
    for (const enabled of [true, false]) {
      saveSettings({ ...value, enabled });
      const before = readFileSync(settingsPath, "utf8");
      assert.throws(() => web.readWebBridgeSettings(), Error);
      assert.throws(() => web.webBridgeConfigurationStatus(), Error);
      await assert.rejects(web.disconnectWebBridge(), Error);
      assert.equal(readFileSync(settingsPath, "utf8"), before);
    }
  }
  saveSettings({ version: 1, enabled: true, ...extras, capabilities });
  assert.throws(() => web.readWebBridgeSettings(), /reconfigure with codex web browser/u);
  saveSettings(valid);
  assert.equal(web.readWebBridgeSettings().enabled, true);
});

test("disconnect CLI disables stale runtime assets while enabled use remains strict", async () => {
  const key = "synthetic-retained-runtime-key\n";
  writeFileSync(web.WEB_BRIDGE_TUNNEL_KEY_PATH, key, "utf8");
  try {
    for (const asset of [runtimeModule, tunnelClientPath]) {
      await web.configureInAppWebBridge({ ...config, mcpPort: 17843 });
      const valid = savedSettings(), contents = readFileSync(asset);
      rmSync(asset);
      try {
        const before = readFileSync(settingsPath, "utf8"), observed = web.webBridgeConfigurationStatus();
        assert.equal(observed.enabled, true); assert.equal(observed.localToolsConfigured, true);
        assert.equal(observed.browser.runtimeModule, runtimeModule); assert.equal(observed.tunnel.id, config.tunnelId);
        assert.equal(observed.models.length, 6); assert.equal(observed.runtimeStatus, "stale");
        assert.equal(observed.runtimeIssues.length, 1);
        assert.equal(readFileSync(settingsPath, "utf8"), before, "observation must preserve enabled saved configuration");
        assert.throws(() => web.webBridgeStatus(), /missing or is not a regular file/u);
        assert.throws(() => web.readWebBridgeSettings(), /missing or is not a regular file/u);
        assert.throws(() => web.webBridgeModels(), /missing or is not a regular file/u);
        await assert.rejects(web.startWebBridge(), /missing or is not a regular file/u);
        await assert.rejects(web.requestWebBridge({ model: "chatgpt-web/gpt-6-sol", input: [] }), /missing or is not a regular file/u);
        await assert.rejects(web.configureInAppWebBridge(config), /missing or is not a regular file/u);
        assert.throws(() => web.webBridgeSettingsWithRuntime(valid, runtimeModule), /missing or is not a regular file/u);
        saveSettings({ ...valid, secret: "retired-private-canary" });
        const disconnected = success(control(["web", "disconnect"]));
        assert.equal(disconnected.enabled, false);
        assert.deepEqual(savedSettings(), { ...valid, enabled: false });
        assert.equal(readFileSync(web.WEB_BRIDGE_TUNNEL_KEY_PATH, "utf8"), key);
        assert.equal(web.webBridgeStatus().localToolsConfigured, false);
        assert.deepEqual(web.webBridgeModels(), []);
        assert.equal(await web.startWebBridge(), undefined);
        await assert.rejects(web.requestWebBridge({ model: "chatgpt-web/gpt-6-sol", input: [] }), error => error.status === 409);
      } finally { writeFileSync(asset, contents); }
    }
  } finally { rmSync(web.WEB_BRIDGE_TUNNEL_KEY_PATH, { force: true }); }
});

test("configuration observation distinguishes inaccessible and nonregular runtime paths without changing saved identity", async () => {
  await web.configureInAppWebBridge(config);
  const before = readFileSync(settingsPath, "utf8"), valid = savedSettings();
  const directory = path.join(root, "observed-directory.mjs"), preload = path.join(root, "deny-runtime-probe.mjs");
  mkdirSync(directory);
  try {
    saveSettings({ ...valid, browser: { ...valid.browser, runtimeModule: directory } });
    const invalid = web.webBridgeConfigurationStatus();
    assert.equal(invalid.enabled, true); assert.equal(invalid.runtimeStatus, "invalid"); assert.equal(invalid.runtimeIssues.length, 1);
    assert.throws(() => web.readWebBridgeSettings(), /not a regular file/u);
    writeFileSync(settingsPath, before, "utf8");
    writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const lstat=fs.lstatSync; fs.lstatSync=(file,...args)=>file===${JSON.stringify(runtimeModule)}
  ? (()=>{throw Object.assign(new Error('private-probe-canary'),{code:'EACCES'});})() : lstat(file,...args);
syncBuiltinESMExports();\n`, "utf8");
    const observed = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "--eval",
      `const web=await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/chatgpt-web.mjs")).href)}); console.log(JSON.stringify(web.webBridgeConfigurationStatus()));`],
    { env: process.env, encoding: "utf8", windowsHide: true, timeout: 15_000 });
    const unavailable = success(observed);
    assert.equal(unavailable.enabled, true); assert.equal(unavailable.runtimeStatus, "unavailable");
    assert.equal(unavailable.runtimeIssues.length, 1); assert.equal(unavailable.browser.runtimeModule, runtimeModule);
    assert.equal(observed.stdout.includes("private-probe-canary"), false);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
  } finally { writeFileSync(settingsPath, before, "utf8"); }
});

test("invalid or unreadable saved settings fail explicitly without being disabled", async () => {
  await web.configureInAppWebBridge(config);
  const before = readFileSync(settingsPath, "utf8");
  try {
    for (const text of ["{malformed", '{"version":2,"enabled":false}', '{"version":1,"enabled":"false"}']) {
      writeFileSync(settingsPath, text, "utf8");
      assert.throws(() => web.readWebBridgeSettings(), /existing invalid state/u);
      assert.throws(() => web.webBridgeConfigurationStatus(), /existing invalid state/u);
      await assert.rejects(web.disconnectWebBridge(), /existing invalid state/u);
      assert.equal(readFileSync(settingsPath, "utf8"), text);
    }
    rmSync(settingsPath); mkdirSync(settingsPath);
    assert.throws(() => web.readWebBridgeSettings(), /existing invalid state/u);
    assert.throws(() => web.webBridgeConfigurationStatus(), /existing invalid state/u);
    await assert.rejects(web.disconnectWebBridge(), /existing invalid state/u);
    rmdirSync(settingsPath);
    writeFileSync(settingsPath, before, "utf8");
    const preload = path.join(root, "deny-settings-read.mjs");
    writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync; fs.readFileSync=(file,...args)=>file===${JSON.stringify(settingsPath)}
  ? (()=>{throw Object.assign(new Error('synthetic denied read'),{code:'EACCES'});})() : read(file,...args);
syncBuiltinESMExports();\n`, "utf8");
    const denied = control(["web", "disconnect"], { preload });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /existing invalid state/u);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
  } finally { writeFileSync(settingsPath, before, "utf8"); }
});

test("runtime configuration rejects directory and symbolic-link assets", async t => {
  await web.configureInAppWebBridge(config);
  const before = readFileSync(settingsPath, "utf8");
  const directory = path.join(root, "directory.mjs"); mkdirSync(directory);
  await assert.rejects(web.configureInAppWebBridge({ ...config, runtimeModule: directory }), /not a regular file/u);
  for (const [target, name, field] of [[runtimeModule, "linked.mjs", "runtimeModule"], [tunnelClientPath, "linked.exe", "tunnelClientPath"]]) {
    await t.test(field, async subtest => {
      const link = path.join(root, name);
      try { symlinkSync(target, link, "file"); }
      catch (error) {
        if (error.code === "EPERM") { subtest.skip("Windows file symlink privilege is unavailable."); return; }
        throw error;
      }
      await assert.rejects(web.configureInAppWebBridge({ ...config, [field]: link }), /not a regular file/u);
      const valid = savedSettings();
      try {
        saveSettings({ ...valid, ...(field === "runtimeModule" ? { browser: { ...valid.browser, runtimeModule: link } }
          : { tunnel: { ...valid.tunnel, executable: link } }) });
        assert.throws(() => web.webBridgeModels(), /not a regular file/u);
      } finally { saveSettings(valid); }
    });
  }
  assert.equal(readFileSync(settingsPath, "utf8"), before);
});

test("configure, disconnect and catalog eligibility wait for the cooperating publication lock", async () => {
  await web.configureInAppWebBridge(config);
  const before = readFileSync(settingsPath, "utf8");
  let release, entered;
  const active = new Promise(resolve => { entered = resolve; });
  const held = withCatalogPublicationLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await active;
  let watcher, timer;
  const prepared = new Promise((resolve, reject) => {
    const observe = () => {
      if (readdirSync(root).filter(name => name.startsWith("catalog-publication.lock.prepare-")).length === 3) resolve();
    };
    watcher = watch(root, observe);
    timer = setTimeout(() => reject(new Error("Cooperating operations did not reach the held publication lock.")), 5000);
  });
  const configuring = web.configureInAppWebBridge({ ...config, mcpPort: 17844 });
  const disconnecting = web.disconnectWebBridge();
  const publishing = withCatalogPublicationLock(() => web.webBridgeModels());
  const completed = Promise.all([configuring, disconnecting, publishing]);
  // Register rejection custody before the barrier, and drain all queued work
  // during cleanup even if an ownership assertion or the barrier fails.
  completed.catch(() => {});
  try {
    await prepared;
    assert.equal(readFileSync(settingsPath, "utf8"), before);
  } finally {
    watcher.close(); clearTimeout(timer); release();
    await held;
    await Promise.allSettled([configuring, disconnecting, publishing]);
  }
  const [configured, disconnected, models] = await completed;
  assert.equal(configured.enabled, true);
  assert.equal(disconnected.enabled, false);
  assert.ok(models.length === 0 || models.length === 6, "catalog observes one complete serialized state");
  assert.equal(savedSettings().mcpPort, 17844, "disconnect preserves whichever supported configuration it observes");
});

test("unavailable models and unsupported efforts fail locally", async () => {
  await web.configureInAppWebBridge(config);
  const valid = savedSettings();
  saveSettings({ ...valid, capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false } });
  try {
    for (const payload of [{ model: "chatgpt-web/sol" }, { model: "chatgpt-web/gpt-6-pro" },
      { model: "chatgpt-web/gpt-6-sol", reasoning: { effort: "xhigh" } },
      { model: "chatgpt-web/gpt-6-sol-instant", reasoning: { effort: "high" } }]) {
      await assert.rejects(web.requestWebBridge({ input: [], ...payload }), error => error.status === 400);
    }
  } finally { saveSettings(valid); }
});

test("browser CLI configures the in-app backend and seeds Web visibility while retaining prior choices", () => {
  const source = path.join(root, "safe-browser-config.json");
  const picker = process.env.MODEL_ROUTER_MODEL_PICKER_STATE;
  const hidden = "chatgpt-web/gpt-6-sol";
  writeFileSync(source, JSON.stringify(config), "utf8");
  writeFileSync(picker, JSON.stringify({ version: 1, hidden: [hidden], visible: [], seeded: [hidden] }), "utf8");
  const status = success(control(["web", "browser", source]));
  assert.equal(status.localToolsConfigured, true);
  assert.equal(status.catalogRefreshRequired, true);
  const choices = JSON.parse(readFileSync(picker, "utf8"));
  assert.deepEqual(choices.hidden, [hidden]);
  assert.equal(choices.visible.length, 5);
  assert.ok(choices.visible.every(slug => slug.startsWith("chatgpt-web/")));
  assert.equal(existsSync(path.join(root, "enabled-providers.json")), false);
  assert.equal(existsSync(path.join(home, "config.toml")), false);
});

test("tunnel-key CLI uses the fixed protected store, never echoes input, and leaves provider state alone", () => {
  const canary = "synthetic-private-tunnel-key";
  const providerKey = path.join(root, "openrouter-api-key.secret");
  const providerState = path.join(root, "enabled-providers.json");
  writeFileSync(providerKey, "existing provider fixture", "utf8");
  writeFileSync(providerState, '{"version":1,"providers":["openrouter"]}', "utf8");
  assert.deepEqual(success(control(["web", "tunnel-key", "status"], {
    env: { CHATGPT_WEB_TUNNEL_KEY: canary, CODEX_WEB_TUNNEL_KEY: canary },
  })), { configured: false, fileStatus: "missing" });
  const rejected = control(["web", "tunnel-key", "set", canary]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /never in command arguments/u);
  assert.equal((rejected.stdout + rejected.stderr).includes(canary), false);
  assert.equal(existsSync(web.WEB_BRIDGE_TUNNEL_KEY_PATH), false);

  const preload = path.join(root, "capture-secret.mjs");
  writeFileSync(preload, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const execute=cp.execFileSync;
cp.execFileSync=(command,args,options)=>options?.env?.CODEX_ROUTER_PROMPT_LABEL==='ChatGPT Web tunnel runtime key'
  ? ${JSON.stringify(canary)} : execute(command,args,options);
syncBuiltinESMExports();\n`, "utf8");
  const set = control(["web", "tunnel-key", "set"], { preload });
  assert.equal(set.status, 0, set.stderr);
  assert.equal((set.stdout + set.stderr).includes(canary), false);
  assert.equal(readFileSync(web.WEB_BRIDGE_TUNNEL_KEY_PATH, "utf8"), `${canary}\n`);
  assert.deepEqual(success(control(["web", "tunnel-key", "status"])), { configured: true, fileStatus: "present" });
  assert.deepEqual(success(control(["web", "tunnel-key", "remove"])), { configured: false, removed: true });
  assert.equal(existsSync(web.WEB_BRIDGE_TUNNEL_KEY_PATH), false);
  assert.equal(readFileSync(providerKey, "utf8"), "existing provider fixture");
  assert.equal(readFileSync(providerState, "utf8"), '{"version":1,"providers":["openrouter"]}');
});
