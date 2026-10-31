import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { prepareWebMaintenance, runWebMaintenance, validateWebMaintenanceAcceptance, nativeCompactionRestoredSnapshot,
  restoreWebMaintenanceNativeCompaction } from "../maintenance/web-runtime-maintenance.mjs";

function fixture({ finalChanged = false } = {}) {
  const options = { expectedCommit: "a".repeat(40), candidateBinary: path.resolve(".tmp", "switchyard-server.exe"), expectedBinarySha256: "d".repeat(64),
    expectedCandidateSha256: "b".repeat(64), timeoutMs: 60_000, deploymentAcceptancePath: path.resolve(".tmp", "a".repeat(32), "underlying-acceptance.json") };
  const initial = { candidateSha256: options.expectedCandidateSha256, plan: { changed: true }, adapter: { generation: "a".repeat(64),
    managedDirectory: path.resolve(".tmp", "adapter", "old"), managedManifestSha256: "e".repeat(64),
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
    async refresh(value) { assert.deepEqual(value, { apply: true, forceServiceReplacement: true, expectedMaintenance: { plan: initial.plan, adapter: initial.adapter },
      cleanupOperationId: "a".repeat(32) }); events.push("refresh"); },
    async deploy(value) {
      assert.deepEqual(value.rollbackAdapter, { generation: initial.adapter.generation, managedDirectory: initial.adapter.managedDirectory,
        managedManifestSha256: initial.adapter.managedManifestSha256 });
      events.push("guarded-deploy"); return { receipt: deployed, resultPath: path.resolve(".tmp", "deployment-owner", "result.json") };
    }, async accept() { events.push("accept"); },
    inspectFinal() { events.push("replan"); return final; },
    async refreshFinal(value) {
      assert.deepEqual({ apply: value.apply, forceServiceReplacement: value.forceServiceReplacement, expectedMaintenance: value.expectedMaintenance },
        { apply: true, forceServiceReplacement: true, expectedMaintenance: final });
      assert.equal(typeof value.dependencies.discover, "function"); events.push("refresh-final");
      assert.equal(value.cleanupOperationId, "a".repeat(32));
    },
    inspectActual() { return { plan: { changed: false }, adapter: final.adapter }; },
  };
  return { options, dependencies, initial, final, events };
}

function restorationFixture() {
  const threadId = "12345678-1234-1234-1234-123456789abc", ledgerPath = path.resolve(".tmp", `${threadId}.json`);
  const confirmationSha256 = "8".repeat(64), archive = `${ledgerPath}.native-compaction-${confirmationSha256}.original`;
  const witnessFile = path.resolve(".tmp", `${threadId}.native-compaction-${"7".repeat(64)}.json`);
  const restoration = { plan: { fixture: true }, threadId, confirmationSha256, ledgerPath, beforeLedgerSha256: "1".repeat(64),
    afterLedgerSha256: "2".repeat(64), planFileSha256: "3".repeat(64), witnessFile, witnessSha256: "4".repeat(64),
    expectedSidecars: [{ name: path.basename(archive), sha256: "1".repeat(64) },
      { name: path.basename(`${archive}.rollout.jsonl`), sha256: "5".repeat(64) }, { name: path.basename(witnessFile), sha256: "6".repeat(64) }] };
  const snapshot = [{ name: path.basename(ledgerPath), kind: "conversation", sha256: restoration.beforeLedgerSha256, uncertainSend: false, unresolvedActions: 0 },
    { name: "existing.original", kind: "sidecar", sha256: "9".repeat(64) }];
  const receipt = { threadId, state: "readable-native-compaction-restored", confirmationSha256, archive, rolloutArchive: `${archive}.rollout.jsonl`,
    witnessFile, ledgerSha256: restoration.afterLedgerSha256, witnessSha256: restoration.witnessSha256 };
  return { restoration, snapshot, receipt };
}

test("exact restoration snapshot preserves all other ledger evidence and names each expected sidecar", () => {
  const f = restorationFixture(), after = nativeCompactionRestoredSnapshot(f.snapshot, f.restoration);
  assert.equal(after.length, f.snapshot.length + 3);
  assert.deepEqual(after.find(row => row.name === "existing.original"), f.snapshot[1]);
  assert.deepEqual(after.find(row => row.kind === "conversation"), { ...f.snapshot[0], sha256: f.restoration.afterLedgerSha256 });
  for (const mutate of [rows => { rows[0].sha256 = "f".repeat(64); }, rows => { rows[0].uncertainSend = true; },
    rows => { rows[0].unresolvedActions = 1; }, rows => { rows.push({ ...after.find(row => row.name === f.restoration.expectedSidecars[0].name), sha256: "f".repeat(64) }); }]) {
    const changed = structuredClone(f.snapshot); mutate(changed);
    assert.throws(() => nativeCompactionRestoredSnapshot(changed, f.restoration));
  }
});

test("offline restoration retains the service owner across strict stop, apply, start and acceptance", async () => {
  const f = restorationFixture(), events = [];
  const actual = await restoreWebMaintenanceNativeCompaction(f.restoration, {
    async lock(operation) { events.push("locked"); const result = await operation(); events.push("released"); return result; },
    prove() { events.push("absent"); }, verifySource() { events.push("source"); }, verify() { events.push("restored"); },
    async service(command, args, options) { assert.deepEqual(args, [command]); options.beforeMutation(); events.push(command); return 0; },
    async apply(plan, sha, options) { assert.equal(plan, f.restoration.plan); assert.equal(sha, f.restoration.confirmationSha256);
      assert.equal(options.serviceAlreadyLocked, true); assert.equal(typeof options.assertOffline, "function"); events.push("apply"); return f.receipt; },
    async accept() { events.push("accept"); },
  });
  assert.equal(actual, f.receipt);
  assert.equal(events[0], "locked"); assert.equal(events.at(-1), "released");
  assert.ok(events.indexOf("stop") < events.indexOf("apply")); assert.ok(events.indexOf("apply") < events.indexOf("start"));
  assert.ok(events.indexOf("start") < events.indexOf("accept"));
});

test("restoration failures compensate only exact unadvanced ledger bytes and preserve both errors", async t => {
  for (const branch of ["offline-refused", "applied-then-failed", "start-failed", "health-failed", "advanced", "rollback-failed", "drain-refused", "new-native-work"]) await t.test(branch, async () => {
    const f = restorationFixture(), events = []; let current = f.restoration.beforeLedgerSha256, starts = 0, health = 0, proofs = 0;
    const dependencies = { lock: operation => operation(), prove() { if (++proofs > 1 && branch === "new-native-work") throw new Error("native work returned"); },
      verifySource() {}, verify() {}, ledgerHash: () => current,
      async service(command) { events.push(command); if (command === "stop" && branch === "drain-refused") return 1;
        if (command === "start" && ++starts === 1 && branch === "start-failed") return 1; return 0; },
      async accept() { if (++health === 1 && ["health-failed", "advanced", "rollback-failed"].includes(branch)) {
        if (branch === "advanced") current = "f".repeat(64); throw new Error("health refused"); } },
      async apply() { events.push("apply"); if (branch === "offline-refused") throw new Error("offline refused"); current = f.restoration.afterLedgerSha256;
        if (branch === "applied-then-failed") throw new Error("write readback failed"); return f.receipt; },
      async rollback() { events.push("rollback"); if (branch === "rollback-failed") throw new Error("archive changed"); current = f.restoration.beforeLedgerSha256; },
    };
    await assert.rejects(restoreWebMaintenanceNativeCompaction(f.restoration, dependencies), branch === "advanced" ? /advanced/u
      : branch === "rollback-failed" ? /health refused.*recovery also failed: archive changed/u : /failed|refused|native work returned/u);
    if (["drain-refused", "new-native-work"].includes(branch)) assert.equal(events.includes("apply"), false);
    if (["advanced", "rollback-failed", "drain-refused", "new-native-work"].includes(branch)) assert.equal(events.at(-1) === "start", false);
    else assert.equal(current, f.restoration.beforeLedgerSha256);
  });
});

test("optional restoration occurs after accepted deployment and retains exact hashes in acceptance", async () => {
  const f = fixture(), r = restorationFixture();
  f.options.nativeCompactionRestorePlan = path.resolve(".tmp", "restoration-plan.json");
  f.options.nativeCompactionRestorePlanSha256 = r.restoration.confirmationSha256;
  f.initial.nativeCompactionRestoration = r.restoration;
  f.dependencies.ledger = () => r.snapshot;
  f.dependencies.inspectRestoration = () => r.restoration;
  f.dependencies.unchanged = value => { f.events.push(value === r.snapshot ? "unchanged-source" : "unchanged-restored"); };
  f.dependencies.restore = async (restoration, options) => { assert.equal(restoration, r.restoration);
    options.verifySource(); options.prove(); options.verify(); f.events.push("restore"); return r.receipt; };
  const receipt = await runWebMaintenance(f.options, f.dependencies);
  assert.ok(f.events.indexOf("restore") > f.events.indexOf("guarded-deploy"));
  assert.ok(f.events.indexOf("restore") > f.events.indexOf("accept"));
  assert.equal(receipt.ledgers.sidecarCount, 4); assert.equal(receipt.nativeCompactionRestoration.count, 1);
  const validate = value => validateWebMaintenanceAcceptance(value, f.options.expectedCommit, f.options.expectedCandidateSha256,
    f.options.candidateBinary, f.options.expectedBinarySha256, f.options.nativeCompactionRestorePlan, f.options.nativeCompactionRestorePlanSha256);
  assert.equal(validate(receipt), receipt);
  for (const mutate of [value => { delete value.nativeCompactionRestoration; }, value => { value.nativeCompactionRestoration.count = 2; },
    value => { value.nativeCompactionRestoration.afterLedgerSha256 = "f".repeat(64); }, value => { value.nativeCompactionRestoration.confirmationSha256 = "f".repeat(64); }]) {
    const changed = structuredClone(receipt); mutate(changed); assert.throws(() => validate(changed), /exact native compaction/u);
  }
  f.dependencies.inspectRestoration = () => ({ ...r.restoration, planFileSha256: "f".repeat(64) });
  await assert.rejects(runWebMaintenance(f.options, f.dependencies), /plan changed after deployment/u);
});

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
    prepare() { return { candidateSha256: options.expectedCandidateSha256, plan: {}, adapter: {
      generation: "a".repeat(64), managedDirectory: ${JSON.stringify(directory)}, managedManifestSha256: "d".repeat(64),
      managedEntryPath: ${JSON.stringify(path.join(directory, "entry.exe"))} } }; },
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
    assert.deepEqual(f.events.slice(0, 4), ["prepare", "exit-handles", "prepare", `absent:${f.initial.adapter.generation}`]);
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

test("refresh-before-deploy retains the original adapter identity instead of refreshed ownership", async () => {
  const f = fixture(), original = { generation: f.initial.adapter.generation, managedDirectory: f.initial.adapter.managedDirectory,
    managedManifestSha256: f.initial.adapter.managedManifestSha256 };
  let installedAdapter = original;
  const refresh = f.dependencies.refresh, deploy = f.dependencies.deploy;
  f.dependencies.refresh = async options => {
    await refresh(options);
    installedAdapter = { generation: "f".repeat(64), managedDirectory: path.resolve(".tmp", "adapter", "refreshed"), managedManifestSha256: "9".repeat(64) };
  };
  f.dependencies.deploy = async options => {
    assert.notDeepEqual(installedAdapter, original);
    assert.deepEqual(options.rollbackAdapter, original);
    return deploy(options);
  };
  await runWebMaintenance(f.options, f.dependencies);
});

test("unknown original adapter identity stops maintenance before refreshing or deploying", async t => {
  for (const field of ["generation", "managedDirectory", "managedManifestSha256", "managedEntryPath"]) await t.test(field, async () => {
    const f = fixture(); delete f.initial.adapter[field];
    await assert.rejects(runWebMaintenance(f.options, f.dependencies), /original adapter rollback identity/u);
    assert.equal(f.events.includes("refresh"), false);
    assert.equal(f.events.includes("guarded-deploy"), false);
  });
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
  const restoration = restorationFixture().restoration, restorationOptions = { ...dependencies,
    nativeCompactionRestorePlan: path.join(directory, "plan.json"), nativeCompactionRestorePlanSha256: restoration.confirmationSha256,
    inspectRestoration: () => restoration };
  const restored = prepareWebMaintenance("a".repeat(40), binary, expectedHash, restorationOptions);
  assert.notEqual(candidate.candidateSha256, restored.candidateSha256);
  assert.notEqual(prepareWebMaintenance("a".repeat(40), binary, expectedHash, { ...restorationOptions,
    inspectRestoration: () => ({ ...restoration, planFileSha256: "f".repeat(64) }) }).candidateSha256, restored.candidateSha256);
  assert.throws(() => prepareWebMaintenance("a".repeat(40), binary, expectedHash, { ...restorationOptions,
    nativeCompactionRestorePlanSha256: undefined }), /exact protected plan/u);
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
