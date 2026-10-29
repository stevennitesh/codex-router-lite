import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWebRuntimeAnchors, inspectWebRuntimeMaintenance, refreshWebRuntime } from "../src/web-runtime-refresh.mjs";
import { assertWebMaintenanceAbsent, waitForWebMaintenanceExit, snapshotWebConversationLedgers, assertWebConversationLedgersUnchanged } from "../src/web-maintenance-proof.mjs";
import { STATE_DIR } from "../src/paths.mjs";
import { writePrivateFile, privateFileIsProtected } from "../src/file-security.mjs";
import { assertDeploymentRuntime } from "../src/deployment-acceptance.mjs";
import { readInstallManifest } from "../src/install-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const checks = ["sourceCandidate", "processAbsence", "webRuntimeRefreshed", "deploymentAccepted", "ledgerPreserved", "adapterFinal"];
const deploymentChecks = ["switchyardHealth", "taskIdentity", "routerFullHealth", "cleanCandidate", "installManifest",
  "doctor", "protectedEndpoints", "processIdentity", "provenance", "installedHashes", "installedCatalog"];

export function assertWebMaintenanceSource(expectedCommit, sourceRoot = root) {
  if (!/^[a-f0-9]{40}$/iu.test(expectedCommit ?? "")) throw new Error("An exact reviewed Router candidate commit is required.");
  const git = args => execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000 }).trim();
  if (git(["rev-parse", "HEAD"]).toLowerCase() !== expectedCommit.toLowerCase()
      || git(["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Router maintenance candidate must remain at the reviewed clean commit.");
  return expectedCommit.toLowerCase();
}

export function prepareWebMaintenance(expectedCommit, candidateBinary, expectedBinarySha256,
  { inspect = inspectWebRuntimeMaintenance, source = assertWebMaintenanceSource, readInstalled = readInstallManifest,
    discover = discoverWebRuntimeAnchors } = {}) {
  source(expectedCommit);
  const installed = readInstalled();
  if (installed?.current?.target !== "codex" || typeof installed.current.sourceRoot !== "string"
      || path.resolve(installed.current.sourceRoot).toLowerCase() !== root.toLowerCase()) throw new Error("Web maintenance requires this checkout to be the recorded installed Router root.");
  if (!path.isAbsolute(candidateBinary ?? "") || !/^[a-f0-9]{64}$/iu.test(expectedBinarySha256 ?? "")) throw new Error("The reviewed Switchyard binary path and SHA-256 are required.");
  const binary = lstatSync(candidateBinary);
  if (!binary.isFile() || binary.isSymbolicLink() || binary.size > 256 * 1024 * 1024
      || hash(readFileSync(candidateBinary)) !== expectedBinarySha256.toLowerCase()) throw new Error("The existing Switchyard binary does not match the reviewed candidate hash.");
  const prepared = inspect({ sourceRoot: root, dependencies: { discover } });
  const candidateSha256 = hash(JSON.stringify({ commit: expectedCommit.toLowerCase(), sourceRoot: root,
    candidateBinary: path.resolve(candidateBinary), expectedBinarySha256: expectedBinarySha256.toLowerCase(), installed, prepared }));
  return { ...prepared, candidateSha256 };
}

async function deploy({ expectedCommit, candidateBinary, expectedBinarySha256, deploymentAcceptancePath }) {
  if (!deploymentAcceptancePath) throw new Error("Independent maintenance requires a protected underlying deployment receipt path.");
  writePrivateFile(deploymentAcceptancePath, "");
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const status = await new Promise((resolve, reject) => {
    // Refresh has already restarted the stale generation. Keep the deployment
    // drain strict so earlier maintenance approval cannot interrupt new work.
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "maintenance", "deploy-switchyard-candidate.ps1"),
      "-InProcess", "-CandidateBinary", candidateBinary, "-ExpectedBinarySha256", expectedBinarySha256,
      "-ExpectedRouterCommit", expectedCommit, "-AcceptancePath", deploymentAcceptancePath], { stdio: "inherit", windowsHide: true });
    child.once("error", reject); child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`Guarded Router deployment failed with status ${status ?? "unknown"}.`);
  if (!privateFileIsProtected(deploymentAcceptancePath)) throw new Error("Underlying deployment acceptance is not protected.");
  const receipt = JSON.parse(readFileSync(deploymentAcceptancePath, "utf8"));
  validateUnderlyingDeployment(receipt, expectedCommit, expectedBinarySha256);
  // Publish the ordinary recognized completed owner immediately. Later Web
  // checks may fail, but must not erase successful deployment/backup custody.
  const resultPath = publishUnderlyingDeploymentAcceptance(receipt, expectedCommit, expectedBinarySha256);
  console.log(`Underlying checkout deployment accepted; retained completed owner: ${resultPath}`);
  return { receipt, resultPath };
}

function validateUnderlyingDeployment(receipt, expectedCommit, expectedBinarySha256) {
  if (receipt?.version !== 1 || receipt.accepted !== true || receipt.deployed !== true || receipt.routerCommit !== expectedCommit.toLowerCase()
      || receipt.switchyardBinarySha256 !== expectedBinarySha256.toLowerCase() || !path.isAbsolute(receipt.rollbackRoot ?? "")
      || !/^[a-f0-9]{40}$/u.test(receipt.switchyardCommit ?? "") || !/^[a-f0-9]{64}$/u.test(receipt.switchyardRoutesSha256 ?? "")
      || !path.isAbsolute(receipt.rollbackRouterRoot ?? "") || !receipt.checks || !Object.keys(receipt.checks).length
      || deploymentChecks.some(name => receipt.checks[name] !== true)
      || Object.values(receipt.checks).some(value => value !== true)) throw new Error("Underlying checkout deployment did not publish complete acceptance and rollback identities.");
}

export function publishUnderlyingDeploymentAcceptance(receipt, expectedCommit, expectedBinarySha256, {
  stateDir = STATE_DIR, write = writePrivateFile, isPrivate = privateFileIsProtected,
} = {}) {
  validateUnderlyingDeployment(receipt, expectedCommit, expectedBinarySha256);
  const operation = path.join(stateDir, "deployments", randomUUID().replaceAll("-", ""));
  mkdirSync(operation, { recursive: false });
  const resultPath = path.join(operation, "result.json"), completed = { state: "completed", succeeded: true, acceptance: receipt };
  write(resultPath, `${JSON.stringify(completed)}\n`);
  if (!isPrivate(resultPath) || JSON.stringify(JSON.parse(readFileSync(resultPath, "utf8"))) !== JSON.stringify(completed)) {
    throw new Error("Underlying completed deployment owner could not be verified; retain its acceptance and backup artifacts.");
  }
  return resultPath;
}

const cohort = adapter => ({ node: adapter.candidate.node, officialCli: adapter.candidate.officialCli,
  officialNodeRepl: adapter.candidate.officialNodeRepl, runtimeModule: adapter.candidate.runtimeModule, runtimeHash: adapter.candidate.runtimeHash });
const binding = value => ({ plan: value.plan, adapter: value.adapter });
const validConfigurationPublication = value => value && Object.keys(value).length === 2
  && [value.beforeSha256, value.afterSha256].every(digest => /^[a-f0-9]{64}$/u.test(digest ?? ""));

function planConfigurationPublication() {
  const output = execFileSync(process.execPath, [path.join(root, "src", "config-manager.mjs"), "validate-enable", "--publication-plan"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
  const publication = JSON.parse(output);
  if (!validConfigurationPublication(publication)) throw new Error("Managed configuration publication plan is invalid.");
  return publication;
}

// This runs only in the existing independent WMI deployment worker. It waits on
// actual process handles, never quits/relaunches Codex and never edits a ledger.
export async function runWebMaintenance({ expectedCommit, candidateBinary, expectedBinarySha256, expectedCandidateSha256, timeoutMs, deploymentAcceptancePath }, dependencies = {}) {
  const prepare = dependencies.prepare ?? prepareWebMaintenance;
  const source = dependencies.source ?? assertWebMaintenanceSource;
  const absent = dependencies.absent ?? assertWebMaintenanceAbsent;
  const ledger = dependencies.ledger ?? (() => snapshotWebConversationLedgers(STATE_DIR));
  const unchanged = dependencies.unchanged ?? (snapshot => assertWebConversationLedgersUnchanged(STATE_DIR, snapshot));
  const refresh = dependencies.refresh ?? (options => refreshWebRuntime({ sourceRoot: root, ...options }));
  // Capture authority before replacing the receipt/User launch selection. Codex
  // remains closed, so its app-owned MCP command can still name the prior owned
  // entry afterward. This witness lives only in this transaction's closure;
  // final inspection still revalidates config bytes, CLI identity, signatures,
  // protected artifacts and current receipt/environment/hook ownership.
  let runtimeDiscovery;
  const discover = options => {
    const observed = (dependencies.discover ?? discoverWebRuntimeAnchors)(options);
    runtimeDiscovery = observed;
    return observed;
  };
  const prepareCandidate = () => prepare(expectedCommit, candidateBinary, expectedBinarySha256, { discover });
  const finalOptions = { sourceRoot: root, dependencies: { discover() {
    if (!runtimeDiscovery) throw new Error("Web maintenance has no retained official runtime discovery.");
    return runtimeDiscovery;
  } } };
  const candidate = prepareCandidate();
  if (candidate.candidateSha256 !== expectedCandidateSha256) throw new Error("Prepared Web maintenance candidate changed before its worker started.");
  await dependencies.onWaiting?.();
  await (dependencies.wait ?? waitForWebMaintenanceExit)(candidate.adapter, { timeoutMs });
  const after = prepareCandidate();
  if (after.candidateSha256 !== expectedCandidateSha256) throw new Error("Prepared Web maintenance candidate changed while awaiting Codex exit.");
  absent(candidate.adapter);
  const snapshot = ledger();
  await refresh({ apply: true, forceServiceReplacement: true, expectedMaintenance: binding(candidate) });
  unchanged(snapshot); source(expectedCommit); absent(candidate.adapter);
  // The deployment's config-manager enable owns canonical managed-block
  // upgrades. Bind its recorded exact output to the unchanged discovery input
  // before deployment, then hand off only after underlying acceptance.
  const configurationPublication = runtimeDiscovery ? (dependencies.planConfigurationPublication ?? planConfigurationPublication)() : null;
  if (runtimeDiscovery) {
    runtimeDiscovery.assertCurrent();
    if (!validConfigurationPublication(configurationPublication) || configurationPublication.beforeSha256 !== runtimeDiscovery.configurationSha256) {
      throw new Error("Managed configuration publication plan differs from the retained discovery input.");
    }
  }
  const deployment = await (dependencies.deploy ?? deploy)({ expectedCommit, candidateBinary, expectedBinarySha256, deploymentAcceptancePath });
  const deployed = deployment.receipt;
  validateUnderlyingDeployment(deployed, expectedCommit, expectedBinarySha256);
  if (configurationPublication) runtimeDiscovery.acceptConfigurationPublication(configurationPublication);
  await (dependencies.accept ?? assertDeploymentRuntime)(root);
  unchanged(snapshot); source(expectedCommit); absent(candidate.adapter);
  // Installed SDK/source paths and adapter source may differ after deployment.
  // Replan with the installed generation and apply only a changed final adapter.
  const final = (dependencies.inspectFinal ?? inspectWebRuntimeMaintenance)(finalOptions);
  if (JSON.stringify(cohort(final.adapter)) !== JSON.stringify(cohort(candidate.adapter))) throw new Error("Final adapter runtime differs from the reviewed official cohort.");
  if (final.plan.changed) {
    absent(final.adapter);
    await (dependencies.refreshFinal ?? refreshWebRuntime)({ ...finalOptions, apply: true, forceServiceReplacement: true, expectedMaintenance: binding(final) });
  }
  unchanged(snapshot); source(expectedCommit); absent(final.adapter);
  await (dependencies.accept ?? assertDeploymentRuntime)(root);
  const actual = (dependencies.inspectActual ?? inspectWebRuntimeMaintenance)(finalOptions);
  if (actual.plan.changed || JSON.stringify(cohort(actual.adapter)) !== JSON.stringify(cohort(candidate.adapter))) throw new Error("Final installed adapter did not retain the reviewed official cohort.");
  return { version: 1, accepted: true, routerCommit: expectedCommit.toLowerCase(), candidateSha256: expectedCandidateSha256,
    sourceRoot: root, candidateBinary: path.resolve(candidateBinary), switchyardBinarySha256: expectedBinarySha256.toLowerCase(), codexReopenRequired: true,
    deployment: deployed, deploymentAcceptancePath, deploymentResultPath: deployment.resultPath,
    configurationPublication,
    finalAdapter: { generation: actual.adapter.generation, managedDirectory: path.dirname(actual.adapter.managedEntryPath),
      officialRuntime: cohort(actual.adapter), sdkPackageJson: actual.adapter.candidate.sdkPackageJson },
    ledgers: { sha256: hash(JSON.stringify(snapshot)), count: snapshot.filter(row => row.kind !== "sidecar").length,
      sidecarCount: snapshot.filter(row => row.kind === "sidecar").length, uncertainSends: snapshot.filter(row => row.uncertainSend).length },
    retainedPriorAdapter: { generation: candidate.adapter.generation,
      managedDirectory: path.dirname(candidate.adapter.managedEntryPath), runtimeModule: candidate.adapter.currentRuntime.runtimeModule,
      liveRollbackQualified: false },
    checks: Object.fromEntries(checks.map(name => [name, true])) };
}

export function validateWebMaintenanceAcceptance(value, expectedCommit, expectedCandidateSha256, candidateBinary, expectedBinarySha256) {
  validateUnderlyingDeployment(value?.deployment, expectedCommit, expectedBinarySha256);
  if (value?.version !== 1 || value.accepted !== true || value.routerCommit !== expectedCommit.toLowerCase()
      || value.candidateSha256 !== expectedCandidateSha256 || value.sourceRoot !== root
      || value.candidateBinary !== path.resolve(candidateBinary) || value.switchyardBinarySha256 !== expectedBinarySha256.toLowerCase()
      || !path.isAbsolute(value.deploymentAcceptancePath ?? "") || !path.isAbsolute(value.deploymentResultPath ?? "") || !path.isAbsolute(value.finalAdapter?.managedDirectory ?? "")
      || value.codexReopenRequired !== true || checks.some(name => value.checks?.[name] !== true)
      || value.configurationPublication !== undefined && value.configurationPublication !== null && !validConfigurationPublication(value.configurationPublication)
      || !/^[a-f0-9]{64}$/u.test(value.ledgers?.sha256 ?? "") || !Number.isSafeInteger(value.ledgers?.count) || value.ledgers.count < 0
      || !Number.isSafeInteger(value.ledgers?.sidecarCount) || value.ledgers.sidecarCount < 0
      || !Number.isSafeInteger(value.ledgers?.uncertainSends) || value.ledgers.uncertainSends < 0 || value.ledgers.uncertainSends > value.ledgers.count
      || !path.isAbsolute(value.retainedPriorAdapter?.managedDirectory ?? "") || !path.isAbsolute(value.retainedPriorAdapter?.runtimeModule ?? "")
      || value.retainedPriorAdapter?.liveRollbackQualified !== false
      || Object.keys(value.checks ?? {}).length !== checks.length) throw new Error("Web maintenance did not publish complete acceptance for the reviewed candidate.");
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, expectedCommit, candidateBinary, expectedBinarySha256, fingerprint, seconds, receiptPath] = process.argv.slice(2);
    if (command === "plan") {
      const candidate = prepareWebMaintenance(expectedCommit, candidateBinary, expectedBinarySha256);
      process.stdout.write(`${JSON.stringify({ candidateSha256: candidate.candidateSha256, plan: candidate.plan, next: "Worker will wait for a full normal Codex quit, then refresh and deploy. Reopen Codex only after its protected result reports success." })}\n`);
    } else if (command === "run") {
      const result = await runWebMaintenance({ expectedCommit, candidateBinary, expectedBinarySha256, expectedCandidateSha256: fingerprint,
        timeoutMs: Number(seconds) * 1000, deploymentAcceptancePath: `${receiptPath}.router.json` }, {
        onWaiting() {
          writePrivateFile(path.join(path.dirname(receiptPath), "result.json"), `${JSON.stringify({ state: "waiting-for-codex-exit", processId: process.pid, candidateSha256: fingerprint })}\n`);
          console.log("Reviewed candidate validated. Waiting for a full normal Codex quit; reopen only after the protected result reports success.");
        },
      });
      writePrivateFile(receiptPath, `${JSON.stringify(result)}\n`);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === "accept") {
      // CLI order: commit, binary, binary hash, candidate digest, receipt path.
      if (!privateFileIsProtected(seconds)) throw new Error("Maintenance acceptance is not protected.");
      validateWebMaintenanceAcceptance(JSON.parse(readFileSync(seconds, "utf8")), expectedCommit, fingerprint, candidateBinary, expectedBinarySha256);
    } else throw new Error("Unknown Web maintenance command.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
