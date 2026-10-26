import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { runInNewContext } from "node:vm";

import { browserDom, browserHelperVersion, browserMutationVersion, browserIdleButtonExactName, browserScript, discoverBrowserExecutor, isSavedChatUrl, parseBrowserOutput, readBrowserProgram, readBrowserReplies } from "../src/web-browser.mjs";
import { WEB_MODEL_REGISTRY, webModelSelection } from "../src/web-models.mjs";
import { createWebStopCode } from "../src/web-stop-hook.mjs";
import { domElement, domText, messageId, replyElement } from "./web-dom-fixture.mjs";

const replyOptions = { ui: browserDom, assistantSelector: browserDom.assistantSelector, regenerateName: browserDom.regenerateButtonExactName };
const readReplies = (elements, options = {}) => readBrowserReplies(elements, { ...replyOptions, ...options });

const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const bindingId = "unit_test";
const base = { bindingId, frameToken: token, sessionId: "current-session", turnId: "first-turn", modelFamily: "GPT-6", power: 0 };
const plugin = { pluginName: "Current tools", pluginAppId: "asdk_current_123", pluginSelectionButtonName: "Current tools The current tool collection" };
const fullConversationText = "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.";
const schema = { type: "object", properties: { code: { type: "string" }, title: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } }, required: ["code"] };
const offered = parameters => [{ type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", parameters }] }];
const broadReplySelector = '[data-markdown-text-style="assistant-message"]';
const scopedReplySelector = `[data-chatgpt-selection-message-id] ${broadReplySelector}`;

const sourceBlock = source => domElement("div", { "data-markdown-copy": "code-block" },
  domElement("div", { "data-markdown-copy": "exclude" }, domText("Plain text")),
  domElement("div", { "data-code-block-source": "true" }, domElement("code", {}, domElement("span", {}, domText(source)))));

test("reply projection excludes the observed code toolbar while preserving literal code, indentation and blank lines", () => {
  const source = "  FORMAT_ONE\n\n    FORMAT_TWO\nFORMAT_THREE\n";
  const root = domElement("div", { "data-markdown-text-style": "assistant-message" }, domElement("div", {}, sourceBlock(source)));
  const isolatedReader = runInNewContext(`(${readBrowserReplies.toString()})`);
  domElement("div", { "data-chatgpt-selection-message-id": messageId(0) }, root);
  const snapshot = isolatedReader([root], replyOptions);
  assert.equal(snapshot.replies[0].text, source);
  assert.equal(snapshot.replies[0].messageId, messageId(0));
  assert.equal(snapshot.turns.length, 0);
  assert.equal(root.textContent, `Plain text${source}`, "The read does not mutate the browser DOM.");
});

test("reply projection preserves paragraph, BR and code boundaries without removing literal Plain text prose", () => {
  const root = domElement("div", { "data-markdown-text-style": "assistant-message" },
    domElement("p", {}, domText("Literal Plain text belongs to the answer.")),
    domElement("p", {}, domText("Second paragraph"), domElement("br"), domText("continued")),
    sourceBlock("  first\n\n    second"),
    domElement("p", {}, domText("After "), domElement("code", {}, domText("inline")), domText(" code.")));
  assert.equal(readReplies([root]).replies[0].text, "Literal Plain text belongs to the answer.\n\nSecond paragraph\ncontinued\n\n  first\n\n    second\n\nAfter inline code.");
});

test("reply projection joins one wrapper's markdown fragments in DOM order without repeating nested selections", () => {
  const prose = domElement("div", { "data-markdown-text-style": "assistant-message" }, domElement("p", {}, domText("Before code.")));
  const source = "  FORMAT_ONE\n\n    FORMAT_TWO\nFORMAT_THREE\n";
  const code = domElement("div", { "data-markdown-text-style": "assistant-message" }, sourceBlock(source));
  const nested = domElement("div", { "data-markdown-text-style": "assistant-message" }, domElement("p", {}, domText("After code.")));
  const tail = domElement("div", { "data-markdown-text-style": "assistant-message" }, nested);
  domElement("div", { "data-chatgpt-selection-message-id": messageId(0) }, prose, code, tail);
  const isolatedReader = runInNewContext(`(${readBrowserReplies.toString()})`);
  const { replies } = isolatedReader([prose, code, tail, nested], replyOptions);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].messageId, messageId(0));
  assert.equal(replies[0].text, `Before code.\n\n${source}\n\nAfter code.`);
});

test("reply projection preserves distinct wrappers with duplicate IDs and separate fragments without wrappers", () => {
  const selected = ["First", "Second", "Missing one", "Missing two"].map(text => domElement("div", { "data-markdown-text-style": "assistant-message" }, domText(text)));
  for (const node of selected.slice(0, 2)) domElement("div", { "data-chatgpt-selection-message-id": messageId(0) }, node);
  assert.deepEqual(readReplies(selected).replies.map(({ messageId, text }) => ({ messageId, text })), [
    { messageId: messageId(0), text: "First" }, { messageId: messageId(0), text: "Second" },
    { messageId: null, text: "Missing one" }, { messageId: null, text: "Missing two" },
  ]);
});

test("invalid identity diagnostics contain only a fixed reason and integer counts without private DOM data", () => {
  const privateValue = "PRIVATE_TOKEN_path_https://private.invalid/value";
  const elements = Array.from({ length: 30 }, () => {
    const element = domElement("private-secret-tag", { class: privateValue, id: privateValue, "data-testid": privateValue,
      "data-private-secret-attribute": privateValue, "data-markdown-text-style": "assistant-message" }, domText(privateValue));
    let root = element;
    for (let depth = 0; depth < 9; depth += 1) root = domElement("div", { class: privateValue, role: privateValue }, root);
    return element;
  });
  const { replies } = readReplies(elements), diagnostic = replies[0].identityDiagnostic;
  assert.equal(diagnostic.reason, "missing-wrapper");
  assert.equal(diagnostic.selectedElementCount, 30);
  assert.equal(diagnostic.messageCount, 30);
  assert.equal(diagnostic.missingWrapperCount, 30);
  for (const [name, value] of Object.entries(diagnostic)) if (name !== "reason") assert.equal(Number.isSafeInteger(value), true);
  const serialized = JSON.stringify(diagnostic);
  assert.ok(serialized.length < 512);
  assert.doesNotMatch(serialized, /PRIVATE_TOKEN|private-secret|private\.invalid/u);
  assert.equal(replies.filter(reply => reply.identityDiagnostic).length, 1);
  const valid = domElement("div", { "data-markdown-text-style": "assistant-message" }, domText(privateValue));
  domElement("div", { "data-chatgpt-selection-message-id": messageId(0) }, valid);
  assert.deepEqual(readReplies([valid]).replies, [{ messageId: messageId(0), text: privateValue, turnKey: null, answer: true, completionActionAfter: false }]);
});

test("CodeMirror logical lines preserve empty lines and reject incomplete or ambiguous source", () => {
  const editor = domElement("div", { class: "cm-content", "data-language": "python" },
    domElement("div", { class: "cm-line" }, domText("  first")),
    domElement("div", { class: "cm-line" }, domElement("br")),
    domElement("div", { class: "cm-line" }, domText("    last")),
    domElement("div", { class: "cm-line" }, domElement("br")));
  const block = (...content) => domElement("div", { "data-markdown-copy": "code-block", "data-markdown-text-style": "assistant-message" },
    domElement("div", { "data-markdown-copy": "exclude" }, domText("Python")), ...content);
  assert.equal(readReplies([block(editor)]).replies[0].text, "  first\n\n    last\n");
  for (const invalid of [
    block(domElement("code", {}, domText("one")), domElement("code", {}, domText("two"))),
    block(editor, editor),
    block(domElement("div", { class: "cm-content", "data-language": "python" }, domElement("div", { class: "spacer" }))),
  ]) assert.throws(() => readReplies([invalid]), /one complete source/);
});

test("native browser executor preserves the exact declared schema and identity", () => {
  const executor = discoverBrowserExecutor(offered(schema));
  assert.equal(executor.namespace, "mcp__node_repl");
  assert.equal(executor.name, "js");
  const code = "const text = '` ${notExecutable}';";
  assert.deepEqual(JSON.parse(executor.argumentsFor(code, "Inspect", 12000)), { code, title: "Inspect", timeout_ms: 12000 });
  assert.throws(() => executor.argumentsFor(code, "Inspect", 90000), /current declaration/);
  assert.throws(() => discoverBrowserExecutor([{ type: "function", name: "mcp__node_repl__js", parameters: schema }]), /explicitly declared/);
  assert.throws(() => discoverBrowserExecutor([...offered(schema), ...offered(schema)]), /one explicitly/);
  assert.throws(() => discoverBrowserExecutor(offered({ ...schema, required: ["code", "executor"] })), /schema/);
  const nullableTitle = { ...schema, properties: { ...schema.properties, title: { type: ["string", "null"] } }, required: ["code", "title"] };
  assert.equal(JSON.parse(discoverBrowserExecutor(offered(nullableTitle)).argumentsFor(code)).title, "ChatGPT Web browser operation");
  const withInputSchema = [{ type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", inputSchema: schema }] }];
  assert.deepEqual(JSON.parse(discoverBrowserExecutor(withInputSchema).argumentsFor(code)), JSON.parse(executor.argumentsFor(code)));
  assert.throws(() => discoverBrowserExecutor([{ type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", input_schema: schema }] }]), /schema/);
});

test("saved chat URL qualification is shared and safe for malformed or foreign values", () => {
  const isolated = runInNewContext(`(${isSavedChatUrl.toString()})`, { URL });
  for (const [value, expected] of [
    ["https://chatgpt.com/c/saved-chat", true], ["https://chatgpt.com/c/saved-chat?model=gpt-6", true],
    ["https://chatgpt.com/", false], ["https://chatgpt.com/c/a?temporary-chat=false", false],
    ["https://foreign.test/c/a", false], ["https://name@chatgpt.com/c/a", false],
    ["https://chatgpt.com/c/a#part", false], ["https://chatgpt.com/c/a/b", false], ["bad", false], [null, false],
  ]) assert.equal(isolated(value), expected, String(value));
});

test("browser programs round trip only with their complete exact guards, helper generation and literal config", () => {
  for (const operation of ["bootstrap", "open", "send", "observe", "retain", "continue", "rollover"]) {
    const options = { ...base, operation, ...plugin, runtimeModule: "current-runtime.mjs",
      ...(operation === "send" ? { prompt: 'Literal `prompt` ${untrusted}\\n' } : {}),
      ...(["continue", "rollover"].includes(operation) ? { expectedOwnerTurnIds: [base.turnId] } : {}),
      ...(operation === "rollover" ? { previousChatUrl: "https://chatgpt.com/c/owned" } : {}) };
    const code = browserScript(options), parsed = readBrowserProgram(code);
    assert.equal(parsed.operation, operation);
    assert.equal(parsed.bindingId, base.bindingId);
    assert.equal(browserScript(parsed).replace(/\r\n?/gu, "\n"), code.replace(/\r\n?/gu, "\n"));
    assert.deepEqual(readBrowserProgram(code.replace(/\r?\n/gu, "\r\n")), parsed);
    assert.equal(readBrowserProgram(`${code}\nvoid 0;`), null);
    assert.equal(readBrowserProgram(code.replace("Object.isFrozen", "Object.isSealed")), null);
    assert.equal(readBrowserProgram(code.replace(browserHelperVersion, "0".repeat(64))), null);
    assert.equal(readBrowserProgram(code.replace('"operation":"' + operation + '"', '"operation":"cancel"')), null);
    assert.equal(readBrowserProgram(code.replace("globalThis.routerWeb_unit_test", "globalThis.routerWeb_other_binding")), null);
  }
  assert.equal(readBrowserProgram("await unknown({});"), null);
});

test("input acknowledgement is a strict observe-only boolean in canonical browser programs", () => {
  for (const inputAcknowledgementPending of [false, true]) {
    const code = browserScript({ ...base, operation: "observe", inputAcknowledgementPending });
    assert.equal(readBrowserProgram(code).inputAcknowledgementPending, inputAcknowledgementPending);
    for (const invalid of ['"true"', '1', 'null', '{}']) {
      assert.equal(readBrowserProgram(code.replace(`"inputAcknowledgementPending":${inputAcknowledgementPending}`, `"inputAcknowledgementPending":${invalid}`)), null);
    }
  }
  for (const inputAcknowledgementPending of ["true", 1, null, {}]) {
    assert.throws(() => browserScript({ ...base, operation: "observe", inputAcknowledgementPending }), /boolean observation hint/u);
  }
  for (const operation of ["bootstrap", "open", "send", "retain", "continue", "rollover"]) {
    assert.throws(() => browserScript({ ...base, operation, inputAcknowledgementPending: true }), /boolean observation hint/u);
  }
});

test("observer and mutation generations invalidate only their exact dependency sources and controls", async () => {
  const source = readFileSync(new URL("../src/web-browser.mjs", import.meta.url), "utf8");
  const stateSource = readFileSync(new URL("../src/web-browser-state.mjs", import.meta.url), "utf8");
  const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text, "utf8").toString("base64")}`;
  const loadVariant = async ({ browser = source, state = stateSource }) => {
    assert.ok(browser !== source || state !== stateSource, "The fixture must change a module dependency.");
    return import(moduleUrl(browser.replaceAll('"./web-browser-state.mjs"', JSON.stringify(moduleUrl(state)))));
  };
  const changeFunction = name => ({ browser: source.replace(new RegExp(`(function ${name}\\([^\\n]*\\) \\{)`, "u"), `$1\n  /* changed ${name} source */`) });
  const changeDom = name => ({ state: stateSource.replace(new RegExp(`\\b${name}: ("[^"\\n]*"|'[^'\\n]*')`, "u"), `${name}: "Changed ${name}"`) });
  const compact = ["observe", "retain"].map(operation => browserScript({ ...base, operation }));
  for (const changed of [
    { state: stateSource.replace(/(export const browserDom = Object\.freeze\(\{)/u, '$1\n  sourceVariant: "changed DOM contract",') },
    ...["temporaryToggleName", "temporaryHeadingName", "stopButtonExactName", "turnKeyAttribute", "composerName", "requestErrorText", "retryButtonExactName"].map(changeDom),
    ...["isSavedChatUrl", "waitForBrowserState", "readBrowserReplies", "createBrowserView", "runBrowserObservation"].map(changeFunction),
  ]) {
    const variant = await loadVariant(changed);
    assert.notEqual(variant.browserHelperVersion, browserHelperVersion);
    for (const code of compact) {
      assert.equal(variant.readBrowserProgram(code), null, "An old compact invocation cannot use changed resident dependencies.");
      const current = variant.browserScript(readBrowserProgram(code));
      assert.ok(variant.readBrowserProgram(current));
    }
  }
  const send = browserScript({ ...base, operation: "send", prompt: "Request" });
  for (const [changed] of [
    ...["runBrowserSend", "createBrowserOperationContext", "selectBrowserModel"].map(name => [changeFunction(name), true]),
    ...["modelButtonName", "modelMenuName", "modelExpandName", "powerMenuItemName", "powerSliderSelector", "addButtonName",
      "temporaryButtonName", "sendButtonExactName", "contentEditableAttribute",
      "familySelector", "checkedAttribute", "powerValueAttribute", "powerMinimumAttribute", "powerMaximumAttribute"].map(name => [changeDom(name), false]),
  ]) {
    const operationVariant = await loadVariant(changed);
    assert.equal(operationVariant.browserHelperVersion, browserHelperVersion);
    assert.notEqual(operationVariant.browserMutationVersion, browserMutationVersion);
    for (const code of compact) {
      const options = operationVariant.readBrowserProgram(code);
      assert.ok(options, "Independently shipped model and Send logic cannot invalidate resident observation calls.");
      assert.equal(operationVariant.browserScript(options), code);
    }
    assert.equal(operationVariant.readBrowserProgram(send), null, "Mutation programs require their exact source and default control generation.");
    const currentSend = operationVariant.browserScript({ ...base, operation: "send", prompt: "Request" });
    assert.notEqual(currentSend, send);
    assert.ok(operationVariant.readBrowserProgram(currentSend));
  }
  const continuationOptions = { ...base, operation: "continue", expectedOwnerTurnIds: [base.turnId], interruptedTurnId: base.turnId };
  const continuation = browserScript(continuationOptions);
  const { interruptedTurnId, ...normalContinuationOptions } = continuationOptions;
  const normalContinuation = browserScript(normalContinuationOptions);
  assert.doesNotMatch(normalContinuation, /function (?:reconcileInterruptedBrowserGeneration|createStopBrowserState)/u);
  assert.equal(readBrowserProgram(continuation.replace(',"interruptedTurnId":"first-turn"', "")), null);
  const stopVariant = await loadVariant({ state: stateSource.replace(/(export function createStopBrowserState\([^\n]*\) \{)/u, "$1\n  /* changed Stop predicate owner */") });
  assert.equal(stopVariant.browserHelperVersion, browserHelperVersion);
  for (const code of compact) assert.ok(stopVariant.readBrowserProgram(code));
  assert.equal(stopVariant.readBrowserProgram(normalContinuation), null, "The shared mutation generation includes interrupted continuation's exact Stop predicates.");
  assert.equal(stopVariant.readBrowserProgram(continuation), null, "A continuation with superseded Stop predicates cannot qualify in the adapter.");
  assert.ok(stopVariant.readBrowserProgram(stopVariant.browserScript(continuationOptions)));
  const reconcilerVariant = await loadVariant(changeFunction("reconcileInterruptedBrowserGeneration"));
  assert.equal(reconcilerVariant.browserHelperVersion, browserHelperVersion);
  assert.equal(reconcilerVariant.readBrowserProgram(normalContinuation), null);
  assert.equal(reconcilerVariant.readBrowserProgram(continuation), null);
});

test("default compact programs omit UI data and decode to the complete resident control contract", () => {
  const operationKeys = ["modelButtonName", "modelMenuName", "modelExpandName", "powerMenuItemName", "powerSliderSelector", "addButtonName",
    "temporaryButtonName", "sendButtonExactName", "contentEditableAttribute", "familySelector", "checkedAttribute", "powerValueAttribute", "powerMinimumAttribute", "powerMaximumAttribute"];
  const expectedUi = { ...browserDom };
  for (const key of operationKeys) delete expectedUi[key];
  for (const operation of ["observe", "retain"]) {
    const code = browserScript({ ...base, operation });
    const literal = JSON.parse(/\.observe\((\{[^\n]*\}), nodeRepl\);$/u.exec(code)[1]);
    assert.equal(Object.hasOwn(literal, "ui"), false);
    const effective = readBrowserProgram(code);
    assert.deepEqual(effective.ui, expectedUi);
    assert.equal(browserScript(effective), code);
    assert.equal(browserScript({ ...base, operation, ui: browserDom }), code);
    assert.equal(readBrowserProgram(code.replace('"frameBegin":', '"ui":{"stopButtonExactName":"Stop"},"frameBegin":')), null,
      "Default-equal wire data must not gain qualification through effective UI expansion.");
  }
});

test("compact program configuration keeps only differing resident and unknown UI overrides after full validation", () => {
  for (const operation of ["observe", "retain"]) {
    const overrides = { stopButtonExactName: "Stop generating", regenerateButtonExactName: browserDom.regenerateButtonExactName,
      modelButtonName: "Other picker", futureControl: "Future control", toString: "Own control" };
    const code = browserScript({ ...base, operation, ...plugin, prompt: "Request", futureOption: { enabled: true }, ui: overrides });
    const literal = JSON.parse(/\.observe\((\{[^\n]*\}), nodeRepl\);$/u.exec(code)[1]);
    assert.deepEqual(literal.ui, { stopButtonExactName: "Stop generating", futureControl: "Future control", toString: "Own control" });
    const parsed = readBrowserProgram(code);
    for (const key of ["modelFamily", "power", "prompt", "pluginAppId", "pluginName", "pluginSelectionButtonName", "pluginChipSelector"]) assert.equal(Object.hasOwn(parsed, key), false);
    assert.equal(Object.hasOwn(parsed.ui, "modelButtonName"), false);
    assert.deepEqual(parsed.futureOption, { enabled: true });
    assert.equal(parsed.ui.stopButtonExactName, overrides.stopButtonExactName);
    assert.equal(parsed.ui.regenerateButtonExactName, browserDom.regenerateButtonExactName);
    assert.equal(parsed.ui.futureControl, "Future control");
    assert.equal(parsed.ui.toString, "Own control");
    assert.equal(browserScript(parsed), code);
    assert.equal(readBrowserProgram(code.replace('"ui":{', '"ui":{"modelButtonName":"Tampered picker",')), null);
    assert.equal(readBrowserProgram(code.replace('"ui":{', '"prompt":"Injected operation input","ui":{')), null);
    for (const invalid of [null, "", 42, "x".repeat(513)]) {
      for (const key of ["futureControl", "stopButtonExactName", "modelButtonName"]) {
        assert.throws(() => browserScript({ ...base, operation, ui: { [key]: invalid } }), /Invalid observed browser control/);
      }
    }
  }
});

const framed = value => `ROUTER_WEB_BROWSER_${token}_BEGIN\n${JSON.stringify({ routerBrowser: value })}\nROUTER_WEB_BROWSER_${token}_END`;
test("only one matching nonce frame can become browser data despite SDK diagnostics", () => {
  const value = { operation: "observe", completed: true, assistantText: "Result" };
  const text = `SDK warning: optional SDK package unavailable\n${framed(value)}\nWall time: 0.1 seconds`;
  assert.deepEqual(parseBrowserOutput(JSON.stringify([{ type: "text", text }]), token), value);
  for (const bad of [text + framed(value), text.replace("_END", "_MISSING"), framed(value).replace('"completed":true', '"completed":undefined')]) {
    assert.throws(() => parseBrowserOutput(bad, token), /frame|strict JSON/);
  }
  assert.throws(() => parseBrowserOutput(text, "another_valid_nonce_1234"), /Expected one/);
  assert.throws(() => parseBrowserOutput({ isError: true, content: [{ text }] }, token), /execution failed/);
  assert.throws(() => parseBrowserOutput([{ text }, { text: framed(value) }], token), /Expected one/);
  assert.throws(() => parseBrowserOutput(JSON.stringify({ routerBrowser: value }), token), /Expected one/);
});

let fixtureNumber = 0;
const runtimeFixtureKeys = [];
after(() => { for (const key of runtimeFixtureKeys) delete globalThis[key]; });
const assistantPrefix = text => ({ sha256: createHash("sha256").update(text, "utf8").digest("hex"), length: text.length });
function fixture({ texts = [], currentPower = 3, fastTimers = false, nativeContext = {}, sessionId = base.sessionId } = {}) {
  const fixtureBindingId = `unit_test_${++fixtureNumber}`;
  const bindingName = `routerWeb_${fixtureBindingId}`;
  const ui = { texts: [...texts], power: currentPower, checked: true, menu: false, chip: false, stop: false,
    complete: false, attachedName: null, typed: [], sendClicks: 0, startNewChatClicks: 0, newTabs: 0, closeCount: 0, handoffs: 0,
    powerMoves: [], present: true, temporary: false, badPowerStep: false, stripChip: false, sendFailure: false, missingPower: false,
    familyText: "GPT-6", familyClicks: 0, familyExpanded: false, familyExpansionClicks: 0, clippedFamilyClicks: 0, familySwitches: 0,
    sendEnabled: true, waitedMs: 0, actions: [],
    composerVisible: true, composerText: "", composerSelected: false, draftCleared: false,
    modelButtonVisible: true, temporaryButtonVisible: true, temporaryHeadingVisible: true,
    tabId: "owned-tab", navigations: [], replyReads: 0, urlReads: 0, controlReads: 0, tabReads: 0, observationReads: 0, composerReads: 0, viewportReads: 0,
    fetchCalls: 0, stopClicks: 0, stopReads: 0, stopWaits: 0, stopRequests: 0, reloads: 0, attachmentWaits: 0,
    mutationReads: 0, generationWaits: 0, idleButtonCount: 1, userMessages: [] };
  let now = 0;
  const fixtureDate = fastTimers ? { now: () => now } : Date;
  const fixtureTimeout = fastTimers ? (callback, milliseconds) => {
    now += milliseconds;
    ui.waitedMs += milliseconds;
    ui.onWait?.();
    callback();
  } : setTimeout;
  const siteIndicator = ({ text, scope = "site" }, kind) => {
    if (scope === "assistant-ancestor") return domElement("div", {}, domElement("div", { "data-markdown-text-style": "assistant-message" }, domText(text)));
    if (scope === "composer-ancestor") return domElement("div", {}, domElement("div", { contenteditable: "true" }, domText(text)));
    const node = domElement(kind === "button" ? "button" : "div", {}, domText(text));
    if (scope === "assistant") domElement("div", { "data-markdown-text-style": "assistant-message" }, node);
    if (scope === "user") domElement("div", { "data-message-author-role": "user" }, node);
    if (scope === "user-article") domElement("article", {}, node);
    if (scope === "composer") domElement("div", { contenteditable: "true" }, node);
    return node;
  };
  const replyRoot = () => {
    const replies = ui.replyElements ?? ui.texts.map((value, index) => replyElement(value, ui.replyIds ? ui.replyIds[index] : messageId(index)));
    const all = [...new Set(replies.map(element => element.closest('[data-chatgpt-selection-message-id]') ?? element))];
    let precedingUser;
    for (const user of ui.userMessages) {
      let boundary = -1;
      for (let index = 0; index < all.length; index += 1) if (user.baselineIds.includes(all[index].getAttribute('data-chatgpt-selection-message-id'))) boundary = index;
      boundary = Math.max(boundary, all.indexOf(precedingUser));
      precedingUser = domElement("div", { 'data-turn-key': user.messageId },
        domElement("h4", {}, domText("You said:")), domElement("div", {}, domText(user.text)));
      all.splice(boundary + 1, 0, precedingUser);
    }
    const turns = [];
    let currentTurn = domElement("section", { 'data-turn-key': messageId(900) });
    for (const element of all) {
      if (element.matches('[data-turn-key]')) {
        if (currentTurn.childNodes.length) turns.push(currentTurn);
        currentTurn = element;
      } else {
        currentTurn.childNodes.push(element); currentTurn.children.push(element); element.parentElement = currentTurn;
      }
    }
    if (currentTurn.childNodes.length) turns.push(currentTurn);
    for (const [index, turn] of turns.entries()) {
      const complete = index < turns.length - 1 || ui.complete;
      const content = domElement('div', { 'data-talvt-turn-state': complete ? 'complete' : 'streaming' }, ...turn.childNodes,
        ...(complete ? [domElement('button', { 'aria-label': 'Regenerate response' })] : []));
      turn.childNodes = [content]; turn.children = [content]; content.parentElement = turn;
    }
    const root = ui.messageRoot ?? domElement("main", {}, ...(ui.orphanMarkdownBefore ?? []), ...turns, ...(ui.orphanMarkdownAfter ?? []));
    // Hand-built fragments represent selected markdown roots.
    for (const element of replies) if (!element.matches(broadReplySelector)) element.setAttribute('data-markdown-text-style', 'assistant-message');
    return root;
  };
  const makeUnion = locators => ({
    or(other) { return makeUnion([...locators, other]); },
    async evaluateAll(callback, argument) {
      if (argument.mutation) {
        ui.mutationReads += 1;
        await ui.onMutationRead?.(argument);
        ui.onComposerRead?.();
      } else ui.observationReads += 1;
      if (!argument.mutation || locators.some(value => value.name?.startsWith('[data-turn-key],'))) {
        ui.replyReads += 1;
        ui.onReplyRead?.(argument);
      }
      const root = replyRoot(), body = domElement("body", {}, root);
      const document = { body, get URL() { return ui.url ?? "https://chatgpt.com/"; },
        defaultView: { getComputedStyle: element => ({ visibility: element.visibilityStyle ?? "visible" }) } };
      body.ownerDocument = document;
      const control = (tag, text, attributes = {}) => {
        const element = domElement(tag, attributes, domText(text));
        element.getBoundingClientRect = () => ({ width: 32, height: 32 });
        return element;
      };
      const namedControls = {
        Stop: ui.stop ? [control("button", "", { "aria-label": "Stop" })] : [],
        "Turn off temporary chat": ui.temporary ? [control("button", "", { "aria-label": "Turn off temporary chat" })] : [],
        "Temporary chat": ui.temporary && ui.temporaryHeadingVisible ? [control("h2", "Temporary chat")] : [],
        ...ui.observationControls,
      };
      const chip = ui.chip ? domElement("span", { "app-mention-display-name": plugin.pluginName,
        "app-mention-path": `app://${plugin.pluginAppId}`, contenteditable: "false" }, domText(plugin.pluginName)) : null;
      const composers = ui.composerElements ?? [ui.composerNode ?? domElement("div", { contenteditable: "true" },
        ...(chip ? [chip] : []), domText(ui.composerText))];
      for (const composer of composers) Object.defineProperty(composer, "innerText", { configurable: true, get: () => ui.composerText });
      const elements = [];
      for (const { kind, name, scopeSelector, guardedBody } of locators) {
        if (kind === "selector") elements.push(...(name === "body" ? !guardedBody || guardedBody.resolve().length ? [body] : []
          : name.startsWith("span[app-mention") ? chip ? [chip] : [] : root.querySelectorAll(name)));
        else if (kind === "textbox" && name === "Ask ChatGPT" && argument.mutation) elements.push(...composers);
        else if (name === "Regenerate response") {
          const scope = scopeSelector ? root.querySelectorAll(scopeSelector) : [root];
          const matches = scope.flatMap(element => element.querySelectorAll('[aria-label="Regenerate response"]'));
          for (const element of matches) element.getBoundingClientRect ??= () => ({ width: 32, height: 32 });
          elements.push(...matches);
        } else if (name === "Start new chat") elements.push(...(ui.fullButtons ?? []).filter(candidate => candidate.text === name && candidate.visible !== false).map(candidate => siteIndicator(candidate, "button")));
        else if (name in namedControls) elements.push(...namedControls[name]);
        else if (kind === "text") {
          const candidates = [...(ui.fullBanners ?? []), ...(ui.userTexts ?? []).map(text => ({ text, scope: "user" })),
            ...ui.texts.filter(text => typeof text === "string").map(text => ({ text, scope: "assistant" })), { text: ui.composerText, scope: "composer" }];
          elements.push(...candidates.filter(candidate => candidate.text === name && candidate.visible !== false).map(candidate => siteIndicator(candidate)));
        } else elements.push(...(namedControls[name] ?? []));
      }
      for (const element of elements) element.getBoundingClientRect ??= () => ({ width: 32, height: 32 });
      return callback([...new Set(elements)], argument);
    },
  });
  const makeLocator = (kind, name, visibleOnly = false, scopeSelector, hasText, hasIdentity, excludedKeys = []) => ({
    kind, name, scopeSelector,
    or(other) { return makeUnion([this, other]); },
    nth(index) { return { resolve: () => {
      const count = ui.observationControls?.[name]?.length ?? Number(name === "Temporary chat"
        ? ui.temporary && ui.temporaryHeadingVisible : name === "Turn off temporary chat" && ui.temporary);
      return Array.from({ length: count }, () => ({})).slice(index, index + 1);
    } }; },
    getByRole(role, options) { return makeLocator(role, options.name, false, kind === "selector" ? name : scopeSelector); },
    locator(selector) { return makeLocator("selector", selector); },
    filter({ hasText: text, visible, has, hasNot }) {
      if (visible !== undefined) return makeLocator(kind, name, visible);
      if (name === '[data-turn-key]') return makeLocator(kind, name, visibleOnly, scopeSelector, text ?? hasText, Boolean(has) || hasIdentity,
        hasNot ? [...hasNot.name.matchAll(/@data-turn-key='([^']+)'/gu)].map(match => match[1]) : excludedKeys);
      assert.equal(kind, "selector");
      assert.equal(name, '[role="menuitemradio"]');
      return makeLocator("family-text", text);
    },
    async count() {
      ui.controlReads += 1;
      await ui.onControlRead?.({ kind, name, method: "count" });
      if (kind === "menuitemradio") return 0; // Visible family text is not its accessible name.
      if (kind === "button" && name === browserIdleButtonExactName) return ui.idleButtonCount;
      if (kind === "button" && name === "Start new chat") return (ui.fullButtons ?? []).filter(candidate => candidate.text === name && (!visibleOnly || candidate.visible !== false)).length;
      return kind === "family-text" ? Number(ui.familyText.includes(name)) : name === plugin.pluginSelectionButtonName ? ui.selectionCount ?? 1 : 0;
    },
    async isVisible() {
      ui.controlReads += 1;
      await ui.onControlRead?.({ kind, name, method: "isVisible" });
      if (name === "Select ChatGPT model" && kind === "menu") return ui.menu;
      if (name === "Select ChatGPT model" && kind === "button") return ui.modelButtonVisible;
      if (name === "Select model" && kind === "menuitem") return ui.menu && !ui.familyExpanded;
      if (name === "Power" && kind === "menuitem") return ui.menu && !ui.familyExpanded;
      if (name === "Ask ChatGPT" && kind === "textbox") return ui.composerVisible;
      if (name === "Stop" || name === "Stop generating") return ui.stop;
      if (name === "Regenerate response") return ui.complete;
      if (name === "Temporary chat" && kind === "button") return ui.temporaryButtonVisible && !ui.temporary;
      if (name === "Temporary chat" && kind === "heading") return ui.temporary && ui.temporaryHeadingVisible;
      if (kind === "heading") return name === ui.decorativeHeading;
      if (name === "Turn off temporary chat") return ui.temporary;
      if (kind === "selector" && name.startsWith("span[app-mention")) return ui.chip;
      return true;
    },
    async click() {
      if (name === "Select ChatGPT model") { ui.actions.push("model-menu"); ui.menu = !ui.menu; ui.familyExpanded = false; ui.onModel?.(); }
      else if (name === "Select model" && kind === "menuitem") {
        assert.equal(ui.menu && !ui.familyExpanded, true);
        ui.actions.push("expand-models"); ui.familyExpansionClicks += 1; ui.familyExpanded = !ui.expansionFails;
      }
      else if (kind === "family-text") {
        if (!ui.familyExpanded) { ui.clippedFamilyClicks += 1; ui.power = 2; }
        else {
          ui.actions.push("select-family"); ui.familyClicks += 1;
          if (!ui.checked) { ui.familySwitches += 1; ui.power = 2; }
          ui.checked = true; ui.familyExpanded = false;
        }
      }
      else if (name === plugin.pluginSelectionButtonName) { ui.actions.push("attach"); ui.chip = true; ui.attachedName = name; ui.onAttach?.(); }
      else if (name === "Send") {
        ui.actions.push("send");
        ui.sendClicks += 1;
        if (!ui.deferSavedUrl) ui.url = "https://chatgpt.com/c/owned-conversation";
        ui.userMessages.push({ messageId: messageId(1000 + ui.sendClicks), text: ui.composerText,
          baselineIds: ui.replyElements ? ui.replyElements.map(element => element.closest('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id'))
            : ui.texts.map((_, index) => ui.replyIds?.[index] ?? messageId(index)) });
        ui.composerText = "";
        ui.onSend?.();
        if (ui.sendFailure) throw new Error("Send effect uncertain");
      }
      else if (name === "Stop") {
        ui.stopClicks += 1;
        if (!ui.keepStopVisible) ui.stop = false;
        await ui.onStopClick?.();
        if (ui.stopClickError) throw ui.stopClickError;
      }
      else if (name === "Start new chat") {
        ui.startNewChatClicks += 1;
        if (!ui.deferRolloverHome) {
          Object.assign(ui, { url: "https://chatgpt.com/", composerText: "", texts: [], chip: false,
            complete: false, stop: false, fullBanners: [], fullButtons: [] });
        }
        ui.onStartNewChat?.();
        if (ui.rolloverClickFailure) throw new Error("Start new chat effect uncertain");
      }
    },
    async getAttribute(attribute) {
      ui.controlReads += 1;
      await ui.onControlRead?.({ kind, name, method: "getAttribute", attribute });
      if (name === '[role="slider"]') assert.equal(ui.menu && !ui.familyExpanded, true, 'Power is read from the visible Power view.');
      if (attribute === "aria-valuenow" && ui.missingPower) return null;
      return { "aria-checked": String(ui.checked), "aria-valuenow": String(ui.power), "aria-valuemin": "0", "aria-valuemax": "4" }[attribute] ?? null;
    },
    async textContent() { ui.controlReads += 1; await ui.onControlRead?.({ kind, name, method: "textContent" }); return kind === "family-text" ? ui.familyText : name; },
    async innerText() { return name === "Ask ChatGPT" ? ui.composerText : ui.power === 0 ? "GPT-6 Instant" : "GPT-6 Thinking"; },
    async press(key) {
      if (name === "Power") {
        assert.equal(ui.menu && !ui.familyExpanded, true, 'Power is operated in the visible Power view.');
        if (key === "Escape") ui.menu = false;
        else { ui.powerMoves.push(key); ui.power += (key === "ArrowLeft" ? -1 : 1) * (ui.badPowerStep ? 2 : 1); }
      } else if (name === "Ask ChatGPT") {
        if (key === "Control+A") ui.composerSelected = true;
        if (key === "Backspace" && ui.composerSelected) {
          ui.composerText = ""; ui.composerSelected = false; ui.chip = false; ui.sendEnabled = false; ui.draftCleared = true;
        }
      }
    },
    async type(text) {
      ui.typed.push(text); ui.composerText += text;
      if (ui.draftCleared) { ui.sendEnabled = true; ui.draftCleared = false; }
      if (ui.stripChip) ui.chip = false;
      ui.onType?.(text);
    },
    async isEnabled() { return name === "Send" ? ui.sendEnabled : name === "Temporary chat" ? !ui.temporaryButtonDisabled : name === "Select ChatGPT model" ? !ui.modelButtonDisabled : true; },
    async waitFor({ state, timeoutMs }) {
      if (state === "attached") {
        assert.equal(kind, "selector");
        if (name === '[data-turn-key]') {
          assert.equal(typeof hasText, "string"); assert.equal(hasIdentity, true);
          assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
          ui.generationWaits += 1;
          await ui.onGenerationWait?.({ marker: hasText, timeoutMs });
          if (ui.generationWaitError) throw ui.generationWaitError;
          const ready = () => replyRoot().querySelectorAll(name).filter(turn => turn.textContent.includes(hasText)
            && !excludedKeys.includes(turn.getAttribute('data-turn-key'))
            && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(turn.getAttribute('data-turn-key'))).length === 1;
          if (!ready() && fastTimers) {
            // The SDK wait is one call. This harness advances its failure bound;
            // only a qualifying rendered marker/identity can satisfy readiness.
            now += timeoutMs; ui.waitedMs += timeoutMs; ui.onWait?.();
          }
          if (!ready()) throw new Error("The generation marker did not attach with one valid identity.");
          return;
        }
        ui.attachmentWaits += 1; ui.actions.push("wait-checkpoint");
        await ui.onAttachmentWait?.({ selector: name, timeoutMs });
        if (!replyRoot().querySelector(name)) throw new Error("The checkpoint did not attach.");
      } else assert.equal(await this.isVisible(), state === "visible");
    },
    async evaluateAll(callback, argument) {
      if (kind === "text") {
        const candidates = [...(ui.fullBanners ?? []), ...(ui.userTexts ?? []).map(text => ({ text, scope: "user" })),
          ...ui.texts.filter(text => typeof text === "string").map(text => ({ text, scope: "assistant" })),
          { text: ui.composerText, scope: "composer" }];
        return callback(candidates.filter(candidate => candidate.text === name && (!visibleOnly || candidate.visible !== false)).map(candidate => siteIndicator(candidate)), argument);
      }
      if (kind === "button" && name === "Start new chat") {
        return callback((ui.fullButtons ?? []).filter(candidate => candidate.text === name && (!visibleOnly || candidate.visible !== false)).map(candidate => siteIndicator(candidate, "button")), argument);
      }
      if (name === "Ask ChatGPT" && kind === "textbox") {
        ui.composerReads += 1;
        ui.onComposerRead?.();
        const content = [domText(ui.composerText)];
        if (ui.chip) content.unshift(domElement("span", { "app-mention-display-name": plugin.pluginName,
          "app-mention-path": `app://${plugin.pluginAppId}`, contenteditable: "false" }, domText(plugin.pluginName)));
        return callback(ui.composerElements ?? [ui.composerNode ?? domElement("div", { contenteditable: "true" }, ...content)], argument);
      }
      if (name === scopedReplySelector) {
        ui.viewportReads += 1;
        if (ui.viewportError) throw ui.viewportError;
        return callback(ui.viewportElements ?? replyRoot().querySelectorAll(name), argument);
      }
      ui.replyReads += 1;
      ui.onReplyRead?.();
      if (name === '[data-turn-key]' || name.startsWith('[data-turn-key],')) {
        return callback(replyRoot().querySelectorAll(name), argument);
      }
      assert.fail(`Unobserved selector: ${name}`);
    },
  });
  // Policy-only SDK locator model. Accessible names and visible controls are
  // explicit fixture inputs; the installed-browser fixture covers real accname
  // and XPath/filter behavior independently.
  const stopControls = () => [
    ...Array.from({ length: ui.stopCount ?? Number(ui.stop || ui.hiddenMountedStop) }, (_, index) => ({ kind: "stop", index,
      name: "Stop", visible: ui.stop })),
    ...Array.from({ length: ui.stop ? ui.idleDuringStop ?? 0 : ui.idleButtonCount }, (_, index) => ({ kind: "idle", index,
      name: browserIdleButtonExactName, visible: true })),
  ];
  const stopBody = () => {
    const root = replyRoot(), body = domElement("body", {}, root);
    body.ownerDocument = { body, get URL() { return ui.url ?? "https://chatgpt.com/"; },
      querySelectorAll: selector => root.querySelectorAll(selector) };
    return body;
  };
  class StopPolicyLocator {
    constructor(resolve) { this.resolve = resolve; }
    filter(options) {
      assert(Object.keys(options).every(key => ["has", "hasNot", "visible"].includes(key)));
      return new StopPolicyLocator(() => this.resolve().filter(element =>
        (options.visible === undefined || element.visible === options.visible)
        && (!options.has || options.has.resolve().length > 0)
        && (!options.hasNot || options.hasNot.resolve().length === 0)));
    }
    nth(index) { return new StopPolicyLocator(() => this.resolve().slice(index, index + 1)); }
    or(other) { if (other.kind) return makeUnion([Object.assign(this, { kind: "selector", name: "body", guardedBody: this }), other]); return new StopPolicyLocator(() => {
      const result = this.resolve();
      for (const element of other.resolve()) if (!result.some(value => value.tagName === "BODY" && element.tagName === "BODY"
          || value.kind === element.kind && value.index === element.index)) result.push(element);
      return result;
    }); }
    getByRole(kind, options) {
      assert.equal(kind, "button"); assert.equal(options.exact, true);
      return new StopPolicyLocator(() => this.resolve().length ? stopControls().filter(element => element.name === options.name) : []);
    }
    async count() {
      ui.controlReads += 1;
      await ui.onControlRead?.({ kind: "button", name: this.resolve()[0]?.name, method: "count" });
      return this.resolve().length;
    }
    async click({ timeoutMs }) {
      assert(Number.isInteger(timeoutMs) && timeoutMs > 0);
      ui.stopRequests += 1;
      await ui.onStopRequest?.();
      const matches = this.resolve();
      if (matches.length !== 1 || matches[0].kind !== "stop" || !matches[0].visible) throw new Error("No unique guarded Stop matched.");
      return makeLocator("button", "Stop").click();
    }
    async waitFor({ state, timeoutMs }) {
      assert.equal(state, "visible"); assert(Number.isInteger(timeoutMs) && timeoutMs > 0);
      ui.stopWaits += 1;
      await ui.onStopWait?.();
      if (!this.resolve().some(element => element.tagName === "BODY" || element.visible)) throw new Error("Stop readiness was not observed.");
    }
    async evaluateAll(reader, argument, { timeoutMs }) {
      assert(Number.isInteger(timeoutMs) && timeoutMs > 0);
      ui.stopReads += 1;
      await ui.onStopRead?.();
      return reader(this.resolve(), argument);
    }
  }
  const stopLocator = selector => {
    if (selector === "body") return Object.assign(new StopPolicyLocator(() => [stopBody()]), { kind: "selector", name: selector });
    assert(selector.startsWith("xpath=//body["));
    const key = /\[@data-turn-key='([a-f0-9-]+)'\]/u.exec(selector)?.[1];
    assert(key);
    return new StopPolicyLocator(() => {
      const body = stopBody(), turns = body.querySelectorAll("[data-turn-key]"), matching = turns.filter(turn => turn.getAttribute("data-turn-key") === key);
      const states = matching.length === 1 ? matching[0].querySelectorAll("[data-talvt-turn-state]") : [];
      return matching.length === 1 && turns.at(-1)?.getAttribute("data-turn-key") === key
        && (!selector.includes("data-talvt-turn-state") || states.length === 1 && states[0].getAttribute("data-talvt-turn-state") === "complete") ? [body] : [];
    });
  };
  const roleLocator = (kind, options) => {
    const result = makeLocator(kind, options.name);
    if (kind === "button" && ["Stop", browserIdleButtonExactName].includes(options.name)) {
      const semantic = stopLocator("body").getByRole(kind, options);
      Object.assign(result, { resolve: semantic.resolve,
        filter: options => Object.assign(semantic.filter(options), { kind, name: options.name ?? result.name }), nth: semantic.nth.bind(semantic) });
    }
    return result;
  };
  const tab = { get id() { return ui.tabId; }, url: async () => { ui.urlReads += 1; return ui.url ?? "https://chatgpt.com/"; }, goto: async url => { ui.url = url; ui.navigations.push(url); ui.onGoto?.(url); },
    reload: async () => { ui.reloads += 1; ui.actions.push("reload"); await ui.onReload?.(); if (ui.reloadFailure) throw new Error("Reload failed."); },
    playwright: { getByRole: roleLocator, getByText: (text, options) => {
      assert.equal(options.exact, true); return makeLocator("text", text);
    }, locator: name => name === "body" || name.startsWith("xpath=//body[") ? stopLocator(name) : makeLocator("selector", name) },
    close: async () => { ui.closeCount += 1; ui.present = false; }, markHandoff: async () => { ui.handoffs += 1; } };
  const browser = { browserId: "owned-browser",
    tabs: { list: async () => { ui.tabReads += 1; return [...(ui.present ? [{ id: tab.id, url: ui.url ?? "https://chatgpt.com/" }] : []), ...(ui.extraTabs ?? [])]; },
      get: async id => { assert.equal(id, tab.id); return tab; },
      new: async () => {
        if (ui.newTabs) { ui.tabId = "reopened-tab"; ui.url = "about:blank"; ui.texts = []; ui.composerText = ""; ui.chip = false; }
        ui.newTabs += 1; ui.present = true; return tab;
      } } };
  const agent = { browsers: { list: async () => [
    { type: "iab", id: "foreign", metadata: { codexSessionId: "other-session" } },
    { type: "iab", id: browser.browserId, metadata: { codexSessionId: sessionId } },
  ], get: async id => { assert.equal(id, browser.browserId); return browser; } } };
  let state = { agent };
  nativeContext[bindingName] = state;
  const runtimeFixtureKey = `${bindingName}_agent`;
  runtimeFixtureKeys.push(runtimeFixtureKey);
  globalThis[runtimeFixtureKey] = agent;
  const runtimeModule = `data:text/javascript,${encodeURIComponent(`export const setupBrowserRuntime = () => globalThis[${JSON.stringify(runtimeFixtureKey)}];`)}`;
  let ownerTurnId;
  const run = async (operation, extra = {}, allowFullContinuation = true) => {
    let output;
    const options = { ...base, bindingId: fixtureBindingId, sessionId, operation,
      ...(["continue", "rollover"].includes(operation) ? { ...plugin, expectedOwnerTurnIds: [ownerTurnId], ...(extra.recovery ? { runtimeModule } : {}) } : {}), ...extra };
    const code = browserScript(options);
    // Each call has a fresh execution scope, like the official REPL's modules.
    // Only the shared global object carries state; no injected local alias may
    // hide a generated initializer that shadows a previous call's binding.
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("nodeRepl", "Date", "setTimeout", "fetch", "globalThis", `${code}\nreturn globalThis.${bindingName};`);
    const forbiddenFetch = () => { ui.fetchCalls += 1; throw new Error("Native browser sandbox does not allow loopback fetch."); };
    state = await execute({ write: value => { output = value; } }, fixtureDate, fixtureTimeout, forbiddenFetch, nativeContext);
    const result = parseBrowserOutput(output, token);
    if (result.operation === "continue" && result.needsFullContinuation === true && result.noActions === true) {
      if (allowFullContinuation) {
        assert.equal(extra.fullContinuation, undefined, "A full Continue cannot ask for another install.");
        assert.equal(Object.keys(result).length, 3);
        return run(operation, { ...extra, fullContinuation: true }, false);
      }
      return result;
    }
    if (["open", "continue", "rollover"].includes(operation)) ownerTurnId = nativeContext.routerWebActiveTurns?.get(sessionId)?.turnId;
    return result;
  };
  const ready = async () => {
    await run("bootstrap", { runtimeModule: "current-runtime.mjs" });
    await run("open");
  };
  return { ui, run, runFast: (operation, extra) => run(operation, extra, false), ready, tab, browser, agent, runtimeModule, getState: () => nativeContext[bindingName],
    loseBinding({ preserveOwner = false } = {}) { delete nativeContext[bindingName]; if (!preserveOwner) nativeContext.routerWebActiveTurns?.delete(sessionId); },
    activeTurn: () => nativeContext.routerWebActiveTurns?.get(sessionId) };
}

async function recoverableFixture({ completed = true, text = "  Observed 🔧 reply\n", nativeContext = {} } = {}) {
  const f = fixture({ fastTimers: true, nativeContext });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push(text);
  f.ui.complete = completed;
  f.ui.stop = !completed;
  const observed = await f.run("observe");
  if (completed) await f.run("retain");
  const recovery = { url: observed.url, tabId: observed.tabId,
    baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
    generationTurnKey: observed.generationTurnKey, generationReplyIds: observed.generationReplyIds,
    assistantPrefix: assistantPrefix(observed.assistantText), completed: observed.completed };
  return { ...f, recovery, text };
}

async function staleCompletedCheckpointFixture() {
  const nativeContext = {}, baseline = ["Older reply", "Previous reply", "Immediate predecessor"], text = "Completed checkpoint reply";
  const f = fixture({ fastTimers: true, nativeContext });
  await f.ready();
  f.ui.texts = [...baseline];
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push(text); f.ui.complete = true;
  const observed = await f.run("observe");
  await f.run("retain");
  const recovery = { url: observed.url, tabId: observed.tabId, baselineReplyIds: observed.baselineReplyIds,
    replyId: observed.replyId, generationTurnKey: observed.generationTurnKey, generationReplyIds: observed.generationReplyIds,
    assistantPrefix: assistantPrefix(observed.assistantText), completed: true };
  const predecessor = () => observedTurn(messageId(900), "Previous request", [assistantMessage(2, baseline[2])]);
  const restored = (replyText = text, key = recovery.generationTurnKey) => domElement("main", {}, predecessor(),
    observedTurn(key, "Request", [assistantMessage(3, replyText)]));
  f.ui.messageRoot = domElement("main", {}, predecessor());
  f.loseBinding();
  return { ...f, recovery, text, predecessor, restored, nativeContext };
}

async function interruptedBeforeReplyFixture() {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.texts.push("Earlier answer");
  const sent = await f.run("send", { ...plugin, prompt: "Interrupted request" });
  const rendered = (content = []) => domElement("main", {},
    observedTurn(messageId(100), "Earlier request", [assistantMessage(0, "Earlier answer")]),
    observedTurn(sent.generationTurnKey, "Interrupted request", content, { complete: f.ui.complete }));
  f.ui.messageRoot = rendered();
  f.ui.stop = true;
  const observed = await f.run("observe");
  assert.deepEqual([observed.assistantText, observed.replyId, observed.generationReplyIds], ["", null, []]);
  const recovery = { tabId: observed.tabId, url: observed.url,
    baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
    generationTurnKey: observed.generationTurnKey, generationReplyIds: observed.generationReplyIds,
    assistantPrefix: assistantPrefix(observed.assistantText), completed: false, retainedTabOnly: true };
  // Starting state after native Interrupt has already stopped this generation.
  // Hook authority itself is exercised through the actual hook contract tests.
  f.ui.stop = false;
  f.ui.complete = true;
  f.ui.messageRoot = rendered();
  return { ...f, recovery, rendered };
}

function showFullConversation(ui) {
  ui.fullBanners = [{ text: fullConversationText }];
  ui.fullButtons = [{ text: "Start new chat" }];
}

function assistantMessage(index, text, attributes = {}) {
  return replyElement(text, messageId(index), attributes).parentElement;
}

function observedTurn(key, prompt, content = [], { complete = true, actionFirst = false } = {}) {
  const action = domElement('button', { 'aria-label': 'Regenerate response' });
  return domElement('section', { 'data-turn-key': key }, domElement('div', { 'data-talvt-turn-state': complete ? 'complete' : 'streaming' },
    domElement('h4', {}, domText('You said:')), domElement('div', {}, domText(prompt)),
    ...(actionFirst ? [action] : []), ...content, ...(!actionFirst && complete ? [action] : [])));
}

test("generation snapshots return only a marker match and do not read prior prompt text during observation", () => {
  const privatePrompt = 'PRIVATE_USER_TRANSCRIPT';
  const marker = 'Router generation: native-turn';
  const turn = observedTurn(messageId(100), privatePrompt, [assistantMessage(20, 'Public answer')]);
  const root = domElement('main', {}, turn);
  const selected = root.querySelectorAll(`[data-turn-key],${scopedReplySelector}`);
  let promptReads = 0;
  Object.defineProperty(turn, 'textContent', { get() { promptReads += 1; return `${privatePrompt}\n${marker}`; } });
  const options = { assistantSelector: scopedReplySelector, regenerateName: 'Regenerate response' };
  const observation = readReplies(selected, options);
  assert.equal(promptReads, 0);
  assert.equal(observation.turns[0].matchesGenerationMarker, false);
  const confirmation = readReplies(selected, { ...options, generationMarker: marker });
  assert.equal(promptReads, 1);
  assert.equal(confirmation.turns[0].matchesGenerationMarker, true);
  assert.doesNotMatch(JSON.stringify([observation, confirmation]), /PRIVATE_USER_TRANSCRIPT|Router generation/);
});

test("anchored projection reads only the owned body and completion metadata while retaining all identities", () => {
  const historicalAnswer = assistantMessage(10, "Historical answer");
  const currentAnswer = assistantMessage(20, "Current answer");
  const historical = observedTurn(messageId(100), "Old request", [historicalAnswer]);
  const current = observedTurn(messageId(200), "Current request", [currentAnswer]);
  const root = domElement("main", {}, historical, current);
  const selected = root.querySelectorAll(`[data-turn-key],${scopedReplySelector}`);
  const oldBody = historicalAnswer.querySelector(scopedReplySelector), oldText = oldBody.childNodes[0];
  let historicalBodyReads = 0, historicalMetadataReads = 0, currentBodyReads = 0;
  Object.defineProperty(oldText, "textContent", { get() { historicalBodyReads += 1; return "Historical answer"; } });
  Object.defineProperty(currentAnswer.querySelector(scopedReplySelector).childNodes[0], "textContent", {
    get() { currentBodyReads += 1; return "Current answer"; },
  });
  const query = historical.querySelectorAll;
  historical.querySelectorAll = function (selector) { historicalMetadataReads += 1; return query.call(this, selector); };
  const options = { assistantSelector: scopedReplySelector, regenerateName: "Regenerate response" };
  const anchored = readReplies(selected, { ...options, generationTurnKey: messageId(200) });
  assert.deepEqual(anchored.replies.map(reply => reply.messageId), [messageId(10), messageId(20)]);
  assert.deepEqual(anchored.turns.map(turn => turn.turnKey), [messageId(100), messageId(200)]);
  assert.deepEqual(anchored.replies.map(reply => reply.text), ["", "Current answer"]);
  assert.deepEqual([historicalBodyReads, historicalMetadataReads, currentBodyReads], [0, 0, 1]);
  assert.equal(anchored.replies[1].completionActionAfter, true);
  assert.equal(anchored.turns[1].complete, true);
  const full = readReplies(selected, options);
  assert.equal(full.replies[0].text, "Historical answer", "Recovery retains its full reply projection.");
  assert.ok(historicalBodyReads > 0 && historicalMetadataReads > 0);
  historicalAnswer.setAttribute("data-chatgpt-selection-message-id", messageId(20));
  const duplicate = readReplies(selected, { ...options, generationTurnKey: messageId(200) });
  assert.equal(duplicate.replies[0].identityDiagnostic.reason, "duplicate-wrapper-id");
  assert.equal(duplicate.replies[0].identityDiagnostic.duplicateWrapperCount, 2);
});

test("Send projections read global identities and only new candidate markers without historical bodies or completion metadata", () => {
  const old = observedTurn(messageId(100), "Old private prompt", [assistantMessage(10, "Old private answer")]);
  const current = observedTurn(messageId(200), "Router generation: current-turn", [assistantMessage(20, "Current answer")]);
  const root = domElement("main", {}, old, current);
  const oldRoot = old.querySelector(scopedReplySelector), currentRoot = current.querySelector(scopedReplySelector);
  const forbidden = () => { throw new Error("This phase cannot read historical text or completion metadata."); };
  Object.defineProperty(old, "textContent", { get: forbidden });
  Object.defineProperty(oldRoot.childNodes[0], "textContent", { get: forbidden });
  old.querySelectorAll = forbidden;
  const options = { assistantSelector: scopedReplySelector, regenerateName: "Regenerate response" };
  const identities = readReplies([old, current, oldRoot, currentRoot],
    { ...options, projection: "identities" });
  assert.deepEqual(identities.turns, [{ turnKey: messageId(100) }, { turnKey: messageId(200) }]);
  assert.deepEqual(identities.replies.map(reply => [reply.messageId, reply.turnKey, reply.text]),
    [[messageId(10), messageId(100), ""], [messageId(20), messageId(200), ""]]);
  const anchor = readReplies([old, current], { ...options, projection: "anchor", generationMarker: "Router generation: current-turn",
    baselineTurnKeys: [messageId(100)] });
  assert.deepEqual(anchor, { replies: [], turns: [{ turnKey: messageId(100), matchesGenerationMarker: false },
    { turnKey: messageId(200), matchesGenerationMarker: true }] });
  assert.throws(() => readReplies([old, current, oldRoot, currentRoot], options), /historical text or completion metadata/,
    "Recovery keeps the full historical body and completion proof.");
});

test("Send baseline retains global duplicate and malformed identity rejection without reading any answer body", async () => {
  for (const identity of [null, "malformed", messageId(0)]) {
    const f = fixture(); await f.ready();
    f.ui.texts = ["Earlier answer", "Later answer"];
    f.ui.replyIds = [messageId(0), identity];
    await assert.rejects(f.run("send", { ...plugin, prompt: "Current request" }), /baseline has missing or ambiguous message identities/);
    assert.equal(f.ui.sendClicks, 0);
  }
});

test("generated bootstrap reads the current session browser and opens a verified empty normal home", async () => {
  const f = fixture();
  await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
  assert.equal(f.getState().browser, f.browser);
  assert.equal(f.ui.newTabs, 0);
  assert.equal(f.activeTurn(), undefined);
  await assert.rejects(f.run("open", { sessionId: "foreign-session" }), /another native session/);
  assert.equal(f.ui.newTabs, 0, "A foreign native session cannot allocate a tab from this binding.");
  assert.equal(f.activeTurn(), undefined);
  const goto = f.tab.goto;
  f.tab.goto = async url => {
    assert.equal(f.activeTurn()?.state.tab, f.tab, "Native Interrupt can find the owned tab before navigation starts.");
    await goto(url);
  };
  const open = await f.run("open", { ui: { stopButtonExactName: "Stop generating" } });
  assert.deepEqual([open.tabId, open.normal], ["owned-tab", true]);
  assert.equal(f.ui.url, "https://chatgpt.com/");
  assert.equal(f.ui.handoffs, 1);
  assert.deepEqual(f.activeTurn(), { turnId: base.turnId, state: f.getState(), stopButtonName: "Stop generating" });
  await assert.rejects(f.run("open"), /already owns/);
});

test("open accepts a personalized or absent decorative home heading when the empty normal home is ready", async () => {
  for (const heading of ["A greeting that can change", undefined]) {
    const f = fixture({ fastTimers: true });
    await f.run("bootstrap", { runtimeModule: "current-runtime.mjs" });
    f.ui.decorativeHeading = heading;
    const result = await f.run("open");
    assert.equal(result.normal, true);
    assert.equal(f.ui.waitedMs, 0);
    assert.equal(f.ui.handoffs, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
    assert.equal(f.ui.sendClicks, 0);
  }
});

test("open observes deferred hydration of the composer and both controls without opening or navigating again", async () => {
  const f = fixture({ fastTimers: true });
  await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
  f.ui.composerVisible = false;
  f.ui.modelButtonVisible = false;
  f.ui.temporaryButtonVisible = false;
  f.ui.onWait = () => {
    assert.equal(f.activeTurn()?.state.tab, f.tab, "The owned tab is interruptible while its initial controls hydrate.");
    f.ui.composerVisible = f.ui.waitedMs >= 100;
    f.ui.modelButtonVisible = f.ui.waitedMs >= 200;
    f.ui.temporaryButtonVisible = f.ui.waitedMs >= 300;
  };
  const result = await f.run("open");
  assert.equal(result.normal, true);
  assert.equal(f.ui.waitedMs, 300);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  assert.equal(f.ui.sendClicks, 0);
});

test("normal home waits for both independent temporary-mode visibility reads", { timeout: 2000 }, async () => {
  const f = fixture();
  await f.run("bootstrap", { runtimeModule: "current-runtime.mjs" });
  const started = new Set(), barrier = Promise.withResolvers();
  f.ui.onControlRead = async ({ kind, name, method }) => {
    if (method !== "isVisible" || !["Turn off temporary chat", "Temporary chat"].includes(name)
        || name === "Temporary chat" && kind !== "heading") return;
    started.add(name);
    if (started.size === 2) barrier.resolve();
    await barrier.promise;
  };
  assert.equal((await f.run("open")).normal, true);
  assert.deepEqual([...started].sort(), ["Temporary chat", "Turn off temporary chat"]);
  assert.equal(f.ui.sendClicks, 0);
  assert.equal(f.ui.newTabs, 1);
});

test("a missing initial control ends open's bounded hydration wait without navigation retry or Send", async () => {
  for (const control of ["composerVisible", "modelButtonVisible", "temporaryButtonVisible"]) {
    const f = fixture({ fastTimers: true });
    await f.run("bootstrap", { sessionId: "current-session", runtimeModule: "validated-runtime.mjs" });
    f.ui[control] = false;
    await assert.rejects(f.run("open"), /controls did not become ready within 10 seconds/);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.activeTurn()?.state.tab, f.tab, "A failed initial wait keeps the created tab available for native Interrupt.");
    await assert.rejects(f.run("open"), /already owns/);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("initial normal home verification rejects history, drafts, ambiguous composers, active generation, temporary mode and disabled controls", async () => {
  for (const change of [
    ui => { ui.texts = ["Existing answer"]; },
    ui => { ui.composerText = "Existing draft"; },
    ui => { ui.composerElements = [domElement("div", { contenteditable: "true" }), domElement("div", { contenteditable: "true" })]; },
    ui => { ui.stop = true; },
    ui => { ui.temporary = true; },
    ui => { ui.temporary = true; ui.temporaryHeadingVisible = false; },
    ui => { ui.temporaryButtonDisabled = true; },
    ui => { ui.modelButtonDisabled = true; },
  ]) {
    const f = fixture({ fastTimers: true });
    await f.run("bootstrap", { runtimeModule: "current-runtime.mjs" });
    change(f.ui);
    const draft = f.ui.composerText;
    await assert.rejects(f.run("open"), /Empty normal ChatGPT home controls/);
    assert.equal(f.ui.composerText, draft);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  }
});

test("every registered Web model and effort verifies its exact family and stepwise Power before one Send", async t => {
  for (const model of WEB_MODEL_REGISTRY) for (const [effort, level] of Object.entries(model.efforts)) {
    await t.test(`${model.slug} ${effort}`, async () => {
      const selection = webModelSelection(model.slug, effort);
      const oppositePower = level.power <= 2 ? 4 : 0;
      for (const switchFamily of [false, true]) {
        const f = fixture({ currentPower: oppositePower });
        await f.ready();
        f.ui.familyText = model.family;
        f.ui.checked = !switchFamily;
        await f.run("send", { ...plugin, prompt: "Use the exact requested model", modelFamily: selection.family, power: selection.power });
        // The fixture models the observed family-switch reset to Power 2.
        const startingPower = switchFamily ? 2 : oppositePower;
        const direction = startingPower > level.power ? "ArrowLeft" : "ArrowRight";
        assert.deepEqual([f.ui.checked, f.ui.familyText, f.ui.power], [true, model.family, level.power]);
        assert.deepEqual(f.ui.powerMoves, Array(Math.abs(startingPower - level.power)).fill(direction));
        assert.deepEqual(f.ui.actions, ["attach", "model-menu", ...(switchFamily ? ["expand-models", "select-family"] : []), "send"]);
        assert.equal(f.ui.familyExpansionClicks, Number(switchFamily));
        assert.equal(f.ui.familyClicks, Number(switchFamily));
        assert.equal(f.ui.familySwitches, Number(switchFamily));
        assert.equal(f.ui.clippedFamilyClicks, 0);
        assert.equal(f.ui.sendClicks, 1);
      }
      const invalid = fixture({ currentPower: oppositePower });
      await invalid.ready();
      invalid.ui.familyText = model.family;
      invalid.ui.badPowerStep = true;
      await assert.rejects(invalid.run("send", { ...plugin, prompt: "Reject a skipped Power step", modelFamily: selection.family, power: selection.power }), /exactly one step/);
      assert.equal(invalid.ui.powerMoves.length, 1);
      assert.equal(invalid.ui.sendClicks, 0);
    });
  }
});

test("missing Power attributes prevent Send", async () => {
  const f = fixture(); await f.ready();
  f.ui.missingPower = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Require observed Power" }), /attributes are unavailable/);
  assert.equal(f.ui.sendClicks, 0);
});

test("an unnamed radio option is selected by visible family text and similar family text is rejected before selection", async () => {
  const f = fixture({ currentPower: 0 });
  f.ui.checked = false;
  assert.equal(await f.tab.playwright.getByRole("menuitemradio", { name: "GPT-6", exact: true }).count(), 0);
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Select the exact observed family" });
  assert.equal(f.ui.checked, true);
  assert.equal(f.ui.familyClicks, 1);
  const invalid = fixture({ currentPower: 0 });
  await invalid.ready();
  invalid.ui.familyText = "GPT-6.1";
  invalid.ui.checked = false;
  await assert.rejects(invalid.run("send", { ...plugin, prompt: "Reject a similar family" }), /one exact observed model family/);
  assert.equal(invalid.ui.familyClicks, 0, "A substring match cannot select a different family.");
  assert.equal(invalid.ui.sendClicks, 0);
});

test("collapsed-present family rows are expanded before switching to GPT-5.6 Sol Instant", async () => {
  const f = fixture({ currentPower: 0 }); await f.ready();
  f.ui.familyText = 'GPT-5.6 Sol'; f.ui.checked = false;
  const hiddenRow = f.tab.playwright.getByRole('menu', { name: 'Select ChatGPT model', exact: true })
    .locator('[role="menuitemradio"]').filter({ hasText: 'GPT-5.6 Sol' });
  assert.equal(await hiddenRow.count(), 1, 'Collapsed rows are still present in the DOM.');
  await f.run('send', { ...plugin, prompt: 'Use GPT-5.6 Sol Instant', modelFamily: 'GPT-5.6 Sol', power: 0 });
  assert.deepEqual([f.ui.checked, f.ui.familyText, f.ui.power], [true, 'GPT-5.6 Sol', 0]);
  assert.equal(f.ui.familyExpansionClicks, 1);
  assert.equal(f.ui.familyClicks, 1);
  assert.equal(f.ui.familySwitches, 1);
  assert.equal(f.ui.clippedFamilyClicks, 0);
  assert.deepEqual(f.ui.powerMoves, ['ArrowLeft', 'ArrowLeft'], 'A family switch defaults Power to 2 before the requested Instant setting.');
  assert.equal(f.ui.sendClicks, 1);
});

test("an exact current family and Power send without family selection or Power movement", async () => {
  const f = fixture({ currentPower: 0 }); await f.ready();
  await f.run("send", { ...plugin, prompt: "Keep the current selection" });
  assert.deepEqual([f.ui.checked, f.ui.familyText, f.ui.power], [true, "GPT-6", 0]);
  assert.deepEqual(f.ui.actions, ["attach", "model-menu", "send"]);
  assert.deepEqual(f.ui.powerMoves, []);
  assert.equal(f.ui.clippedFamilyClicks, 0);
});

test("picker reads settle together within each stable phase before selection or Send proceeds", { timeout: 2000 }, async () => {
  const f = fixture(); await f.ready();
  const groups = [
    ["family:count", "family:textContent", "family:aria-checked"],
    ["family:count", "family:textContent"],
    ["slider:aria-valuenow", "slider:aria-valuemin", "slider:aria-valuemax"],
    ["family:aria-checked", "family:textContent"],
  ];
  let phase = 0, started = new Set(), barrier = Promise.withResolvers();
  f.ui.onControlRead = async ({ kind, name, method, attribute }) => {
    const key = `${kind === "family-text" ? "family" : name === '[role="slider"]' ? "slider" : "other"}:${attribute ?? method}`;
    if (!groups[phase]?.includes(key)) return;
    const pending = barrier;
    assert.equal(started.has(key), false, "A phase cannot reread one control while another independent read is pending.");
    started.add(key);
    assert.equal(f.ui.sendClicks, 0);
    if (phase === 2) assert.equal(f.ui.powerMoves.length, 0, "Power must not move before its range has been read.");
    if (started.size === groups[phase].length) {
      phase += 1;
      started = new Set();
      barrier = Promise.withResolvers();
      pending.resolve();
    }
    await pending.promise;
  };
  await f.run("send", { ...plugin, prompt: "Read stable control groups" });
  assert.equal(phase, groups.length);
  assert.deepEqual(f.ui.powerMoves, ["ArrowLeft", "ArrowLeft", "ArrowLeft"]);
  assert.equal(f.ui.sendClicks, 1);
});

test("final concurrent family verification rejects a changed checked state or family after Power readback", async () => {
  for (const change of [ui => { ui.checked = false; }, ui => { ui.familyText = "GPT-6 unexpected"; }]) {
    const f = fixture(); await f.ready();
    f.ui.onControlRead = ({ kind }) => { if (kind === "family-text" && f.ui.powerMoves.length === 3) change(f.ui); };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Require the current final selection" }), /Requested model and Power were not verified/u);
    assert.equal(f.ui.sendClicks, 0);
    assert.deepEqual(f.ui.powerMoves, ["ArrowLeft", "ArrowLeft", "ArrowLeft"]);
  }
});

test("failed family expansion cannot click a clipped row or send", async () => {
  const f = fixture(); await f.ready();
  f.ui.checked = false; f.ui.expansionFails = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Select the requested family" }), /list did not expand/);
  assert.equal(f.ui.familyExpansionClicks, 1);
  assert.equal(f.ui.familyClicks, 0);
  assert.equal(f.ui.clippedFamilyClicks, 0);
  assert.equal(f.ui.sendClicks, 0);
});

test("prepared Send skips an existing exact connector chip and ignores cached model and connector state", async () => {
  const f = fixture({ currentPower: 4 });
  await f.ready();
  f.ui.chip = true;
  Object.assign(f.getState(), { model: { family: "GPT-6", power: 0 }, pluginAppId: "asdk_old_tools" });
  f.ui.onType = () => { f.ui.power = 3; };
  await f.run("send", { ...plugin, prompt: "Recheck after preparation" });
  assert.deepEqual(f.ui.actions, ["model-menu", "send"]);
  assert.equal(f.ui.attachedName, null);
  assert.equal(f.ui.power, 0);
  assert.deepEqual(f.ui.powerMoves, Array(3).fill("ArrowLeft"));
});

test("a model change between retained turns is read from the picker before the next Send", async () => {
  const f = fixture({ currentPower: 0 }); await f.ready();
  await f.run("send", { ...plugin, prompt: "First request" });
  f.ui.texts.push("First answer"); f.ui.complete = true;
  await f.run("observe"); await f.run("retain");
  await f.run("continue", { turnId: "next-turn" });
  f.getState().model = { family: "GPT-6", power: 0 };
  f.ui.checked = false; f.ui.power = 4; f.ui.complete = false;
  await f.run("send", { ...plugin, prompt: "Second request", turnId: "next-turn" });
  assert.equal(f.ui.familyExpansionClicks, 1);
  assert.equal(f.ui.familySwitches, 1);
  assert.equal(f.ui.clippedFamilyClicks, 0);
  assert.deepEqual(f.ui.powerMoves, ["ArrowLeft", "ArrowLeft"], "The actual family switch resets Power to 2.");
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
});

test("connector attachment failures or a changed draft prevent model selection, typing and Send", async () => {
  for (const [change, reason] of [
    [ui => { ui.selectionCount = 0; }, /unavailable or ambiguous/],
    [ui => { ui.selectionCount = 2; }, /unavailable or ambiguous/],
    [ui => { ui.onAttach = () => { ui.chip = false; }; }, /was not attached/],
    [ui => { ui.onAttach = () => { ui.composerText = "A changed draft"; }; }, /changed the composer draft/],
    [ui => { ui.onAttach = () => { ui.url = "https://chatgpt.com/c/unrelated"; }; }, /no longer idle/],
    [ui => { ui.onAttach = () => { ui.stop = true; }; }, /no longer idle/],
  ]) {
    const f = fixture();
    await f.ready();
    change(f.ui);
    await assert.rejects(f.run("send", { ...plugin, prompt: "Prepare safely" }), reason);
    assert.equal(f.ui.actions.includes("model-menu"), false);
    assert.equal(f.ui.typed.length, 0);
    assert.equal(f.ui.sendClicks, 0);
  }
});

test("model selection cannot bypass the final draft, chip or normal idle chat checks", async () => {
  for (const change of [ui => { ui.composerText += " User edit"; }, ui => { ui.chip = false; },
    ui => { ui.temporary = true; }, ui => { ui.stop = true; }, ui => { ui.url = "https://chatgpt.com/c/unrelated"; }]) {
    const f = fixture();
    await f.ready();
    f.ui.onModel = () => change(f.ui);
    await assert.rejects(f.run("send", { ...plugin, prompt: "Prepare safely" }), /nothing sent/);
    assert.equal(f.ui.sendClicks, 0);
    await assert.rejects(f.run("send", { ...plugin, prompt: "Never replay" }), /cannot be replayed/);
  }
});

test("sending preserves the plugin chip, treats prompt as data, and refuses uncertain replay", async () => {
  const f = fixture();
  await f.ready();
  const prompt = 'User content: ` ${throwSomething()} "; await malicious(); //\nNext line';
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt }), /effect uncertain/);
  assert.deepEqual(f.ui.typed, [` ${prompt}`, `\nRouter generation: ${base.turnId}`]);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.chip, true);
  await assert.rejects(f.run("send", { ...plugin, prompt }), /cannot be replayed/);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.handoffs, 2);
});

test("typing that removes the required app chip cannot trigger Send", async () => {
  const f = fixture();
  await f.ready();
  f.ui.stripChip = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Run current tools" }), /removed the plugin chip/);
  assert.equal(f.ui.sendClicks, 0);
});

test("each coherent Send phase freshly rejects draft, plugin, navigation and semantic control changes", async () => {
  for (const phase of [1, 2, 3, 4]) {
    for (const change of ["draft", "plugin", "URL", "Stop", "temporary", "ambiguous composer"]) {
      const f = fixture(); await f.ready();
      f.ui.onMutationRead = () => {
        if (f.ui.mutationReads !== phase) return;
        if (change === "draft") f.ui.composerText = "Foreign private draft";
        if (change === "plugin") f.ui.chip = false;
        if (change === "URL") f.ui.url = "https://chatgpt.com/c/foreign-chat";
        if (change === "Stop") f.ui.observationControls = { Stop: [domElement("button", { "aria-labelledby": "semantic-stop-label" })] };
        if (change === "temporary") f.ui.temporary = true;
        if (change === "ambiguous composer") f.ui.composerElements = [domElement("div", { contenteditable: "true" }), domElement("div", { contenteditable: "true" })];
      };
      // The post-plugin baseline also checks the chip before typing proceeds.
      await assert.rejects(f.run("send", { ...plugin, prompt: "Current request" }), /nothing sent|plugin chip/,
        `${change} changed during phase ${phase}`);
      assert.equal(f.ui.sendClicks, 0);
    }
  }
});

test("semantic mutation reads reject duplicate mounted controls even when hidden", async () => {
  for (const control of ["Stop", "Turn off temporary chat", "Temporary chat"]) {
    const f = fixture(); await f.ready();
    f.ui.onMutationRead = () => {
      if (control === "Stop") f.ui.stopCount = 2;
      else f.ui.observationControls = { [control]: [domElement(control === "Temporary chat" ? "h2" : "button"),
        domElement(control === "Temporary chat" ? "h2" : "button")] };
    };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Current request" }), /mutation document is unavailable/);
    assert.equal(f.ui.sendClicks, 0);
  }
});

test("Send rechecks active ownership and exact draft after the awaited retention handoff", async () => {
  for (const change of ["owner", "draft", "chip", "URL"]) {
    const f = fixture(); await f.ready();
    const handoff = f.tab.markHandoff;
    f.tab.markHandoff = async () => {
      await handoff();
      if (change === "owner") f.activeTurn().turnId = "foreign-turn";
      if (change === "draft") f.ui.composerText += " Changed after handoff";
      if (change === "chip") f.ui.chip = false;
      if (change === "URL") f.ui.url = "https://chatgpt.com/c/foreign-chat";
    };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Current request" }), /nothing sent|different native turn/);
    assert.equal(f.ui.sendClicks, 0);
  }
});

test("generation readiness waits for a rendered marker and settled UUID before its single authoritative snapshot", async () => {
  for (const delayed of ["marker", "identity"]) {
    const f = fixture({ fastTimers: true }); await f.ready();
    const reads = f.ui.replyReads;
    let pending;
    f.ui.onSend = () => {
      pending = f.ui.userMessages[0];
      if (delayed === "marker") f.ui.userMessages = [];
      else pending.messageId = "settling-renderer-identity";
    };
    f.ui.onGenerationWait = ({ timeoutMs }) => {
      assert.equal(timeoutMs, 10000);
      pending.messageId = messageId(1001);
      f.ui.userMessages = [pending];
    };
    const sent = await f.run("send", { ...plugin, prompt: "Current request" });
    assert.equal(sent.sent, true);
    assert.equal(sent.generationTurnKey, messageId(1001));
    assert.equal(f.ui.generationWaits, 1);
    assert.equal(f.ui.replyReads - reads, 2, "Only the identity baseline and authoritative anchor read the mounted conversation.");
  }
});

test("marker readiness cannot replace global turn uniqueness, latest ownership or fresh URL and cancellation guards", async () => {
  for (const change of ["duplicate identity", "newer manual turn", "foreign URL", "owner changed", "wait failed"]) {
    const f = fixture({ fastTimers: true }); await f.ready();
    f.ui.onGenerationWait = () => {
      const current = f.ui.userMessages[0];
      if (["duplicate identity", "newer manual turn"].includes(change)) f.ui.userMessages.push({ ...current,
        messageId: change === "duplicate identity" ? current.messageId : messageId(2000), text: "Manual user request" });
      if (change === "foreign URL") f.ui.url = "https://chatgpt.com/c/foreign-chat";
      if (change === "owner changed") f.activeTurn().turnId = "foreign-turn";
      if (change === "wait failed") f.ui.generationWaitError = new Error("Native locator wait failed.");
    };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Current request" }), /effect is uncertain|different native turn/);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.getState().sendConfirmed, false);
    await assert.rejects(f.run("send", { ...plugin, prompt: "Do not replay" }), /cannot be replayed/);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a long paste waits for Send readiness, types its payload and short marker once, and sends once", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.sendEnabled = false;
  f.ui.onWait = () => { if (f.ui.waitedMs >= 300) f.ui.sendEnabled = true; };
  const prompt = "Full native context\n".repeat(4000);
  const result = await f.run("send", { ...plugin, prompt });
  assert.equal(result.sent, true);
  assert.equal(f.ui.waitedMs, 300);
  assert.deepEqual(f.ui.typed, [` ${prompt}`, `\nRouter generation: ${base.turnId}`]);
  assert.equal(f.ui.sendClicks, 1);
  await assert.rejects(f.run("send", { ...plugin, prompt }), /cannot be replayed/);
  assert.equal(f.ui.sendClicks, 1);
});

test("a settled pasted attachment keeps the short generation marker visible and cannot replay Send", async () => {
  const f = fixture({ fastTimers: true }); await f.ready();
  const prompt = 'Full native context\n'.repeat(4000);
  f.ui.sendEnabled = false;
  f.ui.onWait = () => { f.ui.composerText = ''; f.ui.sendEnabled = true; };
  const sent = await f.run('send', { ...plugin, prompt });
  assert.equal(sent.sent, true);
  assert.deepEqual(f.ui.typed, [` ${prompt}`, `\nRouter generation: ${base.turnId}`]);
  assert.equal(f.ui.userMessages[0].text, `\nRouter generation: ${base.turnId}`);
  assert.equal(typeof sent.generationTurnKey, 'string');
  await assert.rejects(f.run('send', { ...plugin, prompt }), /cannot be replayed/);
  assert.equal(f.ui.sendClicks, 1);
});

test("a pasted attachment preserves full context and leaves only the explicit newest tool directive and marker visible", async () => {
  const f = fixture({ fastTimers: true }); await f.ready();
  const turnToken = 'web_turn_0123456789abcdef0123456789abcdef';
  const olderToken = 'web_turn_fedcba9876543210fedcba9876543210';
  const prompt = `Historical tool result: use turn_token ${olderToken}.\nFull native context\n`.repeat(4000);
  f.ui.sendEnabled = false;
  f.ui.onWait = () => { f.ui.composerText = ''; f.ui.sendEnabled = true; };
  const sent = await f.run('send', { ...plugin, prompt, turnToken });
  const visible = f.ui.userMessages[0].text;
  assert.equal(f.ui.typed[0], ` ${prompt}`, 'The complete input remains in the original pasted payload.');
  assert.equal(f.ui.typed.length, 2, 'The current directive and marker are appended once after paste conversion.');
  assert.equal(f.ui.typed[1], visible);
  assert.equal(visible.split(turnToken).length - 1, 1);
  assert.ok(visible.includes(`Use turn_token ${turnToken} unchanged with every Codex MCP tool call in this response.`));
  assert.ok(visible.includes('instead of tokens quoted in the attached transcript, earlier messages, or tool results'));
  assert.ok(visible.startsWith(`\nRouter generation: ${base.turnId}\nUse turn_token `));
  assert.ok(visible.endsWith('Never expose the token in your answer.'));
  assert.equal(visible.includes(olderToken), false, 'A historical token cannot supply the structured current directive.');
  assert.equal(f.getState().submittedComposerText, visible);
  assert.equal(f.getState().generationMarker, `Router generation: ${base.turnId}`, 'Generation ownership retains only the nonsecret marker.');
  assert.equal(sent.sent, true); assert.equal(f.ui.sendClicks, 1);
  assert.equal(JSON.stringify(sent).includes(turnToken), false, 'Private authority does not enter the browser receipt.');
  await assert.rejects(f.run('send', { ...plugin, prompt, turnToken }), /cannot be replayed/u);
});

test("a changed current tool directive, chip removal or a later draft edit prevents Send without exposing the token", async () => {
  const turnToken = 'web_turn_0123456789abcdef0123456789abcdef';
  for (const change of ['directive removed', 'chip removed', 'draft changed while waiting', 'draft changed by picker']) {
    const f = fixture({ fastTimers: true }); await f.ready();
    f.ui.onType = text => {
      if (!text.includes(`Use turn_token ${turnToken}`)) return;
      if (change === 'directive removed') f.ui.composerText = f.ui.composerText.replace(turnToken, '');
      if (change === 'chip removed') f.ui.chip = false;
      if (change === 'draft changed while waiting') f.ui.sendEnabled = false;
    };
    if (change === 'draft changed while waiting') f.ui.onWait = () => { f.ui.composerText += ' Foreign draft'; f.ui.sendEnabled = true; };
    if (change === 'draft changed by picker') f.ui.onModel = () => { f.ui.composerText += ' Foreign draft'; };
    await assert.rejects(f.run('send', { ...plugin, prompt: 'Current request', turnToken }), error => {
      assert.match(error.message, /nothing sent/u);
      assert.equal(error.message.includes(turnToken), false);
      return true;
    });
    assert.equal(f.ui.sendClicks, 0, change);
  }
  for (const invalid of ['', null, 'web_turn_wrong', `${turnToken}\nInjected directive`, turnToken.toUpperCase()]) {
    assert.throws(() => browserScript({ ...base, operation: 'send', prompt: 'Request', turnToken: invalid }), /broker token format/u);
  }
  assert.throws(() => browserScript({ ...base, operation: 'observe', turnToken }), /supported only for Send/u);
});

test("a changed draft while bulk paste or the short marker settles prevents Send", async () => {
  for (const markerPhase of [false, true]) {
    const f = fixture({ fastTimers: true }); await f.ready();
    f.ui.sendEnabled = markerPhase;
    f.ui.onType = text => { if (markerPhase && text.startsWith('\nRouter generation:')) f.ui.sendEnabled = false; };
    f.ui.onWait = () => { f.ui.composerText += ' Foreign draft'; f.ui.sendEnabled = true; };
    await assert.rejects(f.run('send', { ...plugin, prompt: 'Request' }), /draft changed/);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.ui.typed.length, markerPhase ? 2 : 1);
    await assert.rejects(f.run('send', { ...plugin, prompt: 'Request' }), /cannot be replayed/);
  }
});

test("Send waits within its existing budget for one saved URL before confirming persistence", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.deferSavedUrl = true;
  f.ui.onWait = () => { if (f.ui.waitedMs >= 300) f.ui.url = "https://chatgpt.com/c/owned-conversation"; };
  const sent = await f.run("send", { ...plugin, prompt: "Wait for saved URL" });
  assert.equal(sent.normal, true);
  assert.equal(sent.url, "https://chatgpt.com/c/owned-conversation");
  assert.equal(f.ui.waitedMs, 300);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.typed.length, 2);
  assert.equal(f.getState().sendConfirmed, true);
});

test("paste readiness, saved URL and generation proof consume one shared Send deadline", async () => {
  for (const delayed of ["saved URL", "generation"]) {
    const f = fixture({ fastTimers: true }); await f.ready();
    f.ui.sendEnabled = false;
    f.ui.deferSavedUrl = delayed === "saved URL";
    let sentMessages;
    f.ui.onSend = () => { if (delayed === "generation") sentMessages = f.ui.userMessages.splice(0); };
    f.ui.onWait = () => {
      if (f.ui.waitedMs >= 8000) f.ui.sendEnabled = true;
      // This evidence arrives within a fresh phase budget, but after the
      // original Send budget. Resetting a deadline would wrongly confirm it.
      if (f.ui.waitedMs >= 11000) {
        f.ui.url = "https://chatgpt.com/c/owned-conversation";
        if (sentMessages) f.ui.userMessages = sentMessages;
      }
    };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Shared deadline" }), /its effect is uncertain/);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.getState().sendConfirmed, false);
    assert.equal(f.ui.sendClicks, 1);
    await assert.rejects(f.run("send", { ...plugin, prompt: "No replay" }), /cannot be replayed/);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a missing saved URL or temporary URL after Send remains uncertain and cannot repeat Send", async () => {
  for (const url of ["https://chatgpt.com/", "https://chatgpt.com/c/owned-conversation?temporary-chat=true"]) {
    const f = fixture({ fastTimers: true });
    await f.ready();
    f.ui.deferSavedUrl = true;
    f.ui.onSend = () => { f.ui.url = url; };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain persistence" }), /no verified saved conversation URL/);
    assert.equal(f.getState().sendConfirmed, false);
    assert.equal(f.getState().sendClicked, true);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.ui.sendClicks, 1);
    await assert.rejects(f.run("send", { ...plugin, prompt: "Never repeat" }), /cannot be replayed/);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a follow-up Send cannot confirm a different saved conversation URL", async () => {
  const f = await recoverableFixture();
  await f.run("continue", { turnId: "next-turn" });
  f.ui.onSend = () => { f.ui.url = "https://chatgpt.com/c/unrelated-conversation"; };
  await assert.rejects(f.run("send", { ...plugin, prompt: "Follow-up", turnId: "next-turn" }), /changed the owned saved conversation URL/);
  assert.equal(f.getState().sendConfirmed, false);
  assert.equal(f.getState().savedUrl, f.recovery.url);
  assert.equal(f.ui.sendClicks, 2);
});

test("the exact visible full-chat banner and site button override reassuring assistant prose in observation", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Check this chat" });
  f.ui.texts.push("There is still plenty of room in this conversation.");
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const observed = await f.run("observe");
  assert.equal(observed.conversationFull, true);
  assert.equal(observed.assistantText, "There is still plenty of room in this conversation.");
  assert.equal(observed.completed, false);
  assert.equal(f.ui.waitedMs, 0, "Positive site evidence returns without another observation round.");
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("full-chat detection requires both exact visible site controls outside assistant and editable content", async () => {
  for (const change of [
    ui => { ui.fullBanners = [{ text: fullConversationText }]; },
    ui => { ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { showFullConversation(ui); ui.fullBanners[0].text += " Extra text"; },
    ui => { showFullConversation(ui); ui.fullBanners[0].visible = false; },
    ui => { showFullConversation(ui); ui.fullButtons[0].visible = false; },
    ui => { ui.texts.push(fullConversationText); ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { ui.userTexts = [fullConversationText]; ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { showFullConversation(ui); ui.fullBanners[0].scope = "user-article"; },
    ui => { ui.composerText = fullConversationText; ui.fullButtons = [{ text: "Start new chat" }]; },
    ui => { showFullConversation(ui); ui.fullBanners[0].scope = "assistant-ancestor"; },
    ui => { showFullConversation(ui); ui.fullBanners[0].scope = "composer-ancestor"; },
    ui => { showFullConversation(ui); ui.fullButtons[0].scope = "assistant"; },
    ui => { showFullConversation(ui); ui.fullButtons[0].scope = "user"; },
    ui => { showFullConversation(ui); ui.fullButtons[0].scope = "composer"; },
  ]) {
    const f = fixture();
    await f.ready();
    await f.run("send", { ...plugin, prompt: "Check site evidence" });
    change(f.ui);
    assert.equal((await f.run("observe")).conversationFull, false);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
  }
});

test("full-chat continuation emits metadata while preserving the exact previous owner and send state", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const state = { ...f.getState() };
  const previousHandoffs = f.ui.handoffs;
  const continued = await f.run("continue", { turnId: "next-turn" });
  assert.equal(continued.conversationFull, true);
  assert.equal(continued.assistantText, f.text);
  assert.equal(continued.url, f.recovery.url);
  assert.equal(f.activeTurn(), owner);
  assert.deepEqual(f.getState(), state);
  assert.equal(f.ui.handoffs, previousHandoffs + 1, "Full-chat continuation renews turn-scoped retention before returning metadata.");
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("full-chat continuation rejects an owner change during retention without reclaiming the newer turn", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const state = { ...f.getState() };
  const handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { await handoff(); owner.turnId = "newer-turn"; };
  await assert.rejects(f.run("continue", { turnId: "next-turn" }), /active browser cleanup/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.activeTurn().turnId, "newer-turn");
  assert.deepEqual(f.getState(), state);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("a full-chat Send precheck returns sent false before typing, clicking or changing ownership", async () => {
  const f = await recoverableFixture();
  await f.run("continue", { turnId: "next-turn" });
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const state = { ...f.getState() };
  const typed = [...f.ui.typed];
  const result = await f.run("send", { ...plugin, prompt: "A new delta", turnId: "next-turn" });
  assert.deepEqual(result, { operation: "send", sent: false, conversationFull: true, normal: true,
    tabId: "owned-tab", url: f.recovery.url });
  assert.deepEqual(f.ui.typed, typed);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  assert.equal(f.activeTurn(), owner);
  assert.deepEqual(f.getState(), state);
});

test("positive full-chat controls cannot turn a previous uncertain Send into a safe unsent result", async () => {
  const f = fixture();
  await f.ready();
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain request" }), /effect uncertain/);
  showFullConversation(f.ui);
  await assert.rejects(f.run("send", { ...plugin, prompt: "Do not replay" }), /cannot be replayed/);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.getState().sendClicked, true);
  assert.equal(f.getState().sendConfirmed, false);
});

test("full-chat continuation cannot bypass uncertainty from a clicked follow-up Send in the saved chat", async () => {
  const f = await recoverableFixture();
  await f.run("continue", { turnId: "uncertain-turn" });
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain follow-up", turnId: "uncertain-turn" }), /effect uncertain/);
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: "uncertain-turn" }), /preceding Send is uncertain/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.getState().sendClicked, true);
  assert.equal(f.getState().sendConfirmed, false);
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("guarded rollover clicks once in the same owned tab and keeps full history required until a confirmed Send", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const original = f.getState();
  const owner = f.activeTurn();
  f.ui.onStartNewChat = () => {
    assert.equal(f.activeTurn(), owner, "The old owner remains current until the new home is verified.");
    assert.equal(f.ui.handoffs, 4, "Retention renews before Start new chat.");
    assert.equal(f.getState().needsHistory, true);
    assert.equal(f.getState().rolloverAttempted, true);
    assert.equal(f.getState().rolloverFromUrl, f.recovery.url);
  };
  const rolled = await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  assert.deepEqual(rolled, { operation: "rollover", rolledOver: true, needsHistory: true, previousChatUrl: f.recovery.url,
    tabId: "owned-tab", url: "https://chatgpt.com/", normal: true });
  assert.equal(f.getState(), original);
  assert.deepEqual(f.getState().baselineReplyIds, []);
  assert.equal(f.getState().savedUrl, undefined);
  assert.equal(f.getState().sendAttempted, false);
  assert.equal(f.activeTurn().turnId, "next-turn");
  const continued = await f.run("continue", { turnId: "following-turn", interruptedTurnId: "next-turn",
    expectedOwnerTurnIds: [base.turnId, "next-turn"] });
  assert.equal(continued.needsHistory, true);
  assert.equal(continued.assistantText, "");
  f.ui.onSend = () => { f.ui.url = "https://chatgpt.com/c/successor-conversation"; };
  const sent = await f.run("send", { ...plugin, prompt: "Complete readable native history", turnId: "following-turn" });
  assert.deepEqual(sent.baselineReplyIds, []);
  for (const key of ["needsHistory", "rolloverAttempted", "rolloverFromUrl"]) assert.equal(f.getState()[key], undefined);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
});

test("a rollover whose click result was discarded only acknowledges an already proven empty home on retry", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const previousOwner = f.activeTurn();
  f.ui.rolloverClickFailure = true;
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /Start new chat effect uncertain/);
  assert.equal(f.activeTurn(), previousOwner);
  assert.equal(f.getState().needsHistory, true);
  assert.equal(f.getState().rolloverAttempted, true);
  f.ui.rolloverClickFailure = false;
  const rolled = await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url,
    expectedOwnerTurnIds: [base.turnId, "next-turn"] });
  assert.equal(rolled.needsHistory, true);
  assert.equal(f.activeTurn().turnId, "next-turn");
  await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  assert.equal(f.ui.startNewChatClicks, 1, "No acknowledgement retry can click Start new chat again.");
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("a rollover attempt that never reaches proven home cannot retry its click or continue as a fresh chat", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  f.ui.deferRolloverHome = true;
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /did not reach an empty normal home within 10 seconds/);
  assert.equal(f.ui.waitedMs, 10000);
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /cannot be clicked again/);
  await assert.rejects(f.run("continue", { turnId: "next-turn", needsHistory: true, interruptedTurnId: base.turnId }), /not a proven empty normal home/);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.getState().needsHistory, true);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("rollover waits for normal home hydration after its one click without another navigation", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  f.ui.deferRolloverHome = true;
  f.ui.onWait = () => {
    if (f.ui.waitedMs >= 300) Object.assign(f.ui, { url: "https://chatgpt.com/", texts: [],
      composerText: "", chip: false, fullBanners: [], fullButtons: [] });
  };
  const rolled = await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  assert.equal(rolled.rolledOver, true);
  assert.equal(f.ui.waitedMs, 300);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("rollover rejects changed owners, URLs, full controls, active generation, drafts or uncertain Send before clicking", async () => {
  for (const change of [
    () => ({ expectedOwnerTurnIds: ["stale-owner"] }),
    ui => { ui.url = "https://chatgpt.com/c/unrelated-conversation"; },
    ui => { ui.fullBanners = []; },
    ui => { ui.fullButtons.push({ text: "Start new chat" }); },
    ui => { ui.stop = true; },
    ui => { ui.composerText = "User draft"; },
    (ui, state) => { state.sendClicked = true; state.sendConfirmed = false; },
  ]) {
    const f = await recoverableFixture();
    showFullConversation(f.ui);
    const extra = change(f.ui, f.getState());
    await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url, ...extra }), /active browser cleanup|requires the exact owned full|uncertain Send/);
    assert.equal(f.ui.startNewChatClicks, 0);
    assert.equal(f.getState().needsHistory, undefined);
    assert.equal(f.getState().rolloverAttempted, undefined);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
  }
});

test("pending full-history continuation reconciles only its exact owned unsent draft and keeps history required", async () => {
  for (const changeDraft of [false, true]) {
    const f = await recoverableFixture();
    showFullConversation(f.ui);
    await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
    f.ui.sendEnabled = false;
    await assert.rejects(f.run("send", { ...plugin, prompt: "Full readable history", turnId: "next-turn" }), /nothing sent/);
    if (changeDraft) f.ui.composerText = "Changed user draft";
    const continuation = f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" });
    if (changeDraft) {
      await assert.rejects(continuation, /draft changed or became an attachment/);
      assert.equal(f.ui.composerText, "Changed user draft");
    } else {
      assert.equal((await continuation).needsHistory, true);
      assert.equal(f.ui.composerText, "");
      assert.equal(f.getState().sendAttempted, false);
    }
    assert.equal(f.getState().needsHistory, true);
    assert.equal(f.getState().rolloverAttempted, true);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.startNewChatClicks, 1);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("pending-history draft reconciliation cannot clear a draft after the tab leaves normal home", async () => {
  for (const change of [ui => { ui.url = "https://chatgpt.com/c/unrelated-conversation"; }, ui => { ui.temporary = true; }]) {
    const f = await recoverableFixture();
    showFullConversation(f.ui);
    await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
    f.ui.sendEnabled = false;
    await assert.rejects(f.run("send", { ...plugin, prompt: "Full readable history", turnId: "next-turn" }), /nothing sent/);
    const draft = f.ui.composerText;
    change(f.ui);
    await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" }), /not an idle normal home/);
    assert.equal(f.ui.composerText, draft);
    assert.equal(f.getState().needsHistory, true);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.startNewChatClicks, 1);
  }
});

test("a changed active owner during rollover retention cannot click or reclaim the newer turn", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  const owner = f.activeTurn();
  const handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { await handoff(); owner.turnId = "newer-turn"; };
  await assert.rejects(f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url }), /active browser cleanup/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.activeTurn().turnId, "newer-turn");
  assert.equal(f.ui.startNewChatClicks, 0);
  assert.equal(f.getState().rolloverAttempted, undefined);
});

test("uncertain first successor Send preserves history markers and blocks continuation", async () => {
  const f = await recoverableFixture();
  showFullConversation(f.ui);
  await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  f.ui.sendFailure = true;
  f.ui.onSend = () => { f.ui.url = "https://chatgpt.com/c/successor-conversation"; };
  await assert.rejects(f.run("send", { ...plugin, prompt: "Full readable history", turnId: "next-turn" }), /effect uncertain/);
  await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" }), /preceding Send is uncertain/);
  assert.equal(f.getState().needsHistory, true);
  assert.equal(f.getState().rolloverAttempted, true);
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.startNewChatClicks, 1);
});

test("pending successor never recovers a lost kernel, overwrites a draft or accepts a caller flag without its state", async () => {
  const f = await recoverableFixture();
  await assert.rejects(f.run("continue", { turnId: "next-turn", needsHistory: true }), /successor binding is unavailable/);
  showFullConversation(f.ui);
  await f.run("rollover", { turnId: "next-turn", previousChatUrl: f.recovery.url });
  f.ui.composerText = "Unrelated draft";
  await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true, interruptedTurnId: "next-turn" }), /not a proven empty normal home/);
  assert.equal(f.ui.composerText, "Unrelated draft");
  f.loseBinding();
  await assert.rejects(f.run("continue", { turnId: "following-turn", needsHistory: true }), /browser binding was lost/);
  await assert.rejects(f.run("rollover", { turnId: "following-turn", previousChatUrl: f.recovery.url }), /browser binding was lost/);
  assert.throws(() => browserScript({ ...base, operation: "continue", expectedOwnerTurnIds: [base.turnId], needsHistory: true,
    runtimeModule: f.runtimeModule, recovery: f.recovery }), /without recovery/);
  assert.equal(f.ui.startNewChatClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("permanently disabled Send ends its bounded wait without typing or sending again", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.sendEnabled = false;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Paste that never becomes ready" }), /within 10 seconds/);
  assert.equal(f.ui.waitedMs, 10000);
  assert.equal(f.ui.typed.length, 1);
  assert.equal(f.ui.sendClicks, 0);
  f.ui.sendEnabled = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "No automatic retry" }), /cannot be replayed/);
  assert.equal(f.ui.typed.length, 1);
});

test("readiness cannot permit Send after the app chip or idle normal chat state changes", async () => {
  for (const change of [ui => { ui.chip = false; }, ui => { ui.temporary = true; }, ui => { ui.stop = true; }]) {
    const f = fixture({ fastTimers: true });
    await f.ready();
    f.ui.sendEnabled = false;
    f.ui.onWait = () => { f.ui.sendEnabled = true; change(f.ui); };
    await assert.rejects(f.run("send", { ...plugin, prompt: "Wait for the paste" }), /nothing sent/);
    assert.equal(f.ui.typed.length, 1);
    assert.equal(f.ui.sendClicks, 0);
  }
});

test("observations require a fresh assistant reply and continuation retains exact tab ownership", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts.push("Previous completed answer");
  await f.run("send", { ...plugin, prompt: "Next request" });
  assert.equal(f.ui.url, "https://chatgpt.com/c/owned-conversation");
  f.ui.complete = true;
  assert.equal((await f.run("observe")).completed, false);
  await assert.rejects(f.run("retain"), /successfully completed/);
  f.ui.texts.push("Fresh final answer");
  f.ui.stop = true;
  assert.equal((await f.run("observe")).completed, false);
  f.ui.stop = false;
  const result = await f.run("observe");
  assert.equal(result.assistantText, "Fresh final answer");
  assert.equal(result.completed, true);
  assert.equal(f.activeTurn()?.turnId, base.turnId, "Completion retains the exact owner for the next native handoff.");
  await f.run("retain");
  assert.equal(f.ui.handoffs, 3);
  assert.equal(f.activeTurn()?.turnId, base.turnId);
  const next = await f.run("continue", { tabId: "owned-tab", turnId: "following-turn" });
  assert.equal(next.assistantText, "Fresh final answer", "Completed continuation supplies the visible reply for native delta history.");
  assert.deepEqual(f.activeTurn(), { turnId: "following-turn", state: f.getState(), stopButtonName: "Stop" });
  const active = f.activeTurn();
  f.ui.stop = true;
  await assert.rejects(f.run("continue", { turnId: "stale-turn", interruptedTurnId: base.turnId, expectedOwnerTurnIds: [base.turnId] }), /active.*turn|turn.*active/i);
  assert.equal(f.ui.stop, true, "A stale turn cannot stop the current generation.");
  assert.equal(f.ui.closeCount, 0, "A stale turn cannot close the continued turn's tab.");
  assert.equal(f.activeTurn(), active);
  f.ui.stop = false;
  await f.run("send", { ...plugin, prompt: "Following turn", turnId: "following-turn" });
  assert.equal((await f.run("observe", { turnId: "following-turn" })).completed, false);
  assert.equal(f.ui.newTabs, 1);
});

test("recovery-eligible continuation preserves its existing owned state across fresh execution scopes", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push("Observed completed reply"); f.ui.complete = true;
  const observed = await f.run("observe");
  await f.run("retain");
  const state = f.getState();
  const continued = await f.run("continue", { turnId: "following-turn", tabId: "owned-tab", runtimeModule: "must-not-import-recovery.mjs",
    recovery: { tabId: "owned-tab", url: observed.url,
      baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
      generationTurnKey: observed.generationTurnKey, generationReplyIds: observed.generationReplyIds,
    assistantPrefix: assistantPrefix(observed.assistantText), completed: observed.completed } });
  assert.equal(f.getState(), state);
  assert.equal(f.activeTurn().state, state);
  assert.equal(f.activeTurn().turnId, "following-turn");
  assert.equal(continued.recovered, undefined, "A present binding must not enter lost-kernel recovery.");
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  assert.equal(f.ui.sendClicks, 1);
});

test("a new message identity completes after mounted replies shrink below the Send baseline, including repeated answer text", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts = Array(6).fill("Repeated answer");
  const sent = await f.run("send", { ...plugin, prompt: "Repeat the answer" });
  assert.deepEqual(sent.baselineReplyIds, Array.from({ length: 6 }, (_, index) => messageId(index)));
  f.ui.texts = Array(5).fill("Repeated answer"); f.ui.stop = true;
  const pending = await f.run("observe");
  assert.deepEqual([pending.replyId, pending.assistantText, pending.completed], [null, "", false]);
  f.ui.replyIds = [0, 1, 2, 3, 6].map(messageId); f.ui.stop = false; f.ui.complete = true;
  const completed = await f.run("observe");
  assert.deepEqual([completed.replyId, completed.assistantText, completed.completed], [messageId(6), "Repeated answer", true]);
  await f.run("retain");
  assert.equal(f.ui.sendClicks, 1);
});

test("fragmented markdown in one message completes once with the full prose and literal code", async () => {
  const f = fixture(); await f.ready();
  const earlier = [domElement("div", {}, domText("Earlier reply")), domElement("div", {}, domText("Earlier tail"))];
  domElement("div", { "data-chatgpt-selection-message-id": messageId(0) }, ...earlier);
  f.ui.replyElements = [...earlier];
  const sent = await f.run("send", { ...plugin, prompt: "Return prose and code" });
  assert.deepEqual(sent.baselineReplyIds, [messageId(0)]);
  const source = "  first\n\n    last\n";
  const fragments = [domElement("div", {}, domElement("p", {}, domText("Before."))),
    domElement("div", {}, sourceBlock(source)), domElement("div", {}, domElement("p", {}, domText("After.")))];
  domElement("div", { "data-chatgpt-selection-message-id": messageId(1) }, ...fragments);
  f.ui.replyElements.push(...fragments); f.ui.complete = true;
  const observed = await f.run("observe");
  assert.deepEqual([observed.replyId, observed.completed], [messageId(1), true]);
  assert.equal(observed.assistantText, `Before.\n\n${source}\n\nAfter.`);
  assert.equal(observed.replyUnavailableReason, undefined);
  await f.run("retain");
  assert.equal(f.getState().retained, true);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("orphan markdown widgets before and after saved messages do not enter the Send baseline or current answer", async () => {
  const f = fixture(); await f.ready();
  const widget = text => {
    const node = domElement("div", {}, domText(text));
    domElement("span", {}, domElement("span", {}, node));
    return node;
  };
  f.ui.texts.push("Earlier answer");
  f.ui.orphanMarkdownBefore = [widget("Tool widget before the message")];
  f.ui.orphanMarkdownAfter = [widget("Tool widget after the message")];
  const sent = await f.run("send", { ...plugin, prompt: "Read the actual message" });
  assert.deepEqual(sent.baselineReplyIds, [messageId(0)]);
  f.ui.texts.push("The exact final answer."); f.ui.complete = true;
  const observed = await f.run("observe");
  assert.deepEqual([observed.completed, observed.replyId, observed.assistantText], [true, messageId(1), "The exact final answer."]);
  await f.run("retain");
  const continued = await f.run("continue", { turnId: "next-turn" });
  assert.equal(continued.assistantText, "The exact final answer.");
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("one Send permits a later assistant message identity while retaining all generation-owned identities", async () => {
  const f = fixture(); await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push("Same partial text"); f.ui.stop = true;
  const first = await f.run("observe");
  assert.equal(first.replyId, messageId(0));
  f.ui.replyIds = [null];
  assert.equal((await f.run("observe")).replyId, null);
  f.ui.replyIds = [messageId(1)]; f.ui.stop = false; f.ui.complete = true;
  const replacement = await f.run("observe");
  assert.deepEqual([replacement.replyId, replacement.assistantText, replacement.completed], [messageId(1), "Same partial text", true]);
  assert.deepEqual(replacement.generationReplyIds, [messageId(0), messageId(1)]);
  f.ui.replyIds = [messageId(0)];
  assert.equal((await f.run("observe")).completed, true);
  assert.equal(f.ui.sendClicks, 1);
});

test("one prompt-owned generation spans commentary, multiple tools and a different final message", async () => {
  const f = fixture(); await f.ready();
  const sent = await f.run('send', { ...plugin, prompt: 'Use turn_token fresh_token_123 unchanged. Request' });
  const key = sent.generationTurnKey;
  const commentary = assistantMessage(20, 'I will inspect the file.');
  const firstStatus = domElement('div', { 'data-streaming-response-status': 'true' });
  f.ui.messageRoot = domElement('main', {}, observedTurn(key, 'Request', [commentary, firstStatus], { complete: false }));
  f.ui.stop = true;
  const beforeTool = await f.run('observe');
  assert.deepEqual([beforeTool.replyId, beforeTool.assistantText, beforeTool.completed], [messageId(20), '', false]);
  const middle = assistantMessage(21, 'The measured result is 4.');
  const secondStatus = domElement('div', { 'data-streaming-response-status': 'true' });
  const final = assistantMessage(22, 'Verified final result: 4.');
  const reasoning = domElement('div', { 'data-testid': 'cot-v5-summary' }, assistantMessage(23, 'Private reasoning is not the answer.'));
  f.ui.messageRoot = domElement('main', {}, observedTurn(key, 'Request', [commentary, firstStatus, middle, secondStatus, final, reasoning]));
  f.ui.stop = false; f.ui.complete = true;
  const completed = await f.run('observe');
  assert.deepEqual([completed.replyId, completed.assistantText, completed.completed], [messageId(22), 'Verified final result: 4.', true]);
  assert.deepEqual(completed.generationReplyIds, [20, 21, 22, 23].map(messageId));
  const retained = await f.run('retain');
  assert.equal(retained.assistantText, completed.assistantText);
  await f.run('continue', { turnId: 'following-turn' });
  assert.deepEqual(f.getState().baselineReplyIds, [20, 21, 22, 23].map(messageId));
  assert.equal(f.ui.sendClicks, 1);
});

test("the first status boundary preserves an answer chunk between later tool statuses", async () => {
  const f = fixture(); await f.ready();
  const sent = await f.run('send', { ...plugin, prompt: 'Request' });
  f.ui.messageRoot = domElement('main', {}, observedTurn(sent.generationTurnKey, 'Request', [
    assistantMessage(20, 'Prior commentary'), domElement('div', { 'data-streaming-response-status': 'true' }),
    assistantMessage(21, 'Answer between two tool calls.'), domElement('div', { 'data-streaming-response-status': 'true' }),
  ]));
  f.ui.complete = true;
  const observed = await f.run('observe');
  assert.deepEqual([observed.replyId, observed.assistantText, observed.completed], [messageId(21), 'Answer between two tool calls.', true]);
});

test("an unseen old reply remount cannot become a current answer and old controls cannot complete it", async () => {
  const f = fixture(); await f.ready();
  const sent = await f.run('send', { ...plugin, prompt: 'Current unique request' });
  f.ui.messageRoot = domElement('main', {}, observedTurn(messageId(700), 'Old request', [assistantMessage(99, 'Old answer remounted')]),
    observedTurn(sent.generationTurnKey, 'Current unique request', [], { complete: false }));
  f.ui.complete = true;
  const observed = await f.run('observe');
  assert.deepEqual([observed.replyId, observed.assistantText, observed.completed, observed.statusComplete], [null, '', false, false]);
  assert.equal(observed.replyUnavailableReason, 'no-new-message');
  assert.deepEqual(observed.generationReplyIds, []);
});

test("an invalid historical identity still blocks a valid current answer during scoped observation", async () => {
  for (const [identity, reason] of [[null, "missing-message-identity"], ["invalid", "invalid-message-identity"],
    [messageId(20), "duplicate-message-identity"]]) {
    const f = fixture(); await f.ready();
    const sent = await f.run("send", { ...plugin, prompt: "Current request" });
    const historical = assistantMessage(10, "Old answer");
    historical.setAttribute("data-chatgpt-selection-message-id", identity);
    f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(100), "Old request", [historical]),
      observedTurn(sent.generationTurnKey, "Current request", [assistantMessage(20, "Current final answer")]));
    f.ui.complete = true;
    const observed = await f.run("observe");
    assert.deepEqual([observed.assistantText, observed.replyId, observed.completed], ["", null, false]);
    assert.equal(observed.replyUnavailableReason, reason);
    await assert.rejects(f.run("retain"), /successfully completed/);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a duplicate generation key or a later foreign turn cannot supply the final answer", async () => {
  for (const duplicate of [true, false]) {
    const f = fixture(); await f.ready();
    const sent = await f.run('send', { ...plugin, prompt: 'Request' });
    f.ui.messageRoot = domElement('main', {}, observedTurn(sent.generationTurnKey, 'Request', [assistantMessage(10, 'Owned answer')]),
      observedTurn(duplicate ? sent.generationTurnKey : messageId(701), 'Different request', [assistantMessage(11, 'Other answer')]));
    f.ui.complete = true;
    const observed = await f.run('observe');
    assert.deepEqual([observed.replyId, observed.assistantText, observed.completed], [null, '', false]);
    assert.equal(observed.replyUnavailableReason, duplicate ? 'duplicate-generation-turn' : 'generation-turn-not-latest');
  }
});

test("initial observation reconciles a missing turn or later blank placeholder only to the original unique latest generation", async () => {
  for (const initial of ["missing", "later blank"]) {
    const f = fixture(); await f.ready();
    const sent = await f.run("send", { ...plugin, prompt: "Current request" });
    const owned = () => observedTurn(sent.generationTurnKey, "Current request", [assistantMessage(20, "Owned answer")]);
    f.ui.messageRoot = initial === "missing" ? domElement("main", {})
      : domElement("main", {}, owned(), observedTurn("rendering-placeholder", "", [], { complete: false }));
    const composer = f.ui.composerText = "Keep this private draft";
    const typed = [...f.ui.typed], reads = f.ui.observationReads;
    const locate = f.tab.playwright.locator;
    f.tab.playwright.locator = selector => {
      const locator = locate(selector);
      if (selector.startsWith("xpath=//body[count(")) {
        const wait = locator.waitFor.bind(locator);
        locator.waitFor = async options => { assert.deepEqual(options, { state: "visible", timeoutMs: 3000 }); return wait(options); };
      }
      return locator;
    };
    f.ui.onStopWait = () => {
      assert.equal(f.ui.sendClicks, 1);
      assert.deepEqual(f.getState().generationReplyIds, [], "No answer is adopted from the unowned first view.");
      f.ui.messageRoot = domElement("main", {}, owned());
    };
    const observed = await f.run("observe", { inputAcknowledgementPending: true });
    assert.deepEqual([observed.assistantText, observed.completed, observed.generationTurnKey], ["Owned answer", true, sent.generationTurnKey]);
    assert.deepEqual(observed.initialOwnershipDiagnostic, { anchorCount: Number(initial === "later blank"),
      turnCount: initial === "missing" ? 0 : 2, latestMatches: false });
    assert.equal(f.ui.observationReads - reads, 2, "Readiness is followed by one fresh coherent reply read.");
    assert.equal(f.ui.stopWaits, 1);
    assert.equal(f.getState().generationTurnKey, sent.generationTurnKey);
    assert.equal(f.ui.composerText, composer); assert.deepEqual(f.ui.typed, typed);
    assert.equal(f.ui.sendClicks, 1); assert.equal(f.ui.stopClicks, 0);
    assert.doesNotMatch(JSON.stringify(observed.initialOwnershipDiagnostic), /private|answer|[a-f0-9]{8}-/iu);
  }
});

test("initial ownership reconciliation cannot accept duplicates, permanent replacement, a later request or a readiness race", async () => {
  for (const loss of ["duplicate", "replacement", "later request", "later blank UUID", "readiness race"]) {
    const f = fixture(); await f.ready();
    const sent = await f.run("send", { ...plugin, prompt: "Current request" });
    const owned = () => observedTurn(sent.generationTurnKey, "Current request", [assistantMessage(20, "Owned answer")]);
    const foreign = () => observedTurn(messageId(701), "Manual user request", [assistantMessage(21, "Foreign answer")]);
    f.ui.messageRoot = loss === "duplicate" ? domElement("main", {}, owned(), owned())
      : loss === "replacement" ? domElement("main", {}, foreign())
        : loss === "later request" ? domElement("main", {}, owned(), foreign())
          : loss === "later blank UUID" ? domElement("main", {}, owned(), observedTurn(messageId(701), "", [], { complete: false })) : domElement("main", {});
    const typed = [...f.ui.typed], composer = f.ui.composerText;
    f.ui.onStopWait = () => {
      if (loss !== "replacement") f.ui.messageRoot = domElement("main", {}, owned());
      else throw new Error("Error: Playwright selector deadline exceeded\nlocator.waitFor(visible) timed out");
    };
    f.ui.onReplyRead = () => {
      if (loss === "readiness race" && f.ui.stopWaits) f.ui.messageRoot = domElement("main", {}, foreign());
    };
    const observed = await f.run("observe", { inputAcknowledgementPending: true });
    assert.equal(observed.replyUnavailableReason, loss === "duplicate" ? "duplicate-generation-turn" : "generation-turn-not-latest");
    assert.deepEqual([observed.replyId, observed.assistantText, observed.completed, observed.generationReplyIds], [null, "", false, []]);
    assert.equal(f.ui.stopWaits, Number(["replacement", "readiness race"].includes(loss)), "Duplicate ownership and a settled later identity are rejected without waiting.");
    assert.equal(typeof observed.initialOwnershipDiagnostic, "object");
    assert.equal(f.getState().generationTurnKey, sent.generationTurnKey);
    assert.equal(f.ui.composerText, composer); assert.deepEqual(f.ui.typed, typed);
    await assert.rejects(f.run("send", { ...plugin, prompt: "Do not replay" }), /cannot be replayed/u);
    assert.equal(f.ui.sendClicks, 1); assert.equal(f.ui.stopClicks, 0);
  }
});

test("pending-acceptance renewal never starts a late ownership wait and retains the first snapshot diagnostic", async () => {
  const f = fixture(); await f.ready();
  const sent = await f.run("send", { ...plugin, prompt: "Current request" });
  f.ui.messageRoot = domElement("main", {}, observedTurn(sent.generationTurnKey, "Current request", [], { complete: false }));
  f.ui.onReplyRead = () => {
    assert.equal(f.getState().initialGenerationObservation.generationTurnKey, sent.generationTurnKey,
      "The generation is marked observed before the first native page read.");
  };
  const first = await f.run("observe", { inputAcknowledgementPending: true });
  assert.equal(first.replyUnavailableReason, "no-new-message");
  assert.equal(first.initialOwnershipDiagnostic, undefined);
  f.ui.messageRoot = domElement("main", {});
  f.ui.onStopWait = () => { assert.fail("A later adapter read or renewal has no fresh ownership-wait budget."); };
  const later = await f.run("observe", { inputAcknowledgementPending: true });
  assert.equal(later.replyUnavailableReason, "generation-turn-not-latest");
  assert.deepEqual(later.initialOwnershipDiagnostic, { anchorCount: 1, turnCount: 1, latestMatches: true });
  assert.deepEqual([later.replyId, later.assistantText, later.completed], [null, "", false]);
  assert.equal(f.ui.stopWaits, 0); assert.equal(f.ui.sendClicks, 1);
});

test("ordinary post-acknowledgement observation never reconciles a missing generation", async () => {
  for (const inputAcknowledgementPending of [undefined, false]) {
    const f = fixture(); await f.ready();
    await f.run("send", { ...plugin, prompt: "Current request" });
    f.ui.messageRoot = domElement("main", {});
    f.ui.onStopWait = () => { assert.fail("A post-acknowledgement observation cannot wait for another ownership view."); };
    const observed = await f.run("observe", inputAcknowledgementPending === undefined ? {} : { inputAcknowledgementPending });
    assert.equal(observed.replyUnavailableReason, "generation-turn-not-latest");
    assert.equal(observed.initialOwnershipDiagnostic, undefined);
    assert.equal(f.ui.stopWaits, 0); assert.equal(f.ui.sendClicks, 1);
  }
});

test("initial ownership readiness preserves native errors, cancellation, URL and exact-owner guards without another Send", async () => {
  for (const change of ["native error", "native cancellation", "native owner", "URL", "generation key"]) {
    const f = fixture(); await f.ready();
    const sent = await f.run("send", { ...plugin, prompt: "Current request" });
    f.ui.messageRoot = domElement("main", {});
    const typed = [...f.ui.typed], composer = f.ui.composerText;
    f.ui.onStopWait = () => {
      if (change === "native error") throw new Error("Native selector execution failed.");
      if (change === "native cancellation") throw Object.assign(new Error("Native operation aborted."), { name: "AbortError" });
      f.ui.messageRoot = domElement("main", {}, observedTurn(sent.generationTurnKey, "Current request", [assistantMessage(20, "Owned answer")]));
      if (change === "native owner") f.activeTurn().turnId = "foreign-turn";
      if (change === "URL") f.ui.url = "https://chatgpt.com/c/another-conversation";
      if (change === "generation key") f.getState().generationTurnKey = messageId(999);
    };
    await assert.rejects(f.run("observe", { inputAcknowledgementPending: true }), /Native selector execution failed|Native operation aborted|different native turn|normal saved URL|generation changed/u);
    assert.equal(f.ui.stopWaits, 1);
    assert.deepEqual(f.getState().generationReplyIds, []);
    assert.equal(f.ui.composerText, composer); assert.deepEqual(f.ui.typed, typed);
    assert.equal(f.ui.sendClicks, 1); assert.equal(f.ui.stopClicks, 0);
  }
});

test("Send cannot confirm an old remounted turn without this turn's short marker or replay its uncertain effect", async () => {
  const f = fixture({ fastTimers: true }); await f.ready();
  f.ui.onSend = () => { f.ui.messageRoot = domElement('main', {}, observedTurn(messageId(700), 'Use turn_token previous_token unchanged. Request', [assistantMessage(99, 'Old answer')])); };
  await assert.rejects(f.run('send', { ...plugin, prompt: 'Use turn_token fresh_token unchanged. Request' }), /unique prompt-owned turn/);
  assert.equal(f.getState().sendConfirmed, false);
  await assert.rejects(f.run('send', { ...plugin, prompt: 'Use turn_token fresh_token unchanged. Request' }), /already attempted/);
  assert.equal(f.ui.sendClicks, 1);
});

test("completion requires the owned action after the answer and retain reads the current generation again", async () => {
  const f = fixture(); await f.ready();
  const sent = await f.run('send', { ...plugin, prompt: 'Request' });
  f.ui.complete = true;
  f.ui.messageRoot = domElement('main', {}, observedTurn(sent.generationTurnKey, 'Request', [assistantMessage(20, 'Answer')], { actionFirst: true }));
  assert.equal((await f.run('observe')).completed, false);
  f.ui.messageRoot = domElement('main', {}, observedTurn(sent.generationTurnKey, 'Request', [assistantMessage(20, 'Answer')]));
  assert.equal((await f.run('observe')).completed, true);
  f.ui.messageRoot = domElement('main', {}, observedTurn(sent.generationTurnKey, 'Request', [assistantMessage(20, 'Answer'), assistantMessage(21, 'New final answer')]));
  const retained = await f.run('retain');
  assert.deepEqual([retained.replyId, retained.assistantText, retained.completed], [messageId(21), 'New final answer', true]);
});

test("interrupted anchored recovery stops the exact tab and accepts a later final identity with or without the partial mounted", async () => {
  for (const [partialMounted, retainedTabOnly] of [[true, true], [false, true], [true, false], [false, false]]) {
    const f = fixture(); await f.ready();
    const sent = await f.run('send', { ...plugin, prompt: 'Request' });
    const commentary = assistantMessage(20, 'Checking the file.');
    const status = domElement('div', { 'data-streaming-response-status': 'true' });
    const partial = assistantMessage(21, 'Partial final');
    f.ui.messageRoot = domElement('main', {}, observedTurn(sent.generationTurnKey, 'Request', [commentary, status, partial], { complete: false }));
    f.ui.stop = true;
    const observed = await f.run('observe');
    const recovery = { tabId: observed.tabId, url: observed.url,
      baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
      generationTurnKey: observed.generationTurnKey, generationReplyIds: observed.generationReplyIds,
      assistantPrefix: assistantPrefix(observed.assistantText), completed: false, ...(retainedTabOnly ? { retainedTabOnly: true } : {}) };
    f.loseBinding();
    f.ui.messageRoot = domElement('main', {}, observedTurn(sent.generationTurnKey, 'Request', [commentary, status,
      ...(partialMounted ? [partial] : []), assistantMessage(22, 'Later verified final')], { complete: false }));
    const continued = await f.run('continue', { turnId: 'following-turn', tabId: recovery.tabId,
      interruptedTurnId: base.turnId, recovery });
    assert.equal(continued.assistantText, 'Later verified final');
    assert.equal(f.ui.stopClicks, 1);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.getState().baselineReplyIds, [20, 21, 22].map(messageId));
    assert.equal(f.activeTurn().turnId, 'following-turn');
  }
});

test("an interrupted confirmed generation without a reply restores its saved URL after restart or tab closure without replaying Send", async () => {
  for (const loss of ["restart-home", "restart-closed", "closed"]) for (const answerMounted of [false, true]) {
    const f = await interruptedBeforeReplyFixture();
    if (loss.startsWith("restart")) f.loseBinding();
    if (loss === "restart-home") {
      Object.assign(f.ui, { url: "https://chatgpt.com/", texts: [] });
      delete f.ui.messageRoot;
    } else f.ui.present = false;
    f.ui.onGoto = url => {
      assert.equal(url, f.recovery.url);
      f.ui.texts = ["Earlier answer", ...(answerMounted ? ["Answer mounted after restart"] : [])];
      f.ui.messageRoot = f.rendered(answerMounted ? [assistantMessage(20, "Answer mounted after restart")] : []);
    };
    const continued = await f.run("continue", { turnId: "following-turn", tabId: f.recovery.tabId,
      interruptedTurnId: base.turnId, recovery: f.recovery });
    assert.equal(continued.recovered, true);
    assert.equal(continued.url, f.recovery.url);
    assert.equal(continued.assistantText, answerMounted ? "Answer mounted after restart" : "");
    assert.deepEqual(f.getState().baselineReplyIds, [0, ...(answerMounted ? [20] : [])].map(messageId));
    assert.equal(f.ui.newTabs, loss === "restart-home" ? 1 : 2);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
    assert.equal(f.ui.sendClicks, 1, "Restoring the interrupted generation cannot replay its confirmed Send.");
    delete f.ui.messageRoot;
    const next = await f.run("send", { ...plugin, turnId: "following-turn", prompt: "New follow-up request" });
    assert.equal(next.sent, true);
    assert.equal(next.url, f.recovery.url);
    assert.equal(f.ui.sendClicks, 2);
    assert.equal(f.ui.typed.filter(text => text.includes("Interrupted request")).length, 1);
  }
});

test("saved URL restoration without a reply requires one latest confirmed generation and valid mounted message identities", async () => {
  for (const invalid of ["missing", "mismatched", "duplicate", "later-turn", "duplicate-message"]) {
    const f = await interruptedBeforeReplyFixture();
    f.loseBinding();
    f.ui.present = false;
    f.ui.onGoto = () => {
      const key = f.recovery.generationTurnKey;
      const turn = () => observedTurn(key, "Interrupted request", [], { complete: false });
      f.ui.messageRoot = invalid === "missing" ? domElement("main", {})
        : invalid === "mismatched" ? domElement("main", {}, observedTurn(messageId(900), "Another request", [], { complete: false }))
          : invalid === "duplicate" ? domElement("main", {}, turn(), turn())
            : invalid === "later-turn" ? domElement("main", {}, turn(), observedTurn(messageId(900), "Later request", [], { complete: false }))
              : f.rendered([assistantMessage(20, "First message"), assistantMessage(20, "Duplicate identity")]);
    };
    await assert.rejects(f.run("continue", { turnId: "following-turn", tabId: f.recovery.tabId,
      interruptedTurnId: base.turnId, recovery: f.recovery }), /saved chat URL and reply did not become available/u);
    assert.equal(f.ui.stopClicks, 0, "An unverified restored generation cannot authorize another Stop.");
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.getState().bindingLost, true);
  }
});

test("anchored recovery before a reply cannot overwrite a different chat or a user draft", async () => {
  for (const invalid of ["different-chat", "home-draft", "saved-draft"]) {
    const f = await interruptedBeforeReplyFixture();
    f.loseBinding();
    if (invalid === "different-chat") f.ui.url = "https://chatgpt.com/c/another-conversation";
    else {
      f.ui.composerText = "User draft";
      if (invalid === "home-draft") {
        Object.assign(f.ui, { url: "https://chatgpt.com/", texts: [] });
        delete f.ui.messageRoot;
      }
    }
    await assert.rejects(f.run("continue", { turnId: "following-turn", tabId: f.recovery.tabId,
      interruptedTurnId: base.turnId, recovery: f.recovery }), /cannot overwrite it|reply or composer changed/u);
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("saved URL recovery rechecks ownership and the destination tab after retention before navigation", async () => {
  for (const [closed, change] of [[false, "owner"], [false, "chat"], [false, "draft"], [true, "owner"], [true, "chat"]]) {
    const f = await interruptedBeforeReplyFixture();
    f.loseBinding();
    if (closed) f.ui.present = false;
    else {
      Object.assign(f.ui, { url: "https://chatgpt.com/", texts: [] });
      delete f.ui.messageRoot;
    }
    const handoff = f.tab.markHandoff;
    f.tab.markHandoff = async () => {
      await handoff();
      if (change === "owner") f.activeTurn().turnId = "newer-turn";
      else {
        if (change === "chat") f.ui.url = "https://chatgpt.com/c/another-conversation";
        f.ui.composerText = "New user draft";
      }
    };
    f.ui.onGoto = () => { f.ui.messageRoot = f.rendered(); };
    await assert.rejects(f.run("continue", { turnId: "following-turn", tabId: f.recovery.tabId,
      interruptedTurnId: base.turnId, recovery: f.recovery }), change === "owner"
      ? /different native turn owns/u : /recovery tab changed before saved chat navigation/u);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"], "A changed recovery target cannot be navigated before its guard rejects.");
    if (change === "owner") assert.equal(f.activeTurn().turnId, "newer-turn");
    else {
      assert.equal(f.ui.composerText, "New user draft");
      assert.equal(f.ui.url, change === "chat" ? "https://chatgpt.com/c/another-conversation" : "https://chatgpt.com/");
    }
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("anchorless recovery proofs are rejected before acquiring or navigating browser state", async () => {
  const f = await interruptedBeforeReplyFixture();
  const recovery = { ...f.recovery };
  delete recovery.generationTurnKey;
  delete recovery.generationReplyIds;
  f.loseBinding();
  await assert.rejects(f.run("continue", { turnId: "following-turn", tabId: recovery.tabId,
    interruptedTurnId: base.turnId, recovery }), /confirmed owned chat/);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  assert.equal(f.ui.stopClicks, 0);
  assert.equal(f.ui.sendClicks, 1);
});

test("a proven reply unmounted before continuation remains old when it remounts after the next Send", async () => {
  const f = fixture(); await f.ready();
  await f.run("send", { ...plugin, prompt: "First request" });
  f.ui.texts.push("Prior completed answer"); f.ui.complete = true;
  await f.run("observe"); await f.run("retain");
  f.ui.texts = [];
  await f.run("continue", { turnId: "following-turn" });
  const sent = await f.run("send", { ...plugin, turnId: "following-turn", prompt: "Next request" });
  assert.deepEqual(sent.baselineReplyIds, [messageId(0)]);
  f.ui.texts.push("Prior completed answer");
  const old = await f.run("observe", { turnId: "following-turn" });
  assert.deepEqual([old.replyId, old.assistantText, old.completed], [null, "", false]);
  f.ui.texts.push("Current completed answer");
  const current = await f.run("observe", { turnId: "following-turn" });
  assert.deepEqual([current.replyId, current.assistantText, current.completed], [messageId(1), "Current completed answer", true]);
  assert.equal(f.ui.sendClicks, 2);
});

test("old, missing, duplicate or ambiguous reply identities cannot supply an answer even with completion controls", async () => {
  for (const [ids, reason] of [
    [[0, 1, 2], "no-new-message"], [[0, 1, null], "missing-message-identity"],
    [[0, 3, 3], "duplicate-message-identity"],
    [[3, 1, 2], "no-new-message"], [[0, 1, "invalid"], "invalid-message-identity"],
  ]) {
    const f = fixture(); await f.ready();
    f.ui.texts = ["Old one", "Old two", "Old three"];
    await f.run("send", { ...plugin, prompt: "New request" });
    f.ui.replyIds = ids.map(value => typeof value === "number" ? messageId(value) : value);
    f.ui.complete = true;
    const observed = await f.run("observe");
    assert.deepEqual([observed.replyId, observed.assistantText, observed.completed], [null, "", false]);
    assert.equal(observed.replyUnavailableReason, reason);
    await assert.rejects(f.run("retain"), /successfully completed/);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a missing or duplicate reply identity blocks Send before typing or clicking", async () => {
  for (const ids of [[messageId(0), messageId(0)], [messageId(0), null]]) {
    const f = fixture(); await f.ready();
    f.ui.texts = ["Earlier one", "Earlier two"]; f.ui.replyIds = ids;
    await assert.rejects(f.run("send", { ...plugin, prompt: "New request" }), /baseline.*identities/);
    assert.equal(f.ui.typed.length, 0); assert.equal(f.ui.sendClicks, 0);
  }
});

test("continuation reports one sanitized bounded identity diagnostic before another Send", async () => {
  for (const kind of ["missing-wrapper", "invalid-wrapper-id", "duplicate-wrapper-id"]) {
    const f = await recoverableFixture();
    const secret = "PRIVATE_TOKEN_path_https://private.invalid/value";
    const elements = Array.from({ length: 20 }, () => domElement("div", { "data-testid": secret }, domText(secret)));
    if (kind !== "missing-wrapper") for (const element of elements) domElement("div", {
      "data-chatgpt-selection-message-id": kind === "invalid-wrapper-id" ? secret : messageId(99), class: secret,
    }, element);
    f.ui.replyElements = elements;
    const owner = f.activeTurn();
    await assert.rejects(f.run("continue", { turnId: "next-turn", ...(kind === "missing-wrapper" ? { ui: { assistantFinalReplySelector: broadReplySelector } } : {}) }), error => {
      const marker = " ROUTER_WEB_REPLY_IDENTITY_DIAGNOSTIC ";
      assert.match(error.message, /^The retained conversation has missing or ambiguous assistant message identities\./u);
      const diagnostic = JSON.parse(error.message.split(marker)[1]);
      assert.equal(diagnostic.reason, kind);
      assert.equal(diagnostic.messageCount, 20);
      assert.equal(diagnostic[kind === "missing-wrapper" ? "missingWrapperCount" : kind === "invalid-wrapper-id" ? "invalidWrapperIdCount" : "duplicateWrapperCount"], 20);
      assert.ok(error.message.length < 4096);
      assert.doesNotMatch(error.message, /PRIVATE_TOKEN|private\.invalid|00000000-0000-4000/u);
      return true;
    });
    assert.equal(f.activeTurn(), owner);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("lost kernel globals restore the exact existing tab without reopening or navigation and verify a raw UTF8 reply prefix with UTF16 length", async () => {
  const nativeContext = {}, f = await recoverableFixture({ nativeContext });
  const originalState = f.getState(), originalTab = f.tab;
  for (const key of Object.keys(nativeContext)) delete nativeContext[key];
  assert.equal(f.getState(), undefined);
  assert.equal(f.activeTurn(), undefined);
  f.browser.browserId = "browser-after-restart";
  f.ui.texts[0] += "Later visible suffix";
  const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery: f.recovery });
  assert.equal(continued.normal, true);
  assert.equal(continued.recovered, true);
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, false);
  assert.equal(continued.tabNavigated, false);
  assert.equal(continued.tabId, f.recovery.tabId);
  assert.equal(continued.url, f.recovery.url);
  assert.equal(continued.assistantText, f.text + "Later visible suffix");
  assert.equal(f.getState().browser.browserId, "browser-after-restart");
  assert.notEqual(f.getState(), originalState);
  assert.equal(f.getState().tab, originalTab);
  assert.equal(f.activeTurn().turnId, "next-turn");
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.reloads, 0);
});

test("full-chat binding recovery reports browser effects only while the recovered tab identity survives retention", async () => {
  for (const changeDuringRetention of [false, true]) {
    const f = await recoverableFixture();
    f.loseBinding();
    showFullConversation(f.ui);
    const handoff = f.tab.markHandoff;
    let recoveryHandoffs = 0;
    f.tab.markHandoff = async () => {
      await handoff();
      if (++recoveryHandoffs === 2 && changeDuringRetention) f.ui.tabId = "changed-tab";
    };
    const continuation = f.run("continue", { turnId: "next-turn", recovery: f.recovery });
    if (changeDuringRetention) await assert.rejects(continuation, /tab identity changed during recovery/u);
    else {
      const continued = await continuation;
      assert.equal(continued.conversationFull, true);
      assert.equal(continued.bindingRestored, true);
      assert.equal(continued.tabReopened, false);
      assert.equal(continued.tabNavigated, false);
      assert.equal(continued.assistantText, f.text);
    }
    assert.equal(f.ui.newTabs, 1);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a stale completed predecessor reloads once, waits for its exact checkpoint and acquires ownership only after full verification", async () => {
  const f = await staleCompletedCheckpointFixture(), order = [];
  f.ui.onReplyRead = () => order.push("snapshot");
  f.ui.onControlRead = ({ name, method }) => {
    if (name === "Stop" && method === "isVisible") order.push("stop");
    if (name === browserIdleButtonExactName && method === "count") order.push("idle");
  };
  f.ui.onComposerRead = () => order.push("composer");
  f.ui.onReload = () => {
    order.push("reload");
    assert.equal(f.activeTurn(), undefined);
    assert.match(f.getState().recoveryReloadCheckpoint, /^[a-f0-9]{64}$/u);
  };
  f.ui.onAttachmentWait = ({ selector, timeoutMs }) => {
    order.push("attached");
    assert.equal(selector, `[data-chatgpt-selection-message-id="${f.recovery.replyId}"]`);
    assert.equal(timeoutMs, 10000);
    assert.equal(f.activeTurn(), undefined);
    f.ui.messageRoot = f.restored();
  };
  const handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { order.push("handoff"); assert.equal(f.activeTurn()?.turnId, "next-turn"); await handoff(); };
  const continued = await f.run("continue", { turnId: "next-turn", recovery: f.recovery });
  assert.equal(continued.recovered, true);
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, false);
  assert.equal(continued.tabNavigated, true, "Refreshing the same tab must disclose the recovery navigation.");
  assert.equal(continued.assistantText, f.text);
  assert.equal(continued.tabId, f.recovery.tabId);
  assert.equal(continued.url, f.recovery.url);
  assert.equal(f.getState().bindingLost, undefined);
  assert.equal(f.getState().recoveryReloadCheckpoint, undefined);
  assert.ok(f.getState().baselineReplyIds.includes(f.recovery.replyId));
  assert.equal(f.getState().sendAttempted, false);
  assert.equal(f.getState().sendConfirmed, false);
  assert.equal(f.ui.reloads, 1); assert.equal(f.ui.attachmentWaits, 1);
  assert.equal(f.ui.stopClicks, 0); assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1); assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  assert.deepEqual(order.slice(0, 8), ["snapshot", "snapshot", "stop", "idle", "composer", "reload", "attached", "snapshot"]);
  assert.ok(order.indexOf("handoff") > order.indexOf("attached"));
  assert.equal(f.ui.waitedMs, 0, "The checkpoint wait uses the locator event, without a timer/poll loop.");
});

test("recovery cannot refresh unknown replies, newer user activity, drafts, active generation or changed ownership", async () => {
  const foreign = { turnId: "foreign-owner", state: {} };
  for (const [scenario, configure] of [
    ["draft", f => { f.ui.composerText = "Private unsent draft"; }],
    ["visible generation", f => { f.ui.stop = true; }],
    ["Stop absent but idle control unavailable", f => { f.ui.idleButtonCount = 0; }],
    ["ambiguous visible idle controls", f => { f.ui.idleButtonCount = 2; }],
    ["unknown mounted reply", f => { f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(900), "Previous", [assistantMessage(99, "Unknown reply")])); }],
    ["earlier known baseline", f => { f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(900), "Previous", [assistantMessage(1, "Previous reply")])); }],
    ["newer user-only turn", f => { f.ui.messageRoot = domElement("main", {}, f.predecessor(), observedTurn(messageId(999), "New private user request", [], { complete: false })); }],
    ["checkpoint under changed turn identity", f => { f.ui.messageRoot = f.restored(f.text, messageId(777)); }],
    ["incomplete checkpoint", f => { f.recovery.completed = false; }],
    ["draft during fresh snapshot", f => { let reads = 0; f.ui.onReplyRead = () => { if (++reads === 2) f.ui.composerText = "New private draft"; }; }],
    ["newer user during fresh snapshot", f => { let reads = 0; f.ui.onReplyRead = () => { if (++reads === 2) f.ui.messageRoot = domElement("main", {}, f.predecessor(), observedTurn(messageId(999), "New request")); }; }],
    ["changed URL during fresh snapshot", f => { let reads = 0; f.ui.onReplyRead = () => { if (++reads === 2) f.ui.url = "https://chatgpt.com/c/foreign"; }; }],
    ["changed owner during composer read", f => { f.ui.onComposerRead = () => { f.nativeContext.routerWebActiveTurns.set(base.sessionId, foreign); }; }],
  ]) {
    const f = await staleCompletedCheckpointFixture();
    configure(f);
    const handoffs = f.ui.handoffs;
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /recovery|refresh/iu, scenario);
    assert.equal(f.ui.reloads, 0, scenario); assert.equal(f.ui.attachmentWaits, 0, scenario);
    assert.equal(f.ui.stopClicks, 0); assert.equal(f.ui.sendClicks, 1); assert.equal(f.ui.handoffs, handoffs);
    assert.equal(f.getState().recoveryReloadCheckpoint, undefined);
    assert.equal(f.activeTurn(), scenario === "changed owner during composer read" ? foreign : undefined);
  }
});

test("failed refresh never accepts changed checkpoint proof or repeats reload, and a late verified checkpoint can recover without another reload", async () => {
  for (const [scenario, afterReload, expected] of [
    ["missing attachment", () => {}, /did not attach within 10 seconds/u],
    ["reload failure", f => { f.ui.reloadFailure = true; }, /reload failed/u],
    ["changed prefix", f => { f.ui.onAttachmentWait = () => { f.ui.messageRoot = f.restored(`Changed ${f.text}`); }; }, /reply-prefix-mismatch/u],
    ["changed generation identity", f => { f.ui.onAttachmentWait = () => { f.ui.messageRoot = f.restored(f.text, messageId(777)); }; }, /generation-turn-not-unique/u],
    ["new user turn after checkpoint", f => { f.ui.onAttachmentWait = () => { f.ui.messageRoot = domElement("main", {}, f.restored(), observedTurn(messageId(999), "New user request")); }; }, /generation-turn-not-latest/u],
    ["draft after refresh", f => { f.ui.onAttachmentWait = () => { f.ui.messageRoot = f.restored(); f.ui.composerText = "Private draft"; }; }, /composer changed|reply or composer changed/u],
    ["active generation after refresh", f => { f.ui.onAttachmentWait = () => { f.ui.messageRoot = f.restored(); f.ui.stop = true; }; }, /generating after refresh/u],
    ["redirect after refresh", f => { f.ui.url = "https://chatgpt.com/c/foreign"; }, /left its saved URL after refresh/u],
  ]) {
    const f = await staleCompletedCheckpointFixture();
    f.ui.onReload = () => { assert.equal(f.activeTurn(), undefined); afterReload(f); };
    const handoffs = f.ui.handoffs;
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), expected, scenario);
    assert.equal(f.ui.reloads, 1, scenario); assert.equal(f.ui.handoffs, handoffs);
    assert.equal(f.activeTurn(), undefined);
    assert.match(f.getState().recoveryReloadCheckpoint, /^[a-f0-9]{64}$/u);
    assert.equal(f.ui.stopClicks, 0); assert.equal(f.ui.sendClicks, 1);
    f.ui.messageRoot = domElement("main", {}, f.predecessor()); f.ui.url = f.recovery.url;
    f.ui.stop = false; f.ui.composerText = "";
    await assert.rejects(f.run("continue", { turnId: "retry-turn", recovery: f.recovery }), /already refreshed/u);
    assert.equal(f.ui.reloads, 1);
    f.ui.messageRoot = f.restored();
    const continued = await f.run("continue", { turnId: "late-turn", recovery: f.recovery });
    assert.equal(continued.assistantText, f.text);
    assert.equal(continued.bindingRestored, true);
    assert.equal(continued.tabReopened, false);
    assert.equal(continued.tabNavigated, true, "A late successful checkpoint cannot erase the earlier recovery reload.");
    assert.equal(f.ui.reloads, 1);
    assert.equal(f.getState().recoveryReloadCheckpoint, undefined);
  }
});

test("saved URL reacquires one existing tab when its retained old ID is absent", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.ui.tabId = "current-saved-tab";
  const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery: f.recovery });
  assert.equal(continued.tabId, "current-saved-tab");
  assert.equal(continued.recovered, true);
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, true, "A different existing tab cannot claim restoration of the original tab.");
  assert.equal(continued.tabNavigated, false);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
});

test("a missing original tab reopens only its exact saved URL and registers retention before navigation", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.ui.present = false;
  f.ui.onGoto = url => {
    assert.equal(url, f.recovery.url);
    assert.equal(f.activeTurn()?.state.tab, f.tab);
    assert.equal(f.activeTurn()?.turnId, "next-turn");
    assert.equal(f.ui.handoffs, 4, "The newly owned tab is retained before navigation.");
    f.ui.texts = [f.text];
  };
  const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery: f.recovery });
  assert.equal(continued.tabId, "reopened-tab");
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, true);
  assert.equal(continued.tabNavigated, true);
  assert.equal(continued.assistantText, f.text);
  assert.equal(f.ui.newTabs, 2);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
  assert.equal(f.ui.sendClicks, 1);
});

test("allocating a new recovery tab reports reopening even if the runtime reuses the original tab ID", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.ui.present = false;
  const newTab = f.browser.tabs.new;
  f.browser.tabs.new = async () => { const tab = await newTab(); f.ui.tabId = f.recovery.tabId; return tab; };
  f.ui.onGoto = () => { f.ui.texts = [f.text]; };
  const continued = await f.run("continue", { turnId: "next-turn", recovery: f.recovery });
  assert.equal(continued.tabId, f.recovery.tabId);
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, true);
  assert.equal(continued.tabNavigated, true);
  assert.equal(f.ui.newTabs, 2);
  assert.equal(f.ui.sendClicks, 1);
});

test("binding recovery rejects a tab identity change during rendered proof before acquiring ownership", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.ui.onReplyRead = () => { f.ui.tabId = "changed-tab"; };
  const handoffs = f.ui.handoffs;
  await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /tab identity changed during recovery/u);
  assert.equal(f.activeTurn(), undefined);
  assert.equal(f.ui.handoffs, handoffs);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/"]);
  assert.equal(f.ui.sendClicks, 1);
});

test("a manually closed saved tab recovers the same retained JavaScript binding at its exact saved URL", async () => {
  const f = await recoverableFixture();
  const state = f.getState();
  const originalOwner = f.activeTurn();
  f.ui.present = false;
  f.ui.onGoto = url => {
    assert.equal(url, f.recovery.url);
    f.ui.texts = [f.text];
  };
  const continued = await f.run("continue", { turnId: "next-turn", tabId: "owned-tab", recovery: f.recovery });
  assert.equal(continued.recovered, true);
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, true);
  assert.equal(continued.tabNavigated, true);
  assert.equal(continued.tabId, "reopened-tab");
  assert.equal(continued.assistantText, f.text);
  assert.equal(continued.url, f.recovery.url);
  assert.equal(f.getState(), state, "Manual closure must preserve the retained binding object.");
  assert.equal(originalOwner.state, state);
  assert.equal(f.activeTurn().state, state);
  assert.equal(f.activeTurn().turnId, "next-turn");
  assert.equal(f.getState().bindingLost, undefined);
  assert.equal(f.ui.newTabs, 2);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
  assert.equal(f.ui.sendClicks, 1, "Reopening a closed tab never replays Send or creates another conversation.");
});

test("manual tab closure cannot recover with a stale owner, different saved URL or pending full-history successor", async () => {
  const f = await recoverableFixture();
  f.ui.present = false;
  await assert.rejects(f.run("continue", { turnId: "next-turn", expectedOwnerTurnIds: ["foreign-owner"], recovery: f.recovery }), /active browser cleanup/);
  await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: { ...f.recovery, url: "https://chatgpt.com/c/unrelated-conversation" } }), /differs from the owned saved conversation/);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  const pending = await recoverableFixture();
  showFullConversation(pending.ui);
  await pending.run("rollover", { turnId: "next-turn", previousChatUrl: pending.recovery.url });
  pending.ui.present = false;
  await assert.rejects(pending.run("continue", { turnId: "following-turn", recovery: pending.recovery }), /owned saved chat tab is unavailable/);
  assert.equal(pending.ui.newTabs, 1);
  assert.equal(pending.ui.startNewChatClicks, 1);
});

test("manual-tab recovery rechecks ownership before allocating a tab after browser discovery", async () => {
  const f = await recoverableFixture();
  f.ui.present = false;
  const owner = f.activeTurn();
  const list = f.agent.browsers.list;
  f.agent.browsers.list = async () => { const result = await list(); owner.turnId = "newer-turn"; return result; };
  await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /active browser cleanup/);
  assert.equal(f.activeTurn(), owner);
  assert.equal(f.activeTurn().turnId, "newer-turn");
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.navigations.length, 1);
  assert.equal(f.ui.sendClicks, 1);
});

test("a rejected existing saved-URL candidate never becomes the retained owner's cleanup target", async () => {
  for (const invalid of ["reply", "draft"]) {
    const f = await recoverableFixture();
    const originalTab = f.getState().tab;
    const originalOwner = f.activeTurn();
    const candidate = fixture();
    await candidate.ready();
    candidate.ui.tabId = "candidate-tab";
    candidate.ui.url = f.recovery.url;
    candidate.ui.texts = [invalid === "reply" ? "Corrupted reply" : f.text];
    candidate.ui.composerText = invalid === "draft" ? "Existing user draft" : "";
    f.ui.present = false;
    f.ui.extraTabs = [{ id: candidate.tab.id, url: f.recovery.url }];
    f.browser.tabs.get = async id => { assert.equal(id, candidate.tab.id); return candidate.tab; };
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /saved chat reply or composer changed/);
    assert.equal(f.getState().tab, originalTab);
    assert.equal(f.activeTurn(), originalOwner);
    assert.equal(f.activeTurn().state.tab, originalTab);
    candidate.ui.stop = true;
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /owned saved chat tab is unavailable/);
    assert.equal(candidate.ui.stopClicks, 0, "A failed proof cannot grant cleanup authority over its candidate.");
    assert.equal(candidate.ui.stop, true);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("reopening a virtualized saved chat captures its verified latest reply and preserves prior identities for the next Send", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.texts = Array.from({ length: 39 }, (_, index) => `Earlier mounted assistant reply ${index}`);
  await f.run("send", { ...plugin, prompt: "Initial request" });
  f.ui.texts.push("First verified assistant reply");
  f.ui.complete = true;
  await f.run("observe");
  await f.run("retain");
  await f.run("continue", { turnId: "second-turn" });
  await f.run("send", { ...plugin, prompt: "Latest request", turnId: "second-turn" });
  const latest = "Latest verified 🔧 assistant reply\n";
  f.ui.texts.push(latest);
  const observed = await f.run("observe", { turnId: "second-turn" });
  await f.run("retain", { turnId: "second-turn" });
  assert.deepEqual(observed.baselineReplyIds, Array.from({ length: 40 }, (_, index) => messageId(index)));
  assert.equal(observed.replyId, messageId(40));
  const recovery = { url: observed.url, tabId: observed.tabId,
    baselineReplyIds: observed.baselineReplyIds, replyId: observed.replyId,
    generationTurnKey: observed.generationTurnKey, generationReplyIds: observed.generationReplyIds,
    assistantPrefix: assistantPrefix(observed.assistantText), completed: observed.completed };
  f.loseBinding();
  f.ui.present = false;
  f.ui.onGoto = url => {
    assert.equal(url, recovery.url);
    f.ui.texts = ["Only one preceding reply remains mounted", latest];
    f.ui.replyIds = [messageId(39), observed.replyId];
  };
  const continued = await f.run("continue", { turnId: "third-turn", tabId: "owned-tab", recovery });
  assert.equal(continued.recovered, true);
  assert.equal(continued.assistantText, latest, "The latest saved reply remains available for native delta history despite a smaller mounted list.");
  assert.equal(f.ui.sendClicks, 2, "Recovery does not replay either prior Send.");
  const sent = await f.run("send", { ...plugin, prompt: "New delta only", turnId: "third-turn" });
  assert.deepEqual(sent.baselineReplyIds, Array.from({ length: 41 }, (_, index) => messageId(index)), "A new Send preserves prior proven identities after virtualization.");
  assert.equal(f.ui.sendClicks, 3);
  assert.equal(f.ui.newTabs, 2);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", recovery.url]);
});

test("the known tab may navigate from verified empty normal home to its exact saved conversation", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  f.ui.url = "https://chatgpt.com/";
  f.ui.texts = [];
  f.ui.onGoto = url => { assert.equal(url, f.recovery.url); f.ui.texts = [f.text]; };
  const continued = await f.run("continue", { turnId: "next-turn", recovery: f.recovery });
  assert.equal(continued.tabId, "owned-tab");
  assert.equal(continued.recovered, true);
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, false);
  assert.equal(continued.tabNavigated, true);
  assert.equal(f.ui.newTabs, 1);
  assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
});

test("recovery never overwrites unrelated conversations, drafts, noneditable content, foreign pages or sign-in pages", async () => {
  for (const change of [
    ui => { ui.url = "https://chatgpt.com/c/unrelated-conversation"; },
    ui => { ui.url = "https://chatgpt.com/"; ui.texts = []; ui.composerText = "My unsent draft"; },
    ui => { ui.url = "https://chatgpt.com/"; ui.texts = []; ui.stop = true; },
    ui => { ui.url = "https://chatgpt.com/"; ui.texts = []; ui.composerNode = domElement("div", { contenteditable: "true" }, domElement("span", { contenteditable: "false" })); },
    ui => { ui.url = "https://chatgpt.com/"; ui.texts = []; ui.composerNode = domElement("div", { contenteditable: "true" }, domElement("img", { src: "attachment" })); },
    ui => { ui.url = "https://elsewhere.test/"; },
    ui => { ui.url = "https://chatgpt.com/auth/login"; },
    ui => { ui.url = "about:blank"; },
  ]) {
    const f = await recoverableFixture();
    f.loseBinding();
    change(f.ui);
    const composer = f.ui.composerText;
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /cannot overwrite/);
    assert.equal(f.ui.composerText, composer);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.activeTurn(), undefined);
  }
});

test("saved-chat recovery rejects changed proof or composer with bounded private-data-free diagnostics and no later reads", async () => {
  const privateValue = "PRIVATE_RECOVERY_SECRET_https://private.invalid/token";
  const empty = () => domElement("div", { contenteditable: "true" });
  for (const [reason, change, expected] of [
    ["saved-url-changed", f => { let reads = 0; f.tab.url = async () => ++reads === 1 ? f.recovery.url : `https://chatgpt.com/c/${privateValue}`; },
      { urlMatches: false, temporaryInactive: null, replyCount: null }],
    ["temporary-mode-active", f => { f.ui.temporary = true; }, { temporaryInactive: false, replyCount: null }],
    ["invalid-reply-identities", f => { f.ui.replyIds = [privateValue]; }, { replyIdentitiesValid: false, generationTurnCount: null }],
    ["generation-turn-not-unique", f => { f.ui.userMessages = []; }, { generationTurnCount: 0, generationIsLatest: null }],
    ["generation-turn-not-unique", f => { f.ui.messageRoot = domElement("main", {},
      observedTurn(f.recovery.generationTurnKey, privateValue, [assistantMessage(0, f.text)]),
      observedTurn(f.recovery.generationTurnKey, privateValue, [assistantMessage(1, privateValue)])); },
      { generationTurnCount: 2, generationIsLatest: null }],
    ["generation-turn-not-latest", f => { f.ui.messageRoot = domElement("main", {},
      observedTurn(f.recovery.generationTurnKey, privateValue, [assistantMessage(0, f.text)]),
      observedTurn(messageId(999), privateValue)); }, { generationIsLatest: false, freshReplyCount: null }],
    ["expected-reply-mismatch", f => { f.ui.replyIds = [messageId(999)]; }, { expectedReplyMatches: false, prefixMatches: null }],
    ["expected-reply-mismatch", f => { f.ui.texts.push(privateValue); }, { expectedReplyMatches: false, prefixMatches: null }],
    ["reply-prefix-too-short", f => { f.ui.texts[0] = "x"; }, { prefixLongEnough: false, prefixMatches: null }],
    ["reply-prefix-mismatch", f => { f.ui.texts[0] = `changed ${privateValue}`; }, { prefixLongEnough: true, prefixMatches: false }],
    ["composer-unavailable", f => { f.ui.composerElements = []; }, { prefixMatches: true, composerCount: 0, composerEmpty: null }],
    ["composer-ambiguous", f => { f.ui.composerElements = [empty(), empty()]; }, { composerCount: 2, composerEmpty: null }],
    ["composer-shape-invalid", f => { f.ui.composerNode = domElement("textarea", { contenteditable: "true" }, domText(privateValue)); },
      { composerCount: 1, composerShapeValid: false, composerEmpty: false }],
    ["composer-shape-invalid", f => { f.ui.composerNode = domElement("div", { contenteditable: "true" }, domElement("img", { src: privateValue })); },
      { composerShapeValid: false, composerEmpty: false }],
    ["composer-draft-present", f => { f.ui.composerText = privateValue; }, { composerShapeValid: null, composerEmpty: false }],
  ]) {
    const f = await recoverableFixture({ text: privateValue });
    f.loseBinding();
    change(f);
    const composerReads = f.ui.composerReads, replyReads = f.ui.replyReads, actions = [...f.ui.actions], handoffs = f.ui.handoffs;
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), error => {
      const prefix = "The saved chat reply or composer changed; recovery cannot reuse it. ROUTER_WEB_RECOVERY_DIAGNOSTIC ";
      assert.ok(error.message.startsWith(prefix));
      const diagnostic = JSON.parse(error.message.slice(prefix.length));
      assert.equal(diagnostic.reason, reason);
      for (const [key, value] of Object.entries(expected)) assert.equal(diagnostic[key], value, `${reason}: ${key}`);
      for (const [key, value] of Object.entries(diagnostic)) {
        if (key !== "reason") assert.ok(value === null || typeof value === "boolean" || Number.isSafeInteger(value) && value >= 0 && value <= 10000);
      }
      assert.ok(error.message.length < 2048);
      assert.doesNotMatch(error.message, /PRIVATE_RECOVERY_SECRET|private\.invalid|https:\/\/|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu);
      for (const secret of [token, f.recovery.assistantPrefix.sha256, f.recovery.url]) assert.equal(error.message.includes(secret), false);
      if (!reason.startsWith("composer-")) assert.equal(diagnostic.composerCount, null, "A rejected reply proof cannot read the composer.");
      return true;
    });
    assert.equal(f.ui.composerReads - composerReads, Number(reason.startsWith("composer-")), "Recovery adds no composer reread.");
    assert.equal(f.ui.replyReads - replyReads, Number(!["saved-url-changed", "temporary-mode-active"].includes(reason)));
    assert.equal(f.ui.viewportReads, Number(reason === "generation-turn-not-unique"), "Only the rejected generation identity permits one viewport diagnostic read.");
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.navigations.length, 1);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.handoffs, handoffs);
    assert.deepEqual(f.ui.actions, actions);
    assert.equal(f.activeTurn(), undefined);
  }
});

test("retained interrupted recovery diagnoses missing and displaced fresh replies before reading the composer", async () => {
  for (const displaced of [false, true]) {
    const f = await interruptedBeforeReplyFixture();
    f.loseBinding();
    if (displaced) f.ui.messageRoot = domElement("main", {},
      observedTurn(f.recovery.generationTurnKey, "Private prompt", [assistantMessage(1, "Private reply")]), assistantMessage(2, "Private outside reply"));
    else f.recovery.assistantPrefix = assistantPrefix("Private expected reply");
    const composerReads = f.ui.composerReads;
    await assert.rejects(f.run("continue", { turnId: "next-turn", tabId: f.recovery.tabId,
      interruptedTurnId: base.turnId, recovery: f.recovery }), error => {
      const diagnostic = JSON.parse(error.message.split("ROUTER_WEB_RECOVERY_DIAGNOSTIC ")[1]);
      assert.equal(diagnostic.reason, displaced ? "fresh-reply-not-latest" : "missing-fresh-reply");
      assert.equal(diagnostic.freshReplyCount, Number(displaced));
      assert.equal(diagnostic.freshReplyIsLatest, displaced ? false : null);
      assert.equal(diagnostic.composerCount, null);
      return true;
    });
    assert.equal(f.ui.composerReads, composerReads);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.activeTurn(), undefined);
  }
});

test("a rejected generation checkpoint distinguishes changed turn identity, absent mounted reply and changed reply without accepting recovery", async () => {
  const privateValue = "PRIVATE_CHECKPOINT_TEXT_https://private.invalid/token";
  const viewport = (f, id, { top = 300, height = 1000, client = 400, documentTop = 0, invalid = false } = {}) => {
    const reply = replyElement(privateValue, id), wrapper = reply.parentElement;
    const scroll = domElement("div", { class: privateValue }, wrapper);
    Object.assign(scroll, { overflowY: "auto", scrollTop: top, scrollHeight: invalid ? NaN : height, clientHeight: client });
    const root = domElement("html", {}, domElement("body", {}, scroll));
    Object.assign(root, { parentElement: null, scrollTop: documentTop, scrollHeight: 2000, clientHeight: 800 });
    const document = { URL: f.recovery.url, scrollingElement: root, documentElement: root,
      defaultView: { getComputedStyle: element => ({ overflowY: element.overflowY ?? "visible" }) } };
    for (let element = reply; element; element = element.parentElement) Object.assign(element, { ownerDocument: document, isConnected: true });
    f.ui.viewportElements = [reply];
  };
  for (const [scenario, configure, expected] of [
    ["same latest reply under a different turn identity", f => {
      f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(777), privateValue, [assistantMessage(0, f.text)]));
      viewport(f, messageId(0), { top: 600, documentTop: 1200 });
    }, { checkpointReplyCount: 1, checkpointIsLatestReply: true, checkpointPrefixMatches: true,
      checkpointHasTurnIdentity: true, checkpointTurnCount: 1, checkpointTurnIsLatest: true,
      scrollHasAbove: true, scrollHasBelow: false, scrollAtEnd: true, documentAtEnd: true }],
    ["same latest reply text under different message and turn identities", f => {
      f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(777), privateValue, [assistantMessage(1, f.text)]));
      viewport(f, messageId(1));
    }, { checkpointReplyCount: 0, checkpointIsLatestReply: null, checkpointPrefixMatches: null,
      prefixMatchingReplyCount: 1, latestReplyPrefixMatches: true }],
    ["earlier mounted viewport omits the checkpoint", f => {
      f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(777), privateValue, [assistantMessage(1, `Different ${privateValue}`)]));
      viewport(f, messageId(1), { top: 0 });
    }, { checkpointReplyCount: 0, checkpointIsLatestReply: null, checkpointPrefixMatches: null, checkpointHasTurnIdentity: null,
      checkpointTurnCount: null, checkpointTurnIsLatest: null, scrollHasAbove: false, scrollHasBelow: true, scrollAtEnd: false,
      prefixMatchingReplyCount: 0, latestReplyPrefixMatches: false }],
    ["checkpoint content changed", f => {
      f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(777), privateValue, [assistantMessage(0, `Changed ${privateValue}`)]));
      viewport(f, messageId(0));
    }, { checkpointReplyCount: 1, checkpointIsLatestReply: true, checkpointPrefixLongEnough: true, checkpointPrefixMatches: false,
      checkpointTurnCount: 1, checkpointTurnIsLatest: true }],
    ["checkpoint still mounted before a newer reply", f => {
      f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(777), privateValue,
        [assistantMessage(0, f.text), assistantMessage(1, privateValue)]));
      viewport(f, messageId(1));
    }, { checkpointReplyCount: 1, checkpointIsLatestReply: false, checkpointPrefixMatches: true, checkpointTurnIsLatest: true }],
    ["checkpoint lacks a turn identity", f => {
      f.ui.messageRoot = domElement("main", {}, assistantMessage(0, f.text));
      viewport(f, messageId(0));
    }, { mountedTurnCount: 0, checkpointReplyCount: 1, checkpointHasTurnIdentity: false, checkpointTurnCount: null, checkpointTurnIsLatest: null }],
    ["viewport reply changed during the second read", f => {
      f.ui.userMessages = [];
      viewport(f, messageId(99));
    }, { viewportLastReplyMatches: false, scrollAncestorCount: null, scrollHasAbove: null, scrollHasBelow: null, documentAtEnd: null }],
    ["scroll geometry is unavailable", f => {
      f.ui.userMessages = [];
      viewport(f, messageId(0), { invalid: true });
    }, { viewportReadSucceeded: true, scrollUnknownCount: 1, scrollHasAbove: null, scrollHasBelow: null, scrollAtEnd: null }],
    ["viewport read fails", f => { f.ui.userMessages = []; f.ui.viewportError = new Error(privateValue); },
      { viewportReadSucceeded: false, viewportLastReplyMatches: null, scrollAncestorCount: null, scrollHasBelow: null }],
  ]) {
    const f = await recoverableFixture({ text: privateValue });
    configure(f);
    f.loseBinding();
    const composerReads = f.ui.composerReads, actions = [...f.ui.actions], handoffs = f.ui.handoffs;
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), error => {
      assert.ok(error.message.startsWith("The saved chat reply or composer changed; recovery cannot reuse it. ROUTER_WEB_RECOVERY_DIAGNOSTIC "));
      const diagnostic = JSON.parse(error.message.split("ROUTER_WEB_RECOVERY_DIAGNOSTIC ")[1]);
      assert.equal(diagnostic.reason, "generation-turn-not-unique");
      for (const [key, value] of Object.entries(expected)) assert.equal(diagnostic[key], value, `${scenario}: ${key}`);
      for (const key of ["generationIsLatest", "freshReplyCount", "expectedReplyMatches", "prefixLongEnough", "prefixMatches", "composerCount"]) assert.equal(diagnostic[key], null);
      for (const [key, value] of Object.entries(diagnostic)) if (key !== "reason") {
        assert.ok(value === null || typeof value === "boolean" || Number.isSafeInteger(value) && value >= 0 && value <= 10000);
      }
      assert.ok(error.message.length < 2048);
      assert.doesNotMatch(error.message, /PRIVATE_CHECKPOINT|private\.invalid|https:\/\/|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu);
      assert.equal(error.message.includes(f.recovery.assistantPrefix.sha256), false);
      return true;
    });
    assert.equal(f.ui.viewportReads, 1);
    assert.equal(f.ui.composerReads, composerReads);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.ui.handoffs, handoffs);
    assert.deepEqual(f.ui.actions, actions);
    assert.equal(f.activeTurn(), undefined);
  }
});

test("reopening deleted, inaccessible or redirected saved chats fails after one exact navigation without a fresh chat fallback", async () => {
  for (const redirect of [undefined, "https://chatgpt.com/auth/login", "https://signin.example.test/"]) {
    const f = await recoverableFixture();
    f.loseBinding();
    f.ui.present = false;
    f.ui.onGoto = () => { if (redirect) f.ui.url = redirect; };
    await assert.rejects(f.run("continue", { turnId: "next-turn", recovery: f.recovery }), /saved chat URL and reply did not become available/);
    assert.equal(f.ui.waitedMs, 10000);
    assert.equal(f.ui.newTabs, 2);
    assert.deepEqual(f.ui.navigations, ["https://chatgpt.com/", f.recovery.url]);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.closeCount, 0);
    await assert.rejects(f.run("continue", { turnId: "retry-turn", expectedOwnerTurnIds: [base.turnId, "next-turn"],
      interruptedTurnId: "next-turn", recovery: f.recovery }), /recovery did not finish verification/);
    assert.equal(f.ui.newTabs, 2, "A failed partial recovery cannot allocate another tab or bypass its failed proof.");
  }
});

test("recovery refuses a surviving active owner or ambiguous saved URL before creating or navigating tabs", async () => {
  const owned = await recoverableFixture();
  const previous = owned.activeTurn();
  owned.loseBinding({ preserveOwner: true });
  owned.agent.browsers.list = async () => { throw new Error("Recovery reached browser discovery despite an active owner"); };
  await assert.rejects(owned.run("continue", { turnId: "next-turn", recovery: owned.recovery }), /active browser recovery/);
  assert.equal(owned.activeTurn(), previous);
  assert.equal(owned.ui.newTabs, 1);
  const ambiguous = await recoverableFixture();
  ambiguous.loseBinding();
  ambiguous.ui.tabId = "current-saved-tab";
  ambiguous.ui.extraTabs = [{ id: "duplicate-saved-tab", url: ambiguous.recovery.url }];
  await assert.rejects(ambiguous.run("continue", { turnId: "next-turn", recovery: ambiguous.recovery }), /ambiguous/);
  assert.equal(ambiguous.ui.newTabs, 1);
  assert.equal(ambiguous.ui.navigations.length, 1);
});

test("interrupted recovery retains the exact saved chat before reconciliation Stop and never repeats Send", async () => {
  const nativeContext = {}, f = await recoverableFixture({ completed: false, nativeContext });
  for (const key of Object.keys(nativeContext)) delete nativeContext[key];
  f.ui.onStopRequest = () => {
    assert.equal(f.activeTurn()?.turnId, "next-turn");
    assert.equal(f.ui.handoffs, 4, "Recovery and continuation renew retention before reconciliation Stop.");
  };
  const continued = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, recovery: f.recovery });
  assert.equal(continued.assistantText, f.text);
  assert.equal(continued.interrupted, true);
  assert.equal(continued.recovered, true);
  assert.equal(continued.bindingRestored, true);
  assert.equal(continued.tabReopened, false);
  assert.equal(continued.tabNavigated, false);
  assert.equal(f.ui.stopClicks, 1);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("interrupted recovery revalidates the latest reply after Stop changes the mounted message list", async () => {
  for (const corruptLatest of [false, true]) {
    const f = await recoverableFixture({ completed: false });
    f.ui.texts = ["A preceding reply is initially mounted", f.text];
    f.ui.replyIds = [messageId(1), f.recovery.replyId];
    f.loseBinding();
    f.ui.onStopClick = () => {
      f.ui.texts = [corruptLatest ? "Changed latest reply" : f.text];
      f.ui.replyIds = [f.recovery.replyId];
    };
    const continuation = f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, recovery: f.recovery });
    if (corruptLatest) {
      await assert.rejects(continuation, /latest reply changed during continuation/);
      await assert.rejects(f.run("continue", { turnId: "retry-turn", interruptedTurnId: "next-turn",
        expectedOwnerTurnIds: [base.turnId, "next-turn"], recovery: f.recovery }), /recovery did not finish verification/);
    }
    else {
      const continued = await continuation;
      assert.equal(continued.assistantText, f.text, "A proven latest reply survives count shrink during Stop.");
      assert.equal(continued.recovered, true);
    }
    assert.equal(f.ui.stopClicks, 1);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("native observation returns the original projected source whitespace while testing nonempty content separately", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Return the formatted source." });
  const source = "  first\n\n    last\n";
  f.ui.texts.push(domElement("div", {}, sourceBlock(" \n")));
  f.ui.complete = true;
  assert.equal((await f.run("observe")).completed, false);
  f.ui.texts[0] = domElement("div", {}, sourceBlock(source));
  const result = await f.run("observe");
  assert.equal(result.completed, true);
  assert.equal(result.assistantText, source);
});

test("retained follow-up requires the exact saved URL and absence of Temporary Chat controls", async () => {
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "First request" });
  f.ui.texts.push("Completed first request"); f.ui.complete = true;
  await f.run("observe");
  await f.run("retain");
  const owner = f.activeTurn();
  assert.equal(owner?.turnId, base.turnId);
  await assert.rejects(f.run("continue", { sessionId: "foreign-session" }), /another native session/);
  assert.equal(f.activeTurn(), owner);
  f.ui.temporary = true;
  await assert.rejects(f.run("continue"), /not ready for continuation/, "A saved URL cannot authorize reuse with active temporary controls.");
  assert.equal(f.activeTurn(), owner, "A rejected continuation cannot replace the retained owner.");
  f.ui.temporary = false;
  f.ui.url = "https://chatgpt.com/c/other-conversation";
  await assert.rejects(f.run("continue"), /not ready for continuation/, "Another saved chat cannot qualify.");
  assert.equal(f.activeTurn(), owner);
  f.ui.url = "https://chatgpt.com/c/owned-conversation?temporary-chat=true";
  await assert.rejects(f.run("continue"), /not ready for continuation/, "A temporary URL cannot qualify.");
  f.ui.url = "https://chatgpt.com/c/owned-conversation";
  assert.equal((await f.run("continue")).normal, true);
  await f.run("send", { ...plugin, prompt: "Verified follow-up" });
  assert.equal(f.ui.sendClicks, 2);
});

test("warm continuation reads only its owned answer while retaining historical identity and current draft guards", async () => {
  for (const historicalIdentity of [messageId(0), null, messageId(1)]) {
    const f = fixture(); await f.ready();
    f.ui.texts = ["Earlier answer"];
    const sent = await f.run("send", { ...plugin, prompt: "Current request" });
    f.ui.texts.push("Owned current answer"); f.ui.complete = true;
    await f.run("observe"); await f.run("retain");
    const old = assistantMessage(0, "Earlier answer");
    old.setAttribute("data-chatgpt-selection-message-id", historicalIdentity);
    Object.defineProperty(old.querySelector(scopedReplySelector).childNodes[0], "textContent", {
      get() { throw new Error("Warm continuation cannot read an older answer body."); },
    });
    f.ui.messageRoot = domElement("main", {}, observedTurn(messageId(900), "Old request", [old]),
      observedTurn(sent.generationTurnKey, "Current request", [assistantMessage(1, "Owned current answer")]));
    const owner = f.activeTurn();
    if (historicalIdentity === messageId(0)) {
      const continued = await f.run("continue", { turnId: "following-turn" });
      assert.equal(continued.assistantText, "Owned current answer");
      assert.deepEqual(f.getState().baselineReplyIds, [messageId(0), messageId(1)]);
    } else {
      await assert.rejects(f.run("continue", { turnId: "following-turn" }), /missing or ambiguous assistant message identities/);
      assert.equal(f.activeTurn(), owner);
    }
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a lost interrupted tab fails continuation without replacement or replay", async () => {
  const f = fixture(); await f.ready();
  await f.run("send", { ...plugin, prompt: "Request" });
  const active = f.activeTurn();
  f.ui.stop = true; f.ui.present = false;
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /owned saved chat tab is unavailable/);
  assert.equal(f.activeTurn(), active);
  assert.equal(f.ui.stopClicks, 0);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.closeCount, 0);
});

test("Stop cannot act on another saved conversation in the same owned tab, including navigation during visibility observation", async () => {
  for (const duringVisibility of [false, true]) {
    const f = fixture(); await f.ready();
    await f.run('send', { ...plugin, prompt: 'Request' });
    f.ui.stop = true;
    const owner = f.activeTurn();
    if (duringVisibility) {
      f.ui.onStopRead = () => { f.ui.url = 'https://chatgpt.com/c/another-conversation'; };
    } else f.ui.url = 'https://chatgpt.com/c/another-conversation';
    await assert.rejects(f.run('continue', { turnId: 'next-turn', interruptedTurnId: base.turnId }), /saved chat URL changed|not ready for continuation/);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.ui.stop, true);
    assert.equal(f.ui.closeCount, 0);
    assert.equal(f.activeTurn(), owner);
  }
});

test("interrupted continuation stops the preceding native owner and starts a new turn in the same saved chat", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts.push("Earlier answer");
  await f.run("send", { ...plugin, prompt: "Interrupted request" });
  f.ui.texts.push("  Partial answer\n");
  f.ui.stop = true;
  f.ui.hiddenMountedStop = true;
  const result = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, tabId: "owned-tab" });
  assert.deepEqual(result, { operation: "continue", tabId: "owned-tab", url: "https://chatgpt.com/c/owned-conversation", normal: true, conversationFull: false, interrupted: true, assistantText: "  Partial answer\n" });
  assert.equal(f.ui.stopClicks, 1, "Continuation reconciles Stop even when native Interrupt could not finish it.");
  assert.equal(f.ui.closeCount, 0);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.sendClicks, 1, "Reconciling an interrupted generation never replays its Send.");
  assert.deepEqual(f.getState().baselineReplyIds, [messageId(0), messageId(1)]);
  assert.equal(f.getState().sendAttempted, false);
  assert.equal(f.activeTurn()?.turnId, "next-turn");
  f.ui.stop = true;
  await assert.rejects(f.run("continue", { turnId: "stale-turn", interruptedTurnId: base.turnId, expectedOwnerTurnIds: [base.turnId] }), /active.*turn|turn.*active/i);
  assert.equal(f.ui.stop, true, "Cleanup for the preceding turn cannot stop the new generation.");
  assert.equal(f.ui.stopClicks, 1);
  f.ui.stop = false;
  await f.run("send", { ...plugin, prompt: "Follow-up request", turnId: "next-turn" });
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
});

test("interrupted continuation rearms an SDK-capped readiness wait without replaying the saved chat", async () => {
  const f = fixture({ fastTimers: true }); await f.ready();
  f.ui.texts.push("Earlier answer");
  const sent = await f.run("send", { ...plugin, prompt: "Interrupted request" });
  f.ui.texts.push("Partial answer");
  f.ui.stop = true; f.ui.keepStopVisible = true; f.ui.hiddenMountedStop = true;
  const state = f.getState(), tab = state.tab;
  const messagesBefore = structuredClone(f.ui.userMessages), typedBefore = [...f.ui.typed];
  const events = [];
  f.ui.onStopWait = () => {
    if (f.ui.stopWaits === 1) {
      assert.equal(f.ui.stop, true); assert.equal(f.ui.complete, false);
      events.push("sdk-timeout");
      throw new Error("Playwright selector deadline exceeded\n\nlocator.waitFor(...) timed out");
    }
    assert(events.includes("active-read"), "A coherent active read must separate the capped wait from its rearm.");
    events.push("owned-composer-idle");
    f.ui.stop = false;
  };
  f.ui.onStopRead = () => {
    if (f.ui.stopWaits === 1) {
      assert.equal(f.ui.stop, true); assert.equal(f.ui.complete, false);
      events.push("active-read");
    }
  };
  const result = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId });
  assert.equal(result.interrupted, true); assert.equal(result.normal, true);
  assert.equal(result.assistantText, "Partial answer"); assert.equal(result.tabId, sent.tabId); assert.equal(result.url, sent.url);
  assert.equal(f.getState(), state); assert.equal(state.tab, tab); assert.equal(f.activeTurn()?.turnId, "next-turn");
  assert.equal(f.ui.complete, false, "Continuation requires the witnessed composer transition, not invented completion.");
  assert.equal(events[0], "sdk-timeout"); assert.equal(events.at(-1), "owned-composer-idle");
  assert.equal(f.ui.stopWaits, 2); assert.equal(f.ui.stopRequests, 1); assert.equal(f.ui.stopClicks, 1);
  assert.equal(f.ui.sendClicks, 1); assert.deepEqual(f.ui.userMessages, messagesBefore); assert.deepEqual(f.ui.typed, typedBefore);
  assert.equal(f.ui.newTabs, 1); assert.equal(f.ui.closeCount, 0); assert.equal(f.ui.waitedMs, 0);
});

test("interrupted continuation refuses a newer manual generation through final ownership transfer", async () => {
  for (const replacementAt of ["initial", "action", "readback", "final-snapshot"]) {
    const f = fixture(); await f.ready();
    const sent = await f.run("send", { ...plugin, prompt: "Owned request" });
    const owner = f.activeTurn();
    const replace = () => {
      f.ui.messageRoot = domElement("main", {}, observedTurn(sent.generationTurnKey, "Owned request", [], { complete: true }),
        observedTurn(messageId(2000), "Manual request", [assistantMessage(20, "Manual answer")], { complete: false }));
      f.ui.stop = true;
    };
    f.ui.stop = true;
    if (replacementAt === "initial") replace();
    else if (replacementAt === "action") f.ui.onStopRequest = replace;
    else if (replacementAt === "readback") f.ui.onStopClick = replace;
    else f.ui.onComposerRead = replace;
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /no longer unique and latest/);
    assert.equal(f.ui.stopClicks, ["readback", "final-snapshot"].includes(replacementAt) ? 1 : 0, "Only the original generation can receive a Stop click.");
    assert.equal(f.ui.stop, true, "The replacement generation remains active.");
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.activeTurn(), owner);
    assert.equal(f.getState().generationTurnKey, sent.generationTurnKey);
    assert.equal(f.ui.newTabs, 1); assert.equal(f.ui.closeCount, 0);
  }
});

test("hidden Stop and an idle composer cannot establish inactivity without completion or a witnessed click transition", async () => {
  for (const missingProof of ["no-click", "idle-already-present", "idle-not-restored"]) {
    const f = fixture(); await f.ready();
    await f.run("send", { ...plugin, prompt: "Owned request" });
    const owner = f.activeTurn();
    f.ui.hiddenMountedStop = true;
    f.ui.stop = missingProof !== "no-click";
    if (missingProof === "idle-already-present") f.ui.idleDuringStop = 1;
    if (missingProof === "idle-not-restored") f.ui.idleButtonCount = 0;
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /no affirmative inactivity proof/);
    assert.equal(f.ui.stopClicks, missingProof === "no-click" ? 0 : 1);
    assert.equal(f.getState().sendConfirmed, true);
    assert.equal(f.activeTurn(), owner);
    assert.equal(f.ui.sendClicks, 1);
  }
});

async function hookedInterruptionFixture() {
  const nativeContext = {}, sessionId = messageId(3000), turnId = messageId(3001);
  const f = fixture({ nativeContext, sessionId, fastTimers: true });
  const stateDir = path.resolve("generated/web-stop-handoff-fixture"), runtimeModule = path.join(stateDir, "browser-runtime.mjs");
  await f.run("bootstrap", { runtimeModule });
  await f.run("open", { turnId });
  const sent = await f.run("send", { ...plugin, turnId, prompt: "Owned interrupted request" });
  const bindingName = Object.keys(nativeContext).find(key => key.startsWith("routerWeb_unit_test_"));
  const ledger = { version: 1, threadId: sessionId, bindingId: bindingName.slice("routerWeb_".length),
    browserOwnerTurnIds: [turnId], tabId: sent.tabId, chatUrl: sent.url, generationTurnKey: sent.generationTurnKey,
    uncertainSend: false, lastTurn: { turnId, sendState: "sent", completed: false } };
  const ledgerBefore = JSON.stringify(ledger);
  const runStop = async () => {
    let output;
    const code = createWebStopCode({ stateDir, runtimeModule }, { threadId: sessionId, turnId, sessionId: messageId(3002) });
    const fs = { lstatSync: filename => {
      assert.equal(filename, path.join(stateDir, "web-in-app", "conversations", `${sessionId}.json`));
      return { isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, size: ledgerBefore.length, mtimeMs: 1 };
    }, readFileSync: (_filename, encoding) => { assert.equal(encoding, "utf8"); return JSON.stringify(ledger); } };
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("nodeRepl", "__publicImport", "globalThis", code.replaceAll("import(", "__publicImport("));
    await execute({ requestMeta: { threadId: sessionId, "x-codex-turn-metadata": {
      thread_id: sessionId, turn_id: turnId, session_id: messageId(3002) } }, write: value => { output = JSON.parse(value); } },
    async name => { assert.equal(name, "node:fs"); return fs; }, nativeContext);
    assert.equal(JSON.stringify(ledger), ledgerBefore, "The hook never settles or rewrites delivery acceptance.");
    return JSON.parse(output.systemMessage.slice("ROUTER_WEB_STOP ".length));
  };
  const continueInterrupted = () => f.run("continue", { turnId: "next-turn", interruptedTurnId: turnId });
  f.ui.stop = true; f.ui.hiddenMountedStop = true;
  return { ...f, nativeContext, runStop, continueInterrupted, sent };
}

test("the generated Stop hook hands its witnessed composer restoration to canonical same-chat continuation", async () => {
  const f = await hookedInterruptionFixture(), owner = f.activeTurn(), state = f.getState();
  f.ui.texts.push("Partial answer before interruption");
  const stopped = await f.runStop();
  assert.equal(stopped.outcome, "cancelled"); assert.equal(stopped.freshController, false);
  assert.equal(stopped.inactivityEvidence, "composer_restored"); assert.equal(stopped.readbackComplete, false);
  assert.equal(f.getState(), state); assert.equal(f.activeTurn(), owner);
  const receipt = state.reconciliationStop;
  const continued = await f.continueInterrupted();
  assert.deepEqual(receipt, { generationTurnKey: f.sent.generationTurnKey, idleAbsent: true, acknowledged: true });
  assert.equal(continued.interrupted, true); assert.equal(continued.assistantText, "Partial answer before interruption");
  assert.equal(continued.url, f.sent.url); assert.equal(continued.tabId, f.sent.tabId);
  assert.equal(f.ui.complete, false, "Explicit DOM completion never arrives in this regression.");
  assert.equal(f.getState(), state); assert.equal(f.getState().reconciliationStop, undefined);
  assert.equal(f.activeTurn().turnId, "next-turn");
  assert.equal(f.ui.stopRequests, 1); assert.equal(f.ui.stopClicks, 1); assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1); assert.equal(f.ui.closeCount, 0);
});

test("a rejected generated-hook click remains uncertain across hook and continuation retries", async () => {
  for (const rejectedAt of ["dispatch", "acknowledgement"]) {
    const f = await hookedInterruptionFixture(), owner = f.activeTurn();
    if (rejectedAt === "dispatch") f.ui.onStopRequest = () => { throw new Error("Rejected before input effect."); };
    else f.ui.stopClickError = new Error("Input effect occurred, acknowledgement rejected.");
    const stopped = await f.runStop();
    assert.equal(stopped.outcome, "blocked"); assert.equal(stopped.clickError, true);
    assert.equal(f.getState().reconciliationStop.acknowledged, false);
    await assert.rejects(f.continueInterrupted(), /no affirmative inactivity proof/);
    // A visible Stop on the same generation cannot justify repeating an
    // action whose input effect or acknowledgement remains uncertain.
    f.ui.stop = true;
    assert.equal((await f.runStop()).outcome, "blocked");
    await assert.rejects(f.continueInterrupted(), /no affirmative inactivity proof/);
    assert.equal(f.ui.stopRequests, 1); assert.equal(f.ui.stopClicks, rejectedAt === "dispatch" ? 0 : 1);
    assert.equal(f.activeTurn(), owner); assert.equal(f.ui.sendClicks, 1);
    f.ui.stop = false; f.ui.complete = true;
    assert.equal((await f.continueInterrupted()).interrupted, true);
    assert.equal(f.ui.stopRequests, 1); assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1); assert.equal(f.ui.closeCount, 0);
  }
});

test("generated-hook receipts cannot replace missing transition proof or renewed generation activity", async () => {
  for (const missingProof of ["no-click", "idle-already-present", "idle-not-restored", "renewed-stop"]) {
    const f = await hookedInterruptionFixture(), owner = f.activeTurn();
    if (missingProof === "no-click") f.ui.stop = false;
    if (missingProof === "idle-already-present") f.ui.idleDuringStop = 1;
    if (missingProof === "idle-not-restored") f.ui.idleButtonCount = 0;
    const stopped = await f.runStop();
    assert.equal(stopped.outcome, missingProof === "renewed-stop" ? "cancelled" : "blocked");
    if (missingProof === "renewed-stop") f.ui.stop = true;
    await assert.rejects(f.continueInterrupted(), /no affirmative inactivity proof/);
    assert.equal(f.ui.complete, false); assert.equal(f.activeTurn(), owner);
    assert.equal(f.ui.stopRequests, missingProof === "no-click" ? 0 : 1);
    assert.equal(f.ui.stopClicks, missingProof === "no-click" ? 0 : 1);
    assert.equal(f.ui.sendClicks, 1); assert.equal(f.ui.newTabs, 1); assert.equal(f.ui.closeCount, 0);
  }
});

test("a hook receipt cannot transfer continuation after its owner, generation, tab or saved URL changes", async () => {
  for (const changed of ["owner", "receipt-generation", "generation", "tab", "url"]) {
    const f = await hookedInterruptionFixture(), state = f.getState();
    assert.equal((await f.runStop()).outcome, "cancelled");
    const receipt = state.reconciliationStop;
    if (changed === "owner") f.nativeContext.routerWebActiveTurns.set(state.sessionId, { ...f.activeTurn(), turnId: "foreign-turn" });
    if (changed === "receipt-generation") receipt.generationTurnKey = messageId(4000);
    if (changed === "generation") state.generationTurnKey = messageId(4000);
    if (changed === "tab") f.ui.tabId = "foreign-tab";
    if (changed === "url") f.ui.url = "https://chatgpt.com/c/foreign-conversation";
    const owner = f.activeTurn();
    await assert.rejects(f.continueInterrupted(), /different native turn|no affirmative inactivity proof|no longer unique and latest|tab is unavailable|not ready for continuation/);
    assert.equal(f.getState(), state); assert.equal(f.activeTurn(), owner);
    assert.equal(state.reconciliationStop, receipt);
    assert.equal(f.ui.stopRequests, 1); assert.equal(f.ui.stopClicks, 1); assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1); assert.equal(f.ui.closeCount, 0);
  }
});

test("an uncertain reconciliation click is not repeated and only explicit completion permits its retry", async () => {
  const f = fixture(); await f.ready();
  await f.run("send", { ...plugin, prompt: "Owned request" });
  const owner = f.activeTurn();
  f.ui.stop = true;
  f.ui.stopClickError = new Error("Input effect is uncertain.");
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /no affirmative inactivity proof/);
  assert.equal(f.ui.stop, false);
  assert.equal(f.ui.stopClicks, 1);
  assert.equal(f.getState().reconciliationStop.acknowledged, false);
  assert.equal(f.activeTurn(), owner);
  // The original generation can still be streaming. Its retry must not issue
  // another click merely because Stop is visible again.
  f.ui.stop = true;
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /no affirmative inactivity proof/);
  assert.equal(f.ui.stopRequests, 1); assert.equal(f.ui.stopClicks, 1);
  f.ui.stop = false; f.ui.complete = true;
  const continued = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId });
  assert.equal(continued.interrupted, true);
  assert.equal(f.getState().reconciliationStop, undefined);
  assert.equal(f.activeTurn().turnId, "next-turn");
  assert.equal(f.ui.stopRequests, 1); assert.equal(f.ui.sendClicks, 1);
});

test("reconciliation rechecks native authority after each conditional read and after Stop acknowledges", async () => {
  for (const changeAt of ["read", "click"]) {
    const nativeContext = {}, f = fixture({ nativeContext }); await f.ready();
    await f.run("send", { ...plugin, prompt: "Owned request" });
    f.ui.stop = true;
    const newer = { ...f.activeTurn(), turnId: "manual-native-owner" };
    const replace = () => nativeContext.routerWebActiveTurns.set(base.sessionId, newer);
    if (changeAt === "read") f.ui.onStopRead = replace;
    else f.ui.onStopClick = replace;
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /different native turn owns/);
    assert.equal(f.activeTurn(), newer);
    assert.equal(f.ui.stopClicks, changeAt === "read" ? 0 : 1);
    assert.equal(f.ui.stopReads, 1, "A changed owner prevents further readback RPCs.");
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("Stop before Send retains the owned tab and does not attribute an earlier assistant reply to the interrupted turn", async () => {
  const f = fixture();
  await f.ready();
  f.ui.texts.push("Earlier answer");
  const result = await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId });
  assert.equal(result.interrupted, true);
  assert.equal(result.assistantText, "");
  assert.equal(f.ui.sendClicks, 0);
  assert.equal(f.ui.stopClicks, 0);
  assert.equal(f.ui.closeCount, 0);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.activeTurn()?.turnId, "next-turn");
});

test("Stop before Send never cancels an unowned generation or clears its composer", async () => {
  for (const ownDraft of [false, true]) {
    const f = fixture({ fastTimers: true }); await f.ready();
    if (ownDraft) {
      f.ui.sendEnabled = false;
      await assert.rejects(f.run("send", { ...plugin, prompt: "Owned unsent draft" }), /nothing sent/);
    }
    const owner = f.activeTurn(), composerText = f.ui.composerText;
    f.ui.stop = true;
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /cannot stop an unowned generation/);
    assert.equal(f.ui.stop, true);
    assert.equal(f.ui.stopClicks, 0); assert.equal(f.ui.stopRequests, 0);
    assert.equal(f.ui.composerText, composerText);
    assert.equal(f.activeTurn(), owner);
    assert.equal(f.ui.sendClicks, 0); assert.equal(f.ui.closeCount, 0);
  }
});

test("continuation rejects missing, changed or foreign active ownership before stopping or sending", async () => {
  for (const interrupted of [false, true]) for (const replacement of [undefined, { turnId: "different-turn" }, { turnId: base.turnId, state: {} }]) {
    const nativeContext = {};
    const f = fixture({ nativeContext });
    await f.ready();
    await f.run("send", { ...plugin, prompt: "Interrupted request" });
    if (!interrupted) {
      f.ui.texts.push("Completed request"); f.ui.complete = true;
      await f.run("observe");
      await f.run("retain");
    }
    f.ui.stop = true;
    if (replacement) nativeContext.routerWebActiveTurns.set(base.sessionId, { ...f.activeTurn(), ...replacement });
    else nativeContext.routerWebActiveTurns.delete(base.sessionId);
    await assert.rejects(f.run("continue", { turnId: "next-turn", ...(interrupted ? { interruptedTurnId: base.turnId } : {}) }), /active.*turn|turn.*active/i);
    assert.equal(f.ui.stop, true);
    assert.equal(f.ui.stopClicks, 0);
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.closeCount, 0);
  }
});

test("interrupted continuation clears an ordinary unsent draft before the new turn attaches and sends", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  f.ui.sendEnabled = false;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Abandoned draft" }), /nothing sent/);
  assert.equal(f.ui.composerText, " Abandoned draft");
  await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId });
  assert.equal(f.ui.composerText, "");
  assert.equal(f.ui.sendClicks, 0);
  assert.equal(f.ui.chip, false, "Clearing the owned draft can remove its chip; prepared Send restores it.");
  await f.run("send", { ...plugin, prompt: "Current request", turnId: "next-turn" });
  assert.deepEqual(f.ui.typed, [" Abandoned draft", " Current request", "\nRouter generation: next-turn"]);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.closeCount, 0);
});

test("unsent draft reconciliation cannot mutate a composer after handoff navigates away from its saved chat or normal home", async () => {
  for (const initial of ["home", "saved"]) for (const destination of ["https://chatgpt.com/c/unowned-conversation", "https://chatgpt.com/"]) {
    if (initial === "home" && destination === "https://chatgpt.com/") continue;
    const f = fixture({ fastTimers: true }); await f.ready();
    if (initial === "saved") {
      await f.run("send", { ...plugin, prompt: "Previous request" });
      f.ui.texts.push("Previous answer"); f.ui.complete = true;
      await f.run("observe"); await f.run("retain");
      await f.run("continue", { turnId: "unsent-turn" });
    }
    const owner = f.activeTurn();
    f.ui.sendEnabled = false;
    await assert.rejects(f.run("send", { ...plugin, turnId: owner.turnId, prompt: "Owned unsent draft" }), /nothing sent/);
    const composerText = f.ui.composerText, mutations = [], sends = f.ui.sendClicks;
    const getByRole = f.tab.playwright.getByRole;
    f.tab.playwright.getByRole = (kind, options) => {
      const locator = getByRole(kind, options), press = locator.press;
      if (kind === "textbox" && options.name === browserDom.composerName) locator.press = async key => { mutations.push(key); return press.call(locator, key); };
      return locator;
    };
    const handoff = f.tab.markHandoff;
    f.tab.markHandoff = async () => { await handoff(); f.ui.url = destination; };
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: owner.turnId }), /left its.*(?:saved URL|normal home)/);
    assert.deepEqual(mutations, [], "A matching draft on another page cannot authorize composer input.");
    assert.equal(f.ui.composerText, composerText);
    assert.equal(f.getState().unsentComposerText, composerText);
    assert.equal(f.activeTurn(), owner);
    assert.equal(f.ui.sendClicks, sends);
    assert.equal(f.ui.stopClicks, 0); assert.equal(f.ui.stopRequests, 0);
    assert.equal(f.ui.closeCount, 0); assert.equal(f.ui.newTabs, 1);
  }
});

test("changed or transformed unsent drafts and uncertain Send cannot be replayed by interrupted continuation", async () => {
  for (const composerText of ["User changed the draft", "User added a prefix Unsent original", ""]) {
    const f = fixture({ fastTimers: true });
    await f.ready();
    f.ui.sendEnabled = false;
    await assert.rejects(f.run("send", { ...plugin, prompt: "Unsent original" }), /nothing sent/);
    f.ui.composerText = composerText;
    const previous = f.activeTurn();
    await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /draft changed or became an attachment/);
    assert.equal(f.ui.composerText, composerText);
    assert.equal(f.activeTurn(), previous);
    assert.equal(f.ui.sendClicks, 0);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.closeCount, 0);
  }
  const f = fixture();
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Confirmed first request" });
  f.ui.texts.push("First answer"); f.ui.complete = true;
  await f.run("observe");
  await f.run("retain");
  await f.run("continue", { turnId: "uncertain-turn" });
  f.ui.sendFailure = true;
  await assert.rejects(f.run("send", { ...plugin, prompt: "Uncertain request", turnId: "uncertain-turn" }), /effect uncertain/);
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: "uncertain-turn" }), /Send is uncertain/);
  assert.equal(f.activeTurn()?.turnId, "uncertain-turn");
  assert.equal(f.ui.sendClicks, 2);
  assert.equal(f.ui.newTabs, 1);
  assert.equal(f.ui.closeCount, 0);
});

test("failed interrupted-continuation handoff preserves the owner and retry retains its exact tab", async () => {
  const f = fixture(); await f.ready();
  await f.run("send", { ...plugin, prompt: "Interrupted request" });
  const active = f.activeTurn(), handoff = f.tab.markHandoff;
  f.ui.stop = true;
  f.tab.markHandoff = async () => { throw new Error("Handoff failed"); };
  await assert.rejects(f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /Handoff failed/);
  assert.equal(f.activeTurn(), active);
  assert.equal(f.ui.stop, true);
  assert.equal(f.ui.stopClicks, 0);
  f.tab.markHandoff = handoff;
  await f.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId });
  assert.equal(f.activeTurn().turnId, "next-turn");
  assert.equal(f.ui.stopClicks, 1);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.closeCount, 0);
});

test("interrupted continuation cannot replace a newer binding or another native session's active turn", async () => {
  const nativeContext = {};
  const older = fixture({ nativeContext }), newer = fixture({ nativeContext });
  const otherSession = fixture({ nativeContext, sessionId: "different-session" });
  await older.ready(); await newer.ready(); await otherSession.ready();
  const newest = newer.activeTurn(), unrelated = otherSession.activeTurn();
  await assert.rejects(newer.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId, sessionId: "different-session" }), /another native session/);
  older.ui.stop = true;
  await assert.rejects(older.run("continue", { turnId: "next-turn", interruptedTurnId: base.turnId }), /active.*turn|turn.*active/i);
  assert.equal(older.ui.stop, true);
  assert.equal(older.ui.stopClicks, 0);
  assert.equal(newer.activeTurn(), newest);
  assert.equal(otherSession.activeTurn(), unrelated);
  assert.equal(older.ui.closeCount, 0);
  assert.equal(newer.ui.closeCount, 0);
});

test("a visual observation returns the current generation without an artificial pause or another Send", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Call the current tools" });
  f.ui.stop = true;
  const before = f.ui.replyReads, waitedBefore = f.ui.waitedMs, urlsBefore = f.ui.urlReads;
  const pending = await f.run("observe");
  assert.equal(pending.completed, false);
  assert.equal(pending.stopVisible, true);
  assert.equal(f.ui.replyReads - before, 1);
  assert.equal(f.ui.waitedMs - waitedBefore, 0);
  assert.equal(f.ui.urlReads - urlsBefore, 1, "The initial URL check precedes the coherent DOM URL and control read.");
  assert.equal(f.ui.fetchCalls, 0);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.closeCount, 0);
  assert.equal(f.ui.handoffs, 2);
});

test("active, completed and retention reads batch exact controls with the owned reply and document URL", async () => {
  for (const operation of ["active", "completed", "retain"]) {
    const f = fixture({ fastTimers: true }); await f.ready();
    await f.run("send", { ...plugin, prompt: "Request" });
    f.ui.texts.push("Owned answer");
    f.ui.complete = operation !== "active"; f.ui.stop = !f.ui.complete;
    if (operation === "retain") await f.run("observe");
    const before = { tabs: f.ui.tabReads, urls: f.ui.urlReads, replies: f.ui.replyReads,
      controls: f.ui.controlReads, observations: f.ui.observationReads, waits: f.ui.waitedMs, handoffs: f.ui.handoffs };
    const result = await f.run(operation === "retain" ? "retain" : "observe");
    assert.deepEqual({ tabs: f.ui.tabReads - before.tabs, urls: f.ui.urlReads - before.urls,
      replies: f.ui.replyReads - before.replies, controls: f.ui.controlReads - before.controls,
      observations: f.ui.observationReads - before.observations, waits: f.ui.waitedMs - before.waits },
    { tabs: 1, urls: 1, replies: 1, controls: 0, observations: 1, waits: 0 });
    assert.deepEqual([result.assistantText, result.completed, result.stopVisible, result.url],
      ["Owned answer", operation !== "active", operation === "active", f.getState().savedUrl]);
    assert.equal(f.ui.handoffs - before.handoffs, operation === "retain" ? 1 : 0);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("batched exact-control reads reject duplicate controls and unrecognized accessible-name markup", async () => {
  const stop = attributes => domElement("button", { "aria-label": "Stop", ...attributes });
  for (const controls of [
    { Stop: [stop(), stop()] },
    { Stop: [stop({ "aria-labelledby": "alternative-accessible-name" })] },
    { "Turn off temporary chat": [domElement("button", { "aria-label": "Turn off temporary chat" }), domElement("button", { "aria-label": "Turn off temporary chat" })] },
    { "Temporary chat": [domElement("h2", {}, domText("Temporary chat")), domElement("h2", {}, domText("Temporary chat"))] },
  ]) {
    const f = fixture({ fastTimers: true }); await f.ready();
    await f.run("send", { ...plugin, prompt: "Request" });
    f.ui.texts.push("Owned answer"); f.ui.complete = true;
    f.ui.observationControls = controls;
    await assert.rejects(f.run("observe"), /controls are unrecognized or ambiguous/);
    assert.notEqual(f.getState().completed, true);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("a same-generation rejection after retention requires the exact restored visible token directive and marker", async () => {
  const f = fixture({ fastTimers: true }); await f.ready();
  const turnToken = 'web_turn_0123456789abcdef0123456789abcdef';
  f.ui.sendEnabled = false;
  f.ui.onWait = () => { f.ui.composerText = ''; f.ui.sendEnabled = true; };
  await f.run("send", { ...plugin, prompt: "Request that may be rejected after retention", turnToken });
  f.ui.texts.push("Answer before late broker activity."); f.ui.complete = true;
  const completed = await f.run("observe");
  await f.run("retain");
  const submitted = f.ui.userMessages.at(-1).text;
  assert.ok(submitted.includes(turnToken));
  assert.equal(submitted.includes('Request that may be rejected after retention'), false, 'The restored draft uses the actual post-conversion composer text.');
  const error = domElement("div", {}, domText("Unknown error"));
  const retry = domElement("button", {}, domText("Retry"));
  const errorRegion = domElement("div", {}, error, retry);
  error.contains = node => node === error;
  errorRegion.contains = node => node === errorRegion || node === error || node === retry;
  const composer = domElement("div", { role: "textbox", "aria-label": "Ask ChatGPT", contenteditable: "true" }, domText(submitted));
  composer.innerText = submitted;
  f.ui.messageRoot = domElement("main", {}, observedTurn(completed.generationTurnKey, submitted,
    [assistantMessage(0, f.ui.texts[0])]), errorRegion, composer);
  f.ui.observationControls = { "Unknown error": [error], Retry: [retry], "Ask ChatGPT": [composer] };
  composer.innerText = submitted.replace(turnToken, 'web_turn_fedcba9876543210fedcba9876543210');
  assert.equal((await f.run("observe")).requestError, undefined, 'A restored draft with a different tool token cannot establish this submitted request.');
  composer.innerText = submitted;
  const reads = f.ui.observationReads;
  const rejected = await f.run("observe");
  assert.equal(f.ui.observationReads, reads + 1, "The resumed operation must run the current browser reader.");
  assert.equal(rejected.generationTurnKey, completed.generationTurnKey);
  assert.equal(rejected.requestError, "unknown_error");
  assert.equal(JSON.stringify(rejected).includes(turnToken), false);
  assert.equal(composer.innerText, submitted, "Observation preserves the restored submitted draft.");
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.closeCount, 0);
});

test("warm mutation programs are compact, source-bound and carry only differing UI overrides", () => {
  for (const operation of ["send", "continue"]) {
    const options = { ...base, operation, ...plugin,
      ...(operation === "send" ? { prompt: "Request" } : { expectedOwnerTurnIds: [base.turnId] }) };
    const code = browserScript(options), parsed = readBrowserProgram(code);
    const literal = JSON.parse(/, (\{[^\n]*\})\);$/u.exec(code)[1]);
    assert.equal(Object.hasOwn(literal, "ui"), false);
    assert.deepEqual(parsed.ui, browserDom);
    assert.equal(browserScript({ ...options, ui: browserDom }), code);
    assert.ok(Buffer.byteLength(code, "utf8") < 5000);
    assert.doesNotMatch(code, /function (?:runBrowserContinuation|runBrowserSend|readBrowserReplies|selectBrowserModel)/u);
    assert.ok(code.includes(browserMutationVersion));
    const custom = browserScript({ ...options, ui: { stopButtonExactName: "Stop generating", futureControl: "Only this call" } });
    const customOptions = readBrowserProgram(custom);
    assert.equal(customOptions.ui.stopButtonExactName, "Stop generating");
    assert.equal(customOptions.ui.futureControl, "Only this call");
    assert.equal(browserScript(customOptions), custom);
    assert.equal(readBrowserProgram(code.replace('"frameBegin":', '"ui":{"stopButtonExactName":"Stop"},"frameBegin":')), null);
    assert.equal(readBrowserProgram(code.replace(browserMutationVersion, "0".repeat(64))), null);
    assert.equal(readBrowserProgram(code.replace("Function.prototype.toString.call", "String")), null);
  }
  for (const fullContinuation of [false, 1, "true"]) assert.throws(() => browserScript({ ...base, operation: "continue", expectedOwnerTurnIds: [base.turnId], fullContinuation }), /Continue-only install flag/u);
  assert.throws(() => browserScript({ ...base, operation: "send", prompt: "Request", fullContinuation: true }), /Continue-only install flag/u);
  const full = browserScript({ ...base, operation: "continue", expectedOwnerTurnIds: [base.turnId], fullContinuation: true });
  assert.equal(readBrowserProgram(full).fullContinuation, true);
  assert.match(full, /function runBrowserContinuation/u);
  assert.match(full, /function runBrowserSend/u);
  assert.equal(readBrowserProgram(full.replace(',"fullContinuation":true', "")), null);
});

test("default observation and retention stay below 2 KB without resending resident control data", () => {
  for (const operation of ["observe", "retain"]) {
    const bytes = Buffer.byteLength(browserScript({ ...base, operation }), "utf8");
    assert.ok(bytes < 2000, `${operation} payload is ${bytes} bytes`);
    assert.doesNotMatch(browserScript({ ...base, operation }), /residentMutation|function runBrowser/u);
  }
});

test("resident defaults and per-call UI overlays remain isolated from bootstrap and prior observations", async () => {
  const defaults = { ...browserDom }, f = fixture();
  await f.run("bootstrap", { runtimeModule: "current-runtime.mjs", ui: { stopButtonExactName: "Bootstrap Stop", bootstrapControl: "Bootstrap only" } });
  await f.run("open");
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push("Completed answer"); f.ui.complete = true;
  const helper = f.getState().residentBrowser, controls = [];
  f.ui.onReplyRead = argument => { controls.push(argument.ui); };
  await f.run("observe", { ui: { stopButtonExactName: "Stop generating", futureControl: "Per call" } });
  assert.equal(controls[0].stopButtonExactName, "Stop generating");
  assert.equal(controls[0].futureControl, "Per call");
  assert.equal(Object.hasOwn(controls[0], "bootstrapControl"), false);
  controls[0].regenerateButtonExactName = "Mutated earlier call";
  await f.run("observe");
  assert.notEqual(controls[0], controls[1]);
  assert.equal(controls[1].stopButtonExactName, browserDom.stopButtonExactName);
  assert.equal(controls[1].regenerateButtonExactName, browserDom.regenerateButtonExactName);
  assert.equal(Object.hasOwn(controls[1], "futureControl"), false);
  assert.equal(Object.hasOwn(controls[1], "bootstrapControl"), false);
  assert.deepEqual(browserDom, defaults);
  assert.equal(f.getState().residentBrowser, helper);
  assert.equal(f.ui.sendClicks, 1);
});

test("one frozen resident controller survives ordinary observation, retention, bootstrap and continuation", async () => {
  const f = fixture(); await f.ready();
  const helper = f.getState().residentBrowser;
  const mutation = f.getState().residentMutation;
  assert.equal(Object.isFrozen(helper), true);
  assert.equal(helper.version, browserHelperVersion);
  assert.equal(helper.state, f.getState());
  assert.equal(Object.isFrozen(mutation), true);
  assert.equal(Object.isFrozen(mutation.ui), true);
  assert.equal(mutation.version, browserMutationVersion);
  assert.equal(mutation.state, f.getState());
  assert.equal(mutation.helper, helper);
  await f.run("bootstrap", { runtimeModule: "current-runtime.mjs" });
  await f.run("send", { ...plugin, prompt: "Request" });
  f.ui.texts.push("Completed answer"); f.ui.complete = true;
  await f.run("observe");
  await f.run("retain");
  await f.run("continue", { turnId: "next-turn" });
  assert.equal(f.getState().residentBrowser, helper);
  assert.equal(f.getState().residentMutation, mutation);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("missing or changed mutation custody yields no-action Continue before UI access and Send fails closed", async () => {
  for (const corrupt of [
    state => { delete state.residentMutation; },
    state => { state.residentMutation = { ...state.residentMutation }; },
    state => { state.residentMutation = Object.freeze({ ...state.residentMutation, version: "old-source" }); },
    state => { state.residentMutation = Object.freeze({ ...state.residentMutation, state: {} }); },
    state => { state.residentMutation = Object.freeze({ ...state.residentMutation, helper: {} }); },
    state => { state.residentMutation = Object.freeze({ ...state.residentMutation, ui: { ...state.residentMutation.ui } }); },
    state => { state.residentMutation = Object.freeze({ ...state.residentMutation, ui: Object.freeze({ ...state.residentMutation.ui, stopButtonExactName: "Changed Stop" }) }); },
    state => {
      const original = state.residentMutation;
      state.residentMutation = Object.freeze(Object.defineProperty({ ...original }, "run", { get: () => original.run }));
    },
    state => {
      const ui = { ...state.residentMutation.ui };
      Object.defineProperty(ui, "stopButtonExactName", { get: () => "Stop" });
      state.residentMutation = Object.freeze({ ...state.residentMutation, ui: Object.freeze(ui) });
    },
    state => {
      const ui = Object.assign(Object.create({ toJSON: () => browserDom }), { ...browserDom, stopButtonExactName: "Changed Stop" });
      state.residentMutation = Object.freeze({ ...state.residentMutation, ui: Object.freeze(ui) });
    },
    ...["run", "continuation", "send", "createContext", "selectModel", "reconcile", "createStopState"].map(key => state => {
      state.residentMutation = Object.freeze({ ...state.residentMutation, [key]: async () => { throw new Error("Tampered runner reached UI authority."); } });
    }),
  ]) {
    const f = fixture(); await f.ready();
    await f.run("send", { ...plugin, prompt: "First request" });
    f.ui.texts.push("Completed answer"); f.ui.complete = true;
    await f.run("observe"); await f.run("retain");
    const state = f.getState(), helper = state.residentBrowser, owner = f.activeTurn();
    corrupt(state);
    const counts = () => [f.ui.replyReads, f.ui.controlReads, f.ui.tabReads, f.ui.handoffs, f.ui.sendClicks, f.ui.newTabs, f.ui.actions.length];
    const before = counts(), baseline = [...state.baselineReplyIds], generation = state.generationTurnKey;
    assert.deepEqual(await f.runFast("continue", { turnId: "next-turn" }), { operation: "continue", needsFullContinuation: true, noActions: true });
    await assert.rejects(f.runFast("send", { ...plugin, prompt: "Never sent" }), /mutation cache was lost or changed/u);
    assert.deepEqual(counts(), before, "No DOM read, handoff, picker, draft, Send, tab creation or recovery preceded the cache-miss receipt.");
    assert.equal(f.activeTurn(), owner);
    assert.equal(state.generationTurnKey, generation);
    assert.deepEqual(state.baselineReplyIds, baseline);
    assert.equal((await f.runFast("continue", { turnId: "next-turn", fullContinuation: true })).assistantText, "Completed answer");
    assert.equal(state.residentBrowser, helper, "Repairing mutation custody preserves the observer generation.");
    assert.equal(state.residentMutation.version, browserMutationVersion);
    assert.equal(state.residentMutation.state, state);
    assert.equal(Object.isFrozen(state.residentMutation), true);
    assert.equal(f.ui.sendClicks, 1);
    await f.runFast("send", { ...plugin, turnId: "next-turn", prompt: "Only the next input" });
    assert.equal(f.ui.sendClicks, 2);
    assert.equal(f.ui.newTabs, 1);
  }
});

test("a warm mutation captures its frozen cache once before source validation and execution", async () => {
  const f = fixture(); await f.ready();
  const state = f.getState(), cache = state.residentMutation;
  let reads = 0;
  Object.defineProperty(state, "residentMutation", { configurable: true, get: () => {
    assert.equal(++reads, 1, "A mutable state accessor cannot replace the cache after validation.");
    return cache;
  } });
  await f.runFast("send", { ...plugin, prompt: "Send once using the verified captured dispatcher" });
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(reads, 1);
});

test("a lost native kernel requests full continuation before importing recovery or creating a binding", async () => {
  const f = await recoverableFixture();
  f.loseBinding();
  const before = [f.ui.tabReads, f.ui.replyReads, f.ui.controlReads, f.ui.handoffs, f.ui.actions.length];
  assert.deepEqual(await f.runFast("continue", { turnId: "next-turn", recovery: f.recovery }), { operation: "continue", needsFullContinuation: true, noActions: true });
  assert.equal(f.getState(), undefined);
  assert.deepEqual([f.ui.tabReads, f.ui.replyReads, f.ui.controlReads, f.ui.handoffs, f.ui.actions.length], before);
  const result = await f.runFast("continue", { turnId: "next-turn", recovery: f.recovery, fullContinuation: true });
  assert.equal(result.recovered, true);
  assert.equal(result.bindingRestored, true);
  assert.equal(result.tabReopened, false);
  assert.equal(result.tabNavigated, false);
  assert.equal(f.ui.sendClicks, 1);
  assert.equal(f.ui.newTabs, 1);
});

test("missing, incompatible or foreign resident helpers fail before DOM reads and continuation repairs them without replay", async () => {
  for (const corrupt of [
    state => { delete state.residentBrowser; },
    state => { state.residentBrowser = Object.freeze({ ...state.residentBrowser, version: "outdated-source" }); },
    state => { state.residentBrowser = Object.freeze({ ...state.residentBrowser, state: {} }); },
    state => { state.residentBrowser = { ...state.residentBrowser }; },
  ]) {
    const f = fixture(); await f.ready();
    await f.run("send", { ...plugin, prompt: "Request" });
    f.ui.texts.push("Completed answer"); f.ui.complete = true;
    await f.run("observe"); await f.run("retain");
    const original = f.getState().residentBrowser;
    corrupt(f.getState());
    const reads = f.ui.replyReads, handoffs = f.ui.handoffs;
    for (const operation of ["observe", "retain"]) await assert.rejects(f.run(operation), /helper was lost or changed/);
    assert.equal(f.ui.replyReads, reads);
    assert.equal(f.ui.handoffs, handoffs);
    const continued = await f.run("continue", { turnId: "next-turn" });
    assert.equal(continued.assistantText, "Completed answer");
    const repaired = f.getState().residentBrowser;
    assert.notEqual(repaired, original);
    assert.equal(repaired.version, browserHelperVersion);
    assert.equal(Object.isFrozen(repaired), true);
    assert.equal(repaired.state, f.getState());
    assert.equal(f.ui.sendClicks, 1);
    assert.equal(f.ui.newTabs, 1);
    assert.equal(f.ui.closeCount, 0);
  }
});

test("resident observation rejects navigation or owner changes during the page read", async () => {
  for (const change of [f => { f.ui.url = "https://chatgpt.com/c/another-conversation"; },
    f => { f.ui.temporary = true; }, f => { f.activeTurn().turnId = "newer-turn"; }]) {
    const f = fixture(); await f.ready();
    await f.run("send", { ...plugin, prompt: "Request" });
    f.ui.texts.push("Completed answer"); f.ui.complete = true;
    f.ui.onReplyRead = () => change(f);
    await assert.rejects(f.run("observe"), /normal saved URL|different native turn owns/);
    assert.notEqual(f.getState().completed, true);
    assert.notEqual(f.getState().retained, true);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("compact observation and retention require the exact session, tab catalog and active owner", async () => {
  const cases = [
    [() => ({ sessionId: "another-session" }), /another native session/u],
    [() => ({ tabId: "another-tab" }), /Owned browser binding is unavailable/u],
    [f => { f.ui.present = false; }, /owned saved chat tab is unavailable/u],
    [f => { f.browser.tabs.list = async () => [{ id: f.tab.id }, { id: f.tab.id }]; }, /owned saved chat tab is unavailable/u],
    [f => { f.ui.url = "https://elsewhere.test/"; }, /owned tab left ChatGPT/u],
    [f => { f.activeTurn().turnId = "newer-turn"; }, /different native turn owns/u],
  ];
  for (const operation of ["observe", "retain"]) for (const [change, reason] of cases) {
    const f = fixture({ fastTimers: true });
    await f.ready();
    await f.run("send", { ...plugin, prompt: "Owned request" });
    f.ui.texts.push("Completed answer"); f.ui.complete = true;
    await f.run("observe");
    const reads = f.ui.replyReads, handoffs = f.ui.handoffs;
    const extra = change(f) ?? {};
    await assert.rejects(f.run(operation, { ...extra }), reason);
    assert.equal(f.ui.replyReads, reads);
    assert.equal(f.ui.handoffs, handoffs);
    assert.equal(f.ui.sendClicks, 1);
  }
});

test("retention cannot claim success when another turn takes ownership during handoff", async () => {
  const f = fixture({ fastTimers: true });
  await f.ready();
  await f.run("send", { ...plugin, prompt: "Owned request" });
  f.ui.texts.push("Completed answer"); f.ui.complete = true;
  await f.run("observe");
  const owner = f.activeTurn(), handoff = f.tab.markHandoff;
  f.tab.markHandoff = async () => { await handoff(); owner.turnId = "newer-turn"; };
  await assert.rejects(f.run("retain"), /different native turn owns/u);
  assert.equal(f.activeTurn(), owner);
  assert.equal(owner.turnId, "newer-turn");
  assert.notEqual(f.getState().retained, true);
});

test("script arguments reject unsafe bindings or native identities", () => {
  for (const binding of ['x;alert(1)', "x.y", "x-y", "x\nvar evil"]) assert.throws(() => browserScript({ ...base, operation: "open", bindingId: binding }), /binding ID/);
  for (const name of ["sessionId", "turnId"]) for (const value of [undefined, "", "not an identity", "x".repeat(129)]) {
    assert.throws(() => browserScript({ ...base, operation: "open", [name]: value }), /session and turn identities/);
  }
  for (const interruptedTurnId of ["", "not an identity", "x".repeat(129)]) {
    assert.throws(() => browserScript({ ...base, operation: "continue", interruptedTurnId, expectedOwnerTurnIds: [base.turnId] }), /previous native turn identity/);
  }
  assert.throws(() => browserScript({ ...base, operation: "observe", interruptedTurnId: "previous-turn" }), /previous native turn identity/);
  for (const operation of ["continue", "rollover"]) for (const expectedOwnerTurnIds of [undefined, [], [""], ["not an identity"], [base.turnId, base.turnId]]) {
    assert.throws(() => browserScript({ ...base, operation, expectedOwnerTurnIds, previousChatUrl: "https://chatgpt.com/c/owned-conversation" }), /expected native owner identities/);
  }
  assert.throws(() => browserScript({ ...base, operation: "observe", expectedOwnerTurnIds: [base.turnId] }), /expected native owner identities/);
  const recovery = { tabId: "owned-tab", url: "https://chatgpt.com/c/owned-conversation",
    baselineReplyIds: [], replyId: messageId(0),
    generationTurnKey: messageId(100), generationReplyIds: [messageId(0)],
    assistantPrefix: assistantPrefix("Observed partial"), completed: false };
  const continuation = { ...base, operation: "continue", tabId: "owned-tab", runtimeModule: "current-runtime.mjs", expectedOwnerTurnIds: [base.turnId] };
  for (const previousChatUrl of [undefined, "https://chatgpt.com/", "https://elsewhere.test/c/owned-conversation",
    "https://chatgpt.com/c/owned-conversation?temporary-chat=true", "https://chatgpt.com/c/owned-conversation#fragment", "https://user@chatgpt.com/c/owned-conversation"]) {
    assert.throws(() => browserScript({ ...base, operation: "rollover", previousChatUrl, expectedOwnerTurnIds: [base.turnId] }), /exact previous saved chat URL/);
  }
  for (const change of [{ url: "https://chatgpt.com/" }, { url: "https://elsewhere.test/c/owned" },
    { url: "https://chatgpt.com/c/owned-conversation?temporary-chat=true" }, { tabId: "" },
    { assistantPrefix: { sha256: "bad", length: 1 } }, { assistantPrefix: { ...recovery.assistantPrefix, length: 0 } }, { completed: undefined }]) {
    assert.throws(() => browserScript({ ...continuation, recovery: { ...recovery, ...change } }), /confirmed owned chat and observed assistant reply/u);
  }
  assert.throws(() => browserScript({ ...base, operation: "observe", recovery }), /confirmed owned chat and observed assistant reply/u);
});
