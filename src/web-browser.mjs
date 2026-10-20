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
  const schemas = [declaration.parameters, declaration.inputSchema, declaration.input_schema].filter(value => value !== undefined);
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
  return { namespace: nativeNamespace, name: "js", type: "function", schema, declaration,
    sha256: createHash("sha256").update(JSON.stringify(declaration)).digest("hex"), argumentsFor };
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

const defaultUi = {
  modelButtonName: "Select ChatGPT model", modelMenuName: "Select ChatGPT model", modelExpandName: "Select model",
  powerMenuItemName: "Power", powerSliderSelector: '[role="slider"]', addButtonName: "Add files and more",
  composerName: "Ask ChatGPT", normalHeadingName: "Ready when you are.", temporaryButtonName: "Temporary chat",
  temporaryToggleName: "Turn off temporary chat", temporaryHeadingName: "Temporary chat",
  assistantFinalReplySelector: '[data-markdown-text-style="assistant-message"]', sendButtonExactName: "Send",
  stopButtonExactName: "Stop", responseCompleteStatusText: "Response complete", regenerateButtonExactName: "Regenerate response",
  conversationFullText: "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.",
  startNewChatButtonName: "Start new chat",
};

// Self-contained read-only DOM projection, also usable directly with the public
// locator.evaluateAll API. Code source excludes the renderer's toolbar and uses
// logical lines rather than layout-derived wrapping. The observed message wrapper
// identity and its text come from the same DOM read.
export function readBrowserReplies(elements) {
  const codeBlock = node => node.nodeType === 1 && (node.tagName === "PRE" || node.getAttribute("data-markdown-copy") === "code-block");
  const block = node => node.nodeType === 1 && (codeBlock(node) || /^(?:DIV|P|BLOCKQUOTE|H[1-6]|UL|OL|LI|TABLE|TR)$/.test(node.tagName));
  const paragraph = node => codeBlock(node) || node.nodeType === 1 && /^(?:P|BLOCKQUOTE|H[1-6])$/.test(node.tagName);
  const readCode = element => {
    const codes = element.querySelectorAll("code");
    const editors = element.querySelectorAll(".cm-content[data-language]");
    if (codes.length === 1 && editors.length === 0) return codes[0].textContent ?? "";
    if (codes.length === 0 && editors.length === 1) {
      const lines = Array.from(editors[0].children);
      if (lines.every(line => line.classList.contains("cm-line"))) return lines.map(line => line.textContent ?? "").join("\n");
    }
    throw new Error("The assistant code block does not expose one complete source.");
  };
  const read = node => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    if (node.getAttribute("data-markdown-copy") === "exclude" || /^(?:SCRIPT|STYLE)$/.test(node.tagName)) return "";
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
  const wrapperSelector = '[data-chatgpt-selection-message-id]';
  const selected = new Set(elements), messages = new Map();
  // evaluateAll supplies document order. Multiple selected markdown fragments
  // can belong to one message; distinct wrappers with the same ID stay distinct
  // so the caller can reject that ambiguous identity.
  for (const element of elements) {
    const wrapper = element.closest(wrapperSelector);
    let ancestor = element.parentElement;
    while (ancestor && !(selected.has(ancestor) && ancestor.closest(wrapperSelector) === wrapper)) ancestor = ancestor.parentElement;
    if (ancestor) continue; // Its selected ancestor already includes this text.
    const key = wrapper ?? element;
    if (!messages.has(key)) messages.set(key, { wrapper, element, fragmentCount: 0,
      reply: { messageId: wrapper?.getAttribute("data-chatgpt-selection-message-id") ?? null, text: "" } });
    const message = messages.get(key), text = read(element);
    if (message.reply.text && text) message.reply.text += "\n\n";
    message.reply.text += text;
    message.fragmentCount += 1;
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
  if (!invalid.length) return replies;
  // Only fixed structural names and transient numeric classes leave this DOM
  // read. Attribute values, custom names, reply IDs and text are never diagnostics.
  const tags = new Set(["DIV", "P", "SPAN", "ARTICLE", "SECTION", "MAIN", "ASIDE", "DETAILS", "SUMMARY", "PRE", "CODE",
    "BUTTON", "UL", "OL", "LI", "TABLE", "TR", "TD", "H1", "H2", "H3", "H4", "H5", "H6", "BODY", "HTML"]);
  const attributes = ["data-chatgpt-selection-message-id", "data-talvt-turn-state", "data-content-search-unit-key",
    "data-markdown-text-style", "data-markdown-copy", "data-message-author-role", "data-testid", "role", "class", "id", "aria-hidden", "contenteditable"];
  const ancestors = element => {
    const result = [];
    for (let current = element; current && result.length < 6; current = current.parentElement) result.push({
      tag: tags.has(current.tagName) ? current.tagName : "other",
      attributes: attributes.filter(name => current.getAttribute(name) !== null).slice(0, 4),
    });
    return result;
  };
  const classes = [new Map(), new Map()];
  const ancestorClass = (wrapper, selector, map) => {
    const ancestor = wrapper.closest(selector);
    if (!ancestor) return null;
    if (!map.has(ancestor)) map.set(ancestor, map.size + 1);
    return map.get(ancestor);
  };
  const contains = (parent, child) => {
    for (let current = child.parentElement; current; current = current.parentElement) if (current === parent) return 1;
    return 0;
  };
  const duplicatePairs = [];
  for (const indices of duplicates) for (const index of indices.slice(1)) {
    if (duplicatePairs.length === 2) break;
    const rows = [indices[0], index], wrappers = rows.map(row => groups[row].wrapper);
    duplicatePairs.push({ rows, containment: [contains(wrappers[0], wrappers[1]), contains(wrappers[1], wrappers[0])],
      turnAncestorClasses: wrappers.map(wrapper => ancestorClass(wrapper, '[data-talvt-turn-state]', classes[0])),
      searchUnitAncestorClasses: wrappers.map(wrapper => ancestorClass(wrapper, '[data-content-search-unit-key]', classes[1])) });
  }
  const distinctReasons = new Set(invalid.map(index => reasons[index]));
  const diagnostic = { reason: distinctReasons.size === 1 ? reasons[invalid[0]] : "mixed-invalid-identities",
    selectedElementCount: elements.length, messageCount: groups.length,
    missingWrapperCount: reasons.filter(reason => reason === "missing-wrapper").length,
    invalidWrapperIdCount: reasons.filter(reason => reason === "invalid-wrapper-id").length,
    duplicateWrapperCount: reasons.filter(reason => reason === "duplicate-wrapper-id").length,
    duplicateIdCount: duplicates.length,
    sampledRows: invalid.slice(0, 2).map(index => ({ row: index, reason: reasons[index], fragmentCount: groups[index].fragmentCount,
      ancestors: ancestors(groups[index].element) })), duplicatePairs,
    omittedRowCount: Math.max(0, invalid.length - 2),
    omittedDuplicatePairCount: duplicates.reduce((count, indices) => count + indices.length - 1, 0) - duplicatePairs.length };
  // Drop whole structural samples rather than slicing JSON or risking an
  // unbounded native error. All emitted strings are fixed ASCII literals.
  if (JSON.stringify(diagnostic).length > 3500) {
    diagnostic.sampledRows = [];
    diagnostic.omittedRowCount = invalid.length;
  }
  replies[invalid[0]].identityDiagnostic = diagnostic;
  return replies;
}

// This function is serialized into the active native REPL. It uses only public
// browser runtime objects; every call finishes inside that native execution.
async function runBrowserOperation(state, options, nodeRepl, replyReader) {
  const { operation, ui } = options;
  const emit = value => nodeRepl.write(options.frameBegin + JSON.stringify({ routerBrowser: { operation, ...value } }) + options.frameEnd);
  // Native Interrupt runs in a new JS invocation. Retained tab ownership must
  // remain available there without looking for tabs by URL or replaying Send.
  const registerActive = () => {
    const active = globalThis.routerWebActiveTurns ??= new Map();
    active.set(options.sessionId, { turnId: options.turnId, state, stopButtonName: ui.stopButtonExactName });
  };
  const clearActive = () => {
    const active = globalThis.routerWebActiveTurns;
    const current = active?.get(options.sessionId);
    if (current?.turnId === options.turnId && current.state === state) active.delete(options.sessionId);
  };
  const role = (name, kind = "button", tab = state.tab) => tab.playwright.getByRole(kind, { name, exact: true });
  const replies = (tab = state.tab) => tab.playwright.locator(ui.assistantFinalReplySelector).evaluateAll(replyReader, undefined, { timeoutMs: 1000 });
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
    const fresh = values.filter(value => !state.baselineReplyIds.includes(value.messageId));
    const latest = values.at(-1);
    // Mounted replies can disappear or return as ChatGPT virtualizes history.
    // Keep the first unambiguous new message identity for the entire Send.
    if (state.replyId) return latest?.messageId === state.replyId && !state.baselineReplyIds.includes(state.replyId)
      ? { reply: latest } : { replyUnavailableReason: "latched-message-no-longer-latest" };
    if (fresh.length === 0) return { replyUnavailableReason: "no-new-message" };
    if (fresh.length > 1) return { replyUnavailableReason: "multiple-new-messages" };
    return fresh[0] === latest ? { reply: latest } : { replyUnavailableReason: "new-message-not-latest" };
  };
  const conversationFull = async () => {
    const outsideMessages = (elements, assistantSelector) => {
      const excluded = `${assistantSelector},[data-message-author-role],article,[contenteditable="true"],[role="textbox"],textarea,input`;
      return elements.some(element => !element.closest(excluded) && !element.querySelector(excluded));
    };
    const [banner, button] = await Promise.all([
      state.tab.playwright.getByText(ui.conversationFullText, { exact: true }).filter({ visible: true })
        .evaluateAll(outsideMessages, ui.assistantFinalReplySelector, { timeoutMs: 1000 }),
      role(ui.startNewChatButtonName).filter({ visible: true })
        .evaluateAll(outsideMessages, ui.assistantFinalReplySelector, { timeoutMs: 1000 }),
    ]);
    return banner && button;
  };
  const savedUrl = value => {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && /^\/c\/[A-Za-z0-9-]+$/u.test(url.pathname)
      && !url.searchParams.has("temporary-chat") && !url.hash && !url.username && !url.password;
  };
  const temporaryInactive = async (tab = state.tab) => !(await role(ui.temporaryToggleName, "button", tab).isVisible())
    && !(await role(ui.temporaryHeadingName, "heading", tab).isVisible());
  const normal = async () => {
    const value = await state.tab.url();
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.searchParams.has("temporary-chat") || !(await temporaryInactive())) return false;
    return state.hasSentMessage ? savedUrl(value) && value === state.savedUrl : url.pathname === "/";
  };
  const emptyComposer = async (tab = state.tab) => {
    const values = await role(ui.composerName, "textbox", tab).evaluateAll((elements, ownedChipSelector) => {
      const empty = node => {
        if (node.nodeType === 3) return !(node.textContent ?? "").trim();
        if (node.nodeType !== 1) return true;
        if (ownedChipSelector && node.matches(ownedChipSelector)) return true;
        if (node.getAttribute("contenteditable") === "false" || !/^(?:DIV|P|SPAN|BR)$/u.test(node.tagName)) return false;
        return Array.from(node.childNodes).every(empty);
      };
      return Array.from(elements, element => element.tagName === "DIV" && element.getAttribute("contenteditable") === "true" && empty(element));
    }, options.pluginChipSelector, { timeoutMs: 1000 });
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
  const ensureOwned = async (reacquired = false) => {
    if (!state?.browser || !state.tab || !state.tabId || state.sessionId !== options.sessionId || !reacquired && options.tabId && options.tabId !== state.tabId) throw new Error("Owned browser binding is unavailable.");
    const matches = (await state.browser.tabs.list()).filter(tab => tab.id === state.tabId);
    if (matches.length !== 1) throw new Error("The owned saved chat tab is unavailable; continuation cannot replace a live binding.");
    const url = await state.tab.url();
    if (new URL(url).origin !== "https://chatgpt.com") throw new Error("The owned tab left ChatGPT.");
  };
  const chip = () => state.tab.playwright.locator(options.pluginChipSelector);
  const modelEvidence = async select => {
    const menu = role(ui.modelMenuName, "menu");
    if (!(await menu.isVisible())) await role(ui.modelButtonName).click();
    // The current picker renders the family as generic text inside an unnamed
    // radio menu item. Match its observed DOM text, then verify the full text.
    const familyLocator = () => menu.locator('[role="menuitemradio"]').filter({ hasText: options.modelFamily });
    let family = familyLocator();
    if (await family.count() === 0 && await menu.getByRole("menuitem", { name: ui.modelExpandName, exact: true }).isVisible()) {
      await menu.getByRole("menuitem", { name: ui.modelExpandName, exact: true }).click();
    }
    if (await family.count() !== 1 || (await family.textContent())?.trim() !== options.modelFamily) throw new Error("Expected one exact observed model family.");
    if (select && await family.getAttribute("aria-checked") !== "true") {
      await family.click();
      if (!(await menu.isVisible())) await role(ui.modelButtonName).click();
      family = familyLocator();
      if (await family.count() !== 1 || (await family.textContent())?.trim() !== options.modelFamily) throw new Error("Expected one exact observed model family.");
    }
    const slider = menu.locator(ui.powerSliderSelector);
    const power = menu.getByRole("menuitem", { name: ui.powerMenuItemName, exact: true });
    const readPower = async attribute => {
      const value = await slider.getAttribute(attribute);
      if (typeof value !== "string" || !/^[0-4]$/.test(value)) throw new Error("Observed Power attributes are unavailable.");
      return Number(value);
    };
    let value = await readPower("aria-valuenow");
    const minimum = await readPower("aria-valuemin");
    const maximum = await readPower("aria-valuemax");
    if (minimum !== 0 || maximum !== 4 || !Number.isInteger(value) || value < 0 || value > 4) throw new Error("Observed Power range changed.");
    if (select) for (let move = 0; value !== options.power && move < 4; move += 1) {
      const direction = value > options.power ? -1 : 1;
      await power.press(direction === -1 ? "ArrowLeft" : "ArrowRight");
      const after = await readPower("aria-valuenow");
      if (after !== value + direction) throw new Error("Power did not move exactly one step.");
      value = after;
    }
    const evidence = { familyChecked: await family.getAttribute("aria-checked") === "true", familyText: await family.textContent(),
      powerValue: value, powerMinimum: minimum, powerMaximum: maximum };
    if (!evidence.familyChecked || evidence.familyText?.trim() !== options.modelFamily || value !== options.power) throw new Error("Requested model and Power were not verified.");
    await power.press("Escape");
    return { ...evidence, effortLabel: await role(ui.modelButtonName).innerText() };
  };
  const activeOwner = (turnIds = [options.turnId], requireActive = false) => {
    const current = globalThis.routerWebActiveTurns?.get(options.sessionId);
    if ((requireActive && !current) || current && (!turnIds.includes(current.turnId) || current.state !== state)) throw new Error("A different native turn owns the active browser cleanup.");
    return current;
  };
  const stopGeneration = async (turnIds = [options.turnId], requireActive = false) => {
    const current = activeOwner(turnIds, requireActive);
    const stop = role(current?.stopButtonName ?? ui.stopButtonExactName);
    const visible = await stop.isVisible();
    activeOwner(turnIds, requireActive);
    if (visible) {
      await stop.click();
      activeOwner(turnIds, requireActive);
      await stop.waitFor({ state: "hidden", timeoutMs: 10000 });
      activeOwner(turnIds, requireActive);
    }
  };
  const stopAndClose = async () => {
    await stopGeneration();
    await state.tab.close();
    state.closed = true;
    clearActive();
    return { tabId: state.tabId, closed: true };
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
    Object.assign(state, { hasSentMessage: false, baselineReplyCount: 0, baselineReplyIds: [], sendAttempted: false, sendClicked: false,
      sendConfirmed: false, completed: false, retained: false, interrupted: false });
    for (const key of ["savedUrl", "unsentDraft", "unsentComposerText", "model", "pluginAppId", "replyId"]) delete state[key];
  };

  let recovered = false;
  let verifyRecoveryTexts;
  let recoverMissingTab = false;
  if (operation === "continue" && options.recovery && !state.bindingLost && !state.needsHistory && !options.needsHistory && state.browser && state.tabId) {
    if (state.sessionId !== options.sessionId) throw new Error("Owned browser binding belongs to another native session.");
    activeOwner(options.expectedOwnerTurnIds, true);
    if (state.sendClicked && !state.sendConfirmed) throw new Error("The preceding Send is uncertain; it cannot be replayed.");
    const owned = (await state.browser.tabs.list()).filter(tab => tab.id === state.tabId);
    recoverMissingTab = owned.length === 0;
    if (recoverMissingTab && options.recovery.retainedTabOnly) throw new Error("The exact retained saved chat tab is unavailable; recovery cannot replace it.");
    if (recoverMissingTab && state.savedUrl !== options.recovery.url) throw new Error("The missing tab recovery URL differs from the owned saved conversation.");
  }
  if (operation === "continue" && (state.bindingLost || recoverMissingTab)) {
    // A confirmed saved URL, message identity and reply prefix can recover a lost kernel.
    // A browser/tab ID is only a hint after restart; the exact saved URL and
    // visible reply remain authoritative. Never replace a surviving owner.
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
    const hinted = proof.tabId ? tabs.filter(tab => tab.id === proof.tabId) : [];
    const matches = proof.retainedTabOnly ? hinted : hinted.length ? hinted : tabs.filter(tab => tab.url === proof.url);
    if (proof.retainedTabOnly && (matches.length !== 1 || matches[0].url !== proof.url)) throw new Error("The exact retained saved chat tab or URL changed; recovery cannot replace it.");
    if (matches.length > 1) throw new Error("The saved chat tab is ambiguous; recovery cannot choose a tab.");
    requireRecoveryOwnership();
    const tab = matches.length ? await browser.tabs.get(matches[0].id) : await browser.tabs.new();
    requireRecoveryOwnership();
    if (!tab?.id || matches.length && tab.id !== matches[0].id) throw new Error("The current tab identity changed during recovery.");
    const navigate = await tab.url() !== proof.url;
    requireRecoveryOwnership();
    if (proof.retainedTabOnly && navigate) throw new Error("The exact retained saved chat URL changed during recovery.");
    if (matches.length && navigate && !(await emptyNormalHome(tab))) throw new Error("The known tab is not an empty normal ChatGPT home; recovery cannot overwrite it.");
    const { createHash } = await import("node:crypto");
    requireRecoveryOwnership();
    let recoveredReplyId, recoveredBaselineIds;
    verifyRecoveryTexts = texts => {
      const latest = texts.at(-1), text = latest?.text;
      const expectedReplyId = proof.replyId ?? recoveredReplyId;
      if (!validReplies(texts)) return false;
      if (proof.retainedTabOnly) {
        const fresh = texts.filter(value => !proof.baselineReplyIds.includes(value.messageId));
        if (fresh.length > 1 || fresh.length === 1 && fresh[0] !== latest || expectedReplyId && (fresh.length !== 1 || latest?.messageId !== expectedReplyId)) return false;
        if (!fresh.length) {
          recoveredBaselineIds = proof.baselineReplyIds;
          return proof.assistantPrefix.length === 0;
        }
      }
      if (expectedReplyId && latest?.messageId !== expectedReplyId || typeof text !== "string" || text.length < proof.assistantPrefix.length
          || createHash("sha256").update(text.slice(0, proof.assistantPrefix.length), "utf8").digest("hex") !== proof.assistantPrefix.sha256) return false;
      recoveredReplyId = latest.messageId;
      recoveredBaselineIds = proof.baselineReplyIds ?? texts.slice(0, -1).map(value => value.messageId);
      return true;
    };
    const verifiedReply = async () => await tab.url() === proof.url && await temporaryInactive(tab) && verifyRecoveryTexts(await replies(tab));
    if (!navigate && (!(await verifiedReply()) || !(await emptyComposer(tab)))) throw new Error("The saved chat reply or composer changed; recovery cannot reuse it.");
    requireRecoveryOwnership();
    Object.assign(state, { agent, browser, tab, tabId: tab.id, sessionId: options.sessionId, runtimeModule: options.runtimeModule, bindingLost: true,
      hasSentMessage: true, savedUrl: proof.url, baselineReplyCount: proof.baselineReplyCount,
      baselineReplyIds: [...(proof.baselineReplyIds ?? [])], replyId: proof.replyId,
      sendAttempted: true, sendClicked: true, sendConfirmed: true, completed: proof.completed, retained: proof.completed });
    registerActive();
    await tab.markHandoff();
    if (navigate) {
      await tab.goto(proof.url);
      const deadline = Date.now() + 10000;
      while (!(await verifiedReply())) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("The saved chat URL and reply did not become available within 10 seconds; recovery cannot start a new chat.");
        await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
      }
      if (!(await emptyComposer())) throw new Error("The saved chat composer has a draft; recovery cannot overwrite it.");
    }
    state.baselineReplyIds = [...recoveredBaselineIds];
    state.replyId = recoveredReplyId;
    recovered = true;
  }

  if (operation === "bootstrap") {
    if (state.sessionId && (state.sessionId !== options.sessionId || state.runtimeModule !== options.runtimeModule)) throw new Error("Browser binding belongs to another session or runtime.");
    if (!state.agent) state.agent = await (await import(options.runtimeModule)).setupBrowserRuntime();
    const own = (await state.agent.browsers.list()).filter(browser => browser.type === "iab" && browser.metadata?.codexSessionId === options.sessionId);
    if (own.length !== 1 || typeof own[0].id !== "string") throw new Error("Expected exactly one same-session in-app browser.");
    if (state.browser && state.browser.browserId !== own[0].id) throw new Error("Owned browser identity changed.");
    state.browser ??= await state.agent.browsers.get(own[0].id);
    state.sessionId = options.sessionId;
    state.runtimeModule = options.runtimeModule;
    emit({ browserId: state.browser.browserId, browsers: own, documentation: await state.browser.documentation() });
    return;
  }
  if (!state?.browser) throw new Error("Active native browser binding was lost; bootstrap is required for a new conversation.");
  if (state.sessionId !== options.sessionId) throw new Error("Owned browser binding belongs to another native session.");
  if (operation === "open") {
    if (state.tab) throw new Error("This browser binding already owns a tab.");
    state.tab = await state.browser.tabs.new();
    state.tabId = state.tab.id;
    registerActive();
    await state.tab.goto("https://chatgpt.com/");
    const openDeadline = Date.now() + 10000;
    while (!(await emptyNormalHome())) {
      const remaining = openDeadline - Date.now();
      if (remaining <= 0) throw new Error("Empty normal ChatGPT home controls did not become ready within 10 seconds.");
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    state.baselineReplyCount = 0;
    await state.tab.markHandoff();
    emit({ tabId: state.tabId, url: await state.tab.url(), normal: true, replyCount: state.baselineReplyCount });
    return;
  }
  await ensureOwned(recovered);
  if (operation === "continue") {
    const interrupted = options.interruptedTurnId !== undefined;
    const owners = recovered ? [options.turnId] : options.expectedOwnerTurnIds;
    activeOwner(owners, true);
    if (state.sendClicked && !state.sendConfirmed) throw new Error("The preceding Send is uncertain; it cannot be replayed.");
    if (options.needsHistory && !state.needsHistory) throw new Error("The pending full-history successor binding is unavailable.");
    if (state.needsHistory) {
      if (!state.rolloverAttempted || !state.rolloverFromUrl || state.closed) throw new Error("The pending full-history successor binding is unavailable.");
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
      emit({ tabId: state.tabId, url: await state.tab.url(), replyCount: 0, normal: true, needsHistory: true, assistantText: "", conversationFull: false,
        ...(interrupted ? { interrupted: true } : {}) });
      return;
    }
    if (state.closed || !(await normal())) throw new Error("The retained conversation is not ready for continuation.");
    if (await conversationFull()) {
      const texts = await replies();
      if (!(await normal())) throw new Error("The retained conversation left its normal saved URL during continuation.");
      if (recovered) {
        if (!verifyRecoveryTexts(texts)) throw new Error("The saved chat latest reply changed during continuation; recovery cannot reuse it.");
        delete state.bindingLost;
      }
      const assistantText = state.sendConfirmed ? currentReply(texts).reply?.text ?? "" : "";
      await state.tab.markHandoff();
      activeOwner(owners, true);
      emit({ tabId: state.tabId, url: await state.tab.url(), replyCount: texts.length, normal: true, assistantText, conversationFull: true,
        ...(recovered ? { recovered: true } : {}), ...(interrupted ? { interrupted: true } : {}) });
      return;
    }
    await state.tab.markHandoff();
    if (interrupted) {
      await stopGeneration(owners, true);
      if (state.sendAttempted && !state.sendConfirmed) await clearUnsentDraft();
      state.interrupted = true;
      state.retained = true;
    } else if (!state.completed || !state.retained || await role(ui.stopButtonExactName).isVisible()) throw new Error("The retained conversation is not ready for continuation.");
    if (!(await emptyComposer())) throw new Error("The retained conversation composer has a draft; continuation cannot overwrite it.");
    const texts = await replies();
    if (!(await normal())) throw new Error("The retained conversation left its normal saved URL during continuation.");
    if (recovered) {
      if (!verifyRecoveryTexts(texts)) throw new Error("The saved chat latest reply changed during continuation; recovery cannot reuse it.");
      delete state.bindingLost;
    }
    const assistantText = state.sendConfirmed ? currentReply(texts).reply?.text ?? "" : "";
    if (!validReplies(texts)) throw identityError("The retained conversation has missing or ambiguous assistant message identities.", texts);
    const continuationUrl = await state.tab.url();
    if (state.hasSentMessage && continuationUrl !== state.savedUrl) throw new Error("The retained conversation left its saved URL during continuation.");
    activeOwner(owners, true);
    state.baselineReplyIds = [...new Set([...(state.baselineReplyIds ?? []), ...(state.replyId ? [state.replyId] : []), ...texts.map(value => value.messageId)])];
    state.baselineReplyCount = texts.length;
    delete state.replyId;
    state.sendAttempted = false;
    state.sendClicked = false;
    state.sendConfirmed = false;
    delete state.unsentDraft;
    delete state.unsentComposerText;
    state.completed = false;
    state.retained = false;
    state.interrupted = false;
    registerActive();
    emit({ tabId: state.tabId, url: continuationUrl, replyCount: state.baselineReplyCount, normal: true, assistantText, conversationFull: false,
      ...(recovered ? { recovered: true } : {}), ...(interrupted ? { interrupted: true } : {}) });
  } else if (operation === "rollover") {
    activeOwner(options.expectedOwnerTurnIds, true);
    if (state.closed || state.sendClicked && !state.sendConfirmed) throw new Error("The saved chat cannot roll over with a closed binding or uncertain Send.");
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
      const deadline = Date.now() + 10000;
      while (!(await emptyNormalHome())) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Rollover did not reach an empty normal home within 10 seconds; Start new chat cannot be clicked again.");
        await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
      }
    }
    if (!(await emptyNormalHome())) throw new Error("The rollover successor is no longer a proven empty normal home.");
    activeOwner(options.expectedOwnerTurnIds, true);
    resetChat();
    registerActive();
    emit({ rolledOver: true, needsHistory: true, previousChatUrl: options.previousChatUrl, tabId: state.tabId, url: await state.tab.url(), normal: true });
  } else if (operation === "model") {
    if (state.sendAttempted && !state.completed) throw new Error("Generation is already pending.");
    const evidence = await modelEvidence(true);
    state.model = { family: options.modelFamily, power: options.power };
    emit(evidence);
  } else if (operation === "attach") {
    if (!(await chip().isVisible())) {
      await role(ui.addButtonName).click();
      const selection = role(options.pluginSelectionButtonName);
      if (await selection.count() !== 1) throw new Error("The configured plugin button is unavailable or ambiguous.");
      await selection.click();
    }
    if (!(await chip().isVisible())) throw new Error("The configured plugin chip was not attached.");
    state.pluginAppId = options.pluginAppId;
    emit({ attached: true, tabId: state.tabId });
  } else if (operation === "send") {
    if (state.sendAttempted) throw new Error("This message was already attempted; uncertain sends cannot be replayed.");
    if (!(await normal()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned saved chat is not idle.");
    if (await conversationFull()) {
      emit({ sent: false, conversationFull: true, tabId: state.tabId, url: await state.tab.url(), normal: true, baselineReplyCount: (await replies()).length });
      return;
    }
    if (!(await emptyComposer())) throw new Error("The owned composer has a draft; nothing sent.");
    const evidence = await modelEvidence(false);
    if (options.pluginAppId && (!(await chip().isVisible()) || state.pluginAppId !== options.pluginAppId)) throw new Error("The configured plugin chip is missing.");
    const baseline = await replies();
    if (!validReplies(baseline)) throw identityError("The assistant reply baseline has missing or ambiguous message identities; nothing sent.", baseline);
    state.baselineReplyCount = baseline.length;
    state.baselineReplyIds = [...new Set([...(state.baselineReplyIds ?? []), ...(state.replyId ? [state.replyId] : []), ...baseline.map(value => value.messageId)])];
    delete state.replyId;
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
    // Long pastes become an attachment in ChatGPT. Wait for that existing UI
    // operation to finish without typing again or repeating a Send attempt.
    while (!(await send.isEnabled())) {
      const remaining = sendDeadline - Date.now();
      if (remaining <= 0) throw new Error("Send did not become ready within 10 seconds; nothing sent.");
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    if (options.pluginAppId && !(await chip().isVisible())) throw new Error("The plugin chip was lost while waiting for Send; nothing sent.");
    if (!(await normal()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned saved chat is no longer idle; nothing sent.");
    await state.tab.markHandoff();
    state.sendClicked = true;
    await send.click();
    state.hasSentMessage = true;
    while (!savedUrl(await state.tab.url())) {
      const remaining = sendDeadline - Date.now();
      if (remaining <= 0) throw new Error("The Send has no verified saved conversation URL within 10 seconds; its effect is uncertain.");
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    const confirmedUrl = await state.tab.url();
    if (state.savedUrl && state.savedUrl !== confirmedUrl) throw new Error("The Send changed the owned saved conversation URL; its effect is uncertain.");
    state.savedUrl = confirmedUrl;
    if (!(await normal())) throw new Error("The Send did not remain in the normal saved conversation; its effect is uncertain.");
    state.sendConfirmed = true;
    delete state.unsentDraft;
    delete state.unsentComposerText;
    for (const key of ["needsHistory", "rolloverAttempted", "rolloverFromUrl"]) delete state[key];
    emit({ sent: true, tabId: state.tabId, url: state.savedUrl, normal: true, conversationFull: false,
      baselineReplyCount: state.baselineReplyCount, baselineReplyIds: state.baselineReplyIds, ...evidence });
  } else if (operation === "observe") {
    if (!state.sendAttempted) throw new Error("No message was issued for this browser binding.");
    let observation;
    for (let iteration = 0; iteration < options.observeIterations; iteration += 1) {
      if (!(await normal())) throw new Error("The observed conversation left its normal saved URL.");
      const texts = await replies();
      const { reply, replyUnavailableReason } = currentReply(texts), assistantText = reply?.text ?? "";
      if (reply) state.replyId = reply.messageId;
      const stopVisible = await role(ui.stopButtonExactName).isVisible();
      const statuses = await state.tab.playwright.locator('[role="status"]').allTextContents({ timeoutMs: 1000 });
      const statusComplete = statuses.some(text => text.trim() === ui.responseCompleteStatusText);
      const regenerateVisible = await role(ui.regenerateButtonExactName).isVisible();
      const completed = assistantText.trim().length > 0 && !stopVisible && statusComplete && regenerateVisible;
      const full = await conversationFull();
      if (!(await normal())) throw new Error("The observed conversation left its normal saved URL.");
      observation = { completed, assistantText, replyId: reply?.messageId ?? null, replyCount: texts.length,
        ...(replyUnavailableReason ? { replyUnavailableReason } : {}),
        baselineReplyCount: state.baselineReplyCount, baselineReplyIds: state.baselineReplyIds,
        stopVisible, statusComplete, regenerateVisible, tabId: state.tabId, url: await state.tab.url(), normal: true, conversationFull: full };
      if (completed) state.completed = true;
      if (completed || full) break;
      if (iteration + 1 < options.observeIterations) await new Promise(resolve => setTimeout(resolve, options.observeDelayMs));
    }
    emit(observation);
  } else if (operation === "retain") {
    if (!state.completed || state.closed) throw new Error("Only a successfully completed conversation can be retained.");
    await state.tab.markHandoff();
    state.retained = true;
    // Retain can execute just before native Stop discards its result. Keep the
    // exact owner available until a confirmed handoff or explicit tab close.
    emit({ retained: true, tabId: state.tabId });
  } else if (operation === "cancel") {
    await stopGeneration([options.turnId], true);
    await state.tab.markHandoff();
    state.interrupted = true;
    state.retained = true;
    state.completed = false;
    emit({ cancelled: true, interrupted: true, retained: true, tabId: state.tabId });
  } else if (operation === "close") emit(await stopAndClose());
  else throw new Error("Unsupported browser operation.");
}

export function browserScript(options) {
  if (!record(options) || !["bootstrap", "open", "model", "attach", "send", "observe", "retain", "close", "cancel", "continue", "rollover"].includes(options.operation)) throw failure("Unsupported browser operation.");
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
  if (options.operation === "rollover") {
    let url;
    try { url = new URL(options.previousChatUrl); } catch { /* Invalid old chat URLs are rejected below. */ }
    if (typeof options.previousChatUrl !== "string" || url?.origin !== "https://chatgpt.com" || !/^\/c\/[A-Za-z0-9-]+$/u.test(url.pathname)
        || url.searchParams.has("temporary-chat") || url.hash || url.username || url.password) throw failure("Rollover requires the exact previous saved chat URL.");
  }
  if (options.recovery !== undefined) {
    const proof = options.recovery;
    const legacyReply = proof?.replyId === undefined && proof?.baselineReplyIds === undefined;
    const retainedTabOnly = proof?.retainedTabOnly === true;
    const validBaselineIds = Array.isArray(proof?.baselineReplyIds)
      && proof.baselineReplyIds.every(value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value))
      && new Set(proof.baselineReplyIds).size === proof.baselineReplyIds.length;
    const validReplyId = typeof proof?.replyId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(proof.replyId)
      && validBaselineIds && !proof.baselineReplyIds.includes(proof.replyId);
    let url;
    try { url = new URL(proof?.url); } catch { /* Invalid recovery proof is rejected below. */ }
    if (options.operation !== "continue" || !record(proof) || proof.tabId !== undefined && (typeof proof.tabId !== "string" || !proof.tabId)
        || url?.origin !== "https://chatgpt.com" || !/^\/c\/[A-Za-z0-9-]+$/u.test(url.pathname)
        || url.searchParams.has("temporary-chat") || url.hash || url.username || url.password
        || !Number.isSafeInteger(proof.baselineReplyCount) || proof.baselineReplyCount < 0
        || !Number.isSafeInteger(proof.replyCount) || proof.replyCount < (retainedTabOnly ? 0 : 1)
        || (retainedTabOnly ? !options.interruptedTurnId || !proof.tabId || proof.tabId !== options.tabId || !validBaselineIds
          || proof.completed !== false || proof.replyId !== null && !validReplyId
          : legacyReply ? proof.replyCount <= proof.baselineReplyCount : !validReplyId)
        || proof.retainedTabOnly !== undefined && !retainedTabOnly
        || !record(proof.assistantPrefix) || !Number.isSafeInteger(proof.assistantPrefix.length) || proof.assistantPrefix.length < (retainedTabOnly ? 0 : 1)
        || typeof proof.assistantPrefix.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(proof.assistantPrefix.sha256) || typeof proof.completed !== "boolean"
        || typeof options.runtimeModule !== "string" || !options.runtimeModule) throw failure("Continuation recovery requires a confirmed owned chat and observed assistant reply.");
  }
  const [frameBegin, frameEnd] = frameParts(options.frameToken);
  const config = { ...options, ui: { ...defaultUi, ...options.ui }, frameBegin, frameEnd,
    modelFamily: options.modelFamily ?? "GPT-6", power: options.power ?? 0,
    // Short UI-only rounds return to Router promptly so it can relay MCP calls.
    // Native browser JavaScript does not need access to Router's loopback server.
    observeIterations: options.observeIterations ?? 2, observeDelayMs: options.observeDelayMs ?? 500 };
  if (!Number.isInteger(config.power) || config.power < 0 || config.power > 4 || typeof config.modelFamily !== "string" || !config.modelFamily.trim()
      || !Number.isInteger(config.observeIterations) || config.observeIterations < 1 || config.observeIterations > 20
      || !Number.isInteger(config.observeDelayMs) || config.observeDelayMs < 0 || config.observeDelayMs > 1000) throw failure("Invalid bounded browser selection or observation arguments.");
  if (options.operation === "bootstrap" && (typeof options.runtimeModule !== "string" || !options.runtimeModule || typeof options.sessionId !== "string" || !options.sessionId)) throw failure("Bootstrap requires the validated runtime module and current session identity.");
  if (options.operation === "send" && (typeof options.prompt !== "string" || !options.prompt.trim())) throw failure("Send requires the exact prompt.");
  for (const value of Object.values(config.ui)) if (typeof value !== "string" || !value || value.length > 512) throw failure("Invalid observed browser control name.");
  if (options.pluginAppId !== undefined || options.operation === "attach") {
    if (typeof options.pluginName !== "string" || !options.pluginName || typeof options.pluginAppId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.pluginAppId)) throw failure("Attachment requires the configured plugin name and app identity.");
    const css = value => '"' + String(value).replace(/[^A-Za-z0-9 _:/.-]/g, char => `\\${char.codePointAt(0).toString(16)} `) + '"';
    config.pluginChipSelector = `span[app-mention-display-name=${css(options.pluginName)}][app-mention-path=${css(`app://${options.pluginAppId}`)}][contenteditable="false"]`;
    if (options.pluginMentionName) config.pluginChipSelector += `[app-mention-name=${css(options.pluginMentionName)}]`;
    config.pluginSelectionButtonName = options.pluginSelectionButtonName ?? options.ui?.pluginSelectionButtonExactName ?? options.pluginName;
  }
  // The official REPL runs each call in a fresh module and omits carried
  // bindings that the new module redeclares. Store state on its shared global
  // object instead of shadowing the previous call's variable in an initializer.
  const binding = `globalThis.routerWeb_${options.bindingId}`;
  const initialize = options.operation === "bootstrap" ? `${binding} ??= {};`
    : options.operation === "continue" && options.recovery ? `${binding} ??= { bindingLost: true };`
      : `if (typeof ${binding} === "undefined") throw new Error("Active native browser binding was lost.");`;
  return `${initialize}\nawait (${runBrowserOperation.toString()})(${binding}, ${JSON.stringify(config)}, nodeRepl, ${readBrowserReplies.toString()});`;
}
