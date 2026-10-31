import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { assertControlledRecoveryOffline, canonicalNativeCompactionSource, inspectNativeCompactionRestoration,
  prepareNativeCompactionRestoration, inspectNativeCompactionRestorationPlan, applyNativeCompactionRestoration,
  rollbackNativeCompactionRestoration, readCanonicalNativeSource } from "../maintenance/web-recovery.mjs";
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
    const snapshot = { originalTabId: ledger.tabId, chatUrl: ledger.chatUrl, turns: [{ turnKey: acceptedTurn, sha256: hash("accepted") }],
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
