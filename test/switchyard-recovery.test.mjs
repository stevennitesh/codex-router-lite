import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const runtimeFiles = ["switchyard-server.exe", "routes.toml", "SOURCE_COMMIT", "provenance.json"];
const currentCommit = "a".repeat(40), previousCommit = "b".repeat(40);
const sha = text => createHash("sha256").update(text).digest("hex");
const windows = { skip: process.platform !== "win32" };

function fixture() {
  // The real PowerShell deployment records expanded paths. Match that producer
  // when CI supplies a Windows 8.3 temporary-directory alias.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "switchyard-recovery-")));
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
  return { dir, runtime, backup, operation, archive, metadata, result, metadataFile, resultFile, save, run,
    cleanup() { assert.ok(dir.startsWith(realpathSync.native(os.tmpdir()) + path.sep)); rmSync(dir, { recursive: true, force: true }); } };
}

test("accepted recovery is archived intact and the original result is not rewritten", windows, () => {
  const f = fixture();
  try {
    const receipt = readFileSync(f.resultFile);
    const preview = f.run(true);
    assert.equal(preview.succeeded, true, preview.error);
    assert.equal(existsSync(f.backup), true);
    assert.equal(existsSync(f.archive), false);
    const actual = f.run();
    assert.equal(actual.succeeded, true, actual.error);
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
