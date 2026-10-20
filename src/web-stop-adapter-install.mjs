import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_HOME, STATE_DIR } from "./paths.mjs";
import { privateFileIsProtected, writePrivateFile } from "./file-security.mjs";
import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { ADAPTER_HOOK_STATUS, createAdapterHook, createAdapterConfig, validAdapterThreadIds } from "./web-stop-contract.mjs";

const OWNER = "codex-router-web-stop-adapter-v1";
const HOOK_ID = ADAPTER_HOOK_STATUS;
const ENV_NAMES = ["CODEX_CLI_PATH", "CODEX_NODE_REPL_PATH"];
const SOURCE_NAMES = Object.freeze(["web-stop-adapter.mjs", "web-browser.mjs", "web-stop-hook.mjs", "web-stop-contract.mjs"]);
const SHA = /^[a-f0-9]{64}$/iu;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n"]/u.test(value)
      || /^(?:\\\\|\/\/)/u.test(value)) throw new Error("Expected a safe absolute local path.");
  return path.resolve(value);
}

function regular(file, { optional = false, directory = false } = {}) {
  file = absolute(file);
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error("Symbolic-link installation paths are refused.");
      if (cursor === file && (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Unexpected installation path type.");
    } catch (error) { if (error.code !== "ENOENT" || cursor === file && !optional) throw error; }
    if (path.dirname(cursor) === cursor) return;
  }
}

function readText(file) {
  regular(file, { optional: true });
  try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function bytes(file, expected) {
  regular(file);
  const before = lstatSync(file), value = readFileSync(file), after = lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || expected !== undefined && hash(value) !== expected.toLowerCase()) throw new Error("Adapter file identity mismatch.");
  return value;
}

function invokeHelper(request) {
  if (process.platform !== "win32") throw new Error("Persistent Web Stop adapter installation requires Windows.");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  return JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(sourceRoot, "web-stop-adapter-env.ps1")], {
    env, input: JSON.stringify(request), encoding: "utf8", timeout: 20_000, maxBuffer: 128 * 1024,
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  }));
}

function compileEntry(source, output) {
  if (process.platform !== "win32") throw new Error("Adapter launcher compilation requires Windows.");
  const compiler = path.join(absolute(process.env.SystemRoot ?? "C:\\Windows"), "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  regular(compiler);
  execFileSync(compiler, ["/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/debug-", `/out:${output}`, source], {
    timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
}

function pair(value) {
  if (!object(value) || Object.keys(value).length !== 2 || ENV_NAMES.some(name => !Object.hasOwn(value, name)
      || !(value[name] === null || typeof value[name] === "string"))) throw new Error("Invalid User environment pair.");
  return Object.fromEntries(ENV_NAMES.map(name => [name, value[name]]));
}

function context(options = {}) {
  const dependencies = options.dependencies ?? {};
  const stateDir = absolute(options.stateDir ?? STATE_DIR), codexHome = absolute(options.codexHome ?? CODEX_HOME);
  const root = path.join(stateDir, "web-stop-adapter");
  return { stateDir, codexHome, root, receiptPath: path.join(root, "ownership.json"), hooksPath: path.join(codexHome, "hooks.json"),
    eventsPath: path.join(root, "events.jsonl"), sourceDir: absolute(dependencies.sourceDir ?? sourceRoot),
    environment: dependencies.environment ?? { readPair: () => invokeHelper({ action: "readPair" }).values,
      compareExchangePair: (expected, values) => invokeHelper({ action: "compareExchangePair", expected, values }) },
    inspectSignatures: dependencies.inspectSignatures ?? (paths => invokeHelper({ action: "signatures", paths })),
    compileEntry: dependencies.compileEntry ?? compileEntry,
    write: dependencies.writePrivate ?? writePrivateFile, isPrivate: dependencies.isPrivate ?? privateFileIsProtected };
}

function inspectManifest(ctx, file) {
  const text = bytes(absolute(file));
  if (text.length > 65536) throw new Error("Adapter manifest exceeds its bound.");
  const manifest = JSON.parse(text.toString("utf8"));
  const allowed = ["version", "node", "officialCli", "officialNodeRepl", "runtimeModule", "sdkPackageJson", "threadIds"];
  if (!object(manifest) || manifest.version !== 1 || Object.keys(manifest).some(key => !allowed.includes(key))) throw new Error("Invalid adapter manifest.");
  const identities = {};
  for (const [name, basename] of [["node", "node.exe"], ["officialCli", "codex.exe"], ["officialNodeRepl", "node_repl.exe"]]) {
    const identity = manifest[name];
    if (!object(identity) || Object.keys(identity).some(key => !["path", "sha256", "authenticode"].includes(key))
        || !SHA.test(identity.sha256 ?? "") || identity.authenticode?.status !== "Valid"
        || !/OpenAI OpCo, LLC/u.test(identity.authenticode.signerSubject ?? "")
        || typeof identity.authenticode.signerThumbprint !== "string" || !identity.authenticode.signerThumbprint
        || path.basename(identity.path ?? "") !== basename) throw new Error("Invalid signed adapter runtime identity.");
    identities[name] = { path: absolute(identity.path), sha256: identity.sha256.toLowerCase(), authenticode: {
      status: "Valid", signerSubject: identity.authenticode.signerSubject, signerThumbprint: identity.authenticode.signerThumbprint } };
    bytes(identities[name].path, identities[name].sha256);
  }
  verifySignatures(ctx, Object.values(identities));
  const runtimeModule = absolute(manifest.runtimeModule), sdkPackageJson = absolute(manifest.sdkPackageJson);
  const runtimeHash = hash(bytes(runtimeModule)), sdkBytes = bytes(sdkPackageJson), sdk = JSON.parse(sdkBytes.toString("utf8"));
  if (path.basename(sdkPackageJson) !== "package.json" || sdk.name !== "@modelcontextprotocol/sdk" || typeof sdk.version !== "string") throw new Error("Invalid MCP SDK package anchor.");
  const threadIds = manifest.threadIds ?? null;
  if (!validAdapterThreadIds(threadIds)) throw new Error("Invalid adapter thread scope.");
  return { ...identities, runtimeModule, runtimeHash, sdkPackageJson, sdkPackageHash: hash(sdkBytes), threadIds: threadIds === null ? null : [...threadIds].sort() };
}

function verifySignatures(ctx, identities) {
  const signatures = ctx.inspectSignatures(identities.map(value => value.path));
  if (!Array.isArray(signatures) || signatures.length !== identities.length) throw new Error("Incomplete official signature inspection.");
  for (const identity of identities) {
    const matches = signatures.filter(value => value.path === identity.path);
    if (matches.length !== 1 || matches[0].status !== "Valid"
        || matches[0].signerSubject !== identity.authenticode.signerSubject
        || matches[0].signerThumbprint !== identity.authenticode.signerThumbprint) throw new Error("Official runtime signature mismatch.");
    bytes(identity.path, identity.sha256);
  }
}

function parseHooks(text) {
  const document = text === null ? {} : JSON.parse(text);
  if (!object(document) || document.hooks !== undefined && !object(document.hooks)
      || document.hooks?.Interrupt !== undefined && !Array.isArray(document.hooks.Interrupt)) throw new Error("Invalid native hooks document.");
  for (const entry of document.hooks?.Interrupt ?? []) if (!object(entry) || !Array.isArray(entry.hooks)
      || entry.hooks.some(value => !object(value))) throw new Error("Invalid Interrupt hook entry.");
  return document;
}

function findHooks(document) {
  const matches = [];
  for (const [entryIndex, entry] of (document.hooks?.Interrupt ?? []).entries()) for (const [hookIndex, hook] of entry.hooks.entries()) {
    if (hook.statusMessage === HOOK_ID) matches.push({ entryIndex, hookIndex, hook });
  }
  return matches;
}

function writeCompared(ctx, file, expected, value) {
  if (readText(file) !== expected) throw new Error("Installation state changed; refusing to overwrite another writer.");
  if (value === expected) return;
  if (value === null) unlinkSync(file); else ctx.write(file, value);
  if (readText(file) !== value) throw new Error("Installation state readback failed.");
}

function loadReceipt(ctx) {
  const text = readText(ctx.receiptPath);
  if (text === null) return null;
  if (!ctx.isPrivate(ctx.receiptPath)) throw new Error("Adapter ownership receipt is not private.");
  const receipt = JSON.parse(text);
  if (!object(receipt) || receipt.owner !== OWNER || receipt.version !== 1 || !["prepared", "installed", "removed"].includes(receipt.state)
      || !SHA.test(receipt.generation ?? "") || receipt.managedDirectory !== path.join(ctx.root, receipt.generation)
      || receipt.entryPath !== path.join(receipt.managedDirectory, "entry.exe")
      || receipt.configPath !== path.join(receipt.managedDirectory, "config.json") || !SHA.test(receipt.managedManifestSha256 ?? "")
      || receipt.hooksPath !== ctx.hooksPath || !(receipt.previousHooksText === null || typeof receipt.previousHooksText === "string")
      || !same(receipt.hook, createAdapterHook()) || !object(receipt.created)
      || typeof receipt.created.hooks !== "boolean" || typeof receipt.created.interrupt !== "boolean") throw new Error("Invalid or foreign adapter ownership receipt.");
  receipt.environment = pair(receipt.environment); receipt.previousEnvironment = pair(receipt.previousEnvironment);
  receipt.priorEnvironment = pair(receipt.priorEnvironment);
  if (receipt.environment.CODEX_NODE_REPL_PATH !== receipt.entryPath) throw new Error("Invalid adapter environment ownership.");
  parseHooks(receipt.previousHooksText);
  return { ...receipt, text };
}

function verifyManaged(ctx, receipt, { external = true } = {}) {
  regular(receipt.managedDirectory, { directory: true });
  const manifestPath = path.join(receipt.managedDirectory, "manifest.json");
  const manifest = JSON.parse(bytes(manifestPath, receipt.managedManifestSha256).toString("utf8"));
  const names = object(manifest.files) ? Object.keys(manifest.files) : [];
  const sourceNames = names.filter(name => /^[a-z][a-z0-9-]*\.mjs$/u.test(name));
  if (!ctx.isPrivate(manifestPath) || manifest.owner !== OWNER || manifest.version !== 1 || manifest.generation !== receipt.generation
      || !object(manifest.files) || !sourceNames.includes("web-stop-adapter.mjs")
      || !same(names.sort(), [...sourceNames, "config.json", "entry.cs", "entry.exe"].sort())
      || !same(readdirSync(receipt.managedDirectory).sort(), [...Object.keys(manifest.files), "manifest.json"].sort())) throw new Error("Invalid managed adapter file set.");
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!SHA.test(expected) || !ctx.isPrivate(path.join(receipt.managedDirectory, name))) throw new Error("Managed adapter file is not private.");
    bytes(path.join(receipt.managedDirectory, name), expected);
  }
  // A retained generation owns its own import closure. New source dependencies
  // must not make a verified earlier generation impossible to upgrade or undo.
  const reachable = new Set(), pending = ["web-stop-adapter.mjs"];
  while (pending.length) {
    const name = pending.pop();
    if (reachable.has(name)) continue;
    if (!sourceNames.includes(name)) throw new Error("Managed adapter local dependency is missing.");
    reachable.add(name);
    const source = bytes(path.join(receipt.managedDirectory, name)).toString("utf8");
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu)) {
      if (!/^\.\/[a-z][a-z0-9-]*\.mjs$/u.test(match[1])) throw new Error("Invalid managed adapter local dependency.");
      pending.push(match[1].slice(2));
    }
  }
  if (reachable.size !== sourceNames.length) throw new Error("Unexpected managed adapter source file.");
  const plan = manifest.plan;
  const config = JSON.parse(bytes(receipt.configPath).toString("utf8"));
  if (!object(plan) || !same(config, createAdapterConfig({ server: plan.officialNodeRepl?.path, serverSha256: plan.officialNodeRepl?.sha256,
    stateDir: ctx.stateDir, runtimeModule: plan.runtimeModule, sdkPackageJson: plan.sdkPackageJson,
    threadIds: plan.threadIds, receiptPath: ctx.eventsPath }))
      || receipt.environment && receipt.environment.CODEX_CLI_PATH !== plan.officialCli?.path
      || receipt.threadIds !== undefined && !same(receipt.threadIds, plan.threadIds)) throw new Error("Managed adapter configuration identity mismatch.");
  if (external) {
    verifySignatures(ctx, [plan.node, plan.officialCli, plan.officialNodeRepl]);
    bytes(plan.runtimeModule, plan.runtimeHash); bytes(plan.sdkPackageJson, plan.sdkPackageHash);
  }
  return manifest;
}

function stage(ctx, plan) {
  const sources = Object.fromEntries(SOURCE_NAMES.map(name => [name, bytes(path.join(ctx.sourceDir, name))]));
  const template = bytes(path.join(ctx.sourceDir, "web-stop-adapter-entry.cs")).toString("utf8");
  const generation = hash(JSON.stringify({ plan, sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, hash(value)])), launcher: hash(template) }));
  const managedDirectory = path.join(ctx.root, generation), configPath = path.join(managedDirectory, "config.json"), entryPath = path.join(managedDirectory, "entry.exe");
  const config = createAdapterConfig({ server: plan.officialNodeRepl.path, serverSha256: plan.officialNodeRepl.sha256,
    stateDir: ctx.stateDir, runtimeModule: plan.runtimeModule, sdkPackageJson: plan.sdkPackageJson,
    threadIds: plan.threadIds, receiptPath: ctx.eventsPath });
  if (!existsSync(managedDirectory)) {
    const temporary = mkdtempSync(path.join(ctx.root, ".stage-"));
    for (const [name, value] of Object.entries(sources)) ctx.write(path.join(temporary, name), value);
    ctx.write(path.join(temporary, "config.json"), json(config));
    let rendered = template;
    for (const [token, value] of [["@@NODE@@", plan.node.path], ["@@ADAPTER@@", path.join(managedDirectory, "web-stop-adapter.mjs")], ["@@CONFIG@@", configPath]]) {
      if (rendered.split(token).length !== 2) throw new Error("Invalid adapter launcher template.");
      rendered = rendered.replace(token, value.replaceAll('"', '""'));
    }
    ctx.write(path.join(temporary, "entry.cs"), rendered);
    ctx.write(path.join(temporary, "entry.exe"), Buffer.alloc(0));
    ctx.compileEntry(path.join(temporary, "entry.cs"), path.join(temporary, "entry.exe"));
    const executable = bytes(path.join(temporary, "entry.exe"));
    if (!executable.length) throw new Error("Adapter launcher compilation produced no executable.");
    ctx.write(path.join(temporary, "entry.exe"), executable);
    const files = Object.fromEntries([...SOURCE_NAMES, "config.json", "entry.cs", "entry.exe"].map(name => [name, hash(bytes(path.join(temporary, name)))]));
    ctx.write(path.join(temporary, "manifest.json"), json({ owner: OWNER, version: 1, generation,
      identity: "custom unsigned Codex Router MCP adapter", plan, files }));
    renameSync(temporary, managedDirectory);
  }
  const managedManifestSha256 = hash(bytes(path.join(managedDirectory, "manifest.json")));
  const receipt = { generation, managedDirectory, configPath, entryPath, managedManifestSha256 };
  const manifest = verifyManaged(ctx, receipt);
  if (!same(manifest.plan, plan) || !same(JSON.parse(bytes(configPath).toString("utf8")), config)
      || SOURCE_NAMES.some(name => manifest.files[name] !== hash(sources[name]))) throw new Error("Managed adapter differs from the requested candidate.");
  return receipt;
}

function ensureInstallOwnership(receipt, environment, document) {
  const found = findHooks(document);
  if (!receipt || receipt.state === "removed") {
    if (found.length) throw new Error("A foreign Interrupt hook uses the adapter identity.");
    return null;
  }
  for (const name of ENV_NAMES) if (environment[name] !== receipt.environment[name]
      && !(receipt.state === "prepared" && [receipt.priorEnvironment[name], receipt.previousEnvironment[name]].includes(environment[name]))) throw new Error("User adapter environment changed; preserving foreign value.");
  if (found.length > 1 || found.length === 1 && !same(found[0].hook, receipt.hook)
      || found.length === 0 && receipt.state === "installed") throw new Error("The managed adapter hook was changed or removed.");
  return found[0] ?? null;
}

function restoreFailedInstall(ctx, transaction, cause) {
  const failures = [];
  try {
    const current = pair(ctx.environment.readPair()), restored = { ...current };
    for (const name of ENV_NAMES) {
      if (current[name] === transaction.desired[name]) restored[name] = transaction.beforeEnvironment[name];
      else if (current[name] !== transaction.beforeEnvironment[name]) failures.push("Foreign User environment preserved.");
    }
    if (!same(current, restored)) ctx.environment.compareExchangePair(current, restored);
  } catch { failures.push("User environment restoration failed."); }
  try {
    const current = readText(ctx.hooksPath);
    if (current === transaction.nextHooksText) writeCompared(ctx, ctx.hooksPath, current, transaction.beforeHooksText);
    else if (current !== transaction.beforeHooksText) failures.push("Foreign hooks changes preserved.");
  } catch { failures.push("Hook restoration failed."); }
  try {
    const current = readText(ctx.receiptPath);
    if (current === transaction.installedText) writeCompared(ctx, ctx.receiptPath, current, transaction.preparedText);
    else if (current !== transaction.preparedText) failures.push("Foreign ownership receipt preserved.");
  } catch { failures.push("Prepared ownership receipt restoration failed."); }
  if (failures.length) throw new Error(`${cause.message} Rollback incomplete: ${failures.join(" ")}`, { cause });
  throw cause;
}

export function installWebStopAdapter(options = {}) {
  const ctx = context(options), manifestPath = absolute(options.manifestPath);
  regular(ctx.root, { optional: true, directory: true }); mkdirSync(ctx.root, { recursive: true });
  return withAtomicStateLock(ctx.receiptPath, () => {
    const previous = loadReceipt(ctx), beforeEnvironment = pair(ctx.environment.readPair()), beforeHooksText = readText(ctx.hooksPath), document = parseHooks(beforeHooksText);
    const found = ensureInstallOwnership(previous, beforeEnvironment, document);
    if (previous && previous.state !== "removed") verifyManaged(ctx, previous);
    const plan = inspectManifest(ctx, manifestPath), candidate = stage(ctx, plan), hook = createAdapterHook();
    regular(ctx.eventsPath, { optional: true });
    if (!existsSync(ctx.eventsPath)) ctx.write(ctx.eventsPath, "");
    if (!ctx.isPrivate(ctx.eventsPath)) throw new Error("Adapter event receipt is not private.");
    const existing = previous && previous.state !== "removed";
    const created = existing ? previous.created : { hooks: document.hooks === undefined, interrupt: document.hooks?.Interrupt === undefined };
    if (!found) { document.hooks ??= {}; document.hooks.Interrupt ??= []; document.hooks.Interrupt.push({ hooks: [hook] }); }
    const nextHooksText = same(document, parseHooks(beforeHooksText)) ? beforeHooksText : json(document);
    const desired = { CODEX_CLI_PATH: plan.officialCli.path, CODEX_NODE_REPL_PATH: candidate.entryPath };
    const installed = { owner: OWNER, version: 1, state: "installed", ...candidate, hooksPath: ctx.hooksPath, hook, created,
      environment: desired, priorEnvironment: existing ? previous.priorEnvironment : beforeEnvironment,
      previousEnvironment: existing ? previous.previousEnvironment : beforeEnvironment,
      previousHooksText: existing ? previous.previousHooksText : beforeHooksText, threadIds: plan.threadIds };
    const installedText = json(installed);
    if (previous?.state === "installed" && same({ ...previous, text: undefined }, { ...installed, text: undefined })
        && same(beforeEnvironment, desired) && beforeHooksText === nextHooksText) return installResult(ctx, installed, null);
    const preparedText = json({ ...installed, state: "prepared", priorEnvironment: beforeEnvironment });
    // Durable private baseline precedes both the hook file and User overrides.
    writeCompared(ctx, ctx.receiptPath, previous?.text ?? null, preparedText);
    const transaction = { beforeEnvironment, desired, beforeHooksText, nextHooksText, preparedText, installedText };
    let result = { broadcast: null };
    try {
      writeCompared(ctx, ctx.hooksPath, beforeHooksText, nextHooksText);
      if (!same(beforeEnvironment, desired)) result = ctx.environment.compareExchangePair(beforeEnvironment, desired);
      if (!same(pair(ctx.environment.readPair()), desired)) throw new Error("Adapter User environment activation readback failed.");
      writeCompared(ctx, ctx.receiptPath, preparedText, installedText);
    } catch (error) { restoreFailedInstall(ctx, transaction, error); }
    return installResult(ctx, installed, result.broadcast);
  });
}

function adapterPaths(ctx, receipt) {
  return { state: receipt.state, cliPath: receipt.environment.CODEX_CLI_PATH, entryPath: receipt.entryPath,
    configPath: receipt.configPath, managedDirectory: receipt.managedDirectory, receiptPath: ctx.receiptPath,
    threadIds: receipt.threadIds };
}

function installResult(ctx, receipt, broadcast) {
  return { ...adapterPaths(ctx, receipt), installed: true, restartRequired: true, trustRequired: true, environmentBroadcast: broadcast };
}

export function webStopAdapterStatus(options = {}) {
  const ctx = context(options), receipt = loadReceipt(ctx);
  // A local receipt owns files and launch selections. It does not establish
  // which generation an existing app loaded or the app's native hook trust.
  const runtime = { appLoaded: "unknown", hookTrusted: "unknown", restartRequired: "unknown", trustRequired: "unknown" };
  if (!receipt) return { installed: false, state: "absent", receiptPath: ctx.receiptPath, hookDefinitionOwned: false, conflicts: [], ...runtime };
  const conflicts = [];
  const conflictMessage = error => error instanceof SyntaxError ? "Adapter JSON is invalid." : error.message;
  try { verifyManaged(ctx, receipt); } catch (error) { conflicts.push(conflictMessage(error)); }
  let hookDefinitionOwned = false;
  if (receipt.state !== "removed") {
    let document;
    try {
      document = parseHooks(readText(ctx.hooksPath));
      const found = findHooks(document);
      hookDefinitionOwned = found.length === 1 && same(found[0].hook, receipt.hook);
    } catch (error) { hookDefinitionOwned = "unknown"; conflicts.push(conflictMessage(error)); }
    if (document) try { ensureInstallOwnership(receipt, pair(ctx.environment.readPair()), document); } catch (error) { conflicts.push(error.message); }
  }
  return { ...adapterPaths(ctx, receipt), installed: receipt.state === "installed" && conflicts.length === 0,
    recoveryRequired: receipt.state === "prepared", hookDefinitionOwned, conflicts, ...runtime };
}

export function rollbackWebStopAdapter(options = {}) {
  const ctx = context(options);
  if (!existsSync(ctx.receiptPath)) return { installed: false, changed: false, state: "absent", restartRequired: false };
  return withAtomicStateLock(ctx.receiptPath, () => {
    const receipt = loadReceipt(ctx);
    if (receipt.state === "removed") return { installed: false, changed: false, state: "removed", restartRequired: false, retainedManagedFiles: true };
    // Restoring owned settings must remain possible after official runtimes
    // update; only our retained managed artifacts authorize this rollback.
    verifyManaged(ctx, receipt, { external: false });
    const conflicts = [], current = pair(ctx.environment.readPair()), restored = { ...current };
    for (const name of ENV_NAMES) {
      if (current[name] === receipt.environment[name] || receipt.state === "prepared" && current[name] === receipt.priorEnvironment[name]) restored[name] = receipt.previousEnvironment[name];
      else if (current[name] !== receipt.previousEnvironment[name]) conflicts.push(`${name} changed; foreign value preserved.`);
    }
    const beforeHooksText = readText(ctx.hooksPath), document = parseHooks(beforeHooksText), found = findHooks(document);
    if (found.length === 1 && same(found[0].hook, receipt.hook)) {
      const entry = document.hooks.Interrupt[found[0].entryIndex]; entry.hooks.splice(found[0].hookIndex, 1);
      if (!entry.hooks.length && Object.keys(entry).length === 1) document.hooks.Interrupt.splice(found[0].entryIndex, 1);
    } else if (found.length) conflicts.push("Adapter hook changed; foreign hook preserved.");
    if (receipt.created.interrupt && document.hooks?.Interrupt?.length === 0) delete document.hooks.Interrupt;
    if (receipt.created.hooks && document.hooks && Object.keys(document.hooks).length === 0) delete document.hooks;
    const nextHooksText = same(document, parseHooks(receipt.previousHooksText)) ? receipt.previousHooksText
      : same(document, parseHooks(beforeHooksText)) ? beforeHooksText : json(document);
    const { text: _text, ...next } = receipt;
    // Never adopt a foreign observed override as ownership during rollback.
    const preparedText = json({ ...next, state: "prepared" });
    writeCompared(ctx, ctx.receiptPath, receipt.text, preparedText);
    let result = { broadcast: null };
    writeCompared(ctx, ctx.hooksPath, beforeHooksText, nextHooksText);
    if (!same(current, restored)) result = ctx.environment.compareExchangePair(current, restored);
    if (!same(pair(ctx.environment.readPair()), restored)) throw new Error("Adapter User environment rollback readback failed.");
    const state = conflicts.length ? "prepared" : "removed";
    writeCompared(ctx, ctx.receiptPath, preparedText, json({ ...next, state }));
    return { installed: false, changed: !same(current, restored) || nextHooksText !== beforeHooksText, state,
      restartRequired: true, retainedManagedFiles: true, managedDirectory: receipt.managedDirectory, conflicts,
      environmentBroadcast: result.broadcast };
  });
}
