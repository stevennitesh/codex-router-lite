// Explicit same-chat abandonment. Inspection never changes the browser or a
// conversation ledger; confirmation is an offline, locked state transaction.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserScript, parseBrowserOutput } from "../src/web-browser.mjs";
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
    browser: settings.browser, bindingId: value.bindingId, expectedOwnerTurnIds: value.browserOwnerTurnIds,
    proof: proofFor(value), frameToken: randomBytes(24).toString("hex") };
  const program = browserScript({ operation: "recover", inspectionOnly: true, sessionId: threadId,
    turnId: request.failedTurnId, bindingId: request.bindingId, expectedOwnerTurnIds: request.expectedOwnerTurnIds,
    recoveryProof: request.proof, frameToken: request.frameToken, ...request.browser });
  const moduleSource = `export default async function inspectWebRecovery(nodeRepl) {\n${program}\n}\n`;
  return { request, program, moduleSource };
}

export function prepareControlledWebRecovery(request, receipt, options = {}) {
  const current = ledger(request.threadId, options);
  if (hash(current.bytes) !== request.ledgerSha256 || hash(proofFor(current.value)) !== hash(request.proof)
      || request.failedTurnId !== current.value.lastTurn.turnId || request.bindingId !== current.value.bindingId
      || hash(request.expectedOwnerTurnIds) !== hash(current.value.browserOwnerTurnIds)) throw failure("The inspected recovery ledger changed.");
  const observed = parseBrowserOutput(receipt, request.frameToken, "recover");
  if (observed.operation !== "recover" || observed.inspectionOnly !== true || !observed.snapshot
      || observed.snapshot.idle !== true || observed.snapshot.emptyComposer !== true
      || observed.snapshot.originalTabId !== current.value.tabId || observed.snapshot.chatUrl !== current.value.chatUrl
      || typeof observed.tabId !== "string" || !observed.tabId
      || hash(observed.snapshot) !== observed.snapshotSha256) throw failure("Recovery requires the exact read-only idle browser receipt.");
  const plan = { version: 1, journalVersion: 3, disposition: "abandon-unconfirmed-attempt", request,
    inputPolicy: { ...recoveryInputPolicy },
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
const locked = (operation, stateDir) => withServiceOperationLock(() => withDirectoryLock(operation, {
  target: path.join(stateDir, "web-stop-adapter", "ownership.json"), waitMs: 2000, retryMs: 25, heartbeatMs: 10000,
  defaults: { waitMs: 2000, retryMs: 25, heartbeatMs: 10000 },
  lockedError: () => failure("Another adapter operation owns recovery."),
  releaseErrorKey: "adapterLockReleaseError", releaseErrorMessage: () => "Recovery adapter ownership lock release failed.",
}), { stateDir });

export async function confirmControlledWebRecovery(plan, confirmationSha256, options = {}) {
  if (plan?.version !== 1 || plan.journalVersion !== 3 || plan.disposition !== "abandon-unconfirmed-attempt" || plan.nextRequest !== "recovery-only-no-send"
      || !plan.inputPolicy || hash(plan.inputPolicy) !== hash(recoveryInputPolicy)
      || hash(plan) !== confirmationSha256 || hash(plan.snapshot) !== plan.snapshotSha256
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
    const next = { ...current.value, version: plan.journalVersion, recovery: { stage: "armed", ledgerSha256: plan.request.ledgerSha256, confirmationSha256,
      inputPolicy: WEB_RECOVERY_INPUT_POLICY,
      revokedTurnIds: [...new Set([...(current.value.recovery?.revokedTurnIds ?? []), plan.request.failedTurnId])],
      snapshotSha256: plan.snapshotSha256, inspectionTabId: plan.inspectionTabId, inspectionEffects: plan.inspectionEffects, proof: plan.request.proof } };
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
    if (!validWebConversation(value, threadId) || value.version !== (plan.journalVersion ?? 2) || value.recovery.confirmationSha256 !== confirmationSha256
        || hash(original) !== plan.request.ledgerSha256 || !validWebConversation(prior, threadId) || prior.uncertainSend !== true
        || hash(value.checkpoint) !== hash(prior.checkpoint) || value.generationTurnKey !== prior.generationTurnKey
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
    } else throw failure("Use inspect <thread> <private-request>, prepare <private-request> <private-receipt> <private-plan>, or confirm <private-plan> <explicitly-approved-sha256>.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
