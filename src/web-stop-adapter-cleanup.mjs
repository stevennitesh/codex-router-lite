import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { isProcessStartIdentity } from "./process-identity.mjs";
import { registeredSystemSandboxBroker } from "./web-maintenance-proof.mjs";

const OWNER = "codex-router-web-stop-adapter-v1";
const RETENTION_OWNER = "codex-router-web-stop-adapter-retention-v1";
const SHA = /^[a-f0-9]{64}$/u;
const BUILD = /^[a-f0-9]{64}(?:-[A-Za-z0-9]{6})?$/u;
const OPERATION = /^[a-f0-9]{32}$/u;
const RUNTIME_FILES = ["SOURCE_COMMIT", "provenance.json", "routes.toml", "switchyard-server.exe"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const normalize = value => path.resolve(value).replaceAll("\\", "/").toLowerCase();
const key = value => normalize(value.managedDirectory);
const fail = reason => { throw Object.assign(new Error(reason), { cleanupReason: reason }); };

function present(ctx, file) {
  try { (ctx.probePath ?? lstatSync)(file); return true; }
  catch (error) {
    if (error.code !== "ENOENT") fail("uncertain-path-presence");
    // A missing leaf underneath a linked, non-directory or unreadable parent is
    // not proof that the managed recovery/retention location is absent.
    for (let cursor = path.dirname(file); ; cursor = path.dirname(cursor)) {
      try {
        const stat = (ctx.probePath ?? lstatSync)(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe-path");
      } catch (parentError) { if (parentError.code !== "ENOENT") fail(parentError.cleanupReason ?? "uncertain-path-presence"); }
      if (path.dirname(cursor) === cursor) return false;
    }
  }
}

// Check the complete ancestry, including junctions, before any read or removal.
function regular(file, directory = false) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/u.test(file) || /^(?:\\\\|\/\/)/u.test(file)) fail("unsafe-path");
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || cursor === file && (directory ? !stat.isDirectory() : !stat.isFile())) fail("unsafe-path");
    if (path.dirname(cursor) === cursor) break;
  }
}

function read(ctx, file, observations, privateFile = true) {
  regular(file);
  if (privateFile && !ctx.isPrivate(file)) fail("unprotected-metadata");
  const before = lstatSync(file), bytes = readFileSync(file), after = lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("metadata-changed");
  if (observations) observations.push([file, hash(bytes)]);
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
}

function listing(ctx, directory, observations) {
  if (!present(ctx, directory)) { observations?.push([directory, null]); return []; }
  regular(directory, true);
  const names = readdirSync(directory).sort();
  observations?.push([directory, names]);
  return names;
}

function identity(ctx, value, { legacy = false } = {}) {
  if (!object(value) || !SHA.test(value.generation ?? "") || typeof value.managedDirectory !== "string"
      || path.dirname(value.managedDirectory) !== ctx.root || !BUILD.test(path.basename(value.managedDirectory))
      || path.basename(value.managedDirectory).split("-")[0] !== value.generation) fail("invalid-build-reference");
  let manifestHash = value.managedManifestSha256;
  // Only an accepted, protected legacy Web receipt may select an old build
  // without a manifest hash. An unselected directory never establishes ownership.
  if (manifestHash === undefined && legacy) {
    const file = path.join(value.managedDirectory, "manifest.json");
    regular(file);
    if (!ctx.isPrivate(file)) fail("unprotected-metadata");
    manifestHash = hash(readFileSync(file));
  }
  if (!SHA.test(manifestHash ?? "")) fail("invalid-build-reference");
  return { generation: value.generation, managedDirectory: value.managedDirectory, managedManifestSha256: manifestHash };
}

function verify(ctx, reference) {
  regular(reference.managedDirectory, true);
  const file = path.join(reference.managedDirectory, "manifest.json");
  regular(file);
  if (!ctx.isPrivate(file) || hash(readFileSync(file)) !== reference.managedManifestSha256) fail("build-integrity");
  const receipt = { ...reference, entryPath: path.join(reference.managedDirectory, "entry.exe"), configPath: path.join(reference.managedDirectory, "config.json") };
  const manifest = ctx.verifyManaged(receipt);
  if (!object(manifest) || manifest.owner !== OWNER || manifest.version !== 1 || manifest.generation !== reference.generation || !object(manifest.files)) fail("build-integrity");
  const names = Object.keys(manifest.files);
  if (names.some(name => !/^[a-z][a-z0-9.-]*$/u.test(name) || name === "manifest.json")
      || JSON.stringify(readdirSync(reference.managedDirectory).sort()) !== JSON.stringify([...names, "manifest.json"].sort())) fail("build-integrity");
  for (const name of names) {
    const member = path.join(reference.managedDirectory, name);
    regular(member);
    if (!SHA.test(manifest.files[name] ?? "") || !ctx.isPrivate(member) || hash(readFileSync(member)) !== manifest.files[name]) fail("build-integrity");
  }
  return manifest;
}

function currentReceipt(ctx, observations) {
  const value = read(ctx, ctx.receiptPath, observations);
  if (value.owner !== OWNER || value.version !== 1 || value.state !== "installed") fail("inactive-ownership");
  const reference = identity(ctx, value);
  verify(ctx, reference);
  return { receipt: value, reference };
}

function loadRetention(ctx, file) {
  if (!present(ctx, file)) return { owner: RETENTION_OWNER, version: 1, current: null, previous: null, builds: [], hostPins: [] };
  const value = read(ctx, file);
  if (value.owner !== RETENTION_OWNER || value.version !== 1 || !Array.isArray(value.builds)) fail("invalid-retention");
  const builds = value.builds.map(item => identity(ctx, item));
  if (new Set(builds.map(key)).size !== builds.length) fail("invalid-retention");
  const current = value.current === null ? null : identity(ctx, value.current);
  const previous = value.previous === null ? null : identity(ctx, value.previous);
  if ([current, previous].some(item => item && !builds.some(build => JSON.stringify(build) === JSON.stringify(item)))) fail("invalid-retention");
  const hostPins = value.hostPins ?? [];
  if (!Array.isArray(hostPins) || hostPins.some(pin => !object(pin) || typeof pin.unknown !== "boolean" || !Array.isArray(pin.hosts)
      || pin.hosts.some(host => !Number.isSafeInteger(host?.pid) || host.pid < 1 || !isProcessStartIdentity(host.identity))
      || !builds.some(build => JSON.stringify(build) === JSON.stringify(identity(ctx, pin.build))))
      || new Set(hostPins.map(pin => key(pin.build))).size !== hostPins.length) fail("invalid-retention");
  return { owner: RETENTION_OWNER, version: 1, current, previous, builds, hostPins };
}

function publishRetention(ctx, file, state) {
  const text = encode(state);
  if (present(ctx, file)) {
    regular(file);
    if (!ctx.isPrivate(file)) fail("unprotected-metadata");
    if (readFileSync(file, "utf8") === text) return;
  }
  ctx.write(file, text);
  if (!ctx.isPrivate(file) || readFileSync(file, "utf8") !== text) fail("retention-publication-failed");
}

/** Register a fully verified completed build under the existing ownership lock.
 * Staging does not rotate launch/recovery selections or reclaim any directory. */
export function recordWebStopAdapterBuild(ctx, value, { previous = null } = {}) {
  try {
    const reference = identity(ctx, value);
    const file = path.join(ctx.root, "build-retention.json"), state = loadRetention(ctx, file);
    const before = previousReference(ctx, previous);
    const unchanged = before && state.current && key(before) === key(reference) && key(state.current) === key(reference);
    const outgoing = [before, state.current].filter(build => build && key(build) !== key(reference));
    for (const build of [reference, ...outgoing]) {
      verify(ctx, build);
      const existing = state.builds.find(item => key(item) === key(build));
      if (existing && JSON.stringify(existing) !== JSON.stringify(build)) fail("conflicting-build-reference");
      if (!existing) state.builds.push(build);
      // Persist exposure custody before any global selection can change. Even a
      // reused candidate needs this pin again: an earlier host-free census does
      // not prove which hosts may observe this new activation attempt.
      if (key(build) === key(reference) && unchanged) continue;
      const pin = state.hostPins.find(item => key(item.build) === key(build));
      if (pin) pin.unknown = true;
      else state.hostPins.push({ build, hosts: [], unknown: true });
    }
    publishRetention(ctx, file, state);
    return { status: "recorded" };
  } catch (error) { return { status: "deferred", reason: error.cleanupReason ?? "build-registration-unavailable" }; }
}

function previousReference(ctx, previous) {
  if (previous === null) return null;
  if (previous?.owner !== OWNER || previous.version !== 1 || !["installed", "prepared", "removed"].includes(previous.state)) fail("invalid-previous-ownership");
  if (previous.state === "removed") return null;
  const reference = identity(ctx, previous); verify(ctx, reference); return reference;
}

function acceptedWeb(result) {
  const accepted = result?.acceptance;
  return result?.state === "completed" && result.succeeded === true && accepted?.version === 1 && accepted.accepted === true
    && accepted.scope === "installation-and-runtime-readiness" && accepted.liveWebVerification === "required-after-reopen"
    && /^[a-f0-9]{40}$/u.test(accepted.routerCommit ?? "") && object(accepted.finalAdapter);
}

function recoveryReferences(ctx, observations) {
  const deployments = path.join(ctx.stateDir, "deployments"), runtime = path.join(ctx.codexHome, "switchyard");
  const snapshots = [], operations = [], accepted = [];
  for (const name of listing(ctx, runtime, observations)) {
    if (!name.startsWith(".rollback-")) continue;
    if (!/^\.rollback-[a-f0-9]{32}$/u.test(name)) fail("invalid-recovery");
    snapshots.push(path.join(runtime, name));
  }
  for (const name of listing(ctx, deployments, observations)) {
    if (!OPERATION.test(name)) continue;
    const directory = path.join(deployments, name);
    regular(directory, true);
    const names = listing(ctx, directory, observations);
    if (names.includes("retained-runtime-recovery")) snapshots.push(path.join(directory, "retained-runtime-recovery"));
    if (!names.includes("result.json")) {
      if (names.includes("request.json")) operations.push({ id: name, result: null, directory });
      continue;
    }
    const resultPath = path.join(directory, "result.json"), result = read(ctx, resultPath, observations);
    if (result.state !== "completed") operations.push({ id: name, result, directory });
    if (acceptedWeb(result)) accepted.push({ result, resultPath });
  }
  const references = [];
  for (const directory of snapshots) {
    regular(directory, true);
    const names = listing(ctx, directory, observations), metadata = read(ctx, path.join(directory, "rollback.json"), observations);
    if (metadata.version !== 1 || !/^[a-f0-9]{40}$/u.test(metadata.previousRouterCommit ?? "")
        || typeof metadata.rollbackRouterRoot !== "string" || !path.isAbsolute(metadata.rollbackRouterRoot)
        || !Array.isArray(metadata.files) || metadata.files.some(name => !RUNTIME_FILES.includes(name))
        || new Set(metadata.files).size !== metadata.files.length
        || JSON.stringify(names) !== JSON.stringify([...metadata.files, "rollback.json"].sort())) fail("invalid-recovery");
    regular(metadata.rollbackRouterRoot, true);
    for (const name of metadata.files) regular(path.join(directory, name));
    if (Object.hasOwn(metadata, "webStopAdapter")) {
      if (metadata.webStopAdapter !== null) {
        const reference = identity(ctx, metadata.webStopAdapter); verify(ctx, reference); references.push(reference);
      }
      continue;
    }
    const matches = accepted.filter(({ result }) => result.acceptance.routerCommit === metadata.previousRouterCommit);
    if (!matches.length) fail("unresolved-legacy-recovery");
    // Multiple accepted final adapters for the same source are all protected.
    // One malformed match makes the mapping uncertain; never guess by age.
    for (const { result } of matches) {
      const reference = identity(ctx, result.acceptance.finalAdapter, { legacy: true });
      verify(ctx, reference); references.push(reference);
    }
  }
  return { references, operations };
}

function within(value, directory) {
  const text = normalize(value), root = normalize(directory);
  return text === root || text.startsWith(`${root}/`);
}

function commandMentions(command, directory) {
  const text = command.toLowerCase().replaceAll("\\", "/"), root = normalize(directory);
  let position = text.indexOf(root);
  while (position !== -1) {
    const before = text[position - 1], after = text[position + root.length];
    if ((before === undefined || /[\s"'=]/u.test(before)) && (after === undefined || /[\/\s"']/u.test(after))) return true;
    position = text.indexOf(root, position + 1);
  }
  return false;
}

function processProof(ctx, builds) {
  const census = ctx.readProcessCensus({ roots: [ctx.root] });
  if (census?.complete !== true || !Array.isArray(census.processes)) fail("incomplete-process-census");
  const rows = census.processes, seen = new Set(), protectedBuilds = new Set();
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.pid) || row.pid < 0 || seen.has(row.pid) || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0
        || typeof row.name !== "string" || !row.name || !["alive", "absent", "unknown"].includes(row.probeState)
        || row.commandLine != null && typeof row.commandLine !== "string" || row.identity != null && !isProcessStartIdentity(row.identity)
        || row.executablePath != null && (typeof row.executablePath !== "string" || !path.isAbsolute(row.executablePath))) fail("incomplete-process-census");
    seen.add(row.pid);
    if (row.probeState === "absent") continue;
    if (registeredSystemSandboxBroker(row, rows)) continue;
    const named = /^(?:entry|node|node_repl|codex(?:[-_].*)?|chatgpt|powershell|pwsh|cmd)(?:\.exe)?$/iu.test(row.name);
    const image = row.executablePath ?? row.identity?.split("|")[1];
    const matched = builds.filter(build => image && within(image, build.managedDirectory)
      || row.commandLine && commandMentions(row.commandLine, build.managedDirectory));
    if ((named || matched.length) && (row.probeState !== "alive" || !isProcessStartIdentity(row.identity)
        || !image || !row.commandLine || normalize(image) !== normalize(row.identity.split("|")[1]))) fail("uncertain-process-identity");
    for (const build of matched) protectedBuilds.add(key(build));
  }
  // Keep ancestry from the full census: an exited launcher may still have live
  // children. Its observed path remains useful, but never proves an exit itself.
  for (const row of rows.filter(item => item.probeState !== "absent")) {
    const visited = new Set();
    for (let parent = rows.find(item => item.pid === row.parentPid); parent && !visited.has(parent.pid); parent = rows.find(item => item.pid === parent.parentPid)) {
      visited.add(parent.pid);
      const image = parent.executablePath ?? parent.identity?.split("|")[1];
      for (const build of builds) if (image && within(image, build.managedDirectory)
          || parent.commandLine && commandMentions(parent.commandLine, build.managedDirectory)) protectedBuilds.add(key(build));
    }
  }
  return { rows, protectedBuilds };
}

const nativeHost = row => /^(?:codex|chatgpt)(?:\.exe)?$/iu.test(row.name) && row.probeState !== "absent";

function cachedHostPins(ctx, builds, transitions, previousPins, uncertainTransitions = []) {
  const hostPins = structuredClone(previousPins);
  if (!transitions.length) return hostPins;
  let hosts = [], unknown = false;
  try {
    const proof = processProof(ctx, builds);
    hosts = proof.rows.filter(nativeHost).map(({ pid, identity }) => ({ pid, identity }));
  } catch { unknown = true; }
  for (const transition of transitions) {
    const uncertain = unknown || uncertainTransitions.some(item => key(item) === key(transition));
    const pin = hostPins.find(item => key(item.build) === key(transition));
    if (pin) {
      pin.unknown ||= uncertain;
      for (const host of hosts) if (!pin.hosts.some(item => item.pid === host.pid && item.identity === host.identity)) pin.hosts.push(host);
    } else hostPins.push({ build: transition, hosts: structuredClone(hosts), unknown: uncertain });
  }
  return hostPins;
}

function hostOwnsBuild(state, build, rows) {
  const pin = state.hostPins.find(item => key(item.build) === key(build));
  if (!pin) return false;
  const hosts = rows.filter(nativeHost);
  if (pin.unknown && hosts.length) return true;
  return pin.hosts.some(host => hosts.some(row => row.pid === host.pid && row.identity === host.identity));
}

function assertOperations(ctx, operations, rows) {
  for (const operation of operations) {
    if (operation.id !== ctx.cleanupOperationId || operation.result?.state !== "running"
        || !Number.isSafeInteger(operation.result.processId)) fail("pending-deployment");
    const chain = [], visited = new Set();
    for (let row = rows.find(item => item.pid === process.pid); row && !visited.has(row.pid); row = rows.find(item => item.pid === row.parentPid)) {
      visited.add(row.pid); chain.push(row);
      if (row.pid === operation.result.processId) break;
    }
    if (!chain.length || chain.at(-1).pid !== operation.result.processId) fail("pending-deployment");
    for (let index = 0; index < chain.length; index++) {
      const row = chain[index];
      if (row.probeState !== "alive" || !isProcessStartIdentity(row.identity) || !row.executablePath || !row.commandLine
          || normalize(row.executablePath) !== normalize(row.identity.split("|")[1])
          || index > 0 && BigInt(row.identity.split("|")[0]) > BigInt(chain[index - 1].identity.split("|")[0])) fail("pending-deployment");
    }
    const owner = chain.at(-1);
    if (!/^(?:powershell|pwsh)(?:\.exe)?$/iu.test(owner.name)
        || !commandMentions(owner.commandLine, path.join(operation.directory, "request.json"))) fail("pending-deployment");
  }
}

function selections(ctx, receipts, builds) {
  const values = [process.env, ctx.environment.readPair(), ...receipts.flatMap(receipt => receipt
    ? [receipt.environment, receipt.previousEnvironment, receipt.priorEnvironment] : [])];
  const protectedBuilds = new Set();
  for (const value of values) {
    if (!object(value)) fail("uncertain-launch-selection");
    for (const name of ["CODEX_CLI_PATH", "CODEX_NODE_REPL_PATH"]) {
      const selected = value[name];
      if (selected == null) continue;
      if (typeof selected !== "string") fail("uncertain-launch-selection");
      for (const build of builds) if (commandMentions(selected, build.managedDirectory)) protectedBuilds.add(key(build));
    }
  }
  return protectedBuilds;
}

/** Called only after successful activation, while the adapter ownership lock is held. */
export function cleanupWebStopAdapterBuilds(ctx, { previous = null } = {}) {
  const removed = [], rejected = [], retentionPath = path.join(ctx.root, "build-retention.json");
  let physical = [], state;
  const result = (status, reason) => ({ status, removed, retained: physical.filter(name => !removed.includes(name)),
    ...(reason ? { reason } : {}), ...(rejected.length ? { rejected } : {}) });
  try {
    physical = listing(ctx, ctx.root).filter(name => BUILD.test(name));
    const { receipt, reference: current } = currentReceipt(ctx), retained = loadRetention(ctx, retentionPath);
    const before = previousReference(ctx, previous);
    const prior = before && key(before) !== key(current) ? before
      : retained.current && key(retained.current) !== key(current) ? retained.current : retained.previous;
    const known = new Map(retained.builds.map(build => [key(build), build]));
    for (const build of [current, before, prior, retained.current].filter(Boolean)) {
      if (key(build) !== key(current)) verify(ctx, build);
      if (known.has(key(build)) && JSON.stringify(known.get(key(build))) !== JSON.stringify(build)) fail("conflicting-build-reference");
      known.set(key(build), build);
    }
    const transitions = [...new Map([before, retained.current].filter(build => build && key(build) !== key(current)).map(build => [key(build), build])).values()];
    const interrupted = retained.current && key(retained.current) !== key(current) && before && key(retained.current) !== key(before) ? [retained.current] : [];
    state = { owner: RETENTION_OWNER, version: 1, current, previous: prior, builds: [...known.values()],
      hostPins: cachedHostPins(ctx, [...known.values()], transitions, retained.hostPins, interrupted).filter(pin => key(pin.build) !== key(current)) };
    // Register the successful transition even if process/recovery proof later
    // defers reclamation. Failed activation never invokes this function.
    const publish = () => publishRetention(ctx, retentionPath, state);
    publish();
    const observations = [], initial = recoveryReferences(ctx, observations);
    for (const reference of initial.references) {
      if (known.has(key(reference)) && JSON.stringify(known.get(key(reference))) !== JSON.stringify(reference)) fail("conflicting-build-reference");
      if (!known.has(key(reference))) state.hostPins.push({ build: reference, hosts: [], unknown: true });
      known.set(key(reference), reference);
    }
    state.builds = [...known.values()]; publish();
    const fingerprint = JSON.stringify(observations), ownedText = readFileSync(ctx.receiptPath, "utf8");
    const protectedRefs = new Set([current, prior, before, ...initial.references].filter(Boolean).map(key));
    const initialProof = processProof(ctx, state.builds); assertOperations(ctx, initial.operations, initialProof.rows);
    const liveHosts = initialProof.rows.filter(nativeHost);
    for (const pin of state.hostPins) {
      if (pin.unknown && !liveHosts.length) pin.unknown = false;
      pin.hosts = pin.hosts.filter(host => liveHosts.some(row => row.pid === host.pid && row.identity === host.identity));
    }
    publish();
    for (const build of [...state.builds]) {
      if (protectedRefs.has(key(build))) continue;
      try {
        const currentObservations = [], recovery = recoveryReferences(ctx, currentObservations);
        if (JSON.stringify(currentObservations) !== fingerprint || readFileSync(ctx.receiptPath, "utf8") !== ownedText
            || readFileSync(retentionPath, "utf8") !== encode(state)) fail("metadata-changed");
        const proof = processProof(ctx, state.builds); assertOperations(ctx, recovery.operations, proof.rows);
        const selected = selections(ctx, [receipt, previous], state.builds);
        if (proof.protectedBuilds.has(key(build)) || selected.has(key(build)) || hostOwnsBuild(state, build, proof.rows)) continue;
        verify(ctx, build);
        const finalObservations = [];
        recoveryReferences(ctx, finalObservations);
        if (JSON.stringify(finalObservations) !== fingerprint || readFileSync(ctx.receiptPath, "utf8") !== ownedText
            || readFileSync(retentionPath, "utf8") !== encode(state)) fail("metadata-changed");
        // The checked path is an exact direct child with a fully enumerated,
        // protected manifest membership; unknown/partial directories never enter.
        (ctx.removeDirectory ?? (directory => rmSync(directory, { recursive: true })))(build.managedDirectory);
        if (present(ctx, build.managedDirectory)) fail("removal-failed");
        removed.push(path.basename(build.managedDirectory));
        state.builds = state.builds.filter(item => key(item) !== key(build));
        state.hostPins = state.hostPins.filter(pin => key(pin.build) !== key(build)); publish();
      } catch (error) {
        const reason = error.cleanupReason ?? "build-cleanup-failed";
        if (["metadata-changed", "pending-deployment", "incomplete-process-census", "uncertain-process-identity", "uncertain-path-presence"].includes(reason)) return result("deferred", reason);
        rejected.push({ build: path.basename(build.managedDirectory), reason });
      }
    }
    return result("completed");
  } catch (error) { return result("deferred", error.cleanupReason ?? "cleanup-unavailable"); }
}
