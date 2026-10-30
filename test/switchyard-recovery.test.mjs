import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishUnderlyingDeploymentAcceptance } from "../maintenance/web-runtime-maintenance.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runtimeFiles = ["switchyard-server.exe", "routes.toml", "SOURCE_COMMIT", "provenance.json"];
const currentCommit = "a".repeat(40), previousCommit = "b".repeat(40);
const sha = text => createHash("sha256").update(text).digest("hex");
const windows = { skip: process.platform !== "win32" };

function fixture({ unicodePaths = false } = {}) {
  // The real PowerShell deployment records expanded paths. Match that producer
  // when CI supplies a Windows 8.3 temporary-directory alias.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), unicodePaths ? "switchyard-recovery-\u00e9-" : "switchyard-recovery-")));
  const runtime = path.join(dir, "runtime"), state = path.join(dir, "state");
  const backup = path.join(runtime, ".rollback-" + "c".repeat(32));
  const operation = path.join(state, "deployments", "d".repeat(32));
  const archive = path.join(operation, "retained-runtime-recovery");
  for (const folder of [backup, operation]) mkdirSync(folder, { recursive: true });
  const binary = "synthetic current binary", routes = "synthetic current routes";
  const provenance = { routerCommit: currentCommit, upstreamCommit: "e".repeat(40), binarySha256: sha(binary), routesSha256: sha(routes) };
  writeFileSync(path.join(runtime, "switchyard-server.exe"), binary);
  writeFileSync(path.join(runtime, "routes.toml"), routes);
  writeFileSync(path.join(runtime, "provenance.json"), JSON.stringify(provenance));
  const rollbackCheckout = path.join(dir, "previous-checkout");
  const metadata = { version: 1, previousRouterCommit: previousCommit, rollbackRouterRoot: rollbackCheckout, files: runtimeFiles };
  const result = { state: "completed", succeeded: true, acceptance: {
    version: 1, accepted: true, deployed: true, routerCommit: currentCommit,
    switchyardCommit: provenance.upstreamCommit, switchyardBinarySha256: provenance.binarySha256,
    switchyardRoutesSha256: provenance.routesSha256, rollbackRoot: backup, rollbackRouterRoot: rollbackCheckout,
    checks: Object.fromEntries(["switchyardHealth", "taskIdentity", "routerFullHealth", "cleanCandidate", "installManifest",
      "doctor", "protectedEndpoints", "processIdentity", "provenance", "installedHashes", "installedCatalog"].map(name => [name, true])),
  } };
  for (const name of runtimeFiles) writeFileSync(path.join(backup, name), "previous-" + name);
  const metadataFile = path.join(backup, "rollback.json"), resultFile = path.join(operation, "result.json");
  const save = () => { writeFileSync(metadataFile, JSON.stringify(metadata)); writeFileSync(resultFile, JSON.stringify(result)); };
  save();
  const run = preview => {
    const child = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(root, "test/fixtures/switchyard-recovery.ps1"), "-CodeRoot", root, "-FixtureRoot", dir, ...(preview ? ["-Preview"] : [])],
    { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(readFileSync(path.join(dir, "outcome.json"), "utf8"));
  };
  return { dir, state, runtime, backup, operation, archive, metadata, result, metadataFile, resultFile, save, run,
    cleanup() { assert.ok(dir.startsWith(realpathSync.native(os.tmpdir()) + path.sep)); rmSync(dir, { recursive: true, force: true }); } };
}

test("accepted recovery preserves Unicode paths and archives without rewriting the original result", windows, () => {
  const f = fixture({ unicodePaths: true });
  try {
    const receipt = readFileSync(f.resultFile);
    const preview = f.run(true);
    assert.equal(preview.succeeded, true, preview.error);
    assert.equal(existsSync(f.backup), true);
    assert.equal(existsSync(f.archive), false);
    const actual = f.run();
    assert.equal(actual.succeeded, true, actual.error);
    assert.equal(actual.plan.source, f.backup);
    assert.equal(actual.plan.destination, f.archive);
    assert.equal(existsSync(f.backup), false);
    for (const name of runtimeFiles) assert.equal(readFileSync(path.join(f.archive, name), "utf8"), "previous-" + name);
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.archive, "rollback.json"), "utf8")), f.metadata);
    assert.deepEqual(readFileSync(f.resultFile), receipt);
    assert.equal(readFileSync(path.join(f.runtime, "switchyard-server.exe"), "utf8"), "synthetic current binary");
    // A retry sees no pending backup and cannot move or overwrite the archive.
    assert.equal(f.run().succeeded, true);
    assert.equal(readFileSync(path.join(f.archive, "routes.toml"), "utf8"), "previous-routes.toml");
  } finally { f.cleanup(); }
});

test("recovery archives preserve bound adapter identity, explicit absence and legacy metadata", windows, () => {
  for (const binding of [undefined, null, { generation: "e".repeat(64), managedDirectory: path.resolve(".tmp", "adapter", "e".repeat(64)),
    managedManifestSha256: "f".repeat(64) }]) {
    const f = fixture();
    try {
      if (binding !== undefined) f.metadata.webStopAdapter = binding;
      f.save(); const original = readFileSync(f.metadataFile);
      const actual = f.run();
      assert.equal(actual.succeeded, true, actual.error);
      assert.deepEqual(readFileSync(path.join(f.archive, "rollback.json")), original);
      assert.equal(Object.hasOwn(JSON.parse(original), "webStopAdapter"), binding !== undefined);
    } finally { f.cleanup(); }
  }
});

test("actual recovery reader retains the recognized underlying deployment owner after successful or failed outer Web maintenance", windows, () => {
  for (const succeeded of [true, false]) {
    const f = fixture();
    try {
      const accepted = structuredClone(f.result.acceptance);
      const resultPath = publishUnderlyingDeploymentAcceptance(accepted, currentCommit, accepted.switchyardBinarySha256, {
        stateDir: f.state, write: writeFileSync, isPrivate: () => true,
      });
      const resultBytes = readFileSync(resultPath);
      writeFileSync(f.resultFile, JSON.stringify({ state: "completed", succeeded,
        ...(succeeded ? { acceptance: { version: 1, accepted: true, deployment: accepted } } : { error: "final Web adapter rejected" }) }));
      const actual = f.run();
      assert.equal(actual.succeeded, true, actual.error);
      assert.equal(actual.plan.acceptedResult, resultPath);
      assert.equal(actual.plan.destination, path.join(path.dirname(resultPath), "retained-runtime-recovery"));
      assert.deepEqual(readFileSync(resultPath), resultBytes, "recovery never rewrites completed underlying custody");
      assert.equal(existsSync(f.backup), false);
    } finally { f.cleanup(); }
  }
});

test("underlying owner publication rejects incomplete accepted checks before creating recovery ownership", () => {
  const f = fixture();
  try {
    delete f.result.acceptance.checks.processIdentity;
    assert.throws(() => publishUnderlyingDeploymentAcceptance(f.result.acceptance, currentCommit,
      f.result.acceptance.switchyardBinarySha256, { stateDir: f.state, write: writeFileSync, isPrivate: () => true }), /complete acceptance/u);
  } finally { f.cleanup(); }
});

const invalid = {
  "failed deployment": f => { f.result.succeeded = false; f.save(); },
  "unfinished worker": f => { f.result.state = "running"; f.save(); },
  "unaccepted candidate": f => { f.result.acceptance.accepted = false; f.save(); },
  "incomplete checks": f => { delete f.result.acceptance.checks.processIdentity; f.save(); },
  "failed check": f => { f.result.acceptance.checks.routerFullHealth = false; f.save(); },
  "different installed commit": f => { f.result.acceptance.routerCommit = previousCommit; f.save(); },
  "different backup owner": f => { f.result.acceptance.rollbackRouterRoot = f.dir; f.save(); },
  "changed installed binary": f => writeFileSync(path.join(f.runtime, "switchyard-server.exe"), "changed"),
  "changed installed routes": f => writeFileSync(path.join(f.runtime, "routes.toml"), "changed"),
  "missing backup file": f => rmSync(path.join(f.backup, "routes.toml")),
  "empty metadata with files": f => { f.metadata.files = []; f.save(); },
  "unlisted backup file": f => { f.metadata.files = runtimeFiles.filter(name => name !== "routes.toml"); f.save(); },
  "duplicate backup names": f => { f.metadata.files = [...runtimeFiles, "routes.toml"]; f.save(); },
  "missing receipt": f => rmSync(f.resultFile),
  "occupied archive": f => mkdirSync(f.archive),
  "multiple backups": f => mkdirSync(path.join(f.runtime, ".rollback-" + "f".repeat(32))),
  "ambiguous acceptance": f => {
    const other = path.join(path.dirname(f.operation), "f".repeat(32)); mkdirSync(other);
    writeFileSync(path.join(other, "result.json"), JSON.stringify(f.result));
  },
};
for (const [name, corrupt] of Object.entries(invalid)) {
  test(`recovery archive retains the pending backup for ${name}`, windows, () => {
    const f = fixture();
    try {
      corrupt(f);
      const receipt = existsSync(f.resultFile) ? readFileSync(f.resultFile) : null;
      const actual = f.run();
      assert.equal(actual.succeeded, false);
      assert.equal(existsSync(f.backup), true);
      assert.equal(readFileSync(path.join(f.backup, "switchyard-server.exe"), "utf8"), "previous-switchyard-server.exe");
      if (receipt) assert.deepEqual(readFileSync(f.resultFile), receipt);
      assert.equal(existsSync(path.join(f.archive, "rollback.json")), false);
    } finally { f.cleanup(); }
  });
}
test("accepted recovery archives consistent partial and empty snapshots", windows, () => {
  for (const members of [["routes.toml"], []]) {
    const f = fixture();
    try {
      f.metadata.files = members;
      for (const name of runtimeFiles.filter(name => !members.includes(name))) rmSync(path.join(f.backup, name));
      f.save();
      const result = f.run();
      assert.equal(result.succeeded, true, result.error);
      assert.equal(existsSync(f.backup), false);
      assert.deepEqual(JSON.parse(readFileSync(path.join(f.archive, "rollback.json"), "utf8")).files, members);
      for (const name of runtimeFiles) assert.equal(existsSync(path.join(f.archive, name)), members.includes(name));
    } finally { f.cleanup(); }
  }
});

function consumerFixture(mode, scenario, configure) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "switchyard-recovery-consumer-")));
  try {
    const runtime = path.join(dir, "runtime"), snapshot = path.join(dir, "snapshot"), state = path.join(dir, "state");
    for (const folder of [runtime, snapshot, state]) mkdirSync(folder);
    const metadata = { version: 1, previousRouterCommit: previousCommit, rollbackRouterRoot: path.join(dir, "previous"), files: runtimeFiles };
    for (const name of runtimeFiles) {
      writeFileSync(path.join(runtime, name), "current-" + name);
      writeFileSync(path.join(snapshot, name), "previous-" + name);
    }
    const context = { dir, runtime, snapshot, state, metadata, verdicts: [
      { status: "absent", owned: false, sourceRoot: null }, { status: "absent", owned: false, sourceRoot: null },
    ] };
    configure?.(context);
    writeFileSync(path.join(snapshot, "rollback.json"), JSON.stringify(metadata));
    writeFileSync(path.join(dir, "verdicts.json"), JSON.stringify(context.verdicts));
    const before = Object.fromEntries(runtimeFiles.map(name => [name, readFileSync(path.join(runtime, name), "utf8")]));
    const child = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(root, "test/fixtures/switchyard-recovery.ps1"), "-CodeRoot", root, "-FixtureRoot", dir, "-Mode", mode, "-Case", scenario],
    { encoding: "utf8", timeout: 15_000, env: { ...process.env, CODEX_HOME: path.join(dir, "home"), MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state } });
    assert.equal(child.status, 0, child.stderr);
    const outcome = JSON.parse(readFileSync(path.join(dir, "outcome.json"), "utf8"));
    return { outcome, before, after: Object.fromEntries(runtimeFiles.map(name => [name, existsSync(path.join(runtime, name)) ? readFileSync(path.join(runtime, name), "utf8") : null])) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("actual restore accepts consistent complete, partial and empty prior membership", windows, () => {
  for (const members of [runtimeFiles, ["routes.toml"], []]) {
    const { outcome, after } = consumerFixture("restore", "valid", f => {
      f.metadata.files = members;
      for (const name of runtimeFiles.filter(name => !members.includes(name))) rmSync(path.join(f.snapshot, name));
      writeFileSync(path.join(f.snapshot, "ancillary.txt"), "not managed");
    });
    assert.equal(outcome.succeeded, true, outcome.error);
    for (const name of runtimeFiles) assert.equal(after[name], members.includes(name) ? "previous-" + name : null);
  }
});

const invalidMembership = {
  "empty with physical files": f => { f.metadata.files = []; },
  "duplicate": f => { f.metadata.files = [...runtimeFiles, "routes.toml"]; },
  "nonstring": f => { f.metadata.files = [null]; },
  "unsupported": f => { f.metadata.files = ["../routes.toml"]; },
  "scalar": f => { f.metadata.files = "routes.toml"; },
  "missing": f => rmSync(path.join(f.snapshot, "routes.toml")),
  "unlisted": f => { f.metadata.files = runtimeFiles.filter(name => name !== "routes.toml"); },
  "directory": f => { rmSync(path.join(f.snapshot, "routes.toml")); mkdirSync(path.join(f.snapshot, "routes.toml")); },
  "wrong version": f => { f.metadata.version = 2; },
  "relative root": f => { f.metadata.rollbackRouterRoot = "previous"; },
};
for (const [name, configure] of Object.entries(invalidMembership)) {
  test(`actual restore refuses ${name} snapshot before first mutation`, windows, () => {
    const { outcome, before, after } = consumerFixture("restore", "invalid", configure);
    assert.equal(outcome.succeeded, false);
    assert.deepEqual(after, before);
    assert.deepEqual(outcome.calls, []);
  });
}
for (const scenario of ["changed-file", "changed-metadata"]) {
  test(`actual restore revalidates frozen membership for ${scenario}`, windows, () => {
    const { outcome, before, after } = consumerFixture("restore", scenario);
    assert.equal(outcome.succeeded, false);
    assert.deepEqual(after, before);
    assert.deepEqual(outcome.calls, []);
  });
}

test("actual resolver accepts positive absence and queries the current rich owner", windows, () => {
  for (const scenario of ["synthetic", "actual-absent"]) {
    const { outcome } = consumerFixture("verdict", scenario);
    assert.equal(outcome.succeeded, true, outcome.error);
    assert.equal(outcome.result, null);
    assert.deepEqual(outcome.calls.filter(call => call.startsWith("offline-")), ["offline-4202", "offline-4000"]);
    assert.equal(outcome.calls.filter(call => call.startsWith("verify-")).length, 2);
  }
});
test("actual resolver accepts allowed previous owner after candidate foreign verdict", windows, () => {
  const { outcome } = consumerFixture("verdict", "synthetic", f => {
    f.verdicts = [{ status: "foreign", owned: false, sourceRoot: null }, { status: "owned", owned: true, sourceRoot: path.join(f.dir, "previous") }];
  });
  assert.equal(outcome.succeeded, true, outcome.error);
  assert.match(outcome.result, /previous$/u);
  assert.ok(!outcome.calls.some(call => call.startsWith("offline-")));
});
for (const scenario of ["unknown", "foreign", "boolean-only", "inconsistent", "query-failure", "actual-unknown", "live-4202", "live-4000", "unknown-4202", "unknown-4000"]) {
  test(`actual resolver refuses unresolved ${scenario} before restoration`, windows, () => {
    const { outcome } = consumerFixture("verdict", scenario, f => {
      if (scenario === "actual-unknown") writeFileSync(path.join(f.state, "service-process.json"), JSON.stringify({ version: 1, managed: true, pid: 1 }));
      if (["unknown", "foreign"].includes(scenario)) f.verdicts[0] = { status: scenario, owned: false, sourceRoot: null };
      if (scenario === "boolean-only") f.verdicts[0] = { owned: false, sourceRoot: null };
      if (scenario === "inconsistent") f.verdicts[0] = { status: "absent", owned: true, sourceRoot: null };
    });
    assert.equal(outcome.succeeded, false);
    assert.ok(!outcome.calls.some(call => call.startsWith("stop-")));
  });
}
test("actual stop caller requires rich absent process and both quiet ports after successful service stop", windows, () => {
  for (const scenario of ["stop-absent", "stop-owned", "stop-unknown", "stop-live-4202", "stop-live-4000"]) {
    const { outcome } = consumerFixture("verdict", scenario, f => {
      if (scenario === "stop-owned") f.verdicts[0] = { status: "owned", owned: true, sourceRoot: root };
      if (scenario === "stop-unknown") f.verdicts[0] = { status: "unknown", owned: false, sourceRoot: null };
    });
    assert.equal(outcome.succeeded, scenario === "stop-absent", outcome.error);
    assert.equal(outcome.calls.filter(call => call.startsWith("stop-")).length, 1);
    if (scenario === "stop-absent") assert.deepEqual(outcome.calls.filter(call => call.startsWith("offline-")), ["offline-4202", "offline-4000"]);
  }
});
