import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installWebStopAdapter, rollbackWebStopAdapter, webStopAdapterStatus } from "../src/web-stop-adapter-install.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const signature = { status: "Valid", signerSubject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"', signerThumbprint: "fixture-openai-signer" };
const marker = "Stopping ChatGPT Web generation through Router adapter";
const trialThread = "01a14b65-a7a8-7b41-bd33-7c19d3c6df82";
const native = { type: "mcp_tool", server: "node_repl", tool: "js", input: { code: "preserved native definition" },
  timeout: 3, statusMessage: "Stopping owned ChatGPT Web generation", enabled: false, trusted: true };
const clone = value => structuredClone(value);

function fixture(t, { hooks = undefined, baseline = { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null } } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-adapter-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source"), stateDir = path.join(root, "state"), codexHome = path.join(root, "codex-home");
  for (const directory of [sourceDir, stateDir, codexHome]) mkdirSync(directory);
  const hooksPath = path.join(codexHome, "hooks.json"), receiptPath = path.join(stateDir, "web-stop-adapter", "ownership.json");
  if (hooks !== undefined) writeFileSync(hooksPath, typeof hooks === "string" ? hooks : encode(hooks));
  const sources = { "web-stop-adapter.mjs": 'import "./web-browser.mjs"; import "./web-stop-hook.mjs";\n',
    "web-browser.mjs": "export const browserFixture = true;\n", "web-stop-hook.mjs": "export const hookFixture = true;\n",
    "web-stop-adapter-entry.cs": 'class Entry { string Node = @"@@NODE@@", Adapter = @"@@ADAPTER@@", Config = @"@@CONFIG@@"; }\n' };
  for (const [name, contents] of Object.entries(sources)) writeFileSync(path.join(sourceDir, name), contents);
  const manifest = { version: 1 };
  for (const [key, basename] of [["node", "node.exe"], ["officialCli", "codex.exe"], ["officialNodeRepl", "node_repl.exe"]]) {
    const file = path.join(root, basename), contents = `signed fixture ${basename}`;
    writeFileSync(file, contents); manifest[key] = { path: file, sha256: hash(contents), authenticode: signature };
  }
  manifest.runtimeModule = path.join(root, "browser-runtime.mjs"); writeFileSync(manifest.runtimeModule, "export const fixture = true;\n");
  manifest.sdkPackageJson = path.join(root, "sdk", "package.json"); mkdirSync(path.dirname(manifest.sdkPackageJson));
  writeFileSync(manifest.sdkPackageJson, encode({ name: "@modelcontextprotocol/sdk", version: "fixture" }));
  manifest.threadIds = [trialThread];
  const manifestPath = path.join(root, "manifest.json");
  const saveManifest = () => writeFileSync(manifestPath, encode(manifest)); saveManifest();
  const effects = [], environment = { values: clone(baseline), calls: [],
    readPair() { return clone(this.values); },
    compareExchangePair(expected, values) {
      assert.deepEqual(this.values, expected, "compare both User settings before writing either");
      effects.push("environment"); this.calls.push({ expected: clone(expected), values: clone(values) }); this.values = clone(values);
      return { values: clone(values), broadcast: true };
    } };
  const dependencies = { sourceDir, environment, isPrivate: () => true,
    inspectSignatures: paths => paths.map(file => ({ path: file, ...signature })),
    compileEntry(source, output) { effects.push("compile"); assert.ok(readFileSync(source, "utf8").includes("class Entry")); writeFileSync(output, "custom unsigned compiled fixture"); },
    writePrivate(file, contents) { if (file === hooksPath) effects.push("hooks"); if (file === receiptPath) effects.push(JSON.parse(contents).state);
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); } };
  const options = { manifestPath, stateDir, codexHome, dependencies };
  return { root, sourceDir, sources, stateDir, codexHome, hooksPath, receiptPath, manifest, saveManifest, environment, dependencies, options, effects,
    receipt: () => JSON.parse(readFileSync(receiptPath, "utf8")), hooks: () => JSON.parse(readFileSync(hooksPath, "utf8")) };
}

test("adapter install publishes private baseline before global changes and preserves native hook/trust", t => {
  const original = { custom: true, hooks: { Interrupt: [{ matcher: "native", hooks: [native] }], Stop: [{ hooks: [{ type: "command", command: "user stop" }] }] } };
  const text = JSON.stringify(original), f = fixture(t, { hooks: text });
  const write = f.dependencies.writePrivate;
  f.dependencies.writePrivate = (file, contents) => {
    if (file === f.hooksPath) {
      assert.equal(f.receipt().state, "prepared");
      assert.deepEqual(f.receipt().previousEnvironment, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
      assert.equal(f.receipt().previousHooksText, text);
    }
    write(file, contents);
  };
  const exchange = f.environment.compareExchangePair.bind(f.environment);
  f.environment.compareExchangePair = (expected, values) => { assert.equal(f.receipt().state, "prepared"); return exchange(expected, values); };
  const result = installWebStopAdapter(f.options);
  assert.equal(result.installed, true); assert.equal(result.restartRequired, true); assert.equal(result.trustRequired, true);
  assert.equal(result.nativeHookOperatorStep, true); assert.equal(result.environmentBroadcast, true);
  assert.deepEqual(f.hooks().hooks.Interrupt[0], original.hooks.Interrupt[0]);
  assert.deepEqual(f.hooks().hooks.Stop, original.hooks.Stop);
  assert.deepEqual(f.hooks().hooks.Interrupt[1].hooks[0], { type: "mcp_tool", server: "node_repl", tool: "router_web_interrupt",
    input: { hook_event_name: "${hook_event_name}", session_id: "${session_id}", turn_id: "${turn_id}" }, timeout: 3, statusMessage: marker });
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: f.manifest.officialCli.path, CODEX_NODE_REPL_PATH: result.entryPath });
  const config = JSON.parse(readFileSync(result.configPath, "utf8"));
  assert.deepEqual(config, { version: 1, server: f.manifest.officialNodeRepl.path, serverSha256: f.manifest.officialNodeRepl.sha256,
    stateDir: f.stateDir, runtimeModule: f.manifest.runtimeModule, sdkPackageJson: f.manifest.sdkPackageJson,
    threadIds: [trialThread], receiptPath: path.join(f.stateDir, "web-stop-adapter", "events.jsonl") });
  for (const name of ["web-stop-adapter.mjs", "web-browser.mjs", "web-stop-hook.mjs"]) assert.equal(readFileSync(path.join(result.managedDirectory, name), "utf8"), f.sources[name]);
  const launcher = readFileSync(path.join(result.managedDirectory, "entry.cs"), "utf8");
  assert.equal(launcher.includes("@@"), false); assert.ok(launcher.includes(result.configPath)); assert.ok(launcher.includes(f.manifest.node.path));
  assert.deepEqual(webStopAdapterStatus(f.options).conflicts, []);
  const rolledBack = rollbackWebStopAdapter(f.options);
  assert.equal(rolledBack.state, "removed"); assert.equal(rolledBack.retainedManagedFiles, true);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
  assert.equal(readFileSync(f.hooksPath, "utf8"), text); assert.equal(existsSync(result.entryPath), true);
  assert.equal(rollbackWebStopAdapter(f.options).changed, false);
});

test("repeat install is inert and thread scope promotion stages a new version while retaining first baseline", t => {
  const f = fixture(t), first = installWebStopAdapter(f.options), baseline = readFileSync(f.receiptPath, "utf8");
  const effects = f.effects.length;
  installWebStopAdapter(f.options);
  assert.equal(f.effects.length, effects); assert.equal(readFileSync(f.receiptPath, "utf8"), baseline);
  const oldConfig = readFileSync(first.configPath, "utf8");
  f.manifest.threadIds = null; f.saveManifest();
  const promoted = installWebStopAdapter(f.options);
  assert.notEqual(promoted.managedDirectory, first.managedDirectory); assert.equal(promoted.threadIds, null);
  assert.equal(readFileSync(first.configPath, "utf8"), oldConfig); assert.equal(existsSync(first.entryPath), true);
  assert.equal(f.hooks().hooks.Interrupt.length, 1);
  assert.deepEqual(f.receipt().previousEnvironment, JSON.parse(baseline).previousEnvironment);
  assert.equal(f.receipt().previousHooksText, null);
  rollbackWebStopAdapter(f.options);
  assert.deepEqual(f.environment.values, JSON.parse(baseline).previousEnvironment); assert.equal(existsSync(f.hooksPath), false);
});

test("activation failure after a partial pair write restores both settings and keeps durable recovery baseline", t => {
  const f = fixture(t, { hooks: '{"user":true}' });
  const exchange = f.environment.compareExchangePair.bind(f.environment); let failed = false;
  f.environment.compareExchangePair = (expected, values) => {
    if (!failed) { failed = true; f.environment.values.CODEX_CLI_PATH = values.CODEX_CLI_PATH; throw new Error("fixture partial pair failure"); }
    return exchange(expected, values);
  };
  assert.throws(() => installWebStopAdapter(f.options), /fixture partial pair failure/u);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
  assert.equal(readFileSync(f.hooksPath, "utf8"), '{"user":true}'); assert.equal(f.receipt().state, "prepared");
  installWebStopAdapter(f.options);
  assert.equal(f.receipt().previousEnvironment.CODEX_CLI_PATH, "original working CLI");
  rollbackWebStopAdapter(f.options); assert.equal(readFileSync(f.hooksPath, "utf8"), '{"user":true}');
});

test("failed final ownership publication restores prior runtime settings without losing baseline", t => {
  const f = fixture(t), write = f.dependencies.writePrivate;
  f.dependencies.writePrivate = (file, contents) => {
    if (file === f.receiptPath && JSON.parse(contents).state === "installed") throw new Error("fixture receipt failure");
    write(file, contents);
  };
  assert.throws(() => installWebStopAdapter(f.options), /fixture receipt failure/u);
  assert.equal(f.receipt().state, "prepared"); assert.equal(f.receipt().previousEnvironment.CODEX_CLI_PATH, "original working CLI");
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
  assert.equal(existsSync(f.hooksPath), false);
  f.dependencies.writePrivate = write; rollbackWebStopAdapter(f.options); assert.equal(f.receipt().state, "removed");
});

test("rollback restores only still-owned settings and preserves a foreign override plus unrelated hook edits", t => {
  const f = fixture(t), installed = installWebStopAdapter(f.options);
  f.environment.values.CODEX_CLI_PATH = "foreign CLI choice";
  const hooks = f.hooks(); hooks.userAdded = true; hooks.hooks.Interrupt[0].matcher = "user matcher";
  hooks.hooks.Interrupt[0].hooks.push({ type: "command", command: "foreign added hook" });
  writeFileSync(f.hooksPath, encode(hooks));
  assert.throws(() => installWebStopAdapter(f.options), /foreign value/u);
  const result = rollbackWebStopAdapter(f.options);
  assert.equal(result.state, "prepared"); assert.equal(result.conflicts.length, 1);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "foreign CLI choice", CODEX_NODE_REPL_PATH: null });
  assert.deepEqual(f.hooks(), { userAdded: true, hooks: { Interrupt: [{ matcher: "user matcher", hooks: [{ type: "command", command: "foreign added hook" }] }] } });
  assert.equal(existsSync(installed.entryPath), true);
});

test("rollback preserves a changed managed hook while restoring owned overrides", t => {
  const f = fixture(t); installWebStopAdapter(f.options);
  const hooks = f.hooks(); hooks.hooks.Interrupt[0].hooks[0].input.foreign = true; writeFileSync(f.hooksPath, encode(hooks));
  assert.equal(webStopAdapterStatus(f.options).installed, false);
  const result = rollbackWebStopAdapter(f.options);
  assert.equal(result.conflicts.length, 1); assert.deepEqual(f.hooks(), hooks);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
});

test("a failed rollback never adopts a foreign override for a later recovery attempt", t => {
  const f = fixture(t); installWebStopAdapter(f.options);
  f.environment.values.CODEX_CLI_PATH = "foreign CLI choice";
  const exchange = f.environment.compareExchangePair.bind(f.environment); let failed = false;
  f.environment.compareExchangePair = (expected, values) => {
    if (!failed) { failed = true; throw new Error("fixture rollback pair failure"); }
    return exchange(expected, values);
  };
  assert.throws(() => rollbackWebStopAdapter(f.options), /fixture rollback pair failure/u);
  assert.equal(f.receipt().state, "prepared");
  const recovered = rollbackWebStopAdapter(f.options);
  assert.equal(recovered.conflicts.length, 1);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "foreign CLI choice", CODEX_NODE_REPL_PATH: null });
});

test("rollback restores owned settings after external official runtime or SDK files change", t => {
  const f = fixture(t), installed = installWebStopAdapter(f.options);
  writeFileSync(f.manifest.node.path, "updated official runtime fixture");
  writeFileSync(f.manifest.sdkPackageJson, encode({ name: "@modelcontextprotocol/sdk", version: "updated fixture" }));
  assert.equal(webStopAdapterStatus(f.options).installed, false);
  const result = rollbackWebStopAdapter(f.options);
  assert.equal(result.state, "removed"); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
  assert.equal(existsSync(installed.entryPath), true);
  assert.equal(readFileSync(f.manifest.node.path, "utf8"), "updated official runtime fixture");
});

test("foreign hook identity, invalid manifest and runtime byte/signature mismatch never change globals", async t => {
  for (const branch of ["foreign_hook", "bytes", "signature", "scope", "sdk", "manifest_field"]) {
    await t.test(branch, subtest => {
      const f = fixture(subtest, branch === "foreign_hook" ? { hooks: { hooks: { Interrupt: [{ hooks: [{ statusMessage: marker, type: "command", command: "foreign" }] }] } } } : {});
      if (branch === "bytes") writeFileSync(f.manifest.node.path, "wrong binary");
      if (branch === "signature") f.dependencies.inspectSignatures = paths => paths.map(file => ({ path: file, ...signature, status: "NotSigned" }));
      if (branch === "scope") f.manifest.threadIds = [trialThread, trialThread];
      if (branch === "sdk") writeFileSync(f.manifest.sdkPackageJson, encode({ name: "foreign SDK", version: "fixture" }));
      if (branch === "manifest_field") f.manifest.unknownCommand = "must refuse";
      f.saveManifest(); assert.throws(() => installWebStopAdapter(f.options));
      assert.equal(f.environment.calls.length, 0); assert.equal(f.effects.includes("hooks"), false); assert.equal(existsSync(f.receiptPath), false);
    });
  }
});

test("changed managed files and unprotected ownership are rejected without overwriting managed bytes", t => {
  const f = fixture(t), result = installWebStopAdapter(f.options);
  const changed = path.join(result.managedDirectory, "web-stop-adapter.mjs"); writeFileSync(changed, "foreign adapter bytes");
  assert.equal(webStopAdapterStatus(f.options).installed, false);
  assert.throws(() => installWebStopAdapter(f.options), /identity mismatch/u);
  assert.throws(() => rollbackWebStopAdapter(f.options), /identity mismatch/u);
  assert.equal(readFileSync(changed, "utf8"), "foreign adapter bytes");
  f.dependencies.isPrivate = () => false;
  assert.throws(() => webStopAdapterStatus(f.options), /receipt is not private/u);
});

test("a foreign file in the staged version is retained and blocks activation", t => {
  const f = fixture(t), result = installWebStopAdapter(f.options), foreign = path.join(result.managedDirectory, "foreign.dll");
  writeFileSync(foreign, "foreign");
  assert.throws(() => installWebStopAdapter(f.options), /file set/u);
  assert.equal(readFileSync(foreign, "utf8"), "foreign"); assert.ok(readdirSync(result.managedDirectory).includes("foreign.dll"));
});
