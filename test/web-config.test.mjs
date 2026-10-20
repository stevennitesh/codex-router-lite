import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("in-app setup stores only the explicit safe configuration and advertises native browser verification", async () => {
  const status = await web.configureInAppWebBridge(config);
  assert.deepEqual(savedSettings(), {
    version: 1, enabled: true, capabilities,
    browser: { runtimeModule, pluginName: config.pluginName, pluginAppId: config.pluginAppId,
      pluginSelectionButtonName: config.pluginSelectionButtonName },
    tunnel: { id: config.tunnelId, executable: tunnelClientPath },
  });
  assert.equal(status.localToolsConfigured, true);
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
    { ...valid, capabilities: undefined }, { ...valid, tunnel: { ...valid.tunnel, executable: "relative.exe" } }]) {
    saveSettings(value);
    assert.throws(() => web.readWebBridgeSettings(), Error);
  }
  saveSettings({ version: 1, enabled: true, ...extras, capabilities });
  assert.throws(() => web.readWebBridgeSettings(), /reconfigure with codex web browser/u);
  saveSettings(valid);
  assert.equal(web.readWebBridgeSettings().enabled, true);
});

test("unavailable models and unsupported efforts fail locally", async () => {
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
