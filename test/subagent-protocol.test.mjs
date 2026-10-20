import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyMultiAgentCapabilities, subagentEligibleModels } from "../src/multi-agent-state.mjs";
import { scanTomlDocument } from "../src/toml-structure.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateModule = pathToFileURL(path.join(root, "src/multi-agent-state.mjs")).href;

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-protocol-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "codex"), state = path.join(directory, "state");
  mkdirSync(home); mkdirSync(state);
  writeFileSync(path.join(state, "caller-secret"), "a".repeat(48));
  return { config: path.join(home, "config.toml"), settings: path.join(state, "multi-agent-settings.json"),
    state, env: { ...process.env, CODEX_HOME: home, MODEL_ROUTER_STATE_DIR: state, CODEX_BIN: process.execPath } };
}

function evaluate(f, code) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root, env: f.env, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function select(f, protocol) {
  return evaluate(f, `import {setSubagentProtocol} from ${JSON.stringify(stateModule)};
    process.stdout.write(JSON.stringify(await setSubagentProtocol(${JSON.stringify(protocol)})));`);
}

function enable(f) {
  const result = spawnSync(process.execPath, [path.join(root, "src/config-manager.mjs"), "enable"], {
    cwd: root, env: f.env, encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function feature(contents, name) {
  const document = scanTomlDocument(contents);
  const assignment = document.assignments.find(({ tablePath, key }) =>
    tablePath.length === 1 && tablePath[0] === "features" && key.length === 1 && key[0] === name);
  return assignment && document.lines[assignment.index];
}

test("protocol selection defaults to V2 and preserves independent route, effort and user settings", t => {
  const f = fixture(t);
  assert.equal(evaluate(f, `import {readSubagentProtocol} from ${JSON.stringify(stateModule)};
    process.stdout.write(JSON.stringify(readSubagentProtocol()));`), "v2");
  assert.equal(existsSync(f.settings), false, "reading defaults does not claim configuration ownership");
  const settings = { version: 2, mode: "selected", enabled: ["switchyard/auto"], disabled: ["openrouter/pareto"],
    efforts: { "switchyard/auto": "high" } };
  writeFileSync(f.settings, JSON.stringify(settings));
  const original = 'model = "gpt-6.1-sol"\n# user note\n[features]\napps = true\n[agents.user_role]\ndescription = "Keep me"\n';
  writeFileSync(f.config, original);
  const selected = select(f, "v1");
  assert.equal(selected.protocol, "v1");
  assert.equal(selected.restartRequired, true);
  assert.equal(selected.newConversationRequired, true);
  assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")), { ...settings, protocol: "v1" });
  let contents = readFileSync(f.config, "utf8");
  assert.equal(feature(contents, "multi_agent"), "multi_agent = true");
  assert.equal(feature(contents, "multi_agent_v2"), "multi_agent_v2 = false");
  assert.match(contents, /apps = true/u);
  assert.match(contents, /\[agents\.user_role\]\ndescription = "Keep me"/u);
  assert.match(contents, /# user note/u);
  enable(f);
  contents = readFileSync(f.config, "utf8");
  assert.equal(feature(contents, "multi_agent_v2"), "multi_agent_v2 = false", "ordinary enable respects the selected protocol");
  const v2 = select(f, "v2");
  assert.equal(v2.protocol, "v2");
  contents = readFileSync(f.config, "utf8");
  assert.equal(feature(contents, "multi_agent"), undefined);
  assert.match(feature(contents, "multi_agent_v2"), /enabled = true, max_concurrent_threads_per_session = 6/u);
  assert.match(feature(contents, "multi_agent_v2"), /root_agent_usage_hint_text = /u);
  assert.match(contents, /\[agents\.user_role\]\ndescription = "Keep me"/u);
});

test("explicit protocol selection refuses user-owned features without changing either document", t => {
  const f = fixture(t), settings = '{"version":2,"mode":"all","enabled":[],"disabled":[],"protocol":"v2"}\n';
  writeFileSync(f.settings, settings);
  for (const original of [
    '[features]\nmulti_agent = true\n',
    '["features"]\n"multi_agent_v2" = { enabled = true } # mine\n',
    '[features.multi_agent_v2]\nenabled = false\n',
    'features.multi_agent_v2 = false\n',
  ]) {
    writeFileSync(f.config, original);
    const failure = evaluate(f, `import {setSubagentProtocol} from ${JSON.stringify(stateModule)};
      try { await setSubagentProtocol('v1'); throw new Error('unexpected success'); }
      catch(error) { process.stdout.write(JSON.stringify(error.message)); }`);
    assert.match(failure, /Refusing to replace user-owned multi-agent feature/u);
    assert.equal(readFileSync(f.config, "utf8"), original);
    assert.equal(readFileSync(f.settings, "utf8"), settings);
  }
});

test("invalid persisted or requested protocols fail before any configuration edit", t => {
  const f = fixture(t), original = '[features]\napps = true\n';
  writeFileSync(f.config, original);
  const invalid = '{"version":2,"mode":"all","enabled":[],"disabled":[],"protocol":"v3"}\n';
  writeFileSync(f.settings, invalid);
  const rejectedState = evaluate(f, `import {readSubagentProtocol,setSubagentProtocol} from ${JSON.stringify(stateModule)};
    const errors=[];try{readSubagentProtocol();}catch(error){errors.push(error.message);}
    try{await setSubagentProtocol('v1');}catch(error){errors.push(error.message);}
    process.stdout.write(JSON.stringify(errors));`);
  assert.equal(rejectedState.length, 2);
  assert.ok(rejectedState.every(message => message.includes("Cannot read subagent settings")));
  const rejectedSelection = evaluate(f, `import {setSubagentProtocol} from ${JSON.stringify(stateModule)};
    try{await setSubagentProtocol('v3');}catch(error){process.stdout.write(JSON.stringify(error.message));}`);
  assert.match(rejectedSelection, /Unknown subagent protocol/u);
  assert.equal(readFileSync(f.settings, "utf8"), invalid);
  assert.equal(readFileSync(f.config, "utf8"), original);
});

test("V1 marker recovery accepts only the exact emitted feature sequence", t => {
  const f = fixture(t);
  writeFileSync(f.config, '[features]\napps = true\n');
  select(f, "v1");
  const marker = "# END codex-router-multi-agent-v1-managed";
  const damaged = readFileSync(f.config, "utf8").replace(marker, "user_feature = true\n# preserve this note");
  writeFileSync(f.config, damaged);
  select(f, "v2");
  assert.match(readFileSync(f.config, "utf8"), /user_feature = true\n# preserve this note/u);
  const modified = damaged.replace("multi_agent = true", "multi_agent = false");
  writeFileSync(f.config, modified);
  const failure = evaluate(f, `import {setSubagentProtocol} from ${JSON.stringify(stateModule)};
    try{await setSubagentProtocol('v2');}catch(error){process.stdout.write(JSON.stringify(error.message));}`);
  assert.match(failure, /Refusing to edit an unterminated managed block/u);
  assert.equal(readFileSync(f.config, "utf8"), modified);
});

test("a failed settings publication restores the previous config and preserves missing state", t => {
  const f = fixture(t);
  for (const originalSettings of [undefined, '{"version":2,"mode":"all","enabled":[],"disabled":[],"protocol":"v2"}\n']) {
    if (originalSettings !== undefined) writeFileSync(f.settings, originalSettings);
    const original = Buffer.from('model = "gpt-6.1-sol"\r\n[features]\r\napps = true\r\n');
    writeFileSync(f.config, original);
    const failure = evaluate(f, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const originalRename=fs.renameSync; let injected=false;
      fs.renameSync=(from,to)=>{ if(to===${JSON.stringify(f.settings)}&&!injected){injected=true;throw new Error('synthetic settings publication failure');} return originalRename(from,to);};
      syncBuiltinESMExports();
      const {setSubagentProtocol}=await import(${JSON.stringify(stateModule)});
      try { await setSubagentProtocol('v1'); throw new Error('unexpected success'); }
      catch(error){process.stdout.write(JSON.stringify({message:error.message,injected}));}`);
    assert.equal(failure.injected, true);
    assert.match(failure.message, /synthetic settings publication failure/u);
    assert.deepEqual(readFileSync(f.config), original, "rollback restores exact original bytes");
    if (originalSettings === undefined) assert.equal(existsSync(f.settings), false);
    else assert.equal(readFileSync(f.settings, "utf8"), originalSettings);
  }
});

test("protocol, route choices and effort overrides survive each other's updates", t => {
  const f = fixture(t);
  writeFileSync(f.config, '[features]\napps = true\n');
  select(f, "v1");
  const observed = evaluate(f, `import {setMultiAgentMode,setMultiAgentModel,setSubagentEffort,readMultiAgentSettings,readSubagentProtocol}
    from ${JSON.stringify(stateModule)};
    await setMultiAgentMode('selected'); await setMultiAgentModel('switchyard/auto',true);
    await setSubagentEffort('switchyard/auto','high');
    process.stdout.write(JSON.stringify({settings:readMultiAgentSettings(),protocol:readSubagentProtocol()}));`);
  assert.equal(observed.protocol, "v1");
  assert.equal(observed.settings.mode, "selected");
  assert.deepEqual(observed.settings.enabled, ["switchyard/auto"]);
  assert.deepEqual(observed.settings.efforts, { "switchyard/auto": "high" });
});

test("V1 role eligibility preserves hidden, disabled and selected choices and never exposes Web roles in V2", () => {
  const models = [
    { slug: "switchyard/auto", multiAgentVersion: "v2" },
    { slug: "chatgpt-web/visible", multiAgentVersion: "v1" },
    { slug: "chatgpt-web/hidden", multiAgentVersion: "v1" },
    { slug: "chatgpt-web/disabled", multiAgentVersion: "v1" },
    { slug: "chatgpt-web/unselected", multiAgentVersion: "v1" },
  ];
  const settings = { protocol: "v1", mode: "selected", enabled: models.slice(0, 4).map(model => model.slug),
    disabled: ["chatgpt-web/disabled"] };
  const applied = applyMultiAgentCapabilities(models, settings, { hidden: new Set(["chatgpt-web/hidden"]) });
  assert.ok(applied.every(model => model.multiAgentVersion === "v1"));
  assert.deepEqual(subagentEligibleModels(applied, settings).map(model => model.slug), ["switchyard/auto", "chatgpt-web/visible"]);
  const v2 = { ...settings, protocol: "v2" };
  const webClaimingV2 = { slug: "chatgpt-web/visible", multiAgentVersion: "v2" };
  assert.deepEqual(subagentEligibleModels([webClaimingV2], v2), []);
  assert.deepEqual(subagentEligibleModels(applyMultiAgentCapabilities(models, v2), v2).map(model => model.slug), ["switchyard/auto"]);
});

test("Web effort overrides use the bridge account's exact advertised vocabulary", t => {
  const f = fixture(t);
  const runtimeModule = path.join(f.state, "browser-runtime.mjs"), executable = path.join(f.state, "tunnel-client.exe");
  writeFileSync(runtimeModule, 'throw new Error("Effort configuration must not execute browser work.");\n', "utf8");
  writeFileSync(executable, "Synthetic tunnel path; never execute.\n", "utf8");
  writeFileSync(path.join(f.state, "chatgpt-web.json"), JSON.stringify({ version: 1, enabled: true,
    browser: { runtimeModule, pluginName: "Router local tools", pluginAppId: "asdk_app_fixture",
      pluginSelectionButtonName: "Router local tools, Connectors" }, tunnel: { id: "tunnel_fixture", executable },
    capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false } }));
  const observed = evaluate(f, `import {setSubagentEffort,subagentEffort} from ${JSON.stringify(stateModule)};
    await setSubagentEffort('chatgpt-web/gpt-6-sol','high');
    let rejected;try{await setSubagentEffort('chatgpt-web/gpt-6-sol','xhigh');}catch(error){rejected=error.message;}
    const persisted=subagentEffort('chatgpt-web/gpt-6-sol');
    await setSubagentEffort('chatgpt-web/gpt-6-sol',undefined);
    process.stdout.write(JSON.stringify({persisted,rejected,cleared:subagentEffort('chatgpt-web/gpt-6-sol')===undefined}));`);
  assert.equal(observed.persisted, "high");
  assert.match(observed.rejected, /Choose: medium, high/u);
  assert.equal(observed.cleared, true);
});
