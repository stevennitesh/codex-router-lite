import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-web-runtime-"));
process.env.CODEX_HOME = path.join(stateDir, "codex");
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
mkdirSync(process.env.CODEX_HOME);
after(() => rmSync(stateDir, { recursive: true, force: true }));

const { createInAppWebRuntime, collectWebTools, webTurnIdentity } = await import("../src/web-runtime.mjs");
const { createWebToolBroker } = await import("../src/web-tools.mjs");
const { parseBrowserOutput } = await import("../src/web-browser.mjs");

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

function fakeBrowser() {
  const ui = { power: 2, menu: false, chip: false, stop: false, texts: [], complete: false, sends: [], marks: 0, newTabs: 0, closes: 0, present: true, navigations: 0, reacquired: [], stopMarks: [],
    temporaryControls: true, saveChat: false, url: "https://chatgpt.com/?temporary-chat=true" };
  const locator = (kind, name) => ({
    getByRole: (childKind, options) => locator(childKind, options.name), locator: selector => locator("selector", selector),
    filter({ hasText }) {
      assert.equal(kind, "selector");
      assert.equal(name, '[role="menuitemradio"]');
      return locator("family-text", hasText);
    },
    async count() { return kind === "menuitemradio" ? 0 : 1; },
    async isVisible() {
      if (kind === "menu") return ui.menu;
      if (name === "Stop") return ui.stop;
      if (name === "Regenerate response") return ui.complete;
      if (name === "Temporary chat" || name === "Turn off temporary chat") return ui.temporaryControls;
      if (name === "Save chat") return ui.saveChat;
      if (kind === "selector" && name.startsWith("span[app-mention")) return ui.chip;
      return true;
    },
    async click() {
      if (name === "Select ChatGPT model") ui.menu = !ui.menu;
      else if (name === "Current Codex Tools Workspace tools") ui.chip = true;
      else if (name === "Stop") { ui.stopMarks.push(ui.marks); ui.stop = false; }
      else if (name === "Send") {
        ui.sends.push(ui.composer); ui.composer = ""; ui.complete = false;
        ui.temporaryControls = false; ui.saveChat = true;
        ui.url = "https://chatgpt.com/c/owned-conversation?temporary-chat=true";
      }
    },
    async getAttribute(attribute) { return { "aria-checked": "true", "aria-valuenow": String(ui.power), "aria-valuemin": "0", "aria-valuemax": "4" }[attribute] ?? null; },
    async textContent() { return name; }, async innerText() { return ui.power === 0 ? "GPT-6 Instant" : "GPT-6 Thinking"; },
    async isEnabled() { return true; },
    async press(key) { if (name === "Power") { if (key === "Escape") ui.menu = false; else ui.power += key === "ArrowLeft" ? -1 : 1; } },
    async type(text) { ui.composer = (ui.composer ?? "") + text; },
    async waitFor({ state }) { assert.equal(await this.isVisible(), state === "visible"); },
    async allTextContents() { return name === '[role="status"]' ? (ui.complete ? ["Response complete"] : []) : [...ui.texts]; },
    async evaluateAll(callback) {
      assert.equal(name, '[data-markdown-text-style="assistant-message"]');
      return callback(ui.texts.map(value => ({ nodeType: 1, tagName: "DIV", getAttribute: () => null,
        childNodes: [{ nodeType: 3, textContent: value }] })));
    },
  });
  const tab = { id: "owned-temporary-tab", goto: async url => { ui.navigations += 1; ui.url = url; }, url: async () => ui.url,
    playwright: { getByRole: (kind, options) => locator(kind, options.name), locator: selector => locator("selector", selector) },
    markHandoff: async () => { ui.marks += 1; }, close: async () => { ui.closes += 1; ui.present = false; } };
  const browser = { browserId: "same-session-iab", documentation: async () => "Current public browser runtime documentation",
    tabs: { list: async () => ui.present ? [{ id: tab.id, url: await tab.url() }] : [],
      get: async tabId => { ui.reacquired.push(tabId); assert.equal(tabId, tab.id); return tab; },
      new: async () => { ui.newTabs += 1; return tab; } } };
  const agent = { browsers: { list: async () => [{ type: "iab", id: browser.browserId, metadata: { codexSessionId: threadId } }],
    get: async id => { assert.equal(id, browser.browserId); return browser; } } };
  return { ui, agent, browser, tab };
}

let fixtureNumber = 0;
function harness(t, { tools = [nativeJs, currentRead], toolChoice = "auto", cancelDuringWatch = false,
  tunnelReadiness = () => Promise.resolve() } = {}) {
  const browser = fakeBrowser();
  const key = `router-web-runtime-test-${++fixtureNumber}`;
  globalThis[Symbol.for(key)] = browser.agent;
  const runtimeModule = `data:text/javascript,${encodeURIComponent(`export async function setupBrowserRuntime(){ return globalThis[Symbol.for(${JSON.stringify(key)})]; }`)}`;
  const broker = createWebToolBroker({ invocationTimeoutMs: 5000 });
  const observations = { watchers: [], services: [], nativeOperations: [], bindings: [], fetchCalls: 0 };
  const settings = { browser: { runtimeModule, pluginName: "Current Codex Tools", pluginAppId: "asdk_current_tools",
    pluginSelectionButtonName: "Current Codex Tools Workspace tools", observeIterations: 1, observeDelayMs: 0 },
  tunnel: { executable: "test-tunnel", id: "test-owned-tunnel" }, mcpPort: 0 };
  const runtime = createInAppWebRuntime({ broker, stateDir,
    startMcp: async options => {
      assert.equal(options.broker, broker);
      observations.services.push("mcp");
      return { url: "http://127.0.0.1:40123/mcp", status: () => ({ healthy: true }), close: async () => { observations.services.push("mcp-closed"); } };
    },
    startTunnel: async options => {
      observations.services.push("tunnel");
      return { ready: tunnelReadiness(options), status: () => ({ healthy: true }), close: async () => { observations.services.push("tunnel-closed"); } };
    },
    watchCancellation: options => {
      const watcher = { ...options, closed: false };
      observations.watchers.push(watcher);
      return { ready: Promise.resolve().then(() => { if (cancelDuringWatch) options.onCancel(); }), close: async () => { watcher.closed = true; } };
    },
  });
  t.after(async () => { await runtime.close(); delete globalThis[Symbol.for(key)]; });
  let nativeContext = {};
  let payload = { model: "chatgpt-web/gpt-6-sol-instant", reasoning: { effort: "low" }, stream: false,
    tools: structuredClone(tools), tool_choice: toolChoice, input: [{ role: "user", content: "Read the current file using the declared tools." }] };
  let currentTurn = turnId;
  const request = async (override = {}) => {
    const response = await runtime.request({ ...payload, ...override }, { headers: headers(currentTurn), settings });
    return response.json();
  };
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
  const toObserve = async () => {
    let response = await request();
    for (let round = 0; round < 8; round += 1) {
      const call = response.output[0];
      if (JSON.parse(call.arguments).title === "Wait for ChatGPT or its next Codex tool request") return { response, call };
      response = await answerBrowser(call);
    }
    throw new Error("Browser orchestration did not reach observation.");
  };
  return { runtime, broker, browser, observations, settings, request, executeBrowser, answerBrowser, toObserve,
    token: () => {
      const token = browser.ui.sends.at(-1)?.match(/Use turn_token (web_turn_[a-f0-9]{32}) unchanged/u)?.[1];
      assert.ok(token, "The actual browser prompt supplies its current native tool turn token.");
      return token;
    }, input: () => payload.input,
    browserOwner: () => nativeContext.routerWebActiveTurns?.get(threadId),
    replaceBrowserOwner: owner => nativeContext.routerWebActiveTurns = new Map([[threadId, owner]]),
    append: (...items) => payload.input.push(...items),
    loseKernel: () => { nativeContext = {}; },
    newTurn: (turn, userText, overrides = {}) => { currentTurn = turn; payload = { ...payload, ...overrides, input: [...payload.input, { role: "user", content: userText }] }; },
  };
}

const sentTranscript = (h, index = -1) => JSON.parse(h.browser.ui.sends.at(index).split("Conversation transcript:\n")[1]);

test("a queued MCP invocation routes after UI-only observation and resolves only from paired native output", async t => {
  const h = harness(t, { toolChoice: "required" });
  const { call: observe } = await h.toObserve();
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.marks, 1);
  h.browser.ui.stop = true;
  const token = h.token();
  const read = h.broker.list(token).find(tool => tool.name === "read");
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
  assert.equal(h.browser.ui.marks, 1);
  const final = await h.answerBrowser(retain.output[0]);
  assert.equal(final.output[0].type, "message");
  assert.equal(final.output[0].content[0].text, h.browser.ui.texts[0]);
  assert.equal(h.browser.ui.marks, 2);
  assert.equal(h.observations.watchers[0].closed, true);
  assert.deepEqual(h.observations.nativeOperations, ["bootstrap", "open", "model", "attach", "send", "observe", "observe", "retain"]);
  assert.equal(h.runtime.status().activeTurns, 0);
});

test("native request replay preserves call IDs and follow-up NEW turns reuse the retained binding and tab", async t => {
  const h = harness(t);
  const initial = await h.request();
  const replay = await h.request();
  assert.deepEqual(replay.output, initial.output);
  const { call } = await h.toObserve();
  assert.equal((await h.request()).output[0].call_id, call.call_id);
  await assert.rejects(h.request({ reasoning: { effort: "high" } }), /cannot change model or effort/u);
  assert.equal(h.browser.ui.sends.length, 1);
  h.browser.ui.texts.push("First answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(call);
  const final = await h.answerBrowser(retain.output[0]);
  h.append(final.output[0]);
  h.loseKernel();
  h.newTurn(followupId, "Follow up in this same chat.", { model: "chatgpt-web/gpt-5.6-sol", reasoning: { effort: "high" } });
  const { call: nextObserve } = await h.toObserve();
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.equal(h.observations.nativeOperations.filter(operation => operation === "continue").length, 1);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Follow up in this same chat." }]);
  assert.equal(h.browser.ui.power, 2);
  assert.equal(h.runtime.status().conversations, 1, "Changing model family and effort retains the native session's chat.");
  assert.deepEqual(h.browser.ui.reacquired, ["owned-temporary-tab"]);
  assert.equal(h.browser.ui.navigations, 1);
  const pending = await h.answerBrowser(nextObserve);
  assert.equal(pending.output[0].type, "function_call");
  assert.equal(h.browser.ui.marks, 3, "The follow-up is retained before Send without completing its answer.");
  h.browser.ui.texts.push("Follow-up answer"); h.browser.ui.complete = true;
  const nextRetain = await h.answerBrowser(pending.output[0]);
  const nextFinal = await h.answerBrowser(nextRetain.output[0]);
  assert.equal(nextFinal.output[0].content[0].text, "Follow-up answer");
  assert.equal(h.browser.ui.marks, 4);
  assert.equal(h.observations.watchers.length, 2);
});

test("native cancellation retires the real broker while the next turn retains its chat and historical coding results", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const token = h.token();
  const read = h.broker.list(token).find(tool => tool.name === "read");
  const pending = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual.txt" } });
  const rejection = assert.rejects(pending, { code: "web_turn_cancelled" });
  h.browser.ui.texts.push("Reading the actual requested file."); h.browser.ui.stop = true;
  const coding = (await h.answerBrowser(call)).output[0];
  h.observations.watchers[0].onCancel();
  await rejection;
  assert.throws(() => h.broker.list(token), { code: "web_tool_turn_closed" });
  h.append(coding, outputFor(coding, "too late"));
  await assert.rejects(h.request(), { code: "web_turn_cancelled" });
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
  assert.equal(h.browser.ui.marks, 2);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.closes, 0);
  assert.deepEqual(h.browser.ui.reacquired, ["owned-temporary-tab"]);
  assert.equal(h.browser.ui.navigations, 1);
  assert.deepEqual(h.browser.ui.stopMarks, [2], "Recovery renews the current turn's tab retention before Stop.");
});

test("lost JS state rebinds only the observed owned tab and reconciles its newest partial before the next delta", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const oldToken = h.token();
  h.browser.ui.texts.push("Observed partial"); h.browser.ui.stop = true;
  await h.answerBrowser(call);
  h.observations.watchers[0].onCancel();
  h.loseKernel();
  h.browser.ui.texts[0] = "Observed partial continued before Stop";
  h.append({ role: "assistant", content: "Observed partial continued" });
  h.newTurn(followupId, "Continue in this exact observed conversation.");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Continue in this exact observed conversation." }]);
  assert.deepEqual(h.browser.ui.reacquired, ["owned-temporary-tab"]);
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.navigations, 1);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.equal(h.browserOwner().turnId, followupId);
  assert.deepEqual(h.browser.ui.stopMarks, [2]);
  assert.throws(() => h.broker.list(oldToken), { code: "web_tool_turn_closed" });
});

test("lost-state recovery rejects changed browser, tab, URL, reply or active ownership without Stop or replay", async t => {
  for (const [label, mutate] of [
    ["foreign browser", h => { h.browser.agent.browsers.list = async () => [{ type: "iab", id: "foreign-browser", metadata: { codexSessionId: threadId } }]; }],
    ["foreign session", h => { h.browser.agent.browsers.list = async () => [{ type: "iab", id: "same-session-iab", metadata: { codexSessionId: followupId } }]; }],
    ["missing tab", h => { h.browser.browser.tabs.list = async () => [{ id: "foreign-tab", url: h.browser.ui.url }]; }],
    ["different tab handle", h => { h.browser.browser.tabs.get = async () => ({ ...h.browser.tab, id: "foreign-tab" }); }],
    ["different URL", h => { h.browser.ui.url = "https://chatgpt.com/c/another-conversation?temporary-chat=true"; }],
    ["changed partial", h => { h.browser.ui.texts[0] = "A different assistant reply"; }],
    ["extra reply", h => { h.browser.ui.texts.push("Unexpected next assistant turn"); }],
    ["permanent chat UI", h => { h.browser.ui.saveChat = false; }],
    ["surviving foreign owner", h => { h.replaceBrowserOwner({ turnId: followupId, state: {} }); }],
  ]) await t.test(label, async t => {
    const h = harness(t);
    const { call } = await h.toObserve();
    h.browser.ui.texts.push("Known observed partial"); h.browser.ui.stop = true;
    await h.answerBrowser(call);
    h.observations.watchers[0].onCancel(); h.loseKernel();
    mutate(h);
    h.newTurn(followupId, "Recover only with unchanged observed evidence.");
    const continuation = (await h.request()).output[0];
    await assert.rejects(h.executeBrowser(continuation), /recovery|observed|active browser/iu);
    assert.equal(h.browser.ui.stop, true);
    assert.deepEqual(h.browser.ui.stopMarks, []);
    assert.equal(h.browser.ui.marks, 1);
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
  assert.equal(h.browser.ui.marks, 3);
  assert.equal(h.browser.ui.sends.length, 2);
  assert.equal(new Set(h.observations.bindings).size, 1);
});

test("interrupted native handoffs preserve every exact possible browser owner until a result confirms ownership", async t => {
  for (const executed of [[false], [true], [false, true, false], [true, false, true]]) await t.test(executed.join(","), async t => {
    const h = harness(t);
    const { call } = await h.toObserve();
    h.browser.ui.texts.push("Completed first answer"); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(call);
    h.append((await h.answerBrowser(retain.output[0])).output[0]);
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
    assert.equal(h.browser.ui.marks, 2);
  });
});

test("cancellation before Send preserves unsent native input in the same owned chat", async t => {
  const h = harness(t);
  const bootstrap = (await h.request()).output[0];
  const open = (await h.answerBrowser(bootstrap)).output[0];
  await h.answerBrowser(open);
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

test("cancelled coding calls with no result remain historical unknown outcomes and are not re-emitted", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const token = h.token(), read = h.broker.list(token).find(tool => tool.name === "read");
  const pending = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "unknown.txt" } });
  const rejection = assert.rejects(pending, { code: "web_turn_cancelled" });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding);
  h.observations.watchers[0].onCancel();
  await rejection;
  h.newTurn(followupId, "Continue using only confirmed results.");
  const next = await h.toObserve();
  assert.notEqual(next.call.call_id, coding.call_id);
  assert.equal(next.call.namespace, "mcp__node_repl");
  assert.equal(sentTranscript(h)[0].call_id, coding.call_id);
  assert.equal(sentTranscript(h).some(item => item.type === "function_call_output"), false);
  assert.match(h.browser.ui.sends.at(-1), /an unpaired call has an unknown outcome/u);
  assert.throws(() => h.broker.list(token), { code: "web_tool_turn_closed" });
});

test("an unconfirmed Send is never replayed after cancellation even if its click took effect", async t => {
  for (const [executed, lostKernel] of [[false, false], [true, false], [true, true]]) await t.test(`${executed ? "click took effect" : "execution unknown"}; kernel lost ${lostKernel}`, async t => {
    const h = harness(t);
    let response = await h.request();
    while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
    if (executed) await h.executeBrowser(response.output[0]);
    h.observations.watchers[0].onCancel();
    if (lostKernel) h.loseKernel();
    h.newTurn(followupId, "Resume without duplicating the uncertain Send.");
    const continuation = (await h.request()).output[0];
    assert.equal(JSON.parse(continuation.arguments).title, "ChatGPT Web: continue");
    await assert.rejects(h.answerBrowser(continuation), lostKernel ? /binding was lost/u : { code: "web_send_uncertain" });
    assert.equal(h.browser.ui.sends.length, executed ? 1 : 0);
    assert.equal(h.browser.ui.newTabs, 1);
    assert.equal(h.browser.ui.closes, 0);
  });
});

test("a lost interrupted binding without a successful observed reply fails without replacement or Send", async t => {
  const h = harness(t);
  await h.toObserve();
  h.observations.watchers[0].onCancel();
  h.loseKernel();
  h.newTurn(followupId, "Continue in the same chat.");
  const continuation = (await h.request()).output[0];
  assert.equal(JSON.parse(continuation.arguments).title, "ChatGPT Web: continue");
  await assert.rejects(h.executeBrowser(continuation), /binding was lost/u);
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.newTabs, 1);
});

test("a lost binding after unacknowledged open cannot recover or open a replacement", async t => {
  const h = harness(t);
  const bootstrap = (await h.request()).output[0];
  const open = (await h.answerBrowser(bootstrap)).output[0];
  await h.executeBrowser(open);
  h.observations.watchers[0].onCancel(); h.loseKernel();
  h.newTurn(followupId, "An unacknowledged open is still uncertain.");
  const continuation = (await h.request()).output[0];
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
  const token = h.token(), read = h.broker.list(token).find(tool => tool.name === "read");
  const result = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding, outputFor(coding, "Actual file contents retained as native evidence."));
  const observe = (await h.request()).output[0];
  assert.deepEqual(await result, { content: [{ type: "text", text: "Actual file contents retained as native evidence." }] });
  h.browser.ui.texts.push("First answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(observe);
  const final = await h.answerBrowser(retain.output[0]);
  h.append(final.output[0]);
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
  assert.deepEqual(h.broker.list(h.token()).find(tool => tool.name === "read").parameters, currentRead.tools[0].parameters);
  h.observations.watchers.at(-1).onCancel();
  const opaqueTurn = "33002233-4455-6677-8899-aabbccddeeff";
  h.input().splice(0, h.input().length, { type: "compaction", encrypted_content: "opaque-native-checkpoint" });
  h.newTurn(opaqueTurn, "An opaque checkpoint remains unsupported.");
  await assert.rejects(h.request(), { code: "encrypted_v2_unsupported" });
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.browser.ui.sends.length, 2);
});

test("cancellation during startup stops before service creation or native browser execution", async t => {
  const h = harness(t, { cancelDuringWatch: true });
  await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  assert.deepEqual(h.observations.services, []);
  assert.deepEqual(h.observations.nativeOperations, []);
  assert.equal(h.observations.watchers[0].closed, true);
  assert.equal(h.browser.ui.sends.length, 0);
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
  assert.deepEqual(h.broker.list(h.token()).find(tool => tool.namespace === "mcp__node_repl").parameters, actualNative.tools[0].parameters);
  h.browser.ui.texts.push("Discovered current native tools."); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(call);
  const final = await h.answerBrowser(retain.output[0]);
  h.append(final.output[0]);
  h.newTurn(followupId, "Use the same discovered native tools in this turn.");
  // The follow-up still declares only client search and the read tool. Its
  // paired native search history must recover the executor without invention.
  await h.toObserve();
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(h.observations.nativeOperations.at(-4), "continue");
  assert.deepEqual(h.broker.list(h.token()).find(tool => tool.namespace === "mcp__node_repl").parameters, actualNative.tools[0].parameters);
});

test("an MCP call queued after the delivered batch is emitted after that batch completes", async t => {
  const h = harness(t);
  const { call: observe } = await h.toObserve();
  const token = h.token();
  const read = h.broker.list(token).find(tool => tool.name === "read");
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
  const read = h.broker.list(token).find(tool => tool.name === "read");
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
  assert.equal(h.browser.ui.marks, 1);
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

test("shutdown aborts pending tunnel startup and releases services before returning", async t => {
  let started;
  const tunnelStarted = new Promise(resolve => { started = resolve; });
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
  assert.deepEqual(webTurnIdentity({}, { "x-codex-thread-id": threadId, "x-codex-turn-id": turnId }), { threadId, turnId });
  assert.deepEqual(webTurnIdentity(payload, { ...headers(followupId), "session-id": "cache-affinity", session_id: followupId }), { threadId, turnId });
  assert.deepEqual(webTurnIdentity(payload, { "x-codex-turn-metadata": "stale-prewarm", "x-codex-thread-id": followupId }), { threadId, turnId });
  assert.deepEqual(webTurnIdentity({}, { ...headers(), "session-id": "cache-affinity" }), { threadId, turnId });
  assert.throws(() => webTurnIdentity({ client_metadata: { "x-codex-turn-metadata": "broken-current" } }, headers()), /Invalid native Web turn metadata/);
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": threadId }), /agreeing native thread and turn/);
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": "some-open-task", "x-codex-turn-id": turnId }), /Invalid native Web ownership/);
});
