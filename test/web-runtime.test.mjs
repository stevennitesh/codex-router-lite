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
  const ui = { power: 2, menu: false, chip: false, stop: false, texts: [], complete: false, sends: [], marks: 0, newTabs: 0, closes: 0, present: true,
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
      else if (name === "Stop") ui.stop = false;
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
  });
  const tab = { id: "owned-temporary-tab", goto: async url => { ui.url = url; }, url: async () => ui.url,
    playwright: { getByRole: (kind, options) => locator(kind, options.name), locator: selector => locator("selector", selector) },
    markHandoff: async () => { ui.marks += 1; }, close: async () => { ui.closes += 1; ui.present = false; } };
  const browser = { browserId: "same-session-iab", documentation: async () => "Current public browser runtime documentation",
    tabs: { list: async () => ui.present ? [{ id: tab.id, url: await tab.url() }] : [], new: async () => { ui.newTabs += 1; return tab; } } };
  const agent = { browsers: { list: async () => [{ type: "iab", id: browser.browserId, metadata: { codexSessionId: threadId } }],
    get: async id => { assert.equal(id, browser.browserId); return browser; } } };
  return { ui, agent };
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
  const bindings = new Map();
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
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("nodeRepl", "fetch", binding, `${args.code}\nreturn ${binding};`);
    const state = await execute({ write: value => { framed = value; } }, nativeFetch, bindings.get(binding));
    bindings.set(binding, state);
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
    append: (...items) => payload.input.push(...items),
    newTurn: (turn, userText) => { currentTurn = turn; payload = { ...payload, input: [...payload.input, { role: "user", content: userText }] }; },
  };
}

test("a queued MCP invocation routes after UI-only observation and resolves only from paired native output", async t => {
  const h = harness(t, { toolChoice: "required" });
  const { call: observe } = await h.toObserve();
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.marks, 0);
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
  assert.equal(h.browser.ui.marks, 0);
  const final = await h.answerBrowser(retain.output[0]);
  assert.equal(final.output[0].type, "message");
  assert.equal(final.output[0].content[0].text, h.browser.ui.texts[0]);
  assert.equal(h.browser.ui.marks, 1);
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
  assert.equal(h.browser.ui.sends.length, 1);
  h.browser.ui.texts.push("First answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(call);
  const final = await h.answerBrowser(retain.output[0]);
  h.append(final.output[0]);
  h.newTurn(followupId, "Follow up in this same chat.");
  const { call: nextObserve } = await h.toObserve();
  assert.equal(h.browser.ui.newTabs, 1);
  assert.equal(new Set(h.observations.bindings).size, 1);
  assert.equal(h.observations.nativeOperations.filter(operation => operation === "continue").length, 1);
  assert.equal(h.browser.ui.sends.length, 2);
  const pending = await h.answerBrowser(nextObserve);
  assert.equal(pending.output[0].type, "function_call");
  assert.equal(h.browser.ui.marks, 1, "The previous final cannot complete the follow-up.");
  h.browser.ui.texts.push("Follow-up answer"); h.browser.ui.complete = true;
  const nextRetain = await h.answerBrowser(pending.output[0]);
  const nextFinal = await h.answerBrowser(nextRetain.output[0]);
  assert.equal(nextFinal.output[0].content[0].text, "Follow-up answer");
  assert.equal(h.browser.ui.marks, 2);
  assert.equal(h.observations.watchers.length, 2);
});

test("native cancellation retires the real broker and rejects late native results in later rounds", async t => {
  const h = harness(t);
  const { call } = await h.toObserve();
  const token = h.token();
  const read = h.broker.list(token).find(tool => tool.name === "read");
  const pending = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "actual.txt" } });
  const rejection = assert.rejects(pending, { code: "web_turn_cancelled" });
  const coding = (await h.answerBrowser(call)).output[0];
  h.observations.watchers[0].onCancel();
  await rejection;
  assert.throws(() => h.broker.list(token), { code: "web_tool_turn_closed" });
  h.append(coding, outputFor(coding, "too late"));
  await assert.rejects(h.request(), { code: "web_turn_cancelled" });
  h.newTurn(followupId, "Resume after cancellation.");
  const restart = (await h.request()).output[0];
  assert.equal(JSON.parse(restart.arguments).title, "ChatGPT Web: bootstrap");
  const freshBinding = JSON.parse(restart.arguments).code.match(/\brouterWeb_[A-Za-z0-9_]+\b/)[0];
  assert.notEqual(freshBinding, h.observations.bindings[0]);
  assert.equal(h.browser.ui.marks, 0);
  assert.equal(h.browser.ui.sends.length, 1);
  assert.equal(h.browser.ui.newTabs, 1);
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
  assert.equal(h.browser.ui.marks, 0);
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
