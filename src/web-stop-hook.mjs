import path from "node:path";
import { pathToFileURL } from "node:url";
import { isSavedChatUrl } from "./web-browser.mjs";
import { browserDom, browserIdleButtonExactName, createStopBrowserState, waitForBrowserReadiness } from "./web-browser-state.mjs";
import { STOP_BUDGET, STOP_CODES } from "./web-stop-contract.mjs";

// Serialized into the native JS tool: no Router module, secret, or cached
// request metadata is imported. The caller owns validation/protection of stateDir
// and runtimeModule; Router's atomic ledger writer preserves its private ACL.
async function stopOwnedWebTurn(identity, config, budgetMs, normalUrl, stopCodes, createBrowserState, waitForState) {
  const { threadId: nativeThread, turnId: nativeTurn, sessionId: nativeSession } = identity;
  const started = Date.now(), deadline = started + budgetMs;
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
  const nonempty = value => typeof value === "string" && value.length > 0;
  const codes = new Set(stopCodes);
  const deny = code => { throw Object.assign(new Error(), { stopCode: code }); };
  const budget = (reserve = 0) => { if (deadline - Date.now() < reserve) deny("budget_exhausted"); };
  let inScope = false, stage = "scope", outcome = "blocked", code;
  let guards, guard, key, registry, active, state;
  const diagnostic = { freshController: false, clickAttempted: false, clickError: false,
    stopClicked: false, stopHidden: false, generationInactive: false, inactivityEvidence: "none", retained: false,
    readbackState: null, readbackStopCount: null, readbackStopVisible: null,
    readbackIdleCount: null, readbackIdleVisibleCount: null, readbackControlsRecognized: null,
    readbackUnrecognizedCount: null, readbackLabelledByCount: null, readbackComplete: null };
  const clearReadback = () => {
    for (const field of ["readbackState", "readbackStopCount", "readbackStopVisible", "readbackIdleCount",
      "readbackIdleVisibleCount", "readbackControlsRecognized", "readbackUnrecognizedCount",
      "readbackLabelledByCount", "readbackComplete"]) diagnostic[field] = null;
  };
  try {
    // A native route (or an older Web turn in the same native conversation) has
    // no current confirmed Web delivery in this exact UUID-derived file.
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
      const delivery = config.delivery;
      const deliveryMatches = delivery && value?.bindingId === delivery.bindingId && value?.tabId === delivery.tabId;
      const confirmed = value?.uncertainSend === false && last?.sendState === "sent"
        && normalUrl(value?.chatUrl) && uuid(value?.generationTurnKey);
      // A qualified native Send result can arrive before Router consumes it.
      // Its exact delivery proof grants Stop only; the uncertain ledger stays
      // unchanged and continues to block ordinary replay and continuation.
      const deliveredUncertain = deliveryMatches && value?.uncertainSend === true && last?.sendState === "uncertain";
      // Only the fields which authorize Stop are needed. History, compaction,
      // and reply-recovery schemas remain owned by the ordinary Web runtime.
      if (!record(value) || value.version !== 1 || value.threadId !== nativeThread
          || typeof value.bindingId !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,100}$/u.test(value.bindingId)
          || !Array.isArray(value.browserOwnerTurnIds) || !value.browserOwnerTurnIds.every(uuid)
          || new Set(value.browserOwnerTurnIds).size !== value.browserOwnerTurnIds.length
          || !value.browserOwnerTurnIds.includes(nativeTurn) || !nonempty(value.tabId)
          || !record(last) || last.turnId !== nativeTurn || last.completed !== false
          || !confirmed && !deliveredUncertain
          || delivery && (!deliveryMatches || confirmed
            && (value.chatUrl !== delivery.url || value.generationTurnKey !== delivery.generationTurnKey))) deny("ledger_invalid");
      return value;
    };
    stage = "ledger";
    const ledger = readLedger(true);
    if (!ledger) return;
    const tuple = value => JSON.stringify([value.version, value.threadId, value.bindingId,
      value.browserOwnerTurnIds, value.tabId, value.chatUrl, value.generationTurnKey, value.uncertainSend,
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
          || canonical.turn_id !== nativeTurn || canonical.session_id !== nativeSession) deny("metadata_mismatch");
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
    const tabId = ledger.tabId, savedUrl = config.delivery?.url ?? ledger.chatUrl,
      generationTurnKey = config.delivery?.generationTurnKey ?? ledger.generationTurnKey;
    const assertBinding = (ownerCode, stateCode = ownerCode) => {
      if (!record(active) || !record(state) || active.state !== state || active.turnId !== nativeTurn
          || active.stopButtonName !== config.stopButtonExactName || state.sessionId !== nativeThread) deny(ownerCode);
      if (state.bindingLost || state.hasSentMessage !== true || state.sendAttempted !== true
          || state.sendClicked !== true || state.sendConfirmed !== true || state.runtimeModule !== config.runtimeModule) deny(stateCode);
      if (state.tabId !== tabId || state.savedUrl !== savedUrl || state.generationTurnKey !== generationTurnKey) deny(ownerCode);
    };
    if (!absent) {
      assertBinding("owner_mismatch", "state_unavailable");
      ({ agent, browser, tab } = state);
      browserId = browser?.browserId;
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
      } else {
        if (registry.get(nativeThread) !== active || globalThis[key] !== state
            || state.agent !== agent || state.browser !== browser || state.tab !== tab) deny("owner_changed");
        assertBinding("owner_changed");
      }
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
    if (tab?.id !== tabId || typeof tab?.playwright?.getByRole !== "function"
        || typeof tab?.playwright?.locator !== "function"
        || typeof tab?.markHandoff !== "function") deny("tab_mismatch");
    // The action and every state predicate retain the exact latest generation.
    // The SDK owns semantic names and visibility; no direct-label decoder is
    // allowed to reinterpret the controls selected by those locators.
    const browserState = createBrowserState(tab, { ui: config.ui, generationTurnKey,
      stopName: config.stopButtonExactName, idleName: config.idleButtonExactName }, waitForState);
    const { stop, ready } = browserState;
    const readAllowanceMs = 200;
    let receipt = !absent && state.reconciliationStop?.generationTurnKey === generationTurnKey ? state.reconciliationStop : null;
    // Prior receipts prevent repeated input and survive for continuation.
    // This hook's public result claims only its own witnessed transition.
    let allowComposerRestored = false;
    const inspectGeneration = async (reserve = 0) => {
      clearReadback();
      const view = await browserState.inspect({ allowComposerRestored, preferInactive: Boolean(receipt),
        beforeRead: () => {
          assertCurrent(reserve);
          const timeoutMs = Math.min(1000, Math.floor(deadline - Date.now() - reserve));
          if (timeoutMs < readAllowanceMs) deny("budget_exhausted");
          return timeoutMs;
        },
        // Reserve admits a read. Accepting its result uses the actual deadline;
        // each subsequent RPC reserves its own remaining execution budget.
        afterRead: () => assertCurrent(),
      });
      if (view?.url !== savedUrl) deny("tab_url_mismatch");
      if (!record(view) || view.matchingCount !== 1 || view.latestTurnKey !== generationTurnKey
          || typeof view.complete !== "boolean") deny("generation_mismatch");
      const diagnosticCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : null;
      const diagnosticBoolean = value => typeof value === "boolean" ? value : null;
      Object.assign(diagnostic, { readbackState: "invalid_controls",
        readbackStopCount: diagnosticCount(view.stopCount), readbackStopVisible: diagnosticBoolean(view.stopVisible),
        readbackIdleCount: diagnosticCount(view.idleCount), readbackIdleVisibleCount: diagnosticCount(view.idleVisibleCount),
        readbackControlsRecognized: diagnosticBoolean(view.controlsRecognized),
        readbackUnrecognizedCount: diagnosticCount(view.unrecognizedCount),
        readbackLabelledByCount: diagnosticCount(view.labelledByCount), readbackComplete: view.complete });
      if (view.controlsRecognized !== true || typeof view.stopVisible !== "boolean"
          || typeof view.inactive !== "boolean" || ![null, true, false].includes(view.idleAbsent)) deny("stop_confirmation_failed");
      diagnostic.stopHidden = !view.stopVisible;
      diagnostic.inactivityEvidence = view.inactive && !view.stopVisible && view.complete ? "turn_complete"
        : view.inactive && !view.stopVisible && allowComposerRestored ? "composer_restored" : "none";
      diagnostic.generationInactive = diagnostic.inactivityEvidence !== "none";
      diagnostic.readbackState = diagnostic.generationInactive ? "inactive_readback" : "unconfirmed_readback";
      return { visible: view.stopVisible, idleAbsent: view.idleAbsent, inactive: diagnostic.generationInactive };
    };
    const waitForReadiness = async (locator, readyObservation) => {
      // Leave transport/check headroom beyond the minimum read allowance. A
      // timeout's actual terminal reply need not arrive on its nominal tick.
      const readReserveMs = readAllowanceMs + 100;
      return await browserState.waitForReadiness(locator, {
        nextTimeout: () => {
          assertCurrent();
          // A settled page can still use the decisive read when no scheduling
          // headroom remains. The state read enforces its actual deadline.
          return Math.floor(deadline - Date.now() - readReserveMs);
        },
        afterWait: () => assertCurrent(readAllowanceMs),
        inspect: inspectGeneration,
        ready: readyObservation,
      });
    };
    stage = "generation_proof";
    await inspectGeneration(200);
    stage = "handoff";
    assertCurrent(100);
    await tab.markHandoff();
    assertCurrent();
    if (!absent) {
      state.completed = false;
      state.retained = true;
    }
    diagnostic.retained = true;
    // Retention is independent of action acknowledgement. Recheck the exact
    // generation after handoff before considering the one semantic Stop click.
    stage = "mutation_url";
    let observation = await inspectGeneration(200);
    if (!observation.inactive && !observation.visible && !receipt) {
      stage = "stop_visibility";
      observation = await waitForReadiness(ready(false).or(stop), view => view.inactive || view.visible);
    }
    if (!observation.inactive) {
      if (observation.visible && !receipt) {
        stage = "stop_click";
        assertCurrent(1000);
        // Share the same generation-bound dispatch receipt with ordinary
        // continuation. An uncertain action must not be clicked again there
        // or by another hook; a fresh controller never acquires a binding.
        receipt = { generationTurnKey, idleAbsent: observation.idleAbsent === true, acknowledged: false };
        if (!absent) state.reconciliationStop = receipt;
        diagnostic.clickAttempted = true;
        try {
          await stop.click({ timeoutMs: Math.floor(deadline - Date.now() - 200) });
          diagnostic.stopClicked = true;
        } catch {
          // The public locator may reject after input took effect or natural
          // completion removed its target. Never repeat an uncertain click.
          diagnostic.clickError = true;
        }
        // A click attempt invalidates the earlier observation, even when the
        // acknowledgement or following read cannot complete within the budget.
        clearReadback();
        assertCurrent();
        if (!absent && state.reconciliationStop !== receipt) deny("owner_changed");
        if (diagnostic.stopClicked) receipt.acknowledged = true;
        assertCurrent(readAllowanceMs);
        stage = "stop_readback_visibility";
        allowComposerRestored = receipt.acknowledged && receipt.idleAbsent;
        observation = diagnostic.clickError ? await inspectGeneration()
          : await waitForReadiness(ready(allowComposerRestored), view => view.inactive);
        if (diagnostic.clickError && !observation.inactive) deny("browser_operation_failed");
      }
      if (!observation.inactive) deny("stop_confirmation_failed");
    }
    outcome = diagnostic.stopClicked ? "cancelled" : "already_idle";
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

/** Pure generator. The adapter owns validation of the originating native identity. */
export function createWebStopCode({ stateDir, runtimeModule }, { threadId, turnId, sessionId }, { budgetMs = STOP_BUDGET.scriptMs, delivery } = {}) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > STOP_BUDGET.scriptMs) throw new Error(`Web Stop budget must be within 1..${STOP_BUDGET.scriptMs} ms.`);
  for (const [name, value] of Object.entries({ stateDir, runtimeModule })) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
      throw new Error(`Web Stop ${name} must be a validated absolute path.`);
    }
  }
  if (delivery !== undefined && (delivery === null || typeof delivery !== "object" || Array.isArray(delivery)
      || Object.keys(delivery).length !== 4 || !["bindingId", "tabId", "url", "generationTurnKey"].every(name => Object.hasOwn(delivery, name))
      || typeof delivery.bindingId !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,100}$/u.test(delivery.bindingId)
      || typeof delivery.tabId !== "string" || !delivery.tabId || !isSavedChatUrl(delivery.url)
      || typeof delivery.generationTurnKey !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(delivery.generationTurnKey))) {
    throw new Error("Web Stop delivery requires exact confirmed browser facts.");
  }
  const config = { ledgerDirectory: path.join(stateDir, "web-in-app", "conversations") + path.sep,
    runtimeModule, runtimeUrl: pathToFileURL(runtimeModule).href, stopButtonExactName: browserDom.stopButtonExactName,
    idleButtonExactName: browserIdleButtonExactName,
    ...(delivery === undefined ? {} : { delivery }),
    ui: Object.fromEntries(["turnSelector", "turnKeyAttribute", "turnStateSelector", "turnStateAttribute", "completeTurnState"]
      .map(name => [name, browserDom[name]])) };
  return `await (${stopOwnedWebTurn.toString()})(${JSON.stringify({ threadId, turnId, sessionId })}, ${JSON.stringify(config)}, ${budgetMs}, ${isSavedChatUrl.toString()}, ${JSON.stringify(STOP_CODES)}, ${createStopBrowserState.toString()}, ${waitForBrowserReadiness.toString()});`;
}
