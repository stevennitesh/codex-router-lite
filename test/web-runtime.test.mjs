import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { domElement, domText, messageId, replyElement } from "./web-dom-fixture.mjs";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-web-runtime-"));
process.env.CODEX_HOME = path.join(stateDir, "codex");
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
mkdirSync(process.env.CODEX_HOME);
after(() => rmSync(stateDir, { recursive: true, force: true }));

const { createInAppWebRuntime, collectWebTools, webTurnIdentity } = await import("../src/web-runtime.mjs");
const { createWebToolBroker } = await import("../src/web-tools.mjs");
const { parseBrowserOutput, readBrowserProgram } = await import("../src/web-browser.mjs");
const { startWebMcp } = await import("../src/web-mcp.mjs");
const { qualifyBrowserCall } = await import("../src/web-stop-adapter.mjs");
const { SseFrameBuffer, sseFrameFields } = await import("../src/sse-framing.mjs");
const { decodeCompaction } = await import("../src/compaction-checkpoint.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

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

function fakeBrowser() {
  const ui = { power: 2, menu: false, chip: false, stop: false, texts: [], complete: false, sends: [], marks: 0, newTabs: 0, closes: 0, present: true, navigations: 0, reacquired: [], stopMarks: [],
    temporaryControls: false, normalHome: true, full: false, rollovers: 0, chatNumber: 1, composer: "", url: "https://chatgpt.com/", tabId: "owned-saved-tab", savedReplies: new Map(), turns: [], savedTurns: new Map() };
  const locator = (kind, name, visibleOnly = false) => ({
    getByRole: (childKind, options) => locator(childKind, options.name), locator: selector => locator("selector", selector),
    filter({ hasText, visible }) {
      if (visible !== undefined) return locator(kind, name, visible);
      assert.equal(kind, "selector");
      assert.equal(name, '[role="menuitemradio"]');
      return locator("family-text", hasText);
    },
    async count() { return kind === "menuitemradio" ? 0 : 1; },
    async isVisible() {
      if (kind === "menu") return ui.menu;
      if (name === "Stop") return ui.stop;
      if (name === "Regenerate response") return ui.complete;
      if (name === "Temporary chat") return kind === "heading" ? ui.temporaryControls : ui.normalHome;
      if (name === "Turn off temporary chat") return ui.temporaryControls;
      if (name === "Ready when you are.") return ui.normalHome;
      if (kind === "selector" && name.startsWith("span[app-mention")) return ui.chip;
      return true;
    },
    async click() {
      if (name === "Select ChatGPT model") ui.menu = !ui.menu;
      else if (name === "Current Codex Tools Workspace tools") ui.chip = true;
      else if (name === "Stop") { ui.stopMarks.push(ui.marks); ui.stop = false; }
      else if (name === "Start new chat") {
        ui.rollovers += 1; ui.chatNumber += 1; ui.full = false; ui.normalHome = true; ui.url = "https://chatgpt.com/";
        ui.texts = []; ui.turns = []; ui.composer = ""; ui.chip = false; ui.complete = false;
      }
      else if (name === "Send") {
        const baselineIds = ui.replyElements?.map(element => element.closest('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id'))
          ?? ui.texts.map((_, index) => ui.replyIds?.[index] ?? messageId(index));
        ui.turns.push({ key: messageId(10000 + ui.sends.length), prompt: ui.composer, baselineIds });
        ui.sends.push(ui.composer); ui.composer = ""; ui.complete = false;
        ui.normalHome = false;
        ui.url = `https://chatgpt.com/c/${ui.chatNumber === 1 ? "owned-conversation" : `successor-${ui.chatNumber}`}`;
        ui.savedReplies.set(ui.url, ui.texts);
        ui.savedTurns.set(ui.url, ui.turns);
      }
    },
    async getAttribute(attribute) { return { "aria-checked": "true", "aria-valuenow": String(ui.power), "aria-valuemin": "0", "aria-valuemax": "4" }[attribute] ?? null; },
    async textContent() { return name; }, async innerText() { return name === "Ask ChatGPT" ? ui.composer : ui.power === 0 ? "GPT-6 Instant" : "GPT-6 Thinking"; },
    async isEnabled() { return true; },
    async press(key) { if (name === "Power") { if (key === "Escape") ui.menu = false; else ui.power += key === "ArrowLeft" ? -1 : 1; } },
    async type(text) { ui.composer = (ui.composer ?? "") + text; },
    async waitFor({ state }) { assert.equal(await this.isVisible(), state === "visible"); },
    async evaluateAll(callback, ownedChipSelector) {
      if (kind === "text" || name === "Start new chat") return callback(ui.full && visibleOnly ? [{ closest: () => null, querySelector: () => null }] : [], ownedChipSelector);
      if (name === "Ask ChatGPT") {
        const content = [domText(ui.composer)];
        if (ui.chip) content.push(domElement("span", { "app-mention-display-name": "Current Codex Tools",
          "app-mention-path": "app://asdk_current_tools", contenteditable: "false" }));
        return callback([domElement("div", { contenteditable: "true" }, ...content)], ownedChipSelector);
      }
      assert.equal(name, '[data-turn-key],[data-chatgpt-selection-message-id] [data-markdown-text-style="assistant-message"]');
      const roots = ui.turns.map((turn, index) => {
        const action = { getAttribute: () => "Regenerate response", closest: () => null };
        const root = { nodeType: 1, tagName: "DIV", textContent: turn.prompt, fixtureMarkdown: [],
          getAttribute: key => key === "data-turn-key" ? turn.key : null,
          matches: selector => selector === '[data-turn-key]', querySelector: () => null,
          querySelectorAll: selector => selector === '[data-talvt-turn-state]' ? [{ getAttribute: () => index < ui.turns.length - 1 || ui.complete ? "complete" : "streaming" }]
            : selector === '[aria-label]' ? [action]
              : selector === '[data-chatgpt-selection-message-id] [data-markdown-text-style="assistant-message"],[data-streaming-response-status],[aria-label]'
                ? [...root.fixtureMarkdown, action] : [] };
        return root;
      });
      const elements = ui.replyElements ?? ui.texts.map((value, index) => replyElement(value, ui.replyIds ? ui.replyIds[index] : messageId(index)));
      for (const [index, element] of elements.entries()) {
        const wrapper = element.fixtureWrapper ?? element.closest('[data-chatgpt-selection-message-id]');
        element.fixtureWrapper = wrapper;
        const replyId = wrapper?.getAttribute('data-chatgpt-selection-message-id');
        const ownerIndex = ui.turns.findLastIndex(turn => !turn.baselineIds.includes(replyId));
        let turn = roots[ownerIndex];
        if (ui.replyTurnKeys?.[index]) {
          const key = ui.replyTurnKeys[index];
          turn = roots.find(root => root.getAttribute('data-turn-key') === key);
          if (!turn) {
            turn = { getAttribute: () => key, textContent: "Another generation", matches: selector => selector === '[data-turn-key]', querySelector: () => null, querySelectorAll: () => [] };
            roots.push(turn);
          }
        }
        if (wrapper) wrapper.closest = selector => selector === '[data-turn-key]' ? turn
          : selector === '[data-chatgpt-selection-message-id]' ? wrapper : null;
        turn?.fixtureMarkdown?.push(element);
        element.matches = selector => selector !== '[data-turn-key]';
        element.closest = selector => selector === '[data-chatgpt-selection-message-id]' ? wrapper : element.commentary ? {} : null;
      }
      return callback([...roots, ...(ui.orphanMarkdownBefore ?? []), ...elements, ...(ui.orphanMarkdownAfter ?? [])], ownedChipSelector);
    },
  });
  const tab = { get id() { return ui.tabId; }, goto: async url => {
    ui.navigations += 1; ui.url = url; ui.normalHome = url === "https://chatgpt.com/";
    ui.texts = ui.savedReplies.get(url) ?? []; ui.composer = "";
    ui.turns = ui.savedTurns.get(url) ?? [];
  }, url: async () => ui.url,
    playwright: { getByRole: (kind, options) => locator(kind, options.name), getByText: text => locator("text", text), locator: selector => locator("selector", selector) },
    markHandoff: async () => { ui.marks += 1; }, close: async () => { ui.closes += 1; ui.present = false; } };
  const browser = { browserId: "same-session-iab",
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
function harness(t, { tools = [nativeJs, currentRead], toolChoice = "auto", cancelDuringWatch = false,
  tunnelReadiness = () => Promise.resolve(), storage = syntheticStorage, mcpFactory } = {}) {
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
        status: () => ({ healthy: true }), close: async () => { observations.services.push("mcp-closed"); } };
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
  let runtime = makeRuntime();
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
  return { get runtime() { return runtime; }, get broker() { return broker; }, browser, observations, settings, request, executeBrowser, answerBrowser, toObserve,
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
  let started, release;
  const writeStarted = new Promise(resolve => { started = resolve; });
  const writeAllowed = new Promise(resolve => { release = resolve; });
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
  h.browser.ui.texts.push("Completed reply"); h.browser.ui.complete = true;
  const retained = await h.answerBrowser(call), final = await h.answerBrowser(retained.output[0]);
  h.append(final.output[0]);
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
    h.browser.ui.texts.push("Existing deployed answer"); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
  const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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
  const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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
    const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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
    const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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
      const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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
  const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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

test("native request replay preserves call IDs and follow-up NEW turns reuse the retained binding and tab", async t => {
  const h = harness(t);
  const initial = await h.request();
  const replay = await h.request();
  assert.deepEqual(replay.output, initial.output);
  const { call } = await h.toObserve();
  assert.equal((await h.request()).output[0].call_id, call.call_id);
  await assert.rejects(h.request({ model: "chatgpt-web/gpt-6-sol", reasoning: { effort: "high" } }), /cannot change model or effort/u);
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
  const read = oldBroker.list(oldToken).find(tool => tool.name === "read");
  const actual = oldBroker.invoke(oldToken, { wireName: read.wireName, arguments: { path: "private-tool-argument.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding, outputFor(coding, "private actual tool result"));
  const observe = (await h.request()).output[0];
  await actual;
  h.browser.ui.texts.push("Private assistant final answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(observe);
  const final = await h.answerBrowser(retain.output[0]);
  h.append(final.output[0]);
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
  assert.deepEqual(h.broker.list(h.token()).find(tool => tool.name === "read").parameters, currentRead.tools[0].parameters);
});

test("manually closing the saved tab reopens its URL and preserves delta delivery while the REPL survives", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.browser.ui.texts.push("Latest saved answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
  const read = h.broker.list(token).find(tool => tool.name === "read");
  const actual = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "already-delivered.txt" } });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding, outputFor(coding, "Already delivered actual tool result"));
  const observe = (await h.request()).output[0]; await actual;
  h.append({ role: "user", content: "Unsent native material arrived while the Web answer was finishing." });
  h.browser.ui.texts.push("The completed Web answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(observe), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
  h.newTurn(followupId, "Current follow-up request");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [
    { role: "user", content: "Unsent native material arrived while the Web answer was finishing." },
    { role: "assistant", content: "The completed Web answer" },
    { role: "user", content: "Current follow-up request" },
  ]);
});

test("historical unpaired calls are data and do not create owned unresolved-action blocks", async t => {
  const h = harness(t);
  const historical = { type: "function_call", call_id: "historical_cancelled_call", name: "read", arguments: "{}" };
  h.append(historical);
  const { call } = await h.toObserve();
  h.browser.ui.texts.push("Historical outcome remains unknown."); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(call);
  const final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
    h.browser.ui.texts.push("Persisted answer"); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
  h.browser.ui.texts.push("A completed native final."); h.browser.ui.complete = true;
  const retained = await h.answerBrowser(call), final = await h.answerBrowser(retained.output[0]); h.append(final.output[0]);
  h.newTurn(followupId, "A successor blocked before Send.");
  const continuation = (await h.request()).output[0];
  h.browser.ui.composer = "Keep this draft.";
  await assert.rejects(h.executeBrowser(continuation), /composer has a draft/);
  h.observations.watchers.at(-1).onCancel();
  await h.restartRuntime(); h.loseKernel();
  h.browser.ui.composer = ""; h.browser.ui.replyIds = [messageId(999)];
  h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Retry the new work.");
  const retry = (await h.request()).output[0];
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
    const continuation = (await h.request()).output[0];
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
  const { call } = await h.toObserve();
  const token = h.token(), read = h.broker.list(token).find(tool => tool.name === "read");
  const pending = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "unknown.txt" } });
  const rejection = assert.rejects(pending, { code: "web_turn_cancelled" });
  const coding = (await h.answerBrowser(call)).output[0];
  h.append(coding);
  h.observations.watchers[0].onCancel();
  await rejection;
  const oldBroker = h.broker;
  await h.restartRuntime();
  const operationsBefore = h.observations.nativeOperations.length;
  await assert.rejects(h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() }), { code: "web_coding_uncertain" });
  h.newTurn(followupId, "Continue using only confirmed results.");
  await assert.rejects(h.request(), { code: "web_coding_uncertain" });
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
});

test("an unconfirmed Send is never replayed after cancellation even if its click took effect", async t => {
  for (const [executed, lostKernel] of [[false, false], [true, false], [true, true]]) await t.test(`${executed ? "click took effect" : "execution unknown"}; kernel lost ${lostKernel}`, async t => {
    const h = harness(t);
    let response = await h.request();
    while (JSON.parse(response.output[0].arguments).title !== "ChatGPT Web: send") response = await h.answerBrowser(response.output[0]);
    if (executed) await h.executeBrowser(response.output[0]);
    h.observations.watchers[0].onCancel();
    if (lostKernel) { h.loseKernel(); await h.restartRuntime(); }
    await assert.rejects(h.runtime.request({ model: "chatgpt-web/gpt-6-sol-instant", input: h.input() }, { compact: true, headers: headers() }), { code: "web_send_uncertain" });
    h.newTurn(followupId, "Resume without duplicating the uncertain Send.");
    const before = h.observations.nativeOperations.length;
    await assert.rejects(h.request(), { code: "web_send_uncertain" });
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
  h.browser.ui.stop = true;
  if (emptyReply) h.browser.ui.texts.push("");
  if (observed) await h.answerBrowser(observe);
  h.observations.watchers[0].onCancel();
  h.loseKernel();
}

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
    const continuation = (await h.request()).output[0];
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
    const continuation = (await h.request()).output[0];
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
    const continuation = (await h.request()).output[0];
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
      const getByRole = h.browser.tab.playwright.getByRole;
      h.browser.tab.playwright.getByRole = (kind, options) => {
        const control = getByRole(kind, options), visible = control.isVisible;
        if (options.name === "Stop") control.isVisible = async () => { const value = await visible(); replace(); return value; };
        return control;
      };
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
    const continuation = (await h.request()).output[0];
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
    const getByRole = h.browser.tab.playwright.getByRole;
    h.browser.tab.playwright.getByRole = (kind, options) => {
      const control = getByRole(kind, options), click = control.click;
      if (options.name === "Stop") control.click = async () => {
        await click();
        if (replaceReply) { h.browser.ui.replyIds = [messageId(0), messageId(1), messageId(3)]; h.browser.ui.replyTurnKeys = [null, null, messageId(998)]; }
        else h.browser.ui.texts.push("The first reply rendered while Stop was reconciled");
      };
      return control;
    };
    h.newTurn(followupId, "Continue only after identifying the stopped reply.");
    const continuation = (await h.request()).output[0];
    if (replaceReply) await assert.rejects(h.executeBrowser(continuation), /latest reply changed/iu);
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
  const continuation = (await h.request()).output[0];
  const failure = await h.executeBrowser(continuation).then(() => assert.fail("The draft must block recovery."), error => error);
  h.append(continuation, outputFor(continuation, { isError: true, content: [{ type: "text", text: failure.message }] }));
  await assert.rejects(h.request(), { code: "web_browser_execution_failed" });
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

test("attributed compaction preserves undelivered native items without resending an acknowledged summary", async t => {
  for (const mode of ["used", "abandoned", "recompacted", "restarted", "second abandoned", "second abandoned after restart", "owned coding"]) await t.test(mode, async t => {
    const h = harness(t), { call } = await h.toObserve();
    let observe = call;
    if (mode === "owned coding") {
      const token = h.token(), read = h.broker.list(token).find(tool => tool.name === "read");
      const result = h.broker.invoke(token, { wireName: read.wireName, arguments: { path: "owned-completed-result.txt" } });
      const owned = (await h.answerBrowser(observe)).output[0];
      h.append(owned, outputFor(owned, "Owned actual result already delivered to Web"));
      observe = (await h.request()).output[0]; await result;
    }
    h.browser.ui.texts.push("Already owned Web answer with detailed context"); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(observe), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [
      { role: "user", content: rawTail[0].content },
      { type: "function_call", call_id: rawTail[1].call_id, name: rawTail[1].name, arguments: rawTail[1].arguments },
      { type: "function_call_output", call_id: rawTail[2].call_id, output: rawTail[2].output },
      { role: "assistant", content: rawTail[3].content },
      { role: "user", content: "New request after native compaction" },
    ]);
    assert.match(h.browser.ui.sends.at(-1), /Current changed instructions remain authoritative/u);
    assert.equal(h.browser.ui.sends.at(-1).includes("lossy continuation checkpoint"), false);
    const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
    assert.equal(saved.pendingCompaction, undefined, "Only confirmed Send replaces the delivery checkpoint and consumes the alias.");
    assert.equal(saved.activeCompaction, undefined);
  });
});

test("confirmed capacity rejection with no answer or coding action transfers history once and refreshes native authority", async t => {
  const h = harness(t), { call } = await h.toObserve();
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
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Read the current file using the declared tools." }]);
  const saved = JSON.parse(readFileSync(h.stateFile, "utf8"));
  assert.equal(saved.chatUrl, "https://chatgpt.com/c/successor-2");
  assert.deepEqual(saved.previousChatUrls, [sourceUrl]);
  assert.equal(saved.needsHistory, false);
  h.browser.ui.texts.push("Successor answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(nextObserve), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
  h.newTurn(followupId, "Later native delta");
  await h.toObserve();
  assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Later native delta" }]);
  assert.equal(h.browser.ui.rollovers, 1);
});

test("native V2 preserves an exact pending tail after its retained-user prefix and outer identity are rewritten", async t => {
  for (const mode of ["used", "abandoned", "recompacted", "restarted", "second abandoned", "second abandoned after restart"]) await t.test(mode, async t => {
    const h = harness(t), { call } = await h.toObserve();
    h.browser.ui.texts.push("Already owned Web answer"); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
    h.browser.ui.texts.push("Web completed the post-compaction request"); h.browser.ui.complete = true;
    const retained = await h.answerBrowser(observation.call), completed = await h.answerBrowser(retained.output[0]); h.append(completed.output[0]);
    h.newTurn("33002233-4455-6677-8899-aabbccddeeff", "Next request stays a small delta");
    await h.toObserve();
    assert.deepEqual(sentTranscript(h), [{ role: "user", content: "Next request stays a small delta" }]);
    assert.equal(h.browser.ui.newTabs, 1);
  });
});

test("native V2 forwards changed or clipped retained-prefix material instead of suppressing it", async t => {
  const h = harness(t), { call } = await h.toObserve();
  h.browser.ui.texts.push("Owned answer"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
  const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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
    h.browser.ui.texts.push("Completed Web answer after actual native result"); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(observation.output[0]), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
    const read = h.broker.list(h.token()).find(tool => tool.name === "read");
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
    h.browser.ui.texts.push("Done. Detailed report from the completed Web action."); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(observation), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
    h.browser.ui.texts.push("Follow-up completed with refreshed context"); h.browser.ui.complete = true;
    const retained = await h.answerBrowser(next.call), completed = await h.answerBrowser(retained.output[0]); h.append(completed.output[0]);
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
    const read = h.broker.list(token).find(tool => tool.name === "read");
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
  h.browser.ui.texts.push("Completed post-compaction request"); h.browser.ui.complete = true;
  const retain = await h.answerBrowser(next.call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
    h.browser.ui.texts.push("Already completed original request"); h.browser.ui.complete = true;
    const retain = await h.answerBrowser(call), final = await h.answerBrowser(retain.output[0]); h.append(final.output[0]);
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
      const token = h.token(), read = h.broker.list(token).find(tool => tool.name === "read");
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
      const continuation = (await h.request()).output[0];
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
  const read = h.broker.list(token).find(tool => tool.name === "read");
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
  assert.equal(h.observations.nativeOperations.at(-2), "continue");
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
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": threadId, "x-codex-turn-id": turnId }), { code: "web_turn_identity" });
  assert.deepEqual(webTurnIdentity(payload, { ...headers(followupId), "session-id": "cache-affinity", session_id: followupId }), { threadId, turnId });
  assert.deepEqual(webTurnIdentity(payload, { "x-codex-turn-metadata": "stale-prewarm", "x-codex-thread-id": followupId }), { threadId, turnId });
  assert.deepEqual(webTurnIdentity({}, { ...headers(), "session-id": "cache-affinity" }), { threadId, turnId });
  assert.throws(() => webTurnIdentity({ client_metadata: { "x-codex-turn-metadata": "broken-current" } }, headers()), /Invalid native Web turn metadata/);
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": threadId }), /canonical native thread and turn/);
  assert.throws(() => webTurnIdentity({}, { "x-codex-thread-id": "some-open-task", "x-codex-turn-id": turnId }), /canonical native thread and turn/);
});
