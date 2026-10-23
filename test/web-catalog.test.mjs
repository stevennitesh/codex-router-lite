import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWebBridgeModels } from "../src/chatgpt-web.mjs";
import { applyPickerVisibility, buildMergedCatalog, promoteNativeMultiAgent } from "../src/catalog.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { LISTED_MODELS } from "../src/routed-models.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const native = {
  slug: "gpt-5.5", display_name: "Native fixture", description: "Native account model", priority: 1,
  visibility: "list", base_instructions: "You are Codex, an agent based on GPT-6.1. Follow the task.",
  model_messages: { instructions_template: "You are Codex, an agent based on GPT-6.1. Follow the task." },
  multi_agent_version: "v2", shell_type: "unified_exec", input_modalities: ["text", "image"],
  context_window: 300000, max_context_window: 300000, effective_context_window_percent: 95,
  supported_reasoning_levels: [{ effort: "high", description: "High" }], default_reasoning_level: "high",
  supports_search_tool: true, supports_reasoning_effort_updates: true, tool_mode: "code_mode_only",
  supports_parallel_tool_calls: true, additional_speed_tiers: ["fast"], service_tiers: [{ id: "priority", name: "Fast" }],
  future_schema: { retained: true },
};
const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

test("Web catalog preserves bridge identity and effort without borrowing native-only capabilities", () => {
  const web = buildWebBridgeModels(capabilities);
  const result = buildMergedCatalog({ models: [native] }, [], { webModels: web });
  assert.deepEqual(result.find(model => model.slug === native.slug), native);
  for (const expected of web) {
    const row = result.find(model => model.slug === expected.slug);
    assert.equal(row.display_name, expected.display_name);
    assert.deepEqual(row.supported_reasoning_levels, expected.supported_reasoning_levels);
    assert.equal(row.default_reasoning_level, expected.default_reasoning_level);
    assert.deepEqual(row.input_modalities, ["text"]);
    assert.equal(row.multi_agent_version, "v1");
    assert.equal(row.shell_type, "unified_exec", "installed schema remains parseable");
    assert.equal(row.supports_reasoning_effort_updates, false);
    assert.equal(row.supports_search_tool, false);
    assert.equal(row.tool_mode, null);
    assert.deepEqual(row.service_tiers, []);
    assert.deepEqual(row.additional_speed_tiers, []);
    assert.match(row.base_instructions, new RegExp(expected.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const role = routedAgentDefinition(expected);
    assert.ok(role.contents.includes(`model = "${expected.slug}"`));
    assert.ok(role.contents.includes(`model_reasoning_effort = "${expected.defaultEffort}"`));
    assert.match(role.contents, /using the V1 subagent protocol/u);
  }
  const visible = applyPickerVisibility(result, { nativeBaseSlugs: new Set([native.slug]),
    hiddenModels: new Set([web[0].slug]), visibleModels: new Set(web.slice(1).map(model => model.slug)), hasExplicitVisibility: true });
  assert.equal(visible.find(model => model.slug === web[0].slug).visibility, "hide");
  assert.equal(visible.find(model => model.slug === native.slug).visibility, "list");
});

test("V1 selection projects delegation-capable native entries without mutating their V2 authority", () => {
  const original = [structuredClone(native), { ...structuredClone(native), slug: "hidden-native", visibility: "hide" }];
  const settings = { version: 2, protocol: "v1", mode: "proven", enabled: [], disabled: [] };
  const projected = promoteNativeMultiAgent(original, settings);
  assert.ok(projected.every(model => model.multi_agent_version === "v1"));
  assert.deepEqual(projected.map(model => model.future_schema), original.map(model => model.future_schema));
  assert.ok(original.every(model => model.multi_agent_version === "v2"));
  assert.deepEqual(promoteNativeMultiAgent(original, { ...settings, protocol: "v2" }), original);
});

test("V1 selection retains native models that explicitly disable collaboration", () => {
  const disabled = { ...structuredClone(native), multi_agent_version: "disabled" };
  const settings = { protocol: "v1", mode: "all", enabled: [disabled.slug], disabled: [] };
  assert.deepEqual(promoteNativeMultiAgent([disabled], settings), [disabled]);
});

function json(file, value) { writeFileSync(file, JSON.stringify(value), "utf8"); }
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-web-catalog-"));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("router-web-catalog-"));
    rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, "codex"), state = path.join(root, "state");
  mkdirSync(home); mkdirSync(state);
  const runtimeModule = path.join(root, "browser-runtime.mjs"), tunnelClientPath = path.join(root, "tunnel-client.exe");
  writeFileSync(runtimeModule, 'throw new Error("Catalog configuration must not execute browser work.");\n', "utf8");
  writeFileSync(tunnelClientPath, "Synthetic tunnel path; never execute.\n", "utf8");
  const configuration = { runtimeModule, pluginName: "Router local tools", pluginAppId: "asdk_app_fixture",
    pluginSelectionButtonName: "Router local tools, Connectors", tunnelId: "tunnel_fixture", tunnelClientPath, capabilities };
  const configurationPath = path.join(root, "browser-configuration.json");
  json(configurationPath, configuration);
  const models = [native, { ...native, slug: "gpt-5.6-sol", priority: 2 }];
  const source = path.join(root, "native.json"); json(source, { models });
  json(path.join(state, "native-catalog-source.json"), { version: 1, status: "active", path: source });
  json(path.join(state, "enabled-providers.json"), { version: 1, providers: ["openrouter"] });
  json(path.join(state, "model-picker.json"), { version: 1, hidden: [], visible: LISTED_MODELS.map(model => model.slug), seeded: LISTED_MODELS.map(model => model.slug) });
  writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
  const binary = path.join(root, "codex.cmd");
  writeFileSync(binary, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`, "utf8");
  writeFileSync(path.join(root, "fake-codex.mjs"), `const args=process.argv.slice(2).join(' ');if(args==='--version')console.log('codex-cli 0.162.0');else if(args==='login status')console.log('Logged in');else if(args==='debug models --bundled')console.log(${JSON.stringify(JSON.stringify({ models }))});else process.exitCode=2;`, "utf8");
  const env = { ...process.env, CODEX_HOME: home, CODEX_BIN: binary, CODEX_ROUTER_SOURCE_ROOT: repo,
    CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(state, "model-picker.json"), MODEL_ROUTER_MULTI_AGENT_STATE: path.join(state, "multi-agent-settings.json") };
  delete env.MODEL_ROUTER_SIGNED_ROUTING;
  return { root, home, state, env, configuration, configurationPath };
}

async function command(f, script, args = []) {
  const child = spawn(process.execPath, [path.join(repo, "src", script), ...args], { cwd: repo, env: f.env, windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout);
}

function catalog(f) {
  return JSON.parse(readFileSync(path.join(f.state, "merged-models.json"), "utf8")).models;
}

function webRoles(f) {
  return readdirSync(path.join(f.home, "agents")).filter(file => file.startsWith("router-model-chatgpt-web-"));
}

function saveConfiguredWeb(f) {
  const value = f.configuration;
  json(path.join(f.state, "chatgpt-web.json"), { version: 1, enabled: true, capabilities,
    browser: { runtimeModule: value.runtimeModule, pluginName: value.pluginName, pluginAppId: value.pluginAppId,
      pluginSelectionButtonName: value.pluginSelectionButtonName }, tunnel: { id: value.tunnelId, executable: value.tunnelClientPath } });
}

function seedConnectedWeb(f) {
  saveConfiguredWeb(f);
  const visible = [...LISTED_MODELS, ...buildWebBridgeModels(capabilities)].map(model => model.slug);
  json(path.join(f.state, "model-picker.json"), { version: 1, hidden: [], visible, seeded: visible });
}

test("configuring Web after watcher publication exposes models without switching protocol", { skip: process.platform !== "win32", timeout: 45000 }, async t => {
  const f = fixture(t);
  // A watcher can observe the newly enabled bridge after its settings write
  // and before the CLI records initial picker choices. It must not turn that
  // connection's explicit opt-in into a durable hidden default.
  saveConfiguredWeb(f);
  await command(f, "catalog.mjs");
  const beforeConfig = readFileSync(path.join(f.home, "config.toml"), "utf8");
  const connected = await command(f, "control.mjs", ["web", "browser", f.configurationPath]);
  assert.equal(connected.enabled, true);
  assert.equal(connected.subagentProtocol, "v2");
  assert.equal(readFileSync(path.join(f.home, "config.toml"), "utf8"), beforeConfig);
  const web = buildWebBridgeModels(capabilities);
  await command(f, "catalog.mjs");
  const published = catalog(f);
  const publishedWeb = published.filter(model => model.slug.startsWith("chatgpt-web/") && model.visibility === "list");
  assert.equal(publishedWeb.length, web.length);
  for (const model of publishedWeb) assert.deepEqual(model.input_modalities, ["text"]);
  assert.deepEqual(published.find(model => model.slug === native.slug).input_modalities, ["text", "image"]);
  assert.deepEqual(webRoles(f), []);
});

test("V1 Web roles follow picker choices across reconfiguration and V2 restores native collaboration", { skip: process.platform !== "win32", timeout: 45000 }, async t => {
  const f = fixture(t);
  // Start already connected; the preceding case proves initial opt-in through
  // the CLI. This case retains each control-to-publication handoff it checks.
  seedConnectedWeb(f);
  const web = buildWebBridgeModels(capabilities);
  const v1 = await command(f, "control.mjs", ["subagents", "protocol", "v1"]);
  assert.equal(v1.protocol, "v1"); assert.equal(v1.newConversationRequired, true);
  await command(f, "catalog.mjs");
  assert.ok(catalog(f).every(model => model.multi_agent_version === "v1"));
  assert.equal(webRoles(f).length, web.length);
  await command(f, "control.mjs", ["picker", "hide", web[0].slug]);
  await command(f, "control.mjs", ["web", "browser", f.configurationPath]);
  await command(f, "catalog.mjs");
  assert.equal(catalog(f).find(model => model.slug === web[0].slug).visibility, "hide", "reconfiguration preserves earlier picker choices");
  assert.equal(webRoles(f).length, web.length - 1);
  await command(f, "control.mjs", ["subagents", "protocol", "v2"]);
  await command(f, "catalog.mjs");
  assert.deepEqual(webRoles(f), []);
  assert.ok(catalog(f).some(model => model.slug === native.slug && model.multi_agent_version === "v2"));
});

test("disconnecting stale Web assets removes published models and V1 roles", { skip: process.platform !== "win32", timeout: 45000 }, async t => {
  for (const asset of ["runtimeModule", "tunnelClientPath"]) await t.test(asset, async subtest => {
    const f = fixture(subtest);
    seedConnectedWeb(f);
    await command(f, "control.mjs", ["subagents", "protocol", "v1"]);
    await command(f, "catalog.mjs");
    const before = readFileSync(path.join(f.home, "config.toml"), "utf8");
    const settingsPath = path.join(f.state, "chatgpt-web.json"), saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    const keyPath = path.join(f.state, "chatgpt-web-runtime-key.secret"), key = "synthetic retained catalog key\n";
    writeFileSync(keyPath, key, "utf8");
    assert.ok(catalog(f).some(model => model.slug.startsWith("chatgpt-web/")));
    assert.equal(webRoles(f).length, buildWebBridgeModels(capabilities).length);
    rmSync(f.configuration[asset]);
    const result = await command(f, "control.mjs", ["web", "disconnect"]);
    assert.equal(result.enabled, false);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { ...saved, enabled: false });
    await command(f, "catalog.mjs");
    assert.ok(!catalog(f).some(model => model.slug.startsWith("chatgpt-web/")));
    assert.deepEqual(webRoles(f), []);
    assert.equal(readFileSync(path.join(f.home, "config.toml"), "utf8"), before);
    assert.equal(readFileSync(keyPath, "utf8"), key);
  });
});
