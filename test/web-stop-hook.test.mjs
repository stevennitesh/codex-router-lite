import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

import { createWebStopCode } from "../src/web-stop-hook.mjs";
import { stopCode } from "../src/web-stop-adapter.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stateDir = path.resolve("generated/web-stop-rollout-20261018/hook/test-state");
const runtimeModule = path.resolve("generated/web-stop-rollout-20261018/hook/public-browser-runtime.mjs");
const marker = "ROUTER_WEB_STOP ";

function fixture(stopConfig = { stateDir, runtimeModule }) {
  const { stateDir, runtimeModule } = stopConfig;
  const calls = [], outputs = [];
  const model = { now: 0, owner: id(1), turn: id(11), surfaces: new Map(), ledgers: new Map() };
  const context = vm.createContext({ Map, URL, Date: { now: () => model.now } });
  const touch = (name, thread) => { calls.push({ name, thread }); model.onCall?.(name, thread); };
  context.setTimeout = (callback, milliseconds) => {
    model.now += milliseconds;
    touch("wait", model.owner);
    callback();
  };
  const forbidden = () => { touch("FORBIDDEN"); throw new Error("A forbidden effect ran"); };
  const ledgerPath = thread => path.join(stateDir, "web-in-app", "conversations", `${thread}.json`);
  context.routerWebActiveTurns = new Map();
  const add = (thread, turn) => {
    const surface = { thread, turn, visible: true, complete: false, stopCount: 1,
      generationTurnKey: id(Number(thread.slice(-12)) + 200), tabId: `tab-${thread}`, browserId: `browser-${thread}`,
      url: `https://chatgpt.com/c/${id(Number(thread.slice(-12)) + 100)}` };
    surface.inventoryUrl = surface.url;
    const matchesGuard = () => {
      const keys = surface.turnKeys ?? [surface.generationTurnKey];
      return keys.filter(key => key === stop.guardGeneration).length === 1 && keys.at(-1) === stop.guardGeneration;
    };
    const stop = { click: async options => {
        assert(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 2400);
        touch("click_request", thread);
        if (!matchesGuard()) throw new Error("No element matched the guarded Stop selector");
        surface.clickTimeoutMs = options.timeoutMs; touch("click", thread);
        if (surface.pauseClick) await surface.pauseClick;
        const acknowledgementMs = surface.clickAcknowledgementMs ?? 0;
        model.now += Math.min(acknowledgementMs, options.timeoutMs);
        if (!surface.keepVisible) { surface.visible = false; surface.complete = !surface.keepGenerating; }
        if (acknowledgementMs > options.timeoutMs || surface.clickError) {
          model.now += surface.errorDiagnosticsMs ?? 0;
          throw surface.clickError ?? new Error('Timed out running CDP command "Input.dispatchMouseEvent"');
        }
      } };
    const tab = { id: surface.tabId, url: async () => { touch("url", thread); return surface.url; },
      markHandoff: async () => { touch("handoff", thread); }, close: forbidden, goto: forbidden,
      playwright: { getByRole: forbidden,
        locator: selector => {
          if (selector !== "body") {
            const key = /\[@data-turn-key='([a-f0-9-]+)'\]/u.exec(selector)?.[1];
            assert.equal(selector, `xpath=//body[count(//*[@data-turn-key='${key}'])=1 and (//*[@data-turn-key])[last()][@data-turn-key='${key}']]`);
            stop.guardGeneration = key;
            return { getByRole: (role, options) => {
              assert.equal(role, "button"); assert.equal(options.name, "Stop"); assert.equal(options.exact, true);
              touch("locator", thread); return stop;
            } };
          }
          return { or: other => { assert.equal(other, stop); return { evaluateAll: async (reader, args, options) => {
            assert(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 1000);
            touch("generation", thread);
            if (surface.generationReadError) throw surface.generationReadError;
            touch("visible", thread);
            const turns = (surface.turnKeys ?? [surface.generationTurnKey]).map(turnKey => ({
              getAttribute: name => { assert.equal(name, 'data-turn-key'); return turnKey; },
              querySelectorAll: name => {
                assert.equal(name, '[data-talvt-turn-state]');
                return Array.from({ length: surface.stateCount ?? 1 }, () => ({ getAttribute: attribute => {
                  assert.equal(attribute, 'data-talvt-turn-state'); return surface.turnState ?? (surface.complete ? 'complete' : 'running');
                } }));
              },
            }));
            const body = { tagName: "BODY" };
            body.ownerDocument = { body, URL: surface.url, defaultView: {
              getComputedStyle: () => ({ visibility: surface.visibilityStyle ?? "visible" }),
            }, querySelectorAll: name => { assert.equal(name, '[data-turn-key]'); return turns; } };
            const controls = matchesGuard() ? Array.from({ length: surface.stopCount }, () => ({
              tagName: "BUTTON", getBoundingClientRect: () => ({ width: surface.visible ? 32 : 0, height: surface.visible ? 32 : 0 }),
            })) : [];
            return reader([body, ...controls], args);
          } }; } };
        } } };
    const browser = { browserId: surface.browserId, tabs: {
      list: async () => { touch("tabs", thread); return surface.tabs ?? [{ id: surface.tabId, url: surface.inventoryUrl }]; },
      get: async tabId => { assert.equal(tabId, surface.tabId); touch("get_tab", thread); return tab; }, new: forbidden } };
    const state = { agent: undefined, browser, tab, tabId: surface.tabId, savedUrl: surface.url, sessionId: thread,
      runtimeModule, hasSentMessage: true, sendAttempted: true, sendClicked: true, sendConfirmed: true,
      generationTurnKey: surface.generationTurnKey, bindingLost: false, completed: false, retained: false };
    const active = { turnId: turn, state, stopButtonName: "Stop" };
    const bindingId = `binding_${thread.replaceAll("-", "")}`;
    const key = "routerWeb_" + bindingId;
    const ledger = { version: 1, threadId: thread, bindingId, browserOwnerTurnIds: [turn], tabId: surface.tabId,
      chatUrl: surface.url, generationTurnKey: surface.generationTurnKey,
      uncertainSend: false, lastTurn: { turnId: turn, sendState: "sent", completed: false } };
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
  const run = async ({ thread = model.owner, turn = model.turn, budgetMs, delivery } = {}) => {
    const identity = { threadId: thread, turnId: turn, sessionId: id(99) };
    const source = stopCode(stopConfig, identity, budgetMs, delivery)
      .replaceAll("import(", "__publicImport(");
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
  assert.equal(result.clickAttempted, true);
  assert.equal(result.clickError, false);
  assert.equal(result.stopHidden, true);
  assert.equal(result.generationInactive, true);
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
  return f;
}

test("Stop code generator bounds its budget and requires absolute configuration paths", () => {
  const identity = { threadId: id(1), turnId: id(11), sessionId: id(99) };
  for (const budgetMs of [0, -1, 2401, 2250.5, "2250", NaN])
    assert.throws(() => createWebStopCode({ stateDir, runtimeModule }, identity, { budgetMs }), /budget/u);
  for (const changes of [{ stateDir: "relative" }, { runtimeModule: "relative" }, { stateDir: stateDir + "\0" }])
    assert.throws(() => createWebStopCode({ stateDir, runtimeModule, ...changes }, identity), /validated absolute path/u);
});

test("the adapter's generated Stop program preserves escaped paths as data", async () => {
  const suffix = '\'"; globalThis.injected = true; //${session_id}';
  const f = fixture({ stateDir: stateDir + suffix, runtimeModule: runtimeModule + suffix });
  stopped(await f.run());
  assert.equal(f.context.injected, undefined);
  assert.equal(clicked(f).length, 1);
});

test("the remaining callback budget bounds Stop while preserving the earlier verified retention", async () => {
  const f = fixture(); f.model.onCall = name => { if (name === "visible") f.model.now = 1251; };
  const blocked = await f.run({ budgetMs: 2250 });
  assert.equal(blocked.code, "budget_exhausted"); assert.equal(clicked(f).length, 0);
  assert.equal(blocked.retained, true);
  const g = fixture(); g.first.keepVisible = true;
  const expired = await g.run({ budgetMs: 1200 });
  assert.equal(expired.outcome, "blocked"); assert.equal(expired.stopClicked, true);
  assert.equal(expired.stopHidden, false); assert.equal(expired.retained, true);
  assert(expired.elapsedMs <= 1200); assert.equal(clicked(g).length, 1);
  assert.deepEqual(mutations(g).map(call => call.name), ["handoff", "click"]);
  const h = fixture(); stopped(await h.run({ budgetMs: 2250 }));
});

test("a 600 ms click acknowledgement after setup succeeds within the reduced original cleanup budget", async () => {
  const f = fixture();
  f.model.onCall = name => { if (name === "tabs") f.model.now += 300; };
  f.first.clickAcknowledgementMs = 600;
  const result = await f.run({ budgetMs: 1500 }); stopped(result);
  assert.equal(result.elapsedMs, 900);
  assert(f.first.clickTimeoutMs >= 600 && f.first.clickTimeoutMs <= 1200);
  assert.equal(clicked(f).length, 1);
  assert.deepEqual(mutations(f).map(call => call.name), ["handoff", "click"]);
  assert.equal(f.calls.filter(call => call.name === "visible").length, 3);
});

test("a rejected click acknowledgement permits owned inactive readback without claiming its effect", async () => {
  const f = fixture();
  f.model.onCall = name => { if (name === "tabs") f.model.now += 300; };
  f.first.clickAcknowledgementMs = 1300;
  const result = await f.run({ budgetMs: 1500 });
  assert.equal(result.outcome, "already_idle"); assert.equal(result.code, undefined);
  assert.equal(result.clickAttempted, true); assert.equal(result.clickError, true);
  assert.equal(result.stopClicked, false); assert.equal(result.stopHidden, true); assert.equal(result.retained, true);
  assert.equal(result.generationInactive, true);
  assert.equal(result.elapsedMs, 300 + f.first.clickTimeoutMs);
  assert(result.elapsedMs <= 1500);
  assert.equal(clicked(f).length, 1);
  assert.equal(f.calls.filter(call => call.name === "visible").length, 3);
  assert.deepEqual(mutations(f).map(call => call.name), ["handoff", "click"]);
});

test("a click effect followed by SDK rejection retains and verifies inactivity without claiming acknowledgement", async () => {
  const f = fixture();
  f.first.clickAcknowledgementMs = 100;
  f.first.clickError = new Error("private actual CDP failure");
  const result = await f.run();
  assert.equal(f.first.visible, false, "The page effect does not prove that the click acknowledged successfully.");
  assert.equal(result.outcome, "already_idle"); assert.equal(result.code, undefined);
  assert.equal(result.clickAttempted, true); assert.equal(result.clickError, true);
  assert.equal(result.stopClicked, false); assert.equal(result.stopHidden, true); assert.equal(result.retained, true);
  assert.equal(result.generationInactive, true);
  assert.equal(clicked(f).length, 1);
  assert.equal(f.calls.filter(call => call.name === "visible").length, 3);
  assert.deepEqual(mutations(f).map(call => call.name), ["handoff", "click"]);
  assert(!JSON.stringify(result).includes("private actual CDP failure"));
});

test("two main/peer Web conversations Stop only their own saved tabs, retaining ordinary owners", async () => {
  const f = fixture();
  stopped(await f.run());
  assert.deepEqual(clicked(f).map(call => call.thread), [f.first.thread]);
  assert.equal(f.first.state.retained, true); assert.equal(f.second.visible, true);
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
  const g = fixture(); g.model.ledgers = f.model.ledgers; g.first.visible = f.first.visible; g.first.complete = f.first.complete;
  delete g.context.routerWebActiveTurns; delete g.context[g.first.key]; delete g.context[g.second.key];
  assert.notEqual(g.context, f.context);
  const result = await g.run();
  assert.equal(result.outcome, "already_idle"); assert.equal(result.stopClicked, false); assert.equal(result.retained, true);
  assert.equal(clicked(f).length, 1); assert.equal(clicked(g).length, 0);
  assert(g.calls.some(call => call.name === "setup"));
});

test("current native model, stale ledger, finished Web turn and missing ledger do nothing", async () => {
  for (const change of [
    f => { f.model.turn = id(1000); f.context.nodeRepl.requestMeta = f.metadata(); },
    f => { f.first.ledger.lastTurn.turnId = id(1001); },
    f => { f.first.ledger.lastTurn.completed = true; },
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
    f => { f.context.nodeRepl.requestMeta["x-codex-turn-metadata"].session_id = id(98); },
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

test("fresh setup ownership changes and a changed URL in the coherent proof prevent Stop", async () => {
  await blocked(f => { f.fresh(f.first); f.model.onCall = name => {
    if (name === "setup") f.context.routerWebActiveTurns.set(f.first.thread, f.first.active);
  }; }, "owner_changed");
  await blocked(f => { f.model.onCall = name => {
    if (name === "generation") f.first.url = f.second.url;
  }; }, "tab_url_mismatch");
});

test("late owner change after Stop preserves earlier retention and prevents later browser work", async () => {
  const f = fixture(); f.model.onCall = name => {
    if (name === "click") f.context.routerWebActiveTurns.set(f.first.thread, { ...f.first.active });
  };
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.stopClicked, true); assert.equal(result.retained, true);
  assert.equal(clicked(f).length, 1);
  assert.deepEqual(mutations(f).map(call => call.name), ["handoff", "click"]);
  assert.equal(f.first.state.retained, true);
  assert.equal(f.calls.at(-1).name, "click");
});

test("late owner change during handoff does not mutate stale retained flags", async () => {
  const f = fixture(); f.model.onCall = name => {
    if (name === "handoff") f.context[f.first.key] = { ...f.first.state };
  };
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.retained, false);
  assert.equal(f.first.state.retained, false);
});

test("Stop acknowledgement after 500ms confirms the same tab with one click within the original budget", async () => {
  const f = fixture(); f.first.keepVisible = true;
  const tab = f.first.state.tab;
  f.model.onCall = name => { if (name === "wait" && f.model.now >= 700) { f.first.visible = false; f.first.complete = true; } };
  const result = await f.run(); stopped(result);
  assert(result.elapsedMs >= 700 && result.elapsedMs < 2400);
  assert.equal(clicked(f).length, 1);
  assert.equal(f.first.state.tab, tab);
  assert.deepEqual(mutations(f).map(call => call.name), ["handoff", "click"]);
  assert(f.calls.filter(call => call.name === "visible").length > 2);
});

test("persistently visible Stop exhausts confirmation without claiming cancellation or repeating its click", async () => {
  const f = fixture(); f.first.keepVisible = true;
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.code, "stop_confirmation_failed");
  assert.equal(result.stopClicked, true); assert.equal(result.stopHidden, false); assert.equal(result.retained, true);
  assert(result.elapsedMs > 500 && result.elapsedMs < 2400);
  assert.equal(clicked(f).length, 1); assert.equal(f.calls.filter(call => call.name === "handoff").length, 1);
});

test("authority and saved URL changes during confirmation reads or delays prevent further Stop polling or retention", async () => {
  for (const boundary of ["visible", "wait"]) for (const change of ["metadata", "owner", "ledger", "url"]) {
    const f = fixture(); f.first.keepVisible = true;
    let visibilityReads = 0, changedAt;
    f.model.onCall = name => {
      if (name === "visible") visibilityReads++;
      if (changedAt !== undefined || name !== boundary || name === "visible" && visibilityReads !== 3) return;
      if (change === "metadata") f.context.nodeRepl.requestMeta["x-codex-turn-metadata"].turn_id = f.second.turn;
      if (change === "owner") f.context.routerWebActiveTurns.set(f.first.thread, { ...f.first.active });
      if (change === "ledger") f.first.ledger.lastTurn.completed = true;
      if (change === "url") f.first.url = f.second.url;
      changedAt = f.calls.length;
    };
    const result = await f.run();
    assert.equal(result.outcome, "blocked");
    assert.equal(result.code, { metadata: "metadata_mismatch", owner: "owner_changed", ledger: "ledger_invalid", url: "tab_url_mismatch" }[change]);
    assert.equal(result.stopClicked, true); assert.equal(result.stopHidden, false); assert.equal(result.retained, true);
    assert.equal(clicked(f).length, 1); assert.equal(f.calls.filter(call => call.name === "handoff").length, 1);
    assert(!f.calls.slice(changedAt).some(call => ["click", "handoff", "wait"].includes(call.name)));
  }
});

test("a confirmation visibility-read error fails closed without retrying or exposing browser details", async () => {
  const f = fixture(); let visibilityReads = 0;
  f.model.onCall = name => {
    if (name === "visible" && ++visibilityReads === 3) throw new Error("private browser details");
  };
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.code, "browser_operation_failed");
  assert.equal(result.stage, "stop_readback_visibility");
  assert.equal(result.stopClicked, true); assert.equal(result.stopHidden, false); assert.equal(result.retained, true);
  assert.equal(visibilityReads, 3); assert.equal(clicked(f).length, 1);
  assert(!f.calls.some(call => call.name === "wait"));
  assert(!JSON.stringify(result).includes("private browser details"));
});

test("a late hidden read cannot claim success after the cleanup deadline", async () => {
  const f = fixture(); let visibilityReads = 0;
  f.model.onCall = name => { if (name === "visible" && ++visibilityReads === 3) f.model.now = 2401; };
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.code, "budget_exhausted");
  assert.equal(result.stopClicked, true); assert.equal(result.stopHidden, false); assert.equal(result.retained, true);
  assert.equal(clicked(f).length, 1); assert.equal(f.calls.filter(call => call.name === "handoff").length, 1);
});

test("idle Stop with zero matches retains its tab without claiming cancellation", async () => {
  const f = fixture(); f.first.visible = false; f.first.stopCount = 0; f.first.complete = true;
  const result = await f.run();
  assert.equal(result.outcome, "already_idle"); assert.equal(result.stopClicked, false); assert.equal(result.retained, true);
  assert.equal(f.first.state.retained, true); assert.equal(clicked(f).length, 0);
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
  const retained = fixture(); retained.model.onCall = name => { if (name === "visible") retained.model.now = 1401; };
  const beforeClick = await retained.run();
  assert.equal(beforeClick.code, "budget_exhausted"); assert.equal(beforeClick.retained, true); assert.equal(clicked(retained).length, 0);
  const f = fixture(); f.model.onCall = name => { if (name === "click") f.model.now = 2401; };
  const result = await f.run(); assert.equal(result.code, "budget_exhausted"); assert.equal(result.retained, true);
  assert.equal(clicked(f).length, 1); assert.equal(f.calls.filter(call => call.name === "handoff").length, 1);
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

test("hidden Stop while the owned generation is running never establishes idle", async () => {
  const f = fixture(); f.first.visible = false; f.first.stopCount = 0;
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.code, "stop_confirmation_failed");
  assert.equal(result.stopHidden, true); assert.equal(result.generationInactive, false);
  assert.equal(result.clickAttempted, false); assert.equal(result.clickError, false);
  assert.equal(result.retained, true); assert.equal(clicked(f).length, 0);
});

test("a transiently missing Stop can appear before the single semantic click", async () => {
  const f = fixture(); f.first.visible = false; f.first.stopCount = 0;
  f.model.onCall = name => {
    if (name === "wait") { f.first.visible = true; f.first.stopCount = 1; }
  };
  stopped(await f.run());
  assert.equal(clicked(f).length, 1);
  assert.deepEqual(mutations(f).map(call => call.name), ["handoff", "click"]);
});

test("the saved generation must be unique and latest before any tab effect", async () => {
  for (const turnKeys of [[], [id(500)], [id(201), id(201)], [id(201), id(500)]]) {
    await blocked(f => { f.first.turnKeys = turnKeys; }, "generation_mismatch");
  }
  for (const change of [
    f => { delete f.first.ledger.generationTurnKey; },
    f => { f.first.ledger.generationTurnKey = "invalid"; },
    f => { f.first.state.generationTurnKey = id(500); },
  ]) await blocked(change);
});

test("generation identity changes in the ledger or binding revoke authority across awaits", async () => {
  await blocked(f => { f.model.onCall = name => {
    if (name === "tabs") f.first.ledger.generationTurnKey = id(500);
  }; }, "ledger_changed");
  await blocked(f => { f.model.onCall = name => {
    if (name === "generation") f.first.state.generationTurnKey = id(500);
  }; }, "owner_changed");
});

test("a successor appearing during handoff or semantic action resolution is never clicked", async () => {
  for (const boundary of ["handoff", "click_request"]) {
    const f = fixture(); f.model.onCall = name => {
      if (name === boundary) f.first.turnKeys = [f.first.generationTurnKey, id(500)];
    };
    const result = await f.run();
    assert.equal(result.outcome, "blocked"); assert.equal(result.code, "generation_mismatch");
    assert.equal(result.retained, true);
    assert.equal(clicked(f).length, 0); assert.equal(result.stopClicked, false);
    assert.equal(result.clickAttempted, boundary === "click_request");
    assert.equal(f.calls.filter(call => call.name === "handoff").length, 1);
  }
});

test("pre-click and final inactive proofs do not reopen a successor insertion window through a URL RPC", async () => {
  for (const phase of ["before-click", "final-readback"]) {
    const f = fixture(); let gapOpened = false;
    const url = f.first.tab.url;
    f.first.tab.url = async () => {
      const proofReads = f.calls.filter(call => call.name === "generation").length;
      if (phase === "before-click" ? proofReads >= 2 && !f.first.complete : f.first.complete) {
        gapOpened = true;
        f.first.turnKeys = [f.first.generationTurnKey, id(500)];
      }
      return url();
    };
    stopped(await f.run());
    assert.equal(gapOpened, false);
    assert(!f.calls.some(call => call.name === "url"), "URL and generation evidence come from one DOM read");
    assert.equal(clicked(f).length, 1);
  }
});

test("natural completion during a rejected click reports verified idle with explicit action uncertainty", async () => {
  const f = fixture(); f.first.keepVisible = true;
  f.first.clickError = new Error("The requested Stop target disappeared");
  f.model.onCall = name => {
    if (name === "click") { f.first.visible = false; f.first.complete = true; }
  };
  const result = await f.run();
  assert.equal(result.outcome, "already_idle"); assert.equal(result.clickAttempted, true);
  assert.equal(result.clickError, true); assert.equal(result.stopClicked, false);
  assert.equal(result.generationInactive, true); assert.equal(result.stopHidden, true); assert.equal(result.retained, true);
  assert.equal(clicked(f).length, 1);
});

test("a genuine rejected click with a still-running generation stays blocked and is not retried", async () => {
  const f = fixture(); f.first.keepVisible = true; f.first.clickError = new Error("private dispatch failure");
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.code, "browser_operation_failed");
  assert.equal(result.clickAttempted, true); assert.equal(result.clickError, true); assert.equal(result.stopClicked, false);
  assert.equal(result.generationInactive, false); assert.equal(result.stopHidden, false); assert.equal(result.retained, true);
  assert.equal(clicked(f).length, 1); assert(!f.calls.some(call => call.name === "wait"));
});

test("a locator rejection whose diagnostics outlive the deadline cannot start readback or lose earlier retention", async () => {
  const f = fixture(); f.first.clickError = new Error("private dispatch failure"); f.first.errorDiagnosticsMs = 2500;
  const result = await f.run();
  assert.equal(result.outcome, "blocked"); assert.equal(result.code, "budget_exhausted");
  assert.equal(result.clickAttempted, true); assert.equal(result.clickError, true); assert.equal(result.stopClicked, false);
  assert.equal(result.generationInactive, false); assert.equal(result.retained, true);
  assert.equal(f.calls.filter(call => call.name === "visible").length, 2); assert.equal(clicked(f).length, 1);
});

test("an unreadable rendered generation fails before tab effects without exposing its details", async () => {
  const f = await blocked(g => { g.first.generationReadError = new Error("private rendered content"); }, "browser_operation_failed");
  assert(!JSON.stringify(f.outputs).includes("private rendered content"));
});

test("acknowledged Stop and hidden controls still require a positively complete owned generation", async () => {
  for (const change of [
    f => { f.first.keepGenerating = true; },
    f => { f.first.turnState = "stopped"; },
    f => { f.first.stateCount = 0; },
    f => { f.first.stateCount = 2; },
  ]) {
    const f = fixture(); change(f);
    const result = await f.run();
    assert.equal(result.outcome, "blocked"); assert.equal(result.stopClicked, true);
    assert.equal(result.stopHidden, true); assert.equal(result.generationInactive, false); assert.equal(result.retained, true);
    assert.equal(clicked(f).length, 1);
  }
});

const deliveryFor = f => ({ bindingId: f.first.ledger.bindingId, tabId: f.first.tabId,
  url: f.first.url, generationTurnKey: f.first.generationTurnKey });
const makeUncertainLedger = f => {
  f.first.ledger.uncertainSend = true; f.first.ledger.lastTurn.sendState = "uncertain";
};

test("only exact confirmed Send delivery can cancel before Router consumes its result", async () => {
  for (const fresh of [false, true]) for (const previous of [false, true]) {
    const f = fixture(), delivery = deliveryFor(f); makeUncertainLedger(f);
    if (previous) { f.first.ledger.chatUrl = f.second.url; f.first.ledger.generationTurnKey = id(500); }
    else { delete f.first.ledger.chatUrl; delete f.first.ledger.generationTurnKey; }
    if (fresh) f.fresh(f.first);
    const before = JSON.stringify(f.first.ledger);
    stopped(await f.run({ delivery }));
    assert.equal(JSON.stringify(f.first.ledger), before, "Stop never settles the replay ledger itself");
  }
  await blocked(f => { makeUncertainLedger(f); delete f.first.ledger.generationTurnKey; }, "ledger_invalid");
});

test("delivery facts cannot bypass a conflicting binding, tab, browser generation or completed owner", async () => {
  for (const fresh of [false, true]) for (const change of [
    delivery => { delivery.bindingId = "differentBinding"; },
    delivery => { delivery.tabId = "different-tab"; },
    delivery => { delivery.url = `https://chatgpt.com/c/${id(500)}`; },
    delivery => { delivery.generationTurnKey = id(500); },
  ]) {
    const f = fixture(), delivery = deliveryFor(f); makeUncertainLedger(f); change(delivery);
    if (fresh) f.fresh(f.first);
    const result = await f.run({ delivery });
    assert.equal(result.outcome, "blocked"); assert.deepEqual(mutations(f), []);
  }
  const f = fixture(), delivery = deliveryFor(f); makeUncertainLedger(f); f.first.ledger.lastTurn.completed = true;
  assert.equal(await f.run({ delivery }), undefined); assert.deepEqual(mutations(f), []);
});

test("an effective delivery target still fences every raw ledger change", async () => {
  const f = fixture(), delivery = deliveryFor(f); makeUncertainLedger(f);
  f.model.onCall = name => { if (name === "tabs") f.first.ledger.generationTurnKey = id(500); };
  const result = await f.run({ delivery });
  assert.equal(result.code, "ledger_changed"); assert.deepEqual(mutations(f), []);
});

test("the Stop generator accepts only the exact confirmed-delivery schema", () => {
  const f = fixture(), identity = { threadId: f.first.thread, turnId: f.first.turn, sessionId: id(99) };
  for (const delivery of [null, [], {}, { ...deliveryFor(f), extra: true },
    { ...deliveryFor(f), bindingId: "../bad" }, { ...deliveryFor(f), tabId: "" },
    { ...deliveryFor(f), url: "https://chatgpt.com/" }, { ...deliveryFor(f), generationTurnKey: "bad" }]) {
    assert.throws(() => createWebStopCode({ stateDir, runtimeModule }, identity, { delivery }), /exact confirmed browser facts/u);
  }
});
