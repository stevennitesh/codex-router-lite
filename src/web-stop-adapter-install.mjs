import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_HOME, STATE_DIR } from "./paths.mjs";
import { privateFileIsProtected, writePrivateFile } from "./file-security.mjs";
import { probeRegularFile } from "./file-probe.mjs";
import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { withDirectoryLock } from "./directory-lock.mjs";
import { ADAPTER_HOOK_STATUS, createAdapterHook, createAdapterConfig, validAdapterThreadIds } from "./web-stop-contract.mjs";
import { cleanupWebStopAdapterBuilds, recordWebStopAdapterBuild } from "./web-stop-adapter-cleanup.mjs";
import { readWebProcessCensus } from "./web-maintenance-proof.mjs";

const OWNER = "codex-router-web-stop-adapter-v1";
const HOOK_ID = ADAPTER_HOOK_STATUS;
const ENV_NAMES = ["CODEX_CLI_PATH", "CODEX_NODE_REPL_PATH"];
const SOURCE_NAMES = Object.freeze(["web-stop-adapter.mjs", "web-process-snapshot.mjs", "web-browser.mjs", "web-browser-state.mjs", "web-stop-hook.mjs", "web-stop-contract.mjs"]);
const SHA = /^[a-f0-9]{64}$/iu;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// The only supported hook-definition transition is the previously shipped
// ten-second definition to the host-bounded contract. Never adopt other edits.
const PREVIOUS_ADAPTER_HOOK = { type: "mcp_tool", server: "node_repl", tool: "router_web_interrupt", input: {
  hook_event_name: "${hook_event_name}", session_id: "${session_id}", turn_id: "${turn_id}" },
  timeout: 10, statusMessage: HOOK_ID };
const supportedHook = hook => same(hook, createAdapterHook()) || same(hook, PREVIOUS_ADAPTER_HOOK);
// Either shipped definition may be the prior endpoint of an interrupted
// migration. Reading that recovery record never adopts another hook shape.
const receiptOwnsHook = (receipt, hook) => same(hook, receipt.hook)
  || receipt.state === "prepared" && receipt.priorHook !== undefined && same(hook, receipt.priorHook);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const integrityError = message => Object.assign(new Error(message), { code: "ERR_ADAPTER_INTEGRITY" });

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
      if (stat.isSymbolicLink()) throw integrityError("Symbolic-link installation paths are refused.");
      if (cursor === file && (directory ? !stat.isDirectory() : !stat.isFile())) throw integrityError("Unexpected installation path type.");
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
      || expected !== undefined && hash(value) !== expected.toLowerCase()) throw integrityError("Adapter file identity mismatch.");
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
  execFileSync(compiler, ["/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/debug-", "/reference:System.Management.dll", `/out:${output}`, source], {
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
    probeRuntimeFile: dependencies.probeRuntimeFile ?? probeRegularFile,
    compileEntry: dependencies.compileEntry ?? compileEntry,
    write: dependencies.writePrivate ?? writePrivateFile, isPrivate: dependencies.isPrivate ?? privateFileIsProtected,
    cleanupBuilds: dependencies.cleanupBuilds ?? cleanupWebStopAdapterBuilds,
    readProcessCensus: dependencies.readProcessCensus ?? readWebProcessCensus,
    cleanupOperationId: options.cleanupOperationId };
}

function inspectManifest(ctx, input) {
  let manifest = input;
  if (typeof input === "string") {
    const text = bytes(absolute(input));
    if (text.length > 65536) throw new Error("Adapter manifest exceeds its bound.");
    manifest = JSON.parse(text.toString("utf8"));
  }
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
  return { ...identities, runtimeModule, runtimeHash, sdkPackageJson, sdkPackageHash: hash(sdkBytes), threadIds: threadIds === null ? null : [...threadIds].sort(),
    cuaBootstrap: inspectCuaBootstrap(identities.node.path, runtimeModule) };
}

function inspectCuaBootstrap(node, runtimeModule) {
  // Only the selected official Node cohort supplies this optional entry. No
  // cache search, timestamp selection, app-owned plugin edit or extra override.
  const entryPath = path.join(path.dirname(node), "node_modules", "@oai", "cua-repl", "bin", "cua-repl.mjs");
  let entry;
  try { entry = { path: entryPath, sha256: hash(bytes(entryPath)) }; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const browserVersion = path.dirname(path.dirname(runtimeModule)), browserPlugin = path.dirname(browserVersion);
  const guardPath = path.join(path.dirname(browserPlugin), "unified-computer-use", path.basename(browserVersion), "require-browser-access.mjs");
  let guard = null;
  // A differently arranged browser runtime remains usable through the bridge.
  if (path.basename(browserPlugin) === "browser" && path.basename(path.dirname(runtimeModule)) === "scripts") {
    try { guard = { path: guardPath, sha256: hash(bytes(guardPath)) }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { entry, guard };
}

function verifySignatures(ctx, identities) {
  const signatures = ctx.inspectSignatures(identities.map(value => value.path));
  if (!Array.isArray(signatures) || signatures.length !== identities.length) throw new Error("Incomplete official signature inspection.");
  for (const identity of identities) {
    const matches = signatures.filter(value => value.path === identity.path);
    if (matches.length !== 1) throw new Error("Incomplete official signature inspection.");
    if (matches[0].status !== "Valid"
        || matches[0].signerSubject !== identity.authenticode.signerSubject
        || matches[0].signerThumbprint !== identity.authenticode.signerThumbprint) throw integrityError("Official runtime signature mismatch.");
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
      || !SHA.test(receipt.generation ?? "") || !managedPath(ctx, receipt)
      || receipt.entryPath !== path.join(receipt.managedDirectory, "entry.exe")
      || receipt.configPath !== path.join(receipt.managedDirectory, "config.json") || !SHA.test(receipt.managedManifestSha256 ?? "")
      || receipt.hooksPath !== ctx.hooksPath || !(receipt.previousHooksText === null || typeof receipt.previousHooksText === "string")
      || !supportedHook(receipt.hook)
      || receipt.priorHook !== undefined && !(receipt.state === "prepared" && supportedHook(receipt.priorHook)
        && !same(receipt.hook, receipt.priorHook))
      || !object(receipt.created)
      || typeof receipt.created.hooks !== "boolean" || typeof receipt.created.interrupt !== "boolean") throw new Error("Invalid or foreign adapter ownership receipt.");
  receipt.environment = pair(receipt.environment); receipt.previousEnvironment = pair(receipt.previousEnvironment);
  receipt.priorEnvironment = pair(receipt.priorEnvironment);
  if (receipt.environment.CODEX_NODE_REPL_PATH !== receipt.entryPath) throw new Error("Invalid adapter environment ownership.");
  parseHooks(receipt.previousHooksText);
  return { ...receipt, text };
}

function managedPath(ctx, receipt) {
  if (receipt.managedDirectory === path.join(ctx.root, receipt.generation)) return true;
  return typeof receipt.managedDirectory === "string" && path.dirname(receipt.managedDirectory) === ctx.root
    && path.basename(receipt.managedDirectory).startsWith(`${receipt.generation}-`)
    && /^[a-f0-9]{64}-[a-z0-9]{6}$/iu.test(path.basename(receipt.managedDirectory));
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
      || receipt.environment && ![receipt.previousEnvironment.CODEX_CLI_PATH, plan.officialCli?.path].includes(receipt.environment.CODEX_CLI_PATH)
      || receipt.threadIds !== undefined && !same(receipt.threadIds, plan.threadIds)) throw new Error("Managed adapter configuration identity mismatch.");
  if (external) {
    verifySignatures(ctx, [plan.node, plan.officialCli, plan.officialNodeRepl]);
    bytes(plan.runtimeModule, plan.runtimeHash); bytes(plan.sdkPackageJson, plan.sdkPackageHash);
    for (const identity of [plan.cuaBootstrap?.entry, plan.cuaBootstrap?.guard].filter(Boolean)) bytes(identity.path, identity.sha256);
  }
  return manifest;
}

function observeExternalRuntime(ctx, plan) {
  const issues = [], states = [], signed = [];
  const report = (label, state, detail) => { states.push(state); issues.push(`${label}: ${detail}.`); };
  const fileState = observed => observed.status === "invalid" || observed.code === "ENOTDIR" ? "invalid" : observed.status === "missing" ? "stale" : "unavailable";
  const files = [
    ...["node", "officialCli", "officialNodeRepl"].map(name => ({ label: name, ...plan[name], signed: true })),
    { label: "Browser runtime module", path: plan.runtimeModule, sha256: plan.runtimeHash },
    { label: "MCP SDK package", path: plan.sdkPackageJson, sha256: plan.sdkPackageHash },
    ...[plan.cuaBootstrap?.entry, plan.cuaBootstrap?.guard].filter(Boolean).map(identity => ({ label: "CUA bootstrap", ...identity })),
  ];
  for (const file of files) {
    const observed = ctx.probeRuntimeFile(file.path);
    if (observed.status !== "present") {
      const state = fileState(observed);
      report(file.label, state, state === "stale" ? "recorded file is missing" : state === "invalid" ? "recorded path is not a regular file" : "recorded file could not be inspected");
      continue;
    }
    try {
      bytes(file.path, file.sha256);
      if (file.signed) signed.push(file);
    } catch (error) {
      // An ENOENT from a signature helper can describe its own executable. Only
      // probing the exact recorded runtime path establishes a stale cohort.
      const state = error.code === "ERR_ADAPTER_INTEGRITY" ? "invalid" : fileState(ctx.probeRuntimeFile(file.path));
      report(file.label, state, state === "invalid" ? "recorded file identity is invalid" : state === "stale" ? "recorded file is missing" : "recorded file could not be verified");
    }
  }
  if (signed.length) try { verifySignatures(ctx, signed); }
  catch (error) {
    if (error.code === "ERR_ADAPTER_INTEGRITY") report("Official runtime signatures", "invalid", "recorded signature or file identity is invalid");
    else {
      const missing = signed.filter(file => fileState(ctx.probeRuntimeFile(file.path)) === "stale");
      if (missing.length) for (const file of missing) report(file.label, "stale", "recorded file is missing");
      else report("Official runtime signatures", "unavailable", "verification could not be completed");
    }
  }
  return { runtimeStatus: ["invalid", "unavailable", "stale"].find(state => states.includes(state)) ?? "current", runtimeIssues: issues };
}

function stageInputs(ctx, plan) {
  const sources = Object.fromEntries(SOURCE_NAMES.map(name => [name, bytes(path.join(ctx.sourceDir, name))]));
  const template = bytes(path.join(ctx.sourceDir, "web-stop-adapter-entry.cs")).toString("utf8");
  const generation = hash(JSON.stringify({ plan, sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, hash(value)])), launcher: hash(template) }));
  return { sources, template, generation };
}

function stage(ctx, plan, previous) {
  const { sources, template, generation } = stageInputs(ctx, plan);
  let managedDirectory = previous?.generation === generation ? previous.managedDirectory : path.join(ctx.root, generation);
  const create = !existsSync(managedDirectory);
  // A compiled file can be readable while Windows refuses to rename its parent
  // directory (an open handle without delete sharing is sufficient). Build at
  // a unique final path instead. Only the verified ownership receipt publishes
  // that path; interrupted unselected builds remain untouched and cannot be
  // mistaken for complete candidates by a later attempt.
  if (create) managedDirectory = mkdtempSync(path.join(ctx.root, `${generation}-`));
  const configPath = path.join(managedDirectory, "config.json"), entryPath = path.join(managedDirectory, "entry.exe");
  const config = createAdapterConfig({ server: plan.officialNodeRepl.path, serverSha256: plan.officialNodeRepl.sha256,
    stateDir: ctx.stateDir, runtimeModule: plan.runtimeModule, sdkPackageJson: plan.sdkPackageJson,
    threadIds: plan.threadIds, receiptPath: ctx.eventsPath });
  if (create) {
    for (const [name, value] of Object.entries(sources)) ctx.write(path.join(managedDirectory, name), value);
    ctx.write(configPath, json(config));
    let rendered = template;
    for (const [token, value] of [["@@NODE@@", plan.node.path], ["@@ADAPTER@@", path.join(managedDirectory, "web-stop-adapter.mjs")], ["@@CONFIG@@", configPath],
      ["@@EVENTS@@", ctx.eventsPath], ["@@OFFICIAL_REPL@@", plan.officialNodeRepl.path], ["@@OFFICIAL_REPL_SHA256@@", plan.officialNodeRepl.sha256],
      ["@@NODE_SHA256@@", plan.node.sha256], ["@@CUA_ENTRY@@", plan.cuaBootstrap?.entry.path ?? ""], ["@@CUA_ENTRY_SHA256@@", plan.cuaBootstrap?.entry.sha256 ?? ""],
      ["@@CUA_GUARD@@", plan.cuaBootstrap?.guard?.path ?? ""], ["@@CUA_GUARD_SHA256@@", plan.cuaBootstrap?.guard?.sha256 ?? ""]]) {
      if (rendered.split(token).length !== 2) throw new Error("Invalid adapter launcher template.");
      rendered = rendered.replace(token, value.replaceAll('"', '""'));
    }
    ctx.write(path.join(managedDirectory, "entry.cs"), rendered);
    ctx.write(entryPath, Buffer.alloc(0));
    ctx.compileEntry(path.join(managedDirectory, "entry.cs"), entryPath);
    const executable = bytes(entryPath);
    if (!executable.length) throw new Error("Adapter launcher compilation produced no executable.");
    ctx.write(entryPath, executable);
    const files = Object.fromEntries([...SOURCE_NAMES, "config.json", "entry.cs", "entry.exe"].map(name => [name, hash(bytes(path.join(managedDirectory, name)))]));
    ctx.write(path.join(managedDirectory, "manifest.json"), json({ owner: OWNER, version: 1, generation,
      identity: "custom unsigned Codex Router MCP adapter", plan, files }));
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
  if (found.length > 1 || found.length === 1 && !receiptOwnsHook(receipt, found[0].hook)
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

function installUnlocked(ctx, manifest, refreshTransaction) {
    const previous = loadReceipt(ctx), beforeEnvironment = pair(ctx.environment.readPair()), beforeHooksText = readText(ctx.hooksPath), document = parseHooks(beforeHooksText);
    const found = ensureInstallOwnership(previous, beforeEnvironment, document);
    // An app update may already have removed the old official runtime. Its
    // retained private generation still proves ownership; the new candidate
    // below must independently pass the full external verification.
    if (previous && previous.state !== "removed") verifyManaged(ctx, previous, { external: false });
    const plan = inspectManifest(ctx, manifest), candidate = stage(ctx, plan, previous), hook = createAdapterHook();
    // Authenticate completed builds before publication so a later accepted
    // install can retire candidates left by failed or compensated activation.
    const custody = recordWebStopAdapterBuild(cleanupContext(ctx), candidate, { previous });
    if (custody.status !== "recorded") throw Object.assign(new Error(
      `Adapter build custody could not be recorded (${custody.reason ?? "unavailable"}); no launch selection was changed.`),
    { code: "ERR_ADAPTER_BUILD_CUSTODY" });
    if (refreshTransaction?.expectedGeneration && refreshTransaction.expectedGeneration !== candidate.generation) throw new Error("Adapter source changed during runtime refresh; retry with current source.");
    regular(ctx.eventsPath, { optional: true });
    if (!existsSync(ctx.eventsPath)) ctx.write(ctx.eventsPath, "");
    if (!ctx.isPrivate(ctx.eventsPath)) throw new Error("Adapter event receipt is not private.");
    const existing = previous && previous.state !== "removed";
    const created = existing ? previous.created : { hooks: document.hooks === undefined, interrupt: document.hooks?.Interrupt === undefined };
    const hookDefinitionChanged = !found || !same(found.hook, hook);
    if (!found) { document.hooks ??= {}; document.hooks.Interrupt ??= []; document.hooks.Interrupt.push({ hooks: [hook] }); }
    else if (hookDefinitionChanged) document.hooks.Interrupt[found.entryIndex].hooks[found.hookIndex] = hook;
    const nextHooksText = same(document, parseHooks(beforeHooksText)) ? beforeHooksText : json(document);
    // The official CLI is a verified compatibility record, not a Router launch
    // override. Also release a still-owned legacy pin to the original baseline.
    const desired = { CODEX_CLI_PATH: existing ? previous.previousEnvironment.CODEX_CLI_PATH : beforeEnvironment.CODEX_CLI_PATH,
      CODEX_NODE_REPL_PATH: candidate.entryPath };
    const installed = { owner: OWNER, version: 1, state: "installed", ...candidate, hooksPath: ctx.hooksPath, hook, created,
      environment: desired, priorEnvironment: existing ? previous.priorEnvironment : beforeEnvironment,
      previousEnvironment: existing ? previous.previousEnvironment : beforeEnvironment,
      previousHooksText: existing ? previous.previousHooksText : beforeHooksText, threadIds: plan.threadIds };
    const installedText = json(installed);
    if (previous?.state === "installed" && same({ ...previous, text: undefined }, { ...installed, text: undefined })
        && same(beforeEnvironment, desired) && beforeHooksText === nextHooksText) return installResult(ctx, installed, null, false);
    const preparedText = json({ ...installed, state: "prepared", priorEnvironment: beforeEnvironment,
      ...(found && !same(found.hook, hook) ? { priorHook: found.hook } : {}) });
    if (refreshTransaction) Object.assign(refreshTransaction, { desired, preparedText, installedText, nextHooksText });
    // Durable private baseline precedes both the hook file and User overrides.
    refreshTransaction?.beforeMutation?.();
    writeCompared(ctx, ctx.receiptPath, previous?.text ?? null, preparedText);
    const transaction = { beforeEnvironment, desired, beforeHooksText, nextHooksText, preparedText, installedText };
    let result = { broadcast: null };
    try {
      refreshTransaction?.beforeMutation?.();
      writeCompared(ctx, ctx.hooksPath, beforeHooksText, nextHooksText);
      refreshTransaction?.beforeMutation?.();
      if (!same(beforeEnvironment, desired)) result = ctx.environment.compareExchangePair(beforeEnvironment, desired);
      if (!same(pair(ctx.environment.readPair()), desired)) throw new Error("Adapter User environment activation readback failed.");
      writeCompared(ctx, ctx.receiptPath, preparedText, installedText);
    } catch (error) { if (error.runtimeRefreshRollbackAllowed === false) throw error; restoreFailedInstall(ctx, transaction, error); }
    return installResult(ctx, installed, result.broadcast, hookDefinitionChanged);
}

export function installWebStopAdapter(options = {}) {
  const ctx = context(options), manifestPath = absolute(options.manifestPath);
  regular(ctx.root, { optional: true, directory: true }); mkdirSync(ctx.root, { recursive: true });
  return withAtomicStateLock(ctx.receiptPath, () => {
    const previous = loadReceipt(ctx);
    const result = installUnlocked(ctx, manifestPath);
    return { ...result, cleanup: cleanupAfterSuccess(ctx, previous) };
  });
}

function cleanupContext(ctx) {
  return { ...ctx, verifyManaged: receipt => verifyManaged(ctx, receipt, { external: false }) };
}

function cleanupAfterSuccess(ctx, previous) {
  // Cleanup owns its conservative diagnostics. Its failure must never turn an
  // accepted activation into compensation after obsolete files were released.
  try { return ctx.cleanupBuilds(cleanupContext(ctx), { previous }); }
  catch { return { status: "deferred", removed: [], retained: [], reason: "cleanup-failed" }; }
}

function ownedRefreshState(ctx) {
  const receipt = loadReceipt(ctx);
  if (receipt?.state !== "installed") throw new Error("Runtime refresh requires an installed owned Web Stop adapter; finish adapter setup or recovery first.");
  const managed = verifyManaged(ctx, receipt, { external: false });
  const environment = pair(ctx.environment.readPair()), hooksText = readText(ctx.hooksPath);
  ensureInstallOwnership(receipt, environment, parseHooks(hooksText));
  return { receipt, environment, hooksText, currentRuntime: managed.plan };
}

export function ownedWebStopAdapterEntry(options = {}) {
  return ownedRefreshState(context(options)).receipt.entryPath;
}

const rollbackIdentity = receipt => ({ generation: receipt.generation, managedDirectory: receipt.managedDirectory,
  managedManifestSha256: receipt.managedManifestSha256 });

export function inspectWebStopAdapterRollbackBinding(options = {}) {
  const ctx = context(options), receipt = loadReceipt(ctx);
  if (!receipt || receipt.state === "removed") {
    const selected = pair(ctx.environment.readPair()).CODEX_NODE_REPL_PATH;
    if (selected && path.isAbsolute(selected) && path.resolve(selected).toLowerCase().startsWith(`${ctx.root.toLowerCase()}${path.sep}`)) {
      throw new Error("An adapter is selected without settled installed ownership.");
    }
    return null;
  }
  if (receipt.state !== "installed") throw new Error("Adapter installation is not settled; preserve its recovery artifacts.");
  return rollbackIdentity(ownedRefreshState(ctx).receipt);
}

export function verifyWebStopAdapterRollbackBinding(binding, options = {}) {
  if (binding === null) {
    if (inspectWebStopAdapterRollbackBinding(options) !== null) throw new Error("The rollback adapter absence no longer matches installed ownership.");
    return null;
  }
  const ctx = context(options);
  if (!object(binding) || !same(Object.keys(binding).sort(), ["generation", "managedDirectory", "managedManifestSha256"])
      || !SHA.test(binding.generation ?? "") || !SHA.test(binding.managedManifestSha256 ?? "") || !managedPath(ctx, binding)) {
    throw new Error("Invalid rollback adapter binding.");
  }
  const receipt = { ...binding, configPath: path.join(binding.managedDirectory, "config.json"), entryPath: path.join(binding.managedDirectory, "entry.exe") };
  verifyManaged(ctx, receipt, { external: false });
  return rollbackIdentity(receipt);
}

function inspectRefresh(ctx, options) {
  const { receipt, environment, hooksText, currentRuntime } = ownedRefreshState(ctx);
  let manifest = options.manifestPath ? absolute(options.manifestPath) : options.manifest;
  if (!manifest && options.anchors) {
    const anchors = options.anchors, paths = [anchors.node, anchors.officialCli, anchors.officialNodeRepl].map(absolute);
    const signatures = ctx.inspectSignatures(paths);
    if (!Array.isArray(signatures) || signatures.length !== paths.length) throw new Error("Incomplete official signature inspection.");
    manifest = { version: 1, runtimeModule: anchors.runtimeModule, sdkPackageJson: anchors.sdkPackageJson,
      threadIds: receipt.threadIds ?? null };
    for (const [index, name] of ["node", "officialCli", "officialNodeRepl"].entries()) {
      const matches = signatures.filter(item => item.path === paths[index]);
      if (matches.length !== 1) throw new Error("Ambiguous official runtime signature inspection.");
      const { status, signerSubject, signerThumbprint } = matches[0];
      manifest[name] = { path: paths[index], sha256: hash(bytes(paths[index])), authenticode: { status, signerSubject, signerThumbprint } };
    }
  }
  const candidate = inspectManifest(ctx, manifest);
  if (path.dirname(candidate.node.path) !== path.dirname(candidate.officialNodeRepl.path)) throw new Error("Web runtime refresh requires Node and Node REPL from the same official runtime directory.");
  if (options.allowThreadScopeChange !== true && !same(candidate.threadIds, receipt.threadIds ?? null)) throw new Error("Runtime refresh must preserve the installed adapter thread scope.");
  return { manifest, candidate, candidateGeneration: stageInputs(ctx, candidate).generation, receipt, environment, hooksText, currentRuntime };
}

export function inspectWebStopAdapterRuntimeRefresh(options = {}) {
  const ctx = context(options), observed = inspectRefresh(ctx, options);
  return { manifest: observed.manifest, candidate: observed.candidate, candidateGeneration: observed.candidateGeneration, generation: observed.receipt.generation,
    managedDirectory: observed.receipt.managedDirectory, managedManifestSha256: observed.receipt.managedManifestSha256,
    currentRuntime: observed.currentRuntime, managedEntryPath: observed.receipt.entryPath,
    threadIds: observed.receipt.threadIds ?? null, receiptSha256: hash(observed.receipt.text),
    hooksSha256: hash(observed.hooksText ?? ""), environment: observed.environment,
    hookDefinitionChanged: !same(observed.receipt.hook, createAdapterHook()),
    cliSelectionChanged: observed.environment.CODEX_CLI_PATH !== observed.receipt.previousEnvironment.CODEX_CLI_PATH };
}

// The same lock pathname and owner-file format as the ordinary installer keeps
// install/rollback out while the coordinated Router reload is pending.
export async function withWebStopAdapterRuntimeRefresh(options, operation) {
  const ctx = context(options);
  return withDirectoryLock(async () => {
    const before = inspectRefresh(ctx, options);
    if (options.expected && (options.expected.receiptSha256 !== hash(before.receipt.text)
        || options.expected.hooksSha256 !== hash(before.hooksText ?? "")
        || !same(options.expected.environment, before.environment)
        || options.expected.candidateGeneration !== before.candidateGeneration
        || !same(options.expected.candidate, before.candidate))) throw new Error("Web runtime refresh plan changed; retry before applying.");
    const transaction = { expectedGeneration: before.candidateGeneration, beforeMutation: options.beforeMutation };
    let completed;
    try {
      options.beforeMutation?.();
      const result = installUnlocked(ctx, options.manifestPath ? absolute(options.manifestPath) : options.manifest, transaction);
      completed = await operation(result);
    } catch (cause) {
      if (cause.runtimeRefreshSelectionsUnchanged === true) throw cause;
      // A reloaded Router can already be admitting calls. The coordinator
      // withholds compensation if a fresh idle drain cannot be established.
      if (cause.runtimeRefreshRollbackAllowed === false) throw cause;
      const failures = [];
      try {
        const current = pair(ctx.environment.readPair()), restored = { ...current };
        for (const name of ENV_NAMES) {
          if (current[name] === transaction.desired?.[name]) restored[name] = before.environment[name];
          else if (current[name] !== before.environment[name]) failures.push("Foreign User environment preserved.");
        }
        if (!same(current, restored)) ctx.environment.compareExchangePair(current, restored);
        if (!same(pair(ctx.environment.readPair()), restored)) throw new Error("Environment restoration readback failed.");
      } catch { failures.push("User environment restoration failed."); }
      try {
        // Restore the legacy hook only while the exact published replacement
        // remains owned. Concurrent edits are never overwritten.
        const current = readText(ctx.hooksPath);
        if (current !== before.hooksText) {
          if (current === transaction.nextHooksText) writeCompared(ctx, ctx.hooksPath, current, before.hooksText);
          else failures.push("Foreign hooks changes preserved.");
        }
      } catch { failures.push("Hook restoration verification failed."); }
      try {
        const current = readText(ctx.receiptPath);
        if (current !== before.receipt.text) {
          if (![transaction.installedText, transaction.preparedText].includes(current)) throw new Error("Foreign ownership receipt preserved.");
          writeCompared(ctx, ctx.receiptPath, current, before.receipt.text);
        }
      } catch { failures.push("Ownership receipt restoration failed."); }
      if (failures.length) throw new Error(`Web runtime refresh failed; rollback incomplete: ${failures.join(" ")}`, { cause });
      throw cause;
    }
    const cleanup = cleanupAfterSuccess(ctx, before.receipt);
    return completed && typeof completed === "object" ? { ...completed, cleanup } : completed;
  }, { target: ctx.receiptPath, waitMs: 2_000, retryMs: 25, heartbeatMs: 10_000,
    defaults: { waitMs: 2_000, retryMs: 25, heartbeatMs: 10_000 },
    lockedError: (_wait, cause) => new Error("Another Web Stop adapter operation is running; retry shortly.", { cause }),
    releaseErrorKey: "adapterLockReleaseError", releaseErrorMessage: () => "Web runtime refresh finished, but the adapter ownership lock could not be released." });
}

function adapterPaths(ctx, receipt) {
  return { state: receipt.state, generation: receipt.generation, cliPath: receipt.environment.CODEX_CLI_PATH, entryPath: receipt.entryPath,
    managedManifestSha256: receipt.managedManifestSha256,
    configPath: receipt.configPath, managedDirectory: receipt.managedDirectory, receiptPath: ctx.receiptPath,
    threadIds: receipt.threadIds };
}

function installResult(ctx, receipt, broadcast, hookDefinitionChanged) {
  return { ...adapterPaths(ctx, receipt), installed: true, restartRequired: true, trustRequired: true,
    hookDefinitionChanged, environmentBroadcast: broadcast };
}

export function webStopAdapterStatus(options = {}) {
  const ctx = context(options), receipt = loadReceipt(ctx);
  // A local receipt owns files and launch selections. It does not establish
  // which generation an existing app loaded or the app's native hook trust.
  const runtime = { appLoaded: "unknown", hookTrusted: "unknown", restartRequired: "unknown", trustRequired: "unknown" };
  const unchecked = { runtimeStatus: "not-checked", runtimeIssues: [] };
  if (!receipt) return { installed: false, state: "absent", receiptPath: ctx.receiptPath, hookDefinitionOwned: false,
    ownershipVerified: false, conflicts: [], ...unchecked, ...runtime };
  const conflicts = [];
  const conflictMessage = error => error instanceof SyntaxError ? "Adapter JSON is invalid." : error.message;
  let manifest;
  try { manifest = verifyManaged(ctx, receipt, { external: false }); } catch (error) { conflicts.push(conflictMessage(error)); }
  let hookDefinitionOwned = false;
  if (receipt.state !== "removed") {
    let document;
    try {
      document = parseHooks(readText(ctx.hooksPath));
      const found = findHooks(document);
      hookDefinitionOwned = found.length === 1 && receiptOwnsHook(receipt, found[0].hook);
    } catch (error) { hookDefinitionOwned = "unknown"; conflicts.push(conflictMessage(error)); }
    if (document) try { ensureInstallOwnership(receipt, pair(ctx.environment.readPair()), document); } catch (error) { conflicts.push(error.message); }
  }
  const ownershipVerified = conflicts.length === 0;
  const external = ownershipVerified && receipt.state !== "removed" && options.inspectRuntime !== false
    ? observeExternalRuntime(ctx, manifest.plan) : unchecked;
  return { ...adapterPaths(ctx, receipt), installed: receipt.state === "installed" && ownershipVerified && external.runtimeStatus === "current",
    recoveryRequired: receipt.state === "prepared", ownershipVerified, hookDefinitionOwned, conflicts, ...external, ...runtime };
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
    if (found.length === 1 && receiptOwnsHook(receipt, found[0].hook)) {
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
    const completed = { ...next, state };
    if (state === "removed") delete completed.priorHook;
    writeCompared(ctx, ctx.receiptPath, preparedText, json(completed));
    return { installed: false, changed: !same(current, restored) || nextHooksText !== beforeHooksText, state,
      restartRequired: true, retainedManagedFiles: true, managedDirectory: receipt.managedDirectory, conflicts,
      environmentBroadcast: result.broadcast };
  });
}
