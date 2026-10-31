import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test, { after } from "node:test";
import { domElement, domText, messageId, replyElement } from "./web-dom-fixture.mjs";

const fixtureParent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.tmp");
mkdirSync(fixtureParent, { recursive: true });
const stateDir = mkdtempSync(path.join(fixtureParent, "router-web-runtime-"));
const syntheticEnvironment = {
  CODEX_HOME: path.join(stateDir, "codex"), MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir,
  MODEL_ROUTER_MODEL_PICKER_STATE: path.join(stateDir, "model-picker.json"),
  MODEL_ROUTER_MULTI_AGENT_STATE: path.join(stateDir, "multi-agent-settings.json"),
};
Object.assign(process.env, syntheticEnvironment);
for (const [name, expected] of Object.entries(syntheticEnvironment)) {
  assert.equal(process.env[name], expected, `${name} must be synthetic before loading any production module.`);
  assert.ok(!path.relative(stateDir, expected).startsWith(".."));
}
mkdirSync(process.env.CODEX_HOME);
after(() => rmSync(stateDir, { recursive: true, force: true }));

const { RouterAdmission } = await import("../src/router-admission.mjs");
const runtimePaths = await import("../src/paths.mjs");
assert.equal(runtimePaths.CODEX_HOME, syntheticEnvironment.CODEX_HOME);
assert.equal(runtimePaths.STATE_DIR, stateDir);
const { createInAppWebRuntime, collectWebTools, webTurnIdentity } = await import("../src/web-runtime.mjs");
const { createWebToolBroker } = await import("../src/web-tools.mjs");
const { browserDom, parseBrowserOutput, readBrowserProgram } = await import("../src/web-browser.mjs");
const { startWebMcp } = await import("../src/web-mcp.mjs");
const { qualifyBrowserCall } = await import("../src/web-stop-adapter.mjs");
const { SseFrameBuffer, sseFrameFields } = await import("../src/sse-framing.mjs");
const { decodeCompaction } = await import("../src/compaction-checkpoint.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");
const { inspectControlledWebRecovery, prepareControlledWebRecovery, confirmControlledWebRecovery, restoreControlledWebRecoveryGuard } = await import("../maintenance/web-recovery.mjs");
const { snapshotWebConversationLedgers, assertWebConversationLedgersUnchanged } = await import("../src/web-maintenance-proof.mjs");
const { safeLocalHttpErrorPayload } = await import("../src/http-utils.mjs");

// Runtime policy tests retain real JSON persistence and restart reads. Windows
// ACL behavior is exercised separately below with the runtime's secure defaults.
const syntheticStorage = {
  async writeState(target, value) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value)}\n`, "utf8");
  },
  stateIsProtected: () => true,
};

const threadId = "00112233-4455-6677-8899-aabbccddeeff";
const turnId = "11002233-4455-6677-8899-aabbccddeeff";
const followupId = "22002233-4455-6677-8899-aabbccddeeff";
const nativeJs = { type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", description: "Current native JavaScript",
  parameters: { type: "object", properties: { code: { type: "string" }, title: { type: ["string", "null"] }, timeout_ms: { type: "integer" } }, required: ["code"] } }] };
const currentRead = { type: "namespace", name: "mcp__work", tools: [{ type: "function", name: "read", description: "Read the actual workspace",
  parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false } }] };
const search = { type: "tool_search", execution: "client" };
const metadata = (turn = turnId) => ({ thread_id: threadId, turn_id: turn });
const headers = (turn = turnId) => ({ "x-codex-turn-metadata": JSON.stringify(metadata(turn)), "x-codex-thread-id": threadId });
const outputFor = (call, output) => ({ type: call.type === "tool_search_call" ? "tool_search_output" : "function_call_output", call_id: call.call_id,
  ...(call.type === "tool_search_call" ? { tools: output, execution: "client", status: "completed" } : { output }) });

async function controlledRecoveryFixture(t, { executed = true, legacy = true, compaction, harnessOptions } = {}) {
  const h = harness(t, harnessOptions);
  if (compaction) h.input().unshift({ role: "developer", content: "Accepted native developer context before compaction" });
  const { call } = await h.toObserve();
  await h.completeAnswer(call, "Accepted answer retained through recovery.");
  const accepted = JSON.parse(readFileSync(h.stateFile, "utf8"));
  if (compaction) {
    h.append({ role: "user", content: "FAILED PRE-COMPACTION INPUT MUST NOT BE REPLAYED" });
    const v2 = compaction.startsWith("v2"), original = structuredClone(h.input());
    const compact = () => h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input(), stream: v2 },
      { ...(v2 ? { compactV2: true } : { compact: true }), headers: headers() });
    const result = v2 ? [await nativeV2Checkpoint(await compact())] : (await (await compact()).json()).output;
    h.input().splice(0, h.input().length, ...(v2 ? [...nativeV2Users(original), ...result] : result));
    if (compaction.endsWith("active")) await compact(); // The newer proposed window is deliberately not applied.
  }
  h.newTurn(followupId, "FAILED PRIVATE PROMPT MUST NEVER BE REPLAYED");
  let response = await h.request();
  while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
  if (executed) { await h.executeBrowser(response.output[0]); h.browser.ui.stop = false; }
  const token = h.token();
  h.observations.watchers.at(-1).onCancel();
  await h.restartRuntime();
  const value = JSON.parse(readFileSync(h.stateFile, "utf8"));
  if (legacy) { delete value.attemptedDelivery; writeFileSync(h.stateFile, `${JSON.stringify(value)}\n`, "utf8"); }
  const original = readFileSync(h.stateFile);
  const options = { stateDir: path.dirname(path.dirname(path.dirname(h.stateFile))), isPrivate: () => true,
    settings: h.settings, lock: operation => operation(), assertOffline: async () => {} };
  // The real protected writer is async; this fixture's writer is deliberately
  // synchronous, matching the maintenance transaction's durable write contract.
  options.write = (target, bytes) => { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes); };
  const inspection = inspectControlledWebRecovery(threadId, options);
  const inspect = () => h.executeBrowser({ type: "function_call", namespace: "mcp__node_repl", name: "js",
    arguments: JSON.stringify({ code: inspection.program }) });
  const prepare = async () => prepareControlledWebRecovery(inspection.request, await inspect(), options);
  return { h, accepted, original, options, inspection, inspect, prepare, token };
}

test("controlled legacy recovery archives exact failure and consumes one native request without replay before same-chat continuation", async t => {
  for (const executed of [false, true]) await t.test(`Send executed: ${executed}`, async t => {
    const fixture = await controlledRecoveryFixture(t, { executed }), { h, accepted, original, options } = fixture;
    const { plan, confirmationSha256 } = await fixture.prepare();
    const result = await confirmControlledWebRecovery(plan, confirmationSha256, options);
    assert.deepEqual(readFileSync(result.archive), original);
    const armed = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(armed.version, 2); assert.equal(armed.uncertainSend, true);
    assert.deepEqual(armed.checkpoint, accepted.checkpoint);
    await assert.rejects(h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() }), { code: "web_recovery_pending" });
    const sends = h.browser.ui.sends.length;
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Record the explicitly approved recovery boundary only.");
    const recoveryCall = (await h.request()).output[0];
    assert.equal(readBrowserProgram(JSON.parse(recoveryCall.arguments).code)?.operation, "recover");
    const notice = await h.answerBrowser(recoveryCall);
    assert.match(notice.output[0].content[0].text, /no prompt was sent/u);
    h.append(notice.output[0]);
    const bounded = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(bounded.uncertainSend, false); assert.equal(bounded.lastTurn.sendState, "abandoned");
    assert.deepEqual(bounded.checkpoint, accepted.checkpoint);
    const snapshot = snapshotWebConversationLedgers(options.stateDir, options);
    assert.equal(snapshot.find(row => row.kind === "conversation").uncertainSend, false);
    assert.ok(snapshot.some(row => row.kind === "sidecar" && row.sha256 === createHash("sha256").update(original).digest("hex")));
    assertWebConversationLedgersUnchanged(options.stateDir, snapshot, options);
    await assert.rejects(h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() }), { code: "web_recovery_pending" });
    assert.equal(h.browser.ui.sends.length, sends);
    await assert.rejects(h.broker.invoke(fixture.token, { wireName: "old-authority", arguments: {} }));
    h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "FRESH REQUEST AFTER RECOVERY");
    const { call } = await h.toObserve();
    assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
    assert.equal(h.browser.ui.sends.length, sends + 1);
    const prompt = h.browser.ui.sends.at(-1);
    assert.match(prompt, /FRESH REQUEST AFTER RECOVERY/u);
    assert.doesNotMatch(prompt, /FAILED PRIVATE PROMPT|Record the explicitly approved recovery boundary|Same-chat recovery boundary recorded/u);
    await h.completeAnswer(call, "Fresh answer from the retained saved chat.");
    await h.restartRuntime();
    h.newTurn(followupId, "Attempt to revive the permanently revoked failed turn.");
    await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  });
});

test("controlled recovery verifies pending and active native compaction aliases before bounding abandoned input", async t => {
  for (const compaction of ["v1-pending", "v1-active", "v2-pending", "v2-active"]) await t.test(compaction, async t => {
    const fixture = await controlledRecoveryFixture(t, { compaction }), { h, options, accepted } = fixture;
    const original = JSON.parse(fixture.original);
    assert.ok(original[compaction.endsWith("active") ? "activeCompaction" : "pendingCompaction"]);
    const { plan, confirmationSha256 } = await fixture.prepare();
    await confirmControlledWebRecovery(plan, confirmationSha256, options);
    const sends = h.browser.ui.sends.length;
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Record only the approved compacted recovery boundary");
    const notice = await h.answerBrowser((await h.request()).output[0]); h.append(notice.output[0]);
    assert.equal(h.browser.ui.sends.length, sends);
    const bounded = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.deepEqual(bounded.checkpoint, accepted.checkpoint);
    assert.deepEqual(bounded.pendingCompaction, original.pendingCompaction);
    assert.deepEqual(bounded.activeCompaction, original.activeCompaction);
    h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "FRESH INPUT AFTER COMPACTED RECOVERY");
    const { call } = await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "FRESH INPUT AFTER COMPACTED RECOVERY" }]);
    await h.completeAnswer(call, "Compaction-aware same-chat recovery completed.");
  });
  await t.test("changed retained alias tail", async t => {
    const fixture = await controlledRecoveryFixture(t, { compaction: "v1-pending" }), { h, options } = fixture;
    const { plan, confirmationSha256 } = await fixture.prepare();
    await confirmControlledWebRecovery(plan, confirmationSha256, options);
    h.input().find(item => item.role === "user").content = "Changed retained native input";
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "A changed alias must still refuse recovery");
    const operations = h.observations.nativeOperations.length;
    await assert.rejects(h.request(), { code: "web_history_mismatch" });
    assert.equal(h.observations.nativeOperations.length, operations);
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).recovery.stage, "armed");
  });
  await t.test("unverified opaque native compaction", async t => {
    const fixture = await controlledRecoveryFixture(t, { compaction: "v1-pending" }), { h, options } = fixture;
    const { plan, confirmationSha256 } = await fixture.prepare();
    await confirmControlledWebRecovery(plan, confirmationSha256, options);
    h.input()[0].encrypted_content = "opaque-native-compaction-without-a-verified-alias";
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Opaque compaction cannot authorize recovery");
    const operations = h.observations.nativeOperations.length;
    await assert.rejects(h.request(), { code: "encrypted_v2_unsupported" });
    assert.equal(h.observations.nativeOperations.length, operations);
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).uncertainSend, true);
  });
});

test("cancelled recovery finalization cannot release a successor during persistence or watcher shutdown", { timeout: 5000 }, async t => {
  for (const delayed of ["persistence", "watcher shutdown"]) await t.test(delayed, async t => {
    const reached = Promise.withResolvers(), allowWrite = Promise.withResolvers(), allowClose = Promise.withResolvers();
    t.after(() => { allowWrite.resolve(); allowClose.resolve(); });
    const recoveryId = "33002233-4455-6677-8899-aabbccddeeff", successorId = "44002233-4455-6677-8899-aabbccddeeff";
    let firstWrite = true;
    const fixture = await controlledRecoveryFixture(t, { harnessOptions: {
      storage: { ...syntheticStorage, writeState: async (file, value) => {
        if (delayed === "persistence" && firstWrite && value.recovery?.stage === "bounded" && value.lastTurn.turnId === recoveryId) {
          firstWrite = false; reached.resolve(); await allowWrite.promise;
        }
        await syntheticStorage.writeState(file, value);
      } },
      watcherClosure: async watcher => { if (watcher.turnId === recoveryId) { if (delayed === "watcher shutdown") reached.resolve(); await allowClose.promise; } },
    } });
    const { h, options } = fixture, { plan, confirmationSha256 } = await fixture.prepare();
    await confirmControlledWebRecovery(plan, confirmationSha256, options);
    h.newTurn(recoveryId, "Record the approved recovery boundary");
    const recoveryCall = (await h.request()).output[0];
    const finishing = assert.rejects(h.answerBrowser(recoveryCall), { code: "web_turn_cancelled" });
    await reached.promise;
    h.observations.watchers.find(watcher => watcher.turnId === recoveryId).onCancel();
    h.newTurn(successorId, "The successor owns the fresh request");
    const next = h.request();
    const successorInput = structuredClone(h.input());
    h.newTurn("55002233-4455-6677-8899-aabbccddeeff", "A third request must not steal the successor reservation");
    await assert.rejects(h.request(), /already owns this native conversation/u);
    allowWrite.resolve();
    const successorCall = (await next).output[0];
    assert.equal(readBrowserProgram(JSON.parse(successorCall.arguments).code).turnId, successorId);
    const saved = readFileSync(h.stateFile, "utf8");
    allowClose.resolve(); await finishing;
    h.newTurn("66002233-4455-6677-8899-aabbccddeeff", "Old recovery completion cannot release the successor either");
    await assert.rejects(h.request(), /already owns this native conversation/u);
    assert.equal(readFileSync(h.stateFile, "utf8"), saved);
    assert.equal(h.runtime.maintenanceState().activeTurns, 1);
    h.newTurn(successorId, "Restore the successor's original native request");
    h.input().splice(0, h.input().length, ...successorInput);
    await h.answerBrowser(successorCall);
    const { call } = await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "The successor owns the fresh request" }]);
    await h.completeAnswer(call, "The successor continued after cancelled recovery finalization.");
  });
});

test("controlled recovery refuses changed browser, unresolved actions, stale confirmation and unproven quiescence", async t => {
  for (const [name, change] of [
    ["active Stop", h => { h.browser.ui.stop = true; }],
    ["restored draft", h => { h.browser.ui.composer = "Failed restored draft"; }],
    ["changed accepted reply", h => { h.browser.ui.texts[0] = "Changed accepted answer"; }],
    ["foreign reply", h => { h.browser.ui.texts.push("Unconfirmed assistant output"); }],
    ["foreign URL", h => { const savedUrl = h.browser.ui.url; h.browser.ui.url = "https://chatgpt.com/c/foreign";
      h.browser.browser.tabs.list = async () => [{ id: h.browser.ui.tabId, url: savedUrl }]; }],
    ["foreign owner", h => { h.replaceBrowserOwner({ turnId: "99002233-4455-6677-8899-aabbccddeeff", state: {} }); }],
  ]) await t.test(name, async t => {
    const fixture = await controlledRecoveryFixture(t); change(fixture.h);
    await assert.rejects(fixture.inspect(), /ROUTER_WEB_RECOVERY_DIAGNOSTIC/u);
    assert.deepEqual(readFileSync(fixture.h.stateFile), fixture.original);
  });
  const fixture = await controlledRecoveryFixture(t), { h, options } = fixture;
  const { plan, confirmationSha256 } = await fixture.prepare();
  await assert.rejects(confirmControlledWebRecovery(plan, "0".repeat(64), options), /confirmation/u);
  await assert.rejects(confirmControlledWebRecovery(plan, confirmationSha256, { ...options, assertOffline: async () => { throw new Error("live process remains"); } }), /live process/u);
  assert.deepEqual(readFileSync(h.stateFile), fixture.original);
  const changed = JSON.parse(fixture.original); changed.unresolvedCoding = [{ callId: "native-action", outputType: "function_call_output" }];
  writeFileSync(h.stateFile, JSON.stringify(changed));
  assert.throws(() => inspectControlledWebRecovery(threadId, options), /unresolved actions/u);
  await assert.rejects(confirmControlledWebRecovery(plan, confirmationSha256, options));
});

test("controlled recovery rechecks the browser after offline confirmation and preserves the guard on failure", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options, original } = fixture;
  const marks = h.browser.ui.marks, sends = h.browser.ui.sends.length;
  const { plan, confirmationSha256 } = await fixture.prepare();
  assert.equal(h.browser.ui.marks, marks); assert.equal(h.browser.ui.sends.length, sends);
  await confirmControlledWebRecovery(plan, confirmationSha256, options);
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Recovery-only boundary");
  const call = (await h.request()).output[0];
  h.browser.ui.composer = "A new draft after review";
  await assert.rejects(h.executeBrowser(call), /composer-draft-present/u);
  h.observations.watchers.at(-1).onCancel();
  await h.restartRuntime();
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.recovery.stage, "armed"); assert.equal(saved.uncertainSend, true);
  assert.deepEqual(saved.checkpoint, JSON.parse(original).checkpoint);
  assert.equal(h.browser.ui.sends.length, sends);
});

test("controlled same-chat recovery rebinds one restored tab identity only with the unchanged owning-session content proof", async t => {
  for (const fault of [null, "foreign session", "changed content", "changed failed prompt", "duplicate saved URL"]) await t.test(fault ?? "restored tab", async t => {
    const fixture = await controlledRecoveryFixture(t), { h, options } = fixture;
    const { plan, confirmationSha256 } = await fixture.prepare();
    await confirmControlledWebRecovery(plan, confirmationSha256, options);
    h.loseKernel(); h.browser.ui.tabId = "restored-tab-after-normal-quit";
    if (fault === "foreign session") h.browser.agent.browsers.list = async () => [{ type: "iab", id: h.browser.browser.browserId,
      metadata: { codexSessionId: "99002233-4455-6677-8899-aabbccddeeff" } }];
    if (fault === "changed content") h.browser.ui.texts[0] = "Foreign same-URL answer";
    if (fault === "changed failed prompt") h.browser.ui.turns.at(-1).prompt += " Changed failed input";
    if (fault === "duplicate saved URL") h.browser.browser.tabs.list = async () => [{ id: h.browser.ui.tabId, url: h.browser.ui.url }, { id: "duplicate", url: h.browser.ui.url }];
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Record the recovery-only boundary");
    const call = (await h.request()).output[0];
    if (fault) {
      await assert.rejects(h.executeBrowser(call), /ownership-changed|snapshot-changed/u);
      assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).uncertainSend, true);
    } else {
      const notice = await h.answerBrowser(call); h.append(notice.output[0]);
      const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
      assert.equal(saved.recovery.proof.tabId, plan.request.proof.tabId);
      assert.equal(saved.recovery.inspectionTabId, plan.inspectionTabId);
      assert.equal(saved.recovery.boundTabId, "restored-tab-after-normal-quit");
      h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "Fresh instruction after restored-tab rebind");
      const { call: observe } = await h.toObserve();
      await h.completeAnswer(observe, "The same saved chat continues after a new tab ID.");
      assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).recovery.stage, "continued");
    }
    assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
  });
});

test("controlled recovery serializes competing confirmations and rollback restores only the original guarded record", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options, original } = fixture;
  const { plan, confirmationSha256 } = await fixture.prepare();
  const realLocks = { ...options }; delete realLocks.lock;
  const results = await Promise.allSettled([confirmControlledWebRecovery(plan, confirmationSha256, realLocks), confirmControlledWebRecovery(plan, confirmationSha256, realLocks)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const armed = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(armed.version, 2, "Prior v1 runtimes reject this recovery format instead of silently dropping its replay fence.");
  await assert.rejects(restoreControlledWebRecoveryGuard(plan, "0".repeat(64), options));
  const restored = await restoreControlledWebRecoveryGuard(plan, confirmationSha256, options);
  assert.deepEqual(readFileSync(h.stateFile), original);
  assert.equal(JSON.parse(readFileSync(restored.retained, "utf8")).recovery.stage, "armed");
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "The restored original must still block.");
  await assert.rejects(h.request(), { code: "web_send_uncertain" });
});

test("controlled recovery write failure retains original bytes and cannot authorize a browser action", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options, original } = fixture;
  const { plan, confirmationSha256 } = await fixture.prepare();
  await assert.rejects(confirmControlledWebRecovery(plan, confirmationSha256, { ...options,
    write: (file, bytes) => { if (file === h.stateFile) throw new Error("durable publication failed"); options.write(file, bytes); } }), /publication failed/u);
  assert.deepEqual(readFileSync(h.stateFile), original);
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "No recovery was published");
  await assert.rejects(h.request(), { code: "web_send_uncertain" });
});

test("controlled recovery preserves conflicting or unprotected retained archives", async t => {
  for (const conflict of ["conflicting bytes", "unprotected archive"]) await t.test(conflict, async t => {
    const fixture = await controlledRecoveryFixture(t), { h, options, original } = fixture;
    const { plan, confirmationSha256 } = await fixture.prepare();
    const archive = `${h.stateFile}.abandoned-${plan.request.failedTurnId}-${plan.request.ledgerSha256}.original`;
    const archived = conflict === "conflicting bytes" ? Buffer.from("Different retained original evidence") : original;
    writeFileSync(archive, archived);
    await assert.rejects(confirmControlledWebRecovery(plan, confirmationSha256, { ...options,
      isPrivate: file => conflict !== "unprotected archive" || file !== archive }));
    assert.deepEqual(readFileSync(archive), archived); assert.deepEqual(readFileSync(h.stateFile), original);
  });
});

test("controlled recovery reopens only its exact saved chat when the owned tab is absent", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options } = fixture;
  const originalUrl = h.browser.ui.url, texts = [...h.browser.ui.texts], turns = structuredClone(h.browser.ui.turns);
  h.browser.ui.savedReplies.set(originalUrl, texts); h.browser.ui.savedTurns.set(originalUrl, turns);
  h.browser.ui.savedStops = new Map([[originalUrl, false]]); h.browser.ui.present = false;
  const sends = h.browser.ui.sends.length;
  const { plan, confirmationSha256 } = await fixture.prepare();
  assert.equal(plan.inspectionEffects.tabReopened, true); assert.equal(plan.inspectionEffects.handoffMarked, true);
  assert.equal(h.browser.ui.url, originalUrl); assert.equal(h.browser.ui.sends.length, sends);
  await confirmControlledWebRecovery(plan, confirmationSha256, options);
  h.loseKernel(); h.browser.ui.present = false;
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Record only the approved same-chat recovery boundary");
  const notice = await h.answerBrowser((await h.request()).output[0]); h.append(notice.output[0]);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.recovery.boundEffects.tabReopened, true); assert.equal(saved.chatUrl, originalUrl);
  assert.equal(h.browser.ui.sends.length, sends);
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "FRESH REQUEST IN THE REOPENED SAME CHAT");
  const { call } = await h.toObserve(); await h.completeAnswer(call, "The reopened saved chat continued.");
  assert.match(h.browser.ui.sends.at(-1), /FRESH REQUEST IN THE REOPENED SAME CHAT/u);
  assert.doesNotMatch(h.browser.ui.sends.at(-1), /FAILED PRIVATE PROMPT/u);
});

test("controlled recovery retains possible browser owners across an interrupted recovery-only handoff", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options } = fixture;
  const { plan, confirmationSha256 } = await fixture.prepare();
  await confirmControlledWebRecovery(plan, confirmationSha256, options);
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Recovery-only boundary interrupted before receipt");
  const call = (await h.request()).output[0];
  await h.executeBrowser(call);
  h.observations.watchers.at(-1).onCancel();
  await h.restartRuntime();
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "Complete only the recovery boundary");
  const retry = (await h.request()).output[0], notice = await h.answerBrowser(retry);
  assert.match(notice.output[0].content[0].text, /no prompt was sent/u);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).recovery.stage, "bounded");
  assert.equal(h.browser.ui.sends.length, 2);
});

test("controlled recovery survives a REPL and Router restart after the durable boundary before the fresh Send", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options } = fixture;
  const { plan, confirmationSha256 } = await fixture.prepare();
  await confirmControlledWebRecovery(plan, confirmationSha256, options);
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Record the recovery-only boundary");
  const notice = await h.answerBrowser((await h.request()).output[0]); h.append(notice.output[0]);
  const boundary = JSON.parse(readFileSync(h.stateFile, "utf8")).recovery.inputHashes;
  await h.restartRuntime(); h.loseKernel(); h.browser.ui.tabId = "restored-after-boundary";
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "FRESH AFTER BOUNDARY RESTART");
  const { call } = await h.toObserve();
  assert.deepEqual(JSON.parse(readFileSync(h.stateFile, "utf8")).recovery.inputHashes, boundary);
  assert.match(h.browser.ui.sends.at(-1), /FRESH AFTER BOUNDARY RESTART/u);
  assert.doesNotMatch(h.browser.ui.sends.at(-1), /FAILED PRIVATE PROMPT|recovery-only boundary|Same-chat recovery boundary/u);
  await h.completeAnswer(call, "Fresh input survived the boundary restart.");
  assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
});

test("controlled recovery can abandon a repeated failure before fresh acceptance without admitting unknown extra turns", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options } = fixture;
  const first = await fixture.prepare();
  await confirmControlledWebRecovery(first.plan, first.confirmationSha256, options);
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "First recovery-only boundary");
  const firstNotice = await h.answerBrowser((await h.request()).output[0]); h.append(firstNotice.output[0]);
  const secondFailedId = "44002233-4455-6677-8899-aabbccddeeff";
  h.newTurn(secondFailedId, "SECOND FAILED PRIVATE PROMPT MUST NEVER BE REPLAYED");
  let response = await h.request();
  while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
  await h.executeBrowser(response.output[0]); h.browser.ui.stop = false;
  h.observations.watchers.at(-1).onCancel(); await h.restartRuntime();
  const inspection = inspectControlledWebRecovery(threadId, options);
  assert.deepEqual(inspection.request.proof.priorRevokedTurnIds, [followupId]);
  const inspect = () => h.executeBrowser({ type: "function_call", namespace: "mcp__node_repl", name: "js", arguments: JSON.stringify({ code: inspection.program }) });
  const second = prepareControlledWebRecovery(inspection.request, await inspect(), options);
  const foreignTurn = { key: "99002233-4455-6677-8899-aabbccddeeff", prompt: "Unknown extra user turn", baselineIds: [...h.browser.ui.turns.at(-1).baselineIds] };
  h.browser.ui.turns.push(foreignTurn);
  await assert.rejects(inspect(), /ownership-changed/u);
  h.browser.ui.turns.pop();
  await confirmControlledWebRecovery(second.plan, second.confirmationSha256, options);
  h.newTurn("55002233-4455-6677-8899-aabbccddeeff", "Second recovery-only boundary");
  const secondNotice = await h.answerBrowser((await h.request()).output[0]); h.append(secondNotice.output[0]);
  const recovered = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.deepEqual(recovered.recovery.revokedTurnIds, [followupId, secondFailedId]);
  assert.deepEqual(recovered.checkpoint, fixture.accepted.checkpoint);
  h.newTurn("66002233-4455-6677-8899-aabbccddeeff", "FRESH AFTER BOTH FAILURES");
  const { call } = await h.toObserve();
  assert.match(h.browser.ui.sends.at(-1), /FRESH AFTER BOTH FAILURES/u);
  assert.doesNotMatch(h.browser.ui.sends.at(-1), /FAILED PRIVATE PROMPT|recovery-only boundary|Same-chat recovery boundary/u);
  await h.completeAnswer(call, "Both failed attempts remain abandoned.");
  assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
});

test("the generated recovery inspection module imports with code generation from strings disabled and an explicit nodeRepl argument", async t => {
  const fixture = await controlledRecoveryFixture(t), { h, options } = fixture;
  const directory = path.dirname(h.stateFile), runtimeFile = path.join(directory, "inspection-browser-fixture.mjs");
  const ui = Object.fromEntries(["power", "chip", "stop", "texts", "turns", "composer", "url", "tabId", "present", "complete", "normalHome"]
    .map(key => [key, h.browser.ui[key]]));
  const browserSource = `import assert from 'node:assert/strict';\nimport { browserDom } from ${JSON.stringify(new URL("../src/web-browser.mjs", import.meta.url).href)};\nimport { domElement, domText, messageId, replyElement } from ${JSON.stringify(new URL("./web-dom-fixture.mjs", import.meta.url).href)};\nconst threadId = ${JSON.stringify(threadId)};\n${fakeBrowser.toString()}\nconst fixture = fakeBrowser(); Object.assign(fixture.ui, ${JSON.stringify(ui)});\nexport async function setupBrowserRuntime(){ return fixture.agent; }\n`;
  writeFileSync(runtimeFile, browserSource, "utf8");
  const inspection = inspectControlledWebRecovery(threadId, { ...options, settings: { ...h.settings,
    browser: { ...h.settings.browser, runtimeModule: pathToFileURL(runtimeFile).href } } });
  const moduleFile = path.join(directory, "recovery-inspection.browser.mjs"), entryFile = path.join(directory, "run-inspection.mjs");
  writeFileSync(moduleFile, inspection.moduleSource, "utf8");
  writeFileSync(entryFile, `import assert from 'node:assert/strict';\nassert.equal(globalThis.nodeRepl, undefined);\nlet receipt;\nawait (await import(${JSON.stringify(pathToFileURL(moduleFile).href)})).default({ write(value){ receipt = value; } });\nassert.ok(receipt.includes('ROUTER_WEB_BROWSER_'));\nconsole.log('IMPORTED_RECOVERY_OK');\n`, "utf8");
  const { stdout } = await promisify(execFile)(process.execPath, ["--disallow-code-generation-from-strings", entryFile], { windowsHide: true });
  assert.equal(stdout.trim(), "IMPORTED_RECOVERY_OK");
});

function fakeBrowser() {
  const ui = { power: 2, menu: false, chip: false, stop: false, texts: [], complete: false, sends: [], marks: 0, newTabs: 0, closes: 0, present: true, navigations: 0, reacquired: [], stopMarks: [],
    temporaryControls: false, normalHome: true, full: false, rollovers: 0, chatNumber: 1, composer: "", url: "https://chatgpt.com/", tabId: "owned-saved-tab", savedReplies: new Map(), turns: [], savedTurns: new Map() };
  let completed = false;
  Object.defineProperty(ui, "complete", { get: () => completed, set(value) { completed = value; if (value) ui.stop = false; } });
  // A locator union projects one rendered tree, as the SDK does. Semantic
  // membership stays in the locator model; page readers see ordinary DOM nodes.
  let currentRender;
  const render = () => {
    const control = (tag, name, visible = true, attributes = {}) => {
      const element = domElement(tag, { "aria-label": name, ...attributes }, domText(name));
      element.fixtureVisible = visible;
      element.getBoundingClientRect = () => ({ width: visible ? 32 : 0, height: visible ? 32 : 0 });
      return element;
    };
    let root = ui.observationRoot;
    if (!root) {
      const roots = ui.turns.map((turn, index) => domElement("section", { [browserDom.turnKeyAttribute]: turn.key },
        domElement("div", { [browserDom.turnStateAttribute]: index < ui.turns.length - 1 || ui.complete ? "complete" : "streaming" },
          domElement("div", {}, domText(turn.prompt)))));
      const leadingUnowned = [], trailingUnowned = [];
      let hasOwnedReply = false;
      const elements = ui.replyElements ?? ui.texts.map((value, index) => replyElement(value, ui.replyIds ? ui.replyIds[index] : messageId(index)));
      const placed = new Set();
      for (const [index, element] of elements.entries()) {
        if (!element.getAttribute("data-markdown-text-style")) element.setAttribute("data-markdown-text-style", "assistant-message");
        const wrapper = element.closest(browserDom.messageSelector), replyId = wrapper?.getAttribute(browserDom.messageIdAttribute);
        if (!wrapper && ui.replyElements) {
          // Preserve the existing detached-wrapper fault: the selected markdown
          // root survives a renderer mutation before its wrapper is read.
          const matches = element.matches.bind(element);
          element.matches = selector => selector === browserDom.assistantFinalReplySelector || matches(selector);
        }
        let turn = roots[ui.turns.findLastIndex(value => !value.baselineIds.includes(replyId))];
        const alternate = ui.replyTurnKeys?.[index];
        if (alternate) {
          turn = roots.find(value => value.getAttribute(browserDom.turnKeyAttribute) === alternate);
          if (!turn) { turn = domElement("section", { [browserDom.turnKeyAttribute]: alternate }); roots.push(turn); }
        }
        const node = wrapper ?? element;
        if (placed.has(node)) continue;
        placed.add(node);
        const content = element.commentary ? domElement("div", { "data-streaming-response-status": "active" }, node) : node;
        if (turn) {
          hasOwnedReply = true;
          const target = turn.querySelector(browserDom.turnStateSelector) ?? turn;
          target.childNodes.push(content); target.children.push(content); content.parentElement = target;
        } else (hasOwnedReply ? trailingUnowned : leadingUnowned).push(content);
      }
      for (const turn of roots) {
        const state = turn.querySelector(browserDom.turnStateSelector);
        if (state?.getAttribute(browserDom.turnStateAttribute) !== "complete") continue;
        const action = control("button", browserDom.regenerateButtonExactName);
        state.childNodes.push(action); state.children.push(action); action.parentElement = state;
      }
      root = domElement("main", {}, ...(ui.orphanMarkdownBefore ?? []), ...leadingUnowned, ...roots, ...trailingUnowned, ...(ui.orphanMarkdownAfter ?? []));
    }
    const composer = control("div", browserDom.composerName, true, { role: "textbox", contenteditable: "true" });
    composer.childNodes = [domText(ui.composer)]; composer.children = []; composer.innerText = ui.composer;
    if (ui.chip) {
      const chip = domElement("span", { "app-mention-display-name": "Current Codex Tools", "app-mention-path": "app://asdk_current_tools", contenteditable: "false" });
      chip.getBoundingClientRect = () => ({ width: 32, height: 32 });
      composer.childNodes.push(chip); composer.children.push(chip); chip.parentElement = composer;
    }
    const controls = [
      control("button", browserDom.modelButtonName),
      control("button", browserDom.temporaryButtonName, ui.normalHome),
      ...Array.from({ length: ui.stopCount ?? 1 }, () => control("button", "Stop", ui.stop && !ui.full)),
      ...Array.from({ length: ui.idleCount ?? (ui.stop && !ui.full ? 0 : 1) }, () => control("button", "Start Voice", ui.idleVisible ?? (!ui.stop || ui.full))),
      ...(ui.temporaryControls ? [control("button", "Turn off temporary chat"), control("h2", "Temporary chat")] : []),
      ...(ui.full ? [control("div", browserDom.conversationFullText), control("button", "Start new chat")] : []),
      ...(!ui.observationRoot ? [composer] : []),
    ];
    const body = domElement("body", {}, root, ...controls);
    body.ownerDocument = { body, URL: ui.url, querySelectorAll: selector => body.querySelectorAll(selector),
      defaultView: { getComputedStyle: element => ({ visibility: element.fixtureVisible === false ? "hidden" : "visible" }) } };
    const order = [];
    const visit = element => { order.push(element); element.children.forEach(visit); };
    visit(body);
    for (const element of order) element.getBoundingClientRect ??= () => ({ width: 32, height: 32 });
    return { body, order };
  };
  const locator = (kind, name, visibleOnly = false, filters = [], offset, scope) => {
    const bodyQuery = kind === "selector" && (name === "body" || name.startsWith("xpath=//body["));
    const generationRoots = () => {
      const turns = ui.turns.map((turn, index) => ({
        getAttribute: attribute => attribute === browserDom.turnKeyAttribute ? turn.key : null,
        querySelectorAll: selector => selector === browserDom.turnStateSelector
          ? [{ getAttribute: () => index < ui.turns.length - 1 || ui.complete ? "complete" : "streaming" }] : [],
      }));
      for (const key of ui.replyTurnKeys ?? []) if (key && !ui.turns.some(turn => turn.key === key)) {
        turns.push({ getAttribute: attribute => attribute === browserDom.turnKeyAttribute ? key : null, querySelectorAll: () => [] });
      }
      return turns;
    };
    const matched = () => {
      if (scope && !scope.fixtureCount()) return 0;
      let count = 1;
      if (bodyQuery && name !== "body") {
        const key = name.match(/@data-turn-key='([^']+)'/u)?.[1], roots = generationRoots();
        const owned = roots.filter(root => root.getAttribute(browserDom.turnKeyAttribute) === key);
        if (owned.length !== 1 || name.includes(")[last()]") && roots.at(-1)?.getAttribute(browserDom.turnKeyAttribute) !== key) count = 0;
        if (name.includes(browserDom.turnStateAttribute) && owned[0]?.querySelectorAll(browserDom.turnStateSelector)[0]?.getAttribute() !== "complete") count = 0;
        const replyId = /@data-chatgpt-selection-message-id='([^']+)'/u.exec(name)?.[1];
        if (replyId) {
          const { body } = currentRender ?? render(), messages = body.querySelectorAll(`[data-chatgpt-selection-message-id="${replyId}"]`);
          if (messages.length !== 1 || messages[0].closest(browserDom.turnSelector)?.getAttribute(browserDom.turnKeyAttribute) !== key) count = 0;
        }
      } else if (name === "Stop") count = ui.stopCount ?? 1;
      else if (kind === "selector" && [browserDom.assistantFinalReplySelector, browserDom.assistantSelector].includes(name)) {
        const { body } = currentRender ?? render();
        count = (scope?.selector ? body.querySelectorAll(scope.selector) : [body]).flatMap(root => root.querySelectorAll(name)).length;
      }
      else if (name === "Start Voice") count = ui.idleCount ?? (ui.stop && !ui.full ? 0 : 1);
      else if (name === "Turn off temporary chat" || name === "Temporary chat" && kind === "heading") count = Number(ui.temporaryControls);
      else if (kind === "text") {
        const { order } = currentRender ?? render();
        count = order.filter(element => element.textContent === name && !element.children.some(child => child.textContent === name)).length;
      }
      else if (kind === "menuitemradio") count = 0;
      if (visibleOnly && (name === "Stop" && (!ui.stop || ui.full) || name === "Start Voice" && !(ui.idleVisible ?? (!ui.stop || ui.full)))) count = 0;
      if (visibleOnly && kind === "button" && name === browserDom.temporaryButtonName && !ui.normalHome) count = 0;
      if (filters.some(({ has, hasNot }) => has && !has.fixtureCount() || hasNot && hasNot.fixtureCount())) count = 0;
      return offset === undefined ? count : offset < count ? 1 : 0;
    };
    return {
    kind, name,
    fixtureCount: matched,
    or(other) {
      const first = this;
      const selections = [first, other];
      return {
        or(next) { selections.push(next); return this; },
        async evaluateAll(callback, args) {
          const previous = currentRender;
          currentRender = render();
          try {
            const elements = [];
            for (const selection of selections) elements.push(...await selection.evaluateAll(values => values, args));
            const selected = new Set(elements);
            return callback(currentRender.order.filter(element => selected.has(element)), args);
          } finally { currentRender = previous; }
        },
      };
    },
    nth: index => locator(kind, name, visibleOnly, filters, index, scope),
    getByRole: (childKind, options) => locator(childKind, options.name, false, [], undefined,
      kind === "selector" ? { fixtureCount: matched, selector: bodyQuery ? undefined : name } : scope),
    locator: selector => locator("selector", selector, false, [], undefined,
      kind === "selector" ? { fixtureCount: matched, selector: bodyQuery ? undefined : name } : scope),
    filter({ hasText, visible, has, hasNot }) {
      if (visible !== undefined || has || hasNot) return locator(kind, name, visible ?? visibleOnly, [...filters, { has, hasNot }], offset, scope);
      assert.equal(kind, "selector");
      if (name === browserDom.turnSelector) return locator(kind, name, visibleOnly, [...filters, { hasText }], offset, scope);
      assert.equal(name, '[role="menuitemradio"]');
      return locator("family-text", hasText);
    },
    async count() { return matched(); },
    async isVisible() {
      if (kind === "menu") return ui.menu;
      if (name === "Stop") return ui.stop && !ui.full;
      if (name === "Start Voice") return matched() > 0 && (ui.idleVisible ?? (!ui.stop || ui.full));
      if (name === "Regenerate response") return ui.complete;
      if (name === "Temporary chat") return kind === "heading" ? ui.temporaryControls : ui.normalHome;
      if (name === "Turn off temporary chat") return ui.temporaryControls;
      if (kind === "heading") return false;
      if (kind === "selector" && name.startsWith("span[app-mention")) return ui.chip;
      return true;
    },
    async click() {
      if (scope) {
        assert.equal(matched(), 1, "Conditional controls must still match their owned body at click resolution.");
        assert.equal(await this.isVisible(), true, "The scoped control must be visible when clicked.");
      }
      if (name === "Select ChatGPT model") ui.menu = !ui.menu;
      else if (name === "Current Codex Tools Workspace tools") ui.chip = true;
      else if (name === "Stop") { ui.stopMarks.push(ui.marks); ui.stop = false; ui.afterStopClick?.(); }
      else if (name === "Start new chat") {
        ui.rollovers += 1; ui.chatNumber += 1; ui.full = false; ui.normalHome = true; ui.url = "https://chatgpt.com/";
        ui.texts = []; ui.turns = []; ui.composer = ""; ui.chip = false; ui.complete = false; ui.stop = false;
      }
      else if (name === "Send") {
        const baselineIds = ui.replyElements?.map(element => element.closest('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id'))
          ?? ui.texts.map((_, index) => ui.replyIds?.[index] ?? messageId(index));
        ui.turns.push({ key: messageId(10000 + ui.sends.length), prompt: ui.composer, baselineIds });
        ui.sends.push(ui.composer); ui.composer = ""; ui.complete = false; ui.stop = true;
        ui.normalHome = false;
        ui.url = `https://chatgpt.com/c/${ui.chatNumber === 1 ? "owned-conversation" : `successor-${ui.chatNumber}`}`;
        ui.savedReplies.set(ui.url, ui.texts);
        ui.savedTurns.set(ui.url, ui.turns);
        ui.afterSend?.();
      }
    },
    async getAttribute(attribute) { return { "aria-checked": "true", "aria-valuenow": String(ui.power), "aria-valuemin": "0", "aria-valuemax": "4" }[attribute] ?? null; },
    async textContent() { return name; }, async innerText() { return name === "Ask ChatGPT" ? ui.composer : ui.power === 0 ? "GPT-6 Instant" : "GPT-6 Thinking"; },
    async isEnabled() { return true; },
    async press(key) { if (name === "Power") { if (key === "Escape") ui.menu = false; else ui.power += key === "ArrowLeft" ? -1 : 1; } },
    async type(text) { ui.composer = (ui.composer ?? "") + text; },
    async waitFor({ state }) {
      if (bodyQuery) {
        assert.equal(state, "visible");
        if (matched() !== 1) throw new Error("Error: Playwright selector deadline exceeded\nlocator.waitFor(visible) timed out");
      } else if (state === "attached") {
        assert.equal(kind, "selector"); assert.equal(name, browserDom.turnSelector);
        const candidates = ui.turns.filter(turn => filters.every(filter => (filter.hasText === undefined || turn.prompt.includes(filter.hasText))
          && (!filter.hasNot || !filter.hasNot.name.includes(`='${turn.key}'`))));
        assert.equal(candidates.length, 1);
        assert.match(candidates[0].key, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu);
      } else assert.equal(await this.isVisible(), state === "visible");
    },
    async evaluateAll(callback, options) {
      const { body, order } = currentRender ?? render();
      let selected;
      if (bodyQuery) selected = matched() ? [body] : [];
      else if (kind === "selector") {
        selected = body.querySelectorAll(name);
        if (name.includes(browserDom.assistantFinalReplySelector)) selected.push(...(ui.replyElements ?? [])
          .filter(element => !element.closest(browserDom.messageSelector)));
      }
      else if (kind === "text") selected = order.filter(element => element.textContent === name
        && !element.children.some(child => child.textContent === name));
      else {
        selected = order.filter(element => element.getAttribute("aria-label") === name
          && (kind === "textbox" ? element.matches(browserDom.composerSelector)
            : kind === "heading" ? /^(?:H[1-6])$/u.test(element.tagName) || element.getAttribute("role") === "heading"
              : element.matches(browserDom.buttonSelector)));
        if (scope?.selector) selected = selected.filter(element => element.closest(scope.selector));
        if (scope && !scope.fixtureCount()) selected = [];
      }
      if (visibleOnly) selected = selected.filter(element => element.getBoundingClientRect().width > 0);
      if (offset !== undefined) selected = selected.slice(offset, offset + 1);
      const result = callback(selected, options);
      if (bodyQuery) ui.afterStopRead?.();
      return result;
    },
  };
  };
  const tab = { get id() { return ui.tabId; }, goto: async url => {
    ui.navigations += 1; ui.url = url; ui.normalHome = url === "https://chatgpt.com/";
    ui.texts = ui.savedReplies.get(url) ?? []; ui.composer = ui.savedComposers?.get(url) ?? "";
    ui.turns = ui.savedTurns.get(url) ?? [];
    ui.stop = ui.savedStops?.get(url) ?? (ui.turns.length > 0 && !ui.complete && !ui.full);
  }, url: async () => ui.sdkUrl ?? ui.url,
    playwright: { waitForURL: async (expected, { timeoutMs }) => {
      assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0);
      if (ui.url !== expected) throw new Error("Expected browser URL is unavailable.");
    }, getByRole: (kind, options) => locator(kind, options.name), getByText: text => locator("text", text), locator: selector => locator("selector", selector) },
    markHandoff: async () => { ui.marks += 1; }, close: async () => { ui.closes += 1; ui.present = false; } };
  const browser = { browserId: "same-session-iab",
    documentation: async () => "Synthetic browser guidance",
    tabs: { list: async () => ui.present ? [{ id: tab.id, url: await tab.url() }] : [],
      get: async tabId => { ui.reacquired.push(tabId); assert.equal(tabId, tab.id); return tab; },
      new: async () => {
        ui.newTabs += 1;
        if (!ui.present) {
          ui.tabId = `reopened-saved-tab-${ui.newTabs}`; ui.url = "about:blank"; ui.texts = []; ui.composer = ""; ui.normalHome = false; ui.stop = false;
        }
        ui.present = true; return tab;
      } } };
  const agent = { browsers: { list: async () => [{ type: "iab", id: browser.browserId, metadata: { codexSessionId: threadId } }],
    get: async id => { assert.equal(id, browser.browserId); return browser; } } };
  return { ui, agent, browser, tab };
}

let fixtureNumber = 0;
function harness(t, { tools = [nativeJs, currentRead], toolChoice = "auto", instructions, cancelDuringWatch = false, watcherClosure = async () => {},
  tunnelReadiness = () => Promise.resolve(), tunnelClosure = async () => {}, mcpClosure = async () => {},
  expectedCloseCode, storage = syntheticStorage, mcpFactory } = {}) {
  const browser = fakeBrowser();
  const key = `router-web-runtime-test-${++fixtureNumber}`;
  globalThis[Symbol.for(key)] = browser.agent;
  const runtimeModule = `data:text/javascript,${encodeURIComponent(`export async function setupBrowserRuntime(){ return globalThis[Symbol.for(${JSON.stringify(key)})]; }`)}`;
  let broker = createWebToolBroker({ invocationTimeoutMs: 5000 });
  const observations = { watchers: [], services: [], nativeOperations: [], bindings: [], fetchCalls: 0 };
  const settings = { browser: { runtimeModule, pluginName: "Current Codex Tools", pluginAppId: "asdk_current_tools",
    pluginSelectionButtonName: "Current Codex Tools Workspace tools" },
  tunnel: { executable: "test-tunnel", id: "test-owned-tunnel" }, mcpPort: 0 };
  const runtimeStateDir = path.join(stateDir, key);
  const makeRuntime = () => createInAppWebRuntime({ broker, stateDir: runtimeStateDir, ...storage,
    startMcp: async options => {
      assert.equal(options.broker, broker);
      observations.services.push("mcp");
      if (mcpFactory) return mcpFactory(options);
      return { url: "http://127.0.0.1:40123/mcp",
        observationUrl: (token, revision) => `http://127.0.0.1:40123/${"a".repeat(64)}/observe/${token}?revision=${revision}`,
        status: () => ({ healthy: true }), close: async () => { observations.services.push("mcp-closed"); await mcpClosure(); } };
    },
    startTunnel: async options => {
      observations.services.push("tunnel");
      return { ready: tunnelReadiness(options), status: () => ({ healthy: true }), close: async () => { observations.services.push("tunnel-closed"); await tunnelClosure(); } };
    },
    watchCancellation: options => {
      const watcher = { ...options, closed: false };
      observations.watchers.push(watcher);
      return { ready: Promise.resolve().then(() => { if (cancelDuringWatch) options.onCancel(); }), close: async () => { watcher.closed = true; await watcherClosure(watcher); } };
    },
  });
  let runtime = makeRuntime();
  t.after(async () => {
    try {
      if (expectedCloseCode) await assert.rejects(runtime.close(), { code: expectedCloseCode });
      else await runtime.close();
    } finally { delete globalThis[Symbol.for(key)]; }
  });
  let nativeContext = {};
  let payload = { model: "chatgpt-web/gpt-6-sol-instant", reasoning: { effort: "low" }, stream: false,
    tools: structuredClone(tools), tool_choice: toolChoice, instructions, input: [{ role: "user", content: "Read the current file using the declared tools." }] };
  let currentTurn = turnId;
  const requestResponse = (override = {}) => runtime.request({ ...payload, ...override }, { headers: headers(currentTurn), settings });
  const request = async (override = {}) => (await requestResponse(override)).json();
  const executeBrowser = async call => {
    assert.equal(call.type, "function_call");
    assert.equal(call.namespace, "mcp__node_repl");
    assert.equal(call.name, "js");
    const args = JSON.parse(call.arguments);
    const binding = args.code.match(/\brouterWeb_[A-Za-z0-9_]+\b/)?.[0];
    assert.ok(binding, "The emitted native JavaScript carries its persistent binding.");
    observations.bindings.push(binding);
    let framed;
    const nativeFetch = () => { observations.fetchCalls += 1; throw new Error("Native browser sandbox does not allow loopback fetch."); };
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("nodeRepl", "fetch", "globalThis", args.code);
    await execute({ write: value => { framed = value; } }, nativeFetch, nativeContext);
    const token = framed.match(/^ROUTER_WEB_BROWSER_([A-Za-z0-9_-]+)_BEGIN\n/)?.[1];
    const value = parseBrowserOutput(framed, token);
    observations.nativeOperations.push(value.operation);
    return framed;
  };
  const answerBrowser = async call => {
    const output = await executeBrowser(call);
    payload.input.push(call, outputFor(call, output));
    return request();
  };
  const completeAnswer = async (call, answer) => {
    browser.ui.texts.push(answer); browser.ui.complete = true;
    const retained = await answerBrowser(call), final = await answerBrowser(retained.output[0]);
    assert.equal(final.output[0].content[0].text, answer);
    payload.input.push(final.output[0]);
  };
  const toObserve = async () => {
    let response = await request();
    for (let round = 0; round < 8; round += 1) {
      const call = response.output[0];
      if (JSON.parse(call.arguments).title === "Wait for ChatGPT or its next Codex tool request") return { response, call };
      response = await answerBrowser(call);
    }
    throw new Error("Browser orchestration did not reach observation.");
  };
  return { get runtime() { return runtime; }, get broker() { return broker; }, browser, observations, settings, request, requestResponse, executeBrowser, answerBrowser, completeAnswer, toObserve,
    token: () => {
      const token = browser.ui.sends.at(-1)?.match(/Use turn_token (web_turn_[a-f0-9]{32}) unchanged/u)?.[1];
      assert.ok(token, "The actual browser prompt supplies its current native tool turn token.");
      return token;
    }, input: () => payload.input,
    browserOwner: () => nativeContext.routerWebActiveTurns?.get(threadId),
    replaceBrowserOwner: owner => nativeContext.routerWebActiveTurns = new Map([[threadId, owner]]),
    append: (...items) => payload.input.push(...items),
    loseKernel: () => { nativeContext = {}; },
    restartRuntime: async () => { await runtime.close(); broker = createWebToolBroker({ invocationTimeoutMs: 5000 }); runtime = makeRuntime(); },
    stateFile: path.join(runtimeStateDir, "web-in-app", "conversations", `${threadId}.json`),
    newTurn: (turn, userText, overrides = {}) => { currentTurn = turn; payload = { ...payload, ...overrides, input: [...payload.input, { role: "user", content: userText }] }; },
  };
}

test("dispatched input stays private until its eventual anchor and substantive acceptance", async t => {
  for (const delayed of ["generation", "saved URL"]) await t.test(delayed, async t => {
    const h = harness(t, { instructions: "Delayed current instructions." });
    let pendingTurns;
    h.browser.ui.afterSend = () => {
      if (delayed === "generation") pendingTurns = h.browser.ui.turns.splice(0);
      else h.browser.ui.url = "https://chatgpt.com/";
    };
    const { call } = await h.toObserve();
    const uncertain = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(uncertain.uncertainSend, true); assert.equal(uncertain.lastTurn.sendState, "uncertain");
    assert.equal(uncertain.checkpoint, undefined); assert.equal(uncertain.generationTurnKey, undefined);
    assert.equal(uncertain.deliveredInstructionsSha256, undefined); assert.equal(uncertain.chatUrl, undefined);
    h.browser.ui.afterSend = undefined;
    if (pendingTurns) h.browser.ui.turns = pendingTurns;
    h.browser.ui.url = "https://chatgpt.com/c/owned-conversation";
    const observe = (await h.answerBrowser(call)).output[0];
    const anchored = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(anchored.uncertainSend, true); assert.equal(anchored.checkpoint, undefined);
    assert.equal(h.browserOwner().state.sendConfirmed, true, "The anchor grants browser ownership only.");
    await h.completeAnswer(observe, "Accepted after the actual state event.");
    const accepted = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(accepted.uncertainSend, false); assert.equal(accepted.generationTurnKey, h.browser.ui.turns.at(-1).key);
    assert.equal(accepted.deliveredInstructionsGenerationTurnKey, accepted.generationTurnKey);
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("runtime pending receipts accept home URL variants before coherent saved-chat acquisition", async t => {
  for (const home of ["https://chatgpt.com", "https://chatgpt.com/?model=synthetic"]) await t.test(home.includes("?") ? "model query" : "no slash", async t => {
    const h = harness(t);
    h.browser.ui.afterSend = () => { h.browser.ui.url = home; };
    const { call } = await h.toObserve();
    const uncertain = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(uncertain.uncertainSend, true); assert.equal(uncertain.chatUrl, undefined); assert.equal(uncertain.checkpoint, undefined);
    h.browser.ui.url = "https://chatgpt.com/c/owned-conversation"; h.browser.ui.sdkUrl = home;
    const anchored = (await h.answerBrowser(call)).output[0];
    assert.equal(h.browserOwner().state.sendConfirmed, true);
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).uncertainSend, true);
    h.browser.ui.sdkUrl = undefined;
    await h.completeAnswer(anchored, "Accepted only after current generation evidence.");
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).uncertainSend, false);
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("first-Send route settlement retains no unknown URL or acknowledgement before coherent saved-chat proof", async t => {
  const h = harness(t);
  h.browser.ui.afterSend = () => { h.browser.ui.url = "https://chatgpt.com/PRIVATE_TRANSITION_CANARY"; };
  const { call } = await h.toObserve();
  const unconfirmed = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(unconfirmed.uncertainSend, true); assert.equal(unconfirmed.chatUrl, undefined);
  assert.equal(unconfirmed.checkpoint, undefined); assert.equal(unconfirmed.generationTurnKey, undefined);
  assert.equal(h.browserOwner().state.savedUrl, undefined);
  assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
  assert.equal(JSON.stringify(h.input()).includes("PRIVATE_TRANSITION_CANARY"), false);
  assert.equal(readFileSync(h.stateFile, "utf8").includes("PRIVATE_TRANSITION_CANARY"), false);
  h.browser.ui.url = "https://chatgpt.com/c/settled-conversation";
  await h.completeAnswer(call, "Accepted only after saved URL and marker settlement.");
  const accepted = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(accepted.uncertainSend, false); assert.equal(accepted.chatUrl, h.browser.ui.url);
  assert.equal(h.browser.ui.sends.length, 1);
});

test("unconfirmed URL receipts cannot replace an established saved conversation", async t => {
  const h = harness(t), { call } = await h.toObserve();
  await h.completeAnswer(call, "First confirmed answer.");
  const prior = JSON.parse(readFileSync(h.stateFile, "utf8"));
  h.newTurn(followupId, "Next request.");
  const continuation = (await h.request()).output[0], send = (await h.answerBrowser(continuation)).output[0];
  h.append(send, outputFor(send, browserReceipt(send, { operation: "send", sent: false, dispatched: true,
    generationPending: true, tabId: prior.tabId, url: null, normal: false, urlPending: true,
    conversationFull: false, baselineReplyIds: prior.sendBaselineReplyIds })));
  await assert.rejects(h.request(), /did not establish the connected saved chat URL/u);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.uncertainSend, true); assert.equal(saved.chatUrl, prior.chatUrl);
  assert.deepEqual(saved.checkpoint, prior.checkpoint); assert.equal(h.browser.ui.sends.length, 1);
});

test("runtime rejects non-home first-open receipts even with a normal flag", async t => {
  for (const url of ["https://chatgpt.com/c/unowned", "https://chatgpt.com/?temporary-chat=true", "https://foreign.invalid/", "https://private-user@chatgpt.com/", "https://chatgpt.com/#private"]) await t.test(url, async t => {
    const h = harness(t);
    const bootstrap = (await h.request()).output[0], open = (await h.answerBrowser(bootstrap)).output[0];
    h.append(open, outputFor(open, browserReceipt(open, { operation: "open", normal: true, tabId: "owned-saved-tab", url })));
    await assert.rejects(h.request(), /owned saved ChatGPT conversation was not established/);
    assert.equal(h.browser.ui.sends.length, 0);
  });
});

test("current-token native calls queued before an anchor wait for that anchor and keep their exact request", async t => {
  const h = harness(t);
  let pendingTurns;
  h.browser.ui.afterSend = () => { pendingTurns = h.browser.ui.turns.splice(0); };
  const bootstrap = (await h.request()).output[0], open = (await h.answerBrowser(bootstrap)).output[0];
  const send = (await h.answerBrowser(open)).output[0], dispatched = await h.executeBrowser(send);
  const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
  const invoked = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "queued-before-anchor.txt" } });
  const outcome = invoked.catch(error => error);
  h.append(send, outputFor(send, dispatched));
  const call = (await h.request()).output[0];
  const wait = readBrowserProgram(JSON.parse(call.arguments).code).observationWait;
  assert.ok(Number(new URL(wait.url).searchParams.get("revision")) < h.broker.revision(h.token()),
    "Activity predating the first observation must still wake its held queue.");
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).uncertainSend, true);
  assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
  h.browser.ui.turns = pendingTurns; h.browser.ui.afterSend = undefined;
  const emitted = (await h.answerBrowser(call)).output[0];
  assert.equal(emitted.namespace, "mcp__work"); assert.deepEqual(JSON.parse(emitted.arguments), { path: "queued-before-anchor.txt" });
  const accepted = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(accepted.uncertainSend, false); assert.equal(accepted.generationTurnKey, pendingTurns[0].key);
  assert.equal(accepted.deliveredInstructionsGenerationTurnKey, pendingTurns[0].key);
  h.append(emitted, outputFor(emitted, "ACTUAL_QUEUED_RESULT")); await h.request();
  assert.ok(await outcome); assert.equal(h.browser.ui.sends.length, 1);
});

test("cancellation before an anchor preserves the prior durable delivery despite current-token activity", async t => {
  const h = harness(t), { call } = await h.toObserve();
  await h.completeAnswer(call, "Prior confirmed answer.");
  const prior = JSON.parse(readFileSync(h.stateFile, "utf8"));
  h.newTurn(followupId, "Pending revised input.", { instructions: "New instructions await proof." });
  h.browser.ui.afterSend = () => { h.browser.ui.turns.pop(); };
  await h.toObserve();
  const releaseActivity = h.broker.beginActivity(h.token()); releaseActivity();
  h.observations.watchers.at(-1).onCancel();
  await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  await h.runtime.close();
  const cancelled = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(cancelled.uncertainSend, true); assert.equal(cancelled.lastTurn.sendState, "uncertain");
  for (const key of ["checkpoint", "generationTurnKey", "deliveredInstructionsSha256", "deliveredInstructionsGenerationTurnKey", "chatUrl"]) assert.deepEqual(cancelled[key], prior[key]);
  assert.deepEqual(cancelled.unresolvedCoding, []); assert.equal(h.browser.ui.stopMarks.length, 0);
  assert.equal(h.browser.ui.sends.length, 2);
});

test("Send failure receipts require their exact nonce, producer shape and fixed error code", async t => {
  for (const branch of ["recognized", "recognized diagnostic", "private diagnostic", "wrong nonce", "private extra", "unknown reason", "wrong operation"]) await t.test(branch, async t => {
    const h = harness(t);
    const bootstrap = (await h.request()).output[0], open = (await h.answerBrowser(bootstrap)).output[0];
    const send = (await h.answerBrowser(open)).output[0];
    const receipt = { operation: branch === "wrong operation" ? "observe" : "send", sendFailure: branch === "unknown reason" ? "private error" : branch.includes("diagnostic") ? "saved-url" : "anchor-conflict",
      ...(branch.includes("diagnostic") ? { sendDiagnostic: branch === "recognized diagnostic" ? "normal-controls-unavailable" : "PRIVATE_ERROR_CANARY" } : {}),
      ...(branch === "private extra" ? { privateText: "PRIVATE_ERROR_CANARY" } : {}) };
    h.append(send, outputFor(send, browserReceipt(send, receipt, branch === "wrong nonce" ? "f".repeat(48) : undefined)));
    await assert.rejects(h.request(), { code: branch.startsWith("recognized") ? "web_send_uncertain" : branch === "wrong operation" ? "web_runtime_unavailable" : "web_browser_output_shape" });
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(saved.uncertainSend, true); assert.equal(saved.checkpoint, undefined);
    assert.equal(readFileSync(h.stateFile, "utf8").includes("PRIVATE_ERROR_CANARY"), false);
    assert.equal(h.browser.ui.sends.length, 0);
  });
});

test("Send URL diagnostics cross the runtime boundary only with the exact content-free schema", async t => {
  const parsed = { input: "parsed", protocolValid: true, originValid: true, pathClass: "other",
    temporaryChatPresent: false, hashPresent: false, credentialsPresent: false };
  const unknown = { protocolValid: null, originValid: null, pathClass: null,
    temporaryChatPresent: null, hashPresent: null, credentialsPresent: null };
  const cases = [
    ["parsed", parsed, true],
    ["non-string", { input: "non-string", ...unknown }, true],
    ["unparseable", { input: "unparseable", ...unknown }, true],
    ["extra URL", { ...parsed, url: "PRIVATE_URL_CANARY" }, false],
    ["private input", { ...parsed, input: "PRIVATE_URL_CANARY" }, false],
    ["private path", { ...parsed, pathClass: "PRIVATE_PATH_CANARY" }, false],
    ["nonboolean", { ...parsed, originValid: "PRIVATE_ORIGIN_CANARY" }, false],
    ["missing field", Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "hashPresent")), false],
    ["unparsed flags", { ...parsed, input: "unparseable" }, false],
    ["wrong reason", parsed, false],
    ["wrong failure", parsed, false],
  ];
  for (const [name, diagnostic, valid] of cases) await t.test(name, async t => {
    const h = harness(t);
    const bootstrap = (await h.request()).output[0], open = (await h.answerBrowser(bootstrap)).output[0];
    const send = (await h.answerBrowser(open)).output[0];
    const receipt = { operation: "send", sendFailure: name === "wrong failure" ? "anchor-conflict" : "saved-url",
      sendDiagnostic: name === "wrong reason" ? "normal-controls-unavailable" : "url-class-mismatch", sendUrlDiagnostic: diagnostic };
    h.append(send, outputFor(send, browserReceipt(send, receipt)));
    await assert.rejects(h.request(), error => {
      assert.equal(error.code, valid ? "web_send_uncertain" : "web_browser_output_shape");
      assert.doesNotMatch(error.message, /PRIVATE_/u);
      if (valid) assert.ok(error.message.endsWith(JSON.stringify(diagnostic)));
      return true;
    });
    const state = readFileSync(h.stateFile, "utf8"), saved = JSON.parse(state);
    assert.equal(saved.uncertainSend, true); assert.equal(saved.checkpoint, undefined);
    assert.equal(state.includes("PRIVATE_"), false); assert.equal(h.browser.ui.sends.length, 0);
  });
});

async function reportObservation(h, call, fields) {
  const output = await h.executeBrowser(call);
  const frameToken = readBrowserProgram(JSON.parse(call.arguments).code).frameToken;
  const observed = parseBrowserOutput(output, frameToken);
  h.append(call, outputFor(call, `ROUTER_WEB_BROWSER_${frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: { ...observed, ...fields } })}\nROUTER_WEB_BROWSER_${frameToken}_END`));
  return h.request();
}

async function fullContinuationAfterMiss(h, call) {
  const config = readBrowserProgram(JSON.parse(call.arguments).code);
  assert.equal(config.operation, "continue");
  assert.equal(config.fullContinuation, undefined);
  const output = await h.executeBrowser(call);
  assert.deepEqual(parseBrowserOutput(output, config.frameToken), { operation: "continue", needsFullContinuation: true, noActions: true });
  h.append(call, outputFor(call, output));
  const full = (await h.request()).output[0];
  assert.equal(readBrowserProgram(JSON.parse(full.arguments).code).fullContinuation, true);
  return full;
}

function browserReceipt(call, value, frameToken = readBrowserProgram(JSON.parse(call.arguments).code).frameToken) {
  return `ROUTER_WEB_BROWSER_${frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: value })}\nROUTER_WEB_BROWSER_${frameToken}_END`;
}

test("warm Continue and Send reuse the installed mutation cache while lost kernels get one bounded full install", async t => {
  for (const lostKernel of [false, true]) await t.test(lostKernel ? "lost kernel" : "warm cache", async t => {
    const h = harness(t), { call } = await h.toObserve();
    await h.completeAnswer(call, "Original completed answer");
    const originalCache = h.browserOwner().state.residentMutation;
    if (lostKernel) h.loseKernel();
    h.newTurn(followupId, "Only this follow-up should be sent.");
    let continuation = (await h.request()).output[0];
    const fast = readBrowserProgram(JSON.parse(continuation.arguments).code);
    assert.equal(fast.fullContinuation, undefined);
    assert.ok(Buffer.byteLength(continuation.arguments, "utf8") < 10000);
    if (lostKernel) {
      const before = [h.browser.ui.marks, h.browser.ui.newTabs, h.browser.ui.navigations, h.browser.ui.sends.length];
      continuation = await fullContinuationAfterMiss(h, continuation);
      assert.deepEqual([h.browser.ui.marks, h.browser.ui.newTabs, h.browser.ui.navigations, h.browser.ui.sends.length], before);
      assert.equal((await h.request()).output[0].call_id, continuation.call_id, "The full-install handoff is replayed by identity until its actual result.");
    }
    const send = (await h.answerBrowser(continuation)).output[0];
    assert.equal(readBrowserProgram(JSON.parse(send.arguments).code).operation, "send");
    assert.ok(Buffer.byteLength(send.arguments, "utf8") < 10000);
    assert.equal(h.browser.ui.sends.length, 1);
    if (!lostKernel) assert.equal(h.browserOwner().state.residentMutation, originalCache);
    const observe = (await h.answerBrowser(send)).output[0];
    assert.equal(readBrowserProgram(JSON.parse(observe.arguments).code).operation, "observe");
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Only this follow-up should be sent." }]);
    assert.equal(h.browser.ui.sends.length, 2);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("only an exact current no-action receipt permits one full Continue and never a Send retry", async t => {
  const receipt = { operation: "continue", needsFullContinuation: true, noActions: true };
  for (const [name, stage, value, foreignNonce] of [
    ["extra field", "continue", { ...receipt, normal: true }],
    ["actions not excluded", "continue", { ...receipt, noActions: false }],
    ["full install not requested", "continue", { ...receipt, needsFullContinuation: false }],
    ["missing action proof", "continue", { operation: "continue", needsFullContinuation: true }],
    ["wrong nonce", "continue", receipt, true],
    ["Send requests install", "send", { ...receipt, operation: "send" }],
    ["second install request", "full", receipt],
  ]) await t.test(name, async t => {
    const h = harness(t), { call } = await h.toObserve();
    await h.completeAnswer(call, "Completed answer");
    h.newTurn(followupId, "Continue only from verified custody.");
    let pending = (await h.request()).output[0];
    if (stage === "send") pending = (await h.answerBrowser(pending)).output[0];
    if (stage === "full") {
      h.loseKernel();
      pending = await fullContinuationAfterMiss(h, pending);
    }
    h.append(pending, outputFor(pending, browserReceipt(pending, value, foreignNonce ? "f".repeat(48) : undefined)));
    await assert.rejects(h.request(), { code: "web_browser_output_shape" });
    assert.equal(h.browser.ui.sends.length, 1);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("a failed fast Send cannot retry after its cache is lost or native execution fails", async t => {
  const h = harness(t), { call } = await h.toObserve();
  await h.completeAnswer(call, "Completed answer");
  h.newTurn(followupId, "An uncertain native Send must never replay.");
  const continuation = (await h.request()).output[0];
  const send = (await h.answerBrowser(continuation)).output[0];
  delete h.browserOwner().state.residentMutation;
  await assert.rejects(h.executeBrowser(send), /mutation cache was lost or changed/u);
  h.append(send, outputFor(send, { isError: true, content: [{ type: "text", text: "Native mutation cache unavailable." }] }));
  await assert.rejects(h.request(), { code: "web_browser_execution_failed" });
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Do not repeat the unconfirmed Send.");
  await assert.rejects(h.request(), { code: "web_send_uncertain" });
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.newTabs, 1);
});

test("cancellation during a full-continuation handoff preserves exact owners and resumes without repeating Send", async t => {
  for (const executed of [false, true]) await t.test(`full install executed ${executed}`, async t => {
    const h = harness(t), { call } = await h.toObserve();
    await h.completeAnswer(call, "Completed before native restart");
    h.loseKernel();
    h.newTurn(followupId, "The first unsent follow-up.");
    const full = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
    if (executed) await h.executeBrowser(full);
    h.observations.watchers.at(-1).onCancel();
    await h.restartRuntime();
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "The next unsent follow-up.");
    await h.toObserve();
    assert.equal(h.browser.ui.sends.length, 2);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.closes, 0);
    assert.deepEqual(sentTranscript(h), [
      { role: "user", content: "The first unsent follow-up." },
      { role: "user", content: "The next unsent follow-up." },
    ]);
  });
});

const sentTranscript = (h, index = -1) => JSON.parse(h.browser.ui.sends.at(index).split("Conversation transcript:\n")[1].split("\nRouter generation: ")[0]);

async function nativeV2Checkpoint(response) {
  const frames = new SseFrameBuffer(), output = [];
  let completed = false;
  for (const frame of frames.write(Buffer.from(await response.text(), "utf8"))) {
    const fields = sseFrameFields(frame.bytes, frame.atStreamStart);
    if (!fields.hasData || fields.data === "[DONE]") continue;
    const event = JSON.parse(fields.data);
    if (event.type === "response.output_item.done") output.push(event.item);
    if (event.type === "response.completed") completed = true;
  }
  assert.equal(completed, true);
  assert.equal(output.length, 1); assert.equal(output[0].type, "compaction");
  // Drop optional outer identity to cover native consumer rewriting.
  return { type: "compaction", encrypted_content: output[0].encrypted_content };
}

const nativeV2Users = input => input.filter(item => item.role === "user").map(item => ({ type: "message", role: "user",
  content: typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content }));

test("the emitted observation carries its exact live broker revision through adapter qualification and HTTP wakeup", async t => {
  const h = harness(t, { mcpFactory: startWebMcp });
  const { call } = await h.toObserve();
  const args = JSON.parse(call.arguments), config = readBrowserProgram(args.code);
  const url = new URL(config.observationWait.url);
  assert.equal(url.searchParams.get("revision"), String(h.broker.revision(h.token())));
  assert.ok(url.pathname.endsWith(`/observe/${h.token()}`));
  const sandbox = { opaqueCurrentAuthority: [true] };
  const native = { name: "js", arguments: args, _meta: { threadId, sessionId: threadId, callId: call.call_id,
    "x-codex-turn-metadata": { ...metadata(), session_id: threadId, auto_review_enabled: true,
      node_repl_auto_review_required: true, node_repl_disabled: false },
    "codex/sandbox-state": sandbox, "codex/sandbox-state-meta": structuredClone(sandbox), "codex/sandbox-launcher": { opaque: true } } };
  assert.equal(qualifyBrowserCall(native, h.settings.browser.runtimeModule)?.observation, true);
  const wake = fetch(url).then(response => response.json());
  const release = h.broker.beginActivity(h.token());
  assert.deepEqual(await wake, { revision: h.broker.revision(h.token()), closed: false });
  release();
  assert.equal(h.browser.ui.sends.length, 1);
});

test("checkpoint writes finish before native actions and a cancelled turn's successor persists in order", async t => {
  const { promise: writeStarted, resolve: started } = Promise.withResolvers();
  const { promise: writeAllowed, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  const writes = [];
  const h = harness(t, { storage: { ...syntheticStorage, writeState: async (target, value) => {
    writes.push(structuredClone(value));
    if (writes.length === 1) { started(); await writeAllowed; }
    await syntheticStorage.writeState(target, value);
  } } });
  let firstSettled = false, nextSettled = false;
  const first = h.request().finally(() => { firstSettled = true; });
  const rejected = assert.rejects(first, { code: "web_turn_cancelled" });
  await writeStarted;
  assert.equal(firstSettled, false, "Native work cannot be returned before its checkpoint reaches disk.");
  h.observations.watchers[0].onCancel();
  h.newTurn(followupId, "Continue after the pending checkpoint is durable.");
  const next = h.request().finally(() => { nextSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextSettled, false);
  assert.equal(writes.length, 1, "The successor cannot overtake the cancelled turn's write.");
  release();
  await rejected;
  await next;
  assert.deepEqual(writes.map(value => value.lastTurn.turnId), [turnId, followupId]);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).lastTurn.turnId, followupId);
});

test("a new turn reflushes a failed completion checkpoint before continuing the same saved chat", { timeout: 5_000 }, async t => {
  const failure = Object.assign(new Error("Synthetic private checkpoint failure."), { code: "synthetic_checkpoint_failed" });
  const { promise: reflushStarted, resolve: started } = Promise.withResolvers();
  const { promise: reflushAllowed, resolve: release } = Promise.withResolvers();
  t.after(release);
  const writes = [];
  let completedWrites = 0;
  const h = harness(t, { storage: { ...syntheticStorage, writeState: async (target, value) => {
    writes.push(structuredClone(value));
    if (value.lastTurn.completed && value.lastTurn.turnId === turnId) {
      if (++completedWrites === 1) throw failure;
      started(); await reflushAllowed;
    }
    await syntheticStorage.writeState(target, value);
  } } });
  const { call } = await h.toObserve();
  h.browser.ui.texts.push("The browser completed this answer."); h.browser.ui.complete = true;
  const retained = (await h.answerBrowser(call)).output[0];
  const previous = JSON.parse(readFileSync(h.stateFile, "utf8"));
  await assert.rejects(h.answerBrowser(retained), error => error === failure);
  const failedWrites = writes.length;
  await assert.rejects(h.request(), error => error === failure);
  assert.equal(writes.length, failedWrites, "The failed native turn and cancellation do not retry its checkpoint or browser action.");
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).lastTurn.completed, false);

  h.newTurn(followupId, "Continue with a separate current request.");
  const next = h.request();
  await reflushStarted;
  assert.equal(h.observations.watchers.length, 1, "The new turn cannot acquire a watcher or browser work before the prior snapshot is durable.");
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(writes.at(-1).lastTurn.turnId, turnId);
  release();
  assert.equal(JSON.parse((await next).output[0].arguments).title, "ChatGPT Web: continue");
  const resumed = (await h.toObserve()).call;
  await h.completeAnswer(resumed, "The new request completed in the saved chat.");
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.bindingId, previous.bindingId);
  assert.equal(saved.chatUrl, previous.chatUrl);
  assert.equal(saved.tabId, previous.tabId);
  assert.equal(saved.lastTurn.turnId, followupId);
  assert.equal(saved.lastTurn.completed, true);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.sends.length, 2, "Only the distinct new request is sent.");
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue with a separate current request." }]);
});

test("a persistent checkpoint failure rejects each new turn before acquiring browser work", async t => {
  const failure = Object.assign(new Error("Synthetic persistent checkpoint failure."), { code: "synthetic_checkpoint_failed" });
  let failedWrites = 0;
  const h = harness(t, { expectedCloseCode: failure.code, storage: { ...syntheticStorage, writeState: async (target, value) => {
    if (value.lastTurn.completed) { failedWrites += 1; throw failure; }
    await syntheticStorage.writeState(target, value);
  } } });
  const { call } = await h.toObserve();
  h.browser.ui.texts.push("Completed browser answer with unavailable storage."); h.browser.ui.complete = true;
  const retained = (await h.answerBrowser(call)).output[0];
  await assert.rejects(h.answerBrowser(retained), error => error === failure);
  const operations = h.observations.nativeOperations.length;
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "Invalid history cannot trigger a storage recovery write.");
  await assert.rejects(h.request({ input: [{ role: "user", content: [{ type: "input_image" }] }] }), { code: "web_input_unsupported" });
  assert.equal(failedWrites, 1);
  for (const nextTurn of [followupId, "33002233-4455-6677-8899-aabbccddeeff"]) {
    h.newTurn(nextTurn, "A fresh request still requires durable private state.");
    await assert.rejects(h.request(), error => error === failure);
  }
  assert.equal(failedWrites, 3, "Each new turn makes one explicit storage attempt; cancellation and same-turn replay make none.");
  assert.equal(h.observations.watchers.length, 1);
  assert.equal(h.observations.nativeOperations.length, operations);
  assert.equal(h.browser.ui.sends.length, 1);
});

test("a cancelled turn's failed pending write is reflushed before its successor can persist", { timeout: 5_000 }, async t => {
  const failure = Object.assign(new Error("Synthetic cancelled checkpoint failure."), { code: "synthetic_checkpoint_failed" });
  const failedWrite = Promise.withResolvers(), allowFailure = Promise.withResolvers();
  const reflush = Promise.withResolvers(), allowReflush = Promise.withResolvers();
  t.after(() => { allowFailure.resolve(); allowReflush.resolve(); });
  const writes = [];
  const h = harness(t, { storage: { ...syntheticStorage, writeState: async (target, value) => {
    writes.push(structuredClone(value));
    if (writes.length === 1) {
      failedWrite.resolve(); await allowFailure.promise; throw failure;
    }
    if (writes.length === 2) {
      reflush.resolve(); await allowReflush.promise;
    }
    await syntheticStorage.writeState(target, value);
  } } });
  const first = assert.rejects(h.request(), error => error === failure);
  await failedWrite.promise;
  h.observations.watchers[0].onCancel();
  h.newTurn(followupId, "Continue after all earlier checkpoint writes settle.");
  const next = h.request();
  assert.equal(writes.length, 1, "The successor cannot overtake the failed pending write.");
  allowFailure.resolve();
  await reflush.promise;
  assert.equal(h.observations.watchers.length, 1);
  assert.deepEqual(writes.map(value => value.lastTurn.turnId), [turnId, turnId]);
  allowReflush.resolve();
  await first;
  assert.equal(JSON.parse((await next).output[0].arguments).title, "ChatGPT Web: bootstrap");
  assert.deepEqual(writes.map(value => value.lastTurn.turnId), [turnId, turnId, followupId],
    "The latest successor checkpoint follows the explicit recovery write and is never overwritten by the old failure.");
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).lastTurn.turnId, followupId);
  assert.equal(h.browser.ui.sends.length, 0, "Storage recovery has not executed or replayed a Send.");
});

test("a cancelled finalizer cannot overwrite its successor after watcher closure", { timeout: 5_000 }, async t => {
  for (const failCancellationWrite of [false, true]) await t.test(`cancellation write fails ${failCancellationWrite}`, async t => {
    const failure = Object.assign(new Error("Synthetic cancelled checkpoint failure."), { code: "synthetic_checkpoint_failed" });
    const watchClose = Promise.withResolvers(), allowWatchClose = Promise.withResolvers();
    const cancellationWrite = Promise.withResolvers();
    t.after(() => allowWatchClose.resolve());
    let armed = false, watcherCloses = 0;
    const writes = [];
    const h = harness(t, { watcherClosure: async () => {
      if (++watcherCloses === 1) { watchClose.resolve(); await allowWatchClose.promise; }
    }, storage: { ...syntheticStorage, writeState: async (target, value) => {
      writes.push(structuredClone(value));
      if (armed && !value.lastTurn.completed) {
        armed = false; cancellationWrite.resolve();
        if (failCancellationWrite) throw failure;
      }
      await syntheticStorage.writeState(target, value);
    } } });
    const { call } = await h.toObserve();
    h.browser.ui.texts.push("The first completed answer frame."); h.browser.ui.complete = true;
    const retained = (await h.answerBrowser(call)).output[0];
    // The final read observes a newer answer before watcher closure. A
    // cancellation checkpoint must retain that read without completing it.
    h.browser.ui.texts[0] = "The final retained answer frame.";
    armed = true;
    const finishing = assert.rejects(h.answerBrowser(retained), error => failCancellationWrite
      ? error === failure : error.code === "web_turn_cancelled");
    await watchClose.promise;
    h.observations.watchers[0].onCancel();
    await cancellationWrite.promise;
    h.newTurn(followupId, "Continue while the cancelled finalizer still owns its watcher close.");
    const continuing = (await h.request()).output[0];
    const send = (await h.answerBrowser(continuing)).output[0];
    assert.equal(JSON.parse(send.arguments).title, "ChatGPT Web: send");
    const successor = readFileSync(h.stateFile, "utf8");
    assert.deepEqual(JSON.parse(successor).lastTurn, { turnId: followupId, sendState: "uncertain", completed: false });
    assert.equal(JSON.parse(successor).uncertainSend, true);
    assert.equal(JSON.parse(successor).generationCompleted, false);
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Do not acquire the successor's saved conversation.");
    await assert.rejects(h.request(), /already owns this native conversation/u);
    allowWatchClose.resolve();
    await finishing;
    assert.equal(readFileSync(h.stateFile, "utf8"), successor, "The cancelled finalizer cannot replace any successor metadata.");
    assert.equal(writes.filter(value => value.lastTurn.turnId === turnId && value.lastTurn.completed).length, 0);
    h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "The successor still owns the conversation after old finalization settles.");
    await assert.rejects(h.request(), /already owns this native conversation/u);
    assert.equal(h.observations.watchers.length, 2);
    assert.equal(h.runtime.maintenanceState().activeTurns, 1);
    assert.equal(h.browser.ui.sends.length, 1, "The cancelled turn's Send is never replayed.");
  });
});

test("final checkpoint persistence retains ownership and late cancellation cannot release a successor", { timeout: 5_000 }, async t => {
  const finalWrite = Promise.withResolvers(), allowFinalWrite = Promise.withResolvers();
  t.after(() => allowFinalWrite.resolve());
  const writes = [];
  const h = harness(t, { storage: { ...syntheticStorage, writeState: async (target, value) => {
    writes.push(structuredClone(value));
    if (value.lastTurn.turnId === turnId && value.lastTurn.completed) {
      finalWrite.resolve(); await allowFinalWrite.promise;
    }
    await syntheticStorage.writeState(target, value);
  } } });
  const { call } = await h.toObserve();
  h.browser.ui.texts.push("A completed browser answer awaiting its final checkpoint."); h.browser.ui.complete = true;
  const retained = (await h.answerBrowser(call)).output[0];
  const finishing = assert.rejects(h.answerBrowser(retained), { code: "web_turn_cancelled" });
  await finalWrite.promise;
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Durable finalization still owns the conversation.");
  await assert.rejects(h.request(), /already owns this native conversation/u);
  assert.equal(h.observations.watchers.length, 1);
  h.observations.watchers[0].onCancel();
  h.newTurn(followupId, "Wait for the cancelled final checkpoint to settle before continuing.");
  const next = h.request();
  h.observations.watchers[0].onCancel();
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "A late cancellation cannot release the waiting successor.");
  await assert.rejects(h.request(), /already owns this native conversation/u);
  assert.equal(h.observations.watchers.length, 1);
  assert.equal(writes.at(-1).lastTurn.turnId, turnId);
  allowFinalWrite.resolve();
  await finishing;
  const continuing = (await next).output[0];
  assert.equal(JSON.parse(continuing.arguments).title, "ChatGPT Web: continue");
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).lastTurn.turnId, followupId);
  h.newTurn("55002233-4455-6677-8899-aabbccddeeff", "Finalization cannot release the admitted successor either.");
  await assert.rejects(h.request(), /already owns this native conversation/u);
  assert.equal(h.observations.watchers.length, 2);
  assert.equal(h.runtime.maintenanceState().activeTurns, 1);
  assert.equal(writes.filter(value => value.lastTurn.turnId === turnId && value.lastTurn.completed).length, 1,
    "The known browser completion stays durable without another old-turn write after cancellation.");
});

test("reflushing a failed checkpoint preserves an uncertain Send and blocks continuation", async t => {
  const failure = Object.assign(new Error("Synthetic uncertain checkpoint failure."), { code: "synthetic_checkpoint_failed" });
  let failed = false;
  const h = harness(t, { storage: { ...syntheticStorage, writeState: async (target, value) => {
    if (!failed && value.uncertainSend) { failed = true; throw failure; }
    await syntheticStorage.writeState(target, value);
  } } });
  const bootstrap = (await h.request()).output[0];
  const open = (await h.answerBrowser(bootstrap)).output[0];
  await assert.rejects(h.answerBrowser(open), error => error === failure);
  const operations = h.observations.nativeOperations.length;
  h.newTurn(followupId, "Do not replay an uncertain input while recovering storage.");
  await assert.rejects(h.request(), { code: "web_send_uncertain" });
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.uncertainSend, true);
  assert.deepEqual(saved.lastTurn, { turnId, sendState: "uncertain", completed: false });
  assert.equal(h.observations.watchers.length, 1);
  assert.equal(h.observations.nativeOperations.length, operations);
  assert.equal(h.browser.ui.sends.length, 0);
});

test("default conversation storage protects its checkpoint and reloads the same binding after restart", async t => {
  const h = harness(t, { storage: {} });
  const first = (await h.request()).output[0];
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(privateFileIsProtected(h.stateFile), true);
  assert.equal(saved.threadId, threadId);
  assert.equal(saved.lastTurn.turnId, turnId);
  assert.ok(JSON.parse(first.arguments).code.includes(saved.bindingId));
  await h.restartRuntime();
  h.newTurn(followupId, "Recover the protected conversation binding.");
  const next = (await h.request()).output[0];
  const reloaded = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(reloaded.bindingId, saved.bindingId);
  assert.equal(reloaded.lastTurn.turnId, followupId);
  assert.ok(JSON.parse(next.arguments).code.includes(saved.bindingId));
  assert.equal(privateFileIsProtected(h.stateFile), true);
  assert.equal(h.browser.ui.newTabs, 0);
});

test("default conversation storage rejects an unprotected record before native browser work", async t => {
  // Only the fixture writer is synthetic; loading uses the real ACL predicate.
  const h = harness(t, { storage: { writeState: syntheticStorage.writeState } });
  await h.request();
  assert.equal(privateFileIsProtected(h.stateFile), false);
  await h.restartRuntime();
  h.newTurn(followupId, "Refuse this unprotected saved record.");
  await assert.rejects(h.request(), { code: "web_conversation_state" });
  assert.equal(h.browser.ui.newTabs, 0);
  assert.equal(h.observations.watchers.length, 1, "An unsafe record cannot acquire a new native turn.");
});

test("the native runtime accepts a new reply identity after mounted counts shrink and recovers that exact completed reply", async t => {
  const h = harness(t);
  let response = await h.request();
  while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
  h.browser.ui.texts = Array(6).fill("Repeated answer");
  const observe = (await h.answerBrowser(response.output[0])).output[0];
  h.browser.ui.texts = Array(5).fill("Repeated answer"); h.browser.ui.stop = true;
  const pendingFrame = await h.executeBrowser(observe);
  assert.match(pendingFrame, /"replyId":null/);
  h.append(observe, outputFor(observe, pendingFrame));
  const pending = await h.request();
  assert.equal(JSON.parse(pending.output[0].arguments).title, "Wait for ChatGPT or its next Codex tool request");
  h.browser.ui.replyIds = [0, 1, 2, 3, 6].map(messageId); h.browser.ui.complete = true; h.browser.ui.stop = false;
  const retained = await h.answerBrowser(pending.output[0]);
  const final = await h.answerBrowser(retained.output[0]);
  assert.equal(final.output[0].content[0].text, "Repeated answer");
  h.append(final.output[0]);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.deepEqual(saved.sendBaselineReplyIds, Array.from({ length: 6 }, (_, index) => messageId(index)));
  assert.equal(saved.sendBaseline, 6);
  assert.equal(saved.observation.replyCount, 7, "The rollback reader gets valid identity-derived counts despite fewer mounted replies.");
  assert.equal(saved.observation.replyId, messageId(6));
  assert.equal(h.browser.ui.sends.length, 1);
  await h.restartRuntime(); h.loseKernel();
  h.newTurn(followupId, "Continue from the identified reply.");
  await h.toObserve();
  assert.equal(h.browser.ui.sends.length, 2, "Recovery never resends the completed turn.");
  assert.deepEqual(h.browser.ui.reacquired, ["owned-saved-tab"]);
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue from the identified reply." }]);
});

test("fragmented message DOM reaches native completion with all prose and code and retains its saved binding", async t => {
  const h = harness(t), { call } = await h.toObserve();
  const source = "  FORMAT_ONE\n\n    FORMAT_TWO\nFORMAT_THREE\n";
  const fragments = [domElement("div", {}, domElement("p", {}, domText("Before code."))),
    domElement("div", {}, domElement("div", { "data-markdown-copy": "code-block" }, domElement("code", {}, domText(source)))),
    domElement("div", {}, domElement("p", {}, domText("After code.")))];
  domElement("div", { "data-chatgpt-selection-message-id": messageId(0) }, ...fragments);
  h.browser.ui.replyElements = fragments;
  h.browser.ui.complete = true;
  const frame = await h.executeBrowser(call);
  const frameToken = frame.match(/^ROUTER_WEB_BROWSER_([A-Za-z0-9_-]+)_BEGIN\n/u)[1];
  const observed = parseBrowserOutput(frame, frameToken);
  const expected = `Before code.\n\n${source}\n\nAfter code.`;
  assert.equal(observed.completed, true);
  assert.equal(observed.assistantText, expected);
  assert.equal(observed.replyId, messageId(0));
  h.append(call, outputFor(call, frame));
  const retained = await h.request();
  assert.equal(JSON.parse(retained.output[0].arguments).title, "ChatGPT Web: retain");
  const final = await h.answerBrowser(retained.output[0]);
  assert.equal(final.output[0].content[0].text, expected);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.chatUrl, "https://chatgpt.com/c/owned-conversation");
  assert.equal(saved.tabId, "owned-saved-tab");
  assert.equal(saved.observation.replyId, messageId(0));
  assert.equal(saved.observation.completed, true);
  assert.equal(saved.bindingId, h.observations.bindings[0].replace(/^routerWeb_/u, ""));
  assert.equal(h.browserOwner().state.retained, true);
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.closes, 0);
  assert.equal(new Set(h.observations.bindings).size, 1);
});

test("native continuation identity failure exposes bounded structural evidence before another Send", async t => {
  const h = harness(t), { call } = await h.toObserve();
  await h.completeAnswer(call, "Completed reply");
  const secret = "PRIVATE_TOKEN_path_https://private.invalid/value";
  h.browser.ui.replyElements = Array.from({ length: 10 }, () => domElement("private-secret-tag", { class: secret }, domText(secret)));
  h.newTurn(followupId, "Continue only with valid identity evidence.");
  const continuation = (await h.request()).output[0];
  assert.equal(JSON.parse(continuation.arguments).title, "ChatGPT Web: continue");
  await assert.rejects(h.executeBrowser(continuation), error => {
    const diagnostic = JSON.parse(error.message.split(" ROUTER_WEB_REPLY_IDENTITY_DIAGNOSTIC ")[1]);
    assert.equal(diagnostic.reason, "missing-wrapper");
    assert.equal(diagnostic.missingWrapperCount, 10);
    assert.equal(diagnostic.messageCount, 10);
    assert.ok(error.message.length < 4096);
    assert.doesNotMatch(error.message, /PRIVATE_|private\.invalid|00000000-0000-4000/u);
    return true;
  });
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browserOwner().turnId, turnId);
});

test("unsupported saved mappings fail before browser effects and preserve the original private record", async t => {
  for (const field of ["sendBaselineReplyIds", "generationTurnKey", "generationReplyIds", "generationCompleted"]) await t.test(field, async t => {
    const h = harness(t), { call } = await h.toObserve();
    await h.completeAnswer(call, "Existing deployed answer");
    await h.restartRuntime(); h.loseKernel();
    const legacy = JSON.parse(readFileSync(h.stateFile, "utf8"));
    delete legacy[field];
    const original = JSON.stringify(legacy);
    writeFileSync(h.stateFile, original, "utf8");
    const sends = h.browser.ui.sends.length, navigations = h.browser.ui.navigations;
    h.newTurn(followupId, "Continue the existing deployed saved chat.");
    await assert.rejects(h.request(), { code: "web_conversation_state" });
    assert.equal(readFileSync(h.stateFile, "utf8"), original);
    assert.equal(h.browser.ui.sends.length, sends);
    assert.equal(h.browser.ui.navigations, navigations);
    assert.deepEqual(h.browser.ui.reacquired, []);
  });
});

test("historical unsent V1 history remains non-resumable after maintenance risk validation", async t => {
  const { validWebConversationRisk } = await import("../src/web-runtime.mjs");
  for (const emptyCheckpoint of [false, true]) await t.test(`empty checkpoint: ${emptyCheckpoint}`, async t => {
    const h = harness(t), { call } = await h.toObserve();
    await h.completeAnswer(call, "Original completed historical answer");
    await h.restartRuntime(); h.loseKernel();
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    saved.lastTurn = { turnId, sendState: "unsent", completed: false };
    saved.uncertainSend = false; saved.unresolvedCoding = [];
    if (emptyCheckpoint) saved.checkpoint = [];
    for (const field of ["sendBaselineReplyIds", "generationTurnKey", "generationReplyIds", "generationCompleted"]) delete saved[field];
    assert.equal(validWebConversationRisk(saved, threadId), true, "maintenance can preserve known risk without accepting old execution fields");
    const original = JSON.stringify(saved); writeFileSync(h.stateFile, original, "utf8");
    const sends = h.browser.ui.sends.length, navigations = h.browser.ui.navigations;
    h.newTurn(followupId, "Continue only if current saved history is valid.");
    await assert.rejects(h.request(), { code: "web_conversation_state" });
    assert.equal(readFileSync(h.stateFile, "utf8"), original);
    assert.equal(h.browser.ui.sends.length, sends); assert.equal(h.browser.ui.navigations, navigations);
  });
});

test("native observation validation rejects old, missing, changed or unpaired reply identity evidence", async t => {
  for (const [label, change] of [
    ["old reply", value => ({ ...value, replyId: messageId(0), assistantText: "Old answer", completed: true })],
    ["missing identity", value => ({ ...value, replyId: undefined, assistantText: "Unpaired answer", completed: true })],
    ["array identity", value => ({ ...value, replyId: [messageId(1)], assistantText: "Unpaired answer", completed: true })],
    ["null identity with answer", value => ({ ...value, replyId: null, assistantText: "Unpaired answer", completed: true })],
    ["changed baseline", value => ({ ...value, baselineReplyIds: [] })],
    ["duplicate baseline", value => ({ ...value, baselineReplyIds: [messageId(0), messageId(0)] })],
  ]) await t.test(label, async t => {
    const h = harness(t);
    let response = await h.request();
    while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
    h.browser.ui.texts.push("Old answer");
    const observe = (await h.answerBrowser(response.output[0])).output[0];
    const original = await h.executeBrowser(observe);
    const frameToken = original.match(/^ROUTER_WEB_BROWSER_([A-Za-z0-9_-]+)_BEGIN\n/u)[1];
    const mutated = `ROUTER_WEB_BROWSER_${frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: change(parseBrowserOutput(original, frameToken)) })}\nROUTER_WEB_BROWSER_${frameToken}_END`;
    h.append(observe, outputFor(observe, mutated));
    await assert.rejects(h.request(), /verified conversation evidence/);
    assert.equal(h.browser.ui.sends.length, 1);
    assert.equal(h.observations.nativeOperations.includes("retain"), false);
  });
});

test("a queued MCP invocation routes after UI-only observation and resolves only from paired native output", async t => {
  const h = harness(t, { toolChoice: "required" });
  const { call: observe } = await h.toObserve();
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.marks, 2, "The owned tab is retained at open and immediately before Send.");
  h.browser.ui.stop = true;
  const token = h.token();
  const read = h.broker.list(token).tools.find(tool => tool.name === "read");
  assert.deepEqual(read.parameters, currentRead.tools[0].parameters);
  const mcpResult = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual.txt", limit: 3 } });
  let resolved = false;
  void mcpResult.then(() => { resolved = true; });
  const codingResponse = await h.answerBrowser(observe);
  const coding = codingResponse.output[0];
  assert.equal(h.observations.fetchCalls, 0);
  assert.equal(coding.namespace, "mcp__work");
  assert.equal(coding.name, "read");
  assert.deepEqual(JSON.parse(coding.arguments), { path: "actual.txt", limit: 3 });
  assert.equal(resolved, false);
  const replay = await h.request();
  assert.deepEqual(replay.output, codingResponse.output);
  h.append(coding, outputFor(coding, "actual native file contents"));
  const afterCoding = await h.request();
  assert.deepEqual(await mcpResult, { content: [{ type: "text", text: "actual native file contents" }] });
  assert.equal(h.browser.ui.sends.length, 1);
  h.browser.ui.texts.push("The native file contains actual native file contents.");
  h.browser.ui.complete = true;
  h.browser.ui.stop = false;
  const retain = await h.answerBrowser(afterCoding.output[0]);
  const marksBeforeRetain = h.browser.ui.marks;
  const final = await h.answerBrowser(retain.output[0]);
  assert.equal(final.output[0].type, "message");
  assert.equal(final.output[0].content[0].text, h.browser.ui.texts[0]);
  assert.equal(h.browser.ui.marks, marksBeforeRetain + 1);
  assert.equal(h.observations.watchers[0].closed, true);
  assert.deepEqual(h.observations.nativeOperations, ["bootstrap", "open", "send", "observe", "observe", "retain"]);
  assert.equal(h.runtime.status().activeTurns, 0);
});

test("one Send carries commentary, actual native execution and a final answer under a new message identity", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.browser.ui.texts.push("I will inspect the requested file."); h.browser.ui.stop = true;
  const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
  const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "actual.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  assert.equal(coding.namespace, "mcp__work");
  h.append(coding, outputFor(coding, "ACTUAL_FILE_CONTENT"));
  const afterCoding = (await h.request()).output[0]; await actual;
  h.browser.ui.stop = false; h.browser.ui.complete = true;
  const oldCommentary = await h.answerBrowser(afterCoding);
  assert.equal(JSON.parse(oldCommentary.output[0].arguments).title, "Wait for ChatGPT or its next Codex tool request");
  h.browser.ui.texts.push("The actual file contains ACTUAL_FILE_CONTENT.");
  const retained = await h.answerBrowser(oldCommentary.output[0]);
  const final = await h.answerBrowser(retained.output[0]);
  assert.equal(final.output[0].content[0].text, "The actual file contains ACTUAL_FILE_CONTENT.");
  assert.equal(h.browser.ui.sends.length, 1);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.deepEqual(saved.generationReplyIds, [messageId(0), messageId(1)]);
  assert.equal(saved.observation.replyId, messageId(1));
});

test("orphan connector widgets cannot block native calls or become the answer through the runtime browser handoff", async t => {
  const h = harness(t);
  const widget = text => domElement("div", { "data-markdown-text-style": "assistant-message" }, domText(text));
  h.browser.ui.orphanMarkdownBefore = [widget("A connector widget before the saved messages")];
  h.browser.ui.orphanMarkdownAfter = [widget("A connector widget after the saved messages")];
  const { call } = await h.toObserve();
  const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
  const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "widget-safe.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  assert.equal(coding.namespace, "mcp__work");
  h.append(coding, outputFor(coding, "WIDGET_SAFE_OUTPUT"));
  const observe = (await h.request()).output[0]; await actual;
  h.browser.ui.texts.push("The native result is WIDGET_SAFE_OUTPUT."); h.browser.ui.complete = true;
  const retained = await h.answerBrowser(observe);
  const final = await h.answerBrowser(retained.output[0]);
  assert.equal(final.output[0].content[0].text, "The native result is WIDGET_SAFE_OUTPUT.");
  assert.equal(h.browser.ui.sends.length, 1);
});

test("lost generation ownership aborts queued MCP work before native delivery or a final answer", async t => {
  for (const reason of ["generation-turn-not-latest", "duplicate-generation-turn", "generation-message-not-latest"]) await t.test(reason, async t => {
    const h = harness(t), { call } = await h.toObserve();
    h.browser.ui.texts.push("A message outside the owned generation."); h.browser.ui.replyTurnKeys = [messageId(999)];
    h.browser.ui.complete = true;
    const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
    const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "must-not-execute.txt" } });
    const aborted = assert.rejects(actual, { code: "web_generation_ownership" });
    const frame = await h.executeBrowser(call);
    const frameToken = frame.match(/^ROUTER_WEB_BROWSER_([A-Za-z0-9_-]+)_BEGIN\n/u)[1];
    const observed = parseBrowserOutput(frame, frameToken);
    assert.equal(observed.replyUnavailableReason, "generation-turn-not-latest", "The actual browser projection detects the foreign latest generation.");
    const reported = reason === observed.replyUnavailableReason ? frame
      : `ROUTER_WEB_BROWSER_${frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: { ...observed, replyUnavailableReason: reason } })}\nROUTER_WEB_BROWSER_${frameToken}_END`;
    h.append(call, outputFor(call, reported));
    await assert.rejects(h.request(), { code: "web_generation_ownership" });
    await aborted;
    await assert.rejects(h.request(), { code: "web_generation_ownership" });
    assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
    assert.equal(h.observations.nativeOperations.includes("retain"), false);
    assert.equal(h.browser.ui.sends.length, 1);
    assert.equal(h.browser.ui.closes, 0);
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.deepEqual(saved.unresolvedCoding, []);
    assert.equal(saved.lastTurn.completed, false);
  });
});

test("MCP activity between the browser read and final delivery forces a fresh answer after its native result", async t => {
  for (const boundary of ["snapshot", "retention"]) await t.test(boundary, async t => {
    const h = harness(t), { call } = await h.toObserve();
    h.browser.ui.texts.push("An answer before late native work."); h.browser.ui.complete = true;
    let pending = call;
    if (boundary === "retention") pending = (await h.answerBrowser(call)).output[0];
    const frame = await h.executeBrowser(pending);
    const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
    const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "late.txt" } });
    h.append(pending, outputFor(pending, frame));
    const coding = (await h.request()).output[0];
    assert.equal(coding.namespace, "mcp__work");
    h.append(coding, outputFor(coding, "LATE_ACTUAL_RESULT"));
    const observe = (await h.request()).output[0]; await actual;
    const unchanged = await h.answerBrowser(observe);
    assert.equal(JSON.parse(unchanged.output[0].arguments).title, "Wait for ChatGPT or its next Codex tool request");
    h.browser.ui.texts.push("Final answer using LATE_ACTUAL_RESULT.");
    const retained = await h.answerBrowser(unchanged.output[0]);
    const final = await h.answerBrowser(retained.output[0]);
    assert.equal(final.output[0].content[0].text, "Final answer using LATE_ACTUAL_RESULT.");
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("discovery activity during an otherwise completed DOM read invalidates its completion fence", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.browser.ui.texts.push("A complete answer."); h.browser.ui.complete = true;
  const frame = await h.executeBrowser(call);
  const release = h.broker.beginActivity(h.token()); release();
  h.append(call, outputFor(call, frame));
  const refresh = await h.request();
  assert.equal(JSON.parse(refresh.output[0].arguments).title, "Wait for ChatGPT or its next Codex tool request");
  const retained = await h.answerBrowser(refresh.output[0]);
  const final = await h.answerBrowser(retained.output[0]);
  assert.equal(final.output[0].content[0].text, "A complete answer.");
});

test("completed pages fail promptly when unreadable or missing a post-tool final and retain actual outcomes", async t => {
  for (const withTool of [false, true]) await t.test(withTool ? "missing post-tool final" : "unreadable answer", async t => {
    const h = harness(t), { call } = await h.toObserve();
    let observe = call;
    if (withTool) {
      h.browser.ui.texts.push("I will read the file."); h.browser.ui.stop = true;
      const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
      const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "read-once.txt" } });
      const coding = (await h.answerBrowser(observe)).output[0];
      h.append(coding, outputFor(coding, "KNOWN_NATIVE_OUTPUT"));
      observe = (await h.request()).output[0]; await actual;
    } else h.browser.ui.texts.push("");
    h.browser.ui.complete = true; h.browser.ui.stop = false;
    for (let index = 0; index < 2; index += 1) observe = (await h.answerBrowser(observe)).output[0];
    await assert.rejects(h.answerBrowser(observe), { code: withTool ? "web_post_tool_answer_missing" : "web_answer_unreadable" });
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(saved.lastTurn.completed, false);
    assert.deepEqual(saved.unresolvedCoding, []);
    assert.equal(h.browser.ui.sends.length, 1);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.closes, 0);
    assert.equal(h.observations.nativeOperations.includes("retain"), false);
    if (withTool) assert.equal(h.input().filter(item => item.output === "KNOWN_NATIVE_OUTPUT").length, 1);
  });
});

test("new native activity resets the bounded completed-but-unreadable wait", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.browser.ui.complete = true;
  let observe = call;
  for (let index = 0; index < 2; index += 1) observe = (await h.answerBrowser(observe)).output[0];
  const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
  const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "once.txt" } });
  const coding = (await h.answerBrowser(observe)).output[0];
  assert.equal(coding.namespace, "mcp__work");
  h.append(coding, outputFor(coding, "READ_ONCE_RESULT"));
  observe = (await h.request()).output[0]; await actual;
  for (let index = 0; index < 2; index += 1) observe = (await h.answerBrowser(observe)).output[0];
  await assert.rejects(h.answerBrowser(observe), { code: "web_answer_unreadable" });
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.input().filter(item => item.output === "READ_ONCE_RESULT").length, 1);
});

test("a final answer cannot bypass the required native tool policy", async t => {
  const h = harness(t, { toolChoice: "required" }), { call } = await h.toObserve();
  h.browser.ui.texts.push("An answer without actual native execution."); h.browser.ui.complete = true;
  const retain = (await h.answerBrowser(call)).output[0];
  await assert.rejects(h.answerBrowser(retain), { code: "web_tool_required" });
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.runtime.status().activeTurns, 0);
});

test("optimistic anchors and explicit request failure preserve accepted context through restart", async t => {
  for (const prior of ["first input", "continuation", "compaction"]) await t.test(prior, async t => {
    const h = harness(t, { instructions: "Prior accepted instructions." });
    if (prior !== "first input") {
      const { call } = await h.toObserve();
      await h.completeAnswer(call, "Accepted prior answer");
      if (prior === "compaction") {
        h.append({ role: "user", content: "Undelivered material before native compaction." });
        const compact = await (await h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() })).json();
        h.input().splice(0, h.input().length, ...compact.output);
      }
      h.newTurn(followupId, "New input that the site will reject.", { instructions: "Revised undelivered instructions." });
    }
    const before = prior === "first input" ? {} : JSON.parse(readFileSync(h.stateFile, "utf8"));
    const { call } = await h.toObserve();
    const acceptedFields = ["checkpoint", "chatUrl", "sendBaselineReplyIds", "generationTurnKey", "generationReplyIds", "generationCompleted",
      "deliveredInstructionsSha256", "deliveredInstructionsGenerationTurnKey", "pendingCompaction", "activeCompaction", "observation"];
    const anchored = JSON.parse(readFileSync(h.stateFile, "utf8"));
    for (const key of acceptedFields) assert.deepEqual(anchored[key], before[key], `DOM anchoring cannot advance ${key}.`);
    assert.equal(anchored.uncertainSend, true);
    assert.equal(anchored.lastTurn.sendState, "uncertain");
    assert.equal(h.browserOwner().state.sendConfirmed, true, "Stop is armed before input acceptance.");
    h.browser.ui.stop = false;
    await assert.rejects(reportObservation(h, call, { requestError: "unknown_error", completed: false, statusComplete: false }), { code: "web_request_failed" });
    const sends = h.browser.ui.sends.length;
    assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
    await h.restartRuntime();
    const failed = JSON.parse(readFileSync(h.stateFile, "utf8"));
    for (const key of acceptedFields) assert.deepEqual(failed[key], before[key], `Rejected input cannot advance ${key}.`);
    assert.equal(failed.uncertainSend, true);
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "No replay after restart.");
    await assert.rejects(h.request(), { code: "web_send_uncertain" });
    assert.equal(h.browser.ui.sends.length, sends);
  });
});

test("first incomplete assistant text persists input acceptance before another wait and permits same-chat Stop continuation", async t => {
  const { promise: writeStarted, resolve: started } = Promise.withResolvers();
  const { promise: writeAllowed, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  let acceptanceWrite;
  const h = harness(t, { storage: { ...syntheticStorage, writeState: async (target, value) => {
    if (!acceptanceWrite && value.deliveredInstructionsSha256) {
      acceptanceWrite = structuredClone(value); started(); await writeAllowed;
    }
    await syntheticStorage.writeState(target, value);
  } } });
  let { call } = await h.toObserve();
  const config = browserCall => readBrowserProgram(JSON.parse(browserCall.arguments).code);
  assert.equal(config(call).inputAcknowledgementPending, true);
  for (const answer of ["", " \n "]) {
    if (answer) h.browser.ui.texts.push(answer);
    call = (await h.answerBrowser(call)).output[0];
    assert.equal(config(call).inputAcknowledgementPending, true);
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, undefined);
  }
  h.browser.ui.texts.push("The current input reached the model."); h.browser.ui.stop = true;
  let nextWaitEmitted = false;
  const advancing = h.answerBrowser(call).then(response => { nextWaitEmitted = true; return response; });
  await writeStarted;
  assert.equal(nextWaitEmitted, false, "The next native wait remains private until acceptance reaches durable storage.");
  assert.equal(acceptanceWrite.uncertainSend, false);
  assert.equal(acceptanceWrite.generationCompleted, false);
  assert.equal(acceptanceWrite.observation.completed, false);
  assert.equal(h.browser.ui.stop, true);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).uncertainSend, true);
  release();
  const next = (await advancing).output[0];
  assert.equal(config(next).inputAcknowledgementPending, undefined);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.checkpoint.length, 1);
  assert.equal(saved.uncertainSend, false);
  assert.equal(saved.deliveredInstructionsGenerationTurnKey, saved.generationTurnKey);
  assert.equal(saved.generationCompleted, false);
  assert.equal(saved.lastTurn.sendState, "sent");
  const binding = saved.bindingId, url = saved.chatUrl;
  h.observations.watchers[0].onCancel(); h.loseKernel();
  h.newTurn(followupId, "Continue after the accepted input was stopped.");
  const continuation = (await h.toObserve()).call;
  const resumed = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(resumed.bindingId, binding); assert.equal(resumed.chatUrl, url);
  assert.equal(resumed.tabId, saved.tabId);
  assert.equal(config(continuation).inputAcknowledgementPending, true, "The next Send has its own acceptance boundary.");
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue after the accepted input was stopped." }]);
  assert.equal(h.browser.ui.sends.length, 2); assert.equal(h.browser.ui.newTabs, 1);
  await h.completeAnswer(continuation, "Continued in the same saved chat.");
});

test("foreign-generation text cannot acknowledge pending input", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.browser.ui.texts.push("Text from a different generation cannot prove receipt.");
  await assert.rejects(reportObservation(h, call, { generationTurnKey: followupId }), /no verified conversation evidence/u);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.uncertainSend, true);
  assert.equal(saved.checkpoint, undefined); assert.equal(saved.deliveredInstructionsSha256, undefined);
  h.newTurn(followupId, "Do not replay input with foreign proof.");
  await assert.rejects(h.request(), { code: "web_send_uncertain" });
  assert.equal(h.browser.ui.sends.length, 1);
});

test("authentic connector discovery accepts input before any native tool completes", async t => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  let service;
  const h = harness(t, { mcpFactory: async options => service = await startWebMcp({ ...options, onDiagnostic: () => {} }) });
  const { call } = await h.toObserve();
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, undefined);
  const client = new Client({ name: "web-input-acceptance", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
  assert.equal(h.broker.hasClientActivity(h.token()), false);
  const discovery = await client.callTool({ name: "codex_tools_list", arguments: { turn_token: h.token() } });
  assert.equal(discovery.isError, undefined);
  const next = (await h.answerBrowser(call)).output[0];
  assert.equal(readBrowserProgram(JSON.parse(next.arguments).code).inputAcknowledgementPending, undefined);
  const accepted = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(accepted.uncertainSend, false);
  assert.ok(accepted.checkpoint.length);
  assert.equal(accepted.deliveredInstructionsGenerationTurnKey, accepted.generationTurnKey);
  assert.deepEqual(h.broker.takeCalls(h.token()), []);
  await h.completeAnswer(next, "Accepted without waiting for a native invocation.");
});

test("a first substantive answer proves receipt even with a simultaneous site error", async t => {
  const cases = [
    { label: "answer without broker activity", answer: "Current-generation input reached the model.", queued: false, accepted: true },
    { label: "answer with queued native action", answer: "Current-generation input reached the model.", queued: true, accepted: true },
    { label: "whitespace-only wrapper is not receipt proof", answer: " \n ", queued: false, accepted: false },
  ];
  for (const scenario of cases) await t.test(scenario.label, async t => {
    const h = harness(t, { instructions: "Current instructions awaiting known receipt." }), { call } = await h.toObserve();
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, undefined);
    let rejected;
    if (scenario.queued) {
      const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
      const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "must-not-emit-after-first-answer-error.txt" } });
      rejected = assert.rejects(actual, { code: "web_request_failed" });
    } else assert.equal(h.broker.hasClientActivity(h.token()), false);
    h.browser.ui.texts.push(scenario.answer); h.browser.ui.complete = true;
    await assert.rejects(reportObservation(h, call, { requestError: "unknown_error" }), { code: "web_request_failed" });
    await rejected;
    await h.restartRuntime();
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(saved.uncertainSend, !scenario.accepted);
    assert.equal(saved.lastTurn.completed, false, "Receipt proof cannot turn a site error into final delivery.");
    assert.deepEqual(saved.unresolvedCoding, []);
    assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
    if (scenario.accepted) {
      assert.equal(saved.checkpoint.length, 1);
      assert.equal(saved.generationTurnKey, h.browser.ui.turns.at(-1).key);
      assert.equal(saved.deliveredInstructionsGenerationTurnKey, saved.generationTurnKey);
      assert.match(saved.deliveredInstructionsSha256, /^[a-f0-9]{64}$/u);
      assert.equal(saved.generationCompleted, false);
    } else {
      assert.equal(saved.checkpoint, undefined);
      assert.equal(saved.deliveredInstructionsSha256, undefined);
    }
    h.newTurn(followupId, "Continue only from actual known receipt.");
    if (scenario.accepted) {
      const continuation = (await h.request()).output[0];
      assert.equal(readBrowserProgram(JSON.parse(continuation.arguments).code).operation, "continue");
      assert.deepEqual(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, saved.checkpoint);
    } else await assert.rejects(h.request(), { code: "web_send_uncertain" });
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("request failure suppresses queued native actions and cannot erase accepted tool outcomes", async t => {
  for (const emitted of [false, true]) await t.test(`native result emitted ${emitted}`, async t => {
    const h = harness(t), { call } = await h.toObserve();
    const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
    const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "one-owned-action.txt" } });
    let observe = call, saved;
    if (emitted) {
      const coding = (await h.answerBrowser(call)).output[0];
      h.append(coding, outputFor(coding, "ACTUAL_NATIVE_OUTCOME"));
      observe = (await h.request()).output[0];
      await actual;
      saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    } else t.after(() => actual.catch(() => {}));
    const rejected = emitted ? undefined : assert.rejects(actual, { code: "web_request_failed" });
    await assert.rejects(reportObservation(h, observe, { requestError: "unknown_error", completed: false, statusComplete: false }), { code: "web_request_failed" });
    await rejected;
    await h.restartRuntime();
    const retained = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(retained.uncertainSend, false, "Authentic current-token activity remains accepted after a later site error.");
    assert.deepEqual(retained.unresolvedCoding, []);
    if (emitted) {
      assert.deepEqual(retained.checkpoint, saved.checkpoint);
      assert.equal(h.input().filter(item => item.output === "ACTUAL_NATIVE_OUTCOME").length, 1);
    } else assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("late request failure during retention blocks final delivery and newly queued native actions", async t => {
  for (const priorResult of [false, true]) for (const lateCall of [false, true]) await t.test(`prior native result ${priorResult}; late queued call ${lateCall}`, async t => {
    const h = harness(t), { call } = await h.toObserve();
    const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
    let observe = call;
    if (priorResult) {
      const actual = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "actual-before-retain.txt" } });
      const coding = (await h.answerBrowser(observe)).output[0];
      h.append(coding, outputFor(coding, "ACTUAL_PRIOR_OUTCOME"));
      observe = (await h.request()).output[0];
      await actual;
    }
    h.browser.ui.texts.push("Current answer accepted before the late site error."); h.browser.ui.complete = true;
    const retain = (await h.answerBrowser(observe)).output[0];
    assert.equal(readBrowserProgram(JSON.parse(retain.arguments).code).operation, "retain");
    const accepted = JSON.parse(readFileSync(h.stateFile, "utf8"));
    let rejected;
    if (lateCall) {
      const queued = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "must-not-emit-after-retain-error.txt" } });
      rejected = assert.rejects(queued, { code: "web_request_failed" });
    }
    await assert.rejects(reportObservation(h, retain, { requestError: "unknown_error" }), { code: "web_request_failed" });
    await rejected;
    await assert.rejects(h.request(), { code: "web_request_failed" });
    await h.restartRuntime();
    const failed = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(failed.lastTurn.completed, false);
    assert.equal(failed.generationCompleted, false);
    assert.equal(failed.uncertainSend, false);
    assert.deepEqual(failed.checkpoint, accepted.checkpoint);
    assert.equal(failed.deliveredInstructionsSha256, accepted.deliveredInstructionsSha256);
    assert.deepEqual(failed.unresolvedCoding, [], "Queued but un-emitted actions never become unresolved native execution.");
    assert.equal(h.input().filter(item => item.namespace === "mcp__work").length, priorResult ? 1 : 0);
    assert.equal(h.input().filter(item => item.output === "ACTUAL_PRIOR_OUTCOME").length, priorResult ? 1 : 0);
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("a broker fence race after retention preserves real rejection detection before queued actions or final delivery", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.browser.ui.texts.push("Current answer before concurrent broker activity."); h.browser.ui.complete = true;
  const retain = (await h.answerBrowser(call)).output[0];
  assert.equal(readBrowserProgram(JSON.parse(retain.arguments).code).operation, "retain");
  const retainedFrame = await h.executeBrowser(retain);
  const retained = JSON.parse(readFileSync(h.stateFile, "utf8"));
  const release = h.broker.beginActivity(h.token()); release();
  h.append(retain, outputFor(retain, retainedFrame));
  const resumed = (await h.request()).output[0];
  assert.equal(readBrowserProgram(JSON.parse(resumed.arguments).code).operation, "observe",
    "The changed broker revision must reject finalization and resume the same generation.");
  const submitted = h.browser.ui.sends.at(-1), generation = h.browser.ui.turns.at(-1);
  const error = domElement("div", { "aria-label": "Unknown error" }, domText("Unknown error"));
  const retry = domElement("button", { "aria-label": "Retry" }, domText("Retry"));
  const errorRegion = domElement("div", {}, error, retry);
  error.contains = node => node === error;
  errorRegion.contains = node => node === errorRegion || node === error || node === retry;
  const composer = domElement("div", { role: "textbox", "aria-label": "Ask ChatGPT", contenteditable: "true" }, domText(submitted));
  composer.innerText = submitted;
  const answer = replyElement(h.browser.ui.texts[0], messageId(0)).parentElement;
  const turn = domElement("section", { "data-turn-key": generation.key },
    domElement("div", { "data-talvt-turn-state": "complete" }, domElement("div", {}, domText(submitted)), answer,
      domElement("button", { "aria-label": "Regenerate response" })));
  h.browser.ui.observationRoot = domElement("main", {}, turn, errorRegion, composer);
  const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
  const queued = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "must-not-emit-after-retention-race.txt" } });
  const queuedOutcome = queued.then(() => undefined, error => error);
  await assert.rejects(h.answerBrowser(resumed), { code: "web_request_failed" });
  assert.equal((await queuedOutcome)?.code, "web_request_failed");
  await assert.rejects(h.request(), { code: "web_request_failed" });
  const failed = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(failed.generationTurnKey, generation.key);
  assert.equal(failed.generationCompleted, false);
  assert.equal(failed.lastTurn.completed, false);
  assert.equal(failed.uncertainSend, false, "Prior substantive answer acceptance remains acknowledged.");
  assert.deepEqual(failed.checkpoint, retained.checkpoint);
  assert.deepEqual(failed.unresolvedCoding, []);
  assert.equal(h.input().some(item => item.namespace === "mcp__work" || item.phase === "final_answer"), false);
  assert.equal(composer.innerText, submitted);
  assert.equal(h.browser.ui.sends.length, 1);
});

test("instruction revisions persist only after accepted input and unchanged turns carry only their exact delta", async t => {
  const instructions = "Preserve the original user marker and current subagent tool policy.";
  const h = harness(t, { instructions });
  const bootstrap = (await h.request()).output[0], open = (await h.answerBrowser(bootstrap)).output[0];
  const send = (await h.answerBrowser(open)).output[0];
  const preparedSend = readBrowserProgram(JSON.parse(send.arguments).code);
  assert.match(preparedSend.turnToken, /^web_turn_[a-f0-9]{32}$/u);
  assert.equal(preparedSend.prompt.includes(preparedSend.turnToken), false,
    "The current authority belongs in the visible suffix, outside the potentially converted transcript.");
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256, undefined);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsGenerationTurnKey, undefined);
  const sent = await h.executeBrowser(send);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256, undefined,
    "A browser click without its confirmed native result cannot acknowledge instructions.");
  h.append(send, outputFor(send, sent));
  let observe = (await h.request()).output[0];
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, undefined, "An optimistic DOM anchor cannot acknowledge context.");
  await h.completeAnswer(observe, "Original task completed");
  const revision = JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256;
  const confirmed = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(confirmed.deliveredInstructionsGenerationTurnKey, confirmed.generationTurnKey);
  assert.match(revision, /^[a-f0-9]{64}$/u);
  assert.ok(h.browser.ui.sends[0].includes(`Current Codex instructions:\n${instructions}`));
  const firstToken = h.token();
  h.newTurn(followupId, "Exact continuation Δ");
  ({ call: observe } = await h.toObserve());
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Exact continuation Δ" }]);
  const followupPrompt = h.browser.ui.sends.at(-1);
  assert.ok(followupPrompt.trimStart().startsWith("Conversation transcript:\n"),
    "An unchanged continuation carries its delta without repeated guidance.");
  assert.equal(followupPrompt.split(h.token()).length - 1, 1,
    "Its current authority is delivered once in the visible suffix.");
  assert.equal(followupPrompt.includes(instructions), false);
  assert.equal(followupPrompt.includes("Current Codex instructions:"), false);
  assert.notEqual(h.token(), firstToken);
  assert.ok(followupPrompt.slice(followupPrompt.lastIndexOf("\nRouter generation: ")).includes(h.token()),
    "Follow-ups retain their fresh authority outside the potentially converted transcript payload.");
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256, revision);
  await h.completeAnswer(observe, "Continuation completed");
  const revised = `${instructions}\n`;
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Use the revised instructions.", { instructions: revised });
  ({ call: observe } = await h.toObserve());
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256, revision);
  await h.completeAnswer(observe, "Revised task completed");
  const nextRevision = JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256;
  assert.notEqual(nextRevision, revision, "Even an exact whitespace change is a new instruction revision.");
  assert.ok(h.browser.ui.sends.at(-1).includes(`Current Codex instructions:\n${revised}`));
  assert.match(h.browser.ui.sends.at(-1), /supersede all earlier Codex instructions/u);
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Use the revised instructions." }]);
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "Proceed without the previous instructions.", { instructions: undefined });
  ({ call: observe } = await h.toObserve());
  await h.completeAnswer(observe, "Completed with current instructions.");
  assert.notEqual(JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256, nextRevision);
  assert.match(h.browser.ui.sends.at(-1), /supersede all earlier Codex instructions/u);
  assert.match(h.browser.ui.sends.at(-1), /No Codex instructions were supplied for this request/u);
  assert.equal(readFileSync(h.stateFile, "utf8").includes(instructions), false);
});

test("restart reuses confirmed instruction delivery while a legacy record seeds instructions safely", async t => {
  for (const legacy of [false, true]) await t.test(`legacy ${legacy}`, async t => {
    const instructions = "Keep current repository authority across restart.";
    const h = harness(t, { instructions }), { call } = await h.toObserve();
    await h.completeAnswer(call, "Saved answer");
    await h.restartRuntime(); h.loseKernel();
    if (legacy) {
      const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
      delete saved.deliveredInstructionsSha256;
      delete saved.deliveredInstructionsGenerationTurnKey;
      writeFileSync(h.stateFile, JSON.stringify(saved), "utf8");
    }
    h.newTurn(followupId, "Continue after restart.");
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue after restart." }]);
    assert.equal(h.browser.ui.sends.at(-1).includes(`Current Codex instructions:\n${instructions}`), legacy);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("a legacy writer's later confirmed generation cannot reuse an older or unbound instruction digest", async t => {
  for (const lineage of ["stale", "absent"]) await t.test(lineage, async t => {
    const instructions = "Confirmed authority A.";
    const h = harness(t, { instructions }), { call } = await h.toObserve();
    await h.completeAnswer(call, "Answer under A");
    const original = JSON.parse(readFileSync(h.stateFile, "utf8"));
    h.newTurn(followupId, "Use authority B.", { instructions: "Later authority B." });
    const { call: later } = await h.toObserve();
    await h.completeAnswer(later, "Answer under B");
    await h.restartRuntime(); h.loseKernel();
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.notEqual(saved.generationTurnKey, original.generationTurnKey);
    // Preserve a valid later ownership/checkpoint record as a legacy writer may,
    // while carrying an extra digest it cannot establish for that later Send.
    saved.deliveredInstructionsSha256 = original.deliveredInstructionsSha256;
    if (lineage === "stale") saved.deliveredInstructionsGenerationTurnKey = original.generationTurnKey;
    else delete saved.deliveredInstructionsGenerationTurnKey;
    writeFileSync(h.stateFile, JSON.stringify(saved), "utf8");
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Restore authority A.", { instructions });
    const { call: restoredCall } = await h.toObserve();
    await h.completeAnswer(restoredCall, "Answer under restored A");
    assert.ok(h.browser.ui.sends.at(-1).includes(`Current Codex instructions:\n${instructions}`));
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Restore authority A." }]);
    const restored = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(restored.deliveredInstructionsSha256, original.deliveredInstructionsSha256);
    assert.equal(restored.deliveredInstructionsGenerationTurnKey, restored.generationTurnKey);
    assert.notEqual(restored.deliveredInstructionsGenerationTurnKey, original.generationTurnKey);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("an unconfirmed revised-instruction Send retains the prior delivery revision and blocks replay", async t => {
  const h = harness(t, { instructions: "Original confirmed authority." }), { call } = await h.toObserve();
  await h.completeAnswer(call, "First answer");
  const revision = JSON.parse(readFileSync(h.stateFile, "utf8")).deliveredInstructionsSha256;
  h.newTurn(followupId, "Use revised authority.", { instructions: "Revised authority awaiting delivery." });
  const continuation = (await h.request()).output[0], send = (await h.answerBrowser(continuation)).output[0];
  await h.executeBrowser(send);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.uncertainSend, true);
  assert.equal(saved.deliveredInstructionsSha256, revision);
  h.observations.watchers.at(-1).onCancel();
  await h.restartRuntime();
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Do not replay an uncertain Send.");
  await assert.rejects(h.request(), { code: "web_send_uncertain" });
  assert.equal(h.browser.ui.sends.length, 2);
});

test("native request replay preserves call IDs and follow-up NEW turns reuse the retained binding and tab", async t => {
  const h = harness(t);
  const initial = await h.request();
  const replay = await h.request();
  assert.deepEqual(replay.output, initial.output);
  const { call } = await h.toObserve();
  assert.equal((await h.request()).output[0].call_id, call.call_id);
  await assert.rejects(h.request({ model: "chatgpt-web/gpt-6-sol", reasoning: { effort: "high" } }), /cannot change model or effort/u);
  assert.equal(h.browser.ui.sends.length, 1);
  await h.completeAnswer(call, "First answer");
  h.loseKernel();
  h.newTurn(followupId, "Follow up in this same chat.", { model: "chatgpt-web/gpt-5.6-sol", reasoning: { effort: "high" } });
  const { call: nextObserve } = await h.toObserve();
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.equal(h.observations.nativeOperations.filter(operation => operation === "continue").length, 2, "Lost REPL state requires one no-action probe and one full continuation.");
  assert.equal(h.browser.ui.sends.length, 2);
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Follow up in this same chat." }]);
  assert.equal(h.browser.ui.power, 2);
  assert.equal(h.runtime.status().conversations, 1, "Changing model family and effort retains the native session's chat.");
  assert.deepEqual(h.browser.ui.reacquired, ["owned-saved-tab"]);
  assert.equal(h.browser.ui.navigations, 1);
  const pending = await h.answerBrowser(nextObserve);
  assert.equal(pending.output[0].type, "function_call");
  const marksBeforeRetain = h.browser.ui.marks;
  h.browser.ui.texts.push("Follow-up answer"); h.browser.ui.complete = true;
  const nextRetain = await h.answerBrowser(pending.output[0]);
  const nextFinal = await h.answerBrowser(nextRetain.output[0]);
  assert.equal(nextFinal.output[0].content[0].text, "Follow-up answer");
  assert.equal(h.browser.ui.marks, marksBeforeRetain + 1);
  assert.equal(h.observations.watchers.length, 2);
});

test("completed turn retirement preserves the exact final JSON and SSE response for its full request fingerprint", async t => {
  for (const stream of [false, true]) await t.test(stream ? "SSE" : "JSON", async t => {
    const h = harness(t), { call } = await h.toObserve();
    h.browser.ui.texts.push("Exact final response with Unicode: ✓ π"); h.browser.ui.complete = true;
    const retain = (await h.answerBrowser(call)).output[0];
    h.append(retain, outputFor(retain, await h.executeBrowser(retain)));
    const intermediate = { stream: false, input: [...h.input().slice(0, -2)] };
    const response = await h.requestResponse({ stream }), body = Buffer.from(await response.arrayBuffer()), originalHeaders = [...response.headers];
    response.headers.set("content-type", "caller-mutated");
    await new Promise(resolve => setImmediate(resolve));
    h.observations.watchers[0].onCancel();
    for (let index = 0; index < 3; index += 1) {
      const replay = await h.requestResponse({ stream });
      assert.deepEqual(Buffer.from(await replay.arrayBuffer()), body);
      assert.deepEqual([...replay.headers], originalHeaders);
      assert.equal(replay.status, response.status);
      assert.equal(replay.statusText, response.statusText);
    }
    await assert.rejects(h.requestResponse(intermediate), /turn is complete/u);
    await assert.rejects(h.requestResponse({ stream, request_metadata: { changed: true } }), /turn is complete/u);
    await assert.rejects(h.requestResponse({ stream: !stream }), /turn is complete/u);
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("intermediate replay preserves exact JSON and SSE bytes across independent consumers and bounded eviction", async t => {
  for (const stream of [false, true]) await t.test(stream ? "SSE" : "JSON", async t => {
    const h = harness(t), replies = [];
    for (let index = 0; index < 11; index += 1) {
      const payload = { stream, input: [...h.input()] };
      const original = await h.requestResponse(payload);
      const headers = [...original.headers], status = original.status, statusText = original.statusText;
      // Leave the original body unread while consuming a replay in full.
      const body = Buffer.from(await (await h.requestResponse(payload)).arrayBuffer());
      const envelope = stream ? JSON.parse(body.toString("utf8").match(/event: response.completed\ndata: ([^\n]+)/u)[1]).response
        : JSON.parse(body.toString("utf8"));
      replies.push({ payload, body, headers, status, statusText });
      if (index === 0) {
        original.headers.set("content-type", "caller-mutated");
        const reader = original.body.getReader(), chunk = await reader.read();
        assert.equal(chunk.done, false);
        chunk.value.fill(0);
        // Abandon a read body and mutate its chunk; neither can change replay.
        await reader.cancel();
        const parsed = stream ? envelope : JSON.parse(body.toString("utf8"));
        parsed.output[0].arguments = "caller-mutated";
        const replay = await h.requestResponse(payload);
        assert.deepEqual(Buffer.from(await replay.arrayBuffer()), body);
        assert.deepEqual([...replay.headers], headers);
      } else assert.deepEqual(Buffer.from(await original.arrayBuffer()), body);
      const call = stream ? JSON.parse(body.toString("utf8").match(/event: response.completed\ndata: ([^\n]+)/u)[1]).response.output[0]
        : JSON.parse(body.toString("utf8")).output[0];
      if (index < 10) h.append(call, outputFor(call, await h.executeBrowser(call)));
    }
    const operations = [...h.observations.nativeOperations];
    for (const retained of replies.slice(-8)) {
      const replay = await h.requestResponse(retained.payload);
      assert.deepEqual(Buffer.from(await replay.arrayBuffer()), retained.body);
      assert.deepEqual([...replay.headers], retained.headers);
      assert.equal(replay.status, retained.status);
      assert.equal(replay.statusText, retained.statusText);
    }
    assert.deepEqual(h.observations.nativeOperations, operations, "Cache hits do not execute or regenerate native work.");
    await assert.rejects(h.requestResponse(replies.at(-9).payload), { code: "web_tool_result", status: 409 });
    await assert.rejects(h.requestResponse(replies.at(-1).payload), { code: "web_tool_result", status: 409 });
    assert.deepEqual(h.observations.nativeOperations, operations, "Eviction and cancellation never reissue a native action.");
  });
});

test("terminal turns release their native schema after request, watcher and checkpoint settlement", async t => {
  if (typeof global.gc !== "function") {
    // Node 22 uses the experimental spelling; newer supported versions retain it.
    const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--experimental-test-isolation=none", "--test", "--test-name-pattern=^terminal turns release their native schema", fileURLToPath(import.meta.url)], {
      timeout: 30_000, env: { ...process.env, ...syntheticEnvironment },
    });
    assert.match(stdout, /terminal turns release their native schema: cancelled/u);
    assert.match(stdout, /terminal turns release their native schema: completed/u);
    return;
  }
  for (const completed of [false, true]) await t.test(`terminal turns release their native schema: ${completed ? "completed" : "cancelled"}`, async t => {
    const { promise: closureAllowed, resolve: release } = Promise.withResolvers();
    t.after(release);
    const h = harness(t, { watcherClosure: () => closureAllowed });
    let tools = structuredClone([nativeJs, currentRead]);
    const schema = new WeakRef(tools[0].tools[0].parameters);
    let response = await h.request({ tools }); tools = undefined;
    while (JSON.parse(response.output[0].arguments).title !== "Wait for ChatGPT or its next Codex tool request") response = await h.answerBrowser(response.output[0]);
    let terminal;
    if (completed) {
      h.browser.ui.texts.push("Completed owned answer"); h.browser.ui.complete = true;
      const retain = (await h.answerBrowser(response.output[0])).output[0];
      terminal = h.answerBrowser(retain);
      await new Promise(resolve => setImmediate(resolve));
    } else h.observations.watchers[0].onCancel();
    await new Promise(resolve => setImmediate(resolve)); global.gc();
    assert.ok(schema.deref(), "An unsettled watcher still owns the terminal turn.");
    release();
    if (terminal) await terminal;
    response = undefined;
    let collected = false;
    for (let attempt = 0; attempt < 10 && !collected; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve)); global.gc();
      collected = schema.deref() === undefined;
    }
    assert.equal(collected, true, "Retained watcher callbacks and turn replay records cannot keep the native schema alive.");
    if (!completed) await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  });
});

test("shutdown retains custody of a cancelled watcher's unsettled close", async t => {
  const { promise: closureAllowed, resolve: release } = Promise.withResolvers();
  t.after(release);
  const h = harness(t, { watcherClosure: () => closureAllowed });
  await h.request(); h.observations.watchers[0].onCancel();
  let closed = false;
  const closing = h.runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  release(); await closing;
  assert.equal(closed, true);
  assert.deepEqual(h.observations.services.slice(-2), ["tunnel-closed", "mcp-closed"]);
});

test("native cancellation retires the real broker while the next turn retains its chat and historical coding results", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const token = h.token();
  const read = h.broker.list(token).tools.find(tool => tool.name === "read");
  const pending = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual.txt" } });
  const rejection = assert.rejects(pending, { code: "web_turn_cancelled" });
  h.browser.ui.texts.push("Reading the actual requested file."); h.browser.ui.stop = true;
  const coding = (await h.answerBrowser(call)).output[0];
  h.observations.watchers[0].onCancel();
  await rejection;
  const marksBeforeRecovery = h.browser.ui.marks;
  assert.throws(() => h.broker.list(token), { code: "web_tool_turn_closed" });
  h.append(coding, outputFor(coding, "too late"));
  await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  const cancelledCompact = await h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() });
  assert.deepEqual((await cancelledCompact.json()).output.slice(1), [coding, outputFor(coding, "too late")], "A canceled tool turn never acknowledges its late actual result as delivered Web history.");
  h.loseKernel();
  h.newTurn(followupId, "Resume after cancellation.");
  const restart = (await h.request()).output[0];
  assert.equal(JSON.parse(restart.arguments).title, "ChatGPT Web: continue");
  const retainedBinding = JSON.parse(restart.arguments).code.match(/\brouterWeb_[A-Za-z0-9_]+\b/)[0];
  assert.equal(retainedBinding, h.observations.bindings[0]);
  const next = await h.toObserve();
  assert.notEqual(next.call.call_id, coding.call_id);
  assert.notEqual(h.token(), token);
  assert.throws(() => h.broker.list(token), { code: "web_tool_turn_closed" });
  assert.deepEqual(sentTranscript(h), [
    { type: "function_call", namespace: coding.namespace, name: coding.name, call_id: coding.call_id, arguments: coding.arguments },
    { type: "function_call_output", call_id: coding.call_id, output: "too late" },
    { role: "user", content: "Resume after cancellation." },
  ]);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.closes, 0);
  assert.deepEqual(h.browser.ui.reacquired, ["owned-saved-tab"]);
  assert.equal(h.browser.ui.navigations, 1);
  assert.equal(h.browser.ui.stopMarks.length, 1);
  assert.ok(h.browser.ui.stopMarks[0] > marksBeforeRecovery, "Recovery renews the current turn's tab retention before Stop.");
});

test("a private saved-chat mapping survives Router and browser restart with delta history and fresh native tools", async t => {
  const h = harness(t);
  const privatePrompt = "Private initial prompt that must not be persisted.";
  h.append({ role: "user", content: privatePrompt });
  const { call } = await h.toObserve();
  const oldToken = h.token(), oldBroker = h.broker;
  const read = oldBroker.list(oldToken).tools.find(tool => tool.name === "read");
  const actual = oldBroker.invoke(oldToken, { wireName: read.wireName, arguments: { path: "private-tool-argument.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding, outputFor(coding, "private actual tool result"));
  const observe = (await h.request()).output[0];
  await actual;
  await h.completeAnswer(observe, "Private assistant final answer");
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.chatUrl, "https://chatgpt.com/c/owned-conversation");
  assert.ok(saved.checkpoint.every(value => /^[a-f0-9]{64}$/u.test(value)));
  const persisted = JSON.stringify(saved);
  for (const secret of [privatePrompt, "private-tool-argument.txt", "private actual tool result", "Private assistant final answer", oldToken]) assert.equal(persisted.includes(secret), false);
  await h.restartRuntime(); h.loseKernel();
  h.browser.ui.present = false;
  h.browser.browser.browserId = "new-current-session-browser";
  h.newTurn(followupId, "Only new native material follows restart.");
  await h.toObserve();
  assert.equal(h.browser.ui.url, saved.chatUrl);
  assert.equal(h.browser.ui.newTabs, 2, "A closed saved tab is reopened once at its exact persisted URL.");
  assert.equal(h.browser.ui.navigations, 2);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.notEqual(h.token(), oldToken);
  assert.throws(() => oldBroker.list(oldToken), { code: "web_tool_turn_closed" });
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Only new native material follows restart." }]);
  assert.equal(h.browser.ui.sends.at(-1).includes(privatePrompt), false);
  assert.equal(h.browser.ui.sends.at(-1).includes(oldToken), false);
  assert.deepEqual(h.broker.list(h.token()).tools.find(tool => tool.name === "read").parameters, currentRead.tools[0].parameters);
});

test("manually closing the saved tab reopens its URL and preserves delta delivery while the REPL survives", async t => {
  const h = harness(t), { call } = await h.toObserve();
  await h.completeAnswer(call, "Latest saved answer");
  const savedUrl = h.browser.ui.url;
  h.browser.ui.present = false;
  h.newTurn(followupId, "Continue the same saved conversation after tab closure.");
  await h.toObserve();
  assert.equal(h.browser.ui.url, savedUrl);
  assert.equal(h.browser.ui.newTabs, 2);
  assert.equal(h.observations.nativeOperations.filter(operation => operation === "bootstrap").length, 1);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue the same saved conversation after tab closure." }]);
});

test("completed native tool acknowledgements stop before genuinely unsent native material", async t => {
  const h = harness(t), { call } = await h.toObserve(), token = h.token();
  const read = h.broker.list(token).tools.find(tool => tool.name === "read");
  const actual = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "already-delivered.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding, outputFor(coding, "Already delivered actual tool result"));
  const observe = (await h.request()).output[0]; await actual;
  h.append({ role: "user", content: "Unsent native material arrived while the Web answer was finishing." });
  await h.completeAnswer(observe, "The completed Web answer");
  h.newTurn(followupId, "Current follow-up request");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [
    { role: "user", content: "Unsent native material arrived while the Web answer was finishing." },
    { role: "assistant", content: "The completed Web answer" },
    { role: "user", content: "Current follow-up request" },
  ]);
});

test("delivery and coding acknowledgement use exact canonical transcript digests", async t => {
  const h = harness(t);
  h.append({ type: "message", role: "developer", content: [{ type: "input_text", text: "Current authority ✓" }, { type: "text", text: "Second block" }] },
    { type: "function_call", call_id: "historical_native_read", namespace: "mcp__work", name: "read", arguments: '{"path":"π.txt"}' },
    { type: "function_call_output", call_id: "historical_native_read", output: { content: [{ type: "text", text: "Historical actual output" }], structuredContent: { values: [1, 2] } } });
  const expected = [
    { role: "user", content: "Read the current file using the declared tools." },
    { role: "developer", content: "Current authority ✓\nSecond block" },
    { type: "function_call", namespace: "mcp__work", name: "read", call_id: "historical_native_read", arguments: '{"path":"π.txt"}' },
    { type: "function_call_output", call_id: "historical_native_read", output: { content: [{ type: "text", text: "Historical actual output" }], structuredContent: { values: [1, 2] } } },
  ];
  const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const { call } = await h.toObserve();
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, undefined);
  const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
  const result = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "actual.txt" } });
  const coding = (await h.answerBrowser(call)).output[0], output = outputFor(coding, { answer: "Actual current result ✓", count: 2 });
  assert.deepEqual(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, expected.map(hash));
  h.append(coding, output);
  const observe = (await h.request()).output[0]; await result;
  expected.push({ type: coding.type, namespace: coding.namespace, name: coding.name, call_id: coding.call_id, arguments: coding.arguments },
    { type: output.type, call_id: output.call_id, output: output.output });
  h.append({ role: "user", content: "This item has not reached the saved Web chat." });
  await h.completeAnswer(observe, "Confirmed result");
  assert.deepEqual(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, expected.map(hash));
});

test("historical unpaired calls are data and do not create owned unresolved-action blocks", async t => {
  const h = harness(t);
  const historical = { type: "function_call", call_id: "historical_cancelled_call", name: "read", arguments: "{}" };
  h.append(historical);
  const { call } = await h.toObserve();
  await h.completeAnswer(call, "Historical outcome remains unknown.");
  await h.restartRuntime(); h.loseKernel();
  h.newTurn(followupId, "Continue without re-executing historical actions.");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue without re-executing historical actions." }]);
  assert.equal(h.browser.ui.newTabs, 1);
});

test("history filters only the exact Router browser-control identity format", async t => {
  const h = harness(t);
  const internal = `call_router_web_${"a".repeat(32)}`;
  const nativeIds = ["call_router_web_fixture", `call_router_web_${"b".repeat(31)}`,
    `call_router_web_${"A".repeat(32)}`, `call_router_web_${"c".repeat(32)}_suffix`];
  const calls = [internal, ...nativeIds].map(call_id => ({ type: "function_call", call_id, name: "read", arguments: "{}" }));
  const results = calls.map(call => outputFor(call, `Actual result for ${call.call_id}`));
  h.append(...calls.flatMap((call, index) => [call, results[index]]));
  await h.toObserve();
  assert.deepEqual(sentTranscript(h).slice(1), calls.slice(1).flatMap((call, index) => [call, results[index + 1]]));
});

test("invalid saved mappings fail before any fresh chat or browser call", async t => {
  for (const [label, mutate] of [
    ["foreign thread", value => { value.threadId = followupId; }],
    ["unsafe URL", value => { value.chatUrl = "https://example.com/c/foreign"; }],
    ["lost checkpoint", value => { delete value.checkpoint; }],
    ["old reply identity", value => { value.sendBaselineReplyIds.push(value.observation.replyId); }],
    ["duplicate baseline identity", value => { value.sendBaselineReplyIds = [messageId(2), messageId(2)]; }],
    ["unpaired completed reply", value => { value.observation.replyId = null; }],
  ]) await t.test(label, async t => {
    const h = harness(t), { call } = await h.toObserve();
    await h.completeAnswer(call, "Persisted answer");
    await h.restartRuntime(); h.loseKernel();
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8")); mutate(saved);
    writeFileSync(h.stateFile, JSON.stringify(saved), "utf8");
    h.newTurn(followupId, "Do not replace an invalid mapping.");
    const before = h.observations.nativeOperations.length;
    await assert.rejects(h.request(), { code: "web_conversation_state" });
    assert.equal(h.observations.nativeOperations.length, before);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("lost JS state rebinds only the observed owned tab and reconciles its newest partial before the next delta", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const oldToken = h.token();
  h.browser.ui.texts.push("Observed partial"); h.browser.ui.stop = true;
  await h.answerBrowser(call);
  h.observations.watchers[0].onCancel();
  const marksBeforeRecovery = h.browser.ui.marks;
  h.loseKernel();
  h.browser.ui.texts[0] = "Observed partial continued before Stop";
  h.append({ role: "assistant", content: "Observed partial continued" });
  h.newTurn(followupId, "Continue in this exact observed conversation.");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue in this exact observed conversation." }]);
  assert.deepEqual(h.browser.ui.reacquired, ["owned-saved-tab"]);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.navigations, 1);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.equal(h.browserOwner().turnId, followupId);
  assert.equal(h.browser.ui.stopMarks.length, 1);
  assert.ok(h.browser.ui.stopMarks[0] > marksBeforeRecovery);
  assert.throws(() => h.broker.list(oldToken), { code: "web_tool_turn_closed" });
});

test("an interrupted anchored generation can advance from an observed partial to its later owned answer", async t => {
  for (const mounted of [true, false]) await t.test(mounted ? "partial remains mounted" : "partial was unmounted", async t => {
    const h = harness(t), { call } = await h.toObserve();
    h.browser.ui.texts.push("Known partial answer"); h.browser.ui.stop = true;
    await h.answerBrowser(call);
    h.observations.watchers[0].onCancel(); h.loseKernel();
    if (mounted) h.browser.ui.texts.push("Later final answer from that same generation.");
    else { h.browser.ui.texts = ["Later final answer from that same generation."]; h.browser.ui.replyIds = [messageId(1)]; }
    await h.restartRuntime();
    h.newTurn(followupId, "Continue after the prior generation.");
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue after the prior generation." }]);
    assert.equal(h.browser.ui.sends.length, 2);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.stopMarks.length, 1);
  });
});

test("a completed generation keeps its exact final reply proof across a failed pre-Send successor", async t => {
  const h = harness(t), { call } = await h.toObserve();
  await h.completeAnswer(call, "A completed native final.");
  h.newTurn(followupId, "A successor blocked before Send.");
  const continuation = (await h.request()).output[0];
  h.browser.ui.composer = "Keep this draft.";
  await assert.rejects(h.executeBrowser(continuation), /composer has a draft/);
  h.observations.watchers.at(-1).onCancel();
  await h.restartRuntime(); h.loseKernel();
  h.browser.ui.composer = ""; h.browser.ui.replyIds = [messageId(999)];
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Retry the new work.");
  const retry = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).generationCompleted, true);
  await assert.rejects(h.executeBrowser(retry), /saved chat reply or composer changed/);
  assert.equal(h.browser.ui.sends.length, 1);
});

test("runtime recovery passes saved evidence and refuses changed session, reply or active ownership without Stop or replay", async t => {
  for (const [label, mutate] of [
    ["foreign session", h => { h.browser.agent.browsers.list = async () => [{ type: "iab", id: "same-session-iab", metadata: { codexSessionId: followupId } }]; }],
    ["changed partial", h => { h.browser.ui.texts[0] = "A different assistant reply"; }],
    ["identical text under foreign generation identity", h => { h.browser.ui.replyIds = [messageId(999)]; h.browser.ui.replyTurnKeys = [messageId(998)]; }],
    ["surviving foreign owner", h => { h.replaceBrowserOwner({ turnId: followupId, state: {} }); }],
  ]) await t.test(label, async t => {
    const h = harness(t);
    const { call } = await h.toObserve();
    h.browser.ui.texts.push("Known observed partial"); h.browser.ui.stop = true;
    await h.answerBrowser(call);
    h.observations.watchers[0].onCancel(); h.loseKernel();
    mutate(h);
    h.newTurn(followupId, "Recover only with unchanged observed evidence.");
    const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
    await assert.rejects(h.executeBrowser(continuation), /recovery|saved chat|active browser/iu);
    assert.equal(h.browser.ui.stop, true);
    assert.deepEqual(h.browser.ui.stopMarks, []);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.navigations, 1);
    assert.equal(h.browser.ui.sends.length, 1);
  });
});

test("Stop after browser retention but before its native result retains the existing chat", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  h.browser.ui.texts.push("Completed answer whose retention result was interrupted."); h.browser.ui.complete = true;
  const retain = (await h.answerBrowser(call)).output[0];
  await h.executeBrowser(retain);
  h.observations.watchers[0].onCancel();
  await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  h.newTurn(followupId, "Continue from that retained answer.");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue from that retained answer." }]);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.closes, 0);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.equal(new Set(h.observations.bindings).size, 1);
});

test("interrupted native handoffs preserve every exact possible browser owner until a result confirms ownership", async t => {
  for (const executed of [[false], [true], [false, true, false], [true, false, true]]) await t.test(executed.join(","), async t => {
    const h = harness(t);
    const { call } = await h.toObserve();
    await h.completeAnswer(call, "Completed first answer");
    const expected = [];
    for (const [index, didExecute] of executed.entries()) {
      const attemptId = `${index + 2}2002233-4455-6677-8899-aabbccddeeff`;
      const content = `Unsent native instruction ${index + 1}.`;
      expected.push({ role: "user", content });
      h.newTurn(attemptId, content);
      const continuation = (await h.request()).output[0];
      assert.equal(JSON.parse(continuation.arguments).title, "ChatGPT Web: continue");
      if (didExecute) await h.executeBrowser(continuation);
      h.observations.watchers.at(-1).onCancel();
      await assert.rejects(h.request(), { code: "web_turn_cancelled" });
    }
    expected.push({ role: "user", content: "Send all accumulated native instructions once." });
    h.newTurn("55002233-4455-6677-8899-aabbccddeeff", expected.at(-1).content);
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), expected);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.closes, 0);
    assert.equal(h.browser.ui.sends.length, 2);
    assert.equal(new Set(h.observations.bindings).size, 1);

    // Accepted discovery proves delivery even when Stop precedes an answer.
    const release = h.broker.beginActivity(h.token()); release();
    // A confirmed handoff collapses the alternatives. An earlier owner can no
    // longer authorize Stop or another handoff, even in this same binding.
    h.observations.watchers.at(-1).onCancel();
    h.browserOwner().turnId = turnId;
    h.browser.ui.stop = true;
    h.newTurn("66002233-4455-6677-8899-aabbccddeeff", "A stale previous owner must fail.");
    const stale = (await h.request()).output[0];
    await assert.rejects(h.executeBrowser(stale), /active.*turn|turn.*active/iu);
    assert.equal(h.browser.ui.stop, true);
    assert.equal(h.browser.ui.sends.length, 2);
  });
});

test("Stop before any open emission permits only an idempotent bootstrap in the same binding", async t => {
  for (const executed of [false, true]) await t.test(String(executed), async t => {
    const h = harness(t);
    const bootstrap = (await h.request()).output[0];
    const binding = JSON.parse(bootstrap.arguments).code.match(/\brouterWeb_[A-Za-z0-9_]+\b/u)[0];
    if (executed) await h.executeBrowser(bootstrap);
    h.observations.watchers[0].onCancel();
    h.newTurn(followupId, "Continue before any tab could have opened.");
    const retry = (await h.request()).output[0];
    assert.equal(JSON.parse(retry.arguments).title, "ChatGPT Web: bootstrap");
    assert.equal(JSON.parse(retry.arguments).code.match(/\brouterWeb_[A-Za-z0-9_]+\b/u)[0], binding);
    await h.toObserve();
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.sends.length, 1);
    assert.deepEqual(sentTranscript(h), [
      { role: "user", content: "Read the current file using the declared tools." },
      { role: "user", content: "Continue before any tab could have opened." },
    ]);
  });
});

test("an emitted open with an interrupted result never creates a replacement tab", async t => {
  for (const executed of [false, true]) await t.test(String(executed), async t => {
    const h = harness(t);
    const bootstrap = (await h.request()).output[0];
    const open = (await h.answerBrowser(bootstrap)).output[0];
    if (executed) await h.executeBrowser(open);
    h.observations.watchers[0].onCancel();
    h.newTurn(followupId, "Use the tab from the pending open.");
    const continuation = (await h.request()).output[0];
    assert.equal(JSON.parse(continuation.arguments).title, "ChatGPT Web: continue");
    if (executed) await h.toObserve();
    else await assert.rejects(h.executeBrowser(continuation), /Owned browser binding is unavailable/u);
    assert.equal(h.browser.ui.newTabs, executed ? 1 : 0);
    assert.equal(h.browser.ui.sends.length, executed ? 1 : 0);
    assert.equal(h.browser.ui.closes, 0);
  });
});

test("a restored failed first open can reinitialize only after its native binding is lost", async t => {
  for (const [label, lostKernel, discovery, interruptedBootstrap] of [
    ["lost binding", true, false], ["lost binding after native discovery", true, true], ["surviving binding", false, false],
    ["recovery bootstrap not executed", true, false, false], ["recovery bootstrap executed", true, false, true],
  ]) await t.test(label, async t => {
    const h = harness(t, { tools: discovery ? [search, currentRead] : [nativeJs, currentRead] });
    const stale = fakeBrowser(), foreign = fakeBrowser();
    stale.ui.tabId = "stale-initialization-tab";
    foreign.ui.tabId = "foreign-user-tab"; foreign.ui.url = "https://chatgpt.com/c/foreign-chat";
    foreign.ui.composer = "Keep the user's foreign draft.";
    const newTab = h.browser.browser.tabs.new, goto = stale.tab.goto;
    let created = 0;
    h.browser.browser.tabs.new = async () => ++created === 1 ? stale.tab : newTab();
    h.browser.browser.tabs.list = async () => [stale.tab, foreign.tab, ...(created > 1 ? [h.browser.tab] : [])]
      .map(tab => ({ id: tab.id, url: tab === stale.tab ? stale.ui.url : tab === foreign.tab ? foreign.ui.url : h.browser.ui.url }));
    stale.tab.goto = async url => { await goto(url); throw new Error("Initial home controls could not be read."); };
    const nextBrowserCall = async () => {
      const call = (await h.request()).output[0];
      if (call.type !== "tool_search_call") return call;
      h.append(call, outputFor(call, [nativeJs]));
      return (await h.request()).output[0];
    };
    const bootstrap = await nextBrowserCall();
    const open = (await h.answerBrowser(bootstrap)).output[0];
    const failure = await h.executeBrowser(open).then(() => assert.fail("The first open must fail before Send."), error => error);
    h.append(open, outputFor(open, { isError: true, content: [{ type: "text", text: failure.message }] }));
    await assert.rejects(h.request(), { code: "web_browser_execution_failed" });
    stale.ui.composer = "Keep the stale initialization draft.";
    const untouched = [stale, foreign].map(({ ui }) => ({ url: ui.url, composer: ui.composer,
      navigations: ui.navigations, closes: ui.closes, sends: [...ui.sends] }));
    await h.restartRuntime();
    if (lostKernel) h.loseKernel();
    // Native discovery declarations need not be retained in the next request.
    if (discovery) h.input().splice(0, h.input().length, ...h.input().filter(item => !["tool_search_call", "tool_search_output"].includes(item.type)));
    h.newTurn(followupId, "Continue the never-sent initial request.");
    let initialization = await nextBrowserCall(), nativeTurn = followupId;
    assert.equal(JSON.parse(initialization.arguments).title, "ChatGPT Web: bootstrap");
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.deepEqual(saved.browserOwnerTurnIds, [turnId, followupId]);
    assert.deepEqual(saved.lastTurn, { turnId: followupId, sendState: "unsent", completed: false });
    assert.equal(saved.uncertainSend, false); assert.deepEqual(saved.unresolvedCoding, []);
    for (const field of ["tabId", "chatUrl", "checkpoint", "generationTurnKey", "deliveredInstructionsSha256"]) assert.equal(saved[field], undefined);
    if (interruptedBootstrap !== undefined) {
      if (interruptedBootstrap) await h.executeBrowser(initialization);
      h.observations.watchers.at(-1).onCancel();
      nativeTurn = "33002233-4455-6677-8899-aabbccddeeff";
      h.newTurn(nativeTurn, "Resume the interrupted initialization.");
      initialization = await nextBrowserCall();
      assert.equal(JSON.parse(initialization.arguments).title, "ChatGPT Web: bootstrap");
      assert.equal(created, 1, "An interrupted recovery bootstrap never opens another tab.");
    }
    const reopened = (await h.answerBrowser(initialization)).output[0];
    assert.equal(JSON.parse(reopened.arguments).title, "ChatGPT Web: open");
    if (lostKernel) {
      const send = (await h.answerBrowser(reopened)).output[0];
      const observe = (await h.answerBrowser(send)).output[0];
      h.browser.ui.texts.push("The initial request completed once."); h.browser.ui.complete = true;
      const retain = (await h.answerBrowser(observe)).output[0];
      for (const call of [send, observe, retain]) {
        const args = JSON.parse(call.arguments), sandbox = { currentAuthority: true };
        const native = { name: "js", arguments: args, _meta: { threadId, sessionId: threadId, callId: call.call_id,
          "x-codex-turn-metadata": { ...metadata(nativeTurn), session_id: threadId, auto_review_enabled: true,
            node_repl_auto_review_required: true, node_repl_disabled: false },
          "codex/sandbox-state": sandbox, "codex/sandbox-state-meta": structuredClone(sandbox), "codex/sandbox-launcher": { opaque: true } } };
        assert.ok(qualifyBrowserCall(native, h.settings.browser.runtimeModule), "Canonical programs retain exact adapter qualification after reinitialization.");
      }
      const final = await h.answerBrowser(retain);
      assert.equal(final.output[0].content[0].text, "The initial request completed once.");
      assert.deepEqual(sentTranscript(h), [
        { role: "user", content: "Read the current file using the declared tools." },
        { role: "user", content: "Continue the never-sent initial request." },
        ...(interruptedBootstrap !== undefined ? [{ role: "user", content: "Resume the interrupted initialization." }] : []),
      ]);
      assert.equal(created, 2); assert.equal(h.browser.ui.sends.length, 1);
    } else {
      await assert.rejects(h.executeBrowser(reopened), /already owns a tab/u);
      assert.equal(created, 1); assert.equal(h.browser.ui.sends.length, 0);
    }
    assert.deepEqual([stale, foreign].map(({ ui }) => ({ url: ui.url, composer: ui.composer,
      navigations: ui.navigations, closes: ui.closes, sends: [...ui.sends] })), untouched);
    assert.equal(new Set(h.observations.bindings).size, 1);
  });
});

test("interrupted Send checkpoints accept omitted or partial native assistant history without resending prior input", async t => {
  for (const [label, partial, nativeAssistant] of [
    ["omitted", "A stopped Web answer", undefined],
    ["prefix", "A stopped Web answer", "A stopped"],
    ["no partial", "", undefined],
    ["distinct assistant data", "A stopped Web answer", "A different native statement"],
  ]) await t.test(label, async t => {
    const h = harness(t);
    await h.toObserve();
    if (partial) h.browser.ui.texts.push(partial);
    const release = h.broker.beginActivity(h.token()); release();
    h.browser.ui.stop = true;
    h.observations.watchers[0].onCancel();
    if (nativeAssistant !== undefined) h.append({ role: "assistant", content: nativeAssistant });
    h.newTurn(followupId, "Continue from the stopped answer.");
    await h.toObserve();
    const expected = [{ role: "user", content: "Continue from the stopped answer." }];
    if (label === "distinct assistant data") expected.unshift({ role: "assistant", content: nativeAssistant });
    assert.deepEqual(sentTranscript(h), expected);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.closes, 0);
    assert.equal(new Set(h.observations.bindings).size, 1);
    assert.equal(h.browser.ui.sends.length, 2);
  });
});

test("cancellation before Send emission preserves unsent native input in the same owned chat", async t => {
  const h = harness(t);
  const bootstrap = (await h.request()).output[0];
  const open = (await h.answerBrowser(bootstrap)).output[0];
  await h.executeBrowser(open);
  h.observations.watchers[0].onCancel();
  h.newTurn(followupId, "Also keep this new instruction.");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [
    { role: "user", content: "Read the current file using the declared tools." },
    { role: "user", content: "Also keep this new instruction." },
  ]);
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(new Set(h.observations.bindings).size, 1);
});

test("owned unresolved coding blocks across restart until a late actual result arrives without re-emitting the action", async t => {
  const h = harness(t);
  const admission = new RouterAdmission({ webRuntimeState: () => h.runtime.maintenanceState() });
  const { call } = await h.toObserve();
  const token = h.token(), read = h.broker.list(token).tools.find(tool => tool.name === "read");
  const pending = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "unknown.txt" } });
  const rejection = assert.rejects(pending, { code: "web_turn_cancelled" });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding);
  h.observations.watchers[0].onCancel();
  await rejection;
  assert.deepEqual(h.runtime.maintenanceState(), { activeTurns: 0, uncertainSends: 0, unresolvedActions: 1 });
  assert.equal((await admission.drain()).reason, "web-workflow-indeterminate");
  const oldBroker = h.broker;
  await h.restartRuntime();
  const operationsBefore = h.observations.nativeOperations.length;
  await assert.rejects(h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() }), { code: "web_coding_uncertain" });
  h.newTurn(followupId, "Continue using only confirmed results.");
  await assert.rejects(h.request(), { code: "web_coding_uncertain" });
  assert.equal((await admission.drain()).reason, "web-workflow-indeterminate");
  assert.equal(h.observations.nativeOperations.length, operationsBefore);
  assert.equal(h.browser.ui.sends.length, 1);
  h.append({ type: "function_call_output", call_id: coding.call_id });
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "A missing result cannot resolve the action.");
  await assert.rejects(h.request(), { code: "web_tool_result" });
  h.input().pop(); h.input().pop();
  h.append(outputFor(coding, "late actual result"));
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "The late result is now available.");
  const next = await h.toObserve();
  assert.notEqual(next.call.call_id, coding.call_id);
  assert.equal(next.call.namespace, "mcp__node_repl");
  assert.equal(sentTranscript(h)[0].call_id, coding.call_id);
  assert.deepEqual(sentTranscript(h).find(item => item.type === "function_call_output"), { type: "function_call_output", call_id: coding.call_id, output: "late actual result" });
  assert.throws(() => oldBroker.list(token), { code: "web_tool_turn_closed" });
  assert.notEqual(h.token(), token);
  assert.equal(h.runtime.maintenanceState().unresolvedActions, 0);
});

test("an unconfirmed Send is never replayed after cancellation even if its click took effect", async t => {
  for (const [executed, lostKernel] of [[false, false], [true, false], [true, true]]) await t.test(`${executed ? "click took effect" : "execution unknown"}; kernel lost ${lostKernel}`, async t => {
    const h = harness(t);
    let response = await h.request();
    while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
    if (executed) await h.executeBrowser(response.output[0]);
    h.observations.watchers[0].onCancel();
    assert.deepEqual(h.runtime.maintenanceState(), { activeTurns: 0, uncertainSends: 1, unresolvedActions: 0 });
    if (lostKernel) { h.loseKernel(); await h.restartRuntime(); }
    await assert.rejects(h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() }), { code: "web_send_uncertain" });
    h.newTurn(followupId, "Resume without duplicating the uncertain Send.");
    const before = h.observations.nativeOperations.length;
    await assert.rejects(h.request(), { code: "web_send_uncertain" });
    const admission = new RouterAdmission({ webRuntimeState: () => h.runtime.maintenanceState() });
    assert.equal((await admission.drain()).reason, "web-workflow-indeterminate");
    assert.equal(h.observations.nativeOperations.length, before);
    assert.equal(h.browser.ui.sends.length, executed ? 1 : 0);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.closes, 0);
  });
});

async function stopBeforeRenderedReply(h, { observed = true, emptyReply = false } = {}) {
  let response = await h.request();
  while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
  h.browser.ui.texts = ["Earlier reply", "Another earlier reply"];
  const observe = (await h.answerBrowser(response.output[0])).output[0];
  // This recovery fixture models an accepted connector discovery before Stop.
  const release = h.broker.beginActivity(h.token()); release();
  h.browser.ui.stop = true;
  if (emptyReply) h.browser.ui.texts.push("");
  if (observed) await h.answerBrowser(observe);
  h.observations.watchers[0].onCancel();
  h.loseKernel();
}

test("maintenance drain follows Web work through Stop and confirmed same-chat continuation", async t => {
  const h = harness(t);
  const admission = new RouterAdmission({ webRuntimeState: () => h.runtime.maintenanceState() });
  const idle = { activeTurns: 0, uncertainSends: 0, unresolvedActions: 0 };
  assert.deepEqual(h.runtime.maintenanceState(), idle);
  const admitted = admission.begin();
  const draining = admission.drain({ timeoutMs: 1_000 });
  await h.request();
  admitted.finish();
  assert.equal((await draining).reason, "web-workflow-active");
  await stopBeforeRenderedReply(h);
  assert.deepEqual(h.runtime.maintenanceState(), idle);
  assert.equal((await admission.drain()).status, "drained");
  admission.resume();

  h.newTurn(followupId, "Continue in the same chat after Stop.");
  const { call } = await h.toObserve();
  assert.equal((await admission.drain()).reason, "web-workflow-indeterminate");
  await h.completeAnswer(call, "Completed after confirmed same-chat recovery.");
  assert.deepEqual(h.runtime.maintenanceState(), idle);
  assert.equal((await admission.drain()).status, "drained");
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.equal(h.browser.ui.stopMarks.length, 1);
});

test("a confirmed interrupted Send without observed text recovers its exact retained tab and sends only new native history", async t => {
  for (const kind of ["no observation", "zero fresh replies", "one latest fresh reply", "multiple owned replies", "known empty reply", "empty reply progressed identity"]) await t.test(kind, async t => {
    const h = harness(t);
    await stopBeforeRenderedReply(h, { observed: kind !== "no observation", emptyReply: kind.includes("empty reply") });
    if (kind === "one latest fresh reply") h.browser.ui.texts.push("An answer rendered after Stop.");
    if (kind === "multiple owned replies") h.browser.ui.texts.push("An owned commentary.", "An owned final answer.");
    if (kind === "empty reply progressed identity") h.browser.ui.replyIds = [messageId(0), messageId(1), messageId(3)];
    await h.restartRuntime();
    const priorCheckpoint = JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint;
    h.newTurn(followupId, "Continue in the same chat.");
    const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
    const pending = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(pending.lastTurn.sendState, "unsent");
    assert.deepEqual(pending.checkpoint, priorCheckpoint);
    const result = await h.executeBrowser(continuation);
    assert.match(result, /"recovered":true/u); assert.match(result, /"interrupted":true/u);
    h.append(continuation, outputFor(continuation, result));
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue in the same chat." }]);
    assert.deepEqual(h.browser.ui.reacquired, ["owned-saved-tab"]);
    assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
    assert.equal(h.browser.ui.sends.length, 2); assert.equal(h.browser.ui.stopMarks.length, 1);
    assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
  });
});

test("a confirmed interrupted generation recovers its saved chat after its tab identity is lost without replaying Send", async t => {
  for (const closed of [false, true]) await t.test(closed ? "closed tab" : "replacement tab at the same saved URL", async t => {
    const h = harness(t);
    await stopBeforeRenderedReply(h);
    const savedUrl = h.browser.ui.url;
    if (closed) h.browser.ui.present = false;
    else h.browser.ui.tabId = "another-tab";
    await h.restartRuntime();
    const priorCheckpoint = JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint;
    h.newTurn(followupId, "Continue in the recovered saved chat.");
    const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
    const pending = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(pending.lastTurn.sendState, "unsent");
    assert.deepEqual(pending.checkpoint, priorCheckpoint);
    const result = await h.executeBrowser(continuation);
    assert.match(result, /"recovered":true/u);
    assert.match(result, /"interrupted":true/u);
    assert.equal(h.browser.ui.url, savedUrl);
    assert.equal(h.browser.ui.sends.length, 1, "Recovery must not replay the interrupted Send.");
    h.append(continuation, outputFor(continuation, result));
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue in the recovered saved chat." }]);
    assert.equal(h.browser.ui.sends.length, 2, "Only the new follow-up is sent.");
    assert.equal(h.browser.ui.newTabs, closed ? 2 : 1);
    assert.equal(h.browser.ui.navigations, closed ? 2 : 1);
    assert.equal(h.browser.ui.closes, 0);
    assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
  });
});

test("retained-tab recovery rejects foreign chats, ambiguous replies and drafts before Stop or Send", async t => {
  for (const [label, mutate, emptyReply] of [
    ["changed saved URL", h => { h.browser.ui.url = "https://chatgpt.com/c/another-chat"; }],
    ["duplicate identity", h => { h.browser.ui.replyIds = [messageId(0), messageId(0)]; }],
    ["missing identity", h => { h.browser.ui.replyIds = [messageId(0), null]; }],
    ["foreign generation identity", h => { h.browser.ui.texts.push("A foreign reply"); h.browser.ui.replyTurnKeys = [null, null, messageId(999)]; }],
    ["fresh identity is not latest", h => { h.browser.ui.replyIds = [messageId(2), messageId(1)]; }],
    ["composer draft", h => { h.browser.ui.composer = "Keep this unsent draft."; }],
  ]) await t.test(label, async t => {
    const h = harness(t);
    await stopBeforeRenderedReply(h, { emptyReply }); mutate(h);
    h.newTurn(followupId, "Continue only in the retained chat.");
    const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
    await assert.rejects(h.executeBrowser(continuation), label === "changed saved URL"
      ? /known tab is not an empty normal ChatGPT home/iu
      : /saved chat reply or composer/iu);
    assert.equal(h.browser.ui.stop, true); assert.deepEqual(h.browser.ui.stopMarks, []);
    assert.equal(h.browser.ui.sends.length, 1); assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
  });
});

test("retained-tab recovery rechecks ownership across SDK discovery, Stop visibility and final reply reads", async t => {
  for (const boundary of ["browser discovery", "tab acquisition", "Stop visibility", "final reply read"]) await t.test(boundary, async t => {
    const h = harness(t); await stopBeforeRenderedReply(h);
    const foreign = { turnId: "99002233-4455-6677-8899-aabbccddeeff", state: {} };
    const replace = () => h.replaceBrowserOwner(foreign);
    if (boundary === "browser discovery") {
      const list = h.browser.agent.browsers.list;
      h.browser.agent.browsers.list = async () => { const value = await list(); replace(); return value; };
    } else if (boundary === "tab acquisition") {
      const get = h.browser.browser.tabs.get;
      h.browser.browser.tabs.get = async tabId => { const value = await get(tabId); replace(); return value; };
    } else if (boundary === "Stop visibility") {
      h.browser.ui.afterStopRead = replace;
    } else {
      const locator = h.browser.tab.playwright.locator;
      let reads = 0;
      h.browser.tab.playwright.locator = selector => {
        const control = locator(selector), evaluate = control.evaluateAll;
        if (selector === '[data-turn-key],[data-chatgpt-selection-message-id] [data-markdown-text-style="assistant-message"]') control.evaluateAll = async (...args) => {
          const value = await evaluate(...args); if (++reads === 2) replace(); return value;
        };
        return control;
      };
    }
    h.newTurn(followupId, "A newer owner must win.");
    const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
    await assert.rejects(h.executeBrowser(continuation), /different native turn/iu);
    assert.equal(h.browserOwner(), foreign);
    assert.equal(h.browser.ui.sends.length, 1); assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
    if (boundary !== "final reply read") assert.deepEqual(h.browser.ui.stopMarks, []);
  });
});

test("retained-tab recovery can discover owned replies during Stop but cannot cross a generation boundary", async t => {
  for (const replaceReply of [false, true]) await t.test(replaceReply ? "foreign generation appeared" : "first reply appears during Stop", async t => {
    const h = harness(t); await stopBeforeRenderedReply(h);
    if (replaceReply) h.browser.ui.texts.push("The first unobserved reply");
    h.browser.ui.afterStopClick = () => {
      if (replaceReply) { h.browser.ui.replyIds = [messageId(0), messageId(1), messageId(3)]; h.browser.ui.replyTurnKeys = [null, null, messageId(998)]; }
      else h.browser.ui.texts.push("The first reply rendered while Stop was reconciled");
    };
    h.newTurn(followupId, "Continue only after identifying the stopped reply.");
    const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
    if (replaceReply) await assert.rejects(h.executeBrowser(continuation), /confirmed browser generation is no longer unique and latest/iu);
    else {
      const output = await h.executeBrowser(continuation); h.append(continuation, outputFor(continuation, output));
      await h.toObserve();
      assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue only after identifying the stopped reply." }]);
    }
    assert.equal(h.browser.ui.sends.length, replaceReply ? 1 : 2);
    assert.equal(h.browser.ui.stopMarks.length, 1); assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
  });
});

test("failed pre-Send recovery preserves its confirmed checkpoint across an unsent retry and restart", async t => {
  const h = harness(t); await stopBeforeRenderedReply(h);
  const checkpoint = JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint;
  h.browser.ui.composer = "A draft temporarily blocks recovery.";
  h.newTurn(followupId, "First new native instruction.");
  const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
  const failure = await h.executeBrowser(continuation).then(() => assert.fail("The draft must block recovery."), error => error);
  h.append(continuation, outputFor(continuation, { isError: true, content: [{ type: "text", text: failure.message }] }));
  await assert.rejects(h.request(), error => {
    assert.equal(error.code, "web_saved_chat_recovery_failed");
    assert.deepEqual(error.diagnostic.stage, "continue");
    assert.equal(error.diagnostic.reason, "composer-draft-present");
    assert.match(safeLocalHttpErrorPayload(error).error.message, /stage=continue, reason=composer-draft-present/u);
    assert.equal(error.message.includes(h.browser.ui.composer), false);
    return true;
  });
  await h.restartRuntime();
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.lastTurn.turnId, followupId); assert.equal(saved.lastTurn.sendState, "unsent");
  assert.deepEqual(saved.checkpoint, checkpoint); assert.equal(saved.uncertainSend, false);
  assert.equal(saved.interruptedTurnId, undefined); assert.equal(saved.interruptedSendState, undefined);
  h.browser.ui.composer = "";
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Second new native instruction.");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "First new native instruction." }, { role: "user", content: "Second new native instruction." }]);
  assert.equal(h.browser.ui.sends.length, 2); assert.equal(h.browser.ui.newTabs, 1); assert.equal(h.browser.ui.navigations, 1);
});

test("an interrupted unsent turn without a confirmed checkpoint cannot recover or open a replacement", async t => {
  const h = harness(t);
  const bootstrap = (await h.request()).output[0];
  const open = (await h.answerBrowser(bootstrap)).output[0];
  await h.executeBrowser(open);
  h.observations.watchers[0].onCancel(); h.loseKernel();
  h.newTurn(followupId, "An unacknowledged open is still uncertain.");
  const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
  await assert.rejects(h.executeBrowser(continuation), /binding was lost/u);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.navigations, 1);
  assert.equal(h.browser.ui.sends.length, 0);
});

test("unexplained native history changes reject instead of sending the whole prior transcript", async t => {
  const h = harness(t);
  const previousSearch = { type: "tool_search_call", call_id: "actual_previous_native_search", execution: "client", arguments: { query: "Current native tools" } };
  h.append(previousSearch, outputFor(previousSearch, [currentRead]));
  await h.toObserve();
  const release = h.broker.beginActivity(h.token()); release();
  h.observations.watchers[0].onCancel();
  previousSearch.arguments.query = "Substituted earlier native tool query";
  h.newTurn(followupId, "Continue after changed history.");
  const continuation = (await h.request()).output[0];
  await assert.rejects(h.answerBrowser(continuation), { code: "web_history_mismatch" });
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.newTabs, 1);
});

test("readable compaction preserves native evidence and current instructions in the retained chat", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const token = h.token(), read = h.broker.list(token).tools.find(tool => tool.name === "read");
  const result = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding, outputFor(coding, "Actual file contents retained as native evidence."));
  const observe = (await h.request()).output[0];
  assert.deepEqual(await result, { content: [{ type: "text", text: "Actual file contents retained as native evidence." }] });
  await h.completeAnswer(observe, "First answer");
  const compact = await h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true });
  const checkpoint = (await compact.json()).output;
  h.input().splice(0, h.input().length, ...checkpoint);
  h.newTurn(followupId, "Continue from the readable checkpoint.", { instructions: "Current native instructions still apply." });
  await h.toObserve();
  const history = sentTranscript(h);
  assert.equal(history[0].role, "developer");
  assert.match(history[0].content, /Read the current file using the declared tools/u);
  assert.match(history[0].content, /Actual file contents retained as native evidence/u);
  assert.match(history[0].content, /lossy continuation checkpoint/u);
  assert.deepEqual(history.at(-1), { role: "user", content: "Continue from the readable checkpoint." });
  assert.match(h.browser.ui.sends.at(-1), /Current native instructions still apply/u);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.deepEqual(h.broker.list(h.token()).tools.find(tool => tool.name === "read").parameters, currentRead.tools[0].parameters);
  h.observations.watchers.at(-1).onCancel();
  const opaqueTurn = "33002233-4455-6677-8899-aabbccddeeff";
  h.input().splice(0, h.input().length, { type: "compaction", encrypted_content: "opaque-native-checkpoint" });
  h.newTurn(opaqueTurn, "An opaque checkpoint remains unsupported.");
  await assert.rejects(h.request(), { code: "encrypted_v2_unsupported" });
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.sends.length, 2);
});

test("attributed compaction preserves undelivered native items without resending an acknowledged summary", async t => {
  for (const mode of ["used", "abandoned", "recompacted", "restarted", "second abandoned", "second abandoned after restart", "owned coding"]) await t.test(mode, async t => {
    const h = harness(t), { call } = await h.toObserve();
    let observe = call;
    if (mode === "owned coding") {
      const token = h.token(), read = h.broker.list(token).tools.find(tool => tool.name === "read");
      const result = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "owned-completed-result.txt" } });
      const owned = (await h.answerBrowser(observe)).output[0];
      h.append(owned, outputFor(owned, "Owned actual result already delivered to Web"));
      observe = (await h.request()).output[0]; await result;
    }
    await h.completeAnswer(observe, "Already owned Web answer with detailed context");
    const rawTail = [
      { role: "user", content: "Genuinely unsent user material", id: "native-user-id" },
      { type: "function_call", call_id: "historical-native-action", name: "read", arguments: "{}", status: "completed" },
      { type: "function_call_output", call_id: "historical-native-action", output: "Actual native evidence after the delivery checkpoint" },
      { role: "assistant", content: "Already owned Web answer" },
    ];
    h.append(...rawTail);
    const before = h.observations.nativeOperations.length;
    const compact = async () => (await (await h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() })).json()).output;
    const original = structuredClone(h.input()), output = await compact();
    assert.deepEqual(output.slice(1), rawTail);
    assert.equal(h.observations.nativeOperations.length, before, "Compaction makes no browser or inference call.");
    assert.equal(h.browser.ui.sends.length, 1);
    if (mode !== "abandoned") h.input().splice(0, h.input().length, ...output);
    if (mode === "recompacted") {
      const repeated = await compact();
      assert.deepEqual(repeated.slice(1), rawTail);
      h.input().splice(0, h.input().length, ...repeated);
    }
    if (mode.startsWith("second abandoned")) {
      const abandoned = await compact();
      assert.notEqual(abandoned[0].id, output[0].id);
      assert.deepEqual(h.input(), output, "The newer returned compact window was abandoned; the applied window remains current.");
    }
    if (mode === "restarted" || mode === "second abandoned after restart") { await h.restartRuntime(); h.loseKernel(); }
    if (mode === "abandoned") assert.deepEqual(h.input(), original);
    h.newTurn(followupId, "New request after native compaction", { instructions: "Current changed instructions remain authoritative." });
    const { call: compactObserve } = await h.toObserve();
    assert.deepEqual(sentTranscript(h), [
      { role: "user", content: rawTail[0].content },
      { type: "function_call", call_id: rawTail[1].call_id, name: rawTail[1].name, arguments: rawTail[1].arguments },
      { type: "function_call_output", call_id: rawTail[2].call_id, output: rawTail[2].output },
      { role: "assistant", content: rawTail[3].content },
      { role: "user", content: "New request after native compaction" },
    ]);
    assert.match(h.browser.ui.sends.at(-1), /Current changed instructions remain authoritative/u);
    assert.equal(h.browser.ui.sends.at(-1).includes("lossy continuation checkpoint"), false);
    const release = h.broker.beginActivity(h.token()); release();
    await h.answerBrowser(compactObserve);
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(saved.pendingCompaction, undefined, "Only accepted input replaces the delivery checkpoint and consumes the alias.");
    assert.equal(saved.activeCompaction, undefined);
  });
});

test("confirmed capacity rejection with no answer or coding action transfers history once and refreshes native authority", async t => {
  const instructions = "Successor chats retain the current full native authority.";
  const h = harness(t, { instructions }), { call } = await h.toObserve();
  const oldToken = h.token(), sourceUrl = h.browser.ui.url;
  h.browser.ui.full = true;
  const rollover = (await h.answerBrowser(call)).output[0];
  assert.equal(JSON.parse(rollover.arguments).title, "ChatGPT Web: rollover");
  assert.throws(() => h.broker.list(oldToken), { code: "web_tool_turn_closed" });
  const { call: nextObserve } = await h.toObserve();
  assert.equal(h.browser.ui.rollovers, 1);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.notEqual(h.token(), oldToken);
  assert.ok(h.browser.ui.sends.at(-1).includes(`Current Codex instructions:\n${instructions}`));
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Read the current file using the declared tools." }]);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, undefined);
  await h.completeAnswer(nextObserve, "Successor answer");
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.chatUrl, "https://chatgpt.com/c/successor-2");
  assert.deepEqual(saved.previousChatUrls, [sourceUrl]);
  assert.equal(saved.needsHistory, false);
  h.newTurn(followupId, "Later native delta");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Later native delta" }]);
  assert.equal(h.browser.ui.sends.at(-1).includes(instructions), false);
  assert.equal(h.browser.ui.rollovers, 1);
});

test("first-input capacity rejection survives Router restart without acknowledging context", async t => {
  const h = harness(t), { call } = await h.toObserve();
  const rejectedUrl = h.browser.ui.url;
  h.browser.ui.full = true;
  const rollover = (await h.answerBrowser(call)).output[0];
  const rejected = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(rejected.capacityChatUrl, rejectedUrl);
  assert.equal(rejected.checkpoint, undefined);
  assert.equal(rejected.chatUrl, undefined);
  assert.equal(rejected.deliveredInstructionsSha256, undefined);
  assert.equal(rejected.uncertainSend, false);
  await h.executeBrowser(rollover);
  await h.restartRuntime();
  h.newTurn(followupId, "Continue after the explicit capacity rejection.");
  const { call: next } = await h.toObserve();
  assert.equal(h.browser.ui.rollovers, 1);
  assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).checkpoint, undefined);
  await h.completeAnswer(next, "Accepted successor input.");
  const accepted = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(accepted.capacityChatUrl, undefined);
  assert.deepEqual(accepted.previousChatUrls, [rejectedUrl]);
  assert.equal(h.browser.ui.sends.length, 2);
});

test("native V2 preserves an exact pending tail after its retained-user prefix and outer identity are rewritten", async t => {
  for (const mode of ["used", "abandoned", "recompacted", "restarted", "second abandoned", "second abandoned after restart"]) await t.test(mode, async t => {
    const instructions = "Current native authority survives exact V2 compaction.";
    const h = harness(t, { instructions }), { call } = await h.toObserve();
    await h.completeAnswer(call, "Already owned Web answer");
    const tail = [{ role: "user", content: "Unsent native user must arrive exactly once" },
      { type: "function_call", call_id: "pending_native_tool", name: "read", arguments: '{ "path": "literal `$ 漢.txt" }' },
      { type: "function_call_output", call_id: "pending_native_tool", output: "Unsent actual native tool result" }];
    h.append(...tail);
    const before = h.observations.nativeOperations.length, original = structuredClone(h.input());
    const compact = () => h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", stream: true,
      input: [...h.input(), { type: "compaction_trigger" }] }, { compactV2: true, headers: headers() });
    const first = await nativeV2Checkpoint(await compact());
    assert.deepEqual(decodeCompaction(first.encrypted_content).checkpoint.retained_tail, tail);
    assert.equal(h.observations.nativeOperations.length, before);
    assert.equal(h.browser.ui.sends.length, 1);
    if (mode !== "abandoned") h.input().splice(0, h.input().length, ...nativeV2Users(original), first);
    if (mode === "recompacted" || mode.startsWith("second abandoned")) {
      const second = await nativeV2Checkpoint(await compact());
      assert.deepEqual(decodeCompaction(second.encrypted_content).checkpoint.retained_tail, tail);
      if (mode === "recompacted") h.input().splice(0, h.input().length, ...nativeV2Users(h.input()), second);
    }
    if (mode === "restarted" || mode === "second abandoned after restart") { await h.restartRuntime(); h.loseKernel(); }
    const privateRecord = readFileSync(h.stateFile, "utf8");
    for (const pending of [tail[0].content, tail[1].arguments, tail[2].output]) assert.equal(privateRecord.includes(pending), false);
    h.newTurn(followupId, "New native input after V2 compaction");
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [...tail, { role: "user", content: "New native input after V2 compaction" }]);
    assert.equal(h.browser.ui.sends.at(-1).includes(instructions), false);
    assert.equal(h.browser.ui.sends.length, 2);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("native V2 preserves rebuilt native context once while deduplicating reordered source and pending-user copies", async t => {
  for (const mode of ["used", "recompacted", "restarted", "partial assistant", "extra duplicate"]) await t.test(mode, async t => {
    const h = harness(t), initialUser = structuredClone(h.input()[0]);
    const message = (role, ...texts) => ({ type: "message", role, content: texts.map(text => ({ type: "input_text", text })) });
    const developer = message("developer", "Native runtime instructions", "Native tool contract", "<skills_instructions>Current skills</skills_instructions>",
      "<permissions instructions>Old workspace policy</permissions instructions>", "<collaboration_mode>Default</collaboration_mode>", "Voice settings", "Agent policy", "Task authority");
    const currentDeveloper = structuredClone(developer); currentDeveloper.content[3].text = "<permissions instructions>Current workspace policy</permissions instructions>";
    const retainedDeveloper = message("developer", "Unchanged native developer control");
    const environment = message("user", "# AGENTS.md instructions\n<INSTRUCTIONS>Same repository authority</INSTRUCTIONS>", "<environment_context>Old environment</environment_context>");
    const currentEnvironment = structuredClone(environment); currentEnvironment.content[1].text = "<environment_context>Current environment</environment_context>";
    const repeatedUser = message("user", "A repeated original native request");
    h.input().unshift(developer, retainedDeveloper, environment, repeatedUser, structuredClone(repeatedUser));
    const { call } = await h.toObserve();
    const ownedAnswer = "Owned completed Web answer ".padEnd(130, "x");
    h.browser.ui.texts.push(ownedAnswer); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
    if (mode === "partial assistant") final.output[0].content[0].text = ownedAnswer.slice(0, 64);
    const pendingUser = message("user", "Pending native user must survive exactly once"); h.append(pendingUser);
    await h.restartRuntime();
    const compact = () => h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", stream: true,
      input: [...h.input(), { type: "compaction_trigger" }] }, { compactV2: true, headers: headers() });
    let checkpoint = await nativeV2Checkpoint(await compact());
    assert.deepEqual(decodeCompaction(checkpoint.encrypted_content).checkpoint.retained_tail,
      mode === "partial assistant" ? [final.output[0], pendingUser] : [pendingUser]);
    const prefix = [structuredClone(repeatedUser), retainedDeveloper, currentDeveloper, structuredClone(repeatedUser), currentEnvironment,
      ...(mode === "extra duplicate" ? [structuredClone(repeatedUser)] : []), initialUser, pendingUser];
    h.input().splice(0, h.input().length, ...prefix, checkpoint);
    if (mode === "recompacted") {
      checkpoint = await nativeV2Checkpoint(await compact());
      h.input().splice(0, h.input().length, ...prefix, checkpoint);
    }
    if (mode === "restarted") { await h.restartRuntime(); h.loseKernel(); }
    h.newTurn(followupId, "First request after native compaction");
    const observation = await h.toObserve();
    const normalized = item => ({ role: item.role, content: item.content.map(part => part.text).join("\n") });
    assert.deepEqual(sentTranscript(h), [normalized(currentDeveloper), normalized(currentEnvironment),
      ...(mode === "extra duplicate" ? [normalized(repeatedUser)] : []), normalized(pendingUser), { role: "user", content: "First request after native compaction" }]);
    const privateRecord = readFileSync(h.stateFile, "utf8");
    assert.equal(privateRecord.includes(currentDeveloper.content[3].text), false);
    assert.equal(privateRecord.includes(pendingUser.content[0].text), false);
    await h.completeAnswer(observation.call, "Web completed the post-compaction request");
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Next request stays a small delta");
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Next request stays a small delta" }]);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("native V2 forwards changed or clipped retained-prefix material instead of suppressing it", async t => {
  const h = harness(t), { call } = await h.toObserve();
  await h.completeAnswer(call, "Owned answer");
  const checkpoint = await nativeV2Checkpoint(await h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", stream: true,
    input: [...h.input(), { type: "compaction_trigger" }] }, { compactV2: true, headers: headers() }));
  h.input().splice(0, h.input().length, { role: "user", content: "Unknown or clipped prefix must not disappear" }, checkpoint);
  h.newTurn(followupId, "Preserve all new input");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Unknown or clipped prefix must not disappear" }, { role: "user", content: "Preserve all new input" }]);
  assert.equal(h.browser.ui.sends.length, 2);
});

test("native V2 carries a pending coding result without delivering it until the ordinary request", async t => {
  for (const mode of ["used", "abandoned", "recompacted", "restarted", "later owned batch", "undelivered native tail", "canceled"]) await t.test(mode, async t => {
  const h = harness(t), { call } = await h.toObserve();
  const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
  const result = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "pending-v2.txt" } });
  let settled = false, deliveries = 0;
  void result.then(() => { settled = true; }, () => {});
  const complete = h.broker.complete.bind(h.broker);
  h.broker.complete = (...args) => { deliveries += 1; return complete(...args); };
  const coding = (await h.answerBrowser(call)).output[0], output = outputFor(coding, "Actual result preserved across native V2");
  h.append(coding, output);
  const original = structuredClone(h.input()), operations = h.observations.nativeOperations.length;
  const compact = () => h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", stream: true,
    input: [...h.input(), { type: "compaction_trigger" }] }, { compactV2: true, headers: headers() });
  let checkpoint = await nativeV2Checkpoint(await compact());
  assert.deepEqual(decodeCompaction(checkpoint.encrypted_content).checkpoint.retained_tail, [coding, output]);
  assert.equal(settled, false); assert.equal(deliveries, 0);
  assert.equal(h.observations.nativeOperations.length, operations);
  if (mode !== "abandoned") h.input().splice(0, h.input().length, ...nativeV2Users(original), checkpoint);
  if (mode === "recompacted") {
    checkpoint = await nativeV2Checkpoint(await compact());
    h.input().splice(0, h.input().length, ...nativeV2Users(h.input()), checkpoint);
    assert.equal(deliveries, 0);
  }
  let observation = await h.request();
  assert.deepEqual(await result, { content: [{ type: "text", text: output.output }] });
  assert.equal(deliveries, 1);
  assert.equal(JSON.parse(observation.output[0].arguments).title, "Wait for ChatGPT or its next Codex tool request");
  assert.deepEqual((await h.request()).output, observation.output);
  assert.equal(deliveries, 1);
  assert.equal(h.browser.ui.sends.length, 1);
  if (mode === "later owned batch") {
    const later = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "later-after-carrier.txt" } });
    const second = (await h.answerBrowser(observation.output[0])).output[0];
    h.append(second, outputFor(second, "Later actual result after the carrier"));
    observation = await h.request(); await later;
    assert.equal(deliveries, 2);
  }
  const unsent = [{ role: "user", content: "New native material not delivered to Web" },
    { type: "function_call", call_id: "foreign_after_owned", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "foreign_after_owned", output: "Actual foreign native result" }];
  if (mode === "undelivered native tail") h.append(...unsent);
  if (mode === "canceled") {
    h.observations.watchers[0].onCancel();
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).activeCompaction?.acknowledgedTailHashes, undefined);
  } else {
    await h.completeAnswer(observation.output[0], "Completed Web answer after actual native result");
    const record = JSON.parse(readFileSync(h.stateFile, "utf8"));
    if (mode !== "abandoned") {
      assert.equal(record.activeCompaction.acknowledgedTailHashes.length, mode === "later owned batch" ? 4 : 2);
      assert.equal(JSON.stringify(record).includes(output.output), false);
    }
  }
  if (mode === "restarted") { await h.restartRuntime(); h.loseKernel(); }
  h.newTurn(followupId, "Only this new native request remains");
  await h.toObserve();
  const sent = sentTranscript(h);
  if (mode === "canceled") {
    assert.equal(sent.filter(item => item.call_id === coding.call_id).length, 2);
    assert.deepEqual(sent.at(-1), { role: "user", content: "Only this new native request remains" });
  } else if (mode === "undelivered native tail") {
    assert.deepEqual(sent.slice(0, unsent.length), unsent);
    assert.equal(sent.some(item => item.call_id === coding.call_id), false);
    assert.deepEqual(sent.at(-1), { role: "user", content: "Only this new native request remains" });
  } else assert.deepEqual(sent, [{ role: "user", content: "Only this new native request remains" }]);
  assert.equal(h.browser.ui.sends.length, 2);
  });
});

test("native V2 acknowledges actual coding across refreshed context and recompaction without hiding later native work", async t => {
  for (const mode of ["completed", "restart prefix-form record", "later native answer"]) await t.test(mode, async t => {
    const h = harness(t), { call } = await h.toObserve();
    const read = h.broker.list(h.token()).tools.find(tool => tool.name === "read");
    const result = h.broker.invoke(h.token(), { wireName: read.wireName, arguments: { path: "recompacted-owned-result.txt" } });
    let deliveries = 0, settled = false;
    const complete = h.broker.complete.bind(h.broker);
    h.broker.complete = (...args) => { deliveries += 1; return complete(...args); };
    void result.then(() => { settled = true; }, () => {});
    const coding = (await h.answerBrowser(call)).output[0], output = outputFor(coding, "Actual owned result behind refreshed native context");
    h.append(coding, output);
    const users = nativeV2Users(h.input());
    const compact = () => h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", stream: true,
      input: [...h.input(), { type: "compaction_trigger" }] }, { compactV2: true, headers: headers() });
    const first = await nativeV2Checkpoint(await compact());
    const developer = { type: "message", role: "developer", content: [{ type: "input_text", text: "Refreshed native developer authority" }] };
    const environment = { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>Refreshed current context</environment_context>" }] };
    h.input().splice(0, h.input().length, ...users, developer, environment, first);
    const second = await nativeV2Checkpoint(await compact());
    assert.deepEqual(decodeCompaction(second.encrypted_content).checkpoint.retained_tail, [developer, environment, coding, output]);
    assert.equal(settled, false); assert.equal(deliveries, 0);
    h.input().splice(0, h.input().length, ...users, developer, environment, second);
    const observation = (await h.request()).output[0];
    assert.deepEqual(await result, { content: [{ type: "text", text: output.output }] });
    assert.equal(deliveries, 1);
    const later = [{ role: "user", content: "Genuinely unsent later native request" },
      { type: "function_call", call_id: "different_native_action", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "different_native_action", output: "Actual different native result" },
      { role: "assistant", content: "Done." }];
    if (mode === "later native answer") h.append(...later);
    await h.completeAnswer(observation, "Done. Detailed report from the completed Web action.");
    const record = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(record.activeCompaction.acknowledgedTailHashes.length, 2);
    assert.equal(record.activeCompaction.acknowledgedTailHashes.every(hash => /^[a-f0-9]{64}$/u.test(hash)), true);
    assert.equal(JSON.stringify(record).includes(output.output), false);
    if (mode === "restart prefix-form record") { await h.restartRuntime(); h.loseKernel(); }
    h.newTurn(followupId, "New request after the recompacted coding turn");
    const next = await h.toObserve(), sent = sentTranscript(h);
    assert.deepEqual(sent.slice(0, 2), [{ role: "developer", content: developer.content[0].text }, { role: "user", content: environment.content[0].text }]);
    assert.equal(sent.some(item => item.call_id === coding.call_id), false);
    if (mode === "later native answer") {
      assert.deepEqual(sent.slice(2, 2 + later.length), later);
      assert.deepEqual(sent.at(-1), { role: "user", content: "New request after the recompacted coding turn" });
    } else assert.deepEqual(sent.slice(2), [{ role: "user", content: "New request after the recompacted coding turn" }]);
    await h.completeAnswer(next.call, "Follow-up completed with refreshed context");
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Later request remains a delta");
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Later request remains a delta" }]);
  });
});

test("native V2 compacts after a failed open and completed same-chat native turns without retaining stale controls", async t => {
  const h = harness(t), bootstrap = (await h.request()).output[0];
  const open = (await h.answerBrowser(bootstrap)).output[0], goto = h.browser.tab.goto;
  h.browser.tab.goto = async url => { await goto(url); h.browser.ui.normalHome = false; };
  const failure = await h.executeBrowser(open).then(() => assert.fail("Open must time out before home controls are ready."), error => error);
  assert.match(failure.message, /Empty normal ChatGPT home controls did not become ready within 10 seconds/u);
  h.append(open, outputFor(open, { isError: true, content: [{ type: "text", text: failure.message }] }));
  await assert.rejects(h.request(), { code: "web_browser_execution_failed" });
  assert.equal(h.runtime.status().activeTurns, 0);
  assert.equal(h.browser.ui.sends.length, 0);
  assert.equal(h.browser.ui.newTabs, 1);
  h.browser.tab.goto = goto; h.browser.ui.normalHome = true;

  const completeCodingTurn = async text => {
    const { call } = await h.toObserve(), token = h.token();
    const read = h.broker.list(token).tools.find(tool => tool.name === "read");
    const result = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "same-chat.txt" } });
    const coding = (await h.answerBrowser(call)).output[0], output = outputFor(coding, `Actual native result: ${text}`);
    h.append(coding, output);
    const observation = (await h.request()).output[0];
    assert.deepEqual(await result, { content: [{ type: "text", text: output.output }] });
    h.browser.ui.texts.push(text); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(observation), final = await h.answerBrowser(retain.output[0]);
    assert.deepEqual((await h.request()).output, final.output, "Completed native replies remain replayable.");
    h.append(final.output[0]);
  };
  h.newTurn(followupId, "Complete the baseline after home controls recover.");
  await completeCodingTurn("Completed baseline with an actual native result");
  const savedUrl = h.browser.ui.url, completedId = "33002233-4455-6677-8899-aabbccddeeff";
  h.newTurn(completedId, "Continue in the same saved chat.");
  await completeCodingTurn("Completed continuation with another actual native result");
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue in the same saved chat." }]);
  assert.equal(h.browser.ui.url, savedUrl);
  assert.equal(h.runtime.status().activeTurns, 0);
  const tail = [{ role: "user", content: "Unsent native material after completed coding" },
    { type: "function_call", call_id: "unsent_after_recovered_open", name: "read", arguments: '{ "path": "literal `$ 漢.txt" }' },
    { type: "function_call_output", call_id: "unsent_after_recovered_open", output: "Actual native tail remains exact" }];
  h.append(...tail);
  const original = structuredClone(h.input()), operations = h.observations.nativeOperations.length, sends = h.browser.ui.sends.length;
  const checkpoint = await nativeV2Checkpoint(await h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", stream: true,
    input: [...h.input(), { type: "compaction_trigger" }] }, { compactV2: true, headers: headers(completedId) }));
  assert.deepEqual(decodeCompaction(checkpoint.encrypted_content).checkpoint.retained_tail, tail);
  assert.equal(h.observations.nativeOperations.length, operations);
  assert.equal(h.browser.ui.sends.length, sends);
  const developer = { role: "developer", content: "Current native developer authority after compaction" };
  h.input().splice(0, h.input().length, ...nativeV2Users(original), developer, checkpoint);
  h.newTurn("44002233-4455-6677-8899-aabbccddeeff", "New request after recovered-open compaction.", { instructions: "Updated native instructions remain authoritative." });
  const next = await h.toObserve();
  assert.deepEqual(sentTranscript(h), [developer, ...tail, { role: "user", content: "New request after recovered-open compaction." }]);
  assert.ok(h.browser.ui.sends.at(-1).includes("Current Codex instructions:\nUpdated native instructions remain authoritative."));
  assert.equal(h.browser.ui.url, savedUrl);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.closes, 0);
  await h.completeAnswer(next.call, "Completed post-compaction request");
  h.newTurn("55002233-4455-6677-8899-aabbccddeeff", "Later request stays a delta.");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Later request stays a delta." }]);
});

test("native V2 rejects pending browser and discovery controls without retiring their ordinary continuation", async t => {
  for (const kind of ["browser", "discovery"]) await t.test(kind, async t => {
    const h = harness(t, kind === "discovery" ? { tools: [search, currentRead] } : {});
    const call = kind === "browser" ? (await h.toObserve()).call : (await h.request()).output[0];
    const operations = h.observations.nativeOperations.length;
    await assert.rejects(h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", stream: true,
      input: [...h.input(), { type: "compaction_trigger" }] }, { compactV2: true, headers: headers() }), { code: "web_compaction_control_pending" });
    assert.equal(h.observations.nativeOperations.length, operations);
    assert.equal(h.observations.watchers[0].closed, false);
    if (kind === "browser") {
      h.browser.ui.texts.push("Ordinary continuation remains authorized"); h.browser.ui.complete = true;
      const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]);
      assert.equal(final.output[0].content[0].text, "Ordinary continuation remains authorized");
    } else {
      h.append(call, outputFor(call, [nativeJs]));
      const bootstrap = (await h.request()).output[0];
      assert.equal(JSON.parse(bootstrap.arguments).title, "ChatGPT Web: bootstrap");
      assert.equal(h.browser.ui.newTabs, 0);
    }
  });
});

test("full established chats transfer a new native request before continue or Send without replaying old actions", async t => {
  for (const detection of ["continue", "send"]) await t.test(detection, async t => {
    const h = harness(t), { call } = await h.toObserve();
    await h.completeAnswer(call, "Already completed original request");
    h.newTurn(followupId, "A new request belongs in the successor.");
    if (detection === "continue") h.browser.ui.full = true;
    else {
      let response = await h.request();
      while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
      h.browser.ui.full = true;
    }
    await h.toObserve();
    assert.equal(h.browser.ui.rollovers, 1);
    assert.equal(h.browser.ui.sends.length, 2, "The new request is sent once, only after successor verification.");
    assert.deepEqual(sentTranscript(h), [
      { role: "user", content: "Read the current file using the declared tools." },
      { role: "assistant", content: "Already completed original request" },
      { role: "user", content: "A new request belongs in the successor." },
    ]);
  });
});

test("capacity after an answer or native action never automatically repeats that request", async t => {
  for (const [assistant, completed, codingAction] of [["Completed before capacity", true, true], ["A partial answer", false, false], ["", false, true]]) await t.test(`${completed ? "complete" : "incomplete"};coding ${codingAction}`, async t => {
    const h = harness(t), { call } = await h.toObserve();
    let observe = call;
    if (codingAction) {
      const token = h.token(), read = h.broker.list(token).tools.find(tool => tool.name === "read");
      const actual = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual-capacity-action.txt" } });
      const coding = (await h.answerBrowser(observe)).output[0];
      h.append(coding, outputFor(coding, "Actual completed native effect"));
      observe = (await h.request()).output[0]; await actual;
    }
    if (assistant) h.browser.ui.texts.push(assistant);
    h.browser.ui.complete = completed; h.browser.ui.full = true;
    if (completed) {
      const retain = await h.answerBrowser(observe), final = await h.answerBrowser(retain.output[0]);
      assert.equal(final.output[0].content[0].text, assistant); h.append(final.output[0]);
    } else await assert.rejects(h.answerBrowser(observe), { code: "web_conversation_full" });
    assert.equal(h.browser.ui.rollovers, 0);
    assert.equal(h.browser.ui.sends.length, 1);
    assert.equal(JSON.parse(readFileSync(h.stateFile, "utf8")).rolloverRequired, true);
    if (completed) {
      h.newTurn(followupId, "Proceed after the finished result.");
      await h.toObserve();
      assert.equal(h.browser.ui.rollovers, 1);
      assert.equal(sentTranscript(h).filter(item => item.type === "function_call_output").length, 1);
    }
  });
});

test("an interrupted rollover handoff reconciles execution and retains the empty successor's history requirement", async t => {
  for (const [executed, lostKernel] of [[true, false], [true, true], [false, false]]) await t.test(`executed ${executed};lost kernel ${lostKernel}`, async t => {
    const h = harness(t), { call } = await h.toObserve(); h.browser.ui.full = true;
    const rollover = (await h.answerBrowser(call)).output[0];
    if (executed) await h.executeBrowser(rollover);
    h.observations.watchers[0].onCancel();
    if (lostKernel) { await h.restartRuntime(); h.loseKernel(); }
    h.newTurn(followupId, "Continue after the successor was opened.");
    if (lostKernel) {
      const continuation = await fullContinuationAfterMiss(h, (await h.request()).output[0]);
      await assert.rejects(h.executeBrowser(continuation), /binding was lost/u);
      assert.equal(h.browser.ui.sends.length, 1);
    } else {
      await h.toObserve();
      assert.deepEqual(sentTranscript(h), [
        { role: "user", content: "Read the current file using the declared tools." },
        { role: "user", content: "Continue after the successor was opened." },
      ]);
      assert.equal(h.browser.ui.sends.length, 2);
    }
    assert.equal(h.browser.ui.rollovers, 1);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("a queued native tool invocation blocks automatic capacity transfer before any action is emitted", async t => {
  const h = harness(t), { call } = await h.toObserve(), token = h.token();
  const read = h.broker.list(token).tools.find(tool => tool.name === "read");
  const queued = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "must-not-execute.txt" } });
  const rejected = assert.rejects(queued, { code: "web_tools_pending" });
  h.browser.ui.full = true;
  await assert.rejects(h.answerBrowser(call), { code: "web_tools_pending" });
  await rejected;
  assert.equal(h.browser.ui.rollovers, 0);
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.input().some(item => item.namespace === "mcp__work"), false);
});

test("oversized successor history uses one bounded readable excerpt with explicit loss notice", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.append({ role: "user", content: `New unsent instruction ${"large native context ".repeat(30000)}` });
  h.browser.ui.full = true;
  await h.answerBrowser(call); await h.toObserve();
  assert.equal(h.browser.ui.rollovers, 1);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.ok(Buffer.byteLength(h.browser.ui.sends.at(-1), "utf8") < 512 * 1024);
  assert.match(sentTranscript(h)[0].content, /lossy continuation checkpoint/u);
  assert.match(sentTranscript(h)[0].content, /New unsent instruction/u);
});

test("successor capacity cannot create a retry loop in the same native turn", async t => {
  const h = harness(t), { call } = await h.toObserve(); h.browser.ui.full = true;
  await h.answerBrowser(call);
  const { call: successorObserve } = await h.toObserve(); h.browser.ui.full = true;
  await assert.rejects(h.answerBrowser(successorObserve), { code: "web_conversation_full" });
  assert.equal(h.browser.ui.rollovers, 1);
  assert.equal(h.browser.ui.sends.length, 2);
});

test("cancellation during startup stops before service creation or native browser execution", async t => {
  const h = harness(t, { cancelDuringWatch: true });
  await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  assert.deepEqual(h.observations.services, []);
  assert.deepEqual(h.observations.nativeOperations, []);
  assert.equal(h.observations.watchers[0].closed, true);
  assert.equal(h.browser.ui.sends.length, 0);
  assert.deepEqual(h.runtime.maintenanceState(), { activeTurns: 0, uncertainSends: 0, unresolvedActions: 0 });
  const admission = new RouterAdmission({ webRuntimeState: () => h.runtime.maintenanceState() });
  assert.equal((await admission.drain()).status, "drained");
});

test("browser executor discovery uses actual client search results and preserves their schemas", async t => {
  const h = harness(t, { tools: [search, currentRead] });
  const discovery = (await h.request()).output[0];
  assert.equal(discovery.type, "tool_search_call");
  assert.equal(discovery.execution, "client");
  assert.equal(h.browser.ui.newTabs, 0);
  const actualNative = structuredClone(nativeJs);
  actualNative.tools[0].parameters.properties.code.minLength = 1;
  h.append(discovery, outputFor(discovery, [actualNative]));
  const bootstrap = (await h.request()).output[0];
  assert.equal(bootstrap.namespace, "mcp__node_repl");
  assert.equal(bootstrap.name, "js");
  const { call } = await h.toObserve();
  assert.deepEqual(h.broker.list(h.token()).tools.find(tool => tool.namespace === "mcp__node_repl").parameters, actualNative.tools[0].parameters);
  await h.completeAnswer(call, "Discovered current native tools.");
  h.newTurn(followupId, "Use the same discovered native tools in this turn.");
  // The follow-up still declares only client search and the read tool. Its
  // paired native search history must recover the executor without invention.
  await h.toObserve();
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.observations.nativeOperations.at(-2), "continue");
  assert.deepEqual(h.broker.list(h.token()).tools.find(tool => tool.namespace === "mcp__node_repl").parameters, actualNative.tools[0].parameters);
});

test("an MCP call queued after the delivered batch is emitted after that batch completes", async t => {
  const h = harness(t);
  const { call: observe } = await h.toObserve();
  const token = h.token();
  const read = h.broker.list(token).tools.find(tool => tool.name === "read");
  const firstResult = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "first.txt" } });
  void firstResult.catch(() => {});
  const firstCall = (await h.answerBrowser(observe)).output[0];
  const secondResult = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "second.txt" } });
  void secondResult.catch(() => {});
  let secondResolved = false;
  void secondResult.then(() => { secondResolved = true; }, () => {});
  h.append(firstCall, outputFor(firstCall, "first actual result"));
  const secondBatch = await h.request();
  assert.deepEqual(await firstResult, { content: [{ type: "text", text: "first actual result" }] });
  assert.equal(secondResolved, false);
  assert.equal(secondBatch.output.length, 1);
  const secondCall = secondBatch.output[0];
  assert.equal(secondCall.namespace, "mcp__work");
  assert.equal(secondCall.name, "read");
  assert.deepEqual(JSON.parse(secondCall.arguments), { path: "second.txt" });
  assert.notEqual(secondCall.call_id, firstCall.call_id);
  h.append(secondCall, outputFor(secondCall, "second actual result"));
  const observation = await h.request();
  assert.deepEqual(await secondResult, { content: [{ type: "text", text: "second actual result" }] });
  assert.equal(JSON.parse(observation.output[0].arguments).title, "Wait for ChatGPT or its next Codex tool request");
  assert.equal(h.browser.ui.sends.length, 1);
});

test("a changed request without the pending native result is rejected instead of replaying an uncertain call", async t => {
  const h = harness(t);
  const initial = await h.request();
  assert.deepEqual((await h.request()).output, initial.output, "An identical transport replay remains safe.");
  h.append({ role: "user", content: "The request changed while its native call is still unresolved." });
  await assert.rejects(h.request(), error => error.code === "web_tool_result" && error.status === 409);
  assert.equal(h.browser.ui.newTabs, 0);
  assert.equal(h.browser.ui.sends.length, 0);
  assert.deepEqual(h.observations.nativeOperations, []);
});

test("mutating a consumed native coding result rejects the next advance before conversation retention", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const token = h.token();
  const read = h.broker.list(token).tools.find(tool => tool.name === "read");
  const actualResult = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual.txt" } });
  void actualResult.catch(() => {});
  const coding = (await h.answerBrowser(call)).output[0];
  const output = outputFor(coding, "the original native result");
  h.append(coding, output);
  const observe = (await h.request()).output[0];
  assert.deepEqual(await actualResult, { content: [{ type: "text", text: "the original native result" }] });
  output.output = "a substituted historical result";
  h.browser.ui.texts.push("Final text based on the substituted result."); h.browser.ui.complete = true;
  const observed = await h.executeBrowser(observe);
  h.append(observe, outputFor(observe, observed));
  await assert.rejects(h.request(), error => error.code === "web_tool_result" && error.status === 400);
  assert.equal(h.observations.nativeOperations.includes("retain"), false);
  assert.equal(h.observations.watchers[0].closed, true);
});

test("orphan native search output cannot grant a browser executor", async t => {
  const h = harness(t, { tools: [search, currentRead] });
  h.append({ type: "tool_search_output", call_id: "orphan_search", execution: "client", status: "completed", tools: [nativeJs] });
  const next = (await h.request()).output[0];
  assert.equal(next.type, "tool_search_call");
  assert.equal(h.browser.ui.newTabs, 0);
  assert.deepEqual(collectWebTools({ tools: [currentRead], input: [
    { type: "tool_search_output", call_id: "out_of_order", status: "completed", tools: [nativeJs] },
    { type: "tool_search_call", call_id: "out_of_order", execution: "client", arguments: { query: "native executor" } },
  ] }), [currentRead]);
});

test("tunnel startup failure closes acquired services and the native cancellation watcher", async t => {
  const error = new Error("The owned tunnel failed to become ready.");
  const h = harness(t, { tunnelReadiness: () => Promise.reject(error) });
  await assert.rejects(h.request(), error);
  assert.deepEqual(h.observations.services, ["mcp", "tunnel", "tunnel-closed", "mcp-closed"]);
  assert.equal(h.observations.watchers[0].closed, true);
  assert.equal(h.browser.ui.newTabs, 0);
  assert.equal(h.runtime.status().activeTurns, 0);
});

test("eager starts and native request preparation share one pending acquisition and preserve the configuration fence", async t => {
  const { promise: readiness, resolve: ready } = Promise.withResolvers();
  const { promise: tunnelStarted, resolve: started } = Promise.withResolvers();
  t.after(ready);
  const h = harness(t, { tunnelReadiness: () => { started(); return readiness; } });
  const first = h.runtime.start(h.settings), second = h.runtime.start(h.settings), request = h.request();
  await tunnelStarted;
  assert.equal(h.runtime.status().started, false);
  await assert.rejects(h.runtime.start({ ...h.settings, mcpPort: 40124 }), /Restart Router/u);
  ready();
  await Promise.all([first, second, request]);
  assert.equal(h.runtime.status().started, true);
  assert.deepEqual(h.observations.services, ["mcp", "tunnel"]);
  assert.equal(h.observations.watchers.length, 1);
});

test("successful startup rollback preserves the original error and permits another same-configuration acquisition", async t => {
  const original = Object.assign(new Error("Synthetic readiness failed."), { code: "web_tunnel_not_ready" });
  let attempts = 0;
  const h = harness(t, { tunnelReadiness: () => ++attempts === 1 ? Promise.reject(original) : Promise.resolve() });
  await assert.rejects(h.runtime.start(h.settings), error => error === original);
  assert.equal(h.runtime.status().started, false);
  await assert.rejects(h.runtime.start({ ...h.settings, tunnel: { ...h.settings.tunnel, id: "different" } }), /Restart Router/u);
  await h.runtime.start(h.settings);
  await h.request();
  assert.deepEqual(h.observations.services, ["mcp", "tunnel", "tunnel-closed", "mcp-closed", "mcp", "tunnel"]);
  await h.runtime.close();
  assert.deepEqual(h.observations.services.slice(-2), ["tunnel-closed", "mcp-closed"]);
});

test("a synchronous MCP acquisition failure releases its empty slot before retry", async t => {
  const original = new Error("Synthetic MCP start failure.");
  let starts = 0, closes = 0;
  const runtime = createInAppWebRuntime({ stateDir,
    startMcp: () => {
      if (++starts === 1) throw original;
      return { url: "http://127.0.0.1:40123/mcp", status: () => ({}), close: async () => { closes += 1; } };
    },
    startTunnel: async () => ({ ready: Promise.resolve(), status: () => ({ healthy: true }), close: async () => {} }),
  });
  t.after(() => runtime.close());
  const settings = { browser: {}, tunnel: {} };
  await assert.rejects(runtime.start(settings), error => error === original);
  await runtime.start(settings);
  await runtime.close();
  assert.deepEqual({ starts, closes }, { starts: 2, closes: 1 });
});

test("failed startup release attempts every owner, keeps bounded errors and blocks duplicate acquisition", async t => {
  for (const [tunnelCode, mcpFails, expected] of [
    ["web_tunnel_cleanup_failed", false, "web_tunnel_cleanup_failed"],
    ["web_tunnel_stop_failed", false, "web_tunnel_stop_failed"],
    [undefined, true, "web_mcp_close_failed"],
    ["unknown-private-code", true, "web_service_cleanup_failed"],
  ]) await t.test(`${tunnelCode ?? "mcp"}, MCP failure ${mcpFails}`, async t => {
    const privateMarker = "synthetic-private-error-details";
    const h = harness(t, {
      tunnelReadiness: () => Promise.reject(Object.assign(new Error(privateMarker), { code: tunnelCode ? "web_tunnel_not_ready" : privateMarker })),
      tunnelClosure: async () => { if (tunnelCode) throw Object.assign(new Error(privateMarker), { code: tunnelCode, cause: privateMarker }); },
      mcpClosure: async () => { if (mcpFails) throw Object.assign(new Error(privateMarker), { code: "private-mcp-code", cause: privateMarker }); },
      expectedCloseCode: expected,
    });
    let retained;
    await assert.rejects(h.request(), error => {
      retained = error;
      assert.equal(error.code, expected);
      assert.equal(error.startupCode, tunnelCode ? "web_tunnel_not_ready" : "web_service_start_failed");
      assert.deepEqual(error.cleanupCodes, [
        ...(tunnelCode ? [{ owner: "tunnel", code: tunnelCode === "web_tunnel_cleanup_failed" ? tunnelCode : "web_tunnel_stop_failed" }] : []),
        ...(mcpFails ? [{ owner: "mcp", code: "web_mcp_close_failed" }] : []),
      ]);
      assert.equal(error.cause, undefined);
      assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(privateMarker), false);
      assert.equal(JSON.stringify(error).includes("unknown-private-code"), false);
      return true;
    });
    assert.deepEqual(h.observations.services, ["mcp", "tunnel", "tunnel-closed", "mcp-closed"]);
    await assert.rejects(h.runtime.start(h.settings), error => error === retained);
    const closing = h.runtime.close();
    assert.equal(h.runtime.close(), closing);
    await assert.rejects(closing, error => error === retained);
    await assert.rejects(h.runtime.close(), error => error === retained);
    assert.deepEqual(h.observations.services, ["mcp", "tunnel", "tunnel-closed", "mcp-closed"]);
    assert.equal(h.observations.watchers[0].closed, true);
  });
});

test("a rejected tunnel rollback before returning its handle retains failed-acquisition custody", async () => {
  let mcpStarts = 0, mcpCloses = 0, tunnelStarts = 0;
  const runtime = createInAppWebRuntime({ stateDir,
    startMcp: async () => { mcpStarts += 1; return { url: "http://127.0.0.1:40123/mcp", close: async () => { mcpCloses += 1; } }; },
    startTunnel: async () => { tunnelStarts += 1; throw Object.assign(new Error("Synthetic cleanup failure."), { code: "web_tunnel_cleanup_failed" }); },
  });
  const settings = { browser: {}, tunnel: {} };
  for (let attempt = 0; attempt < 2; attempt += 1) await assert.rejects(runtime.start(settings), { code: "web_tunnel_cleanup_failed" });
  await assert.rejects(runtime.close(), { code: "web_tunnel_cleanup_failed" });
  assert.deepEqual({ mcpStarts, mcpCloses, tunnelStarts }, { mcpStarts: 1, mcpCloses: 1, tunnelStarts: 1 });
});

test("a tunnel close failure still stops the acquired real loopback MCP listener and shutdown retains the failure", async t => {
  let actualMcp, mcpCloses = 0;
  t.after(async () => { await actualMcp?.close(); });
  const h = harness(t, {
    mcpFactory: async options => {
      actualMcp = await startWebMcp(options);
      assert.equal(actualMcp.status().listening, true);
      return { ...actualMcp, close: async () => { mcpCloses += 1; await actualMcp.close(); } };
    },
    tunnelReadiness: () => Promise.reject(Object.assign(new Error("Synthetic not-ready failure."), { code: "web_tunnel_not_ready" })),
    tunnelClosure: async () => { throw Object.assign(new Error("Synthetic cleanup failure."), { code: "web_tunnel_cleanup_failed" }); },
    expectedCloseCode: "web_tunnel_cleanup_failed",
  });
  await assert.rejects(h.runtime.start(h.settings), { code: "web_tunnel_cleanup_failed" });
  assert.equal(actualMcp.status().listening, false);
  await assert.rejects(h.runtime.start(h.settings), { code: "web_tunnel_cleanup_failed" });
  await assert.rejects(h.runtime.close(), { code: "web_tunnel_cleanup_failed" });
  assert.equal(actualMcp.status().listening, false);
  assert.equal(mcpCloses, 1);
  assert.deepEqual(h.observations.services, ["mcp", "tunnel", "tunnel-closed"]);
});

test("watcher shutdown failure still releases both services after checkpoint settlement", { timeout: 5_000 }, async t => {
  const { promise: writeStarted, resolve: started } = Promise.withResolvers();
  const { promise: writeAllowed, resolve: release } = Promise.withResolvers();
  t.after(release);
  const original = Object.assign(new Error("Synthetic watcher close failure."), { code: "synthetic_watcher_close_failed" });
  let writes = 0;
  const h = harness(t, { watcherClosure: async () => { throw original; }, expectedCloseCode: original.code,
    storage: { ...syntheticStorage, writeState: async (target, value) => {
      if (++writes > 1) { started(); await writeAllowed; }
      await syntheticStorage.writeState(target, value);
    } },
  });
  const initial = await h.request();
  const advancing = assert.rejects(h.answerBrowser(initial.output[0]), { code: "web_turn_cancelled" });
  await writeStarted;
  const closing = assert.rejects(h.runtime.close(), error => error === original);
  assert.deepEqual(h.observations.services, ["mcp", "tunnel"], "Checkpoint custody remains until its write settles, including after watcher failure.");
  release();
  await Promise.all([advancing, closing]);
  assert.deepEqual(h.observations.services, ["mcp", "tunnel", "tunnel-closed", "mcp-closed"]);
  assert.equal(h.observations.watchers[0].closed, true);
});

test("a failed private checkpoint write still closes and awaits owned services", async () => {
  const failedState = path.join(stateDir, "failed-checkpoint");
  const closed = [];
  const runtime = createInAppWebRuntime({ stateDir: failedState,
    startMcp: async () => ({ url: "http://127.0.0.1:40123/mcp", status: () => ({ healthy: true }), close: async () => { closed.push("mcp"); } }),
    startTunnel: async () => {
      mkdirSync(path.join(failedState, "web-in-app", "conversations", `${threadId}.json`), { recursive: true });
      return { ready: Promise.resolve(), status: () => ({ healthy: true }), close: async () => { await Promise.resolve(); closed.push("tunnel"); } };
    },
    watchCancellation: () => ({ ready: Promise.resolve(), close: async () => {} }),
  });
  await assert.rejects(runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", reasoning: { effort: "low" }, tools: [nativeJs], input: "Current native input" },
    { headers: headers(), settings: { browser: { runtimeModule: "data:text/javascript,export{}" }, tunnel: { executable: "test", id: "test" } } }));
  await assert.rejects(runtime.close());
  assert.deepEqual(closed, ["tunnel", "mcp"]);
});

test("shutdown aborts pending tunnel startup and releases services before returning", async t => {
  const { promise: tunnelStarted, resolve: started } = Promise.withResolvers();
  const h = harness(t, { tunnelReadiness: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Owned tunnel startup stopped.", "AbortError")), { once: true });
    started();
  }) });
  const pending = h.request();
  const rejected = assert.rejects(pending, /startup stopped/);
  await tunnelStarted;
  await h.runtime.close();
  await rejected;
  assert.deepEqual(h.observations.services, ["mcp", "tunnel", "tunnel-closed", "mcp-closed"]);
  assert.equal(h.observations.watchers[0].closed, true);
  assert.equal(h.browser.ui.newTabs, 0);
  await assert.rejects(h.request(), /runtime is stopping/);
});

test("shutdown before scheduled eager acquisition prevents a new owner from starting", async t => {
  const h = harness(t);
  const startup = assert.rejects(h.runtime.start(h.settings), /runtime is stopping/u);
  await Promise.all([startup, h.runtime.close()]);
  assert.deepEqual(h.observations.services, []);
  assert.equal(h.runtime.status().started, false);
});

test("missing or conflicting native executor declarations fail without fabricated browser capabilities", async t => {
  const absent = harness(t, { tools: [currentRead] });
  await assert.rejects(absent.request(), { code: "web_browser_capability_gap" });
  assert.equal(absent.browser.ui.newTabs, 0);
  assert.deepEqual(absent.observations.services, []);
  const conflict = structuredClone(nativeJs);
  conflict.tools[0].parameters.properties.code.maxLength = 5;
  assert.throws(() => collectWebTools({ tools: [nativeJs], input: [{ type: "additional_tools", tools: [conflict] }] }), { code: "web_tool_declaration" });
  const additional = collectWebTools({ tools: [currentRead], input: [{ type: "additional_tools", tools: [nativeJs] }] });
  assert.deepEqual(additional, [currentRead, nativeJs]);

  const wrongDiscovery = harness(t, { tools: [search, currentRead] });
  const call = (await wrongDiscovery.request()).output[0];
  wrongDiscovery.append(call, outputFor(call, [{ type: "function", name: "mcp__node_repl__js", parameters: nativeJs.tools[0].parameters }]));
  await assert.rejects(wrongDiscovery.request(), { code: "web_browser_capability_gap" });
  assert.equal(wrongDiscovery.browser.ui.newTabs, 0);
});

test("native ownership uses current turn metadata ahead of stale headers and cache affinity", () => {
  const payload = { client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata()) } };
  assert.deepEqual(webTurnIdentity(payload, headers()), { threadId, turnId });
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": threadId, "x-codex-turn-id": turnId }), { code: "web_turn_identity" });
  assert.deepEqual(webTurnIdentity(payload, { ...headers(followupId), "session-id": "cache-affinity", session_id: followupId }), { threadId, turnId });
  assert.deepEqual(webTurnIdentity(payload, { "x-codex-turn-metadata": "stale-prewarm", "x-codex-thread-id": followupId }), { threadId, turnId });
  assert.deepEqual(webTurnIdentity({}, { ...headers(), "session-id": "cache-affinity" }), { threadId, turnId });
  assert.throws(() => webTurnIdentity({ client_metadata: { "x-codex-turn-metadata": "broken-current" } }, headers()), /Invalid native Web turn metadata/);
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": threadId }), /canonical native thread and turn/);
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": "some-open-task", "x-codex-turn-id": turnId }), /canonical native thread and turn/);
});
