import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { runInNewContext } from "node:vm";

import { browserScript, discoverBrowserExecutor, parseBrowserOutput, readBrowserReplies } from "../src/web-browser.mjs";

const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const bindingId = "unit_test";
const base = { bindingId, frameToken: token, sessionId: "current-session", turnId: "first-turn", modelFamily: "GPT-6", power: 0 };
const plugin = { pluginName: "Current tools", pluginAppId: "asdk_current_123", pluginSelectionButtonName: "Current tools The current tool collection" };
const fullConversationText = "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.";
const schema = { type: "object", properties: { code: { type: "string" }, title: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } }, required: ["code"] };
const offered = parameters => [{ type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", parameters }] }];
const messageId = index => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

const domText = value => ({ nodeType: 3, textContent: value });
function domElement(tag, attributes = {}, ...children) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), childNodes: children, children: children.filter(child => child.nodeType === 1),
    getAttribute: name => attributes[name] ?? null,
    matches(selector) {
      return selector.split(/\s*,\s*/u).some(part => {
        const requiredTag = part.match(/^[A-Za-z][A-Za-z0-9-]*/u)?.[0];
        const requiredAttributes = Array.from(part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/gu));
        return Boolean(requiredTag || requiredAttributes.length) && (!requiredTag || requiredTag.toUpperCase() === this.tagName)
          && requiredAttributes.every(match => match[2] === undefined ? attributes[match[1]] !== undefined : attributes[match[1]] === match[2]);
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; },
    classList: { contains: name => (attributes.class ?? "").split(/\s+/).includes(name) },
    get textContent() { return children.map(child => child.textContent).join(""); },
    querySelectorAll(selector) {
      const found = [];
      const visit = candidate => {
        if (candidate.nodeType !== 1) return;
        if (selector === "code" ? candidate.tagName === "CODE"
          : selector === ".cm-content[data-language]" ? candidate.classList.contains("cm-content") && candidate.getAttribute("data-language") !== null
            : candidate.matches(selector)) found.push(candidate);
        candidate.childNodes.forEach(visit);
      };
      children.forEach(visit);
      return found;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; } };
  for (const child of node.children) child.parentElement = node;
  return node;
}
const sourceBlock = source => domElement("div", { "data-markdown-copy": "code-block" },
  domElement("div", { "data-markdown-copy": "exclude" }, domText("Plain text")),
  domElement("div", { "data-code-block-source": "true" }, domElement("code", {}, domElement("span", {}, domText(source)))));

test("reply projection excludes the observed code toolbar while preserving literal code, indentation and blank lines", () => {
  const source = "  FORMAT_ONE\n\n    FORMAT_TWO\nFORMAT_THREE\n";
  const root = domElement("div", {}, domElement("div", {}, sourceBlock(source)));
  const isolatedReader = runInNewContext(`(${readBrowserReplies.toString()})`);
  domElement("div", { "data-chatgpt-selection-message-id": messageId(0) }, root);
  assert.equal(isolatedReader([root])[0].text, source);
  assert.equal(isolatedReader([root])[0].messageId, messageId(0));
  assert.equal(root.textContent, `Plain text${source}`, "The read does not mutate the browser DOM.");
});

test("reply projection preserves paragraph, BR and code boundaries without removing literal Plain text prose", () => {
  const root = domElement("div", {},
    domElement("p", {}, domText("Literal Plain text belongs to the answer.")),
    domElement("p", {}, domText("Second paragraph"), domElement("br"), domText("continued")),
    sourceBlock("  first\n\n    second"),
    domElement("p", {}, domText("After "), domElement("code", {}, domText("inline")), domText(" code.")));
  assert.equal(readBrowserReplies([root])[0].text, "Literal Plain text belongs to the answer.\n\nSecond paragraph\ncontinued\n\n  first\n\n    second\n\nAfter inline code.");
});

test("CodeMirror logical lines preserve empty lines and reject incomplete or ambiguous source", () => {
  const editor = domElement("div", { class: "cm-content", "data-language": "python" },
    domElement("div", { class: "cm-line" }, domText("  first")),
    domElement("div", { class: "cm-line" }, domElement("br")),
    domElement("div", { class: "cm-line" }, domText("    last")),
    domElement("div", { class: "cm-line" }, domElement("br")));
  const block = (...content) => domElement("div", { "data-markdown-copy": "code-block" },
    domElement("div", { "data-markdown-copy": "exclude" }, domText("Python")), ...content);
  assert.equal(readBrowserReplies([block(editor)])[0].text, "  first\n\n    last\n");
  for (const invalid of [
    block(domElement("code", {}, domText("one")), domElement("code", {}, domText("two"))),
    block(editor, editor),
    block(domElement("div", { class: "cm-content", "data-language": "python" }, domElement("div", { class: "spacer" }))),
  ]) assert.throws(() => readBrowserReplies([invalid]), /one complete source/);
});

test("native browser executor preserves the exact declared schema and identity", () => {
  const executor = discoverBrowserExecutor(offered(schema));
  assert.equal(executor.namespace, "mcp__node_repl");
  assert.equal(executor.name, "js");
  assert.equal(executor.schema, schema);
  const code = "const text = '` ${notExecutable}';";
  assert.deepEqual(JSON.parse(executor.argumentsFor(code, "Inspect", 12000)), { code, title: "Inspect", timeout_ms: 12000 });
  assert.throws(() => executor.argumentsFor(code, "Inspect", 90000), /current declaration/);
  assert.throws(() => discoverBrowserExecutor([{ type: "function", name: "mcp__node_repl__js", parameters: schema }]), /explicitly declared/);
  assert.throws(() => discoverBrowserExecutor([...offered(schema), ...offered(schema)]), /one explicitly/);
  assert.throws(() => discoverBrowserExecutor(offered({ ...schema, required: ["code", "executor"] })), /schema/);
  const nullableTitle = { ...schema, properties: { ...schema.properties, title: { type: ["string", "null"] } }, required: ["code", "title"] };
  assert.equal(JSON.parse(discoverBrowserExecutor(offered(nullableTitle)).argumentsFor(code)).title, "ChatGPT Web browser operation");
});

const framed = value => `ROUTER_WEB_BROWSER_${token}_BEGIN\n${JSON.stringify({ routerBrowser: value })}\nROUTER_WEB_BROWSER_${token}_END`;
test("only one matching nonce frame can become browser data despite SDK diagnostics", () => {
  const value = { operation: "observe", completed: true, assistantText: "Result" };
  const text = `SDK warning: optional SDK package unavailable\n${framed(value)}\nWall time: 0.1 seconds`;
  assert.deepEqual(parseBrowserOutput(JSON.stringify([{ type: "text", text }]), token), value);
  for (const bad of [text + framed(value), text.replace("_END", "_MISSING"), framed(value).replace('"completed":true', '"completed":undefined')]) {
    assert.throws(() => parseBrowserOutput(bad, token), /frame|strict JSON/);
  }
  assert.throws(() => parseBrowserOutput(text, "another_valid_nonce_1234"), /Expected one/);
  assert.throws(() => parseBrowserOutput({ isError: true, content: [{ text }] }, token), /execution failed/);
  assert.throws(() => parseBrowserOutput([{ text }, { text: framed(value) }], token), /Expected one/);
  assert.throws(() => parseBrowserOutput(JSON.stringify({ routerBrowser: value }), token), /Expected one/);
});

let fixtureNumber = 0;
const runtimeFixtureKeys = [];
after(() => { for (const key of runtimeFixtureKeys) delete globalThis[key]; });
const assistantPrefix = text => ({ sha256: createHash("sha256").update(text, "utf8").digest("hex"), length: text.length });
function fixture({ texts = [], currentPower = 3, fastTimers = false, nativeContext = {}, sessionId = base.sessionId } = {}) {
  const fixtureBindingId = `unit_test_${++fixtureNumber}`;
  const bindingName = `routerWeb_${fixtureBindingId}`;
  const ui = { texts: [...texts], power: currentPower, checked: true, menu: false, chip: false, stop: false,
    complete: false, attachedName: null, typed: [], sendClicks: 0, startNewChatClicks: 0, newTabs: 0, closeCount: 0, handoffs: 0,
    powerMoves: [], present: true, temporary: false, badPowerStep: false, stripChip: false, sendFailure: false, missingPower: false,
    familyText: "GPT-6", familyClicks: 0, sendEnabled: true, waitedMs: 0,
    composerVisible: true, composerText: "", composerSelected: false, draftCleared: false,
    modelButtonVisible: true, normalHeadingVisible: true, temporaryButtonVisible: true, temporaryHeadingVisible: true,
    tabId: "owned-tab", navigations: [], replyReads: 0, fetchCalls: 0, stopClicks: 0 };
  let now = 0;
  const fixtureDate = fastTimers ? { now: () => now } : Date;
  const fixtureTimeout = fastTimers ? (callback, milliseconds) => {
    now += milliseconds;
    ui.waitedMs += milliseconds;
    ui.onWait?.();
    callback();
  } : setTimeout;
  const siteIndicator = ({ text, scope = "site", visible = true }, kind) => {
    if (scope === "assistant-ancestor") return domElement("div", {}, domElement("div", { "data-markdown-text-style": "assistant-message" }, domText(text)));
    if (scope === "composer-ancestor") return domElement("div", {}, domElement("div", { contenteditable: "true" }, domText(text)));
    const node = domElement(kind === "button" ? "button" : "div", {}, domText(text));
    if (scope === "assistant") domElement("div", { "data-markdown-text-style": "assistant-message" }, node);
    if (scope === "user") domElement("div", { "data-message-author-role": "user" }, node);
    if (scope === "user-article") domElement("article", {}, node);
    if (scope === "composer") domElement("div", { contenteditable: "true" }, node);
    node.fixtureVisible = visible;
    return node;
  };
  const makeLocator = (kind, name, visibleOnly = false) => ({
    getByRole(role, options) { return makeLocator(role, options.name); },
    locator(selector) { return makeLocator("selector", selector); },
    filter({ hasText, visible }) {
      if (visible !== undefined) return makeLocator(kind, name, visible);
      assert.equal(kind, "selector");
      assert.equal(name, '[role="menuitemradio"]');
      return makeLocator("family-text", hasText);
    },
    async count() {
      if (kind === "menuitemradio") return 0; // Visible family text is not its accessible name.
      if (kind === "button" && name === "Start new chat") return (ui.fullButtons ?? []).filter(candidate => candidate.text === name && (!visibleOnly || candidate.visible !== false)).length;
      return kind === "family-text" ? Number(ui.familyText.includes(name)) : name === plugin.pluginSelectionButtonName ? 1 : 0;
    },
    async isVisible() {
      if (name === "Select ChatGPT model" && kind === "menu") return ui.menu;
      if (name === "Select ChatGPT model" && kind === "button") return ui.modelButtonVisible;
      if (name === "Ask ChatGPT" && kind === "textbox") return ui.composerVisible;
      if (name === "Stop" || name === "Stop generating") return ui.stop;
      if (name === "Regenerate response") return ui.complete;
      if (name === "Temporary chat" && kind === "button") return ui.temporaryButtonVisible && !ui.temporary;
      if (name === "Ready when you are.") return ui.normalHeadingVisible;
      if (name === "Temporary chat" && kind === "heading") return ui.temporary && ui.temporaryHeadingVisible;
      if (name === "Turn off temporary chat") return ui.temporary;
      if (kind === "selector" && name.startsWith("span[app-mention")) return ui.chip;
      return true;
    },
    async click() {
      if (name === "Select ChatGPT model") ui.menu = !ui.menu;
      else if (kind === "family-text") { ui.familyClicks += 1; ui.checked = true; ui.menu = false; }
      else if (name === plugin.pluginSelectionButtonName) { ui.chip = true; ui.attachedName = name; }
      else if (name === "Send") {
        ui.sendClicks += 1;
        ui.normalHeadingVisible = false;
        if (!ui.deferSavedUrl) ui.url = "https://chatgpt.com/c/owned-conversation";
        ui.composerText = "";
        ui.onSend?.();
        if (ui.sendFailure) throw new Error("Send effect uncertain");
      }
      else if (name === "Stop") { ui.stopClicks += 1; ui.stop = false; }
      else if (name === "Start new chat") {
        ui.startNewChatClicks += 1;
        if (!ui.deferRolloverHome) {
          Object.assign(ui, { url: "https://chatgpt.com/", normalHeadingVisible: true, composerText: "", texts: [], chip: false,
            complete: false, stop: false, fullBanners: [], fullButtons: [] });
        }
        ui.onStartNewChat?.();
        if (ui.rolloverClickFailure) throw new Error("Start new chat effect uncertain");
      }
    },
    async getAttribute(attribute) {
      if (attribute === "aria-valuenow" && ui.missingPower) return null;
      return { "aria-checked": String(ui.checked), "aria-valuenow": String(ui.power), "aria-valuemin": "0", "aria-valuemax": "4" }[attribute] ?? null;
    },
    async textContent() { return kind === "family-text" ? ui.familyText : name; },
    async innerText() { return name === "Ask ChatGPT" ? ui.composerText : ui.power === 0 ? "GPT-6 Instant" : "GPT-6 Thinking"; },
    async press(key) {
      if (name === "Power") {
        if (key === "Escape") ui.menu = false;
        else { ui.powerMoves.push(key); ui.power += (key === "ArrowLeft" ? -1 : 1) * (ui.badPowerStep ? 2 : 1); }
      } else if (name === "Ask ChatGPT") {
        if (key === "Control+A") ui.composerSelected = true;
        if (key === "Backspace" && ui.composerSelected) {
          ui.composerText = ""; ui.composerSelected = false; ui.chip = false; ui.sendEnabled = false; ui.draftCleared = true;
        }
      }
    },
    async type(text) {
      ui.typed.push(text); ui.composerText += text;
      if (ui.draftCleared) { ui.sendEnabled = true; ui.draftCleared = false; }
      if (ui.stripChip) ui.chip = false;
    },
    async isEnabled() { return name === "Send" ? ui.sendEnabled : name === "Temporary chat" ? !ui.temporaryButtonDisabled : name === "Select ChatGPT model" ? !ui.modelButtonDisabled : true; },
    async waitFor({ state }) { assert.equal(await this.isVisible(), state === "visible"); },
    async allTextContents() {
      if (name === '[role="status"]') return ui.complete ? ["Response complete"] : [];
      throw new Error("Unobserved selector");
    },
    async evaluateAll(callback, argument) {
      if (kind === "text") {
        const candidates = [...(ui.fullBanners ?? []), ...(ui.userTexts ?? []).map(text => ({ text, scope: "user" })),
          ...ui.texts.filter(text => typeof text === "string").map(text => ({ text, scope: "assistant" })),
          { text: ui.composerText, scope: "composer" }];
        return callback(candidates.filter(candidate => candidate.text === name && (!visibleOnly || candidate.visible !== false)).map(candidate => siteIndicator(candidate)), argument);
      }
      if (kind === "button" && name === "Start new chat") {
        return callback((ui.fullButtons ?? []).filter(candidate => candidate.text === name && (!visibleOnly || candidate.visible !== false)).map(candidate => siteIndicator(candidate, "button")), argument);
      }
      if (name === "Ask ChatGPT" && kind === "textbox") {
        const content = [domText(ui.composerText)];
        if (ui.chip) content.unshift(domElement("span", { "app-mention-display-name": plugin.pluginName,
          "app-mention-path": `app://${plugin.pluginAppId}`, contenteditable: "false" }, domText(plugin.pluginName)));
        return callback([ui.composerNode ?? domElement("div", { contenteditable: "true" }, ...content)], argument);
      }
      assert.equal(name, '[data-markdown-text-style="assistant-message"]');
      ui.replyReads += 1;
      return callback(ui.texts.map((value, index) => {
        const node = typeof value === "string" ? domElement("div", {}, domText(value)) : value;
        domElement("div", { "data-chatgpt-selection-message-id": ui.replyIds ? ui.replyIds[index] : messageId(index) }, node);
        return node;
      }));
    },
  });
  const tab = { get id() { return ui.tabId; }, url: async () => ui.url ?? "https://chatgpt.com/", goto: async url => { ui.url = url; ui.navigations.push(url); ui.onGoto?.(url); },
    playwright: { getByRole: (kind, options) => makeLocator(kind, options.name), getByText: (text, options) => {
      assert.equal(options.exact, true); return makeLocator("text", text);
    }, locator: name => makeLocator("selector", name) },
    close: async () => { ui.closeCount += 1; ui.present = false; }, markHandoff: async () => { ui.handoffs += 1; } };
  const browser = { browserId: "owned-browser", documentation: async () => "Current public browser docs",
    tabs: { list: async () => [...(ui.present ? [{ id: tab.id, url: await tab.url() }] : []), ...(ui.extraTabs ?? [])],
      get: async id => { assert.equal(id, tab.id); return tab; },
      new: async () => {
        if (ui.newTabs) { ui.tabId = "reopened-tab"; ui.url = "about:blank"; ui.texts = []; ui.composerText = ""; ui.chip = false; }
        ui.newTabs += 1; ui.present = true; return tab;
      } } };
  const agent = { browsers: { list: async () => [
    { type: "iab", id: "foreign", metadata: { codexSessionId: "other-session" } },
    { type: "iab", id: browser.browserId, metadata: { codexSessionId: sessionId } },
  ], get: async id => { assert.equal(id, browser.browserId); return browser; } } };
  let state = { agent };
  nativeContext[bindingName] = state;
  const runtimeFixtureKey = `${bindingName}_agent`;
  runtimeFixtureKeys.push(runtimeFixtureKey);
  globalThis[runtimeFixtureKey] = agent;
  const runtimeModule = `data:text/javascript,${encodeURIComponent(`export const setupBrowserRuntime = () => globalThis[${JSON.stringify(runtimeFixtureKey)}];`)}`;
  let ownerTurnId;
  const run = async (operation, extra = {}) => {
    let output;
    const options = { ...base, bindingId: fixtureBindingId, sessionId, operation,
      ...(["continue", "rollover"].includes(operation) ? { ...plugin, expectedOwnerTurnIds: [ownerTurnId], ...(extra.recovery ? { runtimeModule } : {}) } : {}), ...extra };
    const code = browserScript(options);
    // Each call has a fresh execution scope, like the official REPL's modules.
    // Only the shared global object carries state; no injected local alias may
    // hide a generated initializer that shadows a previous call's binding.
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("nodeRepl", "Date", "setTimeout", "fetch", "globalThis", `${code}\nreturn globalThis.${bindingName};`);
    const forbiddenFetch = () => { ui.fetchCalls += 1; throw new Error("Native browser sandbox does not allow loopback fetch."); };
    state = await execute({ write: value => { output = value; } }, fixtureDate, fixtureTimeout, forbiddenFetch, nativeContext);
    if (["open", "continue", "rollover"].includes(operation)) ownerTurnId = nativeContext.routerWebActiveTurns?.get(sessionId)?.turnId;
    return parseBrowserOutput(output, token);
  };
  const ready = async () => {
    await run("bootstrap", { runtimeModule: "current-runtime.mjs" });
    await run("open");
    await run("model");
    await run("attach", plugin);
  };
  return { ui, run, ready, tab, browser, agent, runtimeModule, getState: () => nativeContext[bindingName],
    loseBinding({ preserveOwner = false } = {}) { delete nativeContext[bindingName]; if (!preserveOwner) nativeContext.routerWebActiveTurns?.delete(sessionId); },
    activeTurn: () => nativeContext.routerWebActiveTurns?.get(sessionId) };
}

async function recoverableFixture({ completed = true, text = "  Observed 🔧 reply\n" } = {}) {
  const f = fixture({ fastTimers: true });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push(text);
  f.ui.complete = completed;
  f.ui.stop = !completed;
  const observed = await f.run("observe", { observeIterations: 1 });
  if (completed) await f.run("retain");
  const recovery = { url: observed.url, tabId: observed.tabId, baselineReplyCount: observed.baselineReplyCount,
    replyCount: observed.replyCount, baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
    assistantPrefix: assistantPrefix(observed.assistantText), completed: observed.completed };
  return { ...f, recovery, text };
}

function showFullConversation(ui) {
  ui.fullBanners = [{ text: fullConversationText }];
  ui.fullButtons = [{ text: "Start new chat" }];
}

test("generated bootstrap reads the current session browser and opens a verified empty normal home", async () => {
  const f = fixture();
  const boot = await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
  assert.equal(boot.browserId, "owned-browser");
  assert.equal(boot.browsers.length, 1);
  assert.equal(f.ui.newTabs, 0);
  assert.equal(f.activeTurn(), undefined);
  await assert.rejects(f.run("open", { sessionId: "foreign-session" }), /another native session/);
  assert.equal(f.ui.newTabs, 0, "A foreign native session cannot allocate a tab from this binding.");
  assert.equal(f.activeTurn(), undefined);
  const goto = f.tab.goto;
  f.tab.goto = async url => {
    assert.equal(f.activeTurn()?.state.tab, f.tab, "Native Interrupt can find the owned tab before navigation starts.");
    await goto(url);
  };
  const open = await f.run("open", { ui: { stopButtonExactName: "Stop generating" } });
  assert.deepEqual([open.tabId, open.normal, open.replyCount], ["owned-tab", true, 0]);
  assert.equal(f.ui.url, "https://chatgpt.com/");
  assert.equal(f.ui.handoffs, 1);
  assert.deepEqual(f.activeTurn(), { turnId: base.turnId, state: f.getState(), stopButtonName: "Stop generating" });
  await assert.rejects(f.run("open"), /already owns/);
});

test("open observes deferred hydration of all four controls without opening or navigating again", async () => {
  const f = fixture({ fastTimers: true });
  await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
  f.ui.composerVisible = false;
  f.ui.modelButtonVisible = false;
  f.ui.temporaryButtonVisible = false;
  f.ui.normalHeadingVisible = false;
  f.ui.onWait = () => {
    assert.equal(f.activeTurn()?.state.tab, f.tab, "The owned tab is interruptible while its initial controls hydrate.");
    f.ui.composerVisible = f.ui.waitedMs >= 100;
    f.ui.modelButtonVisible = f.ui.waitedMs >= 200;
    f.ui.temporaryButtonVisible = f.ui.waitedMs >= 300;
    f.ui.normalHeadingVisible = f.ui.waitedMs >= 400;
  };
  const result = await f.run("open");
  assert.equal(result.normal, true);
  assert.equal(f.ui.waitedMs, 400);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  assert.equal(f.ui.sendClicks, 0);
});

test("a missing initial control ends open's bounded hydration wait without navigation retry or Send", async () => {
  for (const control of ["composerVisible", "modelButtonVisible", "temporaryButtonVisible", "normalHeadingVisible"]) {
    const f = fixture({ fastTimers: true });
    await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
    f.ui[control] = false;
    await assert.rejects(f.run("open"), /controls did not become ready within 10 seconds/);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.activeTurn()?.state.tab, f.tab, "A failed initial wait keeps the created tab available for native Interrupt.");
    await assert.rejects(f.run("open"), /already owns/);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("initial normal home verification cannot accept a draft, a disabled temporary toggle or active temporary mode", async () => {
  for (const change of [ui => { ui.composerText = "Existing draft"; }, ui => { ui.temporaryButtonDisabled = true; }, ui => { ui.temporary = true; }]) {
    const f = fixture({ fastTimers: true });
    await f.run("bootstrap", { runtimeModule: "current-runtime.mjs" });
    change(f.ui);
    const draft = f.ui.composerText;
    await assert.rejects(f.run("open"), /Empty normal ChatGPT home controls/);
    assert.equal(f.ui.composerText, draft);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  }
});

test("exact family selection moves Power one step at a time and verifies each step", async () => {
  const f = fixture({ currentPower: 4 });
  await f.ready();
  assert.equal(f.ui.power, 0);
  assert.deepEqual(f.ui.powerMoves, Array(4).fill("ArrowLeft"));
  f.ui.badPowerStep = true;
  await assert.rejects(f.run("model", { power: 2 }), /exactly one step/);
  f.ui.missingPower = true;
  await assert.rejects(f.run("model"), /attributes are unavailable/);
  assert.equal(f.ui.sendClicks, 0);
});

test("an unnamed radio option is selected by visible family text and similar family text is rejected before selection", async () => {
  const f = fixture({ currentPower: 0 });
  f.ui.checked = false;
  assert.equal(await f.tab.playwright.getByRole("menuitemradio", { name: "GPT-6", exact: true }).count(), 0);
  await f.ready();
  assert.equal(f.ui.checked, true);
  assert.equal(f.ui.familyClicks, 1);
  f.ui.familyText = "GPT-6.1";
  f.ui.checked = false;
  await assert.rejects(f.run("model"), /one exact observed model family/);
  assert.equal(f.ui.familyClicks, 1, "A substring match cannot select a different family.");
  assert.equal(f.ui.sendClicks, 0);
});

test("sending preserves the plugin chip, treats prompt as data, and refuses uncertain replay", async () => {
  const f = fixture();
  await f.ready();
  const prompt = 'User content: ` ${throwSomething()} "; await malicious(); //\nNext line';
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt }), /effect uncertain/);
  assert.deepEqual(f.ui.typed, [` ${prompt}`]);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.chip, true);
  await assert.rejects(f.run("send", { ...plugin, prompt }), /cannot be replayed/);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.handoffs, 2);
});

test("typing that removes the required app chip cannot trigger Send", async () => {
  const f = fixture();
  await f.ready();
  f.ui.stripChip = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Run current tools" }), /removed the plugin chip/);
  assert.equal(f.ui.sendClicks, 0);
});

test("a long paste waits for Send readiness and performs one typing action and one actual Send", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.sendEnabled = false;
  f.ui.onWait = () => { if (f.ui.waitedMs >= 300) f.ui.sendEnabled = true; };
  const prompt = "Full native context\n".repeat(4000);
  const result = await f.run("send", { ...plugin, prompt });
  assert.equal(result.sent, true);
  assert.equal(f.ui.waitedMs, 300);
  assert.deepEqual(f.ui.typed, [` ${prompt}`]);
  assert.equal(f.ui.sendClicks, 1);
  await assert.rejects(f.run("send", { ...plugin, prompt }), /cannot be replayed/);
  assert.equal(f.ui.sendClicks, 1);
});

test("Send waits within its existing budget for one saved URL before confirming persistence", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.deferSavedUrl = true;
  f.ui.onWait = () => { if (f.ui.waitedMs >= 300) f.ui.url = "https://chatgpt.com/c/owned-conversation"; };
  const sent = await f.run("send", { ...plugin, prompt: "Wait for saved URL" });
  assert.equal(sent.normal, true);
  assert.equal(sent.url, "https://chatgpt.com/c/owned-conversation");
  assert.equal(f.ui.waitedMs, 300);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.typed.length, 1);
  assert.equal(f.getState().sendConfirmed, true);
});

test("a missing saved URL or temporary URL after Send remains uncertain and cannot repeat Send", async () => {
  for (const url of ["https://chatgpt.com/", "https://chatgpt.com/c/owned-conversation?temporary-chat=true"]) {
    const f = fixture({ fastTimers: true });
    await f.ready();
    f.ui.deferSavedUrl = true;
    f.ui.onSend = () => { f.ui.url = url; };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain persistence" }), /no verified saved conversation URL/);
    assert.equal(f.getState().sendConfirmed, false);
    assert.equal(f.getState().sendClicked, true);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.ui.sendClicks, 1);
    await assert.rejects(f.run("send", { ...plugin, prompt: "Never repeat" }), /cannot be replayed/);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a follow-up Send cannot confirm a different saved conversation URL", async () => {
  const f = await recoverableFixture();
  await f.run("continue", { turnId: "next-turn" });
  f.ui.onSend = () => { f.ui.url = "https://chatgpt.com/c/unrelated-conversation"; };
  await assert.rejects(f.run("send", { ...plugin, prompt: "Follow-up", turnId: "next-turn" }), /changed the owned saved conversation URL/);
  assert.equal(f.getState().sendConfirmed, false);
  assert.equal(f.getState().savedUrl, f.recovery.url);
  assert.equal(f.ui.sendClicks, 2);
});

test("the exact visible full-chat banner and site button override reassuring assistant prose in observation", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Check this chat" });
  f.ui.texts.push("There is still plenty of room in this conversation.");
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const observed = await f.run("observe");
  assert.equal(observed.conversationFull, true);
  assert.equal(observed.assistantText, "There is still plenty of room in this conversation.");
  assert.equal(observed.completed, false);
  assert.equal(f.ui.waitedMs, 0, "Positive site evidence returns without another observation round.");
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("full-chat detection requires both exact visible site controls outside assistant and editable content", async () => {
  for (const change of [
    ui => { ui.fullBanners = [{ text: fullConversationText }]; },
    ui => { ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { showFullConversation(ui); ui.fullBanners[0].text += " Extra text"; },
    ui => { showFullConversation(ui); ui.fullBanners[0].visible = false; },
    ui => { showFullConversation(ui); ui.fullButtons[0].visible = false; },
    ui => { ui.texts.push(fullConversationText); ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { ui.userTexts = [fullConversationText]; ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { showFullConversation(ui); ui.fullBanners[0].scope = "user-article"; },
    ui => { ui.composerText = fullConversationText; ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { showFullConversation(ui); ui.fullBanners[0].scope = "assistant-ancestor"; },
    ui => { showFullConversation(ui); ui.fullBanners[0].scope = "composer-ancestor"; },
    ui => { showFullConversation(ui); ui.fullButtons[0].scope = "assistant"; },
    ui => { showFullConversation(ui); ui.fullButtons[0].scope = "user"; },
    ui => { showFullConversation(ui); ui.fullButtons[0].scope = "composer"; },
  ]) {
    const f = fixture();
    await f.ready();
    await f.run("send", { ...plugin, prompt: "Check site evidence" });
    change(f.ui);
    assert.equal((await f.run("observe", { observeIterations: 1 })).conversationFull, false);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
  }
});

test("full-chat continuation emits metadata while preserving the exact previous owner and send state", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const state = { ...f.getState() };
  const previousHandoffs = f.ui.handoffs;
  const continued = await f.run("continue", { turnId: "next-turn" });
  assert.equal(continued.conversationFull, true);
  assert.equal(continued.assistantText, f.text);
  assert.equal(continued.replyCount, 1);
  assert.equal(continued.url, f.recovery.url);
  assert.equal(f.activeTurn(), owner);
  assert.deepEqual(f.getState(), state);
  assert.equal(f.ui.handoffs, previousHandoffs + 1, "Full-chat continuation renews turn-scoped retention before returning metadata.");
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("full-chat continuation rejects an owner change during retention without reclaiming the newer turn", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const state = { ...f.getState() };
  const handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { await handoff(); owner.turnId = "newer-turn"; };
  await assert.rejects(f.run("continue", { turnId: "next-turn" }), /active browser cleanup/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.activeTurn().turnId, "newer-turn");
  assert.deepEqual(f.getState(), state);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("a full-chat Send precheck returns sent false before typing, clicking or changing ownership", async () => {
  const f = await recoverableFixture();
  await f.run("continue", { turnId: "next-turn" });
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const state = { ...f.getState() };
  const typed = [...f.ui.typed];
  const result = await f.run("send", { ...plugin, prompt: "A new delta", turnId: "next-turn" });
  assert.deepEqual(result, { operation: "send", sent: false, conversationFull: true, normal: true,
    tabId: "owned-tab", url: f.recovery.url, baselineReplyCount: 1 });
  assert.deepEqual(f.ui.typed, typed);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  assert.equal(f.activeTurn(), owner);
  assert.deepEqual(f.getState(), state);
});

test("positive full-chat controls cannot turn a previous uncertain Send into a safe unsent result", async () => {
  const f = fixture();
  await f.ready();
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain request" }), /effect uncertain/);
  showFullConversation(f.ui);
  await assert.rejects(f.run("send", { ...plugin, prompt: "Do not replay" }), /cannot be replayed/);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.getState().sendClicked, true);
  assert.equal(f.getState().sendConfirmed, false);
});

test("full-chat continuation cannot bypass uncertainty from a clicked follow-up Send in the saved chat", async () => {
  const f = await recoverableFixture();
  await f.run("continue", { turnId: "uncertain-turn" });
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain follow-up", turnId: "uncertain-turn" }), /effect uncertain/);
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: "uncertain-turn" }), /preceding Send is uncertain/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.getState().sendClicked, true);
  assert.equal(f.getState().sendConfirmed, false);
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("guarded rollover clicks once in the same owned tab and keeps full history required until a confirmed Send", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const original = f.getState();
  const owner = f.activeTurn();
  f.ui.onStartNewChat = () => {
    assert.equal(f.activeTurn(), owner, "The old owner remains current until the new home is verified.");
    assert.equal(f.ui.handoffs, 4, "Retention renews before Start new chat.");
    assert.equal(f.getState().needsHistory, true);
    assert.equal(f.getState().rolloverAttempted, true);
    assert.equal(f.getState().rolloverFromUrl, f.recovery.url);
  };
  const rolled = await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  assert.deepEqual(rolled, { operation: "rollover", rolledOver: true, needsHistory: true, previousChatUrl: f.recovery.url,
    tabId: "owned-tab", url: "https://chatgpt.com/", normal: true });
  assert.equal(f.getState(), original);
  assert.equal(f.getState().baselineReplyCount, 0);
  assert.equal(f.getState().savedUrl, undefined);
  assert.equal(f.getState().sendAttempted, false);
  assert.equal(f.activeTurn().turnId, "next-turn");
  const continued = await f.run("continue", { turnId: "following-turn", interruptedTurnId: "next-turn",
    expectedOwnerTurnIds: [base.turnId, "next-turn"] });
  assert.equal(continued.needsHistory, true);
  assert.equal(continued.replyCount, 0);
  assert.equal(continued.assistantText, "");
  await f.run("model", { turnId: "following-turn" });
  await f.run("attach", { ...plugin, turnId: "following-turn" });
  f.ui.onSend = () => { f.ui.url = "https://chatgpt.com/c/successor-conversation"; };
  const sent = await f.run("send", { ...plugin, prompt: "Complete readable native history", turnId: "following-turn" });
  assert.equal(sent.baselineReplyCount, 0);
  for (const key of ["needsHistory", "rolloverAttempted", "rolloverFromUrl"]) assert.equal(f.getState()[key], undefined);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
});

test("a rollover whose click result was discarded only acknowledges an already proven empty home on retry", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const previousOwner = f.activeTurn();
  f.ui.rolloverClickFailure = true;
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /Start new chat effect uncertain/);
  assert.equal(f.activeTurn(), previousOwner);
  assert.equal(f.getState().needsHistory, true);
  assert.equal(f.getState().rolloverAttempted, true);
  f.ui.rolloverClickFailure = false;
  const rolled = await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url,
    expectedOwnerTurnIds: [base.turnId, "next-turn"] });
  assert.equal(rolled.needsHistory, true);
  assert.equal(f.activeTurn().turnId, "next-turn");
  await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  assert.equal(f.ui.startNewChatClicks, 1, "No acknowledgement retry can click Start new chat again.");
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("a rollover attempt that never reaches proven home cannot retry its click or continue as a fresh chat", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  f.ui.deferRolloverHome = true;
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /did not reach an empty normal home within 10 seconds/);
  assert.equal(f.ui.waitedMs, 10000);
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /cannot be clicked again/);
  await assert.rejects(f.run("continue", { turnId: "next-turn", needsHistory: true, interruptedTurnId: base.turnId }), /not a proven empty normal home/);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.getState().needsHistory, true);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("rollover waits for normal home hydration after its one click without another navigation", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  f.ui.deferRolloverHome = true;
  f.ui.onWait = () => {
    if (f.ui.waitedMs >= 300) Object.assign(f.ui, { url: "https://chatgpt.com/", normalHeadingVisible: true, texts: [],
      composerText: "", chip: false, fullBanners: [], fullButtons: [] });
  };
  const rolled = await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  assert.equal(rolled.rolledOver, true);
  assert.equal(f.ui.waitedMs, 300);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("rollover rejects changed owners, URLs, full controls, active generation, drafts or uncertain Send before clicking", async () => {
  for (const change of [
    () => ({ expectedOwnerTurnIds: ["stale-owner"] }),
    ui => { ui.url = "https://chatgpt.com/c/unrelated-conversation"; },
    ui => { ui.fullBanners = []; },
    ui => { ui.fullButtons.push({ text: "Start new chat" }); },
    ui => { ui.stop = true; },
    ui => { ui.composerText = "User draft"; },
    (ui, state) => { state.sendClicked = true; state.sendConfirmed = false; },
  ]) {
    const f = await recoverableFixture();
    showFullConversation(f.ui);
    const extra = change(f.ui, f.getState());
    await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url, ...extra }), /active browser cleanup|requires the exact owned full|uncertain Send/);
    assert.equal(f.ui.startNewChatClicks, 0);
    assert.equal(f.getState().needsHistory, undefined);
    assert.equal(f.getState().rolloverAttempted, undefined);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
  }
});

test("pending full-history continuation reconciles only its exact owned unsent draft and keeps history required", async () => {
  for (const changeDraft of [false, true]) {
    const f = await recoverableFixture();
    showFullConversation(f.ui);
    await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
    await f.run("model", { turnId: "next-turn" });
    await f.run("attach", { ...plugin, turnId: "next-turn" });
    f.ui.sendEnabled = false;
    await assert.rejects(f.run("send", { ...plugin, prompt: "Full readable history", turnId: "next-turn" }), /nothing sent/);
    await f.run("cancel", { turnId: "next-turn" });
    if (changeDraft) f.ui.composerText = "Changed user draft";
    const continuation = f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" });
    if (changeDraft) {
      await assert.rejects(continuation, /draft changed or became an attachment/);
      assert.equal(f.ui.composerText, "Changed user draft");
    } else {
      assert.equal((await continuation).needsHistory, true);
      assert.equal(f.ui.composerText, "");
      assert.equal(f.getState().sendAttempted, false);
    }
    assert.equal(f.getState().needsHistory, true);
    assert.equal(f.getState().rolloverAttempted, true);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.startNewChatClicks, 1);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("pending-history draft reconciliation cannot clear a draft after the tab leaves normal home", async () => {
  for (const change of [ui => { ui.url = "https://chatgpt.com/c/unrelated-conversation"; }, ui => { ui.temporary = true; }]) {
    const f = await recoverableFixture();
    showFullConversation(f.ui);
    await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
    await f.run("model", { turnId: "next-turn" });
    await f.run("attach", { ...plugin, turnId: "next-turn" });
    f.ui.sendEnabled = false;
    await assert.rejects(f.run("send", { ...plugin, prompt: "Full readable history", turnId: "next-turn" }), /nothing sent/);
    const draft = f.ui.composerText;
    change(f.ui);
    await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" }), /not an idle normal home/);
    assert.equal(f.ui.composerText, draft);
    assert.equal(f.getState().needsHistory, true);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.startNewChatClicks, 1);
  }
});

test("a changed active owner during rollover retention cannot click or reclaim the newer turn", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { await handoff(); owner.turnId = "newer-turn"; };
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /active browser cleanup/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.activeTurn().turnId, "newer-turn");
  assert.equal(f.ui.startNewChatClicks, 0);
  assert.equal(f.getState().rolloverAttempted, undefined);
});

test("uncertain first successor Send preserves history markers and blocks continuation", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  await f.run("model", { turnId: "next-turn" });
  await f.run("attach", { ...plugin, turnId: "next-turn" });
  f.ui.sendFailure = true;
  f.ui.onSend = () => { f.ui.url = "https://chatgpt.com/c/successor-conversation"; };
  await assert.rejects(f.run("send", { ...plugin, prompt: "Full readable history", turnId: "next-turn" }), /effect uncertain/);
  await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" }), /preceding Send is uncertain/);
  assert.equal(f.getState().needsHistory, true);
  assert.equal(f.getState().rolloverAttempted, true);
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.startNewChatClicks, 1);
});

test("pending successor never recovers a lost kernel, overwrites a draft or accepts a caller flag without its state", async () => {
  const f = await recoverableFixture();
  await assert.rejects(f.run("continue", { turnId: "next-turn", needsHistory: true }), /successor binding is unavailable/);
  showFullConversation(f.ui);
  await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  f.ui.composerText = "Unrelated draft";
  await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" }), /not a proven empty normal home/);
  assert.equal(f.ui.composerText, "Unrelated draft");
  f.loseBinding();
  await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true }), /browser binding was lost/);
  await assert.rejects(f.run("rollover", { turnId: "following-turn", previousChatUrl: f.recovery.url }), /browser binding was lost/);
  assert.throws(() => browserScript({ ...base, operation: "continue", expectedOwnerTurnIds: [base.turnId], needsHistory: true,
    runtimeModule: f.runtimeModule, recovery: f.recovery }), /without recovery/);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("permanently disabled Send ends its bounded wait without typing or sending again", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.sendEnabled = false;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Paste that never becomes ready" }), /within 10 seconds/);
  assert.equal(f.ui.waitedMs, 10000);
  assert.equal(f.ui.typed.length, 1);
  assert.equal(f.ui.sendClicks, 0);
  f.ui.sendEnabled = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "No automatic retry" }), /cannot be replayed/);
  assert.equal(f.ui.typed.length, 1);
});

test("readiness cannot permit Send after the app chip or idle normal chat state changes", async () => {
  for (const change of [ui => { ui.chip = false; }, ui => { ui.temporary = true; }, ui => { ui.stop = true; }]) {
    const f = fixture({ fastTimers: true });
    await f.ready();
    f.ui.sendEnabled = false;
    f.ui.onWait = () => { f.ui.sendEnabled = true; change(f.ui); };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Wait for the paste" }), /nothing sent/);
    assert.equal(f.ui.typed.length, 1);
    assert.equal(f.ui.sendClicks, 0);
  }
});

test("observations require a fresh assistant reply and continuation retains exact tab ownership", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts.push("Previous completed answer");
  await f.run("send", { ...plugin, prompt: "Next request" });
  assert.equal(f.ui.normalHeadingVisible, false, "The initial home heading disappears after Send.");
  assert.equal(f.ui.url, "https://chatgpt.com/c/owned-conversation");
  f.ui.complete = true;
  assert.equal((await f.run("observe", { observeIterations: 1 })).completed, false);
  await assert.rejects(f.run("retain"), /successfully completed/);
  f.ui.texts.push("Fresh final answer");
  f.ui.stop = true;
  assert.equal((await f.run("observe", { observeIterations: 1 })).completed, false);
  f.ui.stop = false;
  const result = await f.run("observe", { observeIterations: 1 });
  assert.equal(result.assistantText, "Fresh final answer");
  assert.equal(result.completed, true);
  assert.equal(f.activeTurn()?.turnId, base.turnId, "Completion retains the exact owner for the next native handoff.");
  await f.run("retain");
  assert.equal(f.ui.handoffs, 3);
  assert.equal(f.activeTurn()?.turnId, base.turnId);
  const next = await f.run("continue", { tabId: "owned-tab", turnId: "following-turn" });
  assert.equal(next.replyCount, 2);
  assert.equal(next.assistantText, "Fresh final answer", "Completed continuation supplies the visible reply for native delta history.");
  assert.deepEqual(f.activeTurn(), { turnId: "following-turn", state: f.getState(), stopButtonName: "Stop" });
  const active = f.activeTurn();
  f.ui.stop = true;
  await assert.rejects(f.run("cancel"), /active.*turn|turn.*active/i);
  assert.equal(f.ui.stop, true, "A stale turn cannot stop the current generation.");
  assert.equal(f.ui.closeCount, 0, "A stale turn cannot close the continued turn's tab.");
  assert.equal(f.activeTurn(), active);
  f.ui.stop = false;
  await f.run("send", { ...plugin, prompt: "Following turn", turnId: "following-turn" });
  assert.equal((await f.run("observe", { observeIterations: 1, turnId: "following-turn" })).completed, false);
  assert.equal(f.ui.newTabs, 1);
});

test("recovery-eligible continuation preserves its existing owned state across fresh execution scopes", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push("Observed completed reply"); f.ui.complete = true;
  const observed = await f.run("observe", { observeIterations: 1 });
  await f.run("retain");
  const state = f.getState();
  const continued = await f.run("continue", { turnId: "following-turn", tabId: "owned-tab", runtimeModule: "must-not-import-recovery.mjs",
    recovery: { tabId: "owned-tab", url: observed.url, baselineReplyCount: observed.baselineReplyCount,
      replyCount: observed.replyCount, baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
      assistantPrefix: assistantPrefix(observed.assistantText), completed: observed.completed } });
  assert.equal(f.getState(), state);
  assert.equal(f.activeTurn().state, state);
  assert.equal(f.activeTurn().turnId, "following-turn");
  assert.equal(continued.recovered, undefined, "A present binding must not enter lost-kernel recovery.");
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  assert.equal(f.ui.sendClicks, 1);
});

test("a new message identity completes after mounted replies shrink below the Send baseline, including repeated answer text", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts = Array(6).fill("Repeated answer");
  const sent = await f.run("send", { ...plugin, prompt: "Repeat the answer" });
  assert.equal(sent.baselineReplyCount, 6);
  assert.deepEqual(sent.baselineReplyIds, Array.from({ length: 6 }, (_, index) => messageId(index)));
  f.ui.texts = Array(5).fill("Repeated answer"); f.ui.stop = true;
  const pending = await f.run("observe", { observeIterations: 1 });
  assert.deepEqual([pending.replyCount, pending.replyId, pending.assistantText, pending.completed], [5, null, "", false]);
  f.ui.replyIds = [0, 1, 2, 3, 6].map(messageId); f.ui.stop = false; f.ui.complete = true;
  const completed = await f.run("observe", { observeIterations: 1 });
  assert.deepEqual([completed.replyCount, completed.replyId, completed.assistantText, completed.completed], [5, messageId(6), "Repeated answer", true]);
  await f.run("retain");
  assert.equal(f.ui.sendClicks, 1);
});

test("a proven current reply keeps its identity across missing mounts and rejects a replacement with identical text", async () => {
  const f = fixture(); await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push("Same partial text"); f.ui.stop = true;
  const first = await f.run("observe", { observeIterations: 1 });
  assert.equal(first.replyId, messageId(0));
  f.ui.replyIds = [null];
  assert.equal((await f.run("observe", { observeIterations: 1 })).replyId, null);
  f.ui.replyIds = [messageId(1)]; f.ui.stop = false; f.ui.complete = true;
  const replacement = await f.run("observe", { observeIterations: 1 });
  assert.deepEqual([replacement.replyId, replacement.assistantText, replacement.completed], [null, "", false]);
  f.ui.replyIds = [messageId(0)];
  assert.equal((await f.run("observe", { observeIterations: 1 })).completed, true);
  assert.equal(f.ui.sendClicks, 1);
});

test("a proven reply unmounted before continuation remains old when it remounts after the next Send", async () => {
  const f = fixture(); await f.ready();
  await f.run("send", { ...plugin, prompt: "First request" });
  f.ui.texts.push("Prior completed answer"); f.ui.complete = true;
  await f.run("observe", { observeIterations: 1 }); await f.run("retain");
  f.ui.texts = [];
  await f.run("continue", { turnId: "following-turn" });
  const sent = await f.run("send", { ...plugin, turnId: "following-turn", prompt: "Next request" });
  assert.equal(sent.baselineReplyCount, 0);
  assert.deepEqual(sent.baselineReplyIds, [messageId(0)]);
  f.ui.texts.push("Prior completed answer");
  const old = await f.run("observe", { turnId: "following-turn", observeIterations: 1 });
  assert.deepEqual([old.replyId, old.assistantText, old.completed], [null, "", false]);
  f.ui.texts.push("Current completed answer");
  const current = await f.run("observe", { turnId: "following-turn", observeIterations: 1 });
  assert.deepEqual([current.replyId, current.assistantText, current.completed], [messageId(1), "Current completed answer", true]);
  assert.equal(f.ui.sendClicks, 2);
});

test("old, missing, duplicate or ambiguous reply identities cannot supply an answer even with completion controls", async () => {
  for (const ids of [[0, 1, 2], [0, 1, null], [0, 3, 3], [0, 3, 4]]) {
    const f = fixture(); await f.ready();
    f.ui.texts = ["Old one", "Old two", "Old three"];
    await f.run("send", { ...plugin, prompt: "New request" });
    f.ui.replyIds = ids.map(value => value === null ? null : messageId(value));
    f.ui.complete = true;
    const observed = await f.run("observe", { observeIterations: 1 });
    assert.deepEqual([observed.replyId, observed.assistantText, observed.completed], [null, "", false]);
    await assert.rejects(f.run("retain"), /successfully completed/);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a missing or duplicate reply identity blocks Send before typing or clicking", async () => {
  for (const ids of [[messageId(0), messageId(0)], [messageId(0), null]]) {
    const f = fixture(); await f.ready();
    f.ui.texts = ["Earlier one", "Earlier two"]; f.ui.replyIds = ids;
    await assert.rejects(f.run("send", { ...plugin, prompt: "New request" }), /baseline.*identities/);
    assert.equal(f.ui.typed.length, 0); assert.equal(f.ui.sendClicks, 0);
  }
});

test("lost kernel recovery uses the current same-session browser and verifies a raw UTF8 reply prefix with UTF16 length", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.browser.browserId = "browser-after-restart";
  f.ui.texts[0] += "Later visible suffix";
  const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery: f.recovery });
  assert.equal(continued.normal, true);
  assert.equal(continued.recovered, true);
  assert.equal(continued.url, f.recovery.url);
  assert.equal(continued.assistantText, f.text + "Later visible suffix");
  assert.equal(f.getState().browser.browserId, "browser-after-restart");
  assert.equal(f.activeTurn().turnId, "next-turn");
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  assert.equal(f.ui.sendClicks, 1);
});

test("saved URL reacquires one existing tab when its old ID is absent or no tab hint was retained", async () => {
  for (const retainHint of [true, false]) {
    const f = await recoverableFixture();
    f.loseBinding();
    f.ui.tabId = "current-saved-tab";
    const recovery = { ...f.recovery };
    if (!retainHint) delete recovery.tabId;
    const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery });
    assert.equal(continued.tabId, "current-saved-tab");
    assert.equal(continued.recovered, true);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
  }
});

test("a missing original tab reopens only its exact saved URL and registers retention before navigation", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.ui.present = false;
  f.ui.onGoto = url => {
    assert.equal(url, f.recovery.url);
    assert.equal(f.activeTurn()?.state.tab, f.tab);
    assert.equal(f.activeTurn()?.turnId, "next-turn");
    assert.equal(f.ui.handoffs, 4, "The newly owned tab is retained before navigation.");
    f.ui.texts = [f.text];
  };
  const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery: f.recovery });
  assert.equal(continued.tabId, "reopened-tab");
  assert.equal(continued.assistantText, f.text);
  assert.equal(f.ui.newTabs, 2);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
  assert.equal(f.ui.sendClicks, 1);
});

test("a manually closed saved tab recovers the same retained JavaScript binding at its exact saved URL", async () => {
  const f = await recoverableFixture();
  const state = f.getState();
  const originalOwner = f.activeTurn();
  f.ui.present = false;
  f.ui.onGoto = url => {
    assert.equal(url, f.recovery.url);
    f.ui.texts = [f.text];
  };
  const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery: f.recovery });
  assert.equal(continued.recovered, true);
  assert.equal(continued.tabId, "reopened-tab");
  assert.equal(continued.assistantText, f.text);
  assert.equal(continued.url, f.recovery.url);
  assert.equal(f.getState(), state, "Manual closure must preserve the retained binding object.");
  assert.equal(originalOwner.state, state);
  assert.equal(f.activeTurn().state, state);
  assert.equal(f.activeTurn().turnId, "next-turn");
  assert.equal(f.getState().bindingLost, undefined);
  assert.equal(f.ui.newTabs, 2);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
  assert.equal(f.ui.sendClicks, 1, "Reopening a closed tab never replays Send or creates another conversation.");
});

test("manual tab closure cannot recover with a stale owner, different saved URL or pending full-history successor", async () => {
  const f = await recoverableFixture();
  f.ui.present = false;
  await assert.rejects(f.run("continue", { turnId: "next-turn", expectedOwnerTurnIds: ["foreign-owner"], recovery: f.recovery }), /active browser cleanup/);
  await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: { ...f.recovery, url: "https://chatgpt.com/c/unrelated-conversation" } }), /differs from the owned saved conversation/);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  const pending = await recoverableFixture();
  showFullConversation(pending.ui);
  await pending.run("rollover", { turnId: "next-turn", previousChatUrl: pending.recovery.url });
  pending.ui.present = false;
  await assert.rejects(pending.run("continue", { turnId: "following-turn", recovery: pending.recovery }), /owned saved chat tab is unavailable/);
  assert.equal(pending.ui.newTabs, 1);
  assert.equal(pending.ui.startNewChatClicks, 1);
});

test("manual-tab recovery rechecks ownership before allocating a tab after browser discovery", async () => {
  const f = await recoverableFixture();
  f.ui.present = false;
  const owner = f.activeTurn();
  const list = f.agent.browsers.list;
  f.agent.browsers.list = async () => { const result = await list(); owner.turnId = "newer-turn"; return result; };
  await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /active browser cleanup/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.activeTurn().turnId, "newer-turn");
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  assert.equal(f.ui.sendClicks, 1);
});

test("a rejected existing saved-URL candidate never becomes the retained owner's cleanup target", async () => {
  for (const invalid of ["reply", "draft"]) {
    const f = await recoverableFixture();
    const originalTab = f.getState().tab;
    const originalOwner = f.activeTurn();
    const candidate = fixture();
    await candidate.ready();
    candidate.ui.tabId = "candidate-tab";
    candidate.ui.url = f.recovery.url;
    candidate.ui.texts = [invalid === "reply" ? "Corrupted reply" : f.text];
    candidate.ui.composerText = invalid === "draft" ? "Existing user draft" : "";
    f.ui.present = false;
    f.ui.extraTabs = [{ id: candidate.tab.id, url: f.recovery.url }];
    f.browser.tabs.get = async id => { assert.equal(id, candidate.tab.id); return candidate.tab; };
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /saved chat reply or composer changed/);
    assert.equal(f.getState().tab, originalTab);
    assert.equal(f.activeTurn(), originalOwner);
    assert.equal(f.activeTurn().state.tab, originalTab);
    candidate.ui.stop = true;
    await assert.rejects(f.run("cancel"), /owned saved chat tab is unavailable/);
    assert.equal(candidate.ui.stopClicks, 0, "A failed proof cannot grant cleanup authority over its candidate.");
    assert.equal(candidate.ui.stop, true);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("reopening a virtualized saved chat captures its verified latest reply and uses mounted counts for the next Send", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.texts = Array.from({ length: 39 }, (_, index) => `Earlier mounted assistant reply ${index}`);
  await f.run("send", { ...plugin, prompt: "Initial request" });
  f.ui.texts.push("First verified assistant reply");
  f.ui.complete = true;
  await f.run("observe", { observeIterations: 1 });
  await f.run("retain");
  await f.run("continue", { turnId: "second-turn" });
  await f.run("send", { ...plugin, prompt: "Latest request", turnId: "second-turn" });
  const latest = "Latest verified 🔧 assistant reply\n";
  f.ui.texts.push(latest);
  const observed = await f.run("observe", { observeIterations: 1, turnId: "second-turn" });
  await f.run("retain", { turnId: "second-turn" });
  assert.equal(observed.baselineReplyCount, 40);
  assert.equal(observed.replyCount, 41);
  const recovery = { url: observed.url, tabId: observed.tabId, baselineReplyCount: observed.baselineReplyCount,
    replyCount: observed.replyCount, baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
    assistantPrefix: assistantPrefix(observed.assistantText), completed: observed.completed };
  f.loseBinding();
  f.ui.present = false;
  f.ui.onGoto = url => {
    assert.equal(url, recovery.url);
    f.ui.texts = ["Only one preceding reply remains mounted", latest];
    f.ui.replyIds = [messageId(39), observed.replyId];
  };
  const continued = await f.run("continue", { turnId: "third-turn", tabId: "owned-tab", recovery });
  assert.equal(continued.recovered, true);
  assert.equal(continued.replyCount, 2);
  assert.equal(continued.assistantText, latest, "The latest saved reply remains available for native delta history despite a smaller mounted list.");
  assert.equal(f.ui.sendClicks, 2, "Recovery does not replay either prior Send.");
  await f.run("model", { turnId: "third-turn" });
  await f.run("attach", { ...plugin, turnId: "third-turn" });
  const sent = await f.run("send", { ...plugin, prompt: "New delta only", turnId: "third-turn" });
  assert.equal(sent.baselineReplyCount, 2, "A new Send establishes its own current mounted count.");
  assert.equal(f.ui.sendClicks, 3);
  assert.equal(f.ui.newTabs, 2);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", recovery.url]);
});

test("the known tab may navigate from verified empty normal home to its exact saved conversation", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.ui.url = "https://chatgpt.com/";
  f.ui.normalHeadingVisible = true;
  f.ui.texts = [];
  f.ui.onGoto = url => { assert.equal(url, f.recovery.url); f.ui.texts = [f.text]; };
  const continued = await f.run("continue", { turnId: "next-turn", recovery: f.recovery });
  assert.equal(continued.tabId, "owned-tab");
  assert.equal(continued.recovered, true);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
});

test("recovery never overwrites unrelated conversations, drafts, noneditable content, foreign pages or sign-in pages", async () => {
  for (const change of [
    ui => { ui.url = "https://chatgpt.com/c/unrelated-conversation"; },
    ui => { ui.url = "https://chatgpt.com/"; ui.normalHeadingVisible = true; ui.texts = []; ui.composerText = "My unsent draft"; },
    ui => { ui.url = "https://chatgpt.com/"; ui.normalHeadingVisible = true; ui.texts = []; ui.stop = true; },
    ui => { ui.url = "https://chatgpt.com/"; ui.normalHeadingVisible = true; ui.texts = []; ui.composerNode = domElement("div", { contenteditable: "true" }, domElement("span", { contenteditable: "false" })); },
    ui => { ui.url = "https://chatgpt.com/"; ui.normalHeadingVisible = true; ui.texts = []; ui.composerNode = domElement("div", { contenteditable: "true" }, domElement("img", { src: "attachment" })); },
    ui => { ui.url = "https://elsewhere.test/"; },
    ui => { ui.url = "https://chatgpt.com/auth/login"; },
    ui => { ui.url = "about:blank"; },
  ]) {
    const f = await recoverableFixture();
    f.loseBinding();
    change(f.ui);
    const composer = f.ui.composerText;
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /cannot overwrite/);
    assert.equal(f.ui.composerText, composer);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.activeTurn(), undefined);
  }
});

test("corrupted or changed latest saved replies, active temporary mode and drafts reject recovery without navigation", async () => {
  for (const change of [
    ui => { ui.texts[0] = "Corrupted reply"; },
    ui => { ui.replyIds = [messageId(999)]; },
    ui => { ui.texts.push("An unexpected extra reply"); },
    ui => { ui.temporary = true; },
    ui => { ui.composerText = "An existing saved-chat draft"; },
  ]) {
    const f = await recoverableFixture();
    f.loseBinding();
    change(f.ui);
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /reply or composer changed/);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.activeTurn(), undefined);
  }
});

test("reopening deleted, inaccessible or redirected saved chats fails after one exact navigation without a fresh chat fallback", async () => {
  for (const redirect of [undefined, "https://chatgpt.com/auth/login", "https://signin.example.test/"]) {
    const f = await recoverableFixture();
    f.loseBinding();
    f.ui.present = false;
    f.ui.onGoto = () => { if (redirect) f.ui.url = redirect; };
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /saved chat URL and reply did not become available/);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.ui.newTabs, 2);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.closeCount, 0);
    await assert.rejects(f.run("continue", { turnId: "retry-turn", expectedOwnerTurnIds: [base.turnId, "next-turn"],
      interruptedTurnId: "next-turn", recovery: f.recovery }), /recovery did not finish verification/);
    assert.equal(f.ui.newTabs, 2, "A failed partial recovery cannot allocate another tab or bypass its failed proof.");
  }
});

test("recovery refuses a surviving active owner or ambiguous saved URL before creating or navigating tabs", async () => {
  const owned = await recoverableFixture();
  const previous = owned.activeTurn();
  owned.loseBinding({ preserveOwner: true });
  owned.agent.browsers.list = async () => { throw new Error("Recovery reached browser discovery despite an active owner"); };
  await assert.rejects(owned.run("continue", { turnId: "next-turn", recovery: owned.recovery }), /active browser recovery/);
  assert.equal(owned.activeTurn(), previous);
  assert.equal(owned.ui.newTabs, 1);
  const ambiguous = await recoverableFixture();
  ambiguous.loseBinding();
  ambiguous.ui.tabId = "current-saved-tab";
  ambiguous.ui.extraTabs = [{ id: "duplicate-saved-tab", url: ambiguous.recovery.url }];
  await assert.rejects(ambiguous.run("continue", { turnId: "next-turn", recovery: ambiguous.recovery }), /ambiguous/);
  assert.equal(ambiguous.ui.newTabs, 1);
  assert.equal(ambiguous.ui.navigations.length, 1);
});

test("interrupted recovery retains the exact saved chat before reconciliation Stop and never repeats Send", async () => {
  const f = await recoverableFixture({ completed: false });
  f.loseBinding();
  const locator = f.tab.playwright.getByRole;
  f.tab.playwright.getByRole = (kind, options) => {
    const result = locator(kind, options);
    if (options.name === "Stop") {
      const click = result.click;
      result.click = async () => {
        assert.equal(f.activeTurn()?.turnId, "next-turn");
        assert.equal(f.ui.handoffs, 4, "Recovery and continuation renew retention before reconciliation Stop.");
        return click();
      };
    }
    return result;
  };
  const continued = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, recovery: f.recovery });
  assert.equal(continued.assistantText, f.text);
  assert.equal(continued.interrupted, true);
  assert.equal(continued.recovered, true);
  assert.equal(f.ui.stopClicks, 1);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("interrupted recovery revalidates the latest reply after Stop changes the mounted message list", async () => {
  for (const corruptLatest of [false, true]) {
    const f = await recoverableFixture({ completed: false });
    f.ui.texts = ["A preceding reply is initially mounted", f.text];
    f.ui.replyIds = [messageId(1), f.recovery.replyId];
    f.loseBinding();
    const locator = f.tab.playwright.getByRole;
    f.tab.playwright.getByRole = (kind, options) => {
      const result = locator(kind, options);
      if (options.name === "Stop") {
        const click = result.click;
        result.click = async () => {
          await click();
          f.ui.texts = [corruptLatest ? "Changed latest reply" : f.text];
          f.ui.replyIds = [f.recovery.replyId];
        };
      }
      return result;
    };
    const continuation = f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, recovery: f.recovery });
    if (corruptLatest) {
      await assert.rejects(continuation, /latest reply changed during continuation/);
      await assert.rejects(f.run("continue", { turnId: "retry-turn", interruptedTurnId: "next-turn",
        expectedOwnerTurnIds: [base.turnId, "next-turn"], recovery: f.recovery }), /recovery did not finish verification/);
    }
    else {
      const continued = await continuation;
      assert.equal(continued.replyCount, 1);
      assert.equal(continued.assistantText, f.text, "A proven latest reply survives count shrink during Stop.");
      assert.equal(continued.recovered, true);
    }
    assert.equal(f.ui.stopClicks, 1);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("native observation returns the original projected source whitespace while testing nonempty content separately", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Return the formatted source." });
  const source = "  first\n\n    last\n";
  f.ui.texts.push(domElement("div", {}, sourceBlock(" \n")));
  f.ui.complete = true;
  assert.equal((await f.run("observe", { observeIterations: 1 })).completed, false);
  f.ui.texts[0] = domElement("div", {}, sourceBlock(source));
  const result = await f.run("observe", { observeIterations: 1 });
  assert.equal(result.completed, true);
  assert.equal(result.assistantText, source);
});

test("retained follow-up requires the exact saved URL and absence of Temporary Chat controls", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "First request" });
  f.ui.texts.push("Completed first request"); f.ui.complete = true;
  await f.run("observe", { observeIterations: 1 });
  await f.run("retain");
  const owner = f.activeTurn();
  assert.equal(owner?.turnId, base.turnId);
  await assert.rejects(f.run("continue", { sessionId: "foreign-session" }), /another native session/);
  assert.equal(f.activeTurn(), owner);
  f.ui.temporary = true;
  await assert.rejects(f.run("continue"), /not ready for continuation/, "A saved URL cannot authorize reuse with active temporary controls.");
  assert.equal(f.activeTurn(), owner, "A rejected continuation cannot replace the retained owner.");
  f.ui.temporary = false;
  f.ui.url = "https://chatgpt.com/c/other-conversation";
  await assert.rejects(f.run("continue"), /not ready for continuation/, "Another saved chat cannot qualify.");
  assert.equal(f.activeTurn(), owner);
  f.ui.url = "https://chatgpt.com/c/owned-conversation?temporary-chat=true";
  await assert.rejects(f.run("continue"), /not ready for continuation/, "A temporary URL cannot qualify.");
  f.ui.url = "https://chatgpt.com/c/owned-conversation";
  assert.equal((await f.run("continue")).normal, true);
  await f.run("send", { ...plugin, prompt: "Verified follow-up" });
  assert.equal(f.ui.sendClicks, 2);
});

test("cancel stops and retains the exact owned tab, and a lost tab fails continuation without replacement", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.stop = true;
  const active = f.activeTurn();
  assert.deepEqual(await f.run("cancel"), { operation: "cancel", cancelled: true, interrupted: true, retained: true, tabId: "owned-tab" });
  assert.equal(f.ui.stop, false);
  assert.equal(f.ui.stopClicks, 1);
  assert.equal(f.ui.closeCount, 0);
  assert.equal(f.getState().interrupted, true);
  assert.equal(f.getState().retained, true);
  assert.equal(f.activeTurn(), active, "The cancelled owner remains available for the next turn's exact handoff.");
  f.ui.present = false;
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /owned saved chat tab is unavailable/);
  assert.equal(f.ui.newTabs, 1);
});

test("interrupted continuation stops the preceding native owner and starts a new turn in the same saved chat", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts.push("Earlier answer");
  await f.run("send", { ...plugin, prompt: "Interrupted request" });
  f.ui.texts.push("  Partial answer\n");
  f.ui.stop = true;
  const result = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, tabId: "owned-tab" });
  assert.deepEqual(result, { operation: "continue", tabId: "owned-tab", url: "https://chatgpt.com/c/owned-conversation", replyCount: 2, normal: true, conversationFull: false, interrupted: true, assistantText: "  Partial answer\n" });
  assert.equal(f.ui.stopClicks, 1, "Continuation reconciles Stop even when native Interrupt could not finish it.");
  assert.equal(f.ui.closeCount, 0);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.sendClicks, 1, "Reconciling an interrupted generation never replays its Send.");
  assert.equal(f.getState().baselineReplyCount, 2);
  assert.equal(f.getState().sendAttempted, false);
  assert.equal(f.getState().interrupted, false);
  assert.equal(f.activeTurn()?.turnId, "next-turn");
  f.ui.stop = true;
  await assert.rejects(f.run("cancel"), /active.*turn|turn.*active/i);
  await assert.rejects(f.run("close"), /active.*turn|turn.*active/i);
  assert.equal(f.ui.stop, true, "Cleanup for the preceding turn cannot stop the new generation.");
  assert.equal(f.ui.stopClicks, 1);
  f.ui.stop = false;
  await f.run("send", { ...plugin, prompt: "Follow-up request", turnId: "next-turn" });
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
});

test("Stop before Send retains the owned tab and does not attribute an earlier assistant reply to the interrupted turn", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts.push("Earlier answer");
  await f.run("cancel");
  const result = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId });
  assert.equal(result.interrupted, true);
  assert.equal(result.assistantText, "");
  assert.equal(f.ui.sendClicks, 0);
  assert.equal(f.ui.stopClicks, 0);
  assert.equal(f.ui.closeCount, 0);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.activeTurn()?.turnId, "next-turn");
});

test("continuation rejects missing, changed or foreign active ownership before stopping or sending", async () => {
  for (const interrupted of [false, true]) for (const replacement of [undefined, { turnId: "different-turn" }, { turnId: base.turnId, state: {} }]) {
    const nativeContext = {};
    const f = fixture({ nativeContext });
    await f.ready();
    await f.run("send", { ...plugin, prompt: "Interrupted request" });
    if (!interrupted) {
      f.ui.texts.push("Completed request"); f.ui.complete = true;
      await f.run("observe", { observeIterations: 1 });
      await f.run("retain");
    }
    f.ui.stop = true;
    if (replacement) nativeContext.routerWebActiveTurns.set(base.sessionId, { ...f.activeTurn(), ...replacement });
    else nativeContext.routerWebActiveTurns.delete(base.sessionId);
    await assert.rejects(f.run("continue", { turnId: "next-turn", ...(interrupted ? { interruptedTurnId: base.turnId } : {}) }), /active.*turn|turn.*active/i);
    assert.equal(f.ui.stop, true);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.closeCount, 0);
  }
});

test("interrupted continuation clears an ordinary unsent draft before the new turn attaches and sends", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.sendEnabled = false;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Abandoned draft" }), /nothing sent/);
  assert.equal(f.ui.composerText, " Abandoned draft");
  await f.run("cancel");
  await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId });
  assert.equal(f.ui.composerText, "");
  assert.equal(f.ui.sendClicks, 0);
  assert.equal(f.ui.chip, false, "Clearing the owned draft can remove its chip; the normal attach stage restores it.");
  await f.run("attach", { ...plugin, turnId: "next-turn" });
  await f.run("send", { ...plugin, prompt: "Current request", turnId: "next-turn" });
  assert.deepEqual(f.ui.typed, [" Abandoned draft", " Current request"]);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.closeCount, 0);
});

test("changed or transformed unsent drafts and uncertain Send cannot be replayed by interrupted continuation", async () => {
  for (const composerText of ["User changed the draft", "User added a prefix Unsent original", ""]) {
    const f = fixture({ fastTimers: true });
    await f.ready();
    f.ui.sendEnabled = false;
    await assert.rejects(f.run("send", { ...plugin, prompt: "Unsent original" }), /nothing sent/);
    f.ui.composerText = composerText;
    await f.run("cancel");
    const previous = f.activeTurn();
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /draft changed or became an attachment/);
    assert.equal(f.ui.composerText, composerText);
    assert.equal(f.activeTurn(), previous);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.closeCount, 0);
  }
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Confirmed first request" });
  f.ui.texts.push("First answer"); f.ui.complete = true;
  await f.run("observe", { observeIterations: 1 });
  await f.run("retain");
  await f.run("continue", { turnId: "uncertain-turn" });
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain request", turnId: "uncertain-turn" }), /effect uncertain/);
  await f.run("cancel", { turnId: "uncertain-turn" });
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: "uncertain-turn" }), /Send is uncertain/);
  assert.equal(f.activeTurn()?.turnId, "uncertain-turn");
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.closeCount, 0);
});

test("failed handoff or tab closure keeps the exact active turn available until cleanup succeeds", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push("Completed request"); f.ui.complete = true;
  await f.run("observe", { observeIterations: 1 });
  const active = f.activeTurn();
  const handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { throw new Error("Handoff failed"); };
  await assert.rejects(f.run("retain"), /Handoff failed/);
  assert.equal(f.activeTurn(), active);
  f.tab.markHandoff = handoff;
  const close = f.tab.close;
  f.tab.close = async () => { throw new Error("Closure failed"); };
  await assert.rejects(f.run("close"), /Closure failed/);
  assert.equal(f.activeTurn(), active);
  assert.equal(f.getState().closed, undefined);
  f.tab.close = close;
  assert.equal((await f.run("close")).closed, true);
  assert.equal(f.activeTurn(), undefined);
});

test("failed cancellation handoff keeps the old owner and explicit close remains separate", async () => {
  const f = fixture();
  await f.ready();
  const active = f.activeTurn();
  const handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { throw new Error("Handoff failed"); };
  f.ui.stop = true;
  await assert.rejects(f.run("cancel"), /Handoff failed/);
  assert.equal(f.ui.stop, false);
  assert.equal(f.activeTurn(), active);
  assert.equal(f.getState().retained, undefined);
  assert.equal(f.ui.closeCount, 0);
  f.tab.markHandoff = handoff;
  await f.run("cancel");
  assert.equal(f.activeTurn(), active);
  assert.equal((await f.run("close")).closed, true);
  assert.equal(f.ui.closeCount, 1);
  assert.equal(f.activeTurn(), undefined);
});

test("cleanup cannot remove a newer binding or another native session's active turn", async () => {
  const nativeContext = {};
  const older = fixture({ nativeContext });
  const newer = fixture({ nativeContext });
  const otherSession = fixture({ nativeContext, sessionId: "different-session" });
  await older.ready();
  await newer.ready();
  await otherSession.ready();
  const newest = newer.activeTurn();
  const unrelated = otherSession.activeTurn();
  await assert.rejects(newer.run("close", { sessionId: "different-session" }), /another native session/);
  assert.equal(newer.ui.closeCount, 0);
  older.ui.stop = true;
  await assert.rejects(older.run("close"), /active.*turn|turn.*active/i);
  assert.equal(older.ui.stop, true);
  assert.equal(older.ui.closeCount, 0);
  assert.equal(newer.activeTurn(), newest, "An older binding cannot clear a newer binding even when the turn ID matches.");
  assert.equal(otherSession.activeTurn(), unrelated);
  await newer.run("close");
  assert.equal(newer.activeTurn(), undefined);
  assert.equal(otherSession.activeTurn(), unrelated);
  await older.run("close");
  assert.equal(older.ui.closeCount, 1, "An idle owned tab remains explicitly closeable after the active turn ends.");
  assert.equal(otherSession.activeTurn(), unrelated);
  await otherSession.run("cancel");
  assert.equal(otherSession.activeTurn(), unrelated);
  assert.equal(otherSession.ui.closeCount, 0);
});

test("a short UI-only observation returns unfinished generation without network access or another Send", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Call the current tools" });
  f.ui.stop = true;
  const before = f.ui.replyReads;
  const pending = await f.run("observe");
  assert.equal(pending.completed, false);
  assert.equal(pending.stopVisible, true);
  assert.equal(f.ui.replyReads - before, 2);
  assert.equal(f.ui.waitedMs, 500);
  assert.equal(f.ui.fetchCalls, 0);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.closeCount, 0);
  assert.equal(f.ui.handoffs, 2);
});

test("script arguments reject unsafe bindings or native identities and unbounded observation", () => {
  for (const binding of ['x;alert(1)', "x.y", "x-y", "x\nvar evil"]) assert.throws(() => browserScript({ ...base, operation: "open", bindingId: binding }), /binding ID/);
  assert.throws(() => browserScript({ ...base, operation: "observe", observeIterations: 100 }), /bounded browser/);
  for (const name of ["sessionId", "turnId"]) for (const value of [undefined, "", "not an identity", "x".repeat(129)]) {
    assert.throws(() => browserScript({ ...base, operation: "open", [name]: value }), /session and turn identities/);
  }
  for (const interruptedTurnId of ["", "not an identity", "x".repeat(129)]) {
    assert.throws(() => browserScript({ ...base, operation: "continue", interruptedTurnId, expectedOwnerTurnIds: [base.turnId] }), /previous native turn identity/);
  }
  assert.throws(() => browserScript({ ...base, operation: "cancel", interruptedTurnId: "previous-turn" }), /previous native turn identity/);
  for (const operation of ["continue", "rollover"]) for (const expectedOwnerTurnIds of [undefined, [], [""], ["not an identity"], [base.turnId, base.turnId]]) {
    assert.throws(() => browserScript({ ...base, operation, expectedOwnerTurnIds, previousChatUrl: "https://chatgpt.com/c/owned-conversation" }), /expected native owner identities/);
  }
  assert.throws(() => browserScript({ ...base, operation: "cancel", expectedOwnerTurnIds: [base.turnId] }), /expected native owner identities/);
  const recovery = { tabId: "owned-tab", url: "https://chatgpt.com/c/owned-conversation",
    baselineReplyCount: 0, baselineReplyIds: [], replyId: messageId(0), replyCount: 1,
    assistantPrefix: assistantPrefix("Observed partial"), completed: false };
  const continuation = { ...base, operation: "continue", tabId: "owned-tab", runtimeModule: "current-runtime.mjs", expectedOwnerTurnIds: [base.turnId] };
  for (const previousChatUrl of [undefined, "https://chatgpt.com/", "https://elsewhere.test/c/owned-conversation",
    "https://chatgpt.com/c/owned-conversation?temporary-chat=true", "https://chatgpt.com/c/owned-conversation#fragment", "https://user@chatgpt.com/c/owned-conversation"]) {
    assert.throws(() => browserScript({ ...base, operation: "rollover", previousChatUrl, expectedOwnerTurnIds: [base.turnId] }), /exact previous saved chat URL/);
  }
  for (const change of [{ url: "https://chatgpt.com/" }, { url: "https://elsewhere.test/c/owned" },
    { url: "https://chatgpt.com/c/owned-conversation?temporary-chat=true" }, { tabId: "" }, { baselineReplyCount: -1 }, { replyCount: 0 },
    { assistantPrefix: { sha256: "bad", length: 1 } }, { assistantPrefix: { ...recovery.assistantPrefix, length: 0 } }, { completed: undefined }]) {
    assert.throws(() => browserScript({ ...continuation, recovery: { ...recovery, ...change } }), /confirmed owned chat and observed assistant reply/u);
  }
  assert.throws(() => browserScript({ ...base, operation: "observe", recovery }), /confirmed owned chat and observed assistant reply/u);
});
