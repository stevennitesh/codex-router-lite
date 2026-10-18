import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installWebStop, removeWebStop, webStopStatus } from "../src/web-stop-install.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const signature = { status: "Valid", signerSubject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"', signerThumbprint: "fixture-signer" };
const marker = "Stopping owned ChatGPT Web generation";
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

function fixture(t, { hooks = undefined, previousEnvironment = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-web-stop-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "candidate");
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  mkdirSync(source); mkdirSync(stateDir); mkdirSync(codexHome);
  const hooksPath = path.join(codexHome, "hooks.json");
  if (hooks !== undefined) writeFileSync(hooksPath, typeof hooks === "string" ? hooks : encode(hooks));
  const companionNames = ["codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe"];
  const cli = Buffer.from("verified CLI fixture");
  writeFileSync(path.join(source, "codex.exe"), cli);
  const candidateCli = { path: path.join(source, "codex.exe"), sizeBytes: cli.length, sha256: hash(cli), authenticode: { status: "NotSigned" } };
  const companions = companionNames.map(name => {
    const bytes = Buffer.from(`signed official fixture ${name}`);
    const file = path.join(source, name);
    writeFileSync(file, bytes);
    const identity = { path: file, sizeBytes: bytes.length, sha256: hash(bytes), authenticode: signature };
    return { name, source: identity, staged: identity };
  });
  const acceptedBuild = { sha256: candidateCli.sha256, version: "fixture-1.2.3", sourceCommit: "a".repeat(40), signerThumbprint: signature.signerThumbprint,
    companions: Object.fromEntries(companions.map(item => [item.name, item.staged.sha256])) };
  const manifest = { schemaVersion: 1, upstreamReleaseVersion: acceptedBuild.version,
    upstreamSourceCommit: acceptedBuild.sourceCommit, candidateCli, companions };
  const candidateManifestPath = path.join(root, "candidate-build-manifest.json");
  writeFileSync(candidateManifestPath, encode(manifest));
  const runtimeModule = path.join(root, "browser-runtime.mjs");
  writeFileSync(runtimeModule, "export const fixture = true;\n");
  const environment = { value: previousEnvironment, calls: [],
    read() { return this.value; },
    compareExchange(expected, value) {
      assert.equal(this.value, expected, "compare/exchange protects User environment ownership");
      this.calls.push({ expected, value }); this.value = value;
      return { value, broadcast: true };
    } };
  const dependencies = { acceptedBuild, environment, isPrivate: () => true,
    writePrivate(file, contents) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); },
    readVersion: () => `codex-cli ${acceptedBuild.version}`,
    inspectSignatures: paths => paths.map(file => ({ path: file, ...(path.basename(file) === "codex.exe" ? { status: "NotSigned" } : signature) })),
  };
  const options = { stateDir, codexHome, candidateManifestPath, runtimeModule, dependencies };
  return { root, source, stateDir, codexHome, hooksPath, runtimeModule, options, environment, dependencies, manifest,
    saveManifest: () => writeFileSync(candidateManifestPath, encode(manifest)),
    readHooks: () => JSON.parse(readFileSync(hooksPath, "utf8")),
    receipt: () => JSON.parse(readFileSync(path.join(stateDir, "native-web-stop", "ownership.json"), "utf8")),
  };
}

test("persistent install stages the exact build, preserves unrelated hooks, and restores original User state", t => {
  const original = { description: "user hooks", ownSetting: 19, hooks: {
    PreToolUse: [{ matcher: "custom", hooks: [{ type: "command", command: "user-pre" }] }],
    Interrupt: [{ matcher: "user-filter", timeout: 12, hooks: [{ type: "command", command: "user-interrupt" }] }],
  } };
  const originalText = JSON.stringify(original);
  const f = fixture(t, { hooks: originalText, previousEnvironment: "C:\\user\\previous.exe" });
  const processValue = process.env.CODEX_CLI_PATH;
  const result = installWebStop(f.options);
  assert.equal(result.installed, true);
  assert.equal(result.restartRequired, true); assert.equal(result.trustRequired, true);
  assert.equal(result.environmentBroadcast, true);
  assert.equal(f.environment.value, result.cliPath);
  assert.equal(process.env.CODEX_CLI_PATH, processValue, "process override does not become the saved User value");
  assert.equal(f.receipt().previousUserCliPath, "C:\\user\\previous.exe");
  assert.equal(f.receipt().previousHooksText, originalText);
  const hooks = f.readHooks();
  assert.deepEqual(hooks.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(hooks.hooks.Interrupt[0], original.hooks.Interrupt[0]);
  assert.equal(hooks.hooks.Interrupt.length, 2);
  assert.equal(hooks.hooks.Interrupt[1].hooks[0].statusMessage, marker);
  for (const [name, identity] of Object.entries({ "codex.exe": f.manifest.candidateCli,
    ...Object.fromEntries(f.manifest.companions.map(item => [item.name, item.staged])) })) {
    assert.equal(hash(readFileSync(path.join(result.managedDirectory, name))), identity.sha256);
  }
  assert.ok(result.cliPath.startsWith(path.join(f.stateDir, "native-web-stop")));
  assert.deepEqual(webStopStatus(f.options).conflicts, []);
  const removed = removeWebStop(f.options);
  assert.equal(removed.changed, true); assert.equal(removed.retainedManagedFiles, true);
  assert.equal(f.environment.value, "C:\\user\\previous.exe");
  assert.equal(readFileSync(f.hooksPath, "utf8"), originalText);
  assert.equal(webStopStatus(f.options).state, "removed");
  assert.equal(removeWebStop(f.options).changed, false);
});

test("idempotent install and hook replacement retain the original previous environment", t => {
  const f = fixture(t);
  const first = installWebStop(f.options);
  const firstReceipt = readFileSync(first.receiptPath, "utf8");
  installWebStop(f.options);
  assert.equal(f.environment.calls.length, 1);
  assert.equal(readFileSync(first.receiptPath, "utf8"), firstReceipt);
  const replacementRuntime = path.join(f.root, "new-runtime.mjs");
  writeFileSync(replacementRuntime, "export const next = true;");
  installWebStop({ ...f.options, runtimeModule: replacementRuntime });
  assert.equal(f.receipt().previousUserCliPath, null);
  assert.equal(f.receipt().previousHooksText, null);
  assert.equal(f.readHooks().hooks.Interrupt.length, 1);
  assert.ok(f.readHooks().hooks.Interrupt[0].hooks[0].input.code.includes("new-runtime.mjs"));
  removeWebStop(f.options);
  assert.equal(f.environment.value, null);
  assert.equal(existsSync(f.hooksPath), false);
  f.environment.value = "C:\\new\\user-choice.exe";
  installWebStop(f.options);
  assert.equal(f.receipt().previousUserCliPath, "C:\\new\\user-choice.exe", "a new install after removal owns a new baseline");
});

test("removal preserves unrelated edits and matcher fields added beside the owned handler", t => {
  const f = fixture(t);
  installWebStop(f.options);
  const edited = f.readHooks();
  edited.description = "user added description";
  edited.hooks.Interrupt[0].matcher = "user matcher";
  edited.hooks.Interrupt[0].timeout = 7;
  edited.hooks.Interrupt[0].hooks.push({ type: "command", command: "user-added" });
  edited.hooks.Stop = [{ hooks: [{ type: "command", command: "user-stop" }] }];
  writeFileSync(f.hooksPath, encode(edited));
  removeWebStop(f.options);
  assert.deepEqual(f.readHooks(), { description: edited.description, hooks: {
    Interrupt: [{ matcher: "user matcher", timeout: 7, hooks: [{ type: "command", command: "user-added" }] }],
    Stop: edited.hooks.Stop,
  } });
});

test("an existing hook using the managed identity without a receipt is foreign", t => {
  const original = { hooks: { Interrupt: [{ matcher: "x", hooks: [{ type: "command", command: "foreign", statusMessage: marker }] }] } };
  const f = fixture(t, { hooks: original });
  assert.throws(() => installWebStop(f.options), /foreign Interrupt hook/u);
  assert.equal(f.environment.calls.length, 0);
  assert.deepEqual(f.readHooks(), original);
  assert.equal(existsSync(path.join(f.stateDir, "native-web-stop", f.dependencies.acceptedBuild.sha256.toLowerCase())), false);
});

test("changed User environment or owned handler blocks reinstall/removal without clobbering", t => {
  const f = fixture(t);
  const installed = installWebStop(f.options);
  const hooksBefore = readFileSync(f.hooksPath, "utf8");
  f.environment.value = "C:\\foreign\\cli.exe";
  assert.throws(() => removeWebStop(f.options), /foreign value/u);
  assert.throws(() => installWebStop(f.options), /foreign value/u);
  assert.equal(f.environment.value, "C:\\foreign\\cli.exe");
  assert.equal(readFileSync(f.hooksPath, "utf8"), hooksBefore);
  f.environment.value = installed.cliPath;
  const changed = f.readHooks();
  changed.hooks.Interrupt[0].hooks[0].input.code = "foreign code";
  writeFileSync(f.hooksPath, encode(changed));
  assert.equal(webStopStatus(f.options).installed, false);
  assert.throws(() => removeWebStop(f.options), /changed or removed/u);
  assert.throws(() => installWebStop(f.options), /changed or removed/u);
  assert.deepEqual(f.readHooks(), changed);
});

test("foreign modifications to managed files and unprotected receipts fail closed", t => {
  const f = fixture(t);
  const installed = installWebStop(f.options);
  writeFileSync(path.join(installed.managedDirectory, "codex-command-runner.exe"), "foreign");
  assert.equal(webStopStatus(f.options).installed, false);
  assert.throws(() => removeWebStop(f.options), /identity mismatch/u);
  assert.throws(() => installWebStop(f.options), /identity mismatch/u);
  assert.equal(f.environment.value, installed.cliPath);
  f.dependencies.isPrivate = () => false;
  assert.throws(() => webStopStatus(f.options), /receipt is not private/u);
  assert.throws(() => removeWebStop(f.options), /receipt is not private/u);
});

test("foreign files in the managed executable directory are preserved and block activation/removal", t => {
  const f = fixture(t);
  const installed = installWebStop(f.options);
  const foreign = path.join(installed.managedDirectory, "foreign.dll");
  writeFileSync(foreign, "foreign library");
  assert.throws(() => installWebStop(f.options), /Foreign files/u);
  assert.throws(() => removeWebStop(f.options), /Foreign files/u);
  assert.equal(readFileSync(foreign, "utf8"), "foreign library");
  assert.equal(f.environment.value, installed.cliPath);
});

test("activation failure restores original hooks and User environment", t => {
  const originalText = '{"custom":true,"hooks":{"Stop":[]}}';
  const f = fixture(t, { hooks: originalText, previousEnvironment: "old-user-value" });
  const compareExchange = f.environment.compareExchange.bind(f.environment);
  let failed = false;
  f.environment.compareExchange = (expected, value) => {
    const result = compareExchange(expected, value);
    if (!failed) { failed = true; throw new Error("synthetic broadcast failure after registry write"); }
    return result;
  };
  assert.throws(() => installWebStop(f.options), /synthetic broadcast failure/u);
  assert.equal(f.environment.value, "old-user-value");
  assert.equal(readFileSync(f.hooksPath, "utf8"), originalText);
  assert.equal(f.receipt().state, "prepared");
  assert.equal(f.receipt().previousUserCliPath, "old-user-value");
  installWebStop(f.options);
  assert.equal(f.receipt().previousUserCliPath, "old-user-value");
});

test("a failing removal receipt publication rolls back environment/hooks and retains the durable baseline", t => {
  const f = fixture(t, { previousEnvironment: "original-user-cli" });
  const installed = installWebStop(f.options);
  const previousHooks = readFileSync(f.hooksPath, "utf8");
  const previousReceipt = readFileSync(installed.receiptPath, "utf8");
  const write = f.dependencies.writePrivate;
  f.dependencies.writePrivate = (file, contents) => {
    if (file === installed.receiptPath && JSON.parse(contents).state === "removed") throw new Error("receipt write failure");
    write(file, contents);
  };
  assert.throws(() => removeWebStop(f.options), /receipt write failure/u);
  assert.equal(f.environment.value, installed.cliPath);
  assert.equal(readFileSync(f.hooksPath, "utf8"), previousHooks);
  assert.equal(f.receipt().state, "prepared");
  assert.equal(f.receipt().previousUserCliPath, JSON.parse(previousReceipt).previousUserCliPath);
  assert.equal(f.receipt().previousHooksText, JSON.parse(previousReceipt).previousHooksText);
  f.dependencies.writePrivate = write;
  removeWebStop(f.options);
  assert.equal(f.environment.value, "original-user-cli");
});

test("the protected original baseline is published before either global activation effect", t => {
  const f = fixture(t, { hooks: '{"user":true}', previousEnvironment: "original-user-cli" });
  const write = f.dependencies.writePrivate;
  f.dependencies.writePrivate = (file, contents) => {
    if (file === f.hooksPath) {
      assert.equal(f.receipt().state, "prepared");
      assert.equal(f.receipt().previousUserCliPath, "original-user-cli");
      assert.equal(f.receipt().previousHooksText, '{"user":true}');
    }
    write(file, contents);
  };
  const compareExchange = f.environment.compareExchange.bind(f.environment);
  f.environment.compareExchange = (expected, value) => {
    assert.equal(f.receipt().state, "prepared");
    return compareExchange(expected, value);
  };
  installWebStop(f.options);
  assert.equal(f.receipt().state, "installed");
});

test("failure to prepare the baseline cannot activate global hooks or User environment", t => {
  const f = fixture(t, { hooks: '{"user":true}', previousEnvironment: "original-user-cli" });
  const write = f.dependencies.writePrivate;
  f.dependencies.writePrivate = (file, contents) => {
    if (path.basename(file) === "ownership.json") throw new Error("baseline publication failed");
    write(file, contents);
  };
  assert.throws(() => installWebStop(f.options), /baseline publication failed/u);
  assert.equal(readFileSync(f.hooksPath, "utf8"), '{"user":true}');
  assert.equal(f.environment.value, "original-user-cli");
  assert.equal(f.environment.calls.length, 0);
});

test("retry or direct removal after incomplete rollback restores the original User value", async t => {
  for (const action of ["retry-install", "direct-remove"]) await t.test(action, child => {
    const original = action === "direct-remove" ? null : "original-user-cli";
    const f = fixture(child, { hooks: '{"user":true}', previousEnvironment: original });
    const write = f.dependencies.writePrivate;
    const compareExchange = f.environment.compareExchange.bind(f.environment);
    f.dependencies.writePrivate = (file, contents) => {
      if (path.basename(file) === "ownership.json" && JSON.parse(contents).state === "installed") throw new Error("installed receipt publication failed");
      write(file, contents);
    };
    f.environment.compareExchange = (expected, value) => {
      if (value === original) throw new Error("transient environment rollback failure");
      return compareExchange(expected, value);
    };
    assert.throws(() => installWebStop(f.options), /Rollback incomplete: transient environment rollback failure/u);
    assert.notEqual(f.environment.value, original, "the managed User override remains after the injected rollback failure");
    assert.equal(f.receipt().state, "prepared");
    assert.equal(f.receipt().previousUserCliPath, original);
    assert.equal(f.receipt().previousHooksText, '{"user":true}');
    assert.equal(webStopStatus(f.options).recoveryRequired, true);
    f.dependencies.writePrivate = write;
    f.environment.compareExchange = compareExchange;
    if (action === "retry-install") {
      installWebStop(f.options);
      assert.equal(f.receipt().previousUserCliPath, original, "retry never captures the managed path as the original baseline");
    }
    removeWebStop(f.options);
    assert.equal(f.environment.value, original);
    assert.equal(readFileSync(f.hooksPath, "utf8"), '{"user":true}');
    assert.equal(f.receipt().state, "removed");
  });
});

test("a prepared hook replacement retains ownership of its prior installed definition", t => {
  const f = fixture(t, { previousEnvironment: "original-user-cli" });
  installWebStop(f.options);
  const previousHook = f.readHooks().hooks.Interrupt[0].hooks[0];
  const replacementRuntime = path.join(f.root, "replacement-runtime.mjs");
  writeFileSync(replacementRuntime, "export const replacement = true;");
  const write = f.dependencies.writePrivate;
  f.dependencies.writePrivate = (file, contents) => {
    if (path.basename(file) === "ownership.json" && JSON.parse(contents).state === "installed") throw new Error("replacement publication failed");
    write(file, contents);
  };
  assert.throws(() => installWebStop({ ...f.options, runtimeModule: replacementRuntime }), /replacement publication failed/u);
  assert.deepEqual(f.readHooks().hooks.Interrupt[0].hooks[0], previousHook);
  assert.deepEqual(f.receipt().previousManagedHook, previousHook);
  f.dependencies.writePrivate = write;
  removeWebStop(f.options);
  assert.equal(f.environment.value, "original-user-cli");
  assert.equal(existsSync(f.hooksPath), false);
});

test("rollback reports and preserves a foreign environment change after a partial failure", t => {
  const f = fixture(t, { hooks: '{"user":1}', previousEnvironment: "original" });
  f.environment.compareExchange = () => { f.environment.value = "foreign-after-partial-failure"; throw new Error("activation failed"); };
  assert.throws(() => installWebStop(f.options), /Rollback incomplete:.*preserved foreign value/u);
  assert.equal(f.environment.value, "foreign-after-partial-failure");
  assert.equal(readFileSync(f.hooksPath, "utf8"), '{"user":1}');
});

test("manifest, bytes, versions, signatures, and ambiguous companion sets are verified before effects", async t => {
  const cases = [
    ["unaccepted candidate", f => { f.manifest.candidateCli.sha256 = "0".repeat(64); f.saveManifest(); }, /accepted Web Stop build/u],
    ["unaccepted source", f => { f.manifest.upstreamSourceCommit = "b".repeat(40); f.saveManifest(); }, /accepted Web Stop build/u],
    ["modified bytes", f => writeFileSync(f.manifest.candidateCli.path, "modified"), /identity mismatch/u],
    ["wrong version", f => { f.dependencies.readVersion = () => "codex-cli other"; }, /version does not match/u],
    ["missing companion", f => { f.manifest.companions.pop(); f.saveManifest(); }, /accepted Web Stop build/u],
    ["duplicate companion", f => { f.manifest.companions[3] = f.manifest.companions[0]; f.saveManifest(); }, /companion set/u],
    ["untrusted staged receipt", f => { f.manifest.companions[0].staged.authenticode = { ...signature, status: "NotSigned" }; f.saveManifest(); }, /companion manifest identity/u],
    ["bad actual signature", f => { f.dependencies.inspectSignatures = paths => paths.map(file => ({ path: file, status: "NotSigned" })); }, /companion signature/u],
    ["mismatched signer", f => { f.dependencies.inspectSignatures = paths => paths.map(file => ({ path: file, ...signature, status: path.basename(file) === "codex.exe" ? "NotSigned" : "Valid", signerThumbprint: "foreign" })); }, /companion signature/u],
    ["non-file candidate", f => { rmSync(f.manifest.candidateCli.path); mkdirSync(f.manifest.candidateCli.path); }, /Not a regular file/u],
  ];
  for (const [name, alter, expected] of cases) await t.test(name, child => {
    const f = fixture(child, { hooks: '{"preserve":true}' });
    alter(f);
    assert.throws(() => installWebStop(f.options), expected);
    assert.equal(f.environment.calls.length, 0);
    assert.equal(readFileSync(f.hooksPath, "utf8"), '{"preserve":true}');
  });
});

test("junction ancestors cannot redirect staging or hook writes", t => {
  const f = fixture(t);
  const foreign = path.join(f.root, "foreign-state");
  mkdirSync(foreign);
  symlinkSync(foreign, path.join(f.stateDir, "native-web-stop"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => installWebStop(f.options), /symbolic-link path/u);
  assert.equal(f.environment.calls.length, 0);
  assert.equal(existsSync(path.join(foreign, "ownership.json")), false);
});

test("native hook documents with malformed Interrupt entries remain untouched", t => {
  const text = '{"hooks":{"Interrupt":[{"hooks":"malformed"}]}}';
  const f = fixture(t, { hooks: text });
  assert.throws(() => installWebStop(f.options), /Invalid Interrupt hook entry/u);
  assert.equal(readFileSync(f.hooksPath, "utf8"), text);
  assert.equal(f.environment.calls.length, 0);
});
