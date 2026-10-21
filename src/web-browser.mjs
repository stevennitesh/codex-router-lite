import { createHash } from "node:crypto";

const nativeNamespace = "mcp__node_repl";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (message, code = "web_browser_capability_gap") => Object.assign(new Error(message), { code, status: 409 });
const hasType = (rule, type) => rule?.type === type || Array.isArray(rule?.type) && rule.type.includes(type);

// The caller's declaration is the authority. A name resembling an MCP tool is
// insufficient: native identity must be explicit in this request.
export function discoverBrowserExecutor(tools) {
  const matches = [];
  for (const tool of tools || []) {
    if (tool?.type === "namespace" && tool.name === nativeNamespace) {
      for (const child of tool.tools || []) if (child?.name === "js") matches.push(child);
    } else if (tool?.namespace === nativeNamespace && tool.name === "js") matches.push(tool);
  }
  if (matches.length !== 1 || matches[0].type !== "function") {
    throw failure("Require one explicitly declared native mcp__node_repl.js function.");
  }
  const declaration = matches[0];
  const schemas = [declaration.parameters, declaration.inputSchema].filter(value => value !== undefined);
  const schema = schemas[0];
  if (schemas.length !== 1 || !record(schema) || schema.type !== "object" || !hasType(schema.properties?.code, "string")
      || !Array.isArray(schema.required ?? []) || (schema.required || []).some(key => !["code", "title", "timeout_ms"].includes(key))
      || ["oneOf", "anyOf", "allOf", "$ref", "not", "if", "then", "else"].some(key => key in schema)) {
    throw failure("The current native JavaScript schema cannot represent a bounded browser call.");
  }
  const argumentsFor = (code, title = "ChatGPT Web browser operation", timeoutMs = 30000) => {
    if (typeof code !== "string" || typeof title !== "string") throw failure("Native JavaScript code and title must be strings.");
    const args = { code };
    if (hasType(schema.properties.title, "string")) args.title = title;
    if (hasType(schema.properties.timeout_ms, "integer") || hasType(schema.properties.timeout_ms, "number")) args.timeout_ms = timeoutMs;
    for (const key of schema.required || []) if (!(key in args)) throw failure(`Required native argument ${key} is unavailable.`);
    for (const [key, value] of Object.entries(args)) {
      const rule = schema.properties[key];
      if (!rule || rule.enum && !rule.enum.includes(value) || Object.hasOwn(rule, "const") && rule.const !== value
          || typeof value === "string" && (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)
            || rule.pattern && !(new RegExp(rule.pattern)).test(value))
          || typeof value === "number" && (!Number.isFinite(value) || hasType(rule, "integer") && !Number.isInteger(value)
            || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) {
        throw failure(`Native argument ${key} does not satisfy the current declaration.`);
      }
    }
    return JSON.stringify(args);
  };
  return { namespace: nativeNamespace, name: "js", argumentsFor };
}

export function isSavedChatUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && /^\/c\/[A-Za-z0-9-]+$/u.test(url.pathname)
      && !url.searchParams.has("temporary-chat") && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

// Every phase can spend only the remainder of its caller's deadline. In
// particular paste readiness, saved URL and generation proof share Send's budget.
async function waitForBrowserState(ready, deadline, message) {
  while (!(await ready())) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
  }
}

function frameParts(frameToken) {
  if (typeof frameToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(frameToken)) throw failure("A nonce browser frame token is required.");
  return [`ROUTER_WEB_BROWSER_${frameToken}_BEGIN\n`, `\nROUTER_WEB_BROWSER_${frameToken}_END`];
}

export function parseBrowserOutput(output, frameToken) {
  const [begin, end] = frameParts(frameToken);
  const found = [];
  const visit = value => {
    if (typeof value === "string") {
      const start = value.indexOf(begin);
      if (start >= 0) {
        const finish = value.indexOf(end, start + begin.length);
        if (finish < 0 || value.indexOf(end) !== finish || value.indexOf(begin, start + begin.length) >= 0 || value.indexOf(end, finish + end.length) >= 0) {
          throw failure("Native browser result frame is malformed or ambiguous.", "web_browser_output_shape");
        }
        let parsed;
        try { parsed = JSON.parse(value.slice(start + begin.length, finish)); }
        catch { throw failure("Native browser result is not strict JSON.", "web_browser_output_shape"); }
        if (!record(parsed) || Object.keys(parsed).length !== 1 || !record(parsed.routerBrowser) || typeof parsed.routerBrowser.operation !== "string") {
          throw failure("Native browser result lacks its data envelope.", "web_browser_output_shape");
        }
        found.push(parsed.routerBrowser);
      } else {
        try { visit(JSON.parse(value)); }
        catch (error) { if (error.code) throw error; }
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (record(value)) {
      if (value.isError === true) throw failure("Native JavaScript execution failed.", "web_browser_execution_failed");
      if (typeof value.text === "string") visit(value.text);
      if (value.content !== undefined) visit(value.content);
      if (value.output !== undefined) visit(value.output);
    }
  };
  visit(output);
  if (found.length !== 1) throw failure("Expected one nonce-framed native browser result.", "web_browser_output_shape");
  return found[0];
}

// Stop-only composer evidence must not change the retained observation helper.
export const browserIdleButtonExactName = "Start Voice";

export const browserDom = Object.freeze({
  modelButtonName: "Select ChatGPT model", modelMenuName: "Select ChatGPT model", modelExpandName: "Select model",
  powerMenuItemName: "Power", powerSliderSelector: '[role="slider"]', addButtonName: "Add files and more",
  composerName: "Ask ChatGPT", normalHeadingName: "Ready when you are.", temporaryButtonName: "Temporary chat",
  temporaryToggleName: "Turn off temporary chat", temporaryHeadingName: "Temporary chat",
  assistantFinalReplySelector: '[data-chatgpt-selection-message-id] [data-markdown-text-style="assistant-message"]', sendButtonExactName: "Send",
  stopButtonExactName: "Stop", regenerateButtonExactName: "Regenerate response",
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

// These controls belong to independently shipped setup, selection and Send.
// Everything else, including any newly added field, remains a resident dependency.
const operationDomKeys = new Set([
  "modelButtonName", "modelMenuName", "modelExpandName", "powerMenuItemName", "powerSliderSelector", "addButtonName",
  "composerName", "normalHeadingName", "temporaryButtonName", "sendButtonExactName", "contentEditableAttribute",
  "familySelector", "checkedAttribute", "powerValueAttribute", "powerMinimumAttribute", "powerMaximumAttribute",
]);
const residentBrowserDom = Object.freeze(Object.fromEntries(Object.entries(browserDom).filter(([key]) => !operationDomKeys.has(key))));

// Self-contained read-only DOM projection, also usable directly with the public
// locator.evaluateAll API. Code source excludes the renderer's toolbar and uses
// logical lines rather than layout-derived wrapping. The observed message wrapper
// identity and its text come from the same DOM read.
export function readBrowserReplies(elements, options) {
  const ui = options.ui, wrapperSelector = ui.messageSelector;
  const turns = elements.filter(element => element.matches(ui.turnSelector));
  const selectedElements = elements.filter(element => element.matches(options.assistantSelector));
  const turnOrders = new Map();
  const turnOrder = turn => {
    if (!turnOrders.has(turn)) {
      const ordered = Array.from(turn.querySelectorAll(`${options.assistantSelector ?? ui.assistantSelector},${ui.streamingStatusSelector},${ui.labelSelector}`));
      turnOrders.set(turn, new Map(ordered.map((element, index) => [element, index])));
    }
    return turnOrders.get(turn);
  };
  const codeBlock = node => node.nodeType === 1 && (node.tagName === "PRE" || node.getAttribute(ui.markdownCopyAttribute) === ui.codeBlockCopyValue);
  const block = node => node.nodeType === 1 && (codeBlock(node) || /^(?:DIV|P|BLOCKQUOTE|H[1-6]|UL|OL|LI|TABLE|TR)$/.test(node.tagName));
  const paragraph = node => codeBlock(node) || node.nodeType === 1 && /^(?:P|BLOCKQUOTE|H[1-6])$/.test(node.tagName);
  const readCode = element => {
    const codes = element.querySelectorAll(ui.codeSelector);
    const editors = element.querySelectorAll(ui.codeEditorSelector);
    if (codes.length === 1 && editors.length === 0) return codes[0].textContent ?? "";
    if (codes.length === 0 && editors.length === 1) {
      const lines = Array.from(editors[0].children);
      if (lines.every(line => line.classList.contains(ui.codeLineClass))) return lines.map(line => line.textContent ?? "").join("\n");
    }
    throw new Error("The assistant code block does not expose one complete source.");
  };
  const read = node => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    if (node.getAttribute(ui.markdownCopyAttribute) === ui.excludedCopyValue || /^(?:SCRIPT|STYLE)$/.test(node.tagName)) return "";
    if (node.tagName === "BR") return "\n";
    if (codeBlock(node)) return readCode(node);
    let text = "", previous;
    for (const child of node.childNodes) {
      const content = read(child);
      if (content === "") continue;
      if (text && (block(previous) || block(child))) text += paragraph(previous) || paragraph(child) ? "\n\n" : "\n";
      text += content;
      previous = child;
    }
    return text;
  };
  const selected = new Set(selectedElements), messages = new Map();
  // evaluateAll supplies document order. Multiple selected markdown fragments
  // can belong to one message; distinct wrappers with the same ID stay distinct
  // so the caller can reject that ambiguous identity.
  for (const element of selectedElements) {
    const wrapper = element.closest(wrapperSelector);
    let ancestor = element.parentElement;
    while (ancestor && !(selected.has(ancestor) && ancestor.closest(wrapperSelector) === wrapper)) ancestor = ancestor.parentElement;
    if (ancestor) continue; // Its selected ancestor already includes this text.
    const key = wrapper ?? element;
    if (!messages.has(key)) messages.set(key, { wrapper, answerRoots: [],
      reply: { messageId: wrapper?.getAttribute(ui.messageIdAttribute) ?? null, text: "" } });
    const message = messages.get(key);
    const turn = wrapper?.closest(ui.turnSelector);
    message.reply.turnKey = turn?.getAttribute(ui.turnKeyAttribute) ?? null;
    // Identity and document order remain global. Historical bodies and their
    // completion controls are irrelevant to an anchored observation.
    if (options?.generationTurnKey && message.reply.turnKey !== options.generationTurnKey) continue;
    // Status and reasoning roots use the same markdown renderer as answers.
    // The first status boundary preserves answer chunks between later tools.
    const firstStatus = turn?.querySelector(ui.streamingStatusSelector);
    const order = turn ? turnOrder(turn) : null;
    const commentary = element.closest(`${ui.streamingStatusSelector},${ui.reasoningSelector}`)
      || firstStatus && order.has(element) && order.has(firstStatus) && order.get(element) < order.get(firstStatus);
    const text = commentary ? "" : read(element);
    if (!commentary) message.answerRoots.push(element);
    if (message.reply.text && text) message.reply.text += "\n\n";
    message.reply.text += text;
  }
  const groups = [...messages.values()], replies = groups.map(group => group.reply);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
  const identities = new Map(), reasons = groups.map(group => !group.wrapper ? "missing-wrapper"
    : typeof group.reply.messageId !== "string" || !uuid.test(group.reply.messageId) ? "invalid-wrapper-id" : null);
  for (let index = 0; index < groups.length; index += 1) {
    if (reasons[index]) continue;
    const id = replies[index].messageId;
    if (!identities.has(id)) identities.set(id, []);
    identities.get(id).push(index);
  }
  const duplicates = [...identities.values()].filter(indices => indices.length > 1);
  for (const indices of duplicates) for (const index of indices) reasons[index] = "duplicate-wrapper-id";
  const invalid = reasons.flatMap((reason, index) => reason ? [index] : []);
  const result = () => {
    for (const group of groups) {
      const turn = group.wrapper?.closest(ui.turnSelector);
      if (options.generationTurnKey && group.reply.turnKey !== options.generationTurnKey) continue;
      group.reply.answer = group.answerRoots.length > 0;
      const finalRoot = group.answerRoots.at(-1);
      const order = turn ? turnOrder(turn) : null;
      group.reply.completionActionAfter = Boolean(finalRoot && turn && Array.from(turn.querySelectorAll(ui.labelSelector))
        .some(action => action.getAttribute(ui.labelAttribute) === options.regenerateName
          && !action.closest(options.assistantSelector) && order.has(finalRoot) && order.has(action) && order.get(finalRoot) < order.get(action)));
    }
    const projection = { replies, turns: turns.map(turn => {
      const turnKey = turn.getAttribute(ui.turnKeyAttribute);
      if (options.generationTurnKey && turnKey !== options.generationTurnKey) return { turnKey };
      const states = Array.from(turn.querySelectorAll(ui.turnStateSelector));
      return { turnKey,
        matchesGenerationMarker: Boolean(options.generationMarker && (turn.textContent ?? '').includes(options.generationMarker)),
        complete: states.length === 1 && states[0].getAttribute(ui.turnStateAttribute) === ui.completeTurnState };
    }) };
    if (options.observation) {
      const bodies = elements.filter(element => element.tagName === "BODY");
      const body = bodies.length === 1 ? bodies[0] : null, document = body?.ownerDocument;
      if (!document || document.body !== body) throw new Error("The browser observation document is unavailable.");
      const controls = elements.filter(element => element !== body && !element.matches(ui.turnSelector)
        && !element.matches(options.assistantSelector));
      // The semantic union selected each exact accessible control. Canonical
      // direct labels or text identify its group without guessing aria-labelledby.
      const name = element => element.getAttribute("aria-labelledby") ? null
        : element.getAttribute("aria-label") || (element.textContent ?? "").replace(/\s+/gu, " ").trim();
      const button = element => element.matches('button,[role="button"]');
      const heading = element => /^(?:H[1-6])$/u.test(element.tagName) || element.getAttribute("role") === "heading";
      const visible = element => {
        const rect = element.getBoundingClientRect(), style = document.defaultView.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse";
      };
      const groups = [
        ["stop", ui.stopButtonExactName, button], ["regenerate", ui.regenerateButtonExactName, button],
        ["temporaryToggle", ui.temporaryToggleName, button], ["temporaryHeading", ui.temporaryHeadingName, heading],
        ["fullButton", ui.startNewChatButtonName, button], ["fullBanner", ui.conversationFullText, () => true],
      ];
      const recognized = new Set(), values = {};
      for (const [key, expected, kind] of groups) {
        const matches = controls.filter(element => kind(element) && (key === "fullBanner"
          ? (element.textContent ?? "").replace(/\s+/gu, " ").trim() : name(element)) === expected);
        matches.forEach(element => recognized.add(element));
        values[key] = { matches, count: matches.length, visible: matches.some(visible) };
      }
      if (recognized.size !== controls.length || ["stop", "temporaryToggle", "temporaryHeading"].some(key => values[key].count > 1)) {
        throw new Error("The browser observation controls are unrecognized or ambiguous.");
      }
      const excluded = `${ui.assistantFinalReplySelector},${ui.assistantSelector},${ui.conversationContentSelector}`;
      const outside = key => values[key].matches.some(element => visible(element)
        && !element.closest(excluded) && !element.querySelector(excluded));
      projection.observation = { url: document.URL, stopVisible: values.stop.visible,
        regenerateVisible: values.regenerate.visible, regenerateCount: values.regenerate.count,
        temporaryInactive: !values.temporaryToggle.visible && !values.temporaryHeading.visible,
        conversationFull: outside("fullBanner") && outside("fullButton") };
    }
    return projection;
  };
  if (!invalid.length) return result();
  const distinctReasons = new Set(invalid.map(index => reasons[index]));
  // Fixed reasons and counts remain useful without retaining any DOM structure,
  // reply identity, attribute value or assistant text in an error.
  const diagnostic = { reason: distinctReasons.size === 1 ? reasons[invalid[0]] : "mixed-invalid-identities",
    selectedElementCount: selectedElements.length, messageCount: groups.length,
    missingWrapperCount: reasons.filter(reason => reason === "missing-wrapper").length,
    invalidWrapperIdCount: reasons.filter(reason => reason === "invalid-wrapper-id").length,
    duplicateWrapperCount: reasons.filter(reason => reason === "duplicate-wrapper-id").length,
    duplicateIdCount: duplicates.length };
  replies[invalid[0]].identityDiagnostic = diagnostic;
  return result();
}

// This function is serialized into the active native REPL. It uses only public
// browser runtime objects; every call finishes inside that native execution.
function createBrowserView(state, options, replyReader, savedUrl) {
  const { ui } = options;
  const role = (name, kind = "button", tab = state.tab) => tab.playwright.getByRole(kind, { name, exact: true });
  const snapshot = (tab = state.tab, generationMarker, generationTurnKey) => tab.playwright.locator(`${ui.turnSelector},${ui.assistantFinalReplySelector}`)
    .evaluateAll(replyReader, { ui, assistantSelector: ui.assistantFinalReplySelector, regenerateName: ui.regenerateButtonExactName,
      ...(generationMarker ? { generationMarker } : {}), ...(generationTurnKey ? { generationTurnKey } : {}) }, { timeoutMs: 1000 });
  const replies = async (tab = state.tab) => (await snapshot(tab)).replies;
  const replyIdentityIssue = values => values.some(value => value.messageId === null || value.messageId === undefined) ? "missing-message-identity"
    : values.some(value => typeof value.messageId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value.messageId)) ? "invalid-message-identity"
      : new Set(values.map(value => value.messageId)).size !== values.length ? "duplicate-message-identity" : undefined;
  const validReplies = values => replyIdentityIssue(values) === undefined;
  const identityError = (message, values) => new Error(`${message} ROUTER_WEB_REPLY_IDENTITY_DIAGNOSTIC ${JSON.stringify(
    values.find(value => value.identityDiagnostic)?.identityDiagnostic ?? { reason: replyIdentityIssue(values), messageCount: values.length })}`);
  const currentReply = values => {
    const issue = replyIdentityIssue(values);
    if (issue) return { replyUnavailableReason: issue };
    if (!Array.isArray(state.baselineReplyIds)) return { replyUnavailableReason: "missing-send-baseline" };
    const baseline = new Set(state.baselineReplyIds);
    const latest = values.at(-1);
    if (!state.generationTurnKey) return { replyUnavailableReason: "missing-generation-identity" };
    const owned = values.filter(value => value.turnKey === state.generationTurnKey && !baseline.has(value.messageId));
    state.generationReplyIds = [...new Set([...(state.generationReplyIds ?? []), ...owned.map(value => value.messageId)])];
    if (!owned.length) return { replyUnavailableReason: "no-new-message" };
    if (owned.at(-1) !== latest) return { replyUnavailableReason: "generation-message-not-latest" };
    const answer = owned.filter(value => value.answer).at(-1);
    return answer?.text.trim() ? { reply: answer }
      : { reply: answer ?? owned.at(-1), replyUnavailableReason: "no-answer-message" };
  };
  const conversationFull = async () => {
    const outsideMessages = (elements, ui) => {
      const excluded = `${ui.assistantFinalReplySelector},${ui.assistantSelector},${ui.conversationContentSelector}`;
      return elements.some(element => !element.closest(excluded) && !element.querySelector(excluded));
    };
    const [banner, button] = await Promise.all([
      state.tab.playwright.getByText(ui.conversationFullText, { exact: true }).filter({ visible: true })
        .evaluateAll(outsideMessages, ui, { timeoutMs: 1000 }),
      role(ui.startNewChatButtonName).filter({ visible: true })
        .evaluateAll(outsideMessages, ui, { timeoutMs: 1000 }),
    ]);
    return banner && button;
  };
  const temporaryInactive = async (tab = state.tab) => {
    const [toggle, heading] = await Promise.all([
      role(ui.temporaryToggleName, "button", tab).isVisible(),
      role(ui.temporaryHeadingName, "heading", tab).isVisible(),
    ]);
    return !toggle && !heading;
  };
  const normal = async (value) => {
    value ??= await state.tab.url();
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.searchParams.has("temporary-chat") || !(await temporaryInactive())) return false;
    return state.hasSentMessage ? savedUrl(value) && value === state.savedUrl : url.pathname === "/";
  };
  const ensureOwned = async (reacquired = false) => {
    if (!state?.browser || !state.tab || !state.tabId || state.sessionId !== options.sessionId || !reacquired && options.tabId && options.tabId !== state.tabId) throw new Error("Owned browser binding is unavailable.");
    const matches = (await state.browser.tabs.list()).filter(tab => tab.id === state.tabId);
    if (matches.length !== 1) throw new Error("The owned saved chat tab is unavailable; continuation cannot replace a live binding.");
    const url = await state.tab.url();
    if (new URL(url).origin !== "https://chatgpt.com") throw new Error("The owned tab left ChatGPT.");
    return url;
  };
  const activeOwner = (turnIds = [options.turnId], requireActive = false) => {
    const current = globalThis.routerWebActiveTurns?.get(options.sessionId);
    if ((requireActive && !current) || current && (!turnIds.includes(current.turnId) || current.state !== state)) throw new Error("A different native turn owns the active browser cleanup.");
    return current;
  };
  const observeGeneration = async (ownedUrl) => {
    activeOwner([options.turnId], true);
    const normalUrl = value => state.hasSentMessage && savedUrl(value) && value === state.savedUrl;
    if (!normalUrl(ownedUrl)) throw new Error("The observed conversation left its normal saved URL.");
    const generation = state.tab.playwright.locator(`[${ui.turnKeyAttribute}="${state.generationTurnKey}"]`);
    const view = await state.tab.playwright.locator(`${ui.turnSelector},${ui.assistantFinalReplySelector}`)
      .or(state.tab.playwright.locator("body"))
      .or(role(ui.stopButtonExactName)).or(role(ui.temporaryToggleName)).or(role(ui.temporaryHeadingName, "heading"))
      .or(generation.getByRole("button", { name: ui.regenerateButtonExactName, exact: true }))
      .or(state.tab.playwright.getByText(ui.conversationFullText, { exact: true }).filter({ visible: true }))
      .or(role(ui.startNewChatButtonName).filter({ visible: true }))
      .evaluateAll(replyReader, { ui, assistantSelector: ui.assistantFinalReplySelector, regenerateName: ui.regenerateButtonExactName,
        generationTurnKey: state.generationTurnKey, observation: true }, { timeoutMs: 1000 });
    activeOwner([options.turnId], true);
    const { url, stopVisible, temporaryInactive, conversationFull: full } = view.observation;
    if (!normalUrl(url) || !temporaryInactive) throw new Error("The observed conversation left its normal saved URL.");
    const texts = view.replies;
    const anchorCount = view.turns.filter(turn => turn.turnKey === state.generationTurnKey).length;
    const current = anchorCount !== 1 || view.turns.at(-1)?.turnKey !== state.generationTurnKey
      ? { replyUnavailableReason: anchorCount > 1 ? "duplicate-generation-turn" : "generation-turn-not-latest" } : currentReply(texts);
    const { reply, replyUnavailableReason } = current, assistantText = reply?.text ?? "";
    if (reply) state.replyId = reply.messageId;
    if (reply?.completionActionAfter && view.observation.regenerateCount > 1) throw new Error("The browser observation controls are unrecognized or ambiguous.");
    const regenerateVisible = Boolean(reply?.completionActionAfter) && view.observation.regenerateVisible;
    const statusComplete = anchorCount === 1 && view.turns.find(turn => turn.turnKey === state.generationTurnKey).complete;
    const completed = assistantText.trim().length > 0 && !stopVisible && statusComplete && regenerateVisible;
    activeOwner([options.turnId], true);
    return { completed, assistantText, replyId: reply?.messageId ?? null,
      ...(replyUnavailableReason ? { replyUnavailableReason } : {}),
      baselineReplyIds: state.baselineReplyIds,
      generationTurnKey: state.generationTurnKey, generationReplyIds: state.generationReplyIds ?? [],
      stopVisible, statusComplete, regenerateVisible, tabId: state.tabId, url, normal: true, conversationFull: full };
  };
  return { role, snapshot, replies, validReplies, identityError, currentReply, conversationFull, savedUrl, temporaryInactive, normal, ensureOwned, activeOwner, observeGeneration };
}

function createBrowserOperationContext(state, options, nodeRepl, replyReader, viewFactory) {
  const { operation, ui } = options;
  const emit = value => nodeRepl.write(options.frameBegin + JSON.stringify({ routerBrowser: { operation, ...value } }) + options.frameEnd);
  const view = viewFactory(state, options, replyReader);
  const { role, replies, temporaryInactive, activeOwner } = view;
  // Native Interrupt runs in a new JS invocation. Retained tab ownership must
  // remain available there without looking for tabs by URL or replaying Send.
  const registerActive = () => {
    const active = globalThis.routerWebActiveTurns ??= new Map();
    active.set(options.sessionId, { turnId: options.turnId, state, stopButtonName: ui.stopButtonExactName });
  };
  const emptyComposer = async (tab = state.tab) => {
    const values = await role(ui.composerName, "textbox", tab).evaluateAll((elements, { ownedChipSelector, attribute }) => {
      const empty = node => {
        if (node.nodeType === 3) return !(node.textContent ?? "").trim();
        if (node.nodeType !== 1) return true;
        if (ownedChipSelector && node.matches(ownedChipSelector)) return true;
        if (node.getAttribute(attribute) === "false" || !/^(?:DIV|P|SPAN|BR)$/u.test(node.tagName)) return false;
        return Array.from(node.childNodes).every(empty);
      };
      return Array.from(elements, element => element.tagName === "DIV" && element.getAttribute(attribute) === "true" && empty(element));
    }, { ownedChipSelector: options.pluginChipSelector, attribute: ui.contentEditableAttribute }, { timeoutMs: 1000 });
    return values.length === 1 && values[0] === true;
  };
  const normalHomeMode = async (tab = state.tab) => await tab.url() === "https://chatgpt.com/" && await temporaryInactive(tab);
  const emptyNormalHome = async (tab = state.tab) => {
    if (!(await normalHomeMode(tab))) return false;
    const composer = role(ui.composerName, "textbox", tab), model = role(ui.modelButtonName, "button", tab), toggle = role(ui.temporaryButtonName, "button", tab);
    return await composer.isVisible() && await model.isVisible() && await model.isEnabled()
      && await toggle.isVisible() && await toggle.isEnabled() && await role(ui.normalHeadingName, "heading", tab).isVisible()
      && !(await role(ui.stopButtonExactName, "button", tab).isVisible()) && (await replies(tab)).length === 0 && await emptyComposer(tab);
  };
  const stopGeneration = async (turnIds = [options.turnId], requireActive = false) => {
    const current = activeOwner(turnIds, requireActive);
    const requireSavedUrl = async () => {
      if (state.savedUrl && await state.tab.url() !== state.savedUrl) throw new Error("The owned saved chat URL changed; cleanup cannot stop another conversation.");
    };
    await requireSavedUrl();
    const stop = role(current?.stopButtonName ?? ui.stopButtonExactName);
    const visible = await stop.isVisible();
    activeOwner(turnIds, requireActive);
    if (visible) {
      await requireSavedUrl();
      activeOwner(turnIds, requireActive);
      await stop.click();
      activeOwner(turnIds, requireActive);
      await stop.waitFor({ state: "hidden", timeoutMs: 10000 });
      activeOwner(turnIds, requireActive);
    }
  };
  const clearUnsentDraft = async () => {
    const composer = role(ui.composerName, "textbox");
    if (typeof state.unsentDraft !== "string" || typeof state.unsentComposerText !== "string"
        || !state.unsentComposerText.endsWith(state.unsentDraft) || await composer.innerText() !== state.unsentComposerText) throw new Error("The unsent composer draft changed or became an attachment; continuation cannot replay it.");
    await composer.press("Control+A");
    await composer.press("Backspace");
    if ((await composer.innerText()).trim() || await role(ui.sendButtonExactName).isEnabled()) throw new Error("The unsent composer draft was not cleared; continuation cannot replay it.");
  };
  const resetChat = () => {
    Object.assign(state, { hasSentMessage: false, baselineReplyIds: [], sendAttempted: false, sendClicked: false,
      sendConfirmed: false, completed: false, retained: false });
    for (const key of ["savedUrl", "unsentDraft", "unsentComposerText", "replyId", "generationTurnKey", "generationReplyIds"]) delete state[key];
  };

  const requireBinding = () => {
    if (!state?.browser) throw new Error("Active native browser binding was lost; bootstrap is required for a new conversation.");
    if (state.sessionId !== options.sessionId) throw new Error("Owned browser binding belongs to another native session.");
  };
  return { ...view, emit, registerActive, emptyComposer, normalHomeMode, emptyNormalHome, stopGeneration, clearUnsentDraft, resetChat, requireBinding };
}

// Selection ships only with Send. These reads share a stable picker phase;
// mutations and their required readback remain sequential.
async function selectBrowserModel(state, options, role) {
  const { ui } = options;
  const menu = role(ui.modelMenuName, "menu");
  if (!(await menu.isVisible())) await role(ui.modelButtonName).click();
  // The current picker renders the family as generic text inside an unnamed
  // radio menu item. Match its observed DOM text, then verify the full text.
  const familyLocator = () => menu.locator(ui.familySelector).filter({ hasText: options.modelFamily });
  const expand = menu.getByRole("menuitem", { name: ui.modelExpandName, exact: true });
  const power = menu.getByRole("menuitem", { name: ui.powerMenuItemName, exact: true });
  let family = familyLocator();
  const [familyCount, familyText, familyChecked] = await Promise.all([
    family.count(), family.textContent(), family.getAttribute(ui.checkedAttribute),
  ]);
  if (familyCount !== 1 || familyText?.trim() !== options.modelFamily) throw new Error("Expected one exact observed model family.");
  // Read the actual checked row before changing the picker. Collapsed rows
  // are readable but clipped over Power, so only click after expanding.
  if (familyChecked !== "true") {
    if (await expand.isVisible()) await expand.click();
    if (await expand.isVisible() || await power.isVisible()) throw new Error("The model family list did not expand; its clipped row cannot be selected.");
    await family.click();
  } else if (!(await power.isVisible())) {
    // An already-expanded list returns to Power when its selected row is clicked.
    if (await expand.isVisible()) throw new Error("The selected model Power view is unavailable.");
    await family.click();
  }
  family = familyLocator();
  const [selectedCount, selectedText] = await Promise.all([family.count(), family.textContent()]);
  if (selectedCount !== 1 || selectedText?.trim() !== options.modelFamily) throw new Error("Expected one exact observed model family.");
  const slider = menu.locator(ui.powerSliderSelector);
  const readPower = async attribute => {
    const value = await slider.getAttribute(attribute);
    if (typeof value !== "string" || !/^[0-4]$/.test(value)) throw new Error("Observed Power attributes are unavailable.");
    return Number(value);
  };
  const [initialValue, minimum, maximum] = await Promise.all([
    readPower(ui.powerValueAttribute), readPower(ui.powerMinimumAttribute), readPower(ui.powerMaximumAttribute),
  ]);
  let value = initialValue;
  if (minimum !== 0 || maximum !== 4 || !Number.isInteger(value) || value < 0 || value > 4) throw new Error("Observed Power range changed.");
  for (let move = 0; value !== options.power && move < 4; move += 1) {
    const direction = value > options.power ? -1 : 1;
    await power.press(direction === -1 ? "ArrowLeft" : "ArrowRight");
    const after = await readPower(ui.powerValueAttribute);
    if (after !== value + direction) throw new Error("Power did not move exactly one step.");
    value = after;
  }
  const [checked, text] = await Promise.all([family.getAttribute(ui.checkedAttribute), family.textContent()]);
  if (checked !== "true" || text?.trim() !== options.modelFamily || value !== options.power) throw new Error("Requested model and Power were not verified.");
  await power.press("Escape");
}

async function runBrowserBootstrap(state, options, nodeRepl, replyReader, viewFactory, waitForState, createContext) {
  const { emit } = createContext(state, options, nodeRepl, replyReader, viewFactory);
  if (state.sessionId && (state.sessionId !== options.sessionId || state.runtimeModule !== options.runtimeModule)) throw new Error("Browser binding belongs to another session or runtime.");
  if (!state.agent) state.agent = await (await import(options.runtimeModule)).setupBrowserRuntime();
  const own = (await state.agent.browsers.list()).filter(browser => browser.type === "iab" && browser.metadata?.codexSessionId === options.sessionId);
  if (own.length !== 1 || typeof own[0].id !== "string") throw new Error("Expected exactly one same-session in-app browser.");
  if (state.browser && state.browser.browserId !== own[0].id) throw new Error("Owned browser identity changed.");
  state.browser ??= await state.agent.browsers.get(own[0].id);
  state.sessionId = options.sessionId;
  state.runtimeModule = options.runtimeModule;
  emit({});
  return;
}

async function runBrowserOpen(state, options, nodeRepl, replyReader, viewFactory, waitForState, createContext) {
  const { emit, registerActive, emptyNormalHome, requireBinding } = createContext(state, options, nodeRepl, replyReader, viewFactory);
  requireBinding();
  if (state.tab) throw new Error("This browser binding already owns a tab.");
  state.tab = await state.browser.tabs.new();
  state.tabId = state.tab.id;
  registerActive();
  await state.tab.goto("https://chatgpt.com/");
  await waitForState(emptyNormalHome, Date.now() + 10000, "Empty normal ChatGPT home controls did not become ready within 10 seconds.");
  await state.tab.markHandoff();
  emit({ tabId: state.tabId, url: await state.tab.url(), normal: true });
  return;
}

async function runBrowserContinuation(state, options, nodeRepl, replyReader, viewFactory, waitForState, createContext) {
  const { role, snapshot, validReplies, identityError, currentReply, conversationFull, temporaryInactive, normal, ensureOwned, activeOwner, emit, registerActive, emptyComposer, normalHomeMode, emptyNormalHome, stopGeneration, clearUnsentDraft, resetChat, requireBinding } = createContext(state, options, nodeRepl, replyReader, viewFactory);
  const { operation, ui } = options;
  let recovered = false;
  let verifyRecoveryTexts;
  let recoverMissingTab = false;
  if (operation === "continue" && options.recovery && !state.bindingLost && !state.needsHistory && !options.needsHistory && state.browser && state.tabId) {
    if (state.sessionId !== options.sessionId) throw new Error("Owned browser binding belongs to another native session.");
    activeOwner(options.expectedOwnerTurnIds, true);
    if (state.sendClicked && !state.sendConfirmed) throw new Error("The preceding Send is uncertain; it cannot be replayed.");
    const owned = (await state.browser.tabs.list()).filter(tab => tab.id === state.tabId);
    recoverMissingTab = owned.length === 0;
    if (recoverMissingTab && state.savedUrl !== options.recovery.url) throw new Error("The missing tab recovery URL differs from the owned saved conversation.");
  }
  if (operation === "continue" && (state.bindingLost || recoverMissingTab)) {
    // A confirmed saved URL and generation anchor can recover a lost kernel.
    // A browser/tab ID is only a hint after restart; the exact saved URL and
    // rendered generation remain authoritative. Never replace a surviving owner.
    const proof = options.recovery;
    const requireRecoveryOwnership = () => {
      if (recoverMissingTab) activeOwner(options.expectedOwnerTurnIds, true);
      else {
        const recoveryOwner = globalThis.routerWebActiveTurns?.get(options.sessionId);
        if (recoveryOwner?.state === state) throw new Error("The preceding saved-chat recovery did not finish verification; continuation remains blocked.");
        if (recoveryOwner) throw new Error("A different native turn owns the active browser recovery.");
      }
    };
    requireRecoveryOwnership();
    const runtime = await import(options.runtimeModule);
    requireRecoveryOwnership();
    const agent = await runtime.setupBrowserRuntime();
    requireRecoveryOwnership();
    const own = (await agent.browsers.list()).filter(browser => browser.type === "iab" && browser.metadata?.codexSessionId === options.sessionId);
    requireRecoveryOwnership();
    if (own.length !== 1 || typeof own[0].id !== "string") throw new Error("The same-session browser is unavailable for recovery.");
    const browser = await agent.browsers.get(own[0].id);
    requireRecoveryOwnership();
    if (browser.browserId !== own[0].id) throw new Error("The current browser identity changed during recovery.");
    const tabs = await browser.tabs.list();
    requireRecoveryOwnership();
    const hinted = tabs.filter(tab => tab.id === proof.tabId);
    const matches = hinted.length ? hinted : tabs.filter(tab => tab.url === proof.url);
    if (matches.length > 1) throw new Error("The saved chat tab is ambiguous; recovery cannot choose a tab.");
    requireRecoveryOwnership();
    const tab = matches.length ? await browser.tabs.get(matches[0].id) : await browser.tabs.new();
    requireRecoveryOwnership();
    if (!tab?.id || matches.length && tab.id !== matches[0].id) throw new Error("The current tab identity changed during recovery.");
    const recoveryTabUrl = await tab.url();
    const navigate = recoveryTabUrl !== proof.url;
    requireRecoveryOwnership();
    if (matches.length && navigate && !(await emptyNormalHome(tab))) throw new Error("The known tab is not an empty normal ChatGPT home; recovery cannot overwrite it.");
    const { createHash } = await import("node:crypto");
    requireRecoveryOwnership();
    let recoveredReplyId, recoveredBaselineIds, recoveredGenerationIds;
    const unobservedRecovery = () => ({ reason: null, urlMatches: null, temporaryInactive: null,
      replyCount: null, replyIdentitiesValid: null, generationTurnCount: null, generationIsLatest: null,
      freshReplyCount: null, freshReplyIsLatest: null, expectedReplyMatches: null, replyTextAvailable: null,
      recordedReplyPresent: null, prefixLongEnough: null, prefixMatches: null,
      composerCount: null, composerShapeValid: null, composerEmpty: null,
      mountedTurnCount: null, prefixMatchingReplyCount: null, latestReplyPrefixMatches: null,
      checkpointReplyCount: null, checkpointIsLatestReply: null,
      checkpointPrefixLongEnough: null, checkpointPrefixMatches: null, checkpointHasTurnIdentity: null,
      checkpointTurnCount: null, checkpointTurnIsLatest: null,
      viewportReadSucceeded: null, viewportUrlMatches: null, viewportLastReplyMatches: null,
      scrollAncestorCount: null, scrollUnknownCount: null, scrollChainComplete: null,
      scrollHasAbove: null, scrollHasBelow: null, scrollAtEnd: null,
      documentHasAbove: null, documentHasBelow: null, documentAtEnd: null });
    let recoveryDiagnostic = unobservedRecovery();
    const recoveryRejected = reason => { recoveryDiagnostic.reason = reason; return false; };
    const boundedCount = values => Math.min(values.length, 10000);
    verifyRecoveryTexts = view => {
      const texts = view.replies;
      const fresh = texts.filter(value => !proof.baselineReplyIds.includes(value.messageId) && value.turnKey === proof.generationTurnKey);
      const latest = fresh.filter(value => value.answer).at(-1) ?? fresh.at(-1), text = latest?.text;
      const expectedReplyId = proof.replyId ?? recoveredReplyId;
      recoveryDiagnostic.replyCount = boundedCount(texts);
      if (!(recoveryDiagnostic.replyIdentitiesValid = validReplies(texts))) return recoveryRejected("invalid-reply-identities");
      const generationTurns = view.turns.filter(turn => turn.turnKey === proof.generationTurnKey);
      recoveryDiagnostic.generationTurnCount = boundedCount(generationTurns);
      if (generationTurns.length !== 1) {
        // Independent diagnostic facts do not replace the generation guard.
        recoveryDiagnostic.mountedTurnCount = boundedCount(view.turns);
        if (proof.assistantPrefix.length > 0) {
          const matches = texts.map(value => typeof value.text === "string" && value.text.length >= proof.assistantPrefix.length
            ? createHash("sha256").update(value.text.slice(0, proof.assistantPrefix.length), "utf8").digest("hex") === proof.assistantPrefix.sha256 : null);
          recoveryDiagnostic.prefixMatchingReplyCount = boundedCount(matches.filter(value => value === true));
          recoveryDiagnostic.latestReplyPrefixMatches = matches.at(-1) ?? null;
        }
        if (proof.replyId) {
          const checkpoints = texts.filter(value => value.messageId === proof.replyId);
          recoveryDiagnostic.checkpointReplyCount = boundedCount(checkpoints);
          if (checkpoints.length === 1) {
            const checkpoint = checkpoints[0];
            recoveryDiagnostic.checkpointIsLatestReply = checkpoint === texts.at(-1);
            if (typeof checkpoint.text === "string") {
              recoveryDiagnostic.checkpointPrefixLongEnough = checkpoint.text.length >= proof.assistantPrefix.length;
              if (recoveryDiagnostic.checkpointPrefixLongEnough) recoveryDiagnostic.checkpointPrefixMatches = createHash("sha256")
                .update(checkpoint.text.slice(0, proof.assistantPrefix.length), "utf8").digest("hex") === proof.assistantPrefix.sha256;
            }
            recoveryDiagnostic.checkpointHasTurnIdentity = typeof checkpoint.turnKey === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(checkpoint.turnKey);
            if (recoveryDiagnostic.checkpointHasTurnIdentity) {
              const turns = view.turns.filter(turn => turn.turnKey === checkpoint.turnKey);
              recoveryDiagnostic.checkpointTurnCount = boundedCount(turns);
              if (turns.length === 1) recoveryDiagnostic.checkpointTurnIsLatest = view.turns.at(-1)?.turnKey === checkpoint.turnKey;
            }
          }
        }
        return recoveryRejected("generation-turn-not-unique");
      }
      if (!(recoveryDiagnostic.generationIsLatest = view.turns.at(-1)?.turnKey === proof.generationTurnKey)) return recoveryRejected("generation-turn-not-latest");
      recoveryDiagnostic.freshReplyCount = boundedCount(fresh);
      const progressing = !proof.completed;
      if (proof.retainedTabOnly) {
        if (fresh.length && !(recoveryDiagnostic.freshReplyIsLatest = fresh.at(-1) === texts.at(-1))) return recoveryRejected("fresh-reply-not-latest");
        if (!progressing && expectedReplyId && !(recoveryDiagnostic.expectedReplyMatches = latest?.messageId === expectedReplyId)) return recoveryRejected("expected-reply-mismatch");
        if (!fresh.length) {
          recoveredBaselineIds = proof.baselineReplyIds;
          return proof.assistantPrefix.length === 0 || recoveryRejected("missing-fresh-reply");
        }
      }
      const recorded = progressing && expectedReplyId ? fresh.find(value => value.messageId === expectedReplyId) : latest;
      if (!progressing && expectedReplyId && !(recoveryDiagnostic.expectedReplyMatches = latest?.messageId === expectedReplyId)) return recoveryRejected("expected-reply-mismatch");
      if (!(recoveryDiagnostic.replyTextAvailable = typeof text === "string")) return recoveryRejected(fresh.length ? "reply-text-unavailable" : "missing-fresh-reply");
      recoveryDiagnostic.recordedReplyPresent = Boolean(recorded);
      if (recorded) {
        if (!(recoveryDiagnostic.prefixLongEnough = recorded.text.length >= proof.assistantPrefix.length)) return recoveryRejected("reply-prefix-too-short");
        if (!(recoveryDiagnostic.prefixMatches = createHash("sha256").update(recorded.text.slice(0, proof.assistantPrefix.length), "utf8").digest("hex") === proof.assistantPrefix.sha256)) return recoveryRejected("reply-prefix-mismatch");
      } else if (!progressing) return recoveryRejected("recorded-reply-missing");
      recoveredReplyId = latest.messageId;
      recoveredBaselineIds = proof.baselineReplyIds;
      recoveredGenerationIds = [...new Set([...proof.generationReplyIds, ...fresh.map(value => value.messageId)])];
      return true;
    };
    const recoveryViewport = view => tab.playwright.locator(ui.assistantFinalReplySelector).evaluateAll((elements, { url, replyId, messageIdAttribute }) => {
      const result = { viewportReadSucceeded: true, viewportUrlMatches: null, viewportLastReplyMatches: null,
        scrollAncestorCount: null, scrollUnknownCount: null, scrollChainComplete: null,
        scrollHasAbove: null, scrollHasBelow: null, scrollAtEnd: null,
        documentHasAbove: null, documentHasBelow: null, documentAtEnd: null };
      const last = elements.at(-1), document = last?.ownerDocument;
      if (!last || !document) return result;
      result.viewportUrlMatches = document.URL === url;
      result.viewportLastReplyMatches = last.closest(`[${messageIdAttribute}]`)?.getAttribute(messageIdAttribute) === replyId;
      if (!result.viewportUrlMatches || !result.viewportLastReplyMatches || last.isConnected !== true) return result;
      const geometry = element => {
        const { scrollTop: top, scrollHeight: height, clientHeight: client } = element;
        if (![top, height, client].every(Number.isFinite) || top < 0 || client <= 0 || height < client || top > height - client + 2) return null;
        const above = top > 2, below = height - client - top > 2;
        return { above, below, end: !below };
      };
      const scrolling = document.scrollingElement, documentGeometry = scrolling && geometry(scrolling);
      if (documentGeometry) {
        result.documentHasAbove = documentGeometry.above; result.documentHasBelow = documentGeometry.below; result.documentAtEnd = documentGeometry.end;
      }
      const values = [], seen = new Set();
      let current = last.parentElement, unknown = 0;
      for (; current && !seen.has(current) && seen.size < 64; current = current.parentElement) {
        seen.add(current);
        if (current === scrolling) continue;
        let overflow;
        try { overflow = document.defaultView.getComputedStyle(current).overflowY; } catch { unknown += 1; continue; }
        if (/^(?:visible|hidden|clip)$/u.test(overflow)) continue;
        if (typeof overflow !== "string" || !/^(?:auto|scroll|overlay)$/u.test(overflow)) { unknown += 1; continue; }
        const value = geometry(current);
        if (value) values.push(value); else unknown += 1;
      }
      result.scrollAncestorCount = values.length; result.scrollUnknownCount = unknown;
      result.scrollChainComplete = current === null && Boolean(document.documentElement && seen.has(document.documentElement));
      const observed = key => values.some(value => value[key]) ? true : unknown || !result.scrollChainComplete ? null : false;
      result.scrollHasAbove = observed("above"); result.scrollHasBelow = observed("below");
      result.scrollAtEnd = values.some(value => !value.end) ? false : unknown || !result.scrollChainComplete ? null : true;
      return result;
    }, { url: proof.url, replyId: view.replies.at(-1)?.messageId ?? null, messageIdAttribute: ui.messageIdAttribute }, { timeoutMs: 1000 });
    const verifiedReply = async () => {
      recoveryDiagnostic = unobservedRecovery();
      if (!(recoveryDiagnostic.urlMatches = await tab.url() === proof.url)) return recoveryRejected("saved-url-changed");
      if (!(recoveryDiagnostic.temporaryInactive = await temporaryInactive(tab))) return recoveryRejected("temporary-mode-active");
      const view = await snapshot(tab), accepted = verifyRecoveryTexts(view);
      if (!navigate && !accepted && recoveryDiagnostic.reason === "generation-turn-not-unique") {
        try { Object.assign(recoveryDiagnostic, await recoveryViewport(view)); }
        catch { recoveryDiagnostic.viewportReadSucceeded = false; }
      }
      return accepted;
    };
    const emptyRecoveryComposer = async () => {
      // The existing emptiness predicate, projected once with fixed failure
      // categories. No labels, attributes, draft text or reply proof is returned.
      const values = await role(ui.composerName, "textbox", tab).evaluateAll((elements, { ownedChipSelector, attribute }) => {
        const issue = node => {
          if (node.nodeType === 3) return (node.textContent ?? "").trim() ? "draft" : null;
          if (node.nodeType !== 1 || ownedChipSelector && node.matches(ownedChipSelector)) return null;
          if (node.getAttribute(attribute) === "false" || !/^(?:DIV|P|SPAN|BR)$/u.test(node.tagName)) return "shape";
          for (const child of node.childNodes) { const found = issue(child); if (found) return found; }
          return null;
        };
        return Array.from(elements, element => element.tagName === "DIV" && element.getAttribute(attribute) === "true" ? issue(element) : "shape");
      }, { ownedChipSelector: options.pluginChipSelector, attribute: ui.contentEditableAttribute }, { timeoutMs: 1000 });
      recoveryDiagnostic.composerCount = boundedCount(values);
      if (values.length !== 1) return recoveryRejected(values.length ? "composer-ambiguous" : "composer-unavailable");
      recoveryDiagnostic.composerShapeValid = values[0] === "shape" ? false : values[0] === null ? true : null;
      recoveryDiagnostic.composerEmpty = values[0] === null;
      return recoveryDiagnostic.composerEmpty || recoveryRejected(values[0] === "shape" ? "composer-shape-invalid" : "composer-draft-present");
    };
    if (!navigate && (!(await verifiedReply()) || !(await emptyRecoveryComposer()))) throw new Error(`The saved chat reply or composer changed; recovery cannot reuse it. ROUTER_WEB_RECOVERY_DIAGNOSTIC ${JSON.stringify(recoveryDiagnostic)}`);
    requireRecoveryOwnership();
    Object.assign(state, { agent, browser, tab, tabId: tab.id, sessionId: options.sessionId, runtimeModule: options.runtimeModule, bindingLost: true,
      hasSentMessage: true, savedUrl: proof.url,
      baselineReplyIds: [...proof.baselineReplyIds], replyId: proof.replyId,
      generationTurnKey: proof.generationTurnKey, generationReplyIds: [...proof.generationReplyIds],
      sendAttempted: true, sendClicked: true, sendConfirmed: true, completed: proof.completed, retained: proof.completed });
    registerActive();
    await tab.markHandoff();
    activeOwner([options.turnId], true);
    if (navigate) {
      if (matches.length && !(await emptyNormalHome(tab)) || await tab.url() !== recoveryTabUrl) throw new Error("The recovery tab changed before saved chat navigation; recovery cannot overwrite it.");
      activeOwner([options.turnId], true);
      await tab.goto(proof.url);
      await waitForState(verifiedReply, Date.now() + 10000,
        "The saved chat URL and reply did not become available within 10 seconds; recovery cannot start a new chat.");
      if (!(await emptyComposer())) throw new Error("The saved chat composer has a draft; recovery cannot overwrite it.");
    }
    state.baselineReplyIds = [...recoveredBaselineIds];
    state.replyId = recoveredReplyId;
    state.generationReplyIds = recoveredGenerationIds ?? [...proof.generationReplyIds];
    recovered = true;
  }

  requireBinding();
  await ensureOwned(recovered);
  const interrupted = options.interruptedTurnId !== undefined;
  const owners = recovered ? [options.turnId] : options.expectedOwnerTurnIds;
  activeOwner(owners, true);
  if (state.sendClicked && !state.sendConfirmed) throw new Error("The preceding Send is uncertain; it cannot be replayed.");
  if (options.needsHistory && !state.needsHistory) throw new Error("The pending full-history successor binding is unavailable.");
  if (state.needsHistory) {
    if (!state.rolloverAttempted || !state.rolloverFromUrl) throw new Error("The pending full-history successor binding is unavailable.");
    if (interrupted && state.sendAttempted && !state.sendConfirmed) {
      if (!(await normalHomeMode()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The pending full-history successor is not an idle normal home.");
      await state.tab.markHandoff();
      activeOwner(owners, true);
      if (!(await normalHomeMode()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The pending full-history successor left its idle normal home; the draft was not cleared.");
      await clearUnsentDraft();
    }
    if (!(await emptyNormalHome())) throw new Error("The pending full-history successor is not a proven empty normal home.");
    await state.tab.markHandoff();
    if (!(await emptyNormalHome())) throw new Error("The pending full-history successor left its proven empty normal home.");
    activeOwner(owners, true);
    resetChat();
    registerActive();
    emit({ tabId: state.tabId, url: await state.tab.url(), normal: true, needsHistory: true, assistantText: "", conversationFull: false,
      ...(interrupted ? { interrupted: true } : {}) });
    return;
  }
  if (!(await normal())) throw new Error("The retained conversation is not ready for continuation.");
  if (await conversationFull()) {
    const view = await snapshot(), texts = view.replies;
    if (!(await normal())) throw new Error("The retained conversation left its normal saved URL during continuation.");
    if (recovered) {
      if (!verifyRecoveryTexts(view)) throw new Error("The saved chat latest reply changed during continuation; recovery cannot reuse it.");
      delete state.bindingLost;
    }
    const assistantText = state.sendConfirmed ? currentReply(texts).reply?.text ?? "" : "";
    await state.tab.markHandoff();
    activeOwner(owners, true);
    emit({ tabId: state.tabId, url: await state.tab.url(), normal: true, assistantText, conversationFull: true,
      ...(recovered ? { recovered: true } : {}), ...(interrupted ? { interrupted: true } : {}) });
    return;
  }
  await state.tab.markHandoff();
  if (interrupted) {
    await stopGeneration(owners, true);
    if (state.sendAttempted && !state.sendConfirmed) await clearUnsentDraft();
    state.retained = true;
  } else if (!state.completed || !state.retained || await role(ui.stopButtonExactName).isVisible()) throw new Error("The retained conversation is not ready for continuation.");
  if (!(await emptyComposer())) throw new Error("The retained conversation composer has a draft; continuation cannot overwrite it.");
  const view = await snapshot(), texts = view.replies;
  if (!(await normal())) throw new Error("The retained conversation left its normal saved URL during continuation.");
  if (recovered) {
    if (!verifyRecoveryTexts(view)) throw new Error("The saved chat latest reply changed during continuation; recovery cannot reuse it.");
    delete state.bindingLost;
  }
  const assistantText = state.sendConfirmed ? currentReply(texts).reply?.text ?? "" : "";
  if (!validReplies(texts)) throw identityError("The retained conversation has missing or ambiguous assistant message identities.", texts);
  const continuationUrl = await state.tab.url();
  if (state.hasSentMessage && continuationUrl !== state.savedUrl) throw new Error("The retained conversation left its saved URL during continuation.");
  activeOwner(owners, true);
  state.baselineReplyIds = [...new Set([...(state.baselineReplyIds ?? []), ...(state.generationReplyIds ?? []), ...(state.replyId ? [state.replyId] : []), ...texts.map(value => value.messageId)])];
  delete state.replyId;
  delete state.generationTurnKey;
  delete state.generationReplyIds;
  state.sendAttempted = false;
  state.sendClicked = false;
  state.sendConfirmed = false;
  delete state.unsentDraft;
  delete state.unsentComposerText;
  state.completed = false;
  state.retained = false;
  registerActive();
  emit({ tabId: state.tabId, url: continuationUrl, normal: true, assistantText, conversationFull: false,
    ...(recovered ? { recovered: true } : {}), ...(interrupted ? { interrupted: true } : {}) });
}

async function runBrowserRollover(state, options, nodeRepl, replyReader, viewFactory, waitForState, createContext) {
  const { role, conversationFull, normal, ensureOwned, activeOwner, emit, registerActive, emptyComposer, emptyNormalHome, resetChat, requireBinding } = createContext(state, options, nodeRepl, replyReader, viewFactory);
  const { ui } = options;
  requireBinding();
  await ensureOwned();
  activeOwner(options.expectedOwnerTurnIds, true);
  if (state.sendClicked && !state.sendConfirmed) throw new Error("The saved chat cannot roll over with an uncertain Send.");
  if (state.rolloverAttempted) {
    if (!state.needsHistory || state.rolloverFromUrl !== options.previousChatUrl || !(await emptyNormalHome())) throw new Error("The preceding rollover is not a proven empty normal home; Start new chat cannot be clicked again.");
    await state.tab.markHandoff();
  } else {
    const ready = async () => state.savedUrl === options.previousChatUrl && await state.tab.url() === options.previousChatUrl
      && await normal() && await conversationFull() && !(await role(ui.stopButtonExactName).isVisible()) && await emptyComposer();
    const start = role(ui.startNewChatButtonName).filter({ visible: true });
    if (!(await ready()) || await start.count() !== 1) throw new Error("Rollover requires the exact owned full saved chat, an idle empty composer and one visible Start new chat button.");
    await state.tab.markHandoff();
    if (!(await ready()) || await start.count() !== 1) throw new Error("The full saved chat changed before rollover; nothing clicked.");
    activeOwner(options.expectedOwnerTurnIds, true);
    Object.assign(state, { needsHistory: true, rolloverAttempted: true, rolloverFromUrl: options.previousChatUrl });
    await start.click();
    await waitForState(emptyNormalHome, Date.now() + 10000, "Rollover did not reach an empty normal home within 10 seconds; Start new chat cannot be clicked again.");
  }
  if (!(await emptyNormalHome())) throw new Error("The rollover successor is no longer a proven empty normal home.");
  activeOwner(options.expectedOwnerTurnIds, true);
  resetChat();
  registerActive();
  emit({ rolledOver: true, needsHistory: true, previousChatUrl: options.previousChatUrl, tabId: state.tabId, url: await state.tab.url(), normal: true });
}

async function runBrowserSend(state, options, nodeRepl, replyReader, viewFactory, waitForState, createContext, selectModel) {
  const { role, snapshot, validReplies, identityError, conversationFull, savedUrl, normal, ensureOwned, activeOwner, emit, emptyComposer, requireBinding } = createContext(state, options, nodeRepl, replyReader, viewFactory);
  const { ui } = options;
  const chip = () => state.tab.playwright.locator(options.pluginChipSelector);
  requireBinding();
  await ensureOwned();
  if (state.sendAttempted) throw new Error("This message was already attempted; uncertain sends cannot be replayed.");
  if (!(await normal()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned saved chat is not idle.");
  if (await conversationFull()) {
    emit({ sent: false, conversationFull: true, tabId: state.tabId, url: await state.tab.url(), normal: true });
    return;
  }
  if (!(await emptyComposer())) throw new Error("The owned composer has a draft; nothing sent.");
  if (options.pluginAppId) {
    if (!(await chip().isVisible())) {
      await role(ui.addButtonName).click();
      const selection = role(options.pluginSelectionButtonName);
      if (await selection.count() !== 1) throw new Error("The configured plugin button is unavailable or ambiguous.");
      await selection.click();
    }
    if (!(await chip().isVisible())) throw new Error("The configured plugin chip was not attached.");
  }
  if (!(await emptyComposer())) throw new Error("Attaching the plugin changed the composer draft; nothing sent.");
  if (!(await normal()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned saved chat is no longer idle; nothing sent.");
  const beforeSend = await snapshot(), baseline = beforeSend.replies;
  if (!validReplies(baseline)) throw identityError("The assistant reply baseline has missing or ambiguous message identities; nothing sent.", baseline);
  state.baselineReplyIds = [...new Set([...(state.baselineReplyIds ?? []), ...(state.generationReplyIds ?? []), ...(state.replyId ? [state.replyId] : []), ...baseline.map(value => value.messageId)])];
  delete state.replyId;
  delete state.generationTurnKey;
  state.generationReplyIds = [];
  state.sendAttempted = true;
  state.sendClicked = false;
  state.sendConfirmed = false;
  state.unsentDraft = ` ${options.prompt}`;
  const composer = role(ui.composerName, "textbox");
  await composer.press("End");
  await composer.type(state.unsentDraft);
  state.unsentComposerText = await composer.innerText();
  if (options.pluginAppId && !(await chip().isVisible())) throw new Error("Typing removed the plugin chip; nothing sent.");
  const send = role(ui.sendButtonExactName);
  const sendDeadline = Date.now() + 10000;
  const waitForSend = () => waitForState(() => send.isEnabled(), sendDeadline, "Send did not become ready within 10 seconds; nothing sent.");
  // A large paste can become an attachment. Keep a short, nonsecret marker
  // outside that payload so the confirmed Send owns one observable turn.
  await waitForSend();
  if (options.pluginAppId && !(await chip().isVisible())) throw new Error("The plugin chip was lost while waiting for Send; nothing sent.");
  if (!(await normal()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned saved chat is no longer idle; nothing sent.");
  const settledComposerText = await composer.innerText();
  if (settledComposerText !== state.unsentComposerText && !(await emptyComposer())) throw new Error("The composer draft changed while the paste settled; nothing sent.");
  const generationMarker = `\nRouter generation: ${options.turnId}`;
  state.unsentDraft += generationMarker;
  await composer.press('End');
  await composer.type(generationMarker);
  state.unsentComposerText = await composer.innerText();
  if (state.unsentComposerText !== settledComposerText + generationMarker) throw new Error("The composer generation marker changed or was transformed; nothing sent.");
  await waitForSend();
  // Attachment and paste can alter the picker. Select and verify the exact
  // requested family and Power once, using the current DOM before Send.
  await selectModel(state, options, role);
  if (await composer.innerText() !== state.unsentComposerText) throw new Error("The composer draft changed before Send; nothing sent.");
  if (options.pluginAppId && !(await chip().isVisible())) throw new Error("The plugin chip was lost before Send; nothing sent.");
  if (!(await normal()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned saved chat is no longer idle; nothing sent.");
  activeOwner([options.turnId], true);
  await state.tab.markHandoff();
  activeOwner([options.turnId], true);
  if (await composer.innerText() !== state.unsentComposerText) throw new Error("The composer draft changed before Send; nothing sent.");
  if (options.pluginAppId && !(await chip().isVisible())) throw new Error("The plugin chip was lost before Send; nothing sent.");
  if (!(await normal()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned saved chat is no longer idle; nothing sent.");
  state.sendClicked = true;
  await send.click();
  state.hasSentMessage = true;
  await waitForState(async () => savedUrl(await state.tab.url()), sendDeadline,
    "The Send has no verified saved conversation URL within 10 seconds; its effect is uncertain.");
  const confirmedUrl = await state.tab.url();
  if (state.savedUrl && state.savedUrl !== confirmedUrl) throw new Error("The Send changed the owned saved conversation URL; its effect is uncertain.");
  state.savedUrl = confirmedUrl;
  if (!(await normal())) throw new Error("The Send did not remain in the normal saved conversation; its effect is uncertain.");
  const baselineTurns = new Set(beforeSend.turns.map(value => value.turnKey));
  let anchor;
  await waitForState(async () => {
    const afterSend = await snapshot(state.tab, generationMarker.trim());
    const candidates = afterSend.turns.filter(value => !baselineTurns.has(value.turnKey)
      && value.matchesGenerationMarker);
    const latestTurn = afterSend.turns.at(-1);
    if (candidates.length === 1 && candidates[0] === latestTurn
        && typeof latestTurn.turnKey === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(latestTurn.turnKey)
        && afterSend.turns.filter(value => value.turnKey === latestTurn.turnKey).length === 1) anchor = latestTurn.turnKey;
    if (!anchor && !(await normal())) throw new Error("The Send left its saved conversation while confirming its turn; its effect is uncertain.");
    return Boolean(anchor);
  }, sendDeadline, "The Send has no unique prompt-owned turn within 10 seconds; its effect is uncertain.");
  state.generationTurnKey = anchor;
  state.sendConfirmed = true;
  delete state.unsentDraft;
  delete state.unsentComposerText;
  for (const key of ["needsHistory", "rolloverAttempted", "rolloverFromUrl"]) delete state[key];
  emit({ sent: true, tabId: state.tabId, url: state.savedUrl, normal: true, conversationFull: false,
    baselineReplyIds: state.baselineReplyIds, generationTurnKey: state.generationTurnKey });
}

async function runBrowserObservation(state, options, nodeRepl, replyReader, viewFactory) {
  const { operation } = options;
  const emit = value => nodeRepl.write(options.frameBegin + JSON.stringify({ routerBrowser: { operation, ...value } }) + options.frameEnd);
  const { ensureOwned, activeOwner, observeGeneration } = viewFactory(state, options, replyReader);
  if (!state?.browser) throw new Error("Active native browser binding was lost; bootstrap is required for a new conversation.");
  if (state.sessionId !== options.sessionId) throw new Error("Owned browser binding belongs to another native session.");
  const ownedUrl = await ensureOwned();
  if (operation === "observe") {
    if (!state.sendAttempted) throw new Error("No message was issued for this browser binding.");
    // Return after one page read so native Interrupt and queued tools can run.
    const observation = await observeGeneration(ownedUrl);
    state.completed = observation.completed;
    emit(observation);
  } else if (operation === "retain") {
    if (!state.completed) throw new Error("Only a successfully completed conversation can be retained.");
    const observation = await observeGeneration(ownedUrl);
    state.completed = observation.completed;
    if (!observation.completed) throw new Error("Only a currently completed generation can be retained.");
    await state.tab.markHandoff();
    activeOwner([options.turnId], true);
    state.retained = true;
    // Retain can execute just before native Stop discards its result. Keep the
    // exact owner available until a confirmed handoff.
    emit({ retained: true, ...observation });
  } else throw new Error("Unsupported browser observation operation.");
}

// The digest binds the resident controller and DOM contract to their exact source
// generation. Each mutation program ships only its own runner and shared context;
// mutation code is not retained in the resident controller.
// Native modules share this controller through one binding; browser page code has
// no access to its captured state or helper references.
export const browserHelperVersion = createHash("sha256")
  .update([JSON.stringify(residentBrowserDom), ...[isSavedChatUrl, waitForBrowserState, readBrowserReplies, createBrowserView, runBrowserObservation]
    .map(fn => fn.toString())].join("\n").replace(/\r\n?/gu, "\n"), "utf8").digest("hex");

export function browserScript(options) {
  if (!record(options) || !["bootstrap", "open", "send", "observe", "retain", "continue", "rollover"].includes(options.operation)) throw failure("Unsupported browser operation.");
  if (typeof options.bindingId !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(options.bindingId)) throw failure("A safe unique browser binding ID is required.");
  if (![options.sessionId, options.turnId].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw failure("Browser operations require exact native session and turn identities.");
  if (options.interruptedTurnId !== undefined && (options.operation !== "continue" || typeof options.interruptedTurnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.interruptedTurnId))) throw failure("Interrupted continuation requires an exact previous native turn identity.");
  const transfersOwnership = ["continue", "rollover"].includes(options.operation);
  if (transfersOwnership && (!Array.isArray(options.expectedOwnerTurnIds) || !options.expectedOwnerTurnIds.length
      || options.expectedOwnerTurnIds.some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
      || new Set(options.expectedOwnerTurnIds).size !== options.expectedOwnerTurnIds.length)
      || !transfersOwnership && options.expectedOwnerTurnIds !== undefined) throw failure("Continuation or rollover requires exact expected native owner identities.");
  if (options.needsHistory !== undefined && (options.operation !== "continue" || typeof options.needsHistory !== "boolean")
      || options.needsHistory && options.recovery !== undefined) throw failure("A pending full-history successor requires its existing browser binding without recovery.");
  if (options.operation === "rollover" && !isSavedChatUrl(options.previousChatUrl)) throw failure("Rollover requires the exact previous saved chat URL.");
  if (options.recovery !== undefined) {
    const proof = options.recovery;
    const retainedTabOnly = proof?.retainedTabOnly === true;
    const validBaselineIds = Array.isArray(proof?.baselineReplyIds)
      && proof.baselineReplyIds.every(value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value))
      && new Set(proof.baselineReplyIds).size === proof.baselineReplyIds.length;
    const validReplyId = typeof proof?.replyId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(proof.replyId)
      && validBaselineIds && !proof.baselineReplyIds.includes(proof.replyId);
    const validGeneration = typeof proof?.generationTurnKey === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(proof.generationTurnKey)
        && Array.isArray(proof.generationReplyIds) && validBaselineIds
        && proof.generationReplyIds.every(id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id) && !proof.baselineReplyIds.includes(id))
        && new Set(proof.generationReplyIds).size === proof.generationReplyIds.length
        && (proof.replyId === null || proof.generationReplyIds.includes(proof.replyId));
    if (options.operation !== "continue" || !record(proof) || typeof proof.tabId !== "string" || !proof.tabId
        || !isSavedChatUrl(proof.url)
        || (retainedTabOnly ? !options.interruptedTurnId || !proof.tabId || proof.tabId !== options.tabId || !validBaselineIds
          || proof.completed !== false || proof.replyId !== null && !validReplyId
          : !validReplyId)
        || !validGeneration || proof.retainedTabOnly !== undefined && !retainedTabOnly
        || !record(proof.assistantPrefix) || !Number.isSafeInteger(proof.assistantPrefix.length) || proof.assistantPrefix.length < (retainedTabOnly ? 0 : 1)
        || typeof proof.assistantPrefix.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(proof.assistantPrefix.sha256) || typeof proof.completed !== "boolean"
        || typeof options.runtimeModule !== "string" || !options.runtimeModule) throw failure("Continuation recovery requires a confirmed owned chat and observed assistant reply.");
  }
  const [frameBegin, frameEnd] = frameParts(options.frameToken);
  const compact = ["observe", "retain"].includes(options.operation);
  const config = { ...options, ui: { ...browserDom, ...options.ui }, frameBegin, frameEnd,
    modelFamily: options.modelFamily ?? "GPT-6", power: options.power ?? 0 };
  if (!Number.isInteger(config.power) || config.power < 0 || config.power > 4 || typeof config.modelFamily !== "string" || !config.modelFamily.trim()) throw failure("Invalid bounded browser selection arguments.");
  if (options.operation === "bootstrap" && (typeof options.runtimeModule !== "string" || !options.runtimeModule || typeof options.sessionId !== "string" || !options.sessionId)) throw failure("Bootstrap requires the validated runtime module and current session identity.");
  if (options.operation === "send" && (typeof options.prompt !== "string" || !options.prompt.trim())) throw failure("Send requires the exact prompt.");
  for (const value of Object.values(config.ui)) if (typeof value !== "string" || !value || value.length > 512) throw failure("Invalid observed browser control name.");
  if (options.pluginAppId !== undefined) {
    if (typeof options.pluginName !== "string" || !options.pluginName || typeof options.pluginAppId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.pluginAppId)) throw failure("Attachment requires the configured plugin name and app identity.");
    const css = value => '"' + String(value).replace(/[^A-Za-z0-9 _:/.-]/g, char => `\\${char.codePointAt(0).toString(16)} `) + '"';
    config.pluginChipSelector = `span[app-mention-display-name=${css(options.pluginName)}][app-mention-path=${css(`app://${options.pluginAppId}`)}][contenteditable="false"]`;
    if (typeof options.pluginSelectionButtonName !== "string" || !options.pluginSelectionButtonName) throw failure("Attachment requires the exact configured plugin button name.");
    config.pluginSelectionButtonName = options.pluginSelectionButtonName;
  }
  if (compact) {
    config.ui = Object.fromEntries(Object.entries(config.ui).filter(([key]) => !operationDomKeys.has(key)));
    for (const key of ["modelFamily", "power", "prompt", "pluginAppId", "pluginName", "pluginSelectionButtonName", "pluginChipSelector"]) delete config[key];
  }
  // The official REPL runs each call in a fresh module and omits carried
  // bindings that the new module redeclares. Store state on its shared global
  // object instead of shadowing the previous call's variable in an initializer.
  const binding = `globalThis.routerWeb_${options.bindingId}`;
  const initialize = options.operation === "bootstrap" ? `${binding} ??= {};`
    : options.operation === "continue" && options.recovery ? `${binding} ??= { bindingLost: true };`
      : `if (typeof ${binding} === "undefined") throw new Error("Active native browser binding was lost.");`;
  const helper = `${binding}.residentBrowser`;
  const incompatible = `!${helper} || !Object.isFrozen(${helper}) || ${helper}.version !== ${JSON.stringify(browserHelperVersion)} || ${helper}.state !== ${binding} || typeof ${helper}.observe !== "function"`;
  const resident = ["bootstrap", "continue"].includes(options.operation)
    ? `if (${incompatible}) ${helper} = ((state, replyReader, createView, observer, savedUrl, waitForState) => { const viewFactory = (state, options, reader) => createView(state, options, reader, savedUrl); return Object.freeze({ version: ${JSON.stringify(browserHelperVersion)}, state, replyReader, viewFactory, waitForState, observe: (options, nodeRepl) => observer(state, options, nodeRepl, replyReader, viewFactory) }); })(${binding}, ${readBrowserReplies.toString()}, ${createBrowserView.toString()}, ${runBrowserObservation.toString()}, ${isSavedChatUrl.toString()}, ${waitForBrowserState.toString()});`
    : `if (${incompatible}) throw new Error("Active native browser helper was lost or changed; bootstrap or continuation is required.");`;
  if (["observe", "retain"].includes(options.operation)) return `${initialize}\n${resident}\nawait ${helper}.observe(${JSON.stringify(config)}, nodeRepl);`;
  const runner = { bootstrap: runBrowserBootstrap, open: runBrowserOpen, continue: runBrowserContinuation, rollover: runBrowserRollover, send: runBrowserSend }[options.operation];
  return `${initialize}\n${resident}\nawait (${runner.toString()})(${binding}, ${JSON.stringify(config)}, nodeRepl, ${helper}.replyReader, ${helper}.viewFactory, ${helper}.waitForState, ${createBrowserOperationContext.toString()}${options.operation === "send" ? `, ${selectBrowserModel.toString()}` : ""});`;
}

// This is a codec for our own producer, not a permissive JavaScript parser.
// Complete regeneration also checks every binding guard and helper digest.
export function readBrowserProgram(value) {
  try {
    if (typeof value !== "string" || value.length > 1048576) return null;
    const code = value.replace(/\r\n?/gu, "\n");
    let match = /await globalThis\.routerWeb_([A-Za-z][A-Za-z0-9_]{0,100})\.residentBrowser\.observe\((\{[^\n]*\}), nodeRepl\);$/u.exec(code);
    if (!match) {
      match = /\}\)\(globalThis\.routerWeb_([A-Za-z][A-Za-z0-9_]{0,100}), (\{[^\n]*\}), nodeRepl, globalThis\.routerWeb_[A-Za-z][A-Za-z0-9_]{0,100}\.residentBrowser\.replyReader,/u.exec(code);
    }
    if (!match) return null;
    const config = JSON.parse(match[2]);
    return config.bindingId === match[1] && browserScript(config).replace(/\r\n?/gu, "\n") === code ? config : null;
  } catch { return null; }
}
