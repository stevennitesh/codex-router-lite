import path from "node:path";
import { pathToFileURL } from "node:url";

// Serialized into the native JS tool: no Router module, secret, or cached
// request metadata is imported. The caller owns validation/protection of stateDir
// and runtimeModule; Router's atomic ledger writer preserves its private ACL.
async function stopOwnedWebTurn() {
  const nativeThread = '__NATIVE_SESSION__';
  const nativeTurn = '__NATIVE_TURN__';
  const nativeEvent = '__NATIVE_EVENT__';
  const config = '__CONFIG__';
  const started = Date.now(), deadline = started + 2400;
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
  const nonempty = value => typeof value === "string" && value.length > 0;
  const normalUrl = value => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.origin === "https://chatgpt.com" && /^\/c\/[A-Za-z0-9-]+$/u.test(url.pathname)
        && !url.searchParams.has("temporary-chat") && !url.hash && !url.username && !url.password;
    } catch { return false; }
  };
  const codes = new Set(["metadata_missing", "metadata_mismatch", "ledger_invalid", "ledger_changed", "ledger_unreadable",
    "registry_invalid", "owner_mismatch", "owner_changed", "state_unavailable", "controller_invalid",
    "browser_ambiguous", "browser_mismatch", "tab_ambiguous", "tab_mismatch", "tab_url_mismatch",
    "stop_confirmation_failed", "budget_exhausted", "hook_busy", "hook_registry_invalid"]);
  const deny = code => { throw Object.assign(new Error(), { stopCode: code }); };
  const budget = (reserve = 0) => { if (deadline - Date.now() < reserve) deny("budget_exhausted"); };
  let inScope = false, stage = "scope", outcome = "blocked", code;
  let guards, guard, key, registry, active, state;
  const diagnostic = { freshController: false, stopClicked: false, stopHidden: false, retained: false };
  try {
    // A native route (or an older Web turn in the same native conversation) has
    // no current confirmed Web delivery in this exact UUID-derived file.
    if (nativeEvent !== "Interrupt" || !uuid(nativeThread) || !uuid(nativeTurn)) return;
    const recordPath = config.ledgerDirectory + nativeThread + ".json";
    const fs = await import("node:fs");
    const readLedger = (initial = false) => {
      budget();
      let value;
      try {
        const before = fs.lstatSync(recordPath);
        if (!before.isFile() || before.isSymbolicLink()) deny("ledger_invalid");
        value = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        const after = fs.lstatSync(recordPath);
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs) deny("ledger_changed");
      } catch (error) {
        if (initial && error?.code === "ENOENT") return;
        if (codes.has(error?.stopCode)) throw error;
        deny("ledger_unreadable");
      }
      const last = value?.lastTurn;
      if (initial && (!record(value) || value.threadId !== nativeThread || !record(last)
          || last.turnId !== nativeTurn || last.completed === true)) return;
      if (initial) inScope = true;
      // Only the fields which authorize Stop are needed. History, compaction,
      // and reply-recovery schemas remain owned by the ordinary Web runtime.
      if (!record(value) || value.version !== 1 || value.threadId !== nativeThread
          || typeof value.bindingId !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,100}$/u.test(value.bindingId)
          || !Array.isArray(value.browserOwnerTurnIds) || !value.browserOwnerTurnIds.every(uuid)
          || new Set(value.browserOwnerTurnIds).size !== value.browserOwnerTurnIds.length
          || !value.browserOwnerTurnIds.includes(nativeTurn) || !nonempty(value.tabId) || !normalUrl(value.chatUrl)
          || value.uncertainSend !== false || !record(last) || last.turnId !== nativeTurn
          || last.sendState !== "sent" || last.completed !== false) deny("ledger_invalid");
      return value;
    };
    stage = "ledger";
    const ledger = readLedger(true);
    if (!ledger) return;
    const tuple = value => JSON.stringify([value.version, value.threadId, value.bindingId,
      value.browserOwnerTurnIds, value.tabId, value.chatUrl, value.uncertainSend,
      value.lastTurn.turnId, value.lastTurn.sendState, value.lastTurn.completed]);
    const ledgerTuple = tuple(ledger);
    key = "routerWeb_" + ledger.bindingId;
    const actualMetadata = () => {
      const meta = nodeRepl.requestMeta;
      if (!record(meta) || meta["x-codex-turn-metadata"] === undefined) deny("metadata_missing");
      let canonical;
      try { canonical = typeof meta["x-codex-turn-metadata"] === "string"
        ? JSON.parse(meta["x-codex-turn-metadata"]) : meta["x-codex-turn-metadata"]; }
      catch { deny("metadata_mismatch"); }
      if (meta.threadId !== nativeThread || !record(canonical) || canonical.thread_id !== nativeThread
          || canonical.turn_id !== nativeTurn || !uuid(canonical.session_id)) deny("metadata_mismatch");
      // Canonical session_id is cache affinity and need not equal thread_id.
      return JSON.stringify([meta.threadId, canonical.thread_id, canonical.turn_id, canonical.session_id]);
    };
    stage = "metadata";
    const metadataTuple = actualMetadata();
    registry = globalThis.routerWebActiveTurns;
    if (registry !== undefined && !(registry instanceof Map)) deny("registry_invalid");
    active = registry?.get(nativeThread);
    if (registry?.has(nativeThread) && active === undefined) deny("owner_mismatch");
    state = globalThis[key];
    // Peer entries in a valid registry are independent owners. Never replace
    // them or manufacture an ordinary Router binding for a fresh controller.
    const absent = active === undefined && state === undefined;
    let agent, browser, tab, browserId;
    const tabId = ledger.tabId, savedUrl = ledger.chatUrl;
    if (!absent) {
      if (!record(active) || !record(state) || active.state !== state || active.turnId !== nativeTurn
          || active.stopButtonName !== "Stop" || state.sessionId !== nativeThread) deny("owner_mismatch");
      if (state.closed || state.bindingLost || state.hasSentMessage !== true || state.sendAttempted !== true
          || state.sendClicked !== true || state.sendConfirmed !== true || state.runtimeModule !== config.runtimeModule) deny("state_unavailable");
      ({ agent, browser, tab } = state);
      browserId = browser?.browserId;
      if (state.tabId !== tabId || state.savedUrl !== savedUrl) deny("owner_mismatch");
    }
    // Installation owns the single native Interrupt definition. This guard
    // prevents reentrant hooks in one VM; it never changes ordinary owners or
    // claims to coordinate duplicate hook definitions across separate VMs.
    guards = globalThis.routerWebStopHooks;
    if (guards !== undefined && !(guards instanceof Map)) deny("hook_registry_invalid");
    if (guards?.has(nativeThread)) deny("hook_busy");
    if (guards === undefined) globalThis.routerWebStopHooks = guards = new Map();
    guard = {};
    guards.set(nativeThread, guard);
    const assertCurrent = (reserve = 0) => {
      budget(reserve);
      if (actualMetadata() !== metadataTuple) deny("metadata_mismatch");
      if (globalThis.routerWebStopHooks !== guards || guards.get(nativeThread) !== guard) deny("owner_changed");
      if (globalThis.routerWebActiveTurns !== registry) deny("owner_changed");
      if (absent) {
        if (registry?.get(nativeThread) !== undefined || globalThis[key] !== undefined) deny("owner_changed");
      } else if (registry.get(nativeThread) !== active || globalThis[key] !== state || active.state !== state
          || active.turnId !== nativeTurn || active.stopButtonName !== "Stop" || state.sessionId !== nativeThread
          || state.closed || state.bindingLost || state.hasSentMessage !== true || state.sendAttempted !== true
          || state.sendClicked !== true || state.sendConfirmed !== true || state.runtimeModule !== config.runtimeModule
          || state.agent !== agent || state.browser !== browser || state.tab !== tab
          || state.tabId !== tabId || state.savedUrl !== savedUrl) deny("owner_changed");
      if (browser !== undefined && browser?.browserId !== browserId || tab !== undefined && tab?.id !== tabId) deny("owner_changed");
      if (tuple(readLedger()) !== ledgerTuple) deny("ledger_changed");
      budget(reserve);
    };
    assertCurrent();
    if (absent) {
      stage = "public_setup";
      const sdk = await import(config.runtimeUrl);
      assertCurrent(1000);
      agent = await sdk.setupBrowserRuntime();
      assertCurrent(1000);
      diagnostic.freshController = true;
    }
    if (typeof agent?.browsers?.list !== "function") deny("controller_invalid");
    stage = "browser_inventory";
    assertCurrent();
    const browsers = await agent.browsers.list();
    assertCurrent();
    const own = Array.isArray(browsers) ? browsers.filter(item => item.type === "iab" && item.metadata?.codexSessionId === nativeThread) : [];
    if (own.length !== 1 || !nonempty(own[0].id)) deny("browser_ambiguous");
    if (absent) {
      stage = "public_browser";
      browserId = own[0].id;
      browser = await agent.browsers.get(browserId);
      assertCurrent();
    } else if (own[0].id !== browserId) deny("browser_mismatch");
    if (browser?.browserId !== own[0].id || typeof browser?.tabs?.list !== "function") deny("browser_mismatch");
    stage = "tab_inventory";
    const tabs = await browser.tabs.list();
    assertCurrent();
    const matching = Array.isArray(tabs) ? tabs.filter(item => item.id === tabId) : [];
    if (matching.length !== 1) deny("tab_ambiguous");
    if (matching[0].url !== undefined && matching[0].url !== savedUrl) deny("tab_url_mismatch");
    if (absent) {
      stage = "public_tab";
      tab = await browser.tabs.get(tabId);
      assertCurrent();
    }
    if (tab?.id !== tabId || typeof tab?.url !== "function" || typeof tab?.playwright?.getByRole !== "function"
        || typeof tab?.markHandoff !== "function") deny("tab_mismatch");
    stage = "tab_url";
    const url = await tab.url();
    assertCurrent();
    if (url !== savedUrl) deny("tab_url_mismatch");
    stage = "stop_visibility";
    const stop = tab.playwright.getByRole("button", { name: "Stop", exact: true });
    const count = await stop.count();
    assertCurrent();
    if (!Number.isInteger(count) || count < 0 || count > 1) deny("stop_confirmation_failed");
    const visible = await stop.isVisible();
    assertCurrent();
    if (typeof visible !== "boolean" || visible && count !== 1) deny("stop_confirmation_failed");
    stage = "mutation_url";
    const beforeClickUrl = await tab.url();
    assertCurrent(visible ? 1000 : 200);
    if (beforeClickUrl !== savedUrl) deny("tab_url_mismatch");
    if (visible) {
      stage = "stop_click";
      assertCurrent(1000);
      await stop.click({ timeoutMs: 350 });
      diagnostic.stopClicked = true;
      assertCurrent();
      stage = "stop_hidden";
      assertCurrent(600);
      await stop.waitFor({ state: "hidden", timeoutMs: 500 });
      assertCurrent();
      const afterVisible = await stop.isVisible();
      assertCurrent();
      if (afterVisible !== false) deny("stop_confirmation_failed");
      diagnostic.stopHidden = true;
    }
    stage = "handoff_url";
    const handoffUrl = await tab.url();
    assertCurrent(100);
    if (handoffUrl !== savedUrl) deny("tab_url_mismatch");
    stage = "handoff";
    assertCurrent(100);
    await tab.markHandoff();
    assertCurrent();
    if (!absent) {
      if (visible) { state.interrupted = true; state.completed = false; }
      state.retained = true;
    }
    diagnostic.retained = true;
    outcome = visible ? "cancelled" : "already_idle";
    stage = "complete";
  } catch (error) {
    code = codes.has(error?.stopCode) ? error.stopCode : "browser_operation_failed";
  } finally {
    // Release only our entry; a foreign or replacement registry stays intact.
    if (guard !== undefined && globalThis.routerWebStopHooks === guards && guards.get(nativeThread) === guard) guards.delete(nativeThread);
    const output = inScope ? { systemMessage: "ROUTER_WEB_STOP " + JSON.stringify({ outcome, stage, ...diagnostic,
      ...(code ? { code } : {}), elapsedMs: Math.max(0, Date.now() - started) }) } : {};
    nodeRepl.write(JSON.stringify(output));
  }
}

/** Pure generator. Inputs must be the validated, trusted installed configuration. */
export function createWebStopHookConfig({ stateDir, runtimeModule }) {
  for (const [name, value] of Object.entries({ stateDir, runtimeModule })) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || value.includes("${")) {
      throw new Error(`Web Stop ${name} must be a validated absolute path.`);
    }
  }
  const config = { ledgerDirectory: path.join(stateDir, "web-in-app", "conversations") + path.sep,
    runtimeModule, runtimeUrl: pathToFileURL(runtimeModule).href };
  const code = `await (${stopOwnedWebTurn.toString()
    .replace("'__NATIVE_SESSION__'", "'${session_id}'")
    .replace("'__NATIVE_TURN__'", "'${turn_id}'")
    .replace("'__NATIVE_EVENT__'", "'${hook_event_name}'")
    .replace("'__CONFIG__'", JSON.stringify(config))})();`;
  return {
    description: "Stop the current confirmed Router Web generation in its exact native conversation and retain its saved tab. Requires canonical native hook metadata and the private Router ledger; uses only the official public browser SDK. No Send, navigation, new chat, close, fallback, or ledger writes.",
    hooks: { Interrupt: [{ hooks: [{ type: "mcp_tool", server: "node_repl", tool: "js", input: { code,
      timeout_ms: 2700, title: "Stop owned ChatGPT Web generation and retain its tab" }, timeout: 3,
      statusMessage: "Stopping owned ChatGPT Web generation" }] }] },
  };
}
