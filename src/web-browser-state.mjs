// Stop-only composer evidence stays separate from the resident observation helper.
export const browserIdleButtonExactName = "Start Voice";

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
  codeBlockCopyValue: "code-block", excludedCopyValue: "exclude", codeSelector: "code",
  codeEditorSelector: ".cm-content[data-language]", codeLineClass: "cm-line",
  contentEditableAttribute: "contenteditable", familySelector: '[role="menuitemradio"]', checkedAttribute: "aria-checked",
  powerValueAttribute: "aria-valuenow", powerMinimumAttribute: "aria-valuemin", powerMaximumAttribute: "aria-valuemax",
  conversationContentSelector: '[data-message-author-role],article,[contenteditable="true"],[role="textbox"],textarea,input',
});

// Serialized into the native runtime. Semantic locators own accessible names,
// visibility and cardinality; the page reader only projects identity and state.
export function createStopBrowserState(tab, { ui, generationTurnKey, stopName, idleName }) {
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
  return { stop, ready,
    // Callers retain authority, deadline and decisive-proof checks. A
    // nonpositive nextTimeout permits only the final coherent read.
    async waitForReadiness(locator, { nextTimeout, afterWait, inspect, ready: readyObservation }) {
      let timeoutMs = nextTimeout();
      for (;;) {
        let repeat = timeoutMs >= 1;
        // Public SDK selector waits may cap their timeout below the caller's
        // deadline. Rearm that same condition after a coherent unready read.
        if (repeat) {
          try { await locator.waitFor({ state: "visible", timeoutMs }); }
          catch (error) {
            // The SDK appends a "timed out" action label to every error and
            // discards its structured code. Only the original timeout reason,
            // optionally prefixed once with "Error: ", permits another wait;
            // other failures get one decisive read.
            repeat = typeof error?.message === "string"
              && /^(?:Error: )?(?:Playwright selector deadline exceeded(?:\r?\n|$)|Timed out after \d+ms waiting for selector )/u.test(error.message);
          }
          afterWait?.();
        }
        const observation = await inspect();
        if (readyObservation(observation) || !repeat) return observation;
        // A matched locator can become active again before the state read.
        // Readiness never replaces that read or authorizes another Stop click.
        timeoutMs = nextTimeout();
        if (timeoutMs < 1) return observation;
      }
    },
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
