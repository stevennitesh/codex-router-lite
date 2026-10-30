import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupWebStopAdapterBuilds, recordWebStopAdapterBuild } from "../src/web-stop-adapter-cleanup.mjs";

const OWNER = "codex-router-web-stop-adapter-v1";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const pair = entry => ({ CODEX_CLI_PATH: null, CODEX_NODE_REPL_PATH: entry });

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-adapter-cleanup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, "state"), codexHome = path.join(directory, "codex"), root = path.join(stateDir, "web-stop-adapter");
  mkdirSync(root, { recursive: true }); mkdirSync(codexHome);
  mkdirSync(path.join(directory, "retained-checkout"));
  const receiptPath = path.join(root, "ownership.json");
  const f = { directory, root, stateDir, codexHome, receiptPath, rows: [], writes: [], current: null };
  f.ctx = { root, stateDir, codexHome, receiptPath, isPrivate: () => true,
    environment: { readPair: () => pair(f.current?.entryPath ?? null) },
    write(file, bytes) { f.writes.push(file); writeFileSync(file, bytes); },
    readProcessCensus: ({ roots }) => { assert.deepEqual(roots, [root]); return { complete: true, processes: f.rows }; },
    verifyManaged(receipt) {
      assert.equal(receipt.configPath, path.join(receipt.managedDirectory, "config.json"));
      assert.equal(receipt.entryPath, path.join(receipt.managedDirectory, "entry.exe"));
      return JSON.parse(readFileSync(path.join(receipt.managedDirectory, "manifest.json"), "utf8"));
    } };
  f.build = (number, suffix = "") => {
    const generation = number.toString(16).padStart(64, "0"), managedDirectory = path.join(root, generation + suffix);
    mkdirSync(managedDirectory);
    const files = { "entry.exe": "entry", "entry.cs": "source", "config.json": "{}", "web-stop-adapter.mjs": "export {};" };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(managedDirectory, name), bytes);
    const manifest = { owner: OWNER, version: 1, generation, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) };
    const bytes = encode(manifest); writeFileSync(path.join(managedDirectory, "manifest.json"), bytes);
    return { generation, managedDirectory, managedManifestSha256: hash(bytes) };
  };
  f.activate = build => {
    const previous = f.current;
    f.current = { ...build, owner: OWNER, version: 1, state: "installed", entryPath: path.join(build.managedDirectory, "entry.exe"),
      configPath: path.join(build.managedDirectory, "config.json"), environment: pair(path.join(build.managedDirectory, "entry.exe")),
      previousEnvironment: pair(null), priorEnvironment: pair(null) };
    writeFileSync(receiptPath, encode(f.current));
    return previous;
  };
  f.cleanup = previous => cleanupWebStopAdapterBuilds(f.ctx, { previous });
  f.install = build => f.cleanup(f.activate(build));
  f.index = () => JSON.parse(readFileSync(path.join(root, "build-retention.json"), "utf8"));
  f.operation = (number, result) => {
    const operation = path.join(stateDir, "deployments", number.toString(16).padStart(32, "0"));
    mkdirSync(operation, { recursive: true }); writeFileSync(path.join(operation, "result.json"), encode(result));
    return operation;
  };
  f.snapshot = (directory, commit, adapter, { legacy = false } = {}) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "routes.toml"), "snapshot");
    writeFileSync(path.join(directory, "rollback.json"), encode({ version: 1, previousRouterCommit: commit,
      rollbackRouterRoot: path.join(f.directory, "retained-checkout"), files: ["routes.toml"], ...(legacy ? {} : { webStopAdapter: adapter }) }));
    return directory;
  };
  f.accepted = (number, commit, adapter) => f.operation(number, { state: "completed", succeeded: true, acceptance: {
    version: 1, accepted: true, routerCommit: commit, scope: "installation-and-runtime-readiness", liveWebVerification: "required-after-reopen", finalAdapter: adapter } });
  return f;
}

function processRow(f, pid, name, image, commandLine = `"${image}"`, ticks = String(10000 + pid), parentPid = 0) {
  return { pid, parentPid, name, executablePath: image, commandLine, identity: `${ticks}|${image}`, probeState: "alive" };
}

test("successful transitions reclaim known old builds, keep active/previous and preserve unknown partial builds", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2, "-aBc12Z"), c = f.build(3), unknown = f.build(99);
  const partial = path.join(f.root, "a".repeat(64)); mkdirSync(partial); writeFileSync(path.join(partial, "entry.exe"), "interrupted");
  f.install(a); f.install(b);
  const result = f.install(c);
  assert.equal(result.status, "completed"); assert.deepEqual(result.removed, [path.basename(a.managedDirectory)]);
  for (const build of [b, c, unknown]) assert.equal(existsSync(build.managedDirectory), true);
  assert.equal(existsSync(partial), true);
  assert.deepEqual(f.index().builds, [b, c]);
  const writes = f.writes.length;
  const unchanged = f.install(c);
  assert.deepEqual(unchanged.removed, []); assert.equal(f.writes.length, writes, "unchanged cleanup does not rewrite durable state");
  assert.deepEqual(f.index().previous, b, "reinstall keeps the immediate previous generation");
});

test("both physical rollback sets protect explicit exact references and release them when removed", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3), d = f.build(4);
  f.install(a); f.install(b);
  const direct = f.snapshot(path.join(f.codexHome, "switchyard", `.rollback-${"1".repeat(32)}`), "a".repeat(40), a);
  const operation = f.operation(2, { state: "completed", succeeded: true });
  const archived = f.snapshot(path.join(operation, "retained-runtime-recovery"), "b".repeat(40), b);
  f.install(c); const result = f.install(d);
  assert.deepEqual(result.removed, []);
  assert.equal(existsSync(a.managedDirectory), true); assert.equal(existsSync(b.managedDirectory), true);
  rmSync(direct, { recursive: true }); rmSync(archived, { recursive: true });
  const released = f.install(d);
  assert.deepEqual(released.removed.sort(), [a, b].map(build => path.basename(build.managedDirectory)).sort());
});

test("legacy recovery maps only matching accepted Web commits and adopts selected builds fully", t => {
  const f = fixture(t), rollback = f.build(1), unrelated = f.build(99), current = f.build(2), newer = f.build(3);
  const legacyIdentity = { generation: rollback.generation, managedDirectory: rollback.managedDirectory };
  f.accepted(10, "a".repeat(40), legacyIdentity);
  f.accepted(11, "b".repeat(40), unrelated);
  const direct = f.snapshot(path.join(f.codexHome, "switchyard", `.rollback-${"a".repeat(32)}`), "a".repeat(40), null, { legacy: true });
  assert.equal(f.install(current).status, "completed"); f.install(newer);
  assert.equal(f.index().builds.some(build => build.managedDirectory === rollback.managedDirectory), true);
  assert.equal(f.index().builds.some(build => build.managedDirectory === unrelated.managedDirectory), false);
  rmSync(direct, { recursive: true });
  assert.deepEqual(f.install(newer).removed, [path.basename(rollback.managedDirectory)]);
  assert.equal(existsSync(unrelated.managedDirectory), true, "historical receipt is not general cleanup authority");
});

test("unmapped legacy or corrupt physical recovery conservatively defers after recording success", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  const direct = f.snapshot(path.join(f.codexHome, "switchyard", `.rollback-${"a".repeat(32)}`), "a".repeat(40), null, { legacy: true });
  assert.equal(f.install(c).reason, "unresolved-legacy-recovery"); assert.deepEqual(f.index().current, c);
  writeFileSync(path.join(direct, "foreign.txt"), "keep");
  assert.equal(f.install(c).reason, "invalid-recovery"); assert.equal(existsSync(a.managedDirectory), true);
});

test("all matching valid legacy final adapters are protected; invalid matching reference defers", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), current = f.build(3);
  f.accepted(10, "a".repeat(40), a); f.accepted(11, "a".repeat(40), b);
  f.snapshot(path.join(f.codexHome, "switchyard", `.rollback-${"a".repeat(32)}`), "a".repeat(40), null, { legacy: true });
  assert.equal(f.install(current).status, "completed");
  assert.equal(f.index().builds.length, 3);
  f.accepted(12, "a".repeat(40), { ...b, managedDirectory: f.directory });
  assert.equal(f.install(current).reason, "invalid-build-reference");
});

test("live adapter/bridge processes and descendants of an exited launcher protect old generations", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  const image = path.join(a.managedDirectory, "entry.exe");
  f.rows = [processRow(f, 21, "entry.exe", image)];
  assert.deepEqual(f.install(c).removed, []);
  f.rows = [{ ...f.rows[0], probeState: "absent" }, processRow(f, 22, "node_repl.exe", path.join(f.directory, "node_repl.exe"), "official child", "10022", 21)];
  assert.deepEqual(f.install(c).removed, []);
  f.rows = [];
  assert.deepEqual(f.install(c).removed, [path.basename(a.managedDirectory)]);
});

test("command references respect directory boundaries and current/prior/baseline selections", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  const node = path.join(f.directory, "node.exe");
  f.rows = [processRow(f, 30, "node.exe", node, `node "${path.join(a.managedDirectory, "web-stop-adapter.mjs")}"`)];
  assert.deepEqual(f.install(c).removed, []);
  f.rows = [processRow(f, 30, "node.exe", node, `node "${a.managedDirectory}-other/foreign.mjs"`)];
  f.current.previousEnvironment = pair(path.join(a.managedDirectory, "entry.exe")); writeFileSync(f.receiptPath, encode(f.current));
  assert.deepEqual(f.cleanup(f.current).removed, []);
  f.current.previousEnvironment = pair(null); writeFileSync(f.receiptPath, encode(f.current));
  assert.deepEqual(f.cleanup(f.current).removed, [path.basename(a.managedDirectory)]);
});

test("incomplete or denied relevant process identities defer without leaking command lines", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  f.rows = [{ pid: 30, parentPid: 0, name: "powershell.exe", probeState: "unknown", commandLine: "private secret command", identity: null, executablePath: null }];
  const result = f.install(c);
  assert.equal(result.reason, "uncertain-process-identity"); assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(existsSync(a.managedDirectory), true); assert.deepEqual(f.index().current, c);
  f.ctx.readProcessCensus = () => ({ complete: false, processes: [] });
  assert.equal(f.install(c).reason, "incomplete-process-census");
});

test("native host lifetime pins protect cached launch selection and release on exact generation exit", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3), image = path.join(f.directory, "Codex.exe");
  f.install(a);
  f.rows = [processRow(f, 50, "Codex.exe", image, "Codex desktop", "10500")];
  f.install(b); assert.deepEqual(f.install(c).removed, []);
  assert.equal(f.index().hostPins.find(pin => pin.build.managedDirectory === a.managedDirectory).hosts[0].identity, `10500|${image}`);
  f.rows = [processRow(f, 50, "Codex.exe", image, "new desktop generation", "20500")];
  assert.deepEqual(f.install(c).removed, [path.basename(a.managedDirectory)], "new unrelated host does not extend an exited host pin");
});

test("unavailable transition census preserves unknown cached hosts until a complete host-free census", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3), image = path.join(f.directory, "Codex.exe");
  f.install(a);
  const census = f.ctx.readProcessCensus; f.ctx.readProcessCensus = () => { throw new Error("private failure"); };
  assert.equal(f.install(b).status, "deferred");
  assert.equal(f.index().hostPins[0].unknown, true);
  f.ctx.readProcessCensus = census; f.rows = [processRow(f, 50, "Codex.exe", image)];
  assert.deepEqual(f.install(c).removed, []);
  f.rows = []; assert.deepEqual(f.install(c).removed, [path.basename(a.managedDirectory)]);
});

test("foreign files, corrupt manifests and path reparses never become deletion authority", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  writeFileSync(path.join(a.managedDirectory, "foreign.txt"), "private evidence");
  assert.equal(f.install(c).rejected[0].reason, "build-integrity"); assert.equal(existsSync(a.managedDirectory), true);
  rmSync(path.join(a.managedDirectory, "foreign.txt")); writeFileSync(path.join(a.managedDirectory, "entry.exe"), "corrupt");
  assert.equal(f.install(c).rejected[0].reason, "build-integrity");
  const retained = path.join(f.directory, "retained"), candidate = a.managedDirectory;
  renameSync(candidate, retained);
  try { symlinkSync(retained, candidate, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.diagnostic("Host does not permit junction/symlink fixture"); return; } throw error; }
  assert.equal(f.install(c).rejected[0].reason, "unsafe-path"); assert.equal(existsSync(path.join(retained, "entry.exe")), true);
});

test("corrupt or unprotected retention and failed publication defer without deleting any build", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  const file = path.join(f.root, "build-retention.json"), original = readFileSync(file);
  writeFileSync(file, '{"owner":"foreign","version":1,"builds":[]}');
  assert.equal(f.install(c).reason, "invalid-retention"); assert.equal(existsSync(a.managedDirectory), true);
  writeFileSync(file, original); const write = f.ctx.write;
  f.ctx.write = () => { throw new Error("private publication failure"); };
  assert.equal(f.install(c).status, "deferred"); assert.equal(existsSync(a.managedDirectory), true);
  f.ctx.write = write; f.ctx.isPrivate = target => target !== file;
  assert.equal(f.install(c).reason, "unprotected-metadata");
});

test("removal failure remains sanitized and does not turn successful activation into rollback", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  f.ctx.removeDirectory = () => { throw new Error("secret path and process payload"); };
  const result = f.install(c);
  assert.equal(result.status, "completed"); assert.equal(result.rejected[0].reason, "build-cleanup-failed");
  assert.equal(JSON.stringify(result).includes("secret"), false); assert.deepEqual(f.index().current, c);
  assert.equal(existsSync(a.managedDirectory), true);
});

test("rollback snapshot relocation or receipt edits between selection and removal defer", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  const operation = f.operation(10, { state: "completed", succeeded: true });
  const direct = f.snapshot(path.join(f.codexHome, "switchyard", `.rollback-${"a".repeat(32)}`), "a".repeat(40), null);
  const verify = f.ctx.verifyManaged; let moved = false;
  f.ctx.verifyManaged = receipt => {
    const manifest = verify(receipt);
    if (receipt.managedDirectory === a.managedDirectory && !moved) {
      moved = true; renameSync(direct, path.join(operation, "retained-runtime-recovery"));
    }
    return manifest;
  };
  assert.equal(f.install(c).reason, "metadata-changed"); assert.equal(existsSync(a.managedDirectory), true);
});

test("pending deployment blocks GC unless an exact native ancestor owns this operation", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  const operation = f.operation(10, { state: "running", processId: 400 }), image = path.join(f.directory, "powershell.exe");
  f.ctx.cleanupOperationId = path.basename(operation);
  f.rows = [processRow(f, process.pid, "node.exe", process.execPath, "node installer", "30000", 400),
    processRow(f, 400, "powershell.exe", image, `powershell -RequestPath "${path.join(operation, "request.json")}"`, "20000")];
  assert.deepEqual(f.install(c).removed, [path.basename(a.managedDirectory)]);
  const d = f.build(4); f.rows[1].identity = `40000|${image}`;
  assert.equal(f.install(d).reason, "pending-deployment", "a reused parent PID cannot grant cleanup authority");
  assert.equal(existsSync(b.managedDirectory), true);
  f.rows[1].identity = `20000|${image}`;
  f.operation(11, { state: "starting" });
  assert.equal(f.install(d).reason, "pending-deployment", "another pending operation is never exempted");
});

test("completed staging is recorded without rotating retention and may be reclaimed after failed activation", t => {
  const f = fixture(t), a = f.build(1), failed = f.build(2, "-AbC123"), b = f.build(3);
  assert.deepEqual(recordWebStopAdapterBuild(f.ctx, a), { status: "recorded" });
  assert.equal(f.index().current, null); assert.equal(f.index().previous, null);
  f.install(a); const before = f.index();
  assert.deepEqual(recordWebStopAdapterBuild(f.ctx, failed), { status: "recorded" });
  assert.deepEqual(f.index().current, before.current); assert.deepEqual(f.index().previous, before.previous);
  assert.equal(f.index().hostPins.find(pin => pin.build.managedDirectory === a.managedDirectory).unknown, true,
    "the outgoing indexed selection receives custody before attempted activation");
  assert.equal(f.index().hostPins.find(pin => pin.build.managedDirectory === failed.managedDirectory).unknown, true);
  // Activation failed before success/cleanup: retained directory and active
  // selection remain unchanged, and the next successful transaction owns GC.
  assert.equal(existsSync(failed.managedDirectory), true);
  assert.deepEqual(f.install(b).removed, [path.basename(failed.managedDirectory)]);
  assert.equal(existsSync(a.managedDirectory), true); assert.equal(existsSync(b.managedDirectory), true);
  const corrupt = f.build(4); writeFileSync(path.join(corrupt.managedDirectory, "entry.exe"), "corruption");
  assert.equal(recordWebStopAdapterBuild(f.ctx, corrupt).reason, "build-integrity");
  assert.equal(f.index().builds.some(build => build.managedDirectory === corrupt.managedDirectory), false);
});

test("an unselected failed candidate remains protected from a later host's cached launch selection", t => {
  const f = fixture(t), a = f.build(1), failed = f.build(2), b = f.build(3); f.install(a);
  recordWebStopAdapterBuild(f.ctx, failed);
  // This host started after staging and could have seen a briefly published
  // failed activation. No currently running kernel needs to name that build.
  f.rows = [processRow(f, 600, "Codex.exe", path.join(f.directory, "Codex.exe"), "desktop")];
  assert.deepEqual(f.install(b).removed, []);
  assert.equal(existsSync(failed.managedDirectory), true);
  f.rows = [];
  assert.deepEqual(f.install(b).removed, [path.basename(failed.managedDirectory)]);
});

test("ordinary UTF-8 BOM metadata remains valid; missing rollback source remains protected uncertainty", t => {
  const f = fixture(t), a = f.build(1), current = f.build(2);
  const operation = f.accepted(10, "a".repeat(40), a);
  const snapshot = f.snapshot(path.join(f.codexHome, "switchyard", `.rollback-${"a".repeat(32)}`), "a".repeat(40), null, { legacy: true });
  for (const file of [path.join(operation, "result.json"), path.join(snapshot, "rollback.json")]) {
    writeFileSync(file, `\uFEFF${readFileSync(file, "utf8")}`);
  }
  assert.equal(f.install(current).status, "completed");
  rmSync(path.join(f.directory, "retained-checkout"), { recursive: true });
  assert.equal(f.install(current).status, "deferred"); assert.equal(existsSync(a.managedDirectory), true);
});

test("known unrelated native rows and the positively registered sandbox broker do not block cleanup", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
  const packageName = "OpenAI.Codex_1.2.3_x64__abcdefgh", image = path.join(f.directory, "WindowsApps", packageName, "app", "resources", "codex-windows-sandbox-service.exe");
  f.rows = [
    { pid: 0, parentPid: 0, name: "System Idle Process", probeState: "unknown", identity: null, executablePath: null, commandLine: null },
    { pid: 400, parentPid: 0, name: "services.exe", sessionId: 0, probeState: "unknown", identity: null, executablePath: null, commandLine: null },
    { pid: 500, parentPid: 400, name: "codex-windows-sandbox-service.exe", sessionId: 0, probeState: "unknown", identity: null, executablePath: image, commandLine: null,
      service: { name: "CodexSandboxService.OpenAI.Codex", processId: 500, state: "Running", startName: "LocalSystem", registryAccount: "LocalSystem", registryType: 16,
        packageFullName: packageName, configuredImagePath: `"${image}"`, registeredImagePath: `"${image}"` } },
  ];
  assert.deepEqual(f.install(c).removed, [path.basename(a.managedDirectory)]);
  const d = f.build(4); f.rows[2].service.registryAccount = "unverified";
  assert.equal(f.install(d).reason, "uncertain-process-identity");
});

test("preactivation custody survives selection success followed by a crash before cleanup", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3), d = f.build(4);
  f.install(a); f.install(b);
  f.rows = [processRow(f, 700, "Codex.exe", path.join(f.directory, "Codex.exe"), "desktop cached B")];
  const beforeB = structuredClone(f.current);
  assert.equal(recordWebStopAdapterBuild(f.ctx, c, { previous: beforeB }).status, "recorded");
  assert.equal(f.index().hostPins.find(pin => pin.build.managedDirectory === b.managedDirectory).unknown, true);
  f.activate(c); // Successful selection, then process crash before cleanup.
  assert.deepEqual(f.index().current, b, "the crashed install never completed index rotation");
  assert.equal(recordWebStopAdapterBuild(f.ctx, d, { previous: f.current }).status, "recorded");
  const result = f.install(d);
  assert.equal(result.status, "completed"); assert.equal(existsSync(b.managedDirectory), true);
  assert.deepEqual(f.index().previous, c);
  f.rows = [];
  assert.equal(f.install(d).removed.includes(path.basename(b.managedDirectory)), true);
});

test("legacy stale current is protected independently from the immediate previous receipt", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3), d = f.build(4);
  f.install(a); f.install(b);
  f.rows = [processRow(f, 700, "Codex.exe", path.join(f.directory, "Codex.exe"), "desktop cached B")];
  f.activate(c); // Legacy/interrupted installer had no preactivation custody.
  assert.equal(f.install(d).status, "completed");
  assert.equal(existsSync(b.managedDirectory), true);
  assert.equal(f.index().hostPins.find(pin => pin.build.managedDirectory === b.managedDirectory).unknown, true);
  f.rows = [];
  assert.equal(f.install(d).removed.includes(path.basename(b.managedDirectory)), true);
});

test("reused known candidates renew candidate and both outgoing exposure custody", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a);
  recordWebStopAdapterBuild(f.ctx, b, { previous: f.current });
  f.activate(b); // Crash leaves index.current A.
  const prepared = { ...f.current, state: "prepared" };
  assert.equal(recordWebStopAdapterBuild(f.ctx, a, { previous: prepared }).status, "recorded");
  for (const build of [a, b]) assert.equal(f.index().hostPins.find(pin => pin.build.managedDirectory === build.managedDirectory).unknown, true);
  f.activate(a); // Another crash, then C replaces A while a host caches B.
  f.rows = [processRow(f, 701, "Codex.exe", path.join(f.directory, "Codex.exe"), "cached B")];
  assert.equal(f.install(c).status, "completed"); assert.equal(existsSync(b.managedDirectory), true);
  f.rows = []; assert.equal(f.install(c).removed.includes(path.basename(b.managedDirectory)), true);
});

test("custody cannot publish when either supplied outgoing reference fails full verification", t => {
  const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a);
  const oldIndex = readFileSync(path.join(f.root, "build-retention.json"), "utf8");
  writeFileSync(path.join(a.managedDirectory, "entry.exe"), "foreign modified outgoing build");
  assert.equal(recordWebStopAdapterBuild(f.ctx, b, { previous: f.current }).reason, "build-integrity");
  assert.equal(readFileSync(path.join(f.root, "build-retention.json"), "utf8"), oldIndex);
  assert.equal(recordWebStopAdapterBuild(f.ctx, c, { previous: { ...f.current, owner: "foreign" } }).reason, "invalid-previous-ownership");
});

test("denied or non-directory recovery/retention presence is uncertainty rather than absence", t => {
  for (const code of ["EACCES", "EPERM", "ENOTDIR"]) for (const location of ["switchyard", "deployments", "retention"]) {
    const f = fixture(t), a = f.build(1), b = f.build(2), c = f.build(3); f.install(a); f.install(b);
    const previous = f.activate(c), target = location === "retention" ? path.join(f.root, "build-retention.json")
      : location === "switchyard" ? path.join(f.codexHome, "switchyard") : path.join(f.stateDir, "deployments");
    const indexBefore = readFileSync(path.join(f.root, "build-retention.json"), "utf8"), writes = f.writes.length;
    f.ctx.probePath = file => {
      if (file === target) throw Object.assign(new Error("private filesystem failure"), { code });
      return lstatSync(file);
    };
    const result = f.cleanup(previous);
    assert.equal(result.reason, "uncertain-path-presence", `${location}/${code}`);
    assert.deepEqual(result.removed, []); assert.equal(existsSync(a.managedDirectory), true);
    if (location === "retention") {
      assert.equal(readFileSync(target, "utf8"), indexBefore); assert.equal(f.writes.length, writes);
      assert.equal(recordWebStopAdapterBuild(f.ctx, c, { previous }).reason, "uncertain-path-presence");
    }
  }
});
