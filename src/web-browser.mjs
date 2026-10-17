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
  composerName: "Ask ChatGPT", temporaryToggleName: "Turn off temporary chat", temporaryHeadingName: "Temporary chat", saveChatButtonName: "Save chat",
  assistantFinalReplySelector: '[data-markdown-text-style="assistant-message"]', sendButtonExactName: "Send",
  stopButtonExactName: "Stop", responseCompleteStatusText: "Response complete", regenerateButtonExactName: "Regenerate response",
};

// This function is serialized into the active native REPL. It uses only public
// browser runtime objects; every call finishes inside that native execution.
async function runBrowserOperation(state, options, nodeRepl) {
  const { operation, ui } = options;
  const emit = value => nodeRepl.write(options.frameBegin + JSON.stringify({ routerBrowser: { operation, ...value } }) + options.frameEnd);
  const role = (name, kind = "button") => state.tab.playwright.getByRole(kind, { name, exact: true });
  const replies = () => state.tab.playwright.locator(ui.assistantFinalReplySelector).allTextContents({ timeoutMs: 1000 });
  const temporary = async () => {
    const url = new URL(await state.tab.url());
    if (url.origin !== "https://chatgpt.com" || url.searchParams.get("temporary-chat") !== "true") return false;
    if (!state.hasSentMessage) return await role(ui.temporaryToggleName).isVisible() && await role(ui.temporaryHeadingName, "heading").isVisible();
    // After Send the Temporary Chat toolbar replaces the initial controls with
    // Save chat. Its URL alone cannot establish that an owned chat is temporary.
    return state.temporaryVerified === true && await role(ui.saveChatButtonName).isVisible();
  };
  const ensureOwned = async () => {
    if (!state?.browser || !state.tab || !state.tabId || options.tabId && options.tabId !== state.tabId) throw new Error("Owned browser binding is unavailable.");
    const matches = (await state.browser.tabs.list()).filter(tab => tab.id === state.tabId);
    if (matches.length !== 1) throw new Error("The owned Temporary Chat tab is unavailable; continuation cannot create a replacement.");
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
  const stopAndClose = async () => {
    if (await role(ui.stopButtonExactName).isVisible()) {
      await role(ui.stopButtonExactName).click();
      await role(ui.stopButtonExactName).waitFor({ state: "hidden", timeoutMs: 10000 });
    }
    await state.tab.close();
    state.closed = true;
    return { tabId: state.tabId, closed: true };
  };

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
  if (operation === "open") {
    if (state.tab) throw new Error("This browser binding already owns a tab.");
    state.tab = await state.browser.tabs.new();
    state.tabId = state.tab.id;
    await state.tab.goto("https://chatgpt.com/?temporary-chat=true");
    for (const locator of [role(ui.composerName, "textbox"), role(ui.modelButtonName), role(ui.temporaryToggleName), role(ui.temporaryHeadingName, "heading")]) {
      await locator.waitFor({ state: "visible", timeoutMs: 10000 });
    }
    state.temporaryVerified = await temporary();
    if (!state.temporaryVerified) throw new Error("The initial Temporary Chat state was not verified.");
    state.baselineReplyCount = (await replies()).length;
    emit({ tabId: state.tabId, url: await state.tab.url(), temporary: true, composer: true, modelButton: true, replyCount: state.baselineReplyCount });
    return;
  }
  await ensureOwned();
  if (operation === "continue") {
    if (!state.completed || !state.retained || state.closed || !(await temporary()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The retained conversation is not ready for continuation.");
    state.baselineReplyCount = (await replies()).length;
    state.sendAttempted = false;
    state.completed = false;
    state.retained = false;
    emit({ tabId: state.tabId, replyCount: state.baselineReplyCount, temporary: true });
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
    if (!(await temporary()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned Temporary Chat is not idle.");
    const evidence = await modelEvidence(false);
    if (options.pluginAppId && (!(await chip().isVisible()) || state.pluginAppId !== options.pluginAppId)) throw new Error("The configured plugin chip is missing.");
    state.baselineReplyCount = (await replies()).length;
    state.sendAttempted = true;
    const composer = role(ui.composerName, "textbox");
    await composer.press("End");
    await composer.type(` ${options.prompt}`);
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
    if (!(await temporary()) || await role(ui.stopButtonExactName).isVisible()) throw new Error("The owned Temporary Chat is no longer idle; nothing sent.");
    await send.click();
    state.hasSentMessage = true;
    emit({ sent: true, tabId: state.tabId, baselineReplyCount: state.baselineReplyCount, ...evidence });
  } else if (operation === "observe") {
    if (!state.sendAttempted) throw new Error("No message was issued for this browser binding.");
    let observation;
    for (let iteration = 0; iteration < options.observeIterations; iteration += 1) {
      if (options.controlUrl) {
        const response = await fetch(options.controlUrl, { headers: { Authorization: `Bearer ${options.controlToken}` }, signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("The local Web control endpoint is unavailable.");
        const control = await response.json();
        if (typeof control.pendingTool !== "boolean" || typeof control.cancelled !== "boolean") throw new Error("Invalid local Web control state.");
        if (control.cancelled) { emit({ cancelled: true, ...await stopAndClose() }); return; }
        if (control.pendingTool) { emit({ pendingTool: true, completed: false, tabId: state.tabId }); return; }
      }
      const texts = await replies();
      const assistantText = texts.length > state.baselineReplyCount ? texts.at(-1).trim() : "";
      const stopVisible = await role(ui.stopButtonExactName).isVisible();
      const statuses = await state.tab.playwright.locator('[role="status"]').allTextContents({ timeoutMs: 1000 });
      const statusComplete = statuses.some(text => text.trim() === ui.responseCompleteStatusText);
      const regenerateVisible = await role(ui.regenerateButtonExactName).isVisible();
      const completed = texts.length > state.baselineReplyCount && assistantText.length > 0 && !stopVisible && statusComplete && regenerateVisible;
      observation = { completed, assistantText, replyCount: texts.length, baselineReplyCount: state.baselineReplyCount, stopVisible, statusComplete, regenerateVisible, tabId: state.tabId };
      if (completed) { state.completed = true; break; }
      if (iteration + 1 < options.observeIterations) await new Promise(resolve => setTimeout(resolve, options.observeDelayMs));
    }
    emit(observation);
  } else if (operation === "retain") {
    if (!state.completed || state.closed) throw new Error("Only a successfully completed conversation can be retained.");
    await state.tab.markHandoff();
    state.retained = true;
    emit({ retained: true, tabId: state.tabId });
  } else if (operation === "close" || operation === "cancel") emit({ ...(operation === "cancel" ? { cancelled: true } : {}), ...await stopAndClose() });
  else throw new Error("Unsupported browser operation.");
}

export function browserScript(options) {
  if (!record(options) || !["bootstrap", "open", "model", "attach", "send", "observe", "retain", "close", "cancel", "continue"].includes(options.operation)) throw failure("Unsupported browser operation.");
  if (typeof options.bindingId !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(options.bindingId)) throw failure("A safe unique browser binding ID is required.");
  const [frameBegin, frameEnd] = frameParts(options.frameToken);
  const config = { ...options, ui: { ...defaultUi, ...options.ui }, frameBegin, frameEnd,
    modelFamily: options.modelFamily ?? "GPT-6", power: options.power ?? 0,
    observeIterations: options.observeIterations ?? 12, observeDelayMs: options.observeDelayMs ?? 500 };
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
  if (options.controlUrl !== undefined) {
    let url;
    try { url = new URL(options.controlUrl); } catch { throw failure("Invalid local Web control URL."); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.hash || typeof options.controlToken !== "string" || options.controlToken.length < 16) throw failure("Observe control must use the protected local Web endpoint.");
  }
  const binding = `routerWeb_${options.bindingId}`;
  return `${options.operation === "bootstrap" ? `var ${binding} = typeof ${binding} === "undefined" ? {} : ${binding};` : `if (typeof ${binding} === "undefined") throw new Error("Active native browser binding was lost.");`}\nawait (${runBrowserOperation.toString()})(${binding}, ${JSON.stringify(config)}, nodeRepl);`;
}
