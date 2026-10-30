import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { prepareWebMaintenance, runWebMaintenance, validateWebMaintenanceAcceptance } from "../maintenance/web-runtime-maintenance.mjs";

function fixture({ finalChanged = false } = {}) {
  const options = { expectedCommit: "a".repeat(40), candidateBinary: path.resolve(".tmp", "switchyard-server.exe"), expectedBinarySha256: "d".repeat(64),
    expectedCandidateSha256: "b".repeat(64), timeoutMs: 60_000, deploymentAcceptancePath: path.resolve(".tmp", "underlying-acceptance.json") };
  const initial = { candidateSha256: options.expectedCandidateSha256, plan: { changed: true }, adapter: { generation: "old",
    managedEntryPath: path.resolve(".tmp", "adapter", "old", "entry.exe"), currentRuntime: { runtimeModule: path.resolve(".tmp", "old-browser.mjs") },
    candidate: { node: { path: path.resolve(".tmp", "node.exe"), sha256: "1".repeat(64) }, officialCli: { path: path.resolve(".tmp", "codex.exe"), sha256: "2".repeat(64) },
      officialNodeRepl: { path: path.resolve(".tmp", "node_repl.exe"), sha256: "3".repeat(64) }, runtimeModule: path.resolve(".tmp", "new-browser.mjs"), runtimeHash: "4".repeat(64), sdkPackageJson: path.resolve(".tmp", "sdk.json") } } };
  const final = { plan: { changed: finalChanged }, adapter: { ...initial.adapter, generation: "final" } }, events = [];
  const deployed = { version: 1, accepted: true, deployed: true, routerCommit: options.expectedCommit, switchyardBinarySha256: options.expectedBinarySha256,
    switchyardCommit: "a".repeat(40), switchyardRoutesSha256: "b".repeat(64),
    rollbackRoot: path.resolve(".tmp", "switchyard", "rollback"), rollbackRouterRoot: path.resolve(".tmp", "router-rollback"),
    checks: Object.fromEntries(["switchyardHealth", "taskIdentity", "routerFullHealth", "cleanCandidate", "installManifest",
      "doctor", "protectedEndpoints", "processIdentity", "provenance", "installedHashes", "installedCatalog"].map(name => [name, true])) };
  const dependencies = {
    prepare() { events.push("prepare"); return initial; },
    async wait(adapter, { timeoutMs }) { assert.equal(adapter, initial.adapter); assert.equal(timeoutMs, options.timeoutMs); events.push("exit-handles"); },
    absent(adapter) { events.push(`absent:${adapter.generation}`); },
    ledger() { events.push("ledger"); return [{ sha256: "c".repeat(64), uncertainSend: true }]; },
    unchanged(value) { assert.equal(value[0].uncertainSend, true); events.push("unchanged"); },
    source() { events.push("source"); },
    async refresh(value) { assert.deepEqual(value, { apply: true, forceServiceReplacement: true, expectedMaintenance: { plan: initial.plan, adapter: initial.adapter } }); events.push("refresh"); },
    async deploy() { events.push("guarded-deploy"); return { receipt: deployed, resultPath: path.resolve(".tmp", "deployment-owner", "result.json") }; }, async accept() { events.push("accept"); },
    inspectFinal() { events.push("replan"); return final; },
    async refreshFinal(value) {
      assert.deepEqual({ apply: value.apply, forceServiceReplacement: value.forceServiceReplacement, expectedMaintenance: value.expectedMaintenance },
        { apply: true, forceServiceReplacement: true, expectedMaintenance: final });
      assert.equal(typeof value.dependencies.discover, "function"); events.push("refresh-final");
    },
    inspectActual() { return { plan: { changed: false }, adapter: final.adapter }; },
  };
  return { options, dependencies, initial, final, events };
}

test("Web maintenance reaches the guarded deployment body through the real Windows PowerShell File handoff", { skip: process.platform !== "win32" }, t => {
  const root = path.resolve(import.meta.dirname, ".."), scratch = path.join(root, ".tmp", "web-lifecycle-tests");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "deployment-handoff-")), codexHome = path.join(directory, "codex");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { expectedCommit: "a".repeat(40), candidateBinary: path.join(directory, "switchyard-server.exe"),
    expectedBinarySha256: "b".repeat(64), expectedCandidateSha256: "c".repeat(64), timeoutMs: 1000,
    deploymentAcceptancePath: path.join(directory, "acceptance.json") };
  const runner = `import { runWebMaintenance } from ${JSON.stringify(pathToFileURL(path.join(root, "maintenance", "web-runtime-maintenance.mjs")).href)};
const options = ${JSON.stringify(options)};
try {
  await runWebMaintenance(options, {
    prepare() { return { candidateSha256: options.expectedCandidateSha256, plan: {}, adapter: {} }; },
    async wait() {}, absent() {}, ledger() { return []; }, unchanged() {}, source() {},
    async refresh() { console.log("synthetic-refresh-complete"); },
  });
  throw new Error("Deployment unexpectedly passed the missing-manifest guard");
} catch (error) { console.error(error.message); process.exitCode = 17; }
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_ROUTER_STATE_DIR: path.join(directory, "state"),
      MODEL_ROUTER_STATE_DIR: path.join(directory, "state") },
  });
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stdout, /synthetic-refresh-complete/u);
  const missingManifest = `Installed Router manifest is missing at ${path.join(codexHome, "codex-router", "install-manifest.json")}.`;
  // Windows PowerShell wraps its error display at the host's console width.
  assert.ok(result.stderr.replace(/\s/gu, "").includes(missingManifest.replace(/\s/gu, "")), result.stderr);
  assert.match(result.stderr, /Guarded Router deployment failed with status 1/u);
  // The real handoff may create only its scratch receipt; no deployment state
  // or service effects can precede the missing synthetic install manifest.
  assert.deepEqual(readdirSync(directory), ["acceptance.json"]);
});

test("detached maintenance validates around exit and refreshes before guarded deployment, then only changes a stale final adapter", async t => {
  for (const finalChanged of [false, true]) await t.test(`final changed: ${finalChanged}`, async () => {
    const f = fixture({ finalChanged }), receipt = await runWebMaintenance(f.options, f.dependencies);
    assert.deepEqual(f.events.slice(0, 4), ["prepare", "exit-handles", "prepare", "absent:old"]);
    assert.ok(f.events.indexOf("refresh") < f.events.indexOf("guarded-deploy"));
    assert.ok(f.events.indexOf("guarded-deploy") < f.events.indexOf("replan"));
    assert.equal(f.events.includes("refresh-final"), finalChanged);
    assert.equal(receipt.codexReopenRequired, true);
    assert.equal(receipt.scope, "installation-and-runtime-readiness");
    assert.equal(receipt.liveWebVerification, "required-after-reopen");
    assert.ok(Object.values(receipt.checks).every(value => value === true));
    assert.equal(validateWebMaintenanceAcceptance(receipt, f.options.expectedCommit, f.options.expectedCandidateSha256, f.options.candidateBinary, f.options.expectedBinarySha256), receipt);
  });
});

test("changed candidate or source, early reopen, ledger drift and failed deployment withhold acceptance", async t => {
  for (const branch of ["before-wait", "after-wait", "early-reopen", "ledger-drift", "source-drift", "deploy-failure", "accept-failure", "final-reopen"]) {
    await t.test(branch, async () => {
      const f = fixture({ finalChanged: true }); let prepares = 0, proofs = 0;
      f.dependencies.prepare = () => ({ ...f.initial, candidateSha256: (++prepares === (branch === "before-wait" ? 1 : 2) && ["before-wait", "after-wait"].includes(branch)) ? "changed" : f.options.expectedCandidateSha256 });
      if (branch === "early-reopen" || branch === "final-reopen") f.dependencies.absent = () => { if (++proofs === (branch === "early-reopen" ? 2 : 4)) throw new Error("new host"); };
      if (branch === "ledger-drift") f.dependencies.unchanged = () => { throw new Error("ledger drift"); };
      if (branch === "source-drift") f.dependencies.source = () => { throw new Error("source drift"); };
      if (branch === "deploy-failure") f.dependencies.deploy = async () => { throw new Error("deployment status 1"); };
      if (branch === "accept-failure") f.dependencies.accept = async () => { throw new Error("deployment rejected"); };
      await assert.rejects(runWebMaintenance(f.options, f.dependencies));
      if (["before-wait", "after-wait"].includes(branch)) assert.equal(f.events.includes("refresh"), false);
      if (["early-reopen", "ledger-drift", "source-drift"].includes(branch)) assert.equal(f.events.includes("guarded-deploy"), false);
    });
  }
});

test("independent worker acceptance is bound to exact candidate, installation and all required checks", async () => {
  const f = fixture(), receipt = await runWebMaintenance(f.options, f.dependencies);
  for (const mutate of [value => { value.accepted = false; }, value => { value.routerCommit = "d".repeat(40); },
    value => { value.candidateSha256 = "e".repeat(64); }, value => { value.sourceRoot += "-foreign"; },
    value => { delete value.checks.ledgerPreserved; }, value => { value.checks.processAbsence = false; },
    value => { value.configurationPublication = { beforeSha256: "invalid", afterSha256: "a".repeat(64) }; },
    value => { value.codexReopenRequired = false; }, value => { delete value.scope; },
    value => { value.scope = "live-web-verified"; }, value => { delete value.liveWebVerification; },
    value => { value.liveWebVerification = "verified"; }]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.throws(() => validateWebMaintenanceAcceptance(changed, f.options.expectedCommit, f.options.expectedCandidateSha256, f.options.candidateBinary, f.options.expectedBinarySha256), /complete acceptance/u);
  }
});

test("checkout maintenance preflight binds the existing installed source and reviewed Switchyard binary", t => {
  const sourceRoot = path.resolve(import.meta.dirname, ".."), scratch = path.join(sourceRoot, ".tmp", "maintenance-preflight");
  mkdirSync(scratch, { recursive: true }); const directory = mkdtempSync(path.join(scratch, "candidate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "switchyard-server.exe"), bytes = "inert existing binary fixture";
  writeFileSync(binary, bytes); const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const dependencies = { source() {}, inspect: () => ({ plan: {}, adapter: {} }),
    readInstalled: () => ({ version: 1, current: { target: "codex", sourceRoot } }) };
  const candidate = prepareWebMaintenance("a".repeat(40), binary, expectedHash, dependencies);
  assert.match(candidate.candidateSha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => prepareWebMaintenance("a".repeat(40), binary, "0".repeat(64), dependencies), /reviewed candidate hash/u);
  assert.throws(() => prepareWebMaintenance("a".repeat(40), binary, expectedHash, { ...dependencies,
    readInstalled: () => ({ current: { target: "codex", sourceRoot: directory } }) }), /recorded installed Router root/u);
});

test("final replanning cannot silently select another official cohort or claim an unapplied adapter", async t => {
  for (const branch of ["cohort", "unapplied"]) await t.test(branch, async () => {
    const f = fixture({ finalChanged: true });
    if (branch === "cohort") f.dependencies.inspectFinal = () => ({ plan: f.final.plan,
      adapter: { ...f.final.adapter, candidate: { ...f.final.adapter.candidate, runtimeModule: path.resolve(".tmp", "foreign-browser.mjs") } } });
    else f.dependencies.inspectActual = () => ({ plan: { changed: true }, adapter: f.final.adapter });
    await assert.rejects(runWebMaintenance(f.options, f.dependencies), /reviewed official cohort/u);
    if (branch === "cohort") assert.equal(f.events.includes("refresh-final"), false);
  });
});
