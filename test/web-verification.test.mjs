import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { browserScript } from '../src/web-browser.mjs';
import { validWebConversation } from '../src/web-runtime.mjs';
import { evaluateWebPhase, parseWebJsonLines, prepareWebVerification, waitWebVerification, watchWebEvidence, webVerificationPrompt } from '../maintenance/web-verification.mjs';

const threadId = '01a16fe6-04f4-7882-abd1-7ef5b26c5b65';
const turnId = '01a170a7-9be0-7200-98bd-045683e5f699';
const generation = '3927100f-af8d-4e10-9570-cf7d599b2f39';
const generationTurnKey = '5ce680b6-c314-4d8d-a4f8-37678d39c093';
const at = '2026-10-24T22:00:01.000Z';
const marker = 'WEB_NATIVE_MARKER_PRIVATE_CANARY';
const baseline = { bindingId: 'unit_test', tabId: '1', chatUrl: 'https://chatgpt.com/c/private-canary' };
const authority = { at, code: 'authority_cached', generation, threadId, turnId, authorityDigest: 'a'.repeat(64), canonicalDigest: 'b'.repeat(64) };
const row = (type, payload) => ({ type, timestamp: at, payload });
const jsonLines = rows => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value), 'utf8');
function continuedRecoveryLedger(ledger) {
  const failedTurnId = '01a170a7-9be0-7200-98bd-045683e5f698', replyId = '01a170a7-9be0-7200-98bd-045683e5f697';
  const prefix = value => ({ length: value.length, sha256: createHash('sha256').update(value).digest('hex') });
  const value = { ...structuredClone(ledger), version: 2, browserOwnerTurnIds: [ledger.lastTurn.turnId], checkpoint: ['c'.repeat(64)],
    sendBaseline: 0, sendBaselineReplyIds: [], generationReplyIds: [replyId],
    observation: { replyCount: 1, replyId, completed: true, assistantPrefix: prefix(marker) },
    recovery: { stage: 'continued', ledgerSha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64), confirmationSha256: 'c'.repeat(64),
      revokedTurnIds: [failedTurnId], inputHashes: ['d'.repeat(64)],
      proof: { chatUrl: ledger.chatUrl, tabId: String(ledger.tabId), failedTurnId, generationTurnKey: generation,
        sendBaselineReplyIds: [], generationReplyIds: [replyId], observation: { replyId, completed: true, assistantPrefix: prefix('Prior accepted answer') } } } };
  assert.equal(validWebConversation(value, value.threadId), true, 'The fixture must satisfy the maintained complete V2 runtime schema.');
  return value;
}

function evidence(phase = 'ready') {
  const completed = !['ready', 'stop'].includes(phase);
  const run = { version: 1, threadId, createdAt: '2026-10-24T22:00:00.000Z', baseline: { ...baseline }, marker,
    fixturePath: 'E:\\private\\native-fixture.txt', phases: { stop: { status: 'passed' } },
    ready: { ...authority, generationTurnKey } };
  const ledger = { version: 1, threadId, ...baseline, generationTurnKey, generationCompleted: completed,
    lastTurn: { turnId, sendState: 'sent', completed }, uncertainSend: false, unresolvedCoding: [] };
  const rows = [row('session_meta', { id: threadId }), row('event_msg', { type: 'task_started', turn_id: turnId }),
    row('response_item', { type: 'function_call_output', id: 'd'.repeat(40), name: 'send_message_to_thread', namespace: 'codex_app',
      output: 'PRIVATE_INCOMING_PROMPT_CANARY', internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: Date.parse(at) / 1000 } })];
  let counter = 0;
  const addBrowser = (operation, fields = {}) => {
    const callId = `call_router_web_${String(++counter).padStart(32, '0')}`;
    const token = `frame_${String(counter).padStart(16, '0')}`;
    const options = { bindingId: baseline.bindingId, sessionId: threadId, turnId, operation, frameToken: token,
      ...(operation === 'send' ? { prompt: 'a prompt without the private marker', modelFamily: 'GPT-6', power: 0 } : {}),
      ...(operation === 'continue' ? { expectedOwnerTurnIds: ['prior-turn'], interruptedTurnId: 'prior-turn' } : {}) };
    const frame = { operation, normal: true, url: baseline.chatUrl, tabId: '1', ...fields };
    rows.push(row('response_item', { type: 'function_call', call_id: callId, name: 'mcp__node_repl.js', arguments: JSON.stringify({ code: browserScript(options) }) }));
    rows.push(row('response_item', { type: 'function_call_output', call_id: callId,
      output: { content: [{ type: 'text', text: `ROUTER_WEB_BROWSER_${token}_BEGIN\n${JSON.stringify({ routerBrowser: frame })}\nROUTER_WEB_BROWSER_${token}_END` }] } }));
    return { options, frame, output: rows.at(-1).payload, call: rows.at(-2).payload };
  };
  const continuation = addBrowser('continue');
  const send = addBrowser('send', { sent: true });
  const observation = addBrowser('observe', { generationTurnKey, completed, stopVisible: !completed });
  if (completed) {
    addBrowser('retain', { retained: true, completed: true, stopVisible: false });
    rows.push(row('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: marker }] }));
    rows.push(row('event_msg', { type: 'task_complete', turn_id: turnId }));
  }
  const eventRows = [{ ...authority }];
  if (phase === 'native') {
    rows.splice(rows.length - 2, 0,
      row('response_item', { type: 'function_call', call_id: 'native-command', name: 'exec_command', arguments: JSON.stringify({ cmd: `Get-Content -LiteralPath '${run.fixturePath}' -Raw -Encoding UTF8` }) }),
      row('response_item', { type: 'function_call_output', call_id: 'native-command', output: `Chunk ID: 42\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\n${marker}\r\n` }));
  }
  if (phase === 'stop') {
    rows.push(row('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }));
    eventRows.push({ at, code: 'stop_native_dispatched', generation, requestDigest: 'c'.repeat(64) },
      { at, code: 'stop_confirmed', generation, requestDigest: 'c'.repeat(64), outcome: 'cancelled', stage: 'complete',
        clickAttempted: true, clickError: false, stopClicked: true, stopHidden: true, inactivityEvidence: 'composer_restored',
        generationInactive: true, retained: true, childTerminalObserved: true });
  }
  return { run, phase, turnId, sessionRows: rows, eventRows, ledger, fixtureText: `${marker}\n`, continuation, send, observation };
}

function replaceFrame(record) {
  const text = record.output.output.content[0].text;
  record.output.output.content[0].text = text.replace(/\n\{[^\n]+\}\n/u, `\n${JSON.stringify({ routerBrowser: record.frame })}\n`);
}

function continuationCacheMiss(input, fields = {}) {
  const full = structuredClone(input.continuation);
  full.options.fullContinuation = true;
  full.options.frameToken = 'frame_full_0000000000000001';
  full.call.call_id = `call_router_web_${'f'.repeat(32)}`;
  full.call.arguments = JSON.stringify({ code: browserScript(full.options) });
  full.output.call_id = full.call.call_id;
  Object.assign(full.frame, fields);
  full.output.output.content[0].text = `ROUTER_WEB_BROWSER_${full.options.frameToken}_BEGIN\n${JSON.stringify({ routerBrowser: full.frame })}\nROUTER_WEB_BROWSER_${full.options.frameToken}_END`;
  input.continuation.frame = { operation: 'continue', needsFullContinuation: true, noActions: true };
  replaceFrame(input.continuation);
  const index = input.sessionRows.findIndex(entry => entry.payload === input.continuation.output);
  input.sessionRows.splice(index + 1, 0, row('response_item', full.call), row('response_item', full.output));
  return full;
}

function withModelIdentity(input, { model = 'chatgpt-web/gpt-6-sol', effort = 'medium', family = 'GPT-6', power = 1 } = {}) {
  Object.assign(input.run, { model, effort, selection: { family, power } });
  const context = row('turn_context', { turn_id: turnId, model, effort });
  input.sessionRows.splice(2, 0, context);
  Object.assign(input.send.options, { modelFamily: family, power });
  input.send.call.arguments = JSON.stringify({ code: browserScript(input.send.options) });
  input.context = context;
  return input;
}

function addModelSwitchPrefix(input, { hostSkills = false } = {}) {
  const shapes = [['model_switch.instructions'], [...(hostSkills ? ['host_skills.instructions'] : []), 'collaboration_mode.instructions']];
  const prefix = shapes.map((kinds, index) => row('response_item', {
    type: 'message', id: `switch-${index}`, role: 'developer', content: kinds.map(() => ({ type: 'input_text', text: 'PRIVATE_SWITCH_CANARY' })),
    internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: Date.parse(at) / 1000,
      content_item_kinds: kinds, content_item_metadata: kinds.map(() => ({})) },
  }));
  input.sessionRows.splice(2, 0, ...prefix);
  return prefix;
}

test('readiness requires accepted Send, the current generation, and canonical paired browser evidence', () => {
  const input = evidence();
  assert.equal(evaluateWebPhase(input).receipt.status, 'passed');
  input.ledger.lastTurn.sendState = 'sending';
  assert.equal(evaluateWebPhase(input).receipt.status, 'pending');
  input.ledger.lastTurn.sendState = 'sent';
  input.ledger.uncertainSend = true;
  assert.equal(evaluateWebPhase(input).receipt.status, 'pending', 'a provisional Send awaits its actual acknowledgement');
  input.ledger.uncertainSend = false;
  input.observation.frame.generationTurnKey = 'stale-generation'; replaceFrame(input.observation);
  assert.equal(evaluateWebPhase(input).receipt.currentGenerationObserved, false);
  assert.equal(evaluateWebPhase(input).receipt.status, 'pending');
});

test('verification evaluates continued V2 recovery ledgers while invalid journals and abandoned baselines never qualify', () => {
  for (const phase of ['native', 'recall', 'continuation']) {
    const input = evidence(phase); input.ledger = continuedRecoveryLedger(input.ledger);
    assert.equal(evaluateWebPhase(input).receipt.status, 'passed', phase);
    delete input.ledger.recovery.confirmationSha256;
    assert.equal(evaluateWebPhase(input).receipt.code, 'unsupported_ledger');
  }
});

test('readiness refuses malformed delivery, duplicate calls, wrong sessions, and terminal completion', () => {
  for (const [mutate, code] of [
    [input => { delete input.ledger.uncertainSend; }, 'unsupported_ledger'],
    [input => { input.sessionRows.push(input.sessionRows.find(entry => entry.payload?.type === 'function_call')); }, 'duplicate_or_invalid_call'],
    [input => { input.sessionRows[0].payload.id = generation; }, 'session_thread_mismatch'],
    [input => { input.sessionRows.push(row('event_msg', { type: 'task_complete', turn_id: turnId })); }, 'completed_before_native_stop'],
    [input => { input.run.createdAt = '2026-10-24T22:00:02.000Z'; }, 'stale_turn'],
  ]) {
    const input = evidence(); mutate(input);
    assert.equal(evaluateWebPhase(input).receipt.code, code);
  }
});

test('a dispatched Send qualifies only through later accepted anchored evidence, without hiding duplicate attempts', () => {
  const dispatched = input => {
    Object.assign(input.send.frame, { sent: false, dispatched: true, generationPending: true,
      baselineReplyIds: [], conversationFull: false });
    replaceFrame(input.send);
    return input;
  };
  for (const phase of ['native', 'recall', 'ready', 'stop', 'continuation']) {
    const result = evaluateWebPhase(dispatched(withModelIdentity(evidence(phase))));
    assert.equal(result.receipt.status, 'passed', `${phase}: ${result.receipt.code}`);
    assert.equal(result.receipt.browserSelectionVerified, true);
  }
  const unaccepted = dispatched(evidence());
  unaccepted.ledger.uncertainSend = true;
  assert.equal(evaluateWebPhase(unaccepted).receipt.status, 'pending');
  const unanchored = dispatched(evidence());
  delete unanchored.observation.frame.generationTurnKey;
  replaceFrame(unanchored.observation);
  assert.equal(evaluateWebPhase(unanchored).receipt.status, 'pending');
  for (const mutate of [frame => { frame.generationPending = false; }, frame => { frame.extra = true; },
    frame => { frame.baselineReplyIds = ['unverified']; }, frame => { frame.baselineReplyIds = [[generationTurnKey]]; },
    frame => { frame.baselineReplyIds = [generationTurnKey, generationTurnKey]; }]) {
    const input = dispatched(evidence()); mutate(input.send.frame); replaceFrame(input.send);
    assert.equal(evaluateWebPhase(input).receipt.code, 'unsupported_send_receipt');
  }
  const duplicate = dispatched(evidence());
  const call = structuredClone(duplicate.send.call), output = structuredClone(duplicate.send.output);
  call.call_id = `call_router_web_${'e'.repeat(32)}`; output.call_id = call.call_id;
  duplicate.sessionRows.push(row('response_item', call), row('response_item', output));
  assert.equal(evaluateWebPhase(duplicate).receipt.code, 'duplicate_send');
  duplicate.sessionRows.pop();
  assert.equal(evaluateWebPhase(duplicate).receipt.code, 'duplicate_send', 'an unpaired duplicate still represents another Send attempt');
});

test('app prompt ingress is recognized only in its exact first-item envelope; ordinary orphan outputs fail', () => {
  assert.equal(evaluateWebPhase(evidence('native')).receipt.status, 'passed');
  for (const mutate of [
    input => { input.sessionRows[2].payload.namespace = 'foreign'; },
    input => { input.sessionRows[2].payload.name = 'exec_command'; },
    input => { input.sessionRows[2].payload.internal_chat_message_metadata_passthrough.turn_id = generation; },
    input => { input.sessionRows.push(structuredClone(input.sessionRows[2])); },
  ]) {
    const input = evidence('native'); mutate(input);
    assert.equal(evaluateWebPhase(input).receipt.code, 'unsupported_app_prompt_ingress');
  }
  const orphan = evidence('native');
  orphan.sessionRows.push(row('response_item', { type: 'function_call_output', call_id: 'orphan-native-output', output: marker }));
  assert.equal(evaluateWebPhase(orphan).receipt.code, 'unpaired_output');
});

test('a model-switch prefix permits the exact following ingress and rejects changed or extra envelopes', () => {
  for (const hostSkills of [false, true]) {
    const input = withModelIdentity(evidence('native'));
    addModelSwitchPrefix(input, { hostSkills });
    assert.equal(evaluateWebPhase(input).receipt.status, 'passed');
  }
  for (const mutate of [
    prefix => { prefix[0].payload.internal_chat_message_metadata_passthrough.turn_id = generation; },
    prefix => { prefix[0].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['PRIVATE_UNKNOWN_KIND']; },
    prefix => { prefix[1].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['model_switch.instructions']; },
    prefix => { prefix[0].payload.content[0].type = 'output_text'; },
    prefix => { prefix[0].payload.internal_chat_message_metadata_passthrough.create_time = null; },
  ]) {
    const invalid = withModelIdentity(evidence('native')), prefix = addModelSwitchPrefix(invalid);
    mutate(prefix);
    const receipt = evaluateWebPhase(invalid).receipt;
    assert.equal(receipt.code, 'unsupported_app_model_switch_prefix');
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE/u);
  }
  const truncated = withModelIdentity(evidence('native')); addModelSwitchPrefix(truncated); truncated.sessionRows.splice(3, 1);
  assert.equal(evaluateWebPhase(truncated).receipt.code, 'unsupported_app_prompt_ingress');
  const extra = withModelIdentity(evidence('native')), prefix = addModelSwitchPrefix(extra);
  extra.sessionRows.splice(4, 0, structuredClone(prefix[1]));
  assert.equal(evaluateWebPhase(extra).receipt.code, 'unsupported_app_model_switch_prefix');
  for (const mutate of [
    prefix => { prefix[1].payload.internal_chat_message_metadata_passthrough.content_item_kinds.reverse(); },
    prefix => { prefix[1].payload.content.pop(); },
    prefix => { prefix[1].payload.internal_chat_message_metadata_passthrough.content_item_metadata.pop(); },
  ]) {
    const invalid = withModelIdentity(evidence('native')), expanded = addModelSwitchPrefix(invalid, { hostSkills: true });
    mutate(expanded);
    assert.equal(evaluateWebPhase(invalid).receipt.code, 'unsupported_app_model_switch_prefix');
  }
  const duplicate = withModelIdentity(evidence('native')); addModelSwitchPrefix(duplicate);
  duplicate.sessionRows.push(structuredClone(duplicate.sessionRows.find(entry => entry.payload?.name === 'send_message_to_thread')));
  assert.equal(evaluateWebPhase(duplicate).receipt.code, 'unsupported_app_prompt_ingress');
});

test('every phase with an expected route proves the selected native model, effort and pre-Send browser selection', () => {
  for (const phase of ['native', 'recall', 'ready', 'stop', 'continuation']) {
    for (const identity of [{}, { model: 'chatgpt-web/gpt-6-pro', effort: 'max', family: 'GPT-6', power: 4 }]) {
      const input = withModelIdentity(evidence(phase), identity), receipt = evaluateWebPhase(input).receipt;
      assert.equal(receipt.status, 'passed', `${phase}: ${receipt.code}`);
      assert.equal(receipt.expectedModel, input.run.model); assert.equal(receipt.observedModel, input.run.model);
      assert.equal(receipt.expectedEffort, input.run.effort); assert.equal(receipt.observedEffort, input.run.effort);
      assert.equal(receipt.expectedFamily, input.run.selection.family); assert.equal(receipt.observedFamily, input.run.selection.family);
      assert.equal(receipt.expectedPower, input.run.selection.power); assert.equal(receipt.observedPower, input.run.selection.power);
      assert.equal(receipt.nativeModelVerified, true); assert.equal(receipt.browserSelectionVerified, true);
      input.context.payload.effort = 'low';
      assert.equal(evaluateWebPhase(input).receipt.code, 'native_model_or_effort_mismatch');
    }
  }
});

test('model evidence rejects wrong or ambiguous native identity and mismatched browser family or Power', () => {
  for (const mutate of [
    input => { input.context.payload.model = 'chatgpt-web/gpt-5.6-sol'; },
    input => { input.context.payload.effort = 'high'; },
    input => { input.context.payload.turn_id = generation; },
    input => { delete input.context.payload.effort; },
    input => { input.context.payload.model = 'PRIVATE_MODEL_CANARY'; input.context.payload.effort = 'PRIVATE_EFFORT_CANARY'; },
  ]) {
    const input = withModelIdentity(evidence('native')); mutate(input);
    const receipt = evaluateWebPhase(input).receipt;
    assert.equal(receipt.code, 'native_model_or_effort_mismatch');
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE/u);
  }
  const duplicated = withModelIdentity(evidence('native')); duplicated.sessionRows.push(structuredClone(duplicated.context));
  assert.equal(evaluateWebPhase(duplicated).receipt.code, 'ambiguous_native_model_context');
  for (const mutation of [{ modelFamily: 'GPT-5.6 Sol' }, { power: 4 }]) {
    const input = withModelIdentity(evidence('native')), record = input.send;
    Object.assign(record.options, mutation); record.call.arguments = JSON.stringify({ code: browserScript(record.options) });
    assert.equal(evaluateWebPhase(input).receipt.code, 'browser_model_or_power_mismatch');
  }
  const missing = withModelIdentity(evidence('native'));
  missing.sessionRows = missing.sessionRows.filter(entry => entry !== missing.context);
  assert.equal(evaluateWebPhase(missing).receipt.code, 'native_model_context_missing');
  const awaiting = withModelIdentity(evidence('ready'));
  awaiting.sessionRows = awaiting.sessionRows.filter(entry => entry !== awaiting.context);
  assert.equal(evaluateWebPhase(awaiting).receipt.status, 'pending', 'an unfinished context append waits on the existing event barrier');
  const invalidExpected = withModelIdentity(evidence('native')); invalidExpected.run.selection.power = 2;
  assert.equal(evaluateWebPhase(invalidExpected).receipt.code, 'expected_selection_mismatch');
});

test('canonical browser results need no invented ok flag and real error results remain rejected', () => {
  const input = evidence('native');
  assert.equal(Object.hasOwn(input.observation.frame, 'ok'), false);
  assert.equal(evaluateWebPhase(input).receipt.status, 'passed');
  input.observation.output.output = { isError: true, content: [{ type: 'text', text: 'PRIVATE_TOOL_ERROR_CANARY' }] };
  const failed = evaluateWebPhase(input).receipt;
  assert.equal(failed.code, 'unsupported_browser_output');
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/u);
  const requestError = evidence('ready');
  requestError.observation.frame.requestError = 'unknown_error'; replaceFrame(requestError.observation);
  assert.equal(evaluateWebPhase(requestError).receipt.code, 'browser_request_error');
});

test('a real native interruption and matching terminal Stop receipt are independently necessary', () => {
  const input = evidence('stop');
  assert.equal(evaluateWebPhase(input).receipt.status, 'passed');
  input.sessionRows.pop();
  assert.equal(evaluateWebPhase(input).receipt.status, 'pending', 'browser cleanup cannot stand in for native Stop');
  input.sessionRows.push(row('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }));
  input.eventRows.pop();
  assert.equal(evaluateWebPhase(input).receipt.status, 'pending', 'dispatch is not a terminal acknowledgement');
});

test('only the final owned Stop observation may carry the actual native interruption terminal', () => {
  const input = evidence('stop');
  input.observation.output.output = 'aborted by user after 47.1s';
  assert.equal(evaluateWebPhase(input).receipt.status, 'passed');
  input.sessionRows.pop();
  assert.equal(evaluateWebPhase(input).receipt.status, 'pending', 'a cancellation-shaped output is not native interruption proof');
  input.sessionRows.push(row('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }));
  input.eventRows.pop();
  assert.equal(evaluateWebPhase(input).receipt.status, 'pending', 'a cancellation-shaped output is not adapter terminal proof');
  const ordinary = evidence('native'); ordinary.observation.output.output = 'aborted by user after 47.1s';
  assert.equal(evaluateWebPhase(ordinary).receipt.code, 'unsupported_browser_output');
  const malformed = evidence('stop'); malformed.observation.output.output = 'PRIVATE_CANCEL_LOOKALIKE';
  assert.equal(evaluateWebPhase(malformed).receipt.code, 'unsupported_browser_output');
  const notLast = evidence('stop'); notLast.send.output.output = 'aborted by user after 47.1s';
  assert.equal(evaluateWebPhase(notLast).receipt.code, 'unsupported_browser_output');
});

test('Stop rejects receipt mismatch, already-idle cleanup, and a result without an actual child terminal', () => {
  for (const [key, value, code] of [
    ['requestDigest', 'd'.repeat(64), 'stop_request_mismatch'],
    ['outcome', 'already_idle', 'native_stop_unconfirmed'],
    ['childTerminalObserved', false, 'native_stop_unconfirmed'],
    ['retained', null, 'native_stop_unconfirmed'],
  ]) {
    const input = evidence('stop'); input.eventRows.at(-1)[key] = value;
    assert.equal(evaluateWebPhase(input).receipt.code, code);
  }
  const replaced = evidence('stop');
  replaced.eventRows.push({ ...authority, turnId: generation });
  assert.equal(evaluateWebPhase(replaced).receipt.code, 'stop_authority_replaced');
});

test('continuation needs completed retention and cannot claim unproved recovery or a changed tab', () => {
  const input = evidence('continuation');
  assert.equal(evaluateWebPhase(input).receipt.status, 'passed');
  input.continuation.frame.recovered = true; replaceFrame(input.continuation);
  assert.equal(evaluateWebPhase(input).receipt.code, 'browser_recovery_or_rollover');
  delete input.continuation.frame.recovered; replaceFrame(input.continuation);
  input.ledger.tabId = 'reopened-tab';
  assert.equal(evaluateWebPhase(input).receipt.code, 'saved_binding_changed');
});

test('a framed cache miss permits one full continuation with verified same-tab restoration', () => {
  for (const fields of [{}, { recovered: true, bindingRestored: true, tabReopened: false, tabNavigated: false }]) {
    const input = evidence('continuation');
    continuationCacheMiss(input, fields);
    const receipt = evaluateWebPhase(input).receipt;
    assert.equal(receipt.status, 'passed', receipt.code);
    assert.equal(receipt.continuationCacheMiss, true);
    assert.equal(receipt.recoveryBranchExecuted, fields.recovered === true);
    assert.equal(receipt.bindingRestored, fields.recovered === true);
  }
  for (const fields of [
    { recovered: true },
    { recovered: true, bindingRestored: true, tabReopened: true, tabNavigated: false },
    { recovered: true, bindingRestored: true, tabReopened: false, tabNavigated: true },
    { recovered: true, bindingRestored: true, tabReopened: false },
    { recovered: true, bindingRestored: true, tabReopened: false, tabNavigated: false, tabId: 'another-tab' },
  ]) {
    const input = evidence('continuation'); continuationCacheMiss(input, fields);
    assert.notEqual(evaluateWebPhase(input).receipt.status, 'passed');
  }
});

test('cache fallback rejects malformed, repeated and missing full continuation evidence', () => {
  for (const fields of [{ noActions: false }, { extra: true }, { operation: 'send' }]) {
    const input = evidence('continuation'); continuationCacheMiss(input);
    Object.assign(input.continuation.frame, fields); replaceFrame(input.continuation);
    assert.equal(evaluateWebPhase(input).receipt.code, 'invalid_continuation_cache_miss');
  }
  const repeated = evidence('continuation'), full = continuationCacheMiss(repeated);
  full.frame = { operation: 'continue', needsFullContinuation: true, noActions: true }; replaceFrame(full);
  assert.equal(evaluateWebPhase(repeated).receipt.code, 'invalid_continuation_cache_miss');
  const missing = evidence('continuation'); const omitted = continuationCacheMiss(missing);
  missing.sessionRows = missing.sessionRows.filter(entry => entry.payload.call_id !== omitted.call.call_id);
  assert.equal(evaluateWebPhase(missing).receipt.code, 'full_continuation_required');
  const unsolicited = evidence('continuation');
  unsolicited.continuation.options.fullContinuation = true;
  unsolicited.continuation.call.arguments = JSON.stringify({ code: browserScript(unsolicited.continuation.options) });
  assert.equal(evaluateWebPhase(unsolicited).receipt.code, 'unexpected_full_continuation');
});

test('native verification requires one exact paired command and its real exit/output framing', () => {
  const input = evidence('native');
  assert.equal(evaluateWebPhase(input).receipt.status, 'passed');
  const output = input.sessionRows.find(entry => entry.payload?.call_id === 'native-command' && entry.payload.type.endsWith('_output'));
  output.payload.output = output.payload.output.replace('code 0', 'code 1');
  assert.equal(evaluateWebPhase(input).receipt.code, 'native_command_output_failed');
  input.sessionRows = input.sessionRows.filter(entry => entry.payload?.call_id !== 'native-command');
  const result = evaluateWebPhase(input).receipt;
  assert.equal(result.code, 'native_command_missing'); assert.equal(result.nativeCommandCount, 0);
});

test('zero-exec safety refusal cannot pass and private canaries never enter receipts', () => {
  const input = evidence('native');
  input.sessionRows = input.sessionRows.filter(entry => entry.payload?.call_id !== 'native-command');
  input.sessionRows.find(entry => entry.payload?.phase === 'final_answer').payload.content[0].text = `I cannot execute commands. PRIVATE_PROVIDER_CANARY ${marker}`;
  const receipt = evaluateWebPhase(input).receipt;
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.nativeCommandCount, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|chatgpt|unit_test|native-fixture|compiler/u);
  const prompts = ['native', 'recall', 'ready', 'continuation'].map(phase => webVerificationPrompt(input.run, phase));
  assert.ok(prompts.every(prompt => !prompt.includes(marker)));
  const malformed = evidence('stop'); malformed.eventRows.at(-1).childTerminalObserved = 'PRIVATE_TERMINAL_CANARY';
  assert.doesNotMatch(JSON.stringify(evaluateWebPhase(malformed).receipt), /PRIVATE/u);
  assert.match(webVerificationPrompt(input.run, 'ready'), /call codex_tools_list exactly once with the query exec_command/u);
});

test('JSONL append watcher waits for a truncated line to finish without polling', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-evidence-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'evidence.jsonl'); writeFileSync(file, '');
  let inspections = 0;
  const result = await watchWebEvidence([file], () => {
    inspections++;
    const parsed = parseWebJsonLines(readFileSync(file, 'utf8'));
    if (inspections === 1) setImmediate(() => writeFileSync(file, '{"finished":'));
    if (inspections === 2) setImmediate(() => writeFileSync(file, '{"finished":true}\n'));
    return { receipt: { status: parsed[0]?.finished === true ? 'passed' : 'pending' } };
  }, { timeoutMs: 2000 });
  assert.equal(result.receipt.status, 'passed'); assert.ok(inspections >= 3);
  assert.throws(() => parseWebJsonLines('not-json\n'), /unsupported_jsonl/u);
});

test('deadline inspects once more and preserves terminal evidence without a change event', async () => {
  for (const finalReceipt of [{ status: 'passed', code: 'verified' }, { status: 'failed', code: 'fixture_changed' }, { status: 'pending' }]) {
    let reads = 0, closes = 0, clears = 0, fire;
    let receipt = { status: 'pending' };
    const timer = {};
    const waiting = watchWebEvidence(['test/evidence.jsonl'], () => { reads++; return { receipt }; }, {
      watchFile: () => Object.assign(new EventEmitter(), { close: () => { closes++; } }),
      setTimer: callback => { fire = callback; return timer; },
      clearTimer: value => { assert.equal(value, timer); clears++; },
    });
    receipt = finalReceipt;
    fire();
    if (finalReceipt.status === 'pending') await assert.rejects(waiting, /evidence_deadline/u);
    else assert.deepEqual((await waiting).receipt, finalReceipt);
    assert.equal(reads, 2); assert.equal(closes, 1); assert.equal(clears, 1);
  }
});

test('deadline rejects an inspection error and closes its resources', async () => {
  let reads = 0, closes = 0, clears = 0, fire;
  const waiting = watchWebEvidence(['test/evidence.jsonl'], () => {
    if (++reads === 2) throw new Error('private detail');
    return { receipt: { status: 'pending' } };
  }, {
    watchFile: () => Object.assign(new EventEmitter(), { close: () => { closes++; } }),
    setTimer: callback => { fire = callback; return 1; }, clearTimer: () => { clears++; },
  });
  fire();
  await assert.rejects(waiting, /evidence_read_failed/u);
  assert.equal(closes, 1); assert.equal(clears, 1);
});

test('waiting fails closed on changed installed identity and records a non-retriable sanitized receipt', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-phase-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = evidence('native'), run = input.run;
  for (const [key, name] of [['rolloutPath', 'rollout.jsonl'], ['eventPath', 'events.jsonl'], ['ledgerPath', 'ledger.json'], ['fixturePath', 'fixture.txt']]) run[key] = path.join(directory, name);
  writeFileSync(run.rolloutPath, jsonLines(input.sessionRows)); writeFileSync(run.eventPath, jsonLines(input.eventRows)); writeJson(run.ledgerPath, input.ledger); writeFileSync(run.fixturePath, marker);
  const runtimeFile = path.join(directory, 'installed.json'); writeFileSync(runtimeFile, 'PRIVATE_RUNTIME_CANARY');
  Object.assign(run, { phases: {}, eventOffset: 0, snapshots: [{ path: runtimeFile, sha256: 'e'.repeat(64) }], officialIdentity: {}, fixtureSha256: 'f'.repeat(64) });
  const runPath = path.join(directory, 'run.json'); writeJson(runPath, run);
  const result = await waitWebVerification({ runPath, phase: 'native', turnId }, { assertIdentity: () => {}, writeJson });
  assert.equal(result.code, 'installed_identity_changed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|installed\.json/u);
  await assert.rejects(waitWebVerification({ runPath, phase: 'native', turnId }, { assertIdentity: () => {}, writeJson }), /phase_already_recorded_no_retry/u);
});

test('ready wait observes provisional Send then accepted Send through a change event barrier', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-ready-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = evidence('ready'), run = input.run;
  for (const [key, name] of [['rolloutPath', 'rollout.jsonl'], ['eventPath', 'events.jsonl'], ['ledgerPath', 'ledger.json'], ['fixturePath', 'fixture.txt']]) run[key] = path.join(directory, name);
  writeFileSync(run.rolloutPath, jsonLines(input.sessionRows)); writeFileSync(run.eventPath, jsonLines(input.eventRows)); writeFileSync(run.fixturePath, marker);
  input.ledger.uncertainSend = true; input.ledger.unresolvedCoding = [{ current: 'provisional' }]; writeJson(run.ledgerPath, input.ledger);
  Object.assign(run, { phases: { recall: { status: 'passed', turnId: generation } }, eventOffset: 0, snapshots: [], officialIdentity: {},
    fixtureSha256: createHash('sha256').update(marker).digest('hex') });
  const runPath = path.join(directory, 'run.json'); writeJson(runPath, run);
  let observed = 0, notify;
  const receipt = await waitWebVerification({ runPath, phase: 'ready', turnId, timeoutMs: 2000 }, {
    writeJson,
    watchFile: (_directory, callback) => { notify = callback; return Object.assign(new EventEmitter(), { close() {} }); },
    assertIdentity: () => {
      if (++observed !== 1) return;
      setImmediate(() => {
        assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).phases.ready, undefined, 'provisional evidence did not persist a failure');
        input.ledger.uncertainSend = false; input.ledger.unresolvedCoding = []; writeJson(run.ledgerPath, input.ledger);
        notify('change', path.basename(run.ledgerPath));
      });
    },
  });
  assert.equal(observed, 2); assert.equal(receipt.status, 'passed'); assert.equal(receipt.acceptedSend, true);
});

test('prepare binds exact thread and snapshots rollback inputs without changing them', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-prepare-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, 'source'), stateDir = path.join(directory, 'state'), codexHome = path.join(directory, 'home');
  for (const sub of [path.join(sourceRoot, 'generated'), path.join(stateDir, 'web-in-app', 'conversations'), path.join(stateDir, 'web-stop-adapter', 'managed'), codexHome]) mkdirSync(sub, { recursive: true });
  const input = evidence('recall'), ledgerFile = path.join(stateDir, 'web-in-app', 'conversations', `${threadId}.json`);
  writeJson(ledgerFile, input.ledger);
  const adapterFile = path.join(stateDir, 'web-stop-adapter', 'ownership.json');
  writeJson(adapterFile, { owner: 'codex-router-web-stop-adapter-v1', version: 1, state: 'installed', generation: 'f'.repeat(64), managedDirectory: path.join(stateDir, 'web-stop-adapter', 'managed') });
  for (const file of [path.join(stateDir, 'web-stop-adapter', 'managed', 'manifest.json'), path.join(codexHome, 'hooks.json'), path.join(stateDir, 'install.json')]) writeJson(file, { privateCanary: 'PRIVATE_ROLLBACK_CANARY' });
  writeFileSync(path.join(stateDir, 'web-stop-adapter', 'events.jsonl'), '');
  const rollout = path.join(directory, 'rollout.jsonl'); writeFileSync(rollout, jsonLines(input.sessionRows));
  const before = readFileSync(ledgerFile, 'utf8'), dependencies = { sourceRoot, stateDir, codexHome, installManifestPath: path.join(stateDir, 'install.json'),
    codexIdentity: () => ({ binary: 'official.exe', version: 'current', fingerprint: 'known' }), writeFile: writeFileSync, writeJson };
  const output = path.join(sourceRoot, 'generated', 'fresh');
  const result = prepareWebVerification({ threadId, output, rollout }, dependencies);
  assert.equal(result.prepared, true); assert.equal(readFileSync(ledgerFile, 'utf8'), before);
  const run = JSON.parse(readFileSync(result.runPath, 'utf8'));
  assert.match(run.marker, /^WEB_NATIVE_MARKER_[a-f0-9]{32}$/u); assert.equal(run.snapshots.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|MARKER|rollback/u);
  assert.throws(() => prepareWebVerification({ threadId, output, rollout }, dependencies), /fresh_generated_directory_required/u);
  for (const options of [{ model: 'chatgpt-web/gpt-6-pro' }, { effort: 'max' }]) {
    assert.throws(() => prepareWebVerification({ threadId, output, rollout, ...options }, dependencies), /model_and_effort_required_together/u);
  }
  for (const [model, effort] of [['chatgpt-web/gpt-6-pro', 'medium'], ['PRIVATE_UNKNOWN_MODEL', 'max'], ['chatgpt-web/gpt-6-pro', 'toString']]) {
    assert.throws(() => prepareWebVerification({ threadId, output, rollout, model, effort }, dependencies), /unsupported_model_or_effort/u);
  }
  const selected = prepareWebVerification({ threadId, output: path.join(sourceRoot, 'generated', 'selected'), rollout,
    model: 'chatgpt-web/gpt-6-pro', effort: 'max' }, dependencies);
  const selectedRun = JSON.parse(readFileSync(selected.runPath, 'utf8'));
  assert.deepEqual([selectedRun.model, selectedRun.effort, selectedRun.selection], ['chatgpt-web/gpt-6-pro', 'max', { family: 'GPT-6', power: 4 }]);
  assert.equal(readFileSync(ledgerFile, 'utf8'), before);
  const recovered = continuedRecoveryLedger(input.ledger);
  writeJson(ledgerFile, recovered);
  const recoveredBefore = readFileSync(ledgerFile, 'utf8');
  const protectedFile = path.join(directory, 'protected-v2-ledger.json');
  writeJson(protectedFile, { ...recovered, threadId: generation });
  const protectedBefore = readFileSync(protectedFile, 'utf8');
  const recoveredRun = prepareWebVerification({ threadId, output: path.join(sourceRoot, 'generated', 'recovered'), rollout, protectLedger: protectedFile }, dependencies);
  assert.equal(recoveredRun.prepared, true);
  assert.equal(readFileSync(ledgerFile, 'utf8'), recoveredBefore); assert.equal(readFileSync(protectedFile, 'utf8'), protectedBefore);
  assert.equal(JSON.parse(readFileSync(path.join(sourceRoot, 'generated', 'recovered', 'baseline-ledger.json'), 'utf8')).version, 2);
  for (const [kind, change, reason] of [
    ['malformed', value => { delete value.recovery.confirmationSha256; }, 'unsupported_ledger'],
    ['uncertain', value => { value.uncertainSend = true; value.lastTurn.completed = false; value.lastTurn.sendState = 'uncertain'; }, 'unsafe_ledger'],
    ['armed', value => { value.recovery.stage = 'armed'; value.uncertainSend = true; value.lastTurn = { turnId: value.recovery.proof.failedTurnId, sendState: 'uncertain', completed: false }; }, 'unsafe_ledger'],
    ['unresolved', value => { value.lastTurn.completed = false; value.unresolvedCoding = [{ callId: 'current-native-action', outputType: 'function_call_output' }]; }, 'unsafe_ledger'],
    ['bounded-notice', value => { value.recovery.stage = 'bounded'; value.lastTurn.sendState = 'abandoned'; }, 'baseline_not_completed'],
  ]) {
    const value = structuredClone(recovered); change(value); writeJson(ledgerFile, value);
    assert.throws(() => prepareWebVerification({ threadId, output: path.join(sourceRoot, 'generated', kind), rollout }, dependencies), new RegExp(reason, 'u'));
  }
  writeFileSync(ledgerFile, before, 'utf8');
  input.sessionRows[0].payload.id = turnId; writeFileSync(rollout, jsonLines(input.sessionRows));
  assert.throws(() => prepareWebVerification({ threadId, output: path.join(sourceRoot, 'generated', 'other'), rollout }, dependencies), /session_thread_mismatch/u);
});
