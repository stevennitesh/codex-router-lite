import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { browserScript, discoverBrowserExecutor, parseBrowserOutput, readBrowserReplyTexts } from "../src/web-browser.mjs";

const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const bindingId = "unit_test";
const base = { bindingId, frameToken: token, sessionId: "current-session", turnId: "first-turn", modelFamily: "GPT-6", power: 0 };
const plugin = { pluginName: "Current tools", pluginAppId: "asdk_current_123", pluginSelectionButtonName: "Current tools The current tool collection" };
const schema = { type: "object", properties: { code: { type: "string" }, title: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } }, required: ["code"] };
const offered = parameters => [{ type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", parameters }] }];

const domText = value => ({ nodeType: 3, textContent: value });
function domElement(tag, attributes = {}, ...children) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), childNodes: children, children: children.filter(child => child.nodeType === 1),
    getAttribute: name => attributes[name] ?? null,
    classList: { contains: name => (attributes.class ?? "").split(/\s+/).includes(name) },
    get textContent() { return children.map(child => child.textContent).join(""); },
    querySelectorAll(selector) {
      const found = [];
      const visit = candidate => {
        if (candidate.nodeType !== 1) return;
        if (selector === "code" ? candidate.tagName === "CODE"
          : selector === ".cm-content[data-language]" && candidate.classList.contains("cm-content") && candidate.getAttribute("data-language") !== null) found.push(candidate);
        candidate.childNodes.forEach(visit);
      };
      children.forEach(visit);
      return found;
    } };
  return node;
}
const sourceBlock = source => domElement("div", { "data-markdown-copy": "code-block" },
  domElement("div", { "data-markdown-copy": "exclude" }, domText("Plain text")),
  domElement("div", { "data-code-block-source": "true" }, domElement("code", {}, domElement("span", {}, domText(source)))));

test("reply projection excludes the observed code toolbar while preserving literal code, indentation and blank lines", () => {
  const source = "  FORMAT_ONE\n\n    FORMAT_TWO\nFORMAT_THREE\n";
  const root = domElement("div", {}, domElement("div", {}, sourceBlock(source)));
  const isolatedReader = runInNewContext(`(${readBrowserReplyTexts.toString()})`);
  assert.equal(isolatedReader([root])[0], source);
  assert.equal(root.textContent, `Plain text${source}`, "The read does not mutate the browser DOM.");
});

test("reply projection preserves paragraph, BR and code boundaries without removing literal Plain text prose", () => {
  const root = domElement("div", {},
    domElement("p", {}, domText("Literal Plain text belongs to the answer.")),
    domElement("p", {}, domText("Second paragraph"), domElement("br"), domText("continued")),
    sourceBlock("  first\n\n    second"),
    domElement("p", {}, domText("After "), domElement("code", {}, domText("inline")), domText(" code.")));
  assert.equal(readBrowserReplyTexts([root])[0], "Literal Plain text belongs to the answer.\n\nSecond paragraph\ncontinued\n\n  first\n\n    second\n\nAfter inline code.");
});

test("CodeMirror logical lines preserve empty lines and reject incomplete or ambiguous source", () => {
  const editor = domElement("div", { class: "cm-content", "data-language": "python" },
    domElement("div", { class: "cm-line" }, domText("  first")),
    domElement("div", { class: "cm-line" }, domElement("br")),
    domElement("div", { class: "cm-line" }, domText("    last")),
    domElement("div", { class: "cm-line" }, domElement("br")));
  const block = (...content) => domElement("div", { "data-markdown-copy": "code-block" },
    domElement("div", { "data-markdown-copy": "exclude" }, domText("Python")), ...content);
  assert.equal(readBrowserReplyTexts([block(editor)])[0], "  first\n\n    last\n");
  for (const invalid of [
    block(domElement("code", {}, domText("one")), domElement("code", {}, domText("two"))),
    block(editor, editor),
    block(domElement("div", { class: "cm-content", "data-language": "python" }, domElement("div", { class: "spacer" }))),
  ]) assert.throws(() => readBrowserReplyTexts([invalid]), /one complete source/);
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

function fixture({ texts = [], currentPower = 3, fastTimers = false, nativeContext = {}, sessionId = base.sessionId } = {}) {
  const ui = { texts: [...texts], power: currentPower, checked: true, menu: false, chip: false, stop: false,
    complete: false, attachedName: null, typed: [], sendClicks: 0, newTabs: 0, closeCount: 0, handoffs: 0,
    powerMoves: [], present: true, temporary: true, badPowerStep: false, stripChip: false, sendFailure: false, missingPower: false,
    familyText: "GPT-6", familyClicks: 0, saveChat: false, sendEnabled: true, waitedMs: 0,
    composerVisible: true, composerText: "", composerSelected: false, draftCleared: false,
    modelButtonVisible: true, temporaryHeadingVisible: true, navigations: [], replyReads: 0, fetchCalls: 0, stopClicks: 0 };
  let now = 0;
  const fixtureDate = fastTimers ? { now: () => now } : Date;
  const fixtureTimeout = fastTimers ? (callback, milliseconds) => {
    now += milliseconds;
    ui.waitedMs += milliseconds;
    ui.onWait?.();
    callback();
  } : setTimeout;
  const makeLocator = (kind, name) => ({
    getByRole(role, options) { return makeLocator(role, options.name); },
    locator(selector) { return makeLocator("selector", selector); },
    filter({ hasText }) {
      assert.equal(kind, "selector");
      assert.equal(name, '[role="menuitemradio"]');
      return makeLocator("family-text", hasText);
    },
    async count() {
      if (kind === "menuitemradio") return 0; // Visible family text is not its accessible name.
      return kind === "family-text" ? Number(ui.familyText.includes(name)) : name === plugin.pluginSelectionButtonName ? 1 : 0;
    },
    async isVisible() {
      if (name === "Select ChatGPT model" && kind === "menu") return ui.menu;
      if (name === "Select ChatGPT model" && kind === "button") return ui.modelButtonVisible;
      if (name === "Ask ChatGPT" && kind === "textbox") return ui.composerVisible;
      if (name === "Stop") return ui.stop;
      if (name === "Regenerate response") return ui.complete;
      if (name === "Temporary chat") return ui.temporary && ui.temporaryHeadingVisible;
      if (name === "Turn off temporary chat") return ui.temporary;
      if (name === "Save chat") return ui.saveChat;
      if (kind === "selector" && name.startsWith("span[app-mention")) return ui.chip;
      return true;
    },
    async click() {
      if (name === "Select ChatGPT model") ui.menu = !ui.menu;
      else if (kind === "family-text") { ui.familyClicks += 1; ui.checked = true; ui.menu = false; }
      else if (name === plugin.pluginSelectionButtonName) { ui.chip = true; ui.attachedName = name; }
      else if (name === "Send") {
        ui.sendClicks += 1;
        ui.temporary = false;
        ui.saveChat = true;
        ui.url = "https://chatgpt.com/c/owned-conversation?temporary-chat=true";
        ui.composerText = "";
        if (ui.sendFailure) throw new Error("Send effect uncertain");
      }
      else if (name === "Stop") { ui.stopClicks += 1; ui.stop = false; }
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
    async isEnabled() { return name === "Send" ? ui.sendEnabled : true; },
    async waitFor({ state }) { assert.equal(await this.isVisible(), state === "visible"); },
    async allTextContents() {
      if (name === '[role="status"]') return ui.complete ? ["Response complete"] : [];
      throw new Error("Unobserved selector");
    },
    async evaluateAll(callback) {
      assert.equal(name, '[data-markdown-text-style="assistant-message"]');
      ui.replyReads += 1;
      return callback(ui.texts.map(value => typeof value === "string" ? domElement("div", {}, domText(value)) : value));
    },
  });
  const tab = { id: "owned-tab", url: async () => ui.url ?? "https://chatgpt.com/?temporary-chat=true", goto: async url => { ui.url = url; ui.navigations.push(url); },
    playwright: { getByRole: (kind, options) => makeLocator(kind, options.name), locator: name => makeLocator("selector", name) },
    close: async () => { ui.closeCount += 1; ui.present = false; }, markHandoff: async () => { ui.handoffs += 1; } };
  const browser = { browserId: "owned-browser", documentation: async () => "Current public browser docs",
    tabs: { list: async () => ui.present ? [{ id: tab.id, url: await tab.url() }] : [],
      new: async () => { ui.newTabs += 1; return tab; } } };
  const agent = { browsers: { list: async () => [
    { type: "iab", id: "foreign", metadata: { codexSessionId: "other-session" } },
    { type: "iab", id: browser.browserId, metadata: { codexSessionId: sessionId } },
  ], get: async id => { assert.equal(id, browser.browserId); return browser; } } };
  let state = { agent };
  let ownerTurnId;
  const run = async (operation, extra = {}) => {
    let output;
    const options = { ...base, sessionId, operation, ...(operation === "continue" ? { expectedOwnerTurnIds: [ownerTurnId] } : {}), ...extra };
    const code = browserScript(options);
    // Run the actual serialized operation with the persistent native binding as
    // a parameter. Its top-level var shares that parameter's binding, as in REPL.
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("nodeRepl", `routerWeb_${bindingId}`, "Date", "setTimeout", "fetch", "globalThis", `${code}\nreturn routerWeb_${bindingId};`);
    const forbiddenFetch = () => { ui.fetchCalls += 1; throw new Error("Native browser sandbox does not allow loopback fetch."); };
    state = await execute({ write: value => { output = value; } }, state, fixtureDate, fixtureTimeout, forbiddenFetch, nativeContext);
    if (operation === "open" || operation === "continue") ownerTurnId = options.turnId;
    return parseBrowserOutput(output, token);
  };
  const ready = async () => {
    await run("bootstrap", { runtimeModule: "current-runtime.mjs" });
    await run("open");
    await run("model");
    await run("attach", plugin);
  };
  return { ui, run, ready, tab, browser, agent, getState: () => state,
    activeTurn: () => nativeContext.routerWebActiveTurns?.get(sessionId) };
}

test("generated bootstrap reads the current session browser and open waits for Temporary Chat controls", async () => {
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
  assert.deepEqual([open.tabId, open.temporary, open.replyCount], ["owned-tab", true, 0]);
  assert.equal(f.ui.url, "https://chatgpt.com/?temporary-chat=true");
  assert.equal(f.ui.handoffs, 0);
  assert.deepEqual(f.activeTurn(), { turnId: base.turnId, state: f.getState(), stopButtonName: "Stop generating" });
  await assert.rejects(f.run("open"), /already owns/);
});

test("open observes deferred hydration of all four controls without opening or navigating again", async () => {
  const f = fixture({ fastTimers: true });
  await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
  f.ui.composerVisible = false;
  f.ui.modelButtonVisible = false;
  f.ui.temporary = false;
  f.ui.temporaryHeadingVisible = false;
  f.ui.onWait = () => {
    assert.equal(f.activeTurn()?.state.tab, f.tab, "The owned tab is interruptible while its initial controls hydrate.");
    f.ui.composerVisible = f.ui.waitedMs >= 100;
    f.ui.modelButtonVisible = f.ui.waitedMs >= 200;
    f.ui.temporary = f.ui.waitedMs >= 300;
    f.ui.temporaryHeadingVisible = f.ui.waitedMs >= 400;
  };
  const result = await f.run("open");
  assert.equal(result.temporary, true);
  assert.equal(f.ui.waitedMs, 400);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/?temporary-chat=true"]);
  assert.equal(f.ui.sendClicks, 0);
});

test("a missing initial control ends open's bounded hydration wait without navigation retry or Send", async () => {
  for (const control of ["composerVisible", "modelButtonVisible", "temporary", "temporaryHeadingVisible"]) {
    const f = fixture({ fastTimers: true });
    await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
    f.ui[control] = false;
    await assert.rejects(f.run("open"), /controls did not become ready within 10 seconds/);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/?temporary-chat=true"]);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.activeTurn()?.state.tab, f.tab, "A failed initial wait keeps the created tab available for native Interrupt.");
    await assert.rejects(f.run("open"), /already owns/);
    assert.equal(f.ui.newTabs, 1);
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
  assert.equal(f.ui.handoffs, 0);
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

test("readiness cannot permit Send after the app chip or idle Temporary Chat state changes", async () => {
  for (const change of [ui => { ui.chip = false; }, ui => { ui.temporary = false; }, ui => { ui.stop = true; }]) {
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
  const f = fixture({ texts: ["Previous completed answer"] });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Next request" });
  assert.equal(f.ui.temporary, false, "The new-chat controls disappear after Send.");
  assert.equal(f.ui.saveChat, true);
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
  assert.equal(f.ui.handoffs, 1);
  assert.equal(f.activeTurn()?.turnId, base.turnId);
  const next = await f.run("continue", { tabId: "owned-tab", turnId: "following-turn" });
  assert.equal(next.replyCount, 2);
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

test("retained follow-up requires the observed Save chat control and the Temporary Chat URL together", async () => {
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
  f.ui.saveChat = false;
  await assert.rejects(f.run("continue"), /not ready for continuation/, "A URL flag alone cannot authorize reuse.");
  assert.equal(f.activeTurn(), owner, "A rejected continuation cannot replace the retained owner.");
  f.ui.saveChat = true;
  f.ui.url = "https://chatgpt.com/c/owned-conversation";
  await assert.rejects(f.run("continue"), /not ready for continuation/, "An unsaved permanent chat cannot qualify.");
  assert.equal(f.activeTurn(), owner);
  f.ui.url = "https://chatgpt.com/c/owned-conversation?temporary-chat=true";
  assert.equal((await f.run("continue")).temporary, true);
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
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /owned Temporary Chat tab is unavailable/);
  assert.equal(f.ui.newTabs, 1);
});

test("interrupted continuation stops the preceding native owner and starts a new turn in the same Temporary Chat", async () => {
  const f = fixture({ texts: ["Earlier answer"] });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Interrupted request" });
  f.ui.texts.push("  Partial answer\n");
  f.ui.stop = true;
  const result = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, tabId: "owned-tab" });
  assert.deepEqual(result, { operation: "continue", tabId: "owned-tab", replyCount: 2, temporary: true, interrupted: true, assistantText: "  Partial answer\n" });
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
  const f = fixture({ texts: ["Earlier answer"] });
  await f.ready();
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
  assert.equal(f.ui.handoffs, 0);
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
  for (const expectedOwnerTurnIds of [undefined, [], [""], ["not an identity"], [base.turnId, base.turnId]]) {
    assert.throws(() => browserScript({ ...base, operation: "continue", expectedOwnerTurnIds }), /expected native owner identities/);
  }
  assert.throws(() => browserScript({ ...base, operation: "cancel", expectedOwnerTurnIds: [base.turnId] }), /expected native owner identities/);
});
