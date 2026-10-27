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

// The public SDK owns accessible-name resolution and mounted cardinality. A
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
