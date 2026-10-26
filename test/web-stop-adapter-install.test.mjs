import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installWebStopAdapter, rollbackWebStopAdapter, webStopAdapterStatus, withWebStopAdapterRuntimeRefresh } from "../src/web-stop-adapter-install.mjs";
import { createAdapterHook } from "../src/web-stop-contract.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const signature = { status: "Valid", signerSubject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"', signerThumbprint: "fixture-openai-signer" };
const marker = "Stopping ChatGPT Web generation through Router adapter";
const trialThread = "01a14b65-a7a8-7b41-bd33-7c19d3c6df82";
const userHook = { type: "command", command: "user interrupt handler",
  timeout: 3, statusMessage: "User interrupt", enabled: false, trusted: true };
const clone = value => structuredClone(value);

function fixture(t, { hooks = undefined, baseline = { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null } } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-adapter-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source"), stateDir = path.join(root, "state"), codexHome = path.join(root, "codex-home");
  for (const directory of [sourceDir, stateDir, codexHome]) mkdirSync(directory);
  const hooksPath = path.join(codexHome, "hooks.json"), receiptPath = path.join(stateDir, "web-stop-adapter", "ownership.json");
  if (hooks !== undefined) writeFileSync(hooksPath, typeof hooks === "string" ? hooks : encode(hooks));
  const sources = { "web-stop-adapter.mjs": 'import "./web-browser.mjs"; import "./web-stop-hook.mjs"; import "./web-stop-contract.mjs";\n',
    "web-browser.mjs": 'import "./web-browser-state.mjs"; export const browserFixture = true;\n',
    "web-stop-hook.mjs": 'import "./web-browser-state.mjs"; export const hookFixture = true;\n',
    "web-browser-state.mjs": "export const stateFixture = true;\n",
    "web-stop-contract.mjs": "export const contractFixture = true;\n",
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

function replaceOfficialRuntime(f) {
  const previousPaths = [f.manifest.node.path, f.manifest.officialCli.path, f.manifest.officialNodeRepl.path,
    f.manifest.runtimeModule, f.manifest.sdkPackageJson];
  const directory = path.join(f.root, "updated-runtime"); mkdirSync(directory);
  for (const [name, basename] of [["node", "node.exe"], ["officialCli", "codex.exe"], ["officialNodeRepl", "node_repl.exe"]]) {
    const file = path.join(directory, basename), contents = `updated signed fixture ${basename}`;
    writeFileSync(file, contents); f.manifest[name] = { path: file, sha256: hash(contents), authenticode: signature };
  }
  f.manifest.runtimeModule = path.join(directory, "browser-runtime.mjs");
  writeFileSync(f.manifest.runtimeModule, "export const updatedFixture = true;\n");
  f.manifest.sdkPackageJson = path.join(directory, "package.json");
  writeFileSync(f.manifest.sdkPackageJson, encode({ name: "@modelcontextprotocol/sdk", version: "updated fixture" }));
  for (const file of previousPaths) rmSync(file);
  f.saveManifest();
  return previousPaths;
}

function retainLegacyCliPin(f) {
  const receipt = f.receipt();
  receipt.environment.CODEX_CLI_PATH = f.manifest.officialCli.path;
  writeFileSync(f.receiptPath, encode(receipt));
  f.environment.values.CODEX_CLI_PATH = receipt.environment.CODEX_CLI_PATH;
}

function retainLegacyHook(f) {
  const receipt = f.receipt(), document = f.hooks(), hook = { ...createAdapterHook(), timeout: 3 };
  receipt.hook = hook;
  for (const entry of document.hooks.Interrupt) for (let index = 0; index < entry.hooks.length; index++) {
    if (entry.hooks[index].statusMessage === marker) entry.hooks[index] = clone(hook);
  }
  writeFileSync(f.receiptPath, encode(receipt)); writeFileSync(f.hooksPath, encode(document));
  return hook;
}

test("adapter install publishes private baseline before global changes and preserves unrelated user hook/trust", t => {
  const original = { custom: true, hooks: { Interrupt: [{ matcher: "user", hooks: [userHook] }], Stop: [{ hooks: [{ type: "command", command: "user stop" }] }] } };
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
  assert.equal(result.environmentBroadcast, true);
  assert.deepEqual(f.hooks().hooks.Interrupt[0], original.hooks.Interrupt[0]);
  assert.deepEqual(f.hooks().hooks.Stop, original.hooks.Stop);
  assert.deepEqual(f.hooks().hooks.Interrupt[1].hooks[0], { type: "mcp_tool", server: "node_repl", tool: "router_web_interrupt",
    input: { hook_event_name: "${hook_event_name}", session_id: "${session_id}", turn_id: "${turn_id}" }, timeout: 10, statusMessage: marker });
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: result.entryPath });
  const managed = JSON.parse(readFileSync(path.join(result.managedDirectory, "manifest.json"), "utf8"));
  assert.deepEqual(managed.plan.officialCli, f.manifest.officialCli);
  const config = JSON.parse(readFileSync(result.configPath, "utf8"));
  assert.deepEqual(config, { version: 1, server: f.manifest.officialNodeRepl.path, serverSha256: f.manifest.officialNodeRepl.sha256,
    stateDir: f.stateDir, runtimeModule: f.manifest.runtimeModule, sdkPackageJson: f.manifest.sdkPackageJson,
    threadIds: [trialThread], receiptPath: path.join(f.stateDir, "web-stop-adapter", "events.jsonl") });
  for (const name of ["web-stop-adapter.mjs", "web-browser.mjs", "web-browser-state.mjs", "web-stop-hook.mjs", "web-stop-contract.mjs"]) assert.equal(readFileSync(path.join(result.managedDirectory, name), "utf8"), f.sources[name]);
  const launcher = readFileSync(path.join(result.managedDirectory, "entry.cs"), "utf8");
  assert.equal(launcher.includes("@@"), false); assert.ok(launcher.includes(result.configPath)); assert.ok(launcher.includes(f.manifest.node.path));
  assert.deepEqual(webStopAdapterStatus(f.options).conflicts, []);
  const rolledBack = rollbackWebStopAdapter(f.options);
  assert.equal(rolledBack.state, "removed"); assert.equal(rolledBack.retainedManagedFiles, true);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
  assert.equal(readFileSync(f.hooksPath, "utf8"), text); assert.equal(existsSync(result.entryPath), true);
  assert.equal(rollbackWebStopAdapter(f.options).changed, false);
});

test("the exact legacy hook remains readable and removable before migration", t => {
  const f = fixture(t); installWebStopAdapter(f.options); retainLegacyHook(f);
  const hooks = readFileSync(f.hooksPath, "utf8"), receipt = readFileSync(f.receiptPath, "utf8"), effects = f.effects.length;
  const status = webStopAdapterStatus(f.options);
  assert.equal(status.installed, true); assert.equal(status.hookDefinitionOwned, true); assert.deepEqual(status.conflicts, []);
  assert.equal(readFileSync(f.hooksPath, "utf8"), hooks); assert.equal(readFileSync(f.receiptPath, "utf8"), receipt);
  assert.equal(f.effects.length, effects);
  assert.equal(rollbackWebStopAdapter(f.options).state, "removed"); assert.equal(existsSync(f.hooksPath), false);
});

test("legacy hook migration replaces only the owned definition and preserves neighbors and rollback baseline", t => {
  const original = { hooks: { Interrupt: [{ matcher: "user", hooks: [userHook] }] } }, f = fixture(t, { hooks: original });
  installWebStopAdapter(f.options); const legacy = retainLegacyHook(f), before = f.receipt(), document = f.hooks();
  document.hooks.Interrupt[1] = { matcher: "retained wrapper", hooks: [userHook, legacy, { type: "command", command: "neighbor" }] };
  writeFileSync(f.hooksPath, encode(document));
  const result = installWebStopAdapter(f.options);
  assert.equal(result.hookDefinitionChanged, true); assert.equal(result.trustRequired, true); assert.equal(result.restartRequired, true);
  const expected = clone(document); expected.hooks.Interrupt[1].hooks[1] = createAdapterHook();
  assert.deepEqual(f.hooks(), expected); assert.equal(Object.hasOwn(f.hooks().hooks.Interrupt[1].hooks[1], "trusted"), false);
  assert.deepEqual(f.receipt().hook, createAdapterHook()); assert.equal(Object.hasOwn(f.receipt(), "priorHook"), false);
  assert.equal(f.receipt().previousHooksText, before.previousHooksText);
  assert.deepEqual(f.receipt().previousEnvironment, before.previousEnvironment);
  const effects = f.effects.length;
  assert.equal(installWebStopAdapter(f.options).hookDefinitionChanged, false); assert.equal(f.effects.length, effects);
  assert.equal(rollbackWebStopAdapter(f.options).state, "removed");
  expected.hooks.Interrupt[1].hooks.splice(1, 1); assert.deepEqual(f.hooks(), expected);
});

test("hook migration accepts neither arbitrary legacy timeouts nor extra owned-hook fields", async t => {
  for (const [name, mutate] of [["unshipped timeout", hook => { hook.timeout = 4; }], ["string timeout", hook => { hook.timeout = "3"; }],
    ["trust field", hook => { hook.trusted = true; }], ["changed input", hook => { hook.input.foreign = true; }]]) await t.test(name, subtest => {
    const f = fixture(subtest); installWebStopAdapter(f.options); retainLegacyHook(f);
    const receipt = f.receipt(); mutate(receipt.hook); writeFileSync(f.receiptPath, encode(receipt));
    const before = { hooks: readFileSync(f.hooksPath, "utf8"), receipt: readFileSync(f.receiptPath, "utf8"), environment: clone(f.environment.values) };
    assert.throws(() => webStopAdapterStatus(f.options), /foreign adapter ownership receipt/u);
    assert.throws(() => installWebStopAdapter(f.options), /foreign adapter ownership receipt/u);
    assert.throws(() => rollbackWebStopAdapter(f.options), /foreign adapter ownership receipt/u);
    assert.equal(readFileSync(f.hooksPath, "utf8"), before.hooks); assert.equal(readFileSync(f.receiptPath, "utf8"), before.receipt);
    assert.deepEqual(f.environment.values, before.environment);
  });
});

test("failed hook migration preserves both exact prepared endpoints for retry and rollback", async t => {
  for (const endpoint of ["legacy-restored", "current-published"]) await t.test(endpoint, subtest => {
    const f = fixture(subtest); installWebStopAdapter(f.options); const legacy = retainLegacyHook(f);
    const write = f.dependencies.writePrivate; let failed = false;
    f.dependencies.writePrivate = (file, contents) => {
      if (!failed && file === f.receiptPath && JSON.parse(contents).state === "installed") { failed = true; throw new Error("fixture migration publication failure"); }
      write(file, contents);
    };
    assert.throws(() => installWebStopAdapter(f.options), /migration publication failure/u);
    assert.equal(f.receipt().state, "prepared"); assert.deepEqual(f.receipt().priorHook, legacy);
    assert.deepEqual(f.hooks().hooks.Interrupt[0].hooks[0], legacy);
    if (endpoint === "current-published") {
      const document = f.hooks(); document.hooks.Interrupt[0].hooks[0] = createAdapterHook(); writeFileSync(f.hooksPath, encode(document));
    }
    assert.equal(webStopAdapterStatus(f.options).hookDefinitionOwned, true);
    f.dependencies.writePrivate = write;
    if (endpoint === "legacy-restored") assert.equal(installWebStopAdapter(f.options).installed, true);
    assert.equal(rollbackWebStopAdapter(f.options).state, "removed"); assert.equal(existsSync(f.hooksPath), false);
    assert.equal(Object.hasOwn(f.receipt(), "priorHook"), false);
  });
});

test("failed coordinated hook migration restores the exact prior hook and receipt bytes", async t => {
  const f = fixture(t, { hooks: '{"custom":true}' }); installWebStopAdapter(f.options); retainLegacyHook(f);
  const before = { hooks: readFileSync(f.hooksPath, "utf8"), receipt: readFileSync(f.receiptPath, "utf8"), environment: clone(f.environment.values) };
  await assert.rejects(withWebStopAdapterRuntimeRefresh(f.options, async result => {
    assert.equal(result.hookDefinitionChanged, true); assert.deepEqual(f.hooks().hooks.Interrupt[0].hooks[0], createAdapterHook());
    throw new Error("fixture reload failed");
  }), /fixture reload failed/u);
  assert.equal(readFileSync(f.hooksPath, "utf8"), before.hooks); assert.equal(readFileSync(f.receiptPath, "utf8"), before.receipt);
  assert.deepEqual(f.environment.values, before.environment); assert.equal(webStopAdapterStatus(f.options).hookDefinitionOwned, true);
});

test("coordinated hook migration compensation preserves concurrent foreign hook edits", async t => {
  const f = fixture(t); installWebStopAdapter(f.options); retainLegacyHook(f);
  let foreignText;
  await assert.rejects(withWebStopAdapterRuntimeRefresh(f.options, async () => {
    const document = f.hooks(); document.foreign = "concurrent edit"; foreignText = encode(document); writeFileSync(f.hooksPath, foreignText);
    throw new Error("fixture reload failed");
  }), /rollback incomplete: Foreign hooks changes preserved/u);
  assert.equal(readFileSync(f.hooksPath, "utf8"), foreignText);
  assert.equal(webStopAdapterStatus(f.options).hookDefinitionOwned, false);
});

test("install and update preserve the original User CLI selection and rollback baseline", async t => {
  for (const cliPath of [null, "user selected CLI"]) await t.test(cliPath === null ? "app default" : "user override", subtest => {
    const baseline = { CODEX_CLI_PATH: cliPath, CODEX_NODE_REPL_PATH: "original user REPL" }, f = fixture(subtest, { baseline });
    const first = installWebStopAdapter(f.options);
    assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: cliPath, CODEX_NODE_REPL_PATH: first.entryPath });
    assert.deepEqual(f.receipt().previousEnvironment, baseline);
    replaceOfficialRuntime(f);
    const next = installWebStopAdapter(f.options);
    assert.notEqual(next.entryPath, first.entryPath);
    assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: cliPath, CODEX_NODE_REPL_PATH: next.entryPath });
    assert.deepEqual(f.receipt().previousEnvironment, baseline);
    assert.deepEqual(webStopAdapterStatus(f.options).conflicts, []);
    assert.equal(rollbackWebStopAdapter(f.options).state, "removed");
    assert.deepEqual(f.environment.values, baseline);
  });
});

test("a valid new runtime replaces a legacy owned CLI pin after the old app files disappear", async t => {
  for (const cliPath of [null, "user selected CLI"]) await t.test(cliPath === null ? "app default" : "user override", subtest => {
    const baseline = { CODEX_CLI_PATH: cliPath, CODEX_NODE_REPL_PATH: null }, f = fixture(subtest, { baseline });
    const first = installWebStopAdapter(f.options); retainLegacyCliPin(f);
    assert.deepEqual(webStopAdapterStatus(f.options).conflicts, []);
    const previousPaths = replaceOfficialRuntime(f), inspected = [], inspect = f.dependencies.inspectSignatures;
    f.dependencies.inspectSignatures = paths => { inspected.push(...paths); return inspect(paths); };
    const next = installWebStopAdapter(f.options);
    assert.notEqual(next.entryPath, first.entryPath);
    assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: cliPath, CODEX_NODE_REPL_PATH: next.entryPath });
    assert.deepEqual(f.receipt().previousEnvironment, baseline);
    assert.ok(inspected.includes(f.manifest.officialCli.path));
    assert.equal(previousPaths.some(file => inspected.includes(file)), false);
    assert.equal(existsSync(first.entryPath), true);
    assert.deepEqual(webStopAdapterStatus(f.options).conflicts, []);
    assert.equal(rollbackWebStopAdapter(f.options).state, "removed");
    assert.deepEqual(f.environment.values, baseline);
  });
});

test("an invalid replacement runtime preserves the active legacy pin, wrapper, hook and receipt", async t => {
  for (const failure of ["bytes", "signature"]) await t.test(failure, subtest => {
    const f = fixture(subtest); installWebStopAdapter(f.options); retainLegacyCliPin(f);
    const before = { environment: clone(f.environment.values), receipt: readFileSync(f.receiptPath, "utf8"),
      hooks: readFileSync(f.hooksPath, "utf8"), calls: f.environment.calls.length };
    replaceOfficialRuntime(f);
    if (failure === "bytes") writeFileSync(f.manifest.node.path, "invalid replacement bytes");
    else f.dependencies.inspectSignatures = paths => paths.map(file => ({ path: file, ...signature, status: "NotSigned" }));
    assert.throws(() => installWebStopAdapter(f.options), failure === "bytes" ? /identity mismatch/u : /signature mismatch/u);
    assert.deepEqual(f.environment.values, before.environment); assert.equal(f.environment.calls.length, before.calls);
    assert.equal(readFileSync(f.receiptPath, "utf8"), before.receipt); assert.equal(readFileSync(f.hooksPath, "utf8"), before.hooks);
  });
});

test("a foreign CLI choice blocks legacy pin cleanup and remains preserved on rollback", t => {
  const f = fixture(t, { baseline: { CODEX_CLI_PATH: null, CODEX_NODE_REPL_PATH: null } });
  installWebStopAdapter(f.options); retainLegacyCliPin(f); replaceOfficialRuntime(f);
  f.environment.values.CODEX_CLI_PATH = "foreign CLI choice";
  const receipt = readFileSync(f.receiptPath, "utf8"), hooks = readFileSync(f.hooksPath, "utf8");
  assert.throws(() => installWebStopAdapter(f.options), /foreign value/u);
  assert.equal(readFileSync(f.receiptPath, "utf8"), receipt); assert.equal(readFileSync(f.hooksPath, "utf8"), hooks);
  const result = rollbackWebStopAdapter(f.options);
  assert.equal(result.state, "prepared"); assert.equal(result.conflicts.length, 1);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "foreign CLI choice", CODEX_NODE_REPL_PATH: null });
});

test("failed legacy pin cleanup restores its active selection and retains the first rollback baseline", t => {
  const baseline = { CODEX_CLI_PATH: null, CODEX_NODE_REPL_PATH: "original user REPL" }, f = fixture(t, { baseline });
  installWebStopAdapter(f.options); retainLegacyCliPin(f);
  const active = clone(f.environment.values), hooks = readFileSync(f.hooksPath, "utf8");
  replaceOfficialRuntime(f);
  const exchange = f.environment.compareExchangePair.bind(f.environment); let failed = false;
  f.environment.compareExchangePair = (expected, values) => {
    if (!failed) { failed = true; f.environment.values.CODEX_CLI_PATH = values.CODEX_CLI_PATH; throw new Error("fixture partial legacy cleanup"); }
    return exchange(expected, values);
  };
  assert.throws(() => installWebStopAdapter(f.options), /fixture partial legacy cleanup/u);
  assert.deepEqual(f.environment.values, active); assert.equal(readFileSync(f.hooksPath, "utf8"), hooks);
  assert.equal(f.receipt().state, "prepared"); assert.deepEqual(f.receipt().previousEnvironment, baseline);
  installWebStopAdapter(f.options);
  assert.equal(f.environment.values.CODEX_CLI_PATH, null);
  assert.deepEqual(f.receipt().previousEnvironment, baseline);
  assert.equal(rollbackWebStopAdapter(f.options).state, "removed"); assert.deepEqual(f.environment.values, baseline);
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

test("read-only adapter status proves local ownership while restart and native trust remain unknown", t => {
  const f = fixture(t), absent = webStopAdapterStatus(f.options);
  assert.equal(absent.state, "absent"); assert.equal(absent.installed, false); assert.equal(absent.hookDefinitionOwned, false);
  assert.equal(absent.ownershipVerified, false); assert.equal(absent.runtimeStatus, "not-checked");
  installWebStopAdapter(f.options);
  const receipt = readFileSync(f.receiptPath, "utf8"), hooks = readFileSync(f.hooksPath, "utf8"), effects = f.effects.length;
  const installed = webStopAdapterStatus(f.options);
  assert.equal(installed.installed, true); assert.equal(installed.hookDefinitionOwned, true); assert.deepEqual(installed.conflicts, []);
  assert.equal(installed.ownershipVerified, true); assert.equal(installed.runtimeStatus, "current"); assert.deepEqual(installed.runtimeIssues, []);
  assert.equal(readFileSync(f.receiptPath, "utf8"), receipt); assert.equal(readFileSync(f.hooksPath, "utf8"), hooks);
  assert.equal(f.effects.length, effects);
  f.environment.values.CODEX_CLI_PATH = "foreign selected CLI";
  const launchConflict = webStopAdapterStatus(f.options);
  assert.equal(launchConflict.installed, false); assert.equal(launchConflict.hookDefinitionOwned, true);
  assert.equal(launchConflict.ownershipVerified, false); assert.equal(launchConflict.runtimeStatus, "not-checked");
  f.environment.values.CODEX_CLI_PATH = installed.cliPath;
  const changed = f.hooks(); changed.hooks.Interrupt[0].hooks[0].trusted = true; writeFileSync(f.hooksPath, encode(changed));
  const conflict = webStopAdapterStatus(f.options);
  assert.equal(conflict.installed, false); assert.equal(conflict.hookDefinitionOwned, false); assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.ownershipVerified, false); assert.equal(conflict.runtimeStatus, "not-checked");
  writeFileSync(f.hooksPath, 'private-canary-invalid-hooks');
  const unreadable = webStopAdapterStatus(f.options);
  assert.equal(unreadable.hookDefinitionOwned, "unknown"); assert.equal(JSON.stringify(unreadable).includes("private-canary"), false);
  writeFileSync(f.hooksPath, hooks); rollbackWebStopAdapter(f.options);
  const removed = webStopAdapterStatus(f.options);
  assert.equal(removed.hookDefinitionOwned, false);
  for (const status of [absent, installed, launchConflict, conflict, unreadable, removed]) for (const name of ["appLoaded", "hookTrusted", "restartRequired", "trustRequired"]) assert.equal(status[name], "unknown");
  assert.equal(installed.environmentBroadcast, undefined);
});

test("obsolete external runtime paths retain verified adapter ownership without reporting conflicts", t => {
  const f = fixture(t); installWebStopAdapter(f.options);
  const receipt = readFileSync(f.receiptPath, "utf8"), hooks = readFileSync(f.hooksPath, "utf8"), environment = clone(f.environment.values), effects = f.effects.length;
  replaceOfficialRuntime(f);
  f.dependencies.inspectSignatures = () => { throw new Error("missing files must not reach signature inspection"); };
  const status = webStopAdapterStatus(f.options);
  assert.equal(status.installed, false); assert.equal(status.ownershipVerified, true); assert.equal(status.hookDefinitionOwned, true);
  assert.equal(status.runtimeStatus, "stale"); assert.equal(status.runtimeIssues.length, 5); assert.deepEqual(status.conflicts, []);
  assert.equal(readFileSync(f.receiptPath, "utf8"), receipt); assert.equal(readFileSync(f.hooksPath, "utf8"), hooks);
  assert.deepEqual(f.environment.values, environment); assert.equal(f.effects.length, effects);
});

test("runtime observation distinguishes invalid identities, unavailable probes and omitted inspection", async t => {
  for (const failure of ["bytes", "signature", "directory", "denied", "helper", "omitted"]) await t.test(failure, subtest => {
    const f = fixture(subtest); installWebStopAdapter(f.options);
    if (failure === "bytes") writeFileSync(f.manifest.node.path, "changed official runtime");
    if (failure === "signature") f.dependencies.inspectSignatures = paths => paths.map(file => ({ path: file, ...signature, status: "NotSigned" }));
    if (failure === "directory") { rmSync(f.manifest.runtimeModule); mkdirSync(f.manifest.runtimeModule); }
    if (failure === "denied") f.dependencies.probeRuntimeFile = () => ({ status: "access-denied", code: "EACCES" });
    if (failure === "helper") f.dependencies.inspectSignatures = () => { throw Object.assign(new Error("missing signature helper, not recorded runtime"), { code: "ENOENT" }); };
    if (failure === "omitted") f.dependencies.inspectSignatures = () => { throw new Error("signature inspection must be omitted"); };
    const status = webStopAdapterStatus({ ...f.options, ...(failure === "omitted" ? { inspectRuntime: false } : {}) });
    assert.equal(status.installed, false); assert.equal(status.ownershipVerified, true); assert.deepEqual(status.conflicts, []);
    assert.equal(status.runtimeStatus, ["bytes", "signature", "directory"].includes(failure) ? "invalid" : failure === "omitted" ? "not-checked" : "unavailable");
    assert.equal(status.runtimeIssues.length > 0, failure !== "omitted");
    assert.ok(status.runtimeIssues.length <= 5);
    assert.equal(JSON.stringify(status.runtimeIssues).includes("signature helper"), false, "helper exception details must not enter diagnostics");
  });
});

test("ownership conflicts skip external runtime inspection", async t => {
  for (const failure of ["managed", "hook", "environment"]) await t.test(failure, subtest => {
    const f = fixture(subtest), installed = installWebStopAdapter(f.options);
    if (failure === "managed") writeFileSync(path.join(installed.managedDirectory, "web-stop-adapter.mjs"), "changed managed bytes");
    if (failure === "hook") { const hooks = f.hooks(); hooks.hooks.Interrupt[0].hooks[0].trusted = true; writeFileSync(f.hooksPath, encode(hooks)); }
    if (failure === "environment") f.environment.values.CODEX_NODE_REPL_PATH = "foreign selected REPL";
    let probes = 0, inspections = 0;
    f.dependencies.probeRuntimeFile = () => { probes++; return { status: "missing" }; };
    f.dependencies.inspectSignatures = () => { inspections++; throw new Error("unexpected external inspection"); };
    const status = webStopAdapterStatus(f.options);
    assert.equal(status.ownershipVerified, false); assert.equal(status.installed, false); assert.equal(status.runtimeStatus, "not-checked");
    assert.equal(status.conflicts.length, 1); assert.deepEqual(status.runtimeIssues, []); assert.equal(probes, 0); assert.equal(inspections, 0);
    assert.throws(() => installWebStopAdapter(f.options));
  });
});

test("a verified installed snapshot upgrades when the candidate adds a local dependency and retains its original rollback", t => {
  const f = fixture(t), first = installWebStopAdapter(f.options);
  // Reconstruct the installed snapshot before the shared browser-state owner. Its private manifest owns
  // these exact bytes; current candidate source lists are deliberately different.
  const oldSource = f.sources["web-stop-adapter.mjs"];
  const oldBrowser = "export const browserFixture = true;\n", oldHook = "export const hookFixture = true;\n";
  writeFileSync(path.join(first.managedDirectory, "web-stop-adapter.mjs"), oldSource);
  writeFileSync(path.join(first.managedDirectory, "web-browser.mjs"), oldBrowser);
  writeFileSync(path.join(first.managedDirectory, "web-stop-hook.mjs"), oldHook);
  rmSync(path.join(first.managedDirectory, "web-browser-state.mjs"));
  const manifestPath = path.join(first.managedDirectory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.files["web-browser-state.mjs"];
  manifest.files["web-stop-adapter.mjs"] = hash(oldSource);
  manifest.files["web-browser.mjs"] = hash(oldBrowser);
  manifest.files["web-stop-hook.mjs"] = hash(oldHook);
  writeFileSync(manifestPath, encode(manifest));
  const receipt = f.receipt(); receipt.managedManifestSha256 = hash(readFileSync(manifestPath));
  writeFileSync(f.receiptPath, encode(receipt));
  assert.deepEqual(webStopAdapterStatus(f.options).conflicts, []);
  // Ensure candidate staging has a new identity rather than rewriting the
  // deliberately older immutable generation.
  writeFileSync(path.join(f.sourceDir, "web-stop-adapter.mjs"), f.sources["web-stop-adapter.mjs"] + "// next candidate\n");
  const next = installWebStopAdapter(f.options);
  assert.notEqual(next.managedDirectory, first.managedDirectory);
  assert.equal(readFileSync(path.join(first.managedDirectory, "web-stop-adapter.mjs"), "utf8"), oldSource);
  assert.equal(existsSync(path.join(next.managedDirectory, "web-browser-state.mjs")), true);
  assert.equal(rollbackWebStopAdapter(f.options).state, "removed");
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
  assert.equal(existsSync(f.hooksPath), false);
});

test("activation failure after a partial pair write restores both settings and keeps durable recovery baseline", t => {
  const f = fixture(t, { hooks: '{"user":true}' });
  const exchange = f.environment.compareExchangePair.bind(f.environment); let failed = false;
  f.environment.compareExchangePair = (expected, values) => {
    if (!failed) { failed = true; f.environment.values.CODEX_NODE_REPL_PATH = values.CODEX_NODE_REPL_PATH; throw new Error("fixture partial pair failure"); }
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

test("rollback restores legacy owned settings after external official runtime or SDK files change", t => {
  const f = fixture(t), installed = installWebStopAdapter(f.options);
  retainLegacyCliPin(f);
  writeFileSync(f.manifest.node.path, "updated official runtime fixture");
  writeFileSync(f.manifest.sdkPackageJson, encode({ name: "@modelcontextprotocol/sdk", version: "updated fixture" }));
  assert.equal(webStopAdapterStatus(f.options).installed, false);
  const result = rollbackWebStopAdapter(f.options);
  assert.equal(result.state, "removed"); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(f.environment.values, { CODEX_CLI_PATH: "original working CLI", CODEX_NODE_REPL_PATH: null });
  assert.equal(existsSync(installed.entryPath), true);
  assert.equal(readFileSync(f.manifest.node.path, "utf8"), "updated official runtime fixture");
});

test("removed status verifies retained owned artifacts without inspecting obsolete external runtimes", t => {
  const f = fixture(t), installed = installWebStopAdapter(f.options);
  assert.equal(rollbackWebStopAdapter(f.options).state, "removed");
  replaceOfficialRuntime(f);
  let inspections = 0;
  f.dependencies.inspectSignatures = () => { inspections++; throw new Error("obsolete runtime inspected"); };
  const removed = webStopAdapterStatus(f.options);
  assert.equal(removed.state, "removed"); assert.equal(removed.installed, false); assert.deepEqual(removed.conflicts, []);
  assert.equal(inspections, 0);
  writeFileSync(path.join(installed.managedDirectory, "web-stop-adapter.mjs"), "changed retained adapter");
  assert.match(webStopAdapterStatus(f.options).conflicts[0], /identity mismatch/u);
  assert.equal(inspections, 0);
});

test("receipt CLI ownership must match its original selection or the verified legacy pin", t => {
  const f = fixture(t); installWebStopAdapter(f.options);
  const receipt = f.receipt(); receipt.environment.CODEX_CLI_PATH = "unrelated receipt CLI";
  writeFileSync(f.receiptPath, encode(receipt)); f.environment.values.CODEX_CLI_PATH = receipt.environment.CODEX_CLI_PATH;
  const environment = clone(f.environment.values);
  assert.match(webStopAdapterStatus(f.options).conflicts[0], /configuration identity mismatch/u);
  assert.throws(() => installWebStopAdapter(f.options), /configuration identity mismatch/u);
  assert.throws(() => rollbackWebStopAdapter(f.options), /configuration identity mismatch/u);
  assert.deepEqual(f.environment.values, environment);
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
