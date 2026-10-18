import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_HOME, STATE_DIR } from "./paths.mjs";
import { privateFileIsProtected, writePrivateFile } from "./file-security.mjs";
import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { createWebStopHookConfig } from "./web-stop-hook.mjs";

// Activation is deliberately limited to this verified rollout. Updating this
// identity requires renewed native Stop, continuation and Windows sandbox proof.
export const ACCEPTED_WEB_STOP_BUILD = Object.freeze({
  sha256: "42F964BACD72BFE9FF08889E9CFDAD5BA7E99435B0C5E55D448808AFF3FEF9BA",
  version: "0.163.0-alpha.10.2",
  sourceCommit: "4ebc485ca321243727539187169425fcf972f2c4",
  signerThumbprint: "8C1BBD222297A3669B63F95B42710343619559BB",
  companions: Object.freeze({
    "codex-code-mode-host.exe": "3B6A9179A4DA17FA5FC6948219CD61486DC3B534C683838076D8C61BD311C68E",
    "codex-command-runner.exe": "CE80B56A2F37F808815FDE33CCEB97AC858CEECDE296425AD3860F0F37FB4877",
    "codex-windows-sandbox-setup.exe": "C4DA812016CBFB92D9A62791F78460C59E9662FAADB0A2720D3AA5D0535B80BD",
    "rg.exe": "168449A036E74E83CCDDCFA0194CDA9E78D145CBAF3497D7AC3FFA5596FB13D5",
  }),
});

const OWNER = "codex-router-web-stop-v1";
const HOOK_ID = "Stopping owned ChatGPT Web generation";
const helper = fileURLToPath(new URL("./web-stop-env.ps1", import.meta.url));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function invokeHelper(request) {
  if (process.platform !== "win32") throw new Error("Persistent Web Stop installation requires Windows.");
  // A PowerShell 7 caller can otherwise make Windows PowerShell autoload its
  // incompatible Security module. Let the selected host build its own path.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  return JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper], {
    env, input: JSON.stringify(request), encoding: "utf8", timeout: 20_000, maxBuffer: 128 * 1024,
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  }));
}

const userEnvironment = {
  read: () => invokeHelper({ action: "read" }).value,
  compareExchange: (expected, value) => invokeHelper({ action: "compareExchange", expected, value }),
};

function context(options = {}) {
  const stateDir = absolute(options.stateDir ?? STATE_DIR, "state directory");
  const codexHome = absolute(options.codexHome ?? CODEX_HOME, "Codex home");
  // Tests replace only external Windows effects and the accepted fixture build.
  // The CLI never exposes these dependencies or an alternate accepted identity.
  const dependencies = options.dependencies ?? {};
  return { stateDir, codexHome, root: path.join(stateDir, "native-web-stop"),
    receiptPath: path.join(stateDir, "native-web-stop", "ownership.json"),
    hooksPath: path.join(codexHome, "hooks.json"),
    accepted: dependencies.acceptedBuild ?? ACCEPTED_WEB_STOP_BUILD,
    environment: dependencies.environment ?? userEnvironment,
    inspectSignatures: dependencies.inspectSignatures ?? (paths => invokeHelper({ action: "signatures", paths })),
    readVersion: dependencies.readVersion ?? (file => execFileSync(file, ["--version"], {
      encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }).trim()),
    write: dependencies.writePrivate ?? writePrivateFile,
    isPrivate: dependencies.isPrivate ?? privateFileIsProtected,
  };
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error(`Invalid ${label} path.`);
  return path.resolve(value);
}

function regularPath(file, { optional = false, directory = false } = {}) {
  // Reject junctions/symlinks in ancestors as well as the final entry.
  let cursor = absolute(file, "file");
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link path: ${cursor}`);
      if (cursor === file && (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Not a regular ${directory ? "directory" : "file"}: ${file}`);
    } catch (error) { if (error.code !== "ENOENT" || (!optional && cursor === file)) throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function readText(file) {
  regularPath(file, { optional: true });
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function parseHooks(text) {
  const value = text === null ? {} : JSON.parse(text);
  if (!object(value) || (value.hooks !== undefined && !object(value.hooks))
      || (value.hooks?.Interrupt !== undefined && !Array.isArray(value.hooks.Interrupt))) throw new Error("Invalid native hooks document.");
  for (const entry of value.hooks?.Interrupt ?? []) {
    if (!object(entry) || !Array.isArray(entry.hooks) || entry.hooks.some(item => !object(item))) throw new Error("Invalid Interrupt hook entry.");
  }
  return value;
}

function ownedHooks(document) {
  const found = [];
  for (const [entryIndex, entry] of (document.hooks?.Interrupt ?? []).entries()) {
    for (const [hookIndex, handler] of entry.hooks.entries()) {
      if (handler.statusMessage === HOOK_ID) found.push({ entryIndex, hookIndex, handler });
    }
  }
  return found;
}

function loadReceipt(ctx) {
  const text = readText(ctx.receiptPath);
  if (text === null) return null;
  if (!ctx.isPrivate(ctx.receiptPath)) throw new Error("Web Stop ownership receipt is not private.");
  const receipt = JSON.parse(text);
  const expectedDirectory = path.join(ctx.root, ctx.accepted.sha256.toLowerCase());
  if (!object(receipt) || receipt.owner !== OWNER || receipt.version !== 1
      || !["prepared", "installed", "removed"].includes(receipt.state) || receipt.managedDirectory !== expectedDirectory
      || receipt.cliPath !== path.join(expectedDirectory, "codex.exe")
      || receipt.candidateSha256 !== ctx.accepted.sha256 || receipt.hooksPath !== ctx.hooksPath
      || !(receipt.previousUserCliPath === null || typeof receipt.previousUserCliPath === "string")
      || !(receipt.previousHooksText === null || typeof receipt.previousHooksText === "string")
      || receipt.hook?.statusMessage !== HOOK_ID || !object(receipt.created)
      || typeof receipt.created.hooks !== "boolean" || typeof receipt.created.interrupt !== "boolean"
      || (receipt.previousManagedHook != null && receipt.previousManagedHook.statusMessage !== HOOK_ID)) throw new Error("Invalid or foreign Web Stop ownership receipt.");
  parseHooks(receipt.previousHooksText);
  return { ...receipt, text };
}

function verifyBytes(file, expectedHash, expectedSize) {
  regularPath(file);
  const before = lstatSync(file);
  const bytes = readFileSync(file);
  const after = lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || sha256(bytes) !== expectedHash
      || (expectedSize !== undefined && bytes.length !== expectedSize)) throw new Error(`Web Stop file identity mismatch: ${file}`);
  return bytes;
}

function verifySignatures(ctx, files) {
  const actual = ctx.inspectSignatures(files.map(item => item.path));
  if (!Array.isArray(actual) || actual.length !== files.length) throw new Error("Incomplete native signature inspection.");
  for (const file of files) {
    const matches = actual.filter(item => item.path === file.path);
    if (matches.length !== 1) throw new Error("Ambiguous native signature identity.");
    const signature = matches[0];
    if (file.name === "codex.exe") {
      if (signature.status !== "NotSigned") throw new Error("Unexpected locally patched CLI signature identity.");
    } else if (signature.status !== "Valid" || !/OpenAI OpCo, LLC/u.test(signature.signerSubject ?? "")
        || signature.signerThumbprint !== ctx.accepted.signerThumbprint
        || signature.signerThumbprint !== file.authenticode.signerThumbprint
        || signature.signerSubject !== file.authenticode.signerSubject) throw new Error(`Invalid official companion signature: ${file.name}`);
  }
}

function inspectCandidate(ctx, manifestPath) {
  regularPath(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const accepted = ctx.accepted;
  if (manifest.schemaVersion !== 1 || manifest.upstreamReleaseVersion !== accepted.version
      || manifest.upstreamSourceCommit !== accepted.sourceCommit || manifest.candidateCli?.sha256 !== accepted.sha256
      || !Array.isArray(manifest.companions) || manifest.companions.length !== 4) throw new Error("Native build manifest does not identify the accepted Web Stop build.");
  const candidate = manifest.candidateCli;
  if (candidate.authenticode?.status !== "NotSigned" || path.basename(candidate.path ?? "") !== "codex.exe") throw new Error("Invalid native candidate manifest identity.");
  const files = [{ ...candidate, name: "codex.exe", path: absolute(candidate.path, "candidate") }];
  for (const [name, expectedHash] of Object.entries(accepted.companions)) {
    const matches = manifest.companions.filter(item => item.name === name);
    if (matches.length !== 1) throw new Error("Native companion set does not match the accepted build.");
    const item = matches[0];
    if (item.source?.sha256 !== expectedHash || item.staged?.sha256 !== expectedHash
        || item.source.authenticode?.status !== "Valid" || item.staged.authenticode?.status !== "Valid"
        || path.basename(item.staged.path ?? "") !== name || !same(item.source.authenticode, item.staged.authenticode)) throw new Error(`Invalid companion manifest identity: ${name}`);
    files.push({ ...item.staged, name, path: absolute(item.staged.path, "companion") });
  }
  for (const file of files) {
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) throw new Error("Invalid native file size.");
    verifyBytes(file.path, file.sha256, file.sizeBytes);
  }
  verifySignatures(ctx, files);
  if (ctx.readVersion(files[0].path) !== `codex-cli ${accepted.version}`) throw new Error("Native candidate version does not match the accepted build.");
  return files;
}

function stage(ctx, files) {
  regularPath(ctx.root, { optional: true, directory: true });
  mkdirSync(ctx.root, { recursive: true });
  const target = path.join(ctx.root, ctx.accepted.sha256.toLowerCase());
  const manifest = { owner: OWNER, version: 1, candidateSha256: ctx.accepted.sha256,
    cliVersion: ctx.accepted.version, sourceCommit: ctx.accepted.sourceCommit,
    files: files.map(({ name, sha256: hash, sizeBytes, authenticode }) => ({ name, sha256: hash, sizeBytes, authenticode })) };
  if (!existsSync(target)) {
    const temporary = mkdtempSync(path.join(ctx.root, ".stage-"));
    // A failed private staging directory is inert and deliberately retained for
    // inspection; no environment or hooks have been changed at this point.
    for (const file of files) ctx.write(path.join(temporary, file.name), verifyBytes(file.path, file.sha256, file.sizeBytes));
    ctx.write(path.join(temporary, "manifest.json"), json(manifest));
    renameSync(temporary, target);
  }
  verifyManaged(ctx, target, manifest);
  return target;
}

function verifyManaged(ctx, directory, expectedManifest) {
  regularPath(directory, { directory: true });
  const manifestPath = path.join(directory, "manifest.json");
  regularPath(manifestPath);
  if (!ctx.isPrivate(manifestPath)) throw new Error("Managed native manifest is not private.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if ((expectedManifest && !same(manifest, expectedManifest)) || manifest.owner !== OWNER || manifest.version !== 1
      || manifest.candidateSha256 !== ctx.accepted.sha256 || manifest.cliVersion !== ctx.accepted.version
      || manifest.sourceCommit !== ctx.accepted.sourceCommit || !Array.isArray(manifest.files)
      || manifest.files.length !== 5) throw new Error("Foreign managed native build manifest.");
  const hashes = { "codex.exe": ctx.accepted.sha256, ...ctx.accepted.companions };
  const expectedNames = [...Object.keys(hashes), "manifest.json"].sort();
  if (!same(readdirSync(directory).sort(), expectedNames)) throw new Error("Foreign files in the managed native build directory.");
  const files = Object.entries(hashes).map(([name, hash]) => {
    const matches = manifest.files.filter(file => file.name === name);
    if (matches.length !== 1 || matches[0].sha256 !== hash) throw new Error("Foreign managed native file identity.");
    const file = { ...matches[0], path: path.join(directory, name) };
    verifyBytes(file.path, hash, file.sizeBytes);
    if (!ctx.isPrivate(file.path)) throw new Error(`Managed native file is not private: ${name}`);
    return file;
  });
  verifySignatures(ctx, files);
}

function ensureOwnedHook(document, receipt) {
  const found = ownedHooks(document);
  if (!receipt || receipt.state === "removed") {
    if (found.length) throw new Error("A foreign Interrupt hook already uses the Web Stop identity.");
    return null;
  }
  if (receipt.state === "prepared" && found.length === 0) return null;
  if (found.length !== 1 || !(same(found[0].handler, receipt.hook)
      || (receipt.state === "prepared" && same(found[0].handler, receipt.previousManagedHook)))) throw new Error("The managed Web Stop hook was changed or removed by another writer.");
  return found[0];
}

function ensureOwnedEnvironment(receipt, value) {
  if (receipt && receipt.state !== "removed" && value !== receipt.cliPath
      && !(receipt.state === "prepared" && value === receipt.previousUserCliPath)) {
    throw new Error("User CODEX_CLI_PATH changed; refusing to overwrite a foreign value.");
  }
}

function writeCompared(ctx, file, expectedText, nextText) {
  if (readText(file) !== expectedText) throw new Error("Web Stop file changed; refusing to overwrite another writer.");
  if (nextText === expectedText) return;
  if (nextText === null) unlinkSync(file);
  else ctx.write(file, nextText);
}

function restoreAfterFailure(ctx, { previousHooksText, writtenHooksText, beforeEnv, desiredEnv, receiptText, writtenReceiptText }, cause) {
  const failures = [];
  if (desiredEnv !== undefined) {
    try {
      const actual = ctx.environment.read();
      if (actual === desiredEnv) ctx.environment.compareExchange(desiredEnv, beforeEnv);
      else if (actual !== beforeEnv) throw new Error("User environment changed; preserved foreign value.");
    } catch (error) { failures.push(error.message); }
  }
  if (writtenHooksText !== undefined) {
    try {
      const actual = readText(ctx.hooksPath);
      if (actual === writtenHooksText) writeCompared(ctx, ctx.hooksPath, writtenHooksText, previousHooksText);
      else if (actual !== previousHooksText) throw new Error("Hooks changed; preserved foreign file.");
    } catch (error) { failures.push(error.message); }
  }
  if (writtenReceiptText !== undefined) {
    try {
      const actual = readText(ctx.receiptPath);
      if (actual === writtenReceiptText) writeCompared(ctx, ctx.receiptPath, writtenReceiptText, receiptText);
      else if (actual !== receiptText) throw new Error("Ownership receipt changed; preserved foreign file.");
    }
    catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(`${cause.message} Rollback incomplete: ${failures.join(" ")}`, { cause });
  throw cause;
}

export function installWebStop(options = {}) {
  const ctx = context(options);
  const manifestPath = absolute(options.candidateManifestPath ?? options.manifestPath, "explicit candidate manifest");
  const runtimeModule = absolute(options.runtimeModule, "browser runtime module");
  regularPath(runtimeModule);
  regularPath(ctx.root, { optional: true, directory: true });
  mkdirSync(ctx.root, { recursive: true });
  return withAtomicStateLock(ctx.receiptPath, () => {
    const receipt = loadReceipt(ctx);
    const beforeEnv = ctx.environment.read();
    ensureOwnedEnvironment(receipt, beforeEnv);
    const previousHooksText = readText(ctx.hooksPath);
    const document = parseHooks(previousHooksText);
    const found = ensureOwnedHook(document, receipt);
    const files = inspectCandidate(ctx, manifestPath);
    const managedDirectory = stage(ctx, files);
    const cliPath = path.join(managedDirectory, "codex.exe");
    const hook = createWebStopHookConfig({ stateDir: ctx.stateDir, runtimeModule }).hooks.Interrupt[0].hooks[0];
    const existingOwnership = receipt && receipt.state !== "removed";
    const created = existingOwnership ? receipt.created : { hooks: document.hooks === undefined, interrupt: document.hooks?.Interrupt === undefined };
    if (found) document.hooks.Interrupt[found.entryIndex].hooks[found.hookIndex] = hook;
    else { document.hooks ??= {}; document.hooks.Interrupt ??= []; document.hooks.Interrupt.push({ hooks: [hook] }); }
    const nextHooksText = json(document);
    const nextReceipt = { owner: OWNER, version: 1, state: "installed", managedDirectory, cliPath,
      candidateSha256: ctx.accepted.sha256, hooksPath: ctx.hooksPath, runtimeModule,
      previousUserCliPath: existingOwnership ? receipt.previousUserCliPath : beforeEnv,
      previousHooksText: existingOwnership ? receipt.previousHooksText : previousHooksText,
      previousHook: existingOwnership ? receipt.previousHook : null, created, hook };
    const nextReceiptText = json(nextReceipt);
    // Persist the original baseline before either global setting can change.
    // A failed rollback retains this receipt so retry/removal can distinguish
    // our managed value from the user's original value after a partial effect.
    const preparedText = json({ ...nextReceipt, state: "prepared", previousManagedHook: found?.handler ?? null });
    writeCompared(ctx, ctx.receiptPath, receipt?.text ?? null, preparedText);
    const transaction = { previousHooksText, beforeEnv, receiptText: preparedText };
    let environmentResult = { broadcast: null };
    try {
      if (previousHooksText !== nextHooksText) {
        transaction.writtenHooksText = nextHooksText;
        writeCompared(ctx, ctx.hooksPath, previousHooksText, nextHooksText);
      }
      if (beforeEnv !== cliPath) {
        transaction.desiredEnv = cliPath;
        environmentResult = ctx.environment.compareExchange(beforeEnv, cliPath);
        if (ctx.environment.read() !== cliPath) throw new Error("User CODEX_CLI_PATH activation readback failed.");
      }
      transaction.writtenReceiptText = nextReceiptText;
      writeCompared(ctx, ctx.receiptPath, transaction.receiptText, nextReceiptText);
    } catch (error) { restoreAfterFailure(ctx, transaction, error); }
    return { installed: true, cliPath, managedDirectory, hooksPath: ctx.hooksPath,
      candidateSha256: ctx.accepted.sha256, restartRequired: true, trustRequired: true,
      environmentBroadcast: environmentResult.broadcast, receiptPath: ctx.receiptPath };
  });
}

export function webStopStatus(options = {}) {
  const ctx = context(options);
  const receipt = loadReceipt(ctx);
  const userCliPath = ctx.environment.read();
  if (!receipt) return { installed: false, receiptPath: ctx.receiptPath, userCliPath };
  const conflicts = [];
  try { verifyManaged(ctx, receipt.managedDirectory); } catch (error) { conflicts.push(error.message); }
  if (receipt.state !== "removed") {
    try { ensureOwnedEnvironment(receipt, userCliPath); } catch (error) { conflicts.push(error.message); }
    try { ensureOwnedHook(parseHooks(readText(ctx.hooksPath)), receipt); } catch (error) { conflicts.push(error.message); }
  }
  return { installed: receipt.state === "installed" && conflicts.length === 0, state: receipt.state,
    cliPath: receipt.cliPath, userCliPath, hooksPath: ctx.hooksPath, managedDirectory: receipt.managedDirectory,
    candidateSha256: receipt.candidateSha256, conflicts, recoveryRequired: receipt.state === "prepared",
    restartRequired: receipt.state !== "removed", trustRequired: receipt.state !== "removed", receiptPath: ctx.receiptPath };
}

export function removeWebStop(options = {}) {
  const ctx = context(options);
  if (!existsSync(ctx.receiptPath)) return { installed: false, changed: false, restartRequired: false };
  return withAtomicStateLock(ctx.receiptPath, () => {
    const receipt = loadReceipt(ctx);
    if (receipt.state === "removed") return { installed: false, changed: false, restartRequired: false, managedDirectory: receipt.managedDirectory };
    verifyManaged(ctx, receipt.managedDirectory);
    const beforeEnv = ctx.environment.read();
    ensureOwnedEnvironment(receipt, beforeEnv);
    const previousHooksText = readText(ctx.hooksPath);
    const document = parseHooks(previousHooksText);
    const found = ensureOwnedHook(document, receipt);
    if (found) {
      const entry = document.hooks.Interrupt[found.entryIndex];
      entry.hooks.splice(found.hookIndex, 1);
      if (entry.hooks.length === 0 && Object.keys(entry).length === 1) document.hooks.Interrupt.splice(found.entryIndex, 1);
    }
    if (receipt.created.interrupt && document.hooks?.Interrupt?.length === 0) delete document.hooks.Interrupt;
    if (receipt.created.hooks && document.hooks && Object.keys(document.hooks).length === 0) delete document.hooks;
    const nextHooksText = same(document, parseHooks(receipt.previousHooksText)) ? receipt.previousHooksText : json(document);
    const { text: _text, ...nextReceipt } = receipt;
    nextReceipt.state = "removed";
    const nextReceiptText = json(nextReceipt);
    const preparedText = json({ ...nextReceipt, state: "prepared" });
    writeCompared(ctx, ctx.receiptPath, receipt.text, preparedText);
    const transaction = { previousHooksText, beforeEnv, receiptText: preparedText };
    let environmentResult = { broadcast: null };
    try {
      transaction.writtenHooksText = nextHooksText;
      writeCompared(ctx, ctx.hooksPath, previousHooksText, nextHooksText);
      if (beforeEnv !== receipt.previousUserCliPath) {
        transaction.desiredEnv = receipt.previousUserCliPath;
        environmentResult = ctx.environment.compareExchange(beforeEnv, receipt.previousUserCliPath);
        if (ctx.environment.read() !== receipt.previousUserCliPath) throw new Error("User environment restoration readback failed.");
      }
      transaction.writtenReceiptText = nextReceiptText;
      writeCompared(ctx, ctx.receiptPath, preparedText, nextReceiptText);
    } catch (error) { restoreAfterFailure(ctx, transaction, error); }
    // Retain the protected, verified build: the currently running desktop may
    // still hold its executable open. It is inert after the environment restore.
    return { installed: false, changed: true, restartRequired: true, managedDirectory: receipt.managedDirectory,
      retainedManagedFiles: true, environmentBroadcast: environmentResult.broadcast };
  });
}
