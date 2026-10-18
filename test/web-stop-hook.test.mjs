import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

import { createWebStopHookConfig } from "../src/web-stop-hook.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stateDir = path.resolve("generated/web-stop-rollout-20261018/hook/test-state");
const runtimeModule = path.resolve("generated/web-stop-rollout-20261018/hook/public-browser-runtime.mjs");
const config = createWebStopHookConfig({ stateDir, runtimeModule });
const handler = config.hooks.Interrupt[0].hooks[0];
const marker = "ROUTER_WEB_STOP ";

function fixture() {
  const calls = [], outputs = [];
  const model = { now: 0, owner: id(1), turn: id(11), event: "Interrupt", surfaces: new Map(), ledgers: new Map() };
  const context = vm.createContext({ Map, URL, Date: { now: () => model.now } });
  const touch = (name, thread) => { calls.push({ name, thread }); model.onCall?.(name, thread); };
  const forbidden = () => { touch("FORBIDDEN"); throw new Error("A forbidden effect ran"); };
  const ledgerPath = thread => path.join(stateDir, "web-in-app", "conversations", `${thread}.json`);
  context.routerWebActiveTurns = new Map();
  const add = (thread, turn) => {
    const surface = { thread, turn, visible: true, stopCount: 1, tabId: `tab-${thread}`, browserId: `browser-${thread}`,
      url: `https://chatgpt.com/c/${id(Number(thread.slice(-12)) + 100)}` };
    surface.inventoryUrl = surface.url;
    const stop = { count: async () => { touch("count", thread); return surface.stopCount; },
      isVisible: async () => { touch("visible", thread); return surface.visible; },
      click: async options => { assert.equal(options.timeoutMs, 350); touch("click", thread);
        if (surface.pauseClick) await surface.pauseClick; if (!surface.keepVisible) surface.visible = false; },
      waitFor: async options => { assert.equal(options.state, "hidden"); assert.equal(options.timeoutMs, 500); touch("hidden", thread); } };
    const tab = { id: surface.tabId, url: async () => { touch("url", thread); return surface.url; },
      markHandoff: async () => { touch("handoff", thread); }, close: forbidden, goto: forbidden,
      playwright: { getByRole: (role, options) => { assert.equal(role, "button"); assert.equal(options.name, "Stop");
        assert.equal(options.exact, true); touch("locator", thread); return stop; }, locator: forbidden } };
    const browser = { browserId: surface.browserId, tabs: {
      list: async () => { touch("tabs", thread); return surface.tabs ?? [{ id: surface.tabId, url: surface.inventoryUrl }]; },
      get: async tabId => { assert.equal(tabId, surface.tabId); touch("get_tab", thread); return tab; }, new: forbidden } };
    const state = { agent: undefined, browser, tab, tabId: surface.tabId, savedUrl: surface.url, sessionId: thread,
      runtimeModule, hasSentMessage: true, sendAttempted: true, sendClicked: true, sendConfirmed: true,
      closed: false, bindingLost: false, completed: false, interrupted: false, retained: false };
    const active = { turnId: turn, state, stopButtonName: "Stop" };
    const bindingId = `binding_${thread.replaceAll("-", "")}`;
    const key = "routerWeb_" + bindingId;
    const ledger = { version: 1, threadId: thread, bindingId, browserOwnerTurnIds: [turn], tabId: surface.tabId,
      chatUrl: surface.url, uncertainSend: false, lastTurn: { turnId: turn, sendState: "sent", completed: false } };
    model.ledgers.set(ledgerPath(thread), ledger);
    model.surfaces.set(thread, Object.assign(surface, { tab, browser, state, active, key, ledger }));
    context.routerWebActiveTurns.set(thread, active);
    context[key] = state;
    return surface;
  };
  const first = add(id(1), id(11)), second = add(id(2), id(12));
  const agent = { browsers: { list: async () => { touch("browsers", model.owner); return model.browserInventory
    ?? [...model.surfaces.values()].map(item => ({ id: item.browserId, type: "iab", metadata: { codexSessionId: item.thread } })); },
    get: async browserId => { touch("get_browser", model.owner);
      return [...model.surfaces.values()].find(item => item.browserId === browserId)?.browser; } } };
  for (const item of model.surfaces.values()) item.state.agent = agent;
  const metadata = (thread = model.owner, turn = model.turn) => ({ threadId: thread,
    "x-codex-turn-metadata": { thread_id: thread, turn_id: turn, session_id: id(99) } });
  context.nodeRepl = { requestMeta: metadata(), write: value => outputs.push(JSON.parse(value)) };
  const fakeFs = {
    lstatSync: filename => {
      touch("stat", filename);
      if (!model.ledgers.has(filename)) throw Object.assign(new Error("private missing path"), { code: "ENOENT" });
      return { isFile: () => !model.notFile, isSymbolicLink: () => !!model.symlink, dev: 1,
        ino: 1, size: 10, mtimeMs: model.statRevision ?? 1 };
    },
    readFileSync: (filename, encoding) => { assert.equal(encoding, "utf8"); touch("read", filename);
      if (model.readFailure) throw new Error("private prompt or path must never be printed");
      return model.invalidJson ? "not-json" : JSON.stringify(model.ledgers.get(filename)); },
    writeFileSync: forbidden, unlinkSync: forbidden, openSync: forbidden,
  };
  context.__publicImport = async specifier => { touch("import", specifier);
    if (specifier === "node:fs") return fakeFs;
    assert.equal(specifier, pathToFileURL(runtimeModule).href);
    return { setupBrowserRuntime: async () => { touch("setup", model.owner); return agent; } };
  };
  const run = async ({ thread = model.owner, turn = model.turn, event = model.event } = {}) => {
    const source = handler.input.code.replaceAll("${session_id}", thread).replaceAll("${turn_id}", turn)
      .replaceAll("${hook_event_name}", event).replaceAll("import(", "__publicImport(");
    const count = outputs.length;
    await new vm.Script(`(async () => { ${source} })()`).runInContext(context, { timeout: 1000 });
    assert(outputs.length >= count + 1);
    const output = outputs.at(-1);
    assert(!calls.some(call => call.name === "FORBIDDEN"));
    const printed = JSON.stringify(output);
    for (const secret of [first.url, second.url, id(1), id(11), id(99), stateDir, runtimeModule, "private prompt"])
      assert(!printed.includes(secret), "Diagnostics contain no private identity, URL, path, prompt, or raw error");
    return output.systemMessage ? JSON.parse(output.systemMessage.slice(marker.length)) : undefined;
  };
  const fresh = surface => { context.routerWebActiveTurns.delete(surface.thread); delete context[surface.key]; };
  return { model, context, first, second, calls, outputs, agent, metadata, run, fresh, ledgerPath };
}

const mutations = f => f.calls.filter(call => ["click", "handoff"].includes(call.name));
const clicked = f => f.calls.filter(call => call.name === "click");
function stopped(result) {
  assert.equal(result.outcome, "cancelled", JSON.stringify(result));
  assert.equal(result.stopClicked, true);
  assert.equal(result.stopHidden, true);
  assert.equal(result.retained, true);
}
async function blocked(change, expectedCode) {
  const f = fixture();
  change(f);
  const result = await f.run();
  assert.equal(result.outcome, "blocked", JSON.stringify(result));
  if (expectedCode) assert.equal(result.code, expectedCode);
  assert.deepEqual(mutations(f), []);
  assert.equal(f.first.state.retained, false);
  assert.equal(f.first.state.interrupted, false);
  return f;
}

test("generator emits one bounded Interrupt handler and preserves native substitution fields", () => {
  assert.deepEqual(Object.keys(config.hooks), ["Interrupt"]);
  assert.equal(config.hooks.Interrupt.length, 1);
  assert.equal(config.hooks.Interrupt[0].hooks.length, 1);
  assert.equal(handler.type, "mcp_tool"); assert.equal(handler.server, "node_repl"); assert.equal(handler.tool, "js");
  assert.equal(handler.timeout, 3); assert.equal(handler.input.timeout_ms, 2700);
  for (const value of ["${session_id}", "${turn_id}", "${hook_event_name}"]) assert(handler.input.code.includes(value));
  assert.deepEqual(createWebStopHookConfig({ stateDir, runtimeModule }), config);
  for (const changes of [{ stateDir: "relative" }, { runtimeModule: "relative" }, { stateDir: stateDir + "${session_id}" }])
    assert.throws(() => createWebStopHookConfig({ stateDir, runtimeModule, ...changes }), /validated absolute path/u);
});

test("two main/peer Web conversations Stop only their own saved tabs, retaining ordinary owners", async () => {
  const f = fixture();
  stopped(await f.run());
  assert.deepEqual(clicked(f).map(call => call.thread), [f.first.thread]);
  assert.equal(f.first.state.interrupted, true); assert.equal(f.first.state.retained, true);
  assert.equal(f.second.state.interrupted, false); assert.equal(f.second.visible, true);
  f.model.owner = f.second.thread; f.model.turn = f.second.turn;
  f.context.nodeRepl.requestMeta = f.metadata();
  stopped(await f.run());
  assert.deepEqual(clicked(f).map(call => call.thread), [f.first.thread, f.second.thread]);
  assert.equal(f.context.routerWebActiveTurns.size, 2);
  assert.equal(f.context[f.first.key], f.first.state); assert.equal(f.context[f.second.key], f.second.state);
  assert(!f.calls.some(call => call.name === "setup"));
});

test("fresh controller with no ordinary globals retains exact tab and leaves binding absent", async () => {
  const f = fixture();
  delete f.context.routerWebActiveTurns; delete f.context[f.first.key]; delete f.context[f.second.key];
  const result = await f.run(); stopped(result); assert.equal(result.freshController, true);
  assert.equal(f.context.routerWebActiveTurns, undefined); assert.equal(f.context[f.first.key], undefined);
  assert.equal(f.first.state.retained, false, "A discarded old binding is never fabricated or mutated");
  assert.deepEqual(f.calls.filter(call => ["get_browser", "get_tab", "click", "handoff"].includes(call.name)).map(call => call.thread),
    [f.first.thread, f.first.thread, f.first.thread, f.first.thread]);
});

test("fresh target controller preserves a valid peer registry and binding", async () => {
  const f = fixture(); f.fresh(f.first);
  const peer = f.context[f.second.key], registry = f.context.routerWebActiveTurns;
  stopped(await f.run());
  assert.equal(f.context.routerWebActiveTurns, registry); assert.equal(f.context[f.second.key], peer);
  assert.equal(registry.size, 1); assert.equal(f.context[f.first.key], undefined);
  assert.equal(f.second.visible, true);
});

test("simultaneous ordinary conversations in separate VMs retain their own current tabs", async () => {
  const f = fixture(), g = fixture();
  g.model.ledgers = f.model.ledgers;
  g.model.owner = g.second.thread; g.model.turn = g.second.turn; g.context.nodeRepl.requestMeta = g.metadata();
  const results = await Promise.all([f.run(), g.run()]);
  results.forEach(stopped);
  assert.deepEqual(clicked(f).map(call => call.thread), [f.first.thread]);
  assert.deepEqual(clicked(g).map(call => call.thread), [g.second.thread]);
  assert.equal(f.second.visible, true); assert.equal(g.first.visible, true);
});

test("peer registry changes during an await do not revoke this conversation's ownership", async () => {
  const f = fixture(); f.model.onCall = name => {
    if (name === "tabs") f.context.routerWebActiveTurns.set(f.second.thread, { ...f.second.active, turnId: id(500) });
  };
  stopped(await f.run());
  assert.equal(f.context.routerWebActiveTurns.get(f.second.thread).turnId, id(500));
  assert.equal(f.second.visible, true);
});

test("fresh VM after lost globals uses persisted exact identity; duplicate completed Stop stays idle", async () => {
  const f = fixture(); f.fresh(f.first); stopped(await f.run());
  // Reconstruct the VM, retaining only ledger bytes and the public UI outcome.
  const g = fixture(); g.model.ledgers = f.model.ledgers; g.first.visible = f.first.visible;
  delete g.context.routerWebActiveTurns; delete g.context[g.first.key]; delete g.context[g.second.key];
  assert.notEqual(g.context, f.context);
  const result = await g.run();
  assert.equal(result.outcome, "already_idle"); assert.equal(result.stopClicked, false); assert.equal(result.retained, true);
  assert.equal(clicked(f).length, 1); assert.equal(clicked(g).length, 0);
  assert(g.calls.some(call => call.name === "setup"));
});

test("current native model, stale ledger, finished Web turn, invalid scope and missing ledger do nothing", async () => {
  for (const change of [
    f => { f.model.turn = id(1000); f.context.nodeRepl.requestMeta = f.metadata(); },
    f => { f.first.ledger.lastTurn.turnId = id(1001); },
    f => { f.first.ledger.lastTurn.completed = true; },
    f => { f.model.owner = "../../other"; },
    f => { f.model.event = "PostToolUse"; },
    f => { f.model.ledgers.delete(f.ledgerPath(f.first.thread)); },
  ]) {
    const f = fixture(); change(f); assert.equal(await f.run(), undefined);
    assert.deepEqual(mutations(f), []); assert(!f.calls.some(call => ["setup", "browsers", "tabs"].includes(call.name)));
  }
});

test("missing or mismatching canonical metadata never reaches browser controller", async () => {
  for (const change of [
    f => { delete f.context.nodeRepl.requestMeta; },
    f => { delete f.context.nodeRepl.requestMeta["x-codex-turn-metadata"]; },
    f => { f.context.nodeRepl.requestMeta.threadId = f.second.thread; },
    f => { f.context.nodeRepl.requestMeta["x-codex-turn-metadata"].thread_id = f.second.thread; },
    f => { f.context.nodeRepl.requestMeta["x-codex-turn-metadata"].turn_id = f.second.turn; },
    f => { f.context.nodeRepl.requestMeta["x-codex-turn-metadata"].session_id = "forged"; },
    f => { f.context.nodeRepl.requestMeta["x-codex-turn-metadata"] = "{broken"; },
  ]) {
    const f = await blocked(change); assert(!f.calls.some(call => ["setup", "browsers"].includes(call.name)));
  }
  const f = fixture();
  f.context.nodeRepl.requestMeta["x-codex-turn-metadata"] = JSON.stringify(f.context.nodeRepl.requestMeta["x-codex-turn-metadata"]);
  stopped(await f.run());
});

test("unconfirmed Send, bad Stop authority and changed ledger prevent mutation", async () => {
  for (const change of [
    f => { f.first.ledger.uncertainSend = true; },
    f => { f.first.ledger.lastTurn.sendState = "uncertain"; },
    f => { f.first.ledger.lastTurn.sendState = "unsent"; },
    f => { f.first.ledger.browserOwnerTurnIds = [f.second.turn]; },
    f => { f.first.ledger.browserOwnerTurnIds.push(f.first.turn); },
    f => { f.first.ledger.bindingId = "../bad"; },
    f => { f.first.ledger.chatUrl += "?temporary-chat=true"; },
    f => { f.first.state.sendConfirmed = false; },
    f => { f.first.state.sendClicked = false; },
    f => { f.first.state.sendAttempted = false; },
    f => { f.first.state.hasSentMessage = false; },
    f => { f.first.state.bindingLost = true; },
    f => { f.first.state.closed = true; },
  ]) await blocked(change);
});

test("malformed, half-present or foreign existing globals are preserved and denied", async () => {
  for (const change of [
    f => { f.context.routerWebActiveTurns = {}; },
    f => { f.context.routerWebActiveTurns.set(f.first.thread, undefined); },
    f => { f.context.routerWebActiveTurns.delete(f.first.thread); },
    f => { delete f.context[f.first.key]; },
    f => { f.context[f.first.key] = {}; },
    f => { f.first.active.state = f.second.state; },
    f => { f.first.active.turnId = f.second.turn; },
    f => { f.first.state.sessionId = f.second.thread; },
    f => { f.first.state.runtimeModule = "different module"; },
    f => { f.context.routerWebStopHooks = {}; },
  ]) {
    let registry, binding, guards;
    const f = await blocked(h => {
      change(h); registry = h.context.routerWebActiveTurns; binding = h.context[h.first.key]; guards = h.context.routerWebStopHooks;
    });
    assert.equal(f.context.routerWebActiveTurns, registry); assert.equal(f.context[f.first.key], binding);
    assert.equal(f.context.routerWebStopHooks, guards);
  }
});

test("exact saved URL, recorded tab ID and same-session unique browser are all required", async () => {
  for (const change of [
    f => { f.model.browserInventory = [{ id: f.first.browserId, type: "iab", metadata: { codexSessionId: f.second.thread } }]; },
    f => { f.model.browserInventory = [1, 2].map(() => ({ id: f.first.browserId, type: "iab", metadata: { codexSessionId: f.first.thread } })); },
    f => { f.first.browser.browserId = f.second.browserId; },
    f => { f.first.tabs = [{ id: "different-tab-at-same-url", url: f.first.url }]; },
    f => { f.first.tabs = [{ id: f.first.tabId, url: f.first.url }, { id: f.first.tabId, url: f.first.url }]; },
    f => { f.first.inventoryUrl = f.second.url; },
    f => { f.first.url = f.second.url; },
    f => { f.first.tab.id = f.second.tab.id; },
    f => { f.first.stopCount = 2; },
    f => { f.first.stopCount = 0; },
  ]) await blocked(change);
});

test("supported saved-chat query parameters are accepted while full URL ownership remains exact", async () => {
  const setUrl = (surface, url) => {
    surface.ledger.chatUrl = url; surface.state.savedUrl = url; surface.inventoryUrl = url; surface.url = url;
  };
  for (const fresh of [false, true]) {
    const f = fixture(); setUrl(f.first, f.first.url + "?model=gpt-6-sol&source=history");
    if (fresh) f.fresh(f.first);
    stopped(await f.run()); assert.equal(clicked(f).length, 1);
  }
  await blocked(f => {
    setUrl(f.first, f.first.url + "?model=gpt-6-sol");
    f.first.url = f.first.url.replace("gpt-6-sol", "gpt-6-pro");
  }, "tab_url_mismatch");
  for (const transform of [
    url => url + "?temporary-chat=true",
    url => url + "#reply",
    url => url.replace("https://", "https://private-user:private-password@"),
    url => url.replace("https://chatgpt.com", "http://chatgpt.com"),
    url => url.replace("https://chatgpt.com", "https://other.example"),
    url => url + "/extra",
  ]) await blocked(f => { setUrl(f.first, transform(f.first.url)); }, "ledger_invalid");
});

test("metadata, target owner, binding, browser, tab, URL and ledger changes across awaits abort before click", async () => {
  for (const change of [
    f => { f.context.nodeRepl.requestMeta["x-codex-turn-metadata"].turn_id = f.second.turn; },
    f => { f.context.nodeRepl.requestMeta["x-codex-turn-metadata"].session_id = id(98); },
    f => { f.context.routerWebActiveTurns.set(f.first.thread, { ...f.first.active }); },
    f => { f.context[f.first.key] = { ...f.first.state }; },
    f => { f.first.browser.browserId = "changed"; },
    f => { f.first.tab.id = "changed"; },
    f => { f.first.url = f.second.url; },
    f => { f.first.ledger.lastTurn.completed = true; },
    f => { f.first.ledger.tabId = "changed"; },
    f => { f.first.ledger.browserOwnerTurnIds.push(f.second.turn); },
  ]) await blocked(f => { f.model.onCall = name => { if (name === "tabs") change(f); }; });
});

test("fresh setup ownership changes and final pre-click URL changes prevent Stop", async () => {
  await blocked(f => { f.fresh(f.first); f.model.onCall = name => {
    if (name === "setup") f.context.routerWebActiveTurns.set(f.first.thread, f.first.active);
  }; }, "owner_changed");
  await blocked(f => { let urls = 0; f.model.onCall = name => {
    if (name === "url" && ++urls === 2) f.first.url = f.second.url;
  }; }, "tab_url_mismatch");
});

test("late owner change after Stop prevents handoff and does not mark stale state retained", async () => {
  const f = fixture(); f.model.onCall = name => {
    if (name === "click") f.context.routerWebActiveTurns.set(f.first.thread, { ...f.first.active });
  };
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.stopClicked, true); assert.equal(result.retained, false);
  assert.equal(clicked(f).length, 1); assert(!f.calls.some(call => call.name === "handoff"));
  assert.equal(f.first.state.retained, false); assert.equal(f.first.state.interrupted, false);
});

test("late owner change during handoff does not mutate stale retained flags", async () => {
  const f = fixture(); f.model.onCall = name => {
    if (name === "handoff") f.context[f.first.key] = { ...f.first.state };
  };
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.retained, false);
  assert.equal(f.first.state.retained, false); assert.equal(f.first.state.interrupted, false);
});

test("unconfirmed hidden Stop never claims cancellation or repeats its click", async () => {
  const f = fixture(); f.first.keepVisible = true;
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.code, "stop_confirmation_failed");
  assert.equal(result.stopClicked, true); assert.equal(result.stopHidden, false); assert.equal(result.retained, false);
  assert.equal(clicked(f).length, 1); assert(!f.calls.some(call => call.name === "handoff"));
});

test("idle Stop with zero matches retains its tab without claiming cancellation", async () => {
  const f = fixture(); f.first.visible = false; f.first.stopCount = 0;
  const result = await f.run();
  assert.equal(result.outcome, "already_idle"); assert.equal(result.stopClicked, false); assert.equal(result.retained, true);
  assert.equal(f.first.state.interrupted, false); assert.equal(f.first.state.retained, true); assert.equal(clicked(f).length, 0);
});

test("an overlapping same-VM Interrupt cannot click twice and releases only its own guard", async () => {
  const f = fixture(); let release, entered;
  f.first.pauseClick = new Promise(resolve => { release = resolve; });
  const paused = new Promise(resolve => { entered = resolve; });
  f.model.onCall = name => { if (name === "click") entered(); };
  const first = f.run(); await paused;
  const result = await f.run(); assert.equal(result.code, "hook_busy"); assert.equal(clicked(f).length, 1);
  assert.equal(f.context.routerWebStopHooks.size, 1);
  release(); stopped(await first);
  assert.equal(f.context.routerWebStopHooks.size, 0); assert.equal(clicked(f).length, 1);
});

test("budget exhaustion during setup or before mutation prohibits later effects", async () => {
  for (const stage of ["setup", "tabs", "visible"]) await blocked(f => {
    if (stage === "setup") f.fresh(f.first);
    f.model.onCall = name => { if (name === stage) f.model.now = 2401; };
  }, "budget_exhausted");
  await blocked(f => { f.model.onCall = name => { if (name === "visible") f.model.now = 1401; }; }, "budget_exhausted");
  const f = fixture(); f.model.onCall = name => { if (name === "click") f.model.now = 2401; };
  const result = await f.run(); assert.equal(result.code, "budget_exhausted"); assert.equal(result.retained, false);
  assert.equal(clicked(f).length, 1); assert(!f.calls.some(call => call.name === "handoff"));
});

test("ledger file replacement, symlink and opaque browser errors fail safely without private diagnostics", async () => {
  const f = fixture(); let reads = 0;
  f.model.onCall = name => { if (name === "read" && ++reads === 2) f.model.statRevision = 2; };
  const result = await f.run(); assert.equal(result.code, "ledger_changed"); assert.deepEqual(mutations(f), []);
  const g = fixture(); g.model.symlink = true;
  assert.equal(await g.run(), undefined); assert.deepEqual(mutations(g), []);
  await blocked(h => { h.agent.browsers.list = async () => { throw new Error("private prompt or path must never be printed"); }; },
    "browser_operation_failed");
});
