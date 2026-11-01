// Explicit same-chat abandonment. Inspection never changes the browser or a
// conversation ledger; confirmation is an offline, locked state transaction.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserScript, parseBrowserOutput, reconcileControlledRecoverySnapshot } from "../src/web-browser.mjs";
import { validWebConversation, WEB_RECOVERY_INPUT_POLICY } from "../src/web-runtime.mjs";
import { privateFileIsProtected, writePrivateFile } from "../src/file-security.mjs";
import { readWebBridgeSettings } from "../src/chatgpt-web.mjs";
import { STATE_DIR, PORTS, loopback } from "../src/paths.mjs";
import { withServiceOperationLock } from "../src/service-operation-lock.mjs";
import { withDirectoryLock } from "../src/directory-lock.mjs";
import { inspectWebRuntimeMaintenance } from "../src/web-runtime-refresh.mjs";
import { assertWebMaintenanceAbsent } from "../src/web-maintenance-proof.mjs";
import { readServiceProcessState, assertServiceProcessStopped } from "../src/service-process.mjs";
import { windowsScheduledTaskState } from "../src/windows-task-state.mjs";
import { conclusivelyRefused } from "../src/transport-error-graph.mjs";
import { isUtf8 } from "node:buffer";
import { jsonIsUnambiguousForRewrite } from "../src/namespace-relay.mjs";
import { createNativeCompactionWitness, nativeCompactionSource, nativeCompactionWitnessReference,
  nativeCompactionWitnessPath, validNativeCompactionWitness, readCanonicalNativeSource as acquireCanonicalNativeSource } from "../src/web-native-compaction.mjs";
import { guardedWebConversation, inspectNativeCompactionSource, isCanonicalWebAppIngress } from "../src/web-runtime.mjs";

const hash = bytes => createHash("sha256").update(typeof bytes === "string" || Buffer.isBuffer(bytes) ? bytes : JSON.stringify(bytes)).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const failure = message => Object.assign(new Error(message), { code: "web_recovery_refused" });
const recoveryInputPolicy = Object.freeze({ mode: WEB_RECOVERY_INPUT_POLICY,
  disposition: "ALL canonical native input through the first recovery-only request is abandoned and unconfirmed",
  opaqueCompaction: "exact whole-item fingerprints only; never decoded, rendered or sent",
  nativeHistory: "retained at its original native owners", acceptedWebCheckpoint: "unchanged" });
const json = bytes => { try { return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); } catch { throw failure("Recovery input is not valid JSON."); } };
function readProtected(file, isPrivate = privateFileIsProtected) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 * 1024 || !isPrivate(file)) throw failure("Recovery requires protected bounded regular files.");
  for (let cursor = path.dirname(file); ; cursor = path.dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw failure("Recovery refuses linked paths.");
    if (cursor === path.dirname(cursor)) break;
  }
  const bytes = readFileSync(file), after = lstatSync(file);
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw failure("Recovery input changed during inspection.");
  return bytes;
}
function readOptionalProtected(file, isPrivate) {
  try { return readProtected(file, isPrivate); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

// Native owns rollout permissions. Acquire its explicitly selected source with
// a bound descriptor, then retain a protected immutable copy at Router's owner;
// never harden, rewrite or require Router-specific ACLs on native history.
export function readCanonicalNativeSource(file) {
  try { return acquireCanonicalNativeSource(file); }
  catch (error) { throw failure(error.message); }
}
const nativeSourceSnapshotPath = (threadId, sha256, options) => path.join(options.stateDir ?? STATE_DIR,
  "web-in-app", "restoration", `${threadId}.native-source-${sha256}.jsonl`);
function retainNativeSource(threadId, bytes, options) {
  const file = nativeSourceSnapshotPath(threadId, hash(bytes), options);
  preserveOriginal(file, bytes, options);
  return file;
}
function ledger(threadId, options) {
  if (!uuid.test(threadId ?? "")) throw failure("Recovery requires an exact native thread UUID.");
  const file = path.join(options.stateDir ?? STATE_DIR, "web-in-app", "conversations", `${threadId}.json`);
  const bytes = readProtected(file, options.isPrivate), value = json(bytes);
  if (!validWebConversation(value, threadId) || value.uncertainSend !== true || value.unresolvedCoding.length
      || !value.checkpoint || value.generationCompleted !== true || value.observation?.completed !== true
      || value.observation.assistantPrefix.length < 1 || value.needsHistory || value.rolloverRequired
      || value.recovery?.stage === "armed") throw failure("Recovery requires an uncertain attempt, a completed accepted checkpoint, and no unresolved actions or recovery.");
  return { file, bytes, value };
}
const proofFor = value => ({ tabId: value.tabId, chatUrl: value.chatUrl, failedTurnId: value.lastTurn.turnId,
  generationTurnKey: value.generationTurnKey, sendBaselineReplyIds: value.sendBaselineReplyIds,
  generationReplyIds: value.generationReplyIds, observation: value.observation,
  priorRevokedTurnIds: [...(value.recovery?.revokedTurnIds ?? [])] });

export function inspectControlledWebRecovery(threadId, options = {}) {
  const { value, bytes } = ledger(threadId, options);
  const settings = options.settings ?? readWebBridgeSettings();
  const request = { version: 1, threadId, failedTurnId: value.lastTurn.turnId, ledgerSha256: hash(bytes),
    snapshotPolicy: "semantic-v1",
    browser: settings.browser, bindingId: value.bindingId, expectedOwnerTurnIds: value.browserOwnerTurnIds,
    proof: proofFor(value), frameToken: randomBytes(24).toString("hex") };
  const program = browserScript({ operation: "recover", inspectionOnly: true, sessionId: threadId,
    turnId: request.failedTurnId, bindingId: request.bindingId, expectedOwnerTurnIds: request.expectedOwnerTurnIds,
    recoveryProof: request.proof, snapshotPolicy: request.snapshotPolicy, frameToken: request.frameToken, ...request.browser });
  const moduleSource = `export default async function inspectWebRecovery(nodeRepl) {\n${program}\n}\n`;
  return { request, program, moduleSource };
}

export function prepareControlledWebRecovery(request, receipt, options = {}) {
  if (request?.snapshotPolicy !== "semantic-v1") throw failure("New recovery plans require the current semantic inspection; retain raw evidence only for explicit snapshot revision or rollback.");
  const current = ledger(request.threadId, options);
  if (hash(current.bytes) !== request.ledgerSha256 || hash(proofFor(current.value)) !== hash(request.proof)
      || request.failedTurnId !== current.value.lastTurn.turnId || request.bindingId !== current.value.bindingId
      || hash(request.expectedOwnerTurnIds) !== hash(current.value.browserOwnerTurnIds)) throw failure("The inspected recovery ledger changed.");
  const observed = parseBrowserOutput(receipt, request.frameToken, "recover");
  if (observed.operation !== "recover" || observed.inspectionOnly !== true || !observed.snapshot
      || observed.snapshot.idle !== true || observed.snapshot.emptyComposer !== true
      || observed.snapshot.originalTabId !== current.value.tabId || observed.snapshot.chatUrl !== current.value.chatUrl
      || typeof observed.tabId !== "string" || !observed.tabId
      || hash(observed.snapshot) !== observed.snapshotSha256
      || !reconcileControlledRecoverySnapshot(observed.snapshot, request.proof, hash, observed.snapshot)) throw failure("Recovery requires the exact read-only idle browser receipt.");
  const plan = { version: 1, journalVersion: 3, disposition: "abandon-unconfirmed-attempt", request,
    inputPolicy: { ...recoveryInputPolicy },
    snapshotPolicy: request.snapshotPolicy,
    snapshotSha256: observed.snapshotSha256, snapshot: observed.snapshot, inspectionTabId: observed.tabId, inspectionEffects: observed.effects,
    nextRequest: "recovery-only-no-send" };
  return { plan, confirmationSha256: hash(plan) };
}

export async function assertControlledRecoveryOffline({ inspect = inspectWebRuntimeMaintenance, absent = assertWebMaintenanceAbsent,
  taskState = windowsScheduledTaskState, fetchImpl = fetch, readProcess = readServiceProcessState, stopped = assertServiceProcessStopped } = {}) {
  const adapter = inspect().adapter;
  absent(adapter);
  const task = await taskState({ includeEnabled: true });
  if (!task || task.instanceCount !== 0 || task.launcherAlive !== false || task.enabled !== false) throw failure("The managed Router task is not proven stopped and disabled.");
  let refused = false;
  try { await fetchImpl(loopback(PORTS.router, "/live"), { signal: AbortSignal.timeout(3000), redirect: "error" }); }
  catch (error) { if (conclusivelyRefused(error)) refused = true; else throw failure("Router listener absence is unknown."); }
  if (!refused) throw failure("The Router must already be stopped; recovery does not stop it.");
  stopped(readProcess());
  absent(adapter);
}

// Same ownership lock as the adapter installer, without installing or rolling
// back anything. The service operation lock excludes cooperative start/deploy.
const adapterLocked = (operation, stateDir) => withDirectoryLock(operation, {
  target: path.join(stateDir, "web-stop-adapter", "ownership.json"), waitMs: 2000, retryMs: 25, heartbeatMs: 10000,
  defaults: { waitMs: 2000, retryMs: 25, heartbeatMs: 10000 },
  lockedError: () => failure("Another adapter operation owns recovery."),
  releaseErrorKey: "adapterLockReleaseError", releaseErrorMessage: () => "Recovery adapter ownership lock release failed.",
});
const locked = (operation, stateDir) => withServiceOperationLock(() => adapterLocked(operation, stateDir), { stateDir });
const restorationLock = options => options.lock ?? (options.serviceAlreadyLocked ? adapterLocked : locked);

export async function confirmControlledWebRecovery(plan, confirmationSha256, options = {}) {
  if (plan?.version !== 1 || plan.snapshotPolicy !== "semantic-v1" || plan.journalVersion !== 3 || plan.disposition !== "abandon-unconfirmed-attempt" || plan.nextRequest !== "recovery-only-no-send"
      || !plan.inputPolicy || hash(plan.inputPolicy) !== hash(recoveryInputPolicy)
      || hash(plan) !== confirmationSha256 || hash(plan.snapshot) !== plan.snapshotSha256
      || !reconcileControlledRecoverySnapshot(plan.snapshot, plan.request.proof, hash, plan.snapshot)
      || plan.snapshot.idle !== true || plan.snapshot.emptyComposer !== true) throw failure("Explicit confirmation must match this complete recovery plan's SHA-256.");
  const stateDir = options.stateDir ?? STATE_DIR, write = options.write ?? writePrivateFile;
  return (options.lock ?? locked)(async () => {
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    const current = ledger(plan.request.threadId, options);
    if (hash(current.bytes) !== plan.request.ledgerSha256 || hash(proofFor(current.value)) !== hash(plan.request.proof)) throw failure("The confirmed ledger changed; prepare another review.");
    const archive = `${current.file}.abandoned-${plan.request.failedTurnId}-${plan.request.ledgerSha256}.original`;
    const archived = readOptionalProtected(archive, options.isPrivate);
    if (archived !== undefined) {
      if (hash(archived) !== plan.request.ledgerSha256) throw failure("The retained original archive changed.");
    } else write(archive, current.bytes);
    if (hash(readProtected(archive, options.isPrivate)) !== plan.request.ledgerSha256) throw failure("The original ledger archive could not be verified.");
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    if (hash(readProtected(current.file, options.isPrivate)) !== plan.request.ledgerSha256) throw failure("The ledger changed before recovery publication.");
    let next = { ...current.value, version: plan.journalVersion, priorVersion: undefined, nativeCompactionProjection: undefined,
      recovery: { stage: "armed", ledgerSha256: plan.request.ledgerSha256, confirmationSha256,
      inputPolicy: WEB_RECOVERY_INPUT_POLICY,
      snapshotPolicy: plan.snapshotPolicy, snapshot: plan.snapshot,
      revokedTurnIds: [...new Set([...(current.value.recovery?.revokedTurnIds ?? []), plan.request.failedTurnId])],
      snapshotSha256: plan.snapshotSha256, inspectionTabId: plan.inspectionTabId, inspectionEffects: plan.inspectionEffects, proof: plan.request.proof } };
    if (current.value.nativeCompactionProjection) next = guardedWebConversation(next, {
      nativeCompactionProjection: current.value.nativeCompactionProjection });
    if (!validWebConversation(next, next.threadId)) throw failure("The armed recovery record is invalid.");
    write(current.file, `${JSON.stringify(next, null, 2)}\n`);
    if (hash(readProtected(current.file, options.isPrivate)) !== hash(`${JSON.stringify(next, null, 2)}\n`)) throw failure("Recovery publication readback failed; retain original archive and inspect before retrying.");
    return { threadId: next.threadId, failedTurnId: plan.request.failedTurnId, confirmationSha256, archive, state: "armed",
      next: "Reopen Codex normally. The first new native request only records a recovery boundary; send a fresh instruction afterward." };
  }, stateDir);
}

// Rollback restores only the original uncertainty guard. It is never an
// automatic compensation and never restores a broker token or browser action.
export async function restoreControlledWebRecoveryGuard(plan, confirmationSha256, options = {}) {
  if (hash(plan) !== confirmationSha256 || plan?.disposition !== "abandon-unconfirmed-attempt") throw failure("Guard restoration requires explicit confirmation of the exact recovery plan.");
  const stateDir = options.stateDir ?? STATE_DIR, write = options.write ?? writePrivateFile;
  return (options.lock ?? locked)(async () => {
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    const threadId = plan.request.threadId;
    if (!uuid.test(threadId)) throw failure("Invalid recovery thread identity.");
    const file = path.join(stateDir, "web-in-app", "conversations", `${threadId}.json`), bytes = readProtected(file, options.isPrivate), value = json(bytes);
    const archive = `${file}.abandoned-${plan.request.failedTurnId}-${plan.request.ledgerSha256}.original`;
    const original = readProtected(archive, options.isPrivate), prior = json(original);
    if (!validWebConversation(value, threadId) || (value.version === 4 ? value.priorVersion : value.version) !== (plan.journalVersion ?? 2) || value.recovery.confirmationSha256 !== confirmationSha256
        || hash(original) !== plan.request.ledgerSha256 || !validWebConversation(prior, threadId) || prior.uncertainSend !== true
        || hash(value.checkpoint) !== hash(prior.checkpoint) || value.generationTurnKey !== prior.generationTurnKey
        || JSON.stringify(value.nativeCompactionProjection) !== JSON.stringify(prior.nativeCompactionProjection)
        || value.unresolvedCoding.length || value.lastTurn.sendState !== "abandoned" && value.lastTurn.turnId !== plan.request.failedTurnId) throw failure("Recovery advanced or changed; restoring an old guard would lose current evidence.");
    const retained = `${file}.guard-restore-${hash(bytes)}.original`;
    if (readOptionalProtected(retained, options.isPrivate) === undefined) write(retained, bytes);
    if (hash(readProtected(retained, options.isPrivate)) !== hash(bytes)) throw failure("The recovery journal archive could not be verified.");
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    if (hash(readProtected(file, options.isPrivate)) !== hash(bytes)) throw failure("Recovery changed before guard restoration.");
    write(file, original);
    if (hash(readProtected(file, options.isPrivate)) !== plan.request.ledgerSha256) throw failure("Original uncertainty guard readback failed.");
    return { threadId, state: "original-uncertainty-guard-restored", retained, archive };
  }, stateDir);
}

function snapshotRevisionOwner(sourcePlan, sourceConfirmationSha256, options) {
  const sourceVersion = sourcePlan?.journalVersion ?? 2;
  if (sourcePlan?.version !== 1 || ![2, 3].includes(sourceVersion) || sourcePlan.disposition !== "abandon-unconfirmed-attempt"
      || !sourcePlan.request || !Array.isArray(sourcePlan.snapshot?.replies) || hash(sourcePlan) !== sourceConfirmationSha256
      || hash(sourcePlan.snapshot) !== sourcePlan.snapshotSha256) throw failure("Snapshot revision requires the exact previously approved abandonment plan.");
  const threadId = sourcePlan.request?.threadId;
  if (!uuid.test(threadId ?? "")) throw failure("Snapshot revision requires the original native conversation identity.");
  const file = path.join(options.stateDir ?? STATE_DIR, "web-in-app", "conversations", `${threadId}.json`);
  const bytes = readProtected(file, options.isPrivate), value = json(bytes), recovery = value.recovery;
  const journalVersion = value.version === 4 ? value.priorVersion : value.version;
  const armed = recovery?.stage === "armed" && value.uncertainSend === true && value.lastTurn?.turnId === recovery.proof?.failedTurnId;
  const bounded = recovery?.stage === "bounded" && value.uncertainSend === false
    && (value.lastTurn?.sendState === "abandoned" && value.lastTurn.completed === true || value.lastTurn?.sendState === "unsent" && value.lastTurn.completed === false)
    && (sourceVersion === 2 || recovery.boundaryOwner?.threadId === threadId);
  if (!validWebConversation(value, threadId) || journalVersion !== sourceVersion || !armed && !bounded || recovery.snapshotPolicy !== undefined
      || recovery.confirmationSha256 !== sourceConfirmationSha256 || recovery.snapshotSha256 !== sourcePlan.snapshotSha256
      || recovery.ledgerSha256 !== sourcePlan.request.ledgerSha256 || hash(recovery.proof) !== hash(sourcePlan.request.proof)
      || value.unresolvedCoding.length || value.pendingBrowserOpen || value.generationCompleted !== true || value.observation?.completed !== true) {
    throw failure("Only an intact armed or bounded raw-snapshot guard can receive an explicitly reviewed semantic snapshot without changing its existing input policy.");
  }
  const original = `${file}.abandoned-${recovery.proof.failedTurnId}-${recovery.ledgerSha256}.original`;
  if (hash(readProtected(original, options.isPrivate)) !== recovery.ledgerSha256) throw failure("The original uncertainty archive changed.");
  return { file, bytes, value };
}

function snapshotRevisionIntent(value) {
  const journalVersion = value.version === 4 ? value.priorVersion : value.version, recovery = value.recovery;
  // Preserve the already approved V3 armed plan's exact serialized contract.
  if (journalVersion === 3 && recovery.stage === "armed") return { disposition: "revise-armed-recovery-snapshot", nextRequest: "recovery-only-no-send" };
  return { disposition: "revise-recovery-snapshot", preservedRecovery: { journalVersion, stage: recovery.stage, inputPolicy: recovery.inputPolicy ?? null },
    nextRequest: recovery.stage === "armed" ? "recovery-only-no-send" : "continue-existing-boundary-after-saved-chat-proof" };
}

function revisionRequestMatches(request, value) {
  const intent = snapshotRevisionIntent(value);
  return request.disposition === intent.disposition && JSON.stringify(request.preservedRecovery) === JSON.stringify(intent.preservedRecovery);
}

export function inspectControlledWebRecoverySnapshotRevision(sourcePlan, sourceConfirmationSha256, options = {}) {
  const current = snapshotRevisionOwner(sourcePlan, sourceConfirmationSha256, options), value = current.value, intent = snapshotRevisionIntent(value);
  const settings = options.settings ?? readWebBridgeSettings();
  const request = { version: 1, disposition: intent.disposition, ...(intent.preservedRecovery ? { preservedRecovery: intent.preservedRecovery } : {}), threadId: value.threadId,
    ledgerSha256: hash(current.bytes), sourcePlan, sourceConfirmationSha256, snapshotPolicy: "semantic-v1",
    browser: settings.browser, bindingId: value.bindingId, expectedOwnerTurnIds: value.browserOwnerTurnIds,
    proof: value.recovery.proof, frameToken: randomBytes(24).toString("hex") };
  const program = browserScript({ operation: "recover", inspectionOnly: true, sessionId: request.threadId,
    turnId: request.proof.failedTurnId, bindingId: request.bindingId, expectedOwnerTurnIds: request.expectedOwnerTurnIds,
    recoveryProof: request.proof, snapshotPolicy: request.snapshotPolicy, frameToken: request.frameToken, ...request.browser });
  return { request, program, moduleSource: `export default async function inspectWebRecoverySnapshotRevision(nodeRepl) {\n${program}\n}\n` };
}

export function prepareControlledWebRecoverySnapshotRevision(request, receipt, options = {}) {
  if (request?.version !== 1 || !["revise-armed-recovery-snapshot", "revise-recovery-snapshot"].includes(request.disposition) || request.snapshotPolicy !== "semantic-v1") {
    throw failure("Snapshot revision requires its exact inspection request.");
  }
  const current = snapshotRevisionOwner(request.sourcePlan, request.sourceConfirmationSha256, options), intent = snapshotRevisionIntent(current.value);
  if (hash(current.bytes) !== request.ledgerSha256 || request.threadId !== current.value.threadId
      || request.bindingId !== current.value.bindingId || hash(request.proof) !== hash(current.value.recovery.proof)
      || !revisionRequestMatches(request, current.value)
      || hash(request.expectedOwnerTurnIds) !== hash(current.value.browserOwnerTurnIds)) throw failure("The recovery ledger, stage or input policy changed during inspection.");
  const observed = parseBrowserOutput(receipt, request.frameToken, "recover");
  if (observed.operation !== "recover" || observed.inspectionOnly !== true || !observed.tabId
      || hash(observed.snapshot) !== observed.snapshotSha256 || !reconcileControlledRecoverySnapshot(observed.snapshot, request.proof, hash, observed.snapshot)) {
    throw failure("Snapshot revision requires a complete idle semantic browser proof.");
  }
  // Raw turn hashes cannot establish semantic equivalence. Keep their original
  // receipt intact; only the existing normalized reply identities/text can be
  // compared at the accepted boundary. The new plan deliberately approves the
  // fresh accepted-forward bodies; older baseline bodies carry no authority.
  for (const prior of request.sourcePlan.snapshot.replies) {
    const currentReply = observed.snapshot.replies.find(reply => reply.messageId === prior.messageId);
    if (currentReply && hash(currentReply) !== hash(prior)) throw failure("A previously approved assistant reply changed.");
  }
  const plan = { version: 1, disposition: intent.disposition, request,
    ...(intent.preservedRecovery ? { preservedRecovery: intent.preservedRecovery } : { inputPolicy: { ...recoveryInputPolicy } }), snapshotPolicy: "semantic-v1", snapshot: observed.snapshot,
    snapshotSha256: observed.snapshotSha256, inspectionTabId: observed.tabId, inspectionEffects: observed.effects,
    nextRequest: intent.nextRequest };
  return { plan, confirmationSha256: hash(plan) };
}

function validateSnapshotRevisionPlan(plan, confirmationSha256) {
  const preserved = plan?.preservedRecovery;
  const armedV3 = plan?.disposition === "revise-armed-recovery-snapshot" && plan.request?.disposition === plan.disposition
    && plan.nextRequest === "recovery-only-no-send" && preserved === undefined && plan.request.preservedRecovery === undefined
    && plan.inputPolicy && hash(plan.inputPolicy) === hash(recoveryInputPolicy);
  const preserving = plan?.disposition === "revise-recovery-snapshot" && plan.request?.disposition === plan.disposition
    && preserved && [2, 3].includes(preserved.journalVersion) && ["armed", "bounded"].includes(preserved.stage)
    && !(preserved.journalVersion === 3 && preserved.stage === "armed")
    && preserved.inputPolicy === (preserved.journalVersion === 2 ? null : WEB_RECOVERY_INPUT_POLICY)
    && JSON.stringify(preserved) === JSON.stringify(plan.request.preservedRecovery) && plan.inputPolicy === undefined
    && plan.nextRequest === (preserved.stage === "armed" ? "recovery-only-no-send" : "continue-existing-boundary-after-saved-chat-proof");
  if (plan?.version !== 1 || !armedV3 && !preserving
      || hash(plan) !== confirmationSha256 || plan.snapshotPolicy !== "semantic-v1"
      || hash(plan.snapshot) !== plan.snapshotSha256 || !reconcileControlledRecoverySnapshot(plan.snapshot, plan.request?.proof, hash, plan.snapshot)) {
    throw failure("Explicit confirmation must match the complete semantic snapshot revision plan.");
  }
}

function revisedSnapshotLedger(current, plan, confirmationSha256) {
  return { ...current, recovery: { ...current.recovery, confirmationSha256, snapshotPolicy: plan.snapshotPolicy,
    snapshot: plan.snapshot, snapshotSha256: plan.snapshotSha256, inspectionTabId: plan.inspectionTabId, inspectionEffects: plan.inspectionEffects,
    snapshotRevision: { priorConfirmationSha256: plan.request.sourceConfirmationSha256,
      priorSnapshotSha256: plan.request.sourcePlan.snapshotSha256,
      ...(plan.preservedRecovery ? { sourceLedgerSha256: plan.request.ledgerSha256, sourceStage: current.recovery.stage } : { armedLedgerSha256: plan.request.ledgerSha256 }) } } };
}

export async function confirmControlledWebRecoverySnapshotRevision(plan, confirmationSha256, options = {}) {
  validateSnapshotRevisionPlan(plan, confirmationSha256);
  const stateDir = options.stateDir ?? STATE_DIR, write = options.write ?? writePrivateFile;
  return (options.lock ?? locked)(async () => {
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    const current = snapshotRevisionOwner(plan.request.sourcePlan, plan.request.sourceConfirmationSha256, options);
    if (hash(current.bytes) !== plan.request.ledgerSha256 || !revisionRequestMatches(plan.request, current.value)) throw failure("The recovery ledger, stage or input policy changed after snapshot revision approval.");
    const archive = `${current.file}.snapshot-revision-${plan.request.ledgerSha256}.original`;
    preserveOriginal(archive, current.bytes, options);
    const next = revisedSnapshotLedger(current.value, plan, confirmationSha256);
    if (!validWebConversation(next, next.threadId)) throw failure("The revised semantic recovery record is invalid.");
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    if (hash(readProtected(current.file, options.isPrivate)) !== plan.request.ledgerSha256) throw failure("Recovery changed before semantic snapshot publication.");
    const bytes = `${JSON.stringify(next, null, 2)}\n`;
    write(current.file, bytes);
    if (hash(readProtected(current.file, options.isPrivate)) !== hash(bytes)) throw failure("Snapshot revision publication readback failed; inspect retained evidence before retrying.");
    return { threadId: next.threadId, state: `${next.recovery.stage}-semantic-snapshot`, confirmationSha256, archive,
      next: next.recovery.stage === "armed" ? "Reopen Codex normally. The first new native request still records only the recovery boundary; no input is sent."
        : "Reopen Codex normally. Fresh input continues after saved-chat proof; the recorded input boundary is preserved and no new input is abandoned by this revision." };
  }, stateDir);
}

export async function rollbackControlledWebRecoverySnapshotRevision(plan, confirmationSha256, options = {}) {
  validateSnapshotRevisionPlan(plan, confirmationSha256);
  const stateDir = options.stateDir ?? STATE_DIR, write = options.write ?? writePrivateFile;
  return (options.lock ?? locked)(async () => {
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    const file = path.join(stateDir, "web-in-app", "conversations", `${plan.request.threadId}.json`);
    const bytes = readProtected(file, options.isPrivate), current = json(bytes);
    const archive = `${file}.snapshot-revision-${plan.request.ledgerSha256}.original`, original = readProtected(archive, options.isPrivate);
    if (hash(original) !== plan.request.ledgerSha256 || !validWebConversation(current, plan.request.threadId)
        || hash(current) !== hash(revisedSnapshotLedger(json(original), plan, confirmationSha256))) {
      throw failure("Snapshot revision advanced or changed; rollback would discard current evidence.");
    }
    const retained = `${file}.snapshot-revision-rollback-${hash(bytes)}.original`;
    preserveOriginal(retained, bytes, options);
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    if (hash(readProtected(file, options.isPrivate)) !== hash(bytes)) throw failure("Recovery changed before snapshot revision rollback.");
    write(file, original);
    if (hash(readProtected(file, options.isPrivate)) !== plan.request.ledgerSha256) throw failure("Raw-snapshot guard rollback readback failed.");
    return { threadId: plan.request.threadId, state: `${json(original).recovery.stage}-raw-snapshot-restored`, archive, retained };
  }, stateDir);
}

// Restoring readable compaction history does not abandon input or change the
// accepted browser checkpoint. Canonical source is a provenance-labelled import,
// never a claim that the original provider request can be reconstructed exactly.
export function canonicalNativeCompactionSource(bytes, threadId) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!isUtf8(bytes) || bytes.length > 16 * 1024 * 1024 || !bytes.length || bytes.at(-1) !== 10) {
    throw failure("Canonical compaction requires a bounded complete UTF-8 rollout.");
  }
  let offset = 0, meta, compacted, priorClock = -Infinity;
  const input = [];
  for (const line of bytes.toString("utf8").split(/(?<=\n)/u)) {
    if (!line) continue;
    const length = Buffer.byteLength(line), start = offset;
    offset += length;
    if (!jsonIsUnambiguousForRewrite(line)) throw failure("Canonical rollout contains ambiguous JSON.");
    const row = json(line), clock = Date.parse(row.timestamp);
    if (!Number.isFinite(clock) || clock < priorClock) throw failure("Canonical rollout chronology is ambiguous.");
    priorClock = clock;
    if (row.type === "session_meta") {
      if (meta || start !== 0 || row.payload?.id !== threadId || typeof row.payload.base_instructions?.text !== "string") {
        throw failure("Canonical rollout lacks its unique native session instructions.");
      }
      meta = row.payload;
      input.push({ role: "developer", content: meta.base_instructions.text });
    } else if (row.type === "compacted") {
      if (!meta || compacted || !Array.isArray(row.payload?.replacement_history)) throw failure("Canonical restoration requires exactly one original compaction.");
      const opaqueItems = row.payload.replacement_history.filter(item => item?.type === "compaction");
      if (opaqueItems.length !== 1 || typeof opaqueItems[0].encrypted_content !== "string" || !opaqueItems[0].encrypted_content.length) {
        throw failure("Canonical compaction has no unique opaque replacement item.");
      }
      compacted = { opaqueItem: opaqueItems[0], responseId: row.payload.compaction_response_id ?? null,
        byteStart: start, byteEnd: offset, recordSha256: hash(bytes.subarray(start, offset)),
        sourcePrefixSha256: hash(bytes.subarray(0, start)), replacementSha256: hash(row.payload.replacement_history) };
    } else if (row.type === "response_item") {
      if (!meta || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) throw failure("Canonical native item is invalid.");
      if (!compacted) {
        if (row.payload.type === "compaction") throw failure("An earlier native compaction has no readable canonical lineage.");
        if (row.payload.type === "function_call_output" && row.payload.call_id === undefined) {
          // These app-native instruction records are data in this canonical
          // session, not evidence that a historical native action executed.
          if (!isCanonicalWebAppIngress(row.payload)) {
            throw failure("Canonical call-less input lacks its exact native app ingress attribution.");
          }
        }
        input.push(row.payload);
      }
    } else if (row.type === "world_state") {
      // Native state/accounting records accompany response_item history. Keep
      // their original bytes in evidence; admit only these exact metadata forms.
      const state = row.payload;
      if (!state || Object.keys(state).sort().join() !== "full,state" || typeof state.full !== "boolean"
          || !state.state || typeof state.state !== "object" || Array.isArray(state.state)) throw failure("Canonical world-state metadata has an unknown shape.");
    } else if (row.type === "token_usage_record") {
      const usage = row.payload;
      if (!usage || Object.keys(usage).sort().join() !== "response_id,root_turn_id,session_id,thread_id,thread_token_usage,turn_id,turn_token_usage,usage"
          || usage.thread_id !== threadId || ![usage.turn_id, usage.root_turn_id, usage.session_id].every(value => uuid.test(value ?? ""))
          || typeof usage.response_id !== "string" || !usage.response_id
          || ![usage.usage, usage.turn_token_usage, usage.thread_token_usage].every(value => value && typeof value === "object" && !Array.isArray(value))) {
        throw failure("Canonical token-usage metadata lacks its native identity and shape.");
      }
    } else if (!["event_msg", "turn_context"].includes(row.type)) throw failure("Canonical rollout has an unknown record kind.");
  }
  if (!meta || !compacted) throw failure("Canonical restoration requires its native session and compaction boundary.");
  return { source: nativeCompactionSource(input), ...compacted };
}

function restorationLedger(threadId, options) {
  if (!uuid.test(threadId ?? "")) throw failure("Restoration requires an exact native thread UUID.");
  const file = path.join(options.stateDir ?? STATE_DIR, "web-in-app", "conversations", `${threadId}.json`);
  const bytes = readProtected(file, options.isPrivate), value = json(bytes);
  if (!validWebConversation(value, threadId) || value.uncertainSend || value.unresolvedCoding.length || value.pendingBrowserOpen
      || value.nativeCompactionProjection || value.lastTurn.sendState !== "unsent" || value.lastTurn.completed !== false
      || !value.checkpoint?.length || value.generationCompleted !== true || value.observation?.completed !== true
      || value.observation.assistantPrefix.length < 1 || value.needsHistory || value.rolloverRequired
      || value.recovery?.stage === "armed") throw failure("Restoration requires a definitely unsent attempt and an intact completed checkpoint without unresolved actions.");
  return { file, bytes, value };
}
const restorationDisposition = "restore-readable-native-compaction-existing-chat";
const restorationBrowserRequest = (current, settings) => ({ version: 1, threadId: current.value.threadId,
  failedTurnId: current.value.lastTurn.turnId, ledgerSha256: hash(current.bytes), browser: settings.browser,
  bindingId: current.value.bindingId, expectedOwnerTurnIds: current.value.browserOwnerTurnIds,
  proof: proofFor(current.value), frameToken: randomBytes(24).toString("hex") });

export function inspectNativeCompactionRestoration(threadId, rolloutPath, options = {}) {
  if (!path.isAbsolute(rolloutPath ?? "")) throw failure("Restoration requires the absolute canonical rollout path.");
  const current = restorationLedger(threadId, options), bytes = readCanonicalNativeSource(rolloutPath);
  const canonical = canonicalNativeCompactionSource(bytes, threadId);
  inspectNativeCompactionSource(canonical.source, current.value);
  const sourceSnapshotPath = retainNativeSource(threadId, bytes, options);
  const witness = createNativeCompactionWitness({ threadId, source: canonical.source, opaqueItem: canonical.opaqueItem,
    responseId: canonical.responseId, checkpoint: current.value.checkpoint,
    provenance: { kind: "canonical-readable-history", rolloutSha256: hash(bytes), rolloutByteLength: bytes.length,
      boundary: { byteStart: canonical.byteStart, byteEnd: canonical.byteEnd, recordSha256: canonical.recordSha256,
        sourcePrefixSha256: canonical.sourcePrefixSha256, replacementSha256: canonical.replacementSha256 } } });
  const request = { ...restorationBrowserRequest(current, options.settings ?? readWebBridgeSettings()), snapshotPolicy: "semantic-v1",
    disposition: restorationDisposition, rolloutPath, sourceSnapshotPath, sourceBytes: bytes.length, sourceSha256: hash(bytes), canonical, witness };
  const program = browserScript({ operation: "recover", inspectionOnly: true, sessionId: threadId,
    turnId: request.failedTurnId, bindingId: request.bindingId, expectedOwnerTurnIds: request.expectedOwnerTurnIds,
    recoveryProof: request.proof, snapshotPolicy: request.snapshotPolicy, frameToken: request.frameToken, ...request.browser });
  return { request, program, moduleSource: `export default async function inspectNativeCompactionRestoration(nodeRepl) {\n${program}\n}\n` };
}

function checkRestorationRequest(request, options) {
  const current = restorationLedger(request?.threadId, options);
  if (request.disposition !== restorationDisposition || hash(current.bytes) !== request.ledgerSha256
      || hash(proofFor(current.value)) !== hash(request.proof) || request.bindingId !== current.value.bindingId
      || request.failedTurnId !== current.value.lastTurn.turnId || hash(request.expectedOwnerTurnIds) !== hash(current.value.browserOwnerTurnIds)
      || !path.isAbsolute(request.rolloutPath ?? "")) throw failure("The inspected restoration ledger changed.");
  if (request.sourceSnapshotPath !== nativeSourceSnapshotPath(request.threadId, request.sourceSha256, options)) throw failure("Canonical source snapshot identity changed.");
  const originalSource = readProtected(request.sourceSnapshotPath, options.isPrivate);
  if (originalSource.length !== request.sourceBytes || hash(originalSource) !== request.sourceSha256) throw failure("Protected canonical source snapshot changed.");
  const sourceBytes = readCanonicalNativeSource(request.rolloutPath);
  if (!Number.isSafeInteger(request.sourceBytes) || request.sourceBytes < 1 || sourceBytes.length < request.sourceBytes
      || hash(sourceBytes.subarray(0, request.sourceBytes)) !== request.sourceSha256) throw failure("Canonical native source changed after inspection.");
  const canonical = canonicalNativeCompactionSource(sourceBytes, request.threadId);
  if (hash(canonical) !== hash(request.canonical) || !validNativeCompactionWitness(request.witness, { threadId: request.threadId, opaqueItem: canonical.opaqueItem })
      || request.witness.sourceSha256 !== hash(canonical.source) || request.witness.checkpointSha256 !== hash(current.value.checkpoint)
      || request.witness.provenance.kind !== "canonical-readable-history" || request.witness.provenance.rolloutSha256 !== request.sourceSha256
      || request.witness.provenance.rolloutByteLength !== request.sourceBytes
      || hash(request.witness.provenance.boundary) !== hash({ byteStart: canonical.byteStart, byteEnd: canonical.byteEnd,
        recordSha256: canonical.recordSha256, sourcePrefixSha256: canonical.sourcePrefixSha256, replacementSha256: canonical.replacementSha256 })) {
    throw failure("Canonical compaction witness does not match the retained source and accepted checkpoint.");
  }
  inspectNativeCompactionSource(canonical.source, current.value);
  return { ...current, sourceBytes };
}

export function prepareNativeCompactionRestoration(request, receipt, options = {}) {
  if (request?.snapshotPolicy !== "semantic-v1") throw failure("Native compaction restoration requires a fresh current semantic inspection.");
  const current = checkRestorationRequest(request, options);
  const observed = parseBrowserOutput(receipt, request.frameToken, "recover");
  if (observed.operation !== "recover" || observed.inspectionOnly !== true || !observed.snapshot
      || observed.snapshot.idle !== true || observed.snapshot.emptyComposer !== true
      || observed.snapshot.originalTabId !== current.value.tabId || observed.snapshot.chatUrl !== current.value.chatUrl
      || typeof observed.tabId !== "string" || !observed.tabId || hash(observed.snapshot) !== observed.snapshotSha256
      || !reconcileControlledRecoverySnapshot(observed.snapshot, request.proof, hash, observed.snapshot)) {
    throw failure("Restoration requires the exact read-only idle saved-chat receipt.");
  }
  // Inspection itself may append native tool records. Preserve their new complete
  // source snapshot as well; apply refuses any further append or rewrite.
  const rolloutSnapshotPath = retainNativeSource(request.threadId, current.sourceBytes, options);
  const plan = { version: 1, disposition: restorationDisposition, request, rolloutSnapshotPath,
    rolloutBytes: current.sourceBytes.length, rolloutSha256: hash(current.sourceBytes), snapshot: observed.snapshot,
    snapshotSha256: observed.snapshotSha256, inspectionTabId: observed.tabId, inspectionEffects: observed.effects,
    nextRequest: "ordinary-saved-chat-recovery-required-before-send" };
  return { plan, confirmationSha256: hash(plan) };
}

function validRestorationPlan(plan, confirmationSha256, { allowHistoricalSnapshot = false } = {}) {
  if (plan?.version !== 1 || plan.disposition !== restorationDisposition || hash(plan) !== confirmationSha256
      || plan.nextRequest !== "ordinary-saved-chat-recovery-required-before-send" || hash(plan.snapshot) !== plan.snapshotSha256
      || plan.snapshot?.idle !== true || plan.snapshot.emptyComposer !== true) throw failure("Restoration requires the exact reviewed plan's SHA-256.");
  if (!allowHistoricalSnapshot && (plan.request?.snapshotPolicy !== "semantic-v1"
      || !reconcileControlledRecoverySnapshot(plan.snapshot, plan.request.proof, hash, plan.snapshot))) {
    throw failure("Native compaction restoration requires the current semantic snapshot; raw historical plans qualify only for explicit rollback.");
  }
}
function checkPreparedNativeSource(plan, current, options) {
  if (plan.rolloutSnapshotPath !== nativeSourceSnapshotPath(plan.request.threadId, plan.rolloutSha256, options)) throw failure("Prepared canonical source snapshot identity changed.");
  const snapshot = readProtected(plan.rolloutSnapshotPath, options.isPrivate);
  if (snapshot.length !== plan.rolloutBytes || hash(snapshot) !== plan.rolloutSha256
      || current.sourceBytes.length !== plan.rolloutBytes || hash(current.sourceBytes) !== plan.rolloutSha256) throw failure("Canonical rollout changed after plan preparation.");
}
export function inspectNativeCompactionRestorationPlan(planPath, confirmationSha256, options = {}) {
  if (!path.isAbsolute(planPath ?? "")) throw failure("Restoration plan must have an absolute protected path.");
  const planBytes = readProtected(planPath, options.isPrivate), plan = json(planBytes);
  validRestorationPlan(plan, confirmationSha256);
  const current = checkRestorationRequest(plan.request, options);
  checkPreparedNativeSource(plan, current, options);
  const reference = nativeCompactionWitnessReference(plan.request.witness);
  const next = guardedWebConversation(current.value, { nativeCompactionProjection: [reference] });
  if (!validWebConversation(next, current.value.threadId)) throw failure("Restored native compaction ledger is invalid.");
  const archive = `${current.file}.native-compaction-${confirmationSha256}.original`, rolloutArchive = `${archive}.rollout.jsonl`;
  const witnessFile = nativeCompactionWitnessPath(options.stateDir ?? STATE_DIR, current.value.threadId, reference.opaqueSha256);
  return { plan, threadId: current.value.threadId, confirmationSha256, planFileSha256: hash(planBytes), ledgerPath: current.file,
    sourceLedgerSha256: plan.request.ledgerSha256, resultLedgerSha256: hash(`${JSON.stringify(next, null, 2)}\n`),
    beforeLedgerSha256: plan.request.ledgerSha256, afterLedgerSha256: hash(`${JSON.stringify(next, null, 2)}\n`),
    witnessFile, witnessFileSha256: hash(`${JSON.stringify(plan.request.witness, null, 2)}\n`), witnessSha256: reference.witnessSha256,
    expectedSidecars: [{ name: path.basename(archive), sha256: hash(current.bytes) },
      { name: path.basename(rolloutArchive), sha256: plan.rolloutSha256 },
      { name: path.basename(witnessFile), sha256: hash(`${JSON.stringify(plan.request.witness, null, 2)}\n`) }] };
}
function preserveOriginal(file, bytes, options) {
  const existing = readOptionalProtected(file, options.isPrivate);
  if (existing === undefined) (options.write ?? writePrivateFile)(file, bytes);
  if (hash(readProtected(file, options.isPrivate)) !== hash(bytes)) throw failure("Restoration archive readback failed.");
}

export async function applyNativeCompactionRestoration(plan, confirmationSha256, options = {}) {
  validRestorationPlan(plan, confirmationSha256);
  const stateDir = options.stateDir ?? STATE_DIR, write = options.write ?? writePrivateFile;
  return restorationLock(options)(async () => {
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    const current = checkRestorationRequest(plan.request, options);
    checkPreparedNativeSource(plan, current, options);
    const archive = `${current.file}.native-compaction-${confirmationSha256}.original`;
    const rolloutArchive = `${archive}.rollout.jsonl`;
    preserveOriginal(archive, current.bytes, options);
    preserveOriginal(rolloutArchive, current.sourceBytes, options);
    const witness = plan.request.witness, reference = nativeCompactionWitnessReference(witness);
    const witnessFile = nativeCompactionWitnessPath(stateDir, current.value.threadId, reference.opaqueSha256);
    const witnessBytes = `${JSON.stringify(witness, null, 2)}\n`;
    // Orphaned sidecars on failure are harmless. Never publish a reference until
    // its protected immutable witness and both source archives were read back.
    preserveOriginal(witnessFile, witnessBytes, options);
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    if (hash(readProtected(current.file, options.isPrivate)) !== plan.request.ledgerSha256
        || hash(readCanonicalNativeSource(plan.request.rolloutPath)) !== plan.rolloutSha256) {
      throw failure("Restoration source changed before ledger publication.");
    }
    const next = guardedWebConversation(current.value, { nativeCompactionProjection: [reference] });
    if (!validWebConversation(next, current.value.threadId)) throw failure("Restored native compaction ledger is invalid.");
    const nextBytes = `${JSON.stringify(next, null, 2)}\n`;
    write(current.file, nextBytes);
    if (hash(readProtected(current.file, options.isPrivate)) !== hash(nextBytes)) throw failure("Restoration ledger readback failed; retain exact archives before retrying.");
    return { threadId: next.threadId, state: "readable-native-compaction-restored", confirmationSha256, archive, rolloutArchive,
      witnessFile, ledgerSha256: hash(nextBytes), witnessSha256: reference.witnessSha256,
      next: "Resume the same native chat; ordinary exact saved-checkpoint recovery is still required before Send." };
  }, stateDir);
}

export async function rollbackNativeCompactionRestoration(plan, confirmationSha256, options = {}) {
  validRestorationPlan(plan, confirmationSha256, { allowHistoricalSnapshot: true });
  const stateDir = options.stateDir ?? STATE_DIR, write = options.write ?? writePrivateFile;
  return restorationLock(options)(async () => {
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    if (!uuid.test(plan.request?.threadId ?? "")) throw failure("Invalid restoration rollback identity.");
    const file = path.join(stateDir, "web-in-app", "conversations", `${plan.request.threadId}.json`);
    const archive = `${file}.native-compaction-${confirmationSha256}.original`, original = readProtected(archive, options.isPrivate);
    const current = readProtected(file, options.isPrivate), prior = json(original);
    if (hash(original) !== plan.request.ledgerSha256 || !validWebConversation(prior, plan.request.threadId)) throw failure("Restoration original archive changed.");
    const expected = guardedWebConversation(prior, { nativeCompactionProjection: [nativeCompactionWitnessReference(plan.request.witness)] });
    if (hash(json(current)) !== hash(expected)) throw failure("Restoration advanced; rollback would lose current evidence.");
    const retained = `${file}.native-compaction-rollback-${hash(current)}.original`;
    preserveOriginal(retained, current, options);
    await (options.assertOffline ?? assertControlledRecoveryOffline)();
    if (hash(readProtected(file, options.isPrivate)) !== hash(current)) throw failure("Restoration changed before rollback.");
    write(file, original);
    if (hash(readProtected(file, options.isPrivate)) !== plan.request.ledgerSha256) throw failure("Restoration rollback readback failed.");
    return { threadId: plan.request.threadId, state: "original-native-compaction-guard-restored", archive, retained };
  }, stateDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second, third] = process.argv.slice(2);
    if (command === "inspect") {
      const { request, moduleSource } = inspectControlledWebRecovery(first);
      writePrivateFile(second, `${JSON.stringify(request, null, 2)}\n`);
      writePrivateFile(`${second}.browser.mjs`, moduleSource);
      console.log(JSON.stringify({ threadId: first, failedTurnId: request.failedTurnId, ledgerSha256: request.ledgerSha256,
        request: second, browserProgram: `${second}.browser.mjs`, next: "Import this non-sending inspection module in the owning native browser REPL and call default(nodeRepl); save its exact framed receipt privately." }));
    } else if (command === "prepare") {
      const request = json(readProtected(first)), receipt = readProtected(second).toString("utf8");
      const result = prepareControlledWebRecovery(request, receipt);
      writePrivateFile(third, `${JSON.stringify(result.plan, null, 2)}\n`);
      console.log(JSON.stringify({ confirmationSha256: result.confirmationSha256, threadId: request.threadId, failedTurnId: request.failedTurnId,
        ledgerSha256: request.ledgerSha256, snapshotSha256: result.plan.snapshotSha256,
        journalVersion: result.plan.journalVersion, disposition: result.plan.disposition, inputPolicy: result.plan.inputPolicy, nextRequest: result.plan.nextRequest, plan: third }));
    } else if (command === "confirm") {
      console.log(JSON.stringify(await confirmControlledWebRecovery(json(readProtected(first)), second)));
    } else if (command === "restore-guard") {
      console.log(JSON.stringify(await restoreControlledWebRecoveryGuard(json(readProtected(first)), second)));
    } else if (command === "inspect-snapshot-revision") {
      const { request, moduleSource } = inspectControlledWebRecoverySnapshotRevision(json(readProtected(first)), second);
      writePrivateFile(third, `${JSON.stringify(request, null, 2)}\n`);
      writePrivateFile(`${third}.browser.mjs`, moduleSource);
      console.log(JSON.stringify({ threadId: request.threadId, ledgerSha256: request.ledgerSha256, request: third,
        browserProgram: `${third}.browser.mjs`, next: "Run this non-sending semantic inspection in the owning native browser REPL; retain its exact private receipt." }));
    } else if (command === "prepare-snapshot-revision") {
      const result = prepareControlledWebRecoverySnapshotRevision(json(readProtected(first)), readProtected(second).toString("utf8"));
      writePrivateFile(third, `${JSON.stringify(result.plan, null, 2)}\n`);
      console.log(JSON.stringify({ threadId: result.plan.request.threadId, confirmationSha256: result.confirmationSha256,
        snapshotSha256: result.plan.snapshotSha256, disposition: result.plan.disposition, nextRequest: result.plan.nextRequest, plan: third }));
    } else if (command === "confirm-snapshot-revision") {
      console.log(JSON.stringify(await confirmControlledWebRecoverySnapshotRevision(json(readProtected(first)), second)));
    } else if (command === "rollback-snapshot-revision") {
      console.log(JSON.stringify(await rollbackControlledWebRecoverySnapshotRevision(json(readProtected(first)), second)));
    } else if (command === "inspect-native-compaction") {
      const { request, moduleSource } = inspectNativeCompactionRestoration(first, second);
      writePrivateFile(third, `${JSON.stringify(request, null, 2)}\n`);
      writePrivateFile(`${third}.browser.mjs`, moduleSource);
      console.log(JSON.stringify({ threadId: first, ledgerSha256: request.ledgerSha256, sourceSha256: request.sourceSha256,
        request: third, browserProgram: `${third}.browser.mjs`, disposition: request.disposition,
        next: "Run only this read-only inspection module in the owning native browser REPL; retain its exact framed receipt privately." }));
    } else if (command === "prepare-native-compaction") {
      const result = prepareNativeCompactionRestoration(json(readProtected(first)), readProtected(second).toString("utf8"));
      writePrivateFile(third, `${JSON.stringify(result.plan, null, 2)}\n`);
      console.log(JSON.stringify({ threadId: result.plan.request.threadId, confirmationSha256: result.confirmationSha256,
        disposition: result.plan.disposition, ledgerSha256: result.plan.request.ledgerSha256,
        rolloutSha256: result.plan.rolloutSha256, snapshotSha256: result.plan.snapshotSha256, plan: third }));
    } else if (command === "apply-native-compaction") {
      const { plan } = inspectNativeCompactionRestorationPlan(first, second);
      console.log(JSON.stringify(await applyNativeCompactionRestoration(plan, second)));
    } else if (command === "rollback-native-compaction") {
      console.log(JSON.stringify(await rollbackNativeCompactionRestoration(json(readProtected(first)), second)));
    } else throw failure("Use inspect/prepare/confirm for controlled abandonment, or inspect-native-compaction <thread> <canonical-rollout> <private-request>, prepare-native-compaction <private-request> <private-receipt> <private-plan>, apply-native-compaction <private-plan> <reviewed-sha256>, or rollback-native-compaction <private-plan> <reviewed-sha256>.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
