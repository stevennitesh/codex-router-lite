// Stop-only composer evidence stays separate from the resident observation helper.
export const browserIdleButtonExactName = "Start Voice";

const observationFinishGraceMs = 4000, observationTransportMarginMs = 1000;
export const browserObservationBudget = Object.freeze({ finishGraceMs: observationFinishGraceMs,
  transportMarginMs: observationTransportMarginMs, shortReadMs: observationFinishGraceMs - observationTransportMarginMs });

// Host protocol facts shared by the runtime and its retained adapter. These do
// not replace each operation's acceptance, answer, or cleanup proof.
export const browserObservationOwnershipLost = value => ["duplicate-generation-turn", "generation-turn-not-latest",
  "generation-message-not-latest"].includes(value?.replyUnavailableReason);
export const browserObservationIdleComplete = value => value?.completed === true
  || value?.statusComplete === true && value?.stopVisible === false;
export const isBrowserOwnershipPending = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === 2 && Object.hasOwn(value, "operation") && Object.hasOwn(value, "ownershipPending")
  && value.operation === "observe" && value.ownershipPending === true;

// The caller owns the total deadline and any confirmation reserve. Every
// dispatched mutation gets only its current remainder, never a fresh timeout.
export function createBrowserAllowance(deadline, expired) {
  return (reserve = 0, maximum = Infinity) => {
    const remaining = Math.floor(deadline - Date.now() - reserve);
    if (remaining < 1) throw expired();
    return Math.min(maximum, remaining);
  };
}

// Dispatch and held observation use the same prompt-owned anchor condition.
// The SDK wait supplies readiness only; classify independently proves identity,
// global uniqueness and order from the caller's coherent anchor projection.
export function createSendBrowserState(tab, { ui, generationMarker, baselineTurnKeys = [] }) {
  const baseline = new Set(baselineTurnKeys);
  const valid = value => typeof value?.turnKey === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value.turnKey);
  const preceding = [...baseline].filter(turnKey => valid({ turnKey }));
  const attribute = `@${ui.turnKeyAttribute}`;
  let marker = tab.playwright.locator(ui.turnSelector).filter({ hasText: generationMarker });
  if (preceding.length) marker = marker.filter({ hasNot: tab.playwright.locator(
    `xpath=self::*[${preceding.map(key => `${attribute}='${key}'`).join(" or ")}]`) });
  const validIdentity = `string-length(${attribute})=36 and substring(${attribute},9,1)='-' and substring(${attribute},14,1)='-' and substring(${attribute},19,1)='-' and substring(${attribute},24,1)='-' and string-length(translate(${attribute},'-',''))=32 and translate(${attribute},'0123456789abcdefABCDEF-','')=''`;
  const turnsPath = `//*[@${ui.turnKeyAttribute}]`, latestPath = `(${turnsPath})[last()]`;
  const markerPath = `${turnsPath}[contains(., '${generationMarker}')${preceding.length
    ? ` and not(${preceding.map(key => `${attribute}='${key}'`).join(" or ")})` : ""}]`;
  const ready = marker.filter({ has: tab.playwright.locator(`xpath=self::*[${validIdentity} and count(${markerPath})=1 and count(${markerPath} | ${latestPath})=1 and count(//*[@${ui.turnKeyAttribute}=${latestPath}/@${ui.turnKeyAttribute}])=1]`) });
  return { ready, classify(value) {
    const candidates = value.turns.filter(turn => !baseline.has(turn.turnKey) && turn.matchesGenerationMarker);
    const latest = value.turns.at(-1);
    const keyCount = candidates.length === 1 ? value.turns.filter(turn => turn.turnKey === candidates[0].turnKey).length : 0;
    return { anchor: candidates.length === 1 && candidates[0] === latest && valid(latest) && keyCount === 1 ? latest.turnKey : null,
      blocked: candidates.length > 1 || keyCount > 1 || candidates.length === 1 && valid(candidates[0]) && valid(latest) && candidates[0] !== latest,
      diagnostic: { turnCount: value.turns.length, markerCount: candidates.length, validMarkerCount: candidates.filter(valid).length,
        latestMatches: candidates.length === 1 && candidates[0] === latest, keyCount,
        nestedTurnCount: value.turns.filter(turn => turn.nestedInTurn).length,
        latestNestedInTurn: latest?.nestedInTurn ?? null, markerNestedInTurn: candidates.some(turn => turn.nestedInTurn) } };
  } };
}

export function createSendReadyLocator(tab, ui) {
  return tab.playwright.getByRole("button", { name: ui.sendButtonExactName, exact: true })
    .filter({ has: tab.playwright.locator("xpath=self::*[not(@disabled) and not(@aria-disabled='true')]") });
}

// Home readiness schedules one fresh projection. Decorative headings are not
// evidence, and an ordinary draft or reply is never cleared to obtain a home.
export function createHomeBrowserState(tab, { ui, pluginChipSelector, homeUrl }) {
  const role = (name, kind = "button") => tab.playwright.getByRole(kind, { name, exact: true });
  const composer = role(ui.composerName, "textbox"), model = role(ui.modelButtonName), temporary = role(ui.temporaryButtonName);
  const enabled = control => control.filter({ has: tab.playwright.locator("xpath=self::*[not(@disabled) and not(@aria-disabled='true')]") });
  let ready = tab.playwright.locator("body")
    .filter({ has: composer.filter({ visible: true }).filter({ has: tab.playwright.locator("xpath=self::div[@contenteditable='true']") }), hasNot: composer.nth(1) })
    .filter({ has: enabled(model).filter({ visible: true }), hasNot: model.nth(1) })
    .filter({ has: enabled(temporary).filter({ visible: true }), hasNot: temporary.nth(1) })
    .filter({ hasNot: tab.playwright.locator(ui.assistantFinalReplySelector) });
  for (const control of [role(ui.stopButtonExactName), role(ui.temporaryToggleName), role(ui.temporaryHeadingName, "heading")]) {
    ready = ready.filter({ hasNot: control.filter({ visible: true }) }).filter({ hasNot: control.nth(1) });
  }
  return { ready, async inspect(timeoutMs = 1000, includeUrl = false) {
    const proof = await ready.or(composer).evaluateAll((elements, { ui, pluginChipSelector }) => {
      const bodies = elements.filter(element => element.tagName === "BODY"), composers = elements.filter(element => element.tagName !== "BODY");
      if (bodies.length !== 1 || bodies[0].ownerDocument?.body !== bodies[0]) return null;
      const empty = node => {
        if (node.nodeType === 3) return !(node.textContent ?? "").trim();
        if (node.nodeType !== 1 || pluginChipSelector && node.matches(pluginChipSelector)) return true;
        if (node.getAttribute(ui.contentEditableAttribute) === "false" || !/^(?:DIV|P|SPAN|BR)$/u.test(node.tagName)) return false;
        return Array.from(node.childNodes).every(empty);
      };
      return { url: bodies[0].ownerDocument.URL, empty: composers.length === 1
        && composers[0].tagName === "DIV" && composers[0].getAttribute(ui.contentEditableAttribute) === "true" && empty(composers[0]) };
    }, { ui, pluginChipSelector }, { timeoutMs });
    if (proof === null) return null;
    let normal = false;
    if (proof.empty && homeUrl(proof.url)) {
      const [modelEnabled, temporaryEnabled] = await Promise.all([model.isEnabled(), temporary.isEnabled()]);
      normal = modelEnabled && temporaryEnabled;
    }
    return includeUrl ? { ...proof, normal } : normal;
  } };
}

// Most homes need only semantic readiness and one coherent projection. A
// transitional document can already mount those controls; only an actual
// navigation event may wake another projection in that case. Capture before
// the fresh read so a navigation between inspection and subscription is retained.
export async function createBrowserNavigationObserver(tab, { allowance, assertCurrent }) {
  const methods = ["Page.frameNavigated", "Page.navigatedWithinDocument"];
  const valid = batch => Number.isSafeInteger(batch?.cursor) && batch.cursor >= 0 && batch.truncated === false && Array.isArray(batch.events);
  const unavailable = (stage, error, reason) => {
    assertCurrent(); allowance();
    reason ??= /^Required documentation has not been read:/u.test(error?.message ?? "") ? "documentation-required"
      : /^Capability is not available:/u.test(error?.message ?? "") ? "capability-unavailable"
        : error?.name === "BrowserUseSecurityError" ? "security"
          : /timed out|deadline expired|deadline exceeded/iu.test(error?.message ?? "") ? "timeout" : "sdk-error";
    throw new Error(`Browser navigation observation failed. ROUTER_WEB_NAVIGATION_DIAGNOSTIC ${JSON.stringify({ stage, reason })}`);
  };
  let cdp, captured;
  assertCurrent();
  try { cdp = await tab.capabilities.get("cdp"); } catch (error) { unavailable("capability-get", error); }
  assertCurrent(); allowance();
  // The SDK enforces a first-use documentation gate for both raw CDP commands
  // and event reads. Capability lookup alone does not satisfy that contract.
  try { await cdp.documentation(); } catch (error) { unavailable("capability-documentation", error); }
  assertCurrent(); allowance();
  try { await cdp.send("Page.enable", {}, { timeoutMs: allowance(0, 1000) }); } catch (error) { unavailable("page-enable", error); }
  assertCurrent(); allowance();
  try { captured = await cdp.readEvents({ methods, limit: 100, timeoutMs: 0 }); } catch (error) { unavailable("cursor-capture", error); }
  assertCurrent(); allowance();
  if (!valid(captured)) unavailable("cursor-capture", undefined, captured?.truncated === true ? "truncated-batch" : "invalid-batch");
  let cursor = captured.cursor;
  return { async next(timeoutMs = allowance()) {
    assertCurrent();
    let batch;
    try { batch = await cdp.readEvents({ afterSequence: cursor, methods, limit: 100, timeoutMs }); }
    catch (error) { unavailable("navigation-wait", error); }
    assertCurrent(); allowance();
    if (!valid(batch)) unavailable("navigation-wait", undefined, batch?.truncated === true ? "truncated-batch" : "invalid-batch");
    if (batch.cursor <= cursor || !batch.events.length) return false;
    cursor = batch.cursor;
    return true;
  } };
}

export async function waitForHomeBrowserReadiness(tab, { home, browserReadiness, allowance, assertCurrent, transitional }, navigationObserver = createBrowserNavigationObserver) {
  const inspect = () => browserReadiness(home.ready, {
    nextTimeout: () => { assertCurrent(); return allowance(1000); },
    afterWait: ({ error, timedOut }) => { assertCurrent(); if (error && !timedOut) throw new Error("Normal home readiness failed."); },
    inspect: async () => { assertCurrent(); const proof = await home.inspect(allowance(0, 1000), true); assertCurrent(); allowance(); return proof; },
    ready: proof => proof !== null,
  });
  let proof = await inspect();
  if (proof?.normal) return proof;
  if (!proof?.empty || !transitional(proof.url)) return null;
  const navigation = await navigationObserver(tab, { allowance, assertCurrent });
  if (!navigation) return null;
  proof = await inspect();
  while (!proof?.normal) {
    if (!proof?.empty || !transitional(proof.url)) return null;
    // Empty or truncated results cannot establish progress. Each finite read
    // owns its SDK listener lifetime; no competing wait is left behind.
    if (await navigation.next() !== true) return null;
    proof = await inspect();
  }
  return proof;
}

// This is scheduling evidence only. Recovery still verifies the exact saved
// URL, all identities, current generation and normalized UTF-8 prefix digest.
export function createRecoveryBrowserState(tab, { ui, proof }) {
  const turn = `//*[@${ui.turnKeyAttribute}='${proof.generationTurnKey}']`;
  const latestTurn = `(//*[@${ui.turnKeyAttribute}])[last()][@${ui.turnKeyAttribute}='${proof.generationTurnKey}']`;
  const complete = proof.completed ? ` and count(${turn}//*[@${ui.turnStateAttribute}])=1 and ${turn}//*[@${ui.turnStateAttribute}='${ui.completeTurnState}']` : "";
  const message = proof.replyId ? `//*[@${ui.messageIdAttribute}='${proof.replyId}']` : null;
  const checkpoint = message ? ` and count(${message})=1 and ${turn}//*[@${ui.messageIdAttribute}='${proof.replyId}']` : "";
  let ready = tab.playwright.locator(`xpath=//body[count(${turn})=1 and ${latestTurn}${complete}${checkpoint}]`);
  // Raw DOM text length is unrelated to the normalized reply length: paragraph,
  // BR and CodeMirror boundaries can contribute characters absent from textContent.
  // Wait for the owned answer renderer, then let the exact projection/digest
  // reject a settled short or changed body. Multiple fragments in one unique
  // message remain valid; a second message wrapper never becomes that message.
  if (message) ready = ready.filter({ has: tab.playwright.locator(`[${ui.messageIdAttribute}="${proof.replyId}"]`).locator(ui.assistantSelector) });
  return { ready, contentChangedSince(textContent) {
    // XPath string(.) and the captured wrapper textContent use the same raw
    // DOM text, independently of normalized paragraph/code boundaries. The
    // initially mounted renderer cannot satisfy this condition unchanged.
    const literal = value => !value.includes("'") ? `'${value}'`
      : `concat(${value.split("'").map(part => `'${part}'`).join(',"\'",')})`;
    return ready.filter({ has: tab.playwright.locator(`[${ui.messageIdAttribute}="${proof.replyId}"]`)
      .filter({ has: tab.playwright.locator(`xpath=self::*[string(.) != ${literal(textContent)}]`) }) });
  } };
}

export const browserDom = Object.freeze({
  modelButtonName: "Select ChatGPT model", modelMenuName: "Select ChatGPT model", modelExpandName: "Select model",
  powerMenuItemName: "Power", powerSliderSelector: '[role="slider"]', addButtonName: "Add files and more",
  composerName: "Ask ChatGPT", temporaryButtonName: "Temporary chat",
  temporaryToggleName: "Turn off temporary chat", temporaryHeadingName: "Temporary chat",
  assistantFinalReplySelector: '[data-chatgpt-selection-message-id] [data-markdown-text-style="assistant-message"]', sendButtonExactName: "Send",
  stopButtonExactName: "Stop", regenerateButtonExactName: "Regenerate response",
  requestErrorText: "Unknown error", retryButtonExactName: "Retry",
  conversationFullText: "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.",
  startNewChatButtonName: "Start new chat",
  messageSelector: '[data-chatgpt-selection-message-id]', messageIdAttribute: "data-chatgpt-selection-message-id",
  assistantSelector: '[data-markdown-text-style="assistant-message"]', turnSelector: '[data-turn-key]', turnKeyAttribute: "data-turn-key",
  streamingStatusSelector: '[data-streaming-response-status]', reasoningSelector: '[data-testid^="cot-v5"]',
  turnStateSelector: '[data-talvt-turn-state]', turnStateAttribute: "data-talvt-turn-state", completeTurnState: "complete",
  labelSelector: '[aria-label]', labelAttribute: "aria-label", markdownCopyAttribute: "data-markdown-copy",
  buttonSelector: 'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]',
  composerSelector: '[role="textbox"],[contenteditable="true"]',
  controlContentSelector: '[data-message-author-role],pre,code,[contenteditable="true"],[role="textbox"],textarea,input',
  codeBlockCopyValue: "code-block", excludedCopyValue: "exclude", codeSelector: "code",
  codeEditorSelector: ".cm-content[data-language]", codeLineClass: "cm-line",
  contentEditableAttribute: "contenteditable", familySelector: '[role="menuitemradio"]', checkedAttribute: "aria-checked",
  powerValueAttribute: "aria-valuenow", powerMinimumAttribute: "aria-valuemin", powerMaximumAttribute: "aria-valuemax",
  conversationContentSelector: '[data-message-author-role],article,[contenteditable="true"],[role="textbox"],textarea,input',
});

// The public SDK owns accessible-name resolution and semantic cardinality. A
// guarded BODY lets one coherent projection distinguish Stop state while the
// selected Regenerate nodes retain their exact DOM order after the answer.
export function createObservationBrowserState(tab, { ui, generationTurnKey }) {
  const role = (name, kind = "button") => tab.playwright.getByRole(kind, { name, exact: true });
  const stop = role(ui.stopButtonExactName), toggle = role(ui.temporaryToggleName), heading = role(ui.temporaryHeadingName, "heading");
  const fullBanner = tab.playwright.getByText(ui.conversationFullText, { exact: true }).filter({ visible: true });
  const requestError = tab.playwright.getByText(ui.requestErrorText, { exact: true }).filter({ visible: true });
  const guarded = tab.playwright.locator("body")
    .filter({ hasNot: stop.nth(1) }).filter({ hasNot: toggle.nth(1) }).filter({ hasNot: heading.nth(1) })
    .filter({ hasNot: toggle.filter({ visible: true }) }).filter({ hasNot: heading.filter({ visible: true }) });
  const visibleStop = stop.filter({ visible: true });
  return {
    indicatorBody: guarded,
    profile(stopVisible, quiet = true) {
      const body = guarded.filter(stopVisible ? { has: visibleStop } : { hasNot: visibleStop });
      return quiet ? body.filter({ hasNot: fullBanner }).filter({ hasNot: requestError }) : body;
    },
    regenerate: tab.playwright.locator(`[${ui.turnKeyAttribute}="${generationTurnKey}"]`)
      .getByRole("button", { name: ui.regenerateButtonExactName, exact: true }),
    fullBanner, requestError, fullButton: role(ui.startNewChatButtonName).filter({ visible: true }),
    retry: role(ui.retryButtonExactName).filter({ visible: true }), composer: role(ui.composerName, "textbox"),
  };
}

// Callers retain authority, deadline and decisive-proof checks. A nonpositive
// nextTimeout permits only the final coherent read. Serialized callers inject
// this self-contained helper explicitly instead of importing from native code.
export async function waitForBrowserReadiness(locator, { nextTimeout, afterWait, inspect, ready: readyObservation, state = "visible" }) {
  let timeoutMs = nextTimeout();
  for (;;) {
    let repeat = timeoutMs >= 1;
    // Public SDK selector waits may cap their timeout below the caller's
    // deadline. Rearm that same condition after a coherent unready read.
    if (repeat) {
      let error, timedOut = false;
      try { await locator.waitFor({ state, timeoutMs }); }
      catch (rejection) {
        error = rejection;
        // The SDK appends a "timed out" action label to every error and
        // discards its structured code. Only the original timeout reason,
        // optionally prefixed once with "Error: ", permits another wait;
        // other failures get one decisive read unless the caller rejects them.
        timedOut = typeof error?.message === "string"
          && /^(?:Error: )?(?:Playwright selector deadline exceeded(?:\r?\n|$)|Timed out after \d+ms waiting for selector )/u.test(error.message);
        repeat = timedOut;
      }
      afterWait?.({ error, timedOut });
    }
    const observation = await inspect();
    if (readyObservation(observation) || !repeat) return observation;
    // A matched locator can become active again before the state read.
    // Readiness never replaces that read or authorizes another browser action.
    timeoutMs = nextTimeout();
    if (timeoutMs < 1) return observation;
  }
}

// Serialized into the native runtime. Semantic locators own accessible names,
// visibility and cardinality; the page reader only projects identity and state.
export function createStopBrowserState(tab, { ui, generationTurnKey, stopName, idleName }, waitForReadiness = waitForBrowserReadiness) {
  const ownedTurn = `//*[@${ui.turnKeyAttribute}='${generationTurnKey}']`;
  const latestTurn = `(//*[@${ui.turnKeyAttribute}])[last()][@${ui.turnKeyAttribute}='${generationTurnKey}']`;
  const generationGuard = `count(${ownedTurn})=1 and ${latestTurn}`;
  const completeState = `count(${ownedTurn}//*[@${ui.turnStateAttribute}])=1 and ${ownedTurn}//*[@${ui.turnStateAttribute}='${ui.completeTurnState}']`;
  const body = tab.playwright.locator(`xpath=//body[${generationGuard}]`);
  const stop = body.getByRole("button", { name: stopName, exact: true });
  // Relative locators are resolved from each filtered body by the public SDK.
  const semanticStop = tab.playwright.getByRole("button", { name: stopName, exact: true });
  const semanticIdle = tab.playwright.getByRole("button", { name: idleName, exact: true });
  const visibleStop = semanticStop.filter({ visible: true });
  const visibleIdle = semanticIdle.filter({ visible: true });
  const uniqueStop = body.filter({ hasNot: semanticStop.nth(1) });
  const active = uniqueStop.filter({ has: visibleStop });
  const activeWithoutIdle = active.filter({ hasNot: semanticIdle });
  const hiddenStop = uniqueStop.filter({ hasNot: visibleStop });
  const completed = tab.playwright.locator(`xpath=//body[${generationGuard} and ${completeState}]`)
    .filter({ hasNot: semanticStop.nth(1) }).filter({ hasNot: visibleStop });
  const ready = allowComposerRestored => {
    return allowComposerRestored ? completed.or(hiddenStop.filter({ has: visibleIdle, hasNot: semanticIdle.nth(1) })) : completed;
  };
  const readBody = (elements, { ui, generationTurnKey }) => {
    if (elements.length !== 1 || elements[0].tagName !== "BODY") return null;
    const body = elements[0], document = body.ownerDocument;
    if (document?.body !== body) return null;
    const turns = Array.from(document.querySelectorAll(ui.turnSelector));
    const matching = turns.filter(turn => turn.getAttribute(ui.turnKeyAttribute) === generationTurnKey);
    const states = matching.length === 1 ? matching[0].querySelectorAll(ui.turnStateSelector) : [];
    return { url: document.URL, matchingCount: matching.length,
      latestTurnKey: turns.at(-1)?.getAttribute(ui.turnKeyAttribute) ?? null,
      complete: states.length === 1 && states[0].getAttribute(ui.turnStateAttribute) === ui.completeTurnState };
  };
  return { stop, ready, waitForReadiness,
    async inspect({ allowComposerRestored = false, preferInactive = false, timeoutMs = 1000, beforeRead, afterRead } = {}) {
      const read = async locator => {
        const allowance = beforeRead?.() ?? timeoutMs;
        const value = await locator.evaluateAll(readBody, { ui, generationTurnKey }, { timeoutMs: allowance });
        afterRead?.();
        return value;
      };
      const candidates = [
        [activeWithoutIdle, { stopCount: 1, stopVisible: true, idleVisibleCount: 0, idleAbsent: true, inactive: false }],
        [ready(allowComposerRestored), { stopCount: null, stopVisible: false, idleVisibleCount: null, idleAbsent: null, inactive: true }],
        [active, { stopCount: 1, stopVisible: true, idleVisibleCount: null, idleAbsent: false, inactive: false }],
        [hiddenStop, { stopCount: null, stopVisible: false, idleVisibleCount: null, idleAbsent: null, inactive: false }],
      ];
      // After an attempted click, a settled page needs only its decisive read.
      if (preferInactive) candidates.unshift(candidates.splice(1, 1)[0]);
      for (const [locator, proof] of candidates) {
        const view = await read(locator);
        if (view) return { ...view, ...proof, idleCount: null, controlsRecognized: true,
          unrecognizedCount: null, labelledByCount: null };
      }
      // An unconditional body supplies diagnostics only, never semantic proof.
      const view = await read(tab.playwright.locator("body"));
      return view && { ...view, stopCount: null, stopVisible: null, idleCount: null,
        idleVisibleCount: null, controlsRecognized: false, unrecognizedCount: null,
        labelledByCount: null, inactive: false, idleAbsent: null };
    },
  };
}
