import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { assertControlledRecoveryOffline, canonicalNativeCompactionSource, inspectNativeCompactionRestoration,
  prepareNativeCompactionRestoration, inspectNativeCompactionRestorationPlan, applyNativeCompactionRestoration,
  rollbackNativeCompactionRestoration, readCanonicalNativeSource, inspectControlledWebRecovery, prepareControlledWebRecovery,
  confirmControlledWebRecovery, restoreControlledWebRecoveryGuard, inspectControlledWebRecoverySnapshotRevision,
  prepareControlledWebRecoverySnapshotRevision, confirmControlledWebRecoverySnapshotRevision,
  rollbackControlledWebRecoverySnapshotRevision } from "../maintenance/web-recovery.mjs";
import { reconcileControlledRecoverySnapshot, parseBrowserOutput, readBrowserReplies, browserDom } from "../src/web-browser.mjs";
import { domElement, domText } from "./web-dom-fixture.mjs";
import { validWebConversation } from "../src/web-runtime.mjs";
import { nativeCompactionWitnessReference, readNativeCompactionWitness } from "../src/web-native-compaction.mjs";

const refused = () => Promise.reject(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
const offline = () => ({ inspect: () => ({ adapter: {} }), absent: () => {},
  taskState: async () => ({ instanceCount: 0, launcherAlive: false, enabled: false }),
  fetchImpl: refused, readProcess: () => undefined, stopped: state => assert.equal(state, undefined) });

test("controlled recovery requires disabled task, native census, recorded exit and conclusively absent listener without draining", async () => {
  const calls = [], dependencies = offline();
  dependencies.absent = () => calls.push("census");
  dependencies.fetchImpl = (url, options) => {
    assert.ok(url.endsWith("/live"));
    assert.equal(options.method, undefined, "Offline proof issues only a read, never a lifecycle mutation.");
    return refused();
  };
  await assertControlledRecoveryOffline(dependencies);
  assert.deepEqual(calls, ["census", "census"]);
  for (const changed of [
    { taskState: async () => undefined },
    { taskState: async () => ({ instanceCount: 0, launcherAlive: false }) },
    { taskState: async () => ({ instanceCount: 0, launcherAlive: false, enabled: true }) },
    { taskState: async () => ({ instanceCount: 1, launcherAlive: true, enabled: false }) },
    { fetchImpl: async () => ({ ok: true }) },
    { fetchImpl: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
    { stopped: () => { throw new Error("recorded process identity is alive or unknown"); } },
    { absent: () => { throw new Error("native runtime process remains"); } },
  ]) await assert.rejects(assertControlledRecoveryOffline({ ...offline(), ...changed }));
});

const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const restorationThread = "00112233-4455-6677-8899-aabbccddeeff";
const acceptedTurn = "11112233-4455-6677-8899-aabbccddeeff";
const failedTurn = "22112233-4455-6677-8899-aabbccddeeff";
const replyId = "33112233-4455-6677-8899-aabbccddeeff";
const row = (type, payload, index) => JSON.stringify({ timestamp: new Date(1700000000000 + index).toISOString(), type, payload }) + "\n";
const nativeMessage = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const appIngress = (name, text) => ({ type: "function_call_output", id: `native-${name}`, namespace: "codex_app", name, output: text,
  internal_chat_message_metadata_passthrough: { turn_id: acceptedTurn, create_time: 1700000000 } });

function restorationFixture(t, { sourceChange } = {}) {
  const scratch = path.resolve(".tmp"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "restore-native-compaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, "web-in-app", "conversations", `${restorationThread}.json`), rolloutPath = path.join(root, "canonical.jsonl");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const acceptedText = "Previously accepted saved answer";
  const checkpoint = [{ role: "developer", content: "Native base instructions" }, { role: "user", content: "Repeated context" },
    { role: "user", content: "Repeated context" }, { type: "function_call_output", output: "Initial native user instructions" }].map(hash);
  const ledger = { version: 1, threadId: restorationThread, bindingId: "router_restore_fixture", browserOwnerTurnIds: [acceptedTurn, failedTurn],
    tabId: "original-tab", chatUrl: "https://chatgpt.com/c/6ae3ec8e-6740-83e9-a2ce-ff8730be1648", checkpoint,
    sendBaseline: 0, sendBaselineReplyIds: [], generationTurnKey: acceptedTurn, generationReplyIds: [replyId], generationCompleted: true,
    observation: { replyId, replyCount: 1, completed: true, assistantPrefix: { length: acceptedText.length, sha256: hash(acceptedText) } },
    uncertainSend: false, unresolvedCoding: [], lastTurn: { turnId: failedTurn, sendState: "unsent", completed: false } };
  assert.equal(validWebConversation(ledger, restorationThread), true);
  const source = [nativeMessage("user", "Repeated context"), nativeMessage("user", "Repeated context"),
    appIngress("create_thread", "Initial native user instructions"), nativeMessage("assistant", acceptedText),
    nativeMessage("user", "Genuinely undelivered work"),
    { id: "fc-native", type: "function_call", namespace: "mcp__work", name: "read", call_id: "call_native", arguments: '{"path":"fixture"}' },
    { type: "function_call_output", call_id: "call_native", output: "Actual native result" },
    appIngress("send_message_to_thread", "Native user ingress must remain readable"),
    { type: "configuration_update", reasoning: { effort: "high" } },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Ignored reasoning" }] }];
  sourceChange?.(source);
  const opaqueItem = { type: "compaction", encrypted_content: "opaque-fixture-never-decoded" };
  const rows = [row("session_meta", { id: restorationThread, base_instructions: { text: "Native base instructions" } }, 0),
    row("world_state", { full: true, state: { environment: { cwd: "fixture-native-state" } } }, 1),
    ...source.map((item, index) => row("response_item", item, index + 2)),
    row("token_usage_record", { thread_id: restorationThread, turn_id: failedTurn, session_id: restorationThread, root_turn_id: acceptedTurn,
      response_id: "resp_fixture_usage", usage: { input_tokens: 1 }, turn_token_usage: {}, thread_token_usage: {} }, source.length + 2),
    row("compacted", { replacement_history: [nativeMessage("developer", "Current developer"), opaqueItem], compaction_response_id: "resp_compact_fixture" }, source.length + 3)];
  writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, "utf8"); writeFileSync(rolloutPath, rows.join(""), "utf8");
  const options = { stateDir: root, isPrivate: () => true, settings: { browser: { runtimeModule: "file:///fixture/browser.mjs" } },
    lock: operation => operation(), assertOffline: async () => {}, write: (file, bytes) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); } };
  const inspect = () => inspectNativeCompactionRestoration(restorationThread, rolloutPath, options);
  const receipt = request => {
    const snapshot = { ...(request.snapshotPolicy ? { version: 2 } : {}), originalTabId: ledger.tabId, chatUrl: ledger.chatUrl,
      turns: [request.snapshotPolicy ? { turnKey: acceptedTurn, complete: true, revokedTurnId: null,
        messages: [{ role: "user", length: 8, sha256: hash("accepted") }, { role: "assistant", length: acceptedText.length, sha256: hash(acceptedText), replyIds: [replyId] }] }
        : { turnKey: acceptedTurn, sha256: hash("accepted") }],
      replies: [{ messageId: replyId, turnKey: acceptedTurn, sha256: hash(acceptedText) }], idle: true, emptyComposer: true };
    return `ROUTER_WEB_BROWSER_${request.frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: { operation: "recover", inspectionOnly: true,
      snapshot, snapshotSha256: hash(snapshot), tabId: ledger.tabId, effects: { tabReopened: false, tabNavigated: false, handoffMarked: false } } })}\nROUTER_WEB_BROWSER_${request.frameToken}_END`;
  };
  const prepare = () => { const { request } = inspect(); return prepareNativeCompactionRestoration(request, receipt(request), options); };
  return { root, ledger, ledgerPath, rolloutPath, opaqueItem, options, inspect, receipt, prepare };
}

test("canonical restoration preserves duplicates, actual results and configuration while binding one exact opaque boundary", async t => {
  const f = restorationFixture(t), original = readFileSync(f.ledgerPath), rollout = readFileSync(f.rolloutPath);
  const inspection = f.inspect(), canonical = canonicalNativeCompactionSource(rollout, restorationThread);
  assert.equal(canonical.source.filter(item => item.role === "user" && item.content[0].text === "Repeated context").length, 2);
  assert.equal(canonical.source.some(item => item.type === "reasoning"), false);
  assert.deepEqual(canonical.source.at(-1), { type: "configuration_update", reasoning: { effort: "high" } });
  assert.ok(canonical.source.some(item => item.name === "send_message_to_thread" && item.output === "Native user ingress must remain readable"));
  assert.ok(inspection.moduleSource.startsWith("export default async function"));
  assert.equal(hash(readFileSync(f.ledgerPath)), hash(original));
  const prepared = prepareNativeCompactionRestoration(inspection.request, f.receipt(inspection.request), f.options);
  const planFile = path.join(f.root, "plan.json"); writeFileSync(planFile, JSON.stringify(prepared.plan));
  const review = inspectNativeCompactionRestorationPlan(planFile, prepared.confirmationSha256, f.options);
  assert.equal(review.expectedSidecars.length, 3);
  const result = await applyNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256, f.options);
  assert.equal(hash(readFileSync(result.archive)), hash(original));
  assert.equal(hash(readFileSync(result.rolloutArchive)), hash(rollout));
  const restored = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
  assert.equal(restored.version, 4); assert.equal(restored.priorVersion, 1);
  assert.deepEqual(restored.checkpoint, f.ledger.checkpoint); assert.equal(restored.uncertainSend, false);
  assert.equal(restored.recovery, undefined); assert.deepEqual(restored.lastTurn, f.ledger.lastTurn);
  assert.equal(validWebConversation(restored, restorationThread), true);
  assert.equal(hash(readFileSync(f.ledgerPath)), review.afterLedgerSha256);
  const witness = readNativeCompactionWitness({ stateDir: f.root, threadId: restorationThread, reference: restored.nativeCompactionProjection[0], stateIsProtected: () => true });
  assert.deepEqual(nativeCompactionWitnessReference(witness), restored.nativeCompactionProjection[0]);
  assert.deepEqual(witness.source, canonical.source);
  await rollbackNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256, f.options);
  assert.equal(hash(readFileSync(f.ledgerPath)), hash(original));
});

test("controlled abandonment preserves a restored native-compaction guard and rolls back to its exact original bytes", async t => {
  const f = restorationFixture(t), prepared = f.prepare();
  await applyNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256, f.options);
  const value = JSON.parse(readFileSync(f.ledgerPath)); value.uncertainSend = true; value.lastTurn.sendState = "uncertain";
  writeFileSync(f.ledgerPath, JSON.stringify(value)); const original = readFileSync(f.ledgerPath);
  const { request } = inspectControlledWebRecovery(restorationThread, f.options);
  const recovery = prepareControlledWebRecovery(request, f.receipt(request), f.options);
  await confirmControlledWebRecovery(recovery.plan, recovery.confirmationSha256, f.options);
  const armed = JSON.parse(readFileSync(f.ledgerPath));
  assert.equal(validWebConversation(armed, restorationThread), true);
  assert.equal(armed.version, 4); assert.equal(armed.priorVersion, 3); assert.equal(armed.recovery.stage, "armed");
  assert.deepEqual(armed.nativeCompactionProjection, value.nativeCompactionProjection);
  assert.deepEqual(armed.checkpoint, value.checkpoint); assert.equal(armed.uncertainSend, true);
  await restoreControlledWebRecoveryGuard(recovery.plan, recovery.confirmationSha256, f.options);
  assert.deepEqual(readFileSync(f.ledgerPath), original);
});

const olderTurn = "44112233-4455-6677-8899-aabbccddeeff", olderReply = "55112233-4455-6677-8899-aabbccddeeff";
const semanticMessage = (role, text, replyIds = []) => ({ role, length: text.length, sha256: hash(text), ...(role === "assistant" ? { replyIds } : {}) });

test("recovery projects the observed rich-text user and scoped assistant markdown profile without author-role attributes", () => {
  const user = domElement("div", { class: "rich-text-user-turn MarkdownRoot-fixture" },
    domElement("p", { class: "Paragraph-fixture" }, domElement("span", {}, domText("Exact native prompt\nRouter generation: native-owner"))));
  const answer = domElement("div", { "data-markdown-text-style": "assistant-message" }, domElement("p", {}, domText("Exact accepted reply")));
  const wrapper = domElement("div", { "data-chatgpt-selection-message-id": replyId, class: "group flex min-w-0 flex-col" }, answer);
  const turn = domElement("section", { "data-turn-key": acceptedTurn },
    domElement("div", { "data-talvt-turn-state": "complete" }, user, wrapper));
  const inspect = () => readBrowserReplies([turn, answer], { ui: browserDom, assistantSelector: browserDom.assistantFinalReplySelector,
    projection: "recovery", recoveryGenerationTurnKey: acceptedTurn });
  const projected = inspect();
  assert.equal(projected.turns[0].recoveryProjectionComplete, true);
  assert.deepEqual(projected.turns[0].recoveryMessages, [{ role: "user", text: "Exact native prompt\nRouter generation: native-owner", replyIds: [] },
    { role: "assistant", text: "Exact accepted reply", replyIds: [replyId] }]);
  assert.equal(turn.querySelectorAll("[data-message-author-role]").length, 0);
  user.setAttribute("class", "MarkdownRoot-without-user-profile");
  assert.equal(inspect().turns[0].recoveryMessages.some(message => message.role === "user"), false);
  user.setAttribute("class", "rich-text-user-turn");
  const unknownStatus = domElement("div", { "data-streaming-response-status": "active" }, domText("Unattributed output"));
  turn.children.push(unknownStatus); turn.childNodes.push(unknownStatus); unknownStatus.parentElement = turn;
  assert.equal(inspect().turns[0].recoveryProjectionComplete, false);
});

function semanticRevisionReceipt(f, request, { scoped = true } = {}) {
  const observed = parseBrowserOutput(f.receipt(request), request.frameToken, "recover");
  observed.snapshot.turns.unshift({ turnKey: olderTurn, complete: true, revokedTurnId: null,
    messages: [semanticMessage("user", "Known older user payload"), semanticMessage("assistant", "Known older baseline reply", [olderReply])] });
  observed.snapshot.replies.unshift({ messageId: olderReply, turnKey: olderTurn, sha256: hash("Known older baseline reply") });
  if (scoped) observed.snapshot = reconcileControlledRecoverySnapshot(observed.snapshot, request.proof, hash);
  observed.snapshotSha256 = hash(observed.snapshot);
  return { observed, frame: () => `ROUTER_WEB_BROWSER_${request.frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: observed })}\nROUTER_WEB_BROWSER_${request.frameToken}_END` };
}

test("semantic recovery scopes exact content to acceptance and admits only identity-proven older baseline turns", t => {
  const f = restorationFixture(t), proof = { ...f.ledger, observation: f.ledger.observation,
    sendBaselineReplyIds: [olderReply, "88112233-4455-6677-8899-aabbccddeeff"], failedTurnId: failedTurn };
  const request = { proof, snapshotPolicy: "semantic-v1", frameToken: "a".repeat(48) };
  const { observed } = semanticRevisionReceipt(f, request, { scoped: false }), current = observed.snapshot;
  proof.tabId = f.ledger.tabId; proof.chatUrl = f.ledger.chatUrl;
  const expected = reconcileControlledRecoverySnapshot(current, proof, hash);
  assert.equal(expected.turns[0].turnKey, acceptedTurn); assert.equal(expected.turns.length, 1);
  const virtualized = structuredClone(current); virtualized.turns.shift(); virtualized.replies.shift();
  assert.deepEqual(reconcileControlledRecoverySnapshot(virtualized, proof, hash, expected), expected);
  const remounted = structuredClone(current), knownReply = proof.sendBaselineReplyIds[1];
  remounted.turns.unshift({ turnKey: "99112233-4455-6677-8899-aabbccddeeff", complete: true, revokedTurnId: null,
    messages: [semanticMessage("user", "Previously uninspected historical body"), semanticMessage("assistant", "Older mounted output", [knownReply])] });
  remounted.replies.unshift({ messageId: knownReply, turnKey: remounted.turns[0].turnKey, sha256: hash("Older mounted output") });
  assert.deepEqual(reconcileControlledRecoverySnapshot(remounted, proof, hash, expected), expected);
  remounted.turns[1].messages[0] = semanticMessage("user", "Historical text carries no new input authority");
  assert.deepEqual(reconcileControlledRecoverySnapshot(remounted, proof, hash, expected), expected);
  for (const [name, change] of [
    ["unknown user-only prefix", value => { value.turns.unshift({ turnKey: "66112233-4455-6677-8899-aabbccddeeff", complete: true,
      revokedTurnId: null, messages: [semanticMessage("user", "Unknown earlier user-only payload")] }); }],
    ["unknown baseline reply", value => { value.replies[0].messageId = "66112233-4455-6677-8899-aabbccddeeff"; }],
    ["changed accepted reply", value => { value.replies.at(-1).sha256 = hash("Changed accepted text"); }],
    ["changed accepted user", value => { value.turns.at(-1).messages[0] = semanticMessage("user", "Changed prompt"); }],
    ["unknown assistant body", value => { value.turns[0].messages.push(semanticMessage("assistant", "Unattributed output")); }],
    ["duplicate reply identity", value => { value.replies[0].messageId = replyId; value.turns[0].messages[1].replyIds = [replyId]; }],
    ["baseline moved after acceptance", value => { value.turns.push(value.turns.shift()); value.replies.push(value.replies.shift()); }],
    ["postaccepted output", value => { value.turns.at(-1).messages.push(semanticMessage("assistant", "Surprise output")); }],
    ["unknown later user", value => { value.turns.push({ ...structuredClone(value.turns[0]), turnKey: "66112233-4455-6677-8899-aabbccddeeff" }); }],
    ["partial accepted body", value => { value.turns.at(-1).messages.shift(); }],
    ["missing accepted turn", value => { value.turns.pop(); value.replies.pop(); }],
    ["malformed message", value => { value.turns.at(-1).messages[0] = null; }],
  ]) {
    const changed = structuredClone(current); change(changed);
    assert.equal(reconcileControlledRecoverySnapshot(changed, proof, hash, expected), undefined, name);
  }
});

async function armedRawSnapshotFixture(t, { journalVersion = 3, stage = "armed", defaultedVersion = false } = {}) {
  const f = restorationFixture(t), restoration = f.prepare();
  await applyNativeCompactionRestoration(restoration.plan, restoration.confirmationSha256, f.options);
  const value = JSON.parse(readFileSync(f.ledgerPath));
  value.uncertainSend = true; value.lastTurn.sendState = "uncertain"; value.sendBaseline = 1; value.sendBaselineReplyIds = [olderReply];
  writeFileSync(f.ledgerPath, JSON.stringify(value));
  const { request } = inspectControlledWebRecovery(restorationThread, f.options);
  const semantic = prepareControlledWebRecovery(request, f.receipt(request), f.options);
  await confirmControlledWebRecovery(semantic.plan, semantic.confirmationSha256, f.options);
  // Model an already persisted historical raw plan/journal. The current
  // preparation and confirmation APIs deliberately cannot create one.
  const rawRequest = { ...request }; delete rawRequest.snapshotPolicy;
  const historical = parseBrowserOutput(f.receipt(rawRequest), rawRequest.frameToken, "recover");
  const plan = { ...semantic.plan, request: rawRequest, snapshot: historical.snapshot, snapshotSha256: historical.snapshotSha256 };
  delete plan.snapshotPolicy;
  if (journalVersion === 2) { delete plan.inputPolicy; if (defaultedVersion) delete plan.journalVersion; else plan.journalVersion = 2; }
  const raw = { plan, confirmationSha256: hash(plan) };
  const armed = JSON.parse(readFileSync(f.ledgerPath));
  delete armed.recovery.snapshot; delete armed.recovery.snapshotPolicy;
  if (journalVersion === 2) { armed.priorVersion = 2; delete armed.recovery.inputPolicy; }
  armed.recovery.confirmationSha256 = raw.confirmationSha256; armed.recovery.snapshotSha256 = raw.plan.snapshotSha256;
  if (journalVersion === 3) armed.recovery.compactionSources = [{ carrierSha256: hash("retained readable carrier"), encryptedSha256: hash("retained opaque carrier"), inputHashes: [hash("retained source input")] }];
  const alias = id => ({ id, encryptedSha256: hash(id), deliverySha256: hash(armed.checkpoint), retainedHashes: [hash("fresh native tail retained by alias")] });
  armed.pendingCompaction = alias("preserved-pending-compaction"); armed.activeCompaction = alias("preserved-active-compaction");
  if (stage === "bounded") {
    const owner = "66112233-4455-6677-8899-aabbccddeeff";
    armed.recovery.stage = "bounded"; armed.recovery.inputHashes = [hash("exact abandoned prefix item"), hash("exact recovery-only request")];
    armed.recovery.boundTabId = armed.tabId; armed.recovery.boundEffects = { tabReopened: false, tabNavigated: false, handoffMarked: false };
    if (journalVersion === 3) { armed.recovery.opaqueItems = []; armed.recovery.boundaryOwner = { threadId: restorationThread, turnId: owner }; }
    armed.uncertainSend = false; armed.lastTurn = { turnId: owner, sendState: "abandoned", completed: true };
    armed.browserOwnerTurnIds.push(owner);
  }
  assert.equal(validWebConversation(armed, restorationThread), true);
  writeFileSync(f.ledgerPath, JSON.stringify(armed));
  const original = readFileSync(f.ledgerPath);
  return { ...f, raw, original };
}

test("snapshot-only migration preserves bounded V3 and strict V2 armed/bounded policies and exact rollback", async t => {
  for (const [journalVersion, stage, defaultedVersion] of [[3, "bounded", false], [2, "armed", false], [2, "bounded", true]]) {
    await t.test(`V${journalVersion} ${stage}, defaulted version ${defaultedVersion}`, async t => {
      const f = await armedRawSnapshotFixture(t, { journalVersion, stage, defaultedVersion });
      const inspection = inspectControlledWebRecoverySnapshotRevision(f.raw.plan, f.raw.confirmationSha256, f.options);
      const expected = { journalVersion, stage, inputPolicy: journalVersion === 2 ? null : JSON.parse(f.original).recovery.inputPolicy };
      assert.equal(inspection.request.disposition, "revise-recovery-snapshot"); assert.deepEqual(inspection.request.preservedRecovery, expected);
      const receipt = semanticRevisionReceipt(f, inspection.request);
      const revised = prepareControlledWebRecoverySnapshotRevision(inspection.request, receipt.frame(), f.options);
      assert.equal(revised.plan.inputPolicy, undefined, "A snapshot-only plan does not newly abandon native input.");
      assert.equal(revised.plan.nextRequest, stage === "armed" ? "recovery-only-no-send" : "continue-existing-boundary-after-saved-chat-proof");
      const outcome = await confirmControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options);
      assert.equal(outcome.state, `${stage}-semantic-snapshot`);
      const after = JSON.parse(readFileSync(f.ledgerPath)), prior = JSON.parse(f.original);
      assert.equal(validWebConversation(after, restorationThread), true);
      const expectedAfter = structuredClone(prior); expectedAfter.recovery = structuredClone(after.recovery);
      assert.deepEqual(after, expectedAfter, "Every field outside the snapshot journal remains exact.");
      const beforeRecovery = structuredClone(prior.recovery), afterRecovery = structuredClone(after.recovery);
      for (const key of ["confirmationSha256", "snapshotPolicy", "snapshot", "snapshotSha256", "inspectionTabId", "inspectionEffects", "snapshotRevision"]) {
        delete beforeRecovery[key]; delete afterRecovery[key];
      }
      assert.deepEqual(afterRecovery, beforeRecovery, "Stage, policy, boundary, sources and ownership remain exact.");
      assert.equal(after.recovery.inputPolicy, prior.recovery.inputPolicy);
      await rollbackControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options);
      assert.deepEqual(readFileSync(f.ledgerPath), f.original);
    });
  }
});

test("preserving snapshot revision rejects changed stage/policy, uncertain bounded work and changed replay evidence", async t => {
  const f = await armedRawSnapshotFixture(t, { journalVersion: 2, stage: "bounded", defaultedVersion: true });
  const inspection = inspectControlledWebRecoverySnapshotRevision(f.raw.plan, f.raw.confirmationSha256, f.options), receipt = semanticRevisionReceipt(f, inspection.request);
  for (const change of [request => { request.preservedRecovery.stage = "armed"; }, request => { request.preservedRecovery.inputPolicy = "quarantine-all-native-input-through-first-recovery-request-v1"; }]) {
    const changed = structuredClone(inspection.request); change(changed);
    assert.throws(() => prepareControlledWebRecoverySnapshotRevision(changed, receipt.frame(), f.options), /stage or input policy/u);
  }
  const revised = prepareControlledWebRecoverySnapshotRevision(inspection.request, receipt.frame(), f.options);
  const rearmed = structuredClone(revised.plan);
  rearmed.preservedRecovery.stage = "armed"; rearmed.request.preservedRecovery.stage = "armed"; rearmed.nextRequest = "recovery-only-no-send";
  await assert.rejects(confirmControlledWebRecoverySnapshotRevision(rearmed, hash(rearmed), f.options), /stage or input policy/u);
  const converted = structuredClone(revised.plan);
  for (const preserved of [converted.preservedRecovery, converted.request.preservedRecovery]) {
    preserved.journalVersion = 3; preserved.inputPolicy = "quarantine-all-native-input-through-first-recovery-request-v1";
  }
  await assert.rejects(confirmControlledWebRecoverySnapshotRevision(converted, hash(converted), f.options), /stage or input policy/u);
  assert.deepEqual(readFileSync(f.ledgerPath), f.original);
  const uncertain = JSON.parse(f.original); uncertain.uncertainSend = true; uncertain.lastTurn = { turnId: failedTurn, sendState: "uncertain", completed: false };
  writeFileSync(f.ledgerPath, JSON.stringify(uncertain));
  assert.throws(() => inspectControlledWebRecoverySnapshotRevision(f.raw.plan, f.raw.confirmationSha256, f.options), /intact armed or bounded/u);
  writeFileSync(f.ledgerPath, f.original);
  const pending = JSON.parse(f.original);
  pending.pendingBrowserOpen = { turnId: failedTurn, callId: `call_router_web_${"a".repeat(32)}`, chatUrl: pending.chatUrl };
  pending.lastTurn = { turnId: failedTurn, sendState: "unsent", completed: false };
  assert.equal(validWebConversation(pending, restorationThread), true);
  writeFileSync(f.ledgerPath, JSON.stringify(pending));
  assert.throws(() => inspectControlledWebRecoverySnapshotRevision(f.raw.plan, f.raw.confirmationSha256, f.options), /intact armed or bounded/u);
  writeFileSync(f.ledgerPath, f.original);
  await confirmControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options);
  const progressed = JSON.parse(readFileSync(f.ledgerPath)); progressed.recovery.inputHashes.push(hash("changed input boundary"));
  writeFileSync(f.ledgerPath, JSON.stringify(progressed));
  await assert.rejects(rollbackControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options), /discard current evidence/u);
  assert.deepEqual(JSON.parse(readFileSync(f.ledgerPath)), progressed);
});

test("explicit armed snapshot revision approves a newly mounted known baseline and preserves projection, sources, quarantine and rollback", async t => {
  const f = await armedRawSnapshotFixture(t);
  assert.throws(() => prepareControlledWebRecovery(f.raw.plan.request, f.receipt(f.raw.plan.request), f.options), /current semantic inspection/u);
  await assert.rejects(confirmControlledWebRecovery(f.raw.plan, f.raw.confirmationSha256, f.options));
  assert.deepEqual(readFileSync(f.ledgerPath), f.original);
  const inspection = inspectControlledWebRecoverySnapshotRevision(f.raw.plan, f.raw.confirmationSha256, f.options);
  assert.equal(inspection.request.snapshotPolicy, "semantic-v1");
  const receipt = semanticRevisionReceipt(f, inspection.request);
  const revised = prepareControlledWebRecoverySnapshotRevision(inspection.request, receipt.frame(), f.options);
  await assert.rejects(confirmControlledWebRecoverySnapshotRevision(revised.plan, "0".repeat(64), f.options));
  assert.deepEqual(readFileSync(f.ledgerPath), f.original);
  await confirmControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options);
  const after = JSON.parse(readFileSync(f.ledgerPath)), prior = JSON.parse(f.original);
  assert.equal(validWebConversation(after, restorationThread), true);
  assert.equal(after.recovery.stage, "armed"); assert.equal(after.uncertainSend, true);
  assert.deepEqual(after.recovery.compactionSources, prior.recovery.compactionSources);
  assert.deepEqual(after.nativeCompactionProjection, prior.nativeCompactionProjection);
  assert.deepEqual(after.checkpoint, prior.checkpoint);
  assert.equal(after.recovery.inputPolicy, prior.recovery.inputPolicy);
  assert.deepEqual(after.recovery.revokedTurnIds, prior.recovery.revokedTurnIds);
  assert.equal(after.recovery.snapshot.turns.length, 1);
  await rollbackControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options);
  assert.deepEqual(readFileSync(f.ledgerPath), f.original);
});

test("snapshot revision refuses changed accepted text, changed armed evidence and rollback after advancement", async t => {
  const f = await armedRawSnapshotFixture(t), inspection = inspectControlledWebRecoverySnapshotRevision(f.raw.plan, f.raw.confirmationSha256, f.options);
  const receipt = semanticRevisionReceipt(f, inspection.request), changed = structuredClone(receipt.observed);
  changed.snapshot.replies.at(-1).sha256 = hash("Tampered accepted reply"); changed.snapshotSha256 = hash(changed.snapshot);
  const changedFrame = `ROUTER_WEB_BROWSER_${inspection.request.frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: changed })}\nROUTER_WEB_BROWSER_${inspection.request.frameToken}_END`;
  assert.throws(() => prepareControlledWebRecoverySnapshotRevision(inspection.request, changedFrame, f.options), /reply changed/u);
  const revised = prepareControlledWebRecoverySnapshotRevision(inspection.request, receipt.frame(), f.options);
  const newer = JSON.parse(f.original); newer.recovery.compactionSources[0].inputHashes.push(hash("new evidence"));
  writeFileSync(f.ledgerPath, JSON.stringify(newer));
  await assert.rejects(confirmControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options), /changed/u);
  assert.deepEqual(JSON.parse(readFileSync(f.ledgerPath)), newer);
  writeFileSync(f.ledgerPath, f.original);
  await confirmControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options);
  const progressed = JSON.parse(readFileSync(f.ledgerPath)); progressed.recovery.compactionSources[0].inputHashes.push(hash("later evidence"));
  writeFileSync(f.ledgerPath, JSON.stringify(progressed));
  await assert.rejects(rollbackControlledWebRecoverySnapshotRevision(revised.plan, revised.confirmationSha256, f.options), /discard current evidence/u);
  assert.deepEqual(JSON.parse(readFileSync(f.ledgerPath)), progressed);
});

test("read-only inspection append is retained at preparation; later source change blocks application", async t => {
  const f = restorationFixture(t), { request } = f.inspect();
  writeFileSync(f.rolloutPath, row("event_msg", { type: "inspection_completed" }, 100), { flag: "a", encoding: "utf8" });
  const prepared = prepareNativeCompactionRestoration(request, f.receipt(request), f.options);
  assert.notEqual(prepared.plan.rolloutSha256, request.sourceSha256);
  const original = readFileSync(f.ledgerPath);
  writeFileSync(f.rolloutPath, row("event_msg", { type: "later_work" }, 101), { flag: "a", encoding: "utf8" });
  await assert.rejects(applyNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256, f.options), /changed after plan/u);
  assert.deepEqual(readFileSync(f.ledgerPath), original);
});

test("restoration refuses missing actual results, orphan outputs, checkpoint changes and earlier native compaction", async t => {
  for (const change of [source => source.splice(source.findIndex(item => item.call_id === "call_native" && item.type === "function_call_output"), 1),
    source => source.splice(source.findIndex(item => item.type === "function_call"), 1),
    source => source.unshift(nativeMessage("user", "Changed checkpoint")),
    source => source.unshift({ type: "compaction", encrypted_content: "earlier-opaque" }),
    source => source.push({ type: "unknown_native_item" })]) {
    const f = restorationFixture(t, { sourceChange: change }); assert.throws(f.inspect);
  }
});

test("native restoration retains and verifies long source snapshots and rollback without enlarging the witness", async t => {
  const f = restorationFixture(t), ledgerBefore = readFileSync(f.ledgerPath);
  const padding = 'x'.repeat(1024 * 1024);
  for (let index=0; index<17; index++) writeFileSync(f.rolloutPath,
    row('event_msg', {type:'token_count',diagnostic:padding},100+index), {flag:'a',encoding:'utf8'});
  const source = readFileSync(f.rolloutPath); assert(source.length > 16 * 1024 * 1024);
  const prepared = f.prepare();
  assert.deepEqual(readFileSync(prepared.plan.rolloutSnapshotPath), source);
  const result = await applyNativeCompactionRestoration(prepared.plan,prepared.confirmationSha256,f.options);
  assert.deepEqual(readFileSync(result.rolloutArchive), source);
  assert(JSON.stringify(prepared.plan.request.witness).length < 16 * 1024 * 1024);
  await rollbackNativeCompactionRestoration(prepared.plan,prepared.confirmationSha256,f.options);
  assert.deepEqual(readFileSync(f.ledgerPath), ledgerBefore);
  assert.deepEqual(readFileSync(f.rolloutPath), source);
});

test("restoration refuses live state and persistence failure without losing the original ledger", async t => {
  const f = restorationFixture(t), original = readFileSync(f.ledgerPath), prepared = f.prepare();
  await assert.rejects(applyNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256,
    { ...f.options, assertOffline: async () => { throw new Error("admission still open"); } }), /admission/u);
  assert.deepEqual(readFileSync(f.ledgerPath), original);
  await assert.rejects(applyNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256,
    { ...f.options, write: (target, bytes) => { if (target === f.ledgerPath) throw new Error("ledger persistence failed"); f.options.write(target, bytes); } }), /persistence/u);
  assert.deepEqual(readFileSync(f.ledgerPath), original);
  // Durable orphan sidecars from that failed publication are reusable only byte
  // for byte, and restart still reads the original guarded ledger.
  await applyNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256, f.options);
  const value = JSON.parse(readFileSync(f.ledgerPath, "utf8")); value.lastTurn.turnId = "44112233-4455-6677-8899-aabbccddeeff";
  writeFileSync(f.ledgerPath, JSON.stringify(value));
  await assert.rejects(rollbackNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256, f.options), /advanced/u);
});

test("restoration refuses ledger uncertainty, pending ownership and tampered private witness", async t => {
  for (const change of [value => { value.uncertainSend = true; value.lastTurn.sendState = "uncertain"; },
    value => value.unresolvedCoding.push({ callId: "unresolved", outputType: "function_call_output" }),
    value => { value.pendingBrowserOpen = { turnId: failedTurn, callId: "call_router_web_" + "a".repeat(32), chatUrl: value.chatUrl }; value.version = 4; value.priorVersion = 1; }]) {
    const f = restorationFixture(t); change(f.ledger); writeFileSync(f.ledgerPath, JSON.stringify(f.ledger)); assert.throws(f.inspect);
  }
  const f = restorationFixture(t), prepared = f.prepare();
  prepared.plan.request.witness.source.at(-1).reasoning.effort = "low";
  await assert.rejects(applyNativeCompactionRestoration(prepared.plan, hash(prepared.plan), f.options), /witness/u);
});

test("native-owned source permissions are retained while immutable snapshots and plans require private protection", async t => {
  const f = restorationFixture(t), original = readFileSync(f.ledgerPath);
  f.options.isPrivate = file => path.resolve(file) !== f.rolloutPath;
  const { request } = f.inspect();
  assert.equal(hash(readFileSync(request.sourceSnapshotPath)), request.sourceSha256);
  assert.deepEqual(readFileSync(f.ledgerPath), original);
  const prepared = prepareNativeCompactionRestoration(request, f.receipt(request), f.options);
  const planFile = path.join(f.root, "protected-plan.json"); writeFileSync(planFile, JSON.stringify(prepared.plan));
  assert.throws(() => inspectNativeCompactionRestorationPlan(planFile, prepared.confirmationSha256,
    { ...f.options, isPrivate: file => file !== planFile }), /protected/u);
  assert.throws(() => prepareNativeCompactionRestoration(request, f.receipt(request),
    { ...f.options, isPrivate: file => file !== request.sourceSnapshotPath }), /protected/u);
  writeFileSync(request.sourceSnapshotPath, "changed retained source");
  await assert.rejects(applyNativeCompactionRestoration(prepared.plan, prepared.confirmationSha256, f.options), /snapshot changed/u);
  assert.deepEqual(readFileSync(f.ledgerPath), original);
});

test("native source acquisition refuses directory links without changing native history", t => {
  const f = restorationFixture(t), linked = path.join(f.root, "linked-source"), before = readFileSync(f.rolloutPath);
  symlinkSync(f.root, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readCanonicalNativeSource(path.join(linked, path.basename(f.rolloutPath))), /linked paths/u);
  assert.throws(() => readCanonicalNativeSource(f.root), /regular file/u);
  assert.deepEqual(readFileSync(f.rolloutPath), before);
});

test("canonical metadata stays in exact source evidence without becoming readable model history", t => {
  const f = restorationFixture(t), bytes = readFileSync(f.rolloutPath), parsed = canonicalNativeCompactionSource(bytes, restorationThread);
  assert.equal(parsed.source.some(item => item.type === "world_state" || item.type === "token_usage_record"), false);
  const canonicalRows = bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  for (const mutate of [
    rows => { rows.find(item => item.type === "world_state").payload.full = "true"; },
    rows => { rows.find(item => item.type === "world_state").payload.extra = "unknown"; },
    rows => { rows.find(item => item.type === "token_usage_record").payload.thread_id = acceptedTurn; },
    rows => { rows.find(item => item.type === "token_usage_record").payload.turn_id = "not-native-uuid"; },
    rows => { rows.find(item => item.type === "token_usage_record").payload.usage = []; },
    rows => { rows.find(item => item.type === "world_state").type = "unknown_metadata"; },
  ]) {
    const changed = structuredClone(canonicalRows); mutate(changed);
    assert.throws(() => canonicalNativeCompactionSource(Buffer.from(changed.map(item => JSON.stringify(item)).join("\n") + "\n"), restorationThread));
  }
  const { request } = f.inspect();
  assert.deepEqual(readFileSync(request.sourceSnapshotPath), bytes);
});
