import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { browserScript, discoverBrowserExecutor, parseBrowserOutput } from "../src/web-browser.mjs";

const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const bindingId = "unit_test";
const base = { bindingId, frameToken: token, modelFamily: "GPT-6", power: 0 };
const plugin = { pluginName: "Current tools", pluginAppId: "asdk_current_123", pluginSelectionButtonName: "Current tools The current tool collection" };
const schema = { type: "object", properties: { code: { type: "string" }, title: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } }, required: ["code"] };
const offered = parameters => [{ type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", parameters }] }];

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

function fixture({ texts = [], currentPower = 3 } = {}) {
  const ui = { texts: [...texts], power: currentPower, checked: true, menu: false, chip: false, stop: false,
    complete: false, attachedName: null, typed: [], sendClicks: 0, newTabs: 0, closeCount: 0, handoffs: 0,
    powerMoves: [], present: true, temporary: true, badPowerStep: false, stripChip: false, sendFailure: false, missingPower: false,
    familyText: "GPT-6", familyClicks: 0, saveChat: false };
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
      if (name === "Stop") return ui.stop;
      if (name === "Regenerate response") return ui.complete;
      if (name === "Temporary chat" || name === "Turn off temporary chat") return ui.temporary;
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
        if (ui.sendFailure) throw new Error("Send effect uncertain");
      }
      else if (name === "Stop") ui.stop = false;
    },
    async getAttribute(attribute) {
      if (attribute === "aria-valuenow" && ui.missingPower) return null;
      return { "aria-checked": String(ui.checked), "aria-valuenow": String(ui.power), "aria-valuemin": "0", "aria-valuemax": "4" }[attribute] ?? null;
    },
    async textContent() { return kind === "family-text" ? ui.familyText : name; },
    async innerText() { return ui.power === 0 ? "GPT-6 Instant" : "GPT-6 Thinking"; },
    async press(key) {
      if (name === "Power") {
        if (key === "Escape") ui.menu = false;
        else { ui.powerMoves.push(key); ui.power += (key === "ArrowLeft" ? -1 : 1) * (ui.badPowerStep ? 2 : 1); }
      }
    },
    async type(text) { ui.typed.push(text); if (ui.stripChip) ui.chip = false; },
    async isEnabled() { return true; },
    async waitFor({ state }) { assert.equal(await this.isVisible(), state === "visible"); },
    async allTextContents() {
      if (name === '[data-markdown-text-style="assistant-message"]') return [...ui.texts];
      if (name === '[role="status"]') return ui.complete ? ["Response complete"] : [];
      throw new Error("Unobserved selector");
    },
  });
  const tab = { id: "owned-tab", url: async () => ui.url ?? "https://chatgpt.com/?temporary-chat=true", goto: async url => { ui.url = url; },
    playwright: { getByRole: (kind, options) => makeLocator(kind, options.name), locator: name => makeLocator("selector", name) },
    close: async () => { ui.closeCount += 1; ui.present = false; }, markHandoff: async () => { ui.handoffs += 1; } };
  const browser = { browserId: "owned-browser", documentation: async () => "Current public browser docs",
    tabs: { list: async () => ui.present ? [{ id: tab.id, url: await tab.url() }] : [],
      new: async () => { ui.newTabs += 1; return tab; } } };
  const agent = { browsers: { list: async () => [
    { type: "iab", id: "foreign", metadata: { codexSessionId: "other-session" } },
    { type: "iab", id: browser.browserId, metadata: { codexSessionId: "current-session" } },
  ], get: async id => { assert.equal(id, browser.browserId); return browser; } } };
  let state = { agent };
  const run = async (operation, extra = {}) => {
    let output;
    const code = browserScript({ ...base, operation, ...extra });
    // Run the actual serialized operation with the persistent native binding as
    // a parameter. Its top-level var shares that parameter's binding, as in REPL.
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("nodeRepl", `routerWeb_${bindingId}`, `${code}\nreturn routerWeb_${bindingId};`);
    state = await execute({ write: value => { output = value; } }, state);
    return parseBrowserOutput(output, token);
  };
  const ready = async () => {
    await run("bootstrap", { sessionId: "current-session", runtimeModule: "current-runtime.mjs" });
    await run("open");
    await run("model");
    await run("attach", plugin);
  };
  return { ui, run, ready, tab, browser, agent, getState: () => state };
}

test("generated bootstrap reads the current session browser and open waits for Temporary Chat controls", async () => {
  const f = fixture();
  const boot = await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
  assert.equal(boot.browserId, "owned-browser");
  assert.equal(boot.browsers.length, 1);
  assert.equal(f.ui.newTabs, 0);
  const open = await f.run("open");
  assert.deepEqual([open.tabId, open.temporary, open.replyCount], ["owned-tab", true, 0]);
  assert.equal(f.ui.url, "https://chatgpt.com/?temporary-chat=true");
  assert.equal(f.ui.handoffs, 0);
  await assert.rejects(f.run("open"), /already owns/);
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
  await f.run("retain");
  assert.equal(f.ui.handoffs, 1);
  const next = await f.run("continue", { tabId: "owned-tab" });
  assert.equal(next.replyCount, 2);
  await f.run("send", { ...plugin, prompt: "Following turn" });
  assert.equal((await f.run("observe", { observeIterations: 1 })).completed, false);
  assert.equal(f.ui.newTabs, 1);
});

test("retained follow-up requires the observed Save chat control and the Temporary Chat URL together", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "First request" });
  f.ui.texts.push("Completed first request"); f.ui.complete = true;
  await f.run("observe", { observeIterations: 1 });
  await f.run("retain");
  f.ui.saveChat = false;
  await assert.rejects(f.run("continue"), /not ready for continuation/, "A URL flag alone cannot authorize reuse.");
  f.ui.saveChat = true;
  f.ui.url = "https://chatgpt.com/c/owned-conversation";
  await assert.rejects(f.run("continue"), /not ready for continuation/, "An unsaved permanent chat cannot qualify.");
  f.ui.url = "https://chatgpt.com/c/owned-conversation?temporary-chat=true";
  assert.equal((await f.run("continue")).temporary, true);
  await f.run("send", { ...plugin, prompt: "Verified follow-up" });
  assert.equal(f.ui.sendClicks, 2);
});

test("a lost retained tab fails continuation without replacing it; cancel stops only the owned tab", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.stop = true;
  assert.deepEqual(await f.run("cancel"), { operation: "cancel", cancelled: true, tabId: "owned-tab", closed: true });
  assert.equal(f.ui.stop, false);
  assert.equal(f.ui.closeCount, 1);
  await assert.rejects(f.run("continue"), /owned Temporary Chat tab is unavailable/);
  assert.equal(f.ui.newTabs, 1);
});

test("bounded observation reads protected local tool state and cancels the owned browser on request", async t => {
  let cancelled = false;
  const controlToken = "current_private_control_token_1234";
  const authorization = [];
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ pendingTool: !cancelled, cancelled }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const controlUrl = `http://127.0.0.1:${server.address().port}/exact-owned-control`;
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Call the current tools" });
  const pending = await f.run("observe", { controlUrl, controlToken, observeIterations: 1 });
  assert.equal(pending.pendingTool, true);
  assert.equal(pending.completed, false);
  assert.equal(f.ui.closeCount, 0);
  cancelled = true;
  f.ui.stop = true;
  const result = await f.run("observe", { controlUrl, controlToken, observeIterations: 1 });
  assert.equal(result.cancelled, true);
  assert.equal(result.closed, true);
  assert.equal(f.ui.stop, false);
  assert.equal(f.ui.closeCount, 1);
  assert.equal(f.ui.handoffs, 0);
  assert.deepEqual(authorization, [`Bearer ${controlToken}`, `Bearer ${controlToken}`]);
});

test("script arguments reject executable binding names and nonlocal control endpoints", () => {
  for (const binding of ['x;alert(1)', "x.y", "x-y", "x\nvar evil"]) assert.throws(() => browserScript({ ...base, operation: "open", bindingId: binding }), /binding ID/);
  assert.throws(() => browserScript({ ...base, operation: "observe", controlUrl: "https://example.com", controlToken: "a".repeat(32) }), /local Web endpoint/);
  assert.throws(() => browserScript({ ...base, operation: "observe", observeIterations: 100 }), /bounded browser/);
});
