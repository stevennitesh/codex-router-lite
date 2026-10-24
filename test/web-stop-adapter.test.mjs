import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { browserHelperVersion, browserScript, parseBrowserOutput, readBrowserProgram } from '../src/web-browser.mjs';
import { createWebToolBroker } from '../src/web-tools.mjs';
import { startWebMcp } from '../src/web-mcp.mjs';
import { AdapterBridge, INTERRUPT_TOOL, ADAPTER_INFO, cleanupDecision, qualifyBrowserCall, readConfig, readIdentity, readStopResult, retainedMetadata, stopCode } from '../src/web-stop-adapter.mjs';

const APPROVED_THREAD = '01a14b65-a7a8-7b41-bd33-7c19d3c6df82';
const TURN = '01a14b65-a7a8-7b41-bd33-7c19d3c6df83';
const TURN2 = '01a14b65-a7a8-7b41-bd33-7c19d3c6df84';
const SESSION = '01a14b65-a7a8-7b41-bd33-7c19d3c6df85';
const GENERATION = '01a14b65-a7a8-7b41-bd33-7c19d3c6df86';
const SOURCE_SESSION = '01a14b65-a7a8-7b41-bd33-7c19d3c6df87';
const STOP_CONFIG = { stateDir: 'E:\\private-state', runtimeModule: 'E:\\official-runtime\\browser.mjs' };
const clone = value => structuredClone(value);
// Wall time only guards a missing fixture event; modeled behavior uses mock clocks.
const eventGuardTimer = globalThis.setTimeout, clearEventGuardTimer = globalThis.clearTimeout;

function recordedEvents(t) {
  const values = [], waiters = new Set();
  t.after(() => { for (const waiter of waiters) clearEventGuardTimer(waiter.guard); waiters.clear(); });
  return {
    values,
    record(value) {
      values.push(value);
      for (const waiter of waiters) if (waiter.matches(value)) { waiters.delete(waiter); waiter.resolve(value); }
    },
    waitFor(matches) {
      const value = values.find(matches);
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve: observed => { clearEventGuardTimer(waiter.guard); resolve(observed); } };
        waiter.guard = eventGuardTimer(() => { waiters.delete(waiter); reject(new Error('Expected fixture event was not observed.')); }, 10_000);
        waiter.guard.unref();
        waiters.add(waiter);
      });
    },
  };
}

function brokerWake(t, pending) {
  if (pending.wait.abort.signal.aborted) return Promise.resolve(pending.wait.reason);
  const events = recordedEvents(t);
  pending.wait.abort.signal.addEventListener('abort', () => events.record(pending.wait.reason), { once: true });
  return events.waitFor(() => true);
}
function canonical(turn = TURN) {
  return { thread_id: APPROVED_THREAD, turn_id: turn, session_id: SESSION,
    auto_review_enabled: true, node_repl_auto_review_required: true, node_repl_disabled: false,
    model: 'fixture', futureCanonical: { preserved: true } };
}
function ordinary(turn = TURN, operation = 'observe') {
  const config = { bindingId: 'fixtureBinding', sessionId: APPROVED_THREAD, turnId: turn, operation,
    frameToken: 'a'.repeat(48), runtimeModule: STOP_CONFIG.runtimeModule,
    ...(operation === 'send' ? { prompt: 'synthetic send fixture' } : {}) };
  const sandbox = { futureOpaque: ['private opaque value', { retained: true }], permissionProfile: { opaque: true } };
  return { name: 'js', arguments: { code: browserScript(config), timeout_ms: 30000 }, _meta: {
    threadId: APPROVED_THREAD, sessionId: SOURCE_SESSION, callId: `call_router_web_${'a'.repeat(32)}`,
    'x-codex-turn-metadata': canonical(turn), 'codex/sandbox-state': sandbox,
    'codex/sandbox-state-meta': clone(sandbox), 'codex/sandbox-launcher': { futureLauncher: 'private launcher value' },
    'openai/confirmation-policies': { browser_use: 'private originating policy' } } };
}
function hook(turn = TURN) {
  // Actual stock local bundled cleanup has only threadId metadata. Its session
  // argument follows source/root lineage, separate from canonical affinity.
  return { name: INTERRUPT_TOOL, arguments: { session_id: SOURCE_SESSION, turn_id: turn, hook_event_name: 'Interrupt' },
    _meta: { threadId: APPROVED_THREAD } };
}
function builtin(turn = TURN) { return { ...hook(turn), name: 'turn_ended' }; }
function withAuthority(params, marker) {
  const result = clone(params);
  result._meta['codex/sandbox-state'].futureTurnAuthority = marker;
  result._meta['codex/sandbox-state-meta'] = clone(result._meta['codex/sandbox-state']);
  result._meta['codex/sandbox-launcher'].futureTurnAuthority = marker;
  return result;
}
function asSubagent(params, field = 'parent_thread_id', serialized = false) {
  const source = clone(params), metadata = source._meta['x-codex-turn-metadata'];
  metadata[field] = field === 'parent_thread_id' ? SESSION : 'worker';
  if (serialized) source._meta['x-codex-turn-metadata'] = '  ' + JSON.stringify(metadata) + '\n';
  return source;
}
function cached(params = ordinary()) {
  const qualified = qualifyBrowserCall(params, STOP_CONFIG.runtimeModule);
  assert.ok(qualified);
  return { ...qualified, nativeMeta: clone(params._meta), aliasSessionId: params._meta.sessionId, generation: GENERATION };
}
const success = (overrides = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ systemMessage: 'ROUTER_WEB_STOP ' + JSON.stringify({
  outcome: 'cancelled', stage: 'complete', freshController: false, clickAttempted: true, clickError: false,
  stopClicked: true, stopHidden: true, generationInactive: true, inactivityEvidence: 'turn_complete',
  retained: true, elapsedMs: 25, ...overrides }) }) }] });
const ordinaryResult = { content: [{ type: 'text', text: '{}' }] };

test('only actual generated observation code gains cancellation grace', () => {
  const call = ordinary();
  assert.equal(qualifyBrowserCall(call, STOP_CONFIG.runtimeModule)?.observation, true);
  assert.equal(qualifyBrowserCall({ ...call, arguments: { ...call.arguments, code: call.arguments.code + '\n// changed' } }, STOP_CONFIG.runtimeModule), null);
  assert.equal(qualifyBrowserCall(ordinary(TURN, 'retain'), STOP_CONFIG.runtimeModule)?.observation, false);
  assert.equal(qualifyBrowserCall(ordinary(TURN, 'send'), STOP_CONFIG.runtimeModule)?.observation, false);
  assert.equal(qualifyBrowserCall(call, 'E:\\other-runtime.mjs'), null);
});

test('resident observe and retain qualify only with the exact binding, helper version and canonical invocation', () => {
  for (const operation of ['observe', 'retain']) {
    const call = ordinary(TURN, operation), code = call.arguments.code;
    assert.ok(Buffer.byteLength(code, 'utf8') < 5000);
    const qualified = qualifyBrowserCall(call, STOP_CONFIG.runtimeModule);
    assert.equal(qualified?.config.operation, operation);
    assert.equal(qualified?.observation, operation === 'observe');
    assert.ok(code.includes(browserHelperVersion));
    for (const tampered of [
      code.replaceAll('routerWeb_fixtureBinding', 'routerWeb_foreignBinding'),
      code.replace(browserHelperVersion, '0'.repeat(64)),
      code.replace('Object.isFrozen(', 'Object.isExtensible('),
      code.slice(code.lastIndexOf('await globalThis.')),
      `${code}\nvoid 0;`,
    ]) {
      assert.notEqual(tampered, code);
      assert.equal(qualifyBrowserCall({ ...call, arguments: { ...call.arguments, code: tampered } }, STOP_CONFIG.runtimeModule), null);
    }
  }
});

test('compact configuration remains bound to the originating native identity, runtime and Stop control', () => {
  const call = ordinary();
  const config = qualifyBrowserCall(call, STOP_CONFIG.runtimeModule).config;
  for (const replacement of [
    { sessionId: SESSION }, { turnId: TURN2 }, { runtimeModule: 'E:\\other-runtime.mjs' },
    { ui: { ...config.ui, stopButtonExactName: 'Stop generating' } },
  ]) {
    const candidate = { ...call, arguments: { ...call.arguments, code: browserScript({ ...config, ...replacement }) } };
    assert.equal(qualifyBrowserCall(candidate, STOP_CONFIG.runtimeModule), null);
  }
});

test('strict native identities permit canonical session affinity to differ from thread and reject contradictory aliases', () => {
  const meta = ordinary()._meta;
  assert.equal(readIdentity(meta).sessionId, SESSION);
  assert.notEqual(SESSION, APPROVED_THREAD);
  for (const replacement of [{ threadId: SESSION }, { turnId: TURN2 }, { thread_id: SESSION }, { session_id: APPROVED_THREAD }]) {
    assert.equal(readIdentity({ ...meta, ...replacement }), null);
  }
  for (const flag of ['auto_review_enabled', 'node_repl_auto_review_required', 'node_repl_disabled']) {
    const missing = clone(meta); delete missing['x-codex-turn-metadata'][flag]; assert.equal(readIdentity(missing), null);
  }
});

test('minimal stock hook uses the exact retained origin metadata, stripping only per-RPC correlation', () => {
  const source = ordinary();
  source._meta['x-codex-turn-metadata'] = '  ' + JSON.stringify(canonical()) + '\n';
  source._meta.itemId = 'origin_item'; source._meta.progressToken = 93;
  source._meta.futureAuthority = { nested: ['private future authority', { preserved: true }] };
  source._meta.traceparent = 'origin trace'; source._meta.tracestate = 'origin state';
  const cache = cached(source), nativeHook = hook(), before = clone(nativeHook);
  const result = cleanupDecision(nativeHook, cache, GENERATION).meta;
  assert.deepEqual(nativeHook, before);
  const expected = clone(source._meta); delete expected.callId; delete expected.itemId; delete expected.progressToken;
  assert.deepEqual(result, expected);
  assert.equal(result['x-codex-turn-metadata'], source._meta['x-codex-turn-metadata']);
  assert.equal(result.sessionId, SOURCE_SESSION);
  assert.notEqual(result.sessionId, SESSION); assert.notEqual(result.sessionId, APPROVED_THREAD);
  for (const key of ['codex/sandbox-state', 'codex/sandbox-state-meta', 'codex/sandbox-launcher']) assert.deepEqual(result[key], source._meta[key]);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result['codex/sandbox-state'].futureOpaque));
});

test('cold, mismatched, foreign, stale and conflicting authority refuses cleanup', () => {
  const cache = cached();
  assert.equal(cleanupDecision(hook(), null, GENERATION).meta, null);
  assert.equal(cleanupDecision(hook(), cache, TURN2).meta, null);
  const alternatives = [hook(TURN2), hook(), hook(), hook(), hook(), hook(), hook()];
  alternatives[1].arguments.session_id = SESSION;
  alternatives[2]._meta['x-codex-turn-metadata'] = { ...canonical(), node_repl_auto_review_required: false };
  alternatives[3]._meta['codex/sandbox-state'] = { different: true };
  alternatives[4]._meta['codex/sandbox-state-meta'] = { different: true };
  alternatives[5]._meta['codex/sandbox-launcher'] = { different: true };
  alternatives[6]._meta.sessionId = SESSION;
  for (const candidate of alternatives) assert.equal(cleanupDecision(candidate, cache, GENERATION).meta, null);
  const invalidAlias = ordinary(); invalidAlias._meta['codex/sandbox-state-meta'].changed = true;
  assert.equal(qualifyBrowserCall(invalidAlias, STOP_CONFIG.runtimeModule), null);
});

test('optional hook fields must match retained authority except documented request trace fields', () => {
  const source = ordinary(); source._meta.traceparent = 'origin trace'; source._meta.tracestate = 'origin state';
  source._meta['openai/readOnly'] = true;
  const cache = cached(source), optional = hook();
  optional._meta = { ...clone(source._meta), traceparent: 'hook trace', tracestate: 'hook state' };
  delete optional._meta.callId;
  const result = cleanupDecision(optional, cache, GENERATION).meta;
  assert.equal(result.traceparent, 'origin trace'); assert.equal(result.tracestate, 'origin state');
  assert.equal(result['openai/readOnly'], true);
  for (const [key, value] of [['openai/readOnly', false], ['baggage', 'unverified baggage'], ['futureHookAuthority', {}]]) {
    const conflict = clone(optional); conflict._meta[key] = value;
    assert.equal(cleanupDecision(conflict, cache, GENERATION).reason, 'hook_authority_conflict');
  }
  const presentReadOnly = hook(); presentReadOnly._meta['openai/readOnly'] = true;
  assert.equal(cleanupDecision(presentReadOnly, cached(), GENERATION).meta, null);
});

test('any own hook callId excludes ordinary tool calls from lifecycle interpretation', () => {
  for (const value of ['ordinary_call', '', null, false, undefined]) {
    const candidate = hook(); candidate._meta.callId = value;
    assert.equal(cleanupDecision(candidate, cached(), GENERATION).reason, 'ordinary_call');
  }
});

test('Stop generation rejects invalid and injected identities at the adapter boundary', () => {
  const identity = cached().identity;
  for (const field of ['threadId', 'turnId', 'sessionId']) for (const value of ["';evil()//", '${session_id}', '../../other', '', null])
    assert.throws(() => stopCode(STOP_CONFIG, { ...identity, [field]: value }), /identity_refused/u);
  assert.throws(() => stopCode({ ...STOP_CONFIG, threadIds: [SESSION] }, identity), /identity_refused/u);
});

test('bounded actual native output envelope distinguishes explicit success, no-scope, malformed and nested errors', () => {
  assert.equal(readStopResult(success()).ok, true);
  assert.equal(readStopResult(success({ outcome: 'already_idle', clickAttempted: false, stopClicked: false })).ok, true);
  assert.equal(readStopResult({ ...success(), isError: true }).ok, false);
  assert.equal(readStopResult({ content: [{ type: 'text', text: JSON.stringify({ isError: true, result: success() }) }] }).ok, false);
  assert.equal(readStopResult({ content: [{ type: 'text', text: '{}' }] }).ok, false);
  assert.equal(readStopResult(success({ outcome: 'blocked', stage: 'metadata', code: 'metadata_mismatch' })).ok, false);
  assert.equal(readStopResult(success({ stopHidden: false })).ok, false);
  assert.equal(readStopResult(success({ generationInactive: false })).ok, false);
  assert.equal(readStopResult(success({ clickAttempted: false })).ok, false);
  assert.equal(readStopResult(success({ clickError: true })).ok, false);
  assert.equal(readStopResult(success({ outcome: 'already_idle', stopClicked: false, clickError: true })).ok, true);
  assert.equal(readStopResult(success({ outcome: 'already_idle', stopClicked: false })).ok, false);
  const missingInactive = success();
  const envelope = JSON.parse(missingInactive.content[0].text), proof = JSON.parse(envelope.systemMessage.slice(16));
  delete proof.generationInactive;
  envelope.systemMessage = 'ROUTER_WEB_STOP ' + JSON.stringify(proof);
  missingInactive.content[0].text = JSON.stringify(envelope);
  assert.equal(readStopResult(missingInactive).ok, false);
  assert.equal(readStopResult(success({ elapsedMs: 3001 })).ok, false);
  assert.equal(readStopResult(success({ rawPayload: 'must refuse' })).ok, false);
});

test('validated blocked proof retains bounded stage and progress without acquiring success', () => {
  const proof = { outcome: 'blocked', stage: 'stop_readback_visibility', freshController: true,
    clickAttempted: true, clickError: false, stopClicked: true, stopHidden: false, generationInactive: false, inactivityEvidence: 'none',
    retained: false, elapsedMs: 1012, code: 'browser_operation_failed' };
  for (const stage of ['stop_click', 'stop_readback_visibility', 'handoff']) {
    assert.deepEqual(readStopResult(success({ ...proof, stage })), { ok: false, ...proof, stage });
  }
  assert.deepEqual(readStopResult(success({ ...proof, stage: 'private unknown stage' })), { ok: false, code: 'malformed_proof' });
  assert.deepEqual(readStopResult(success({ ...proof, elapsedMs: 3001 })), { ok: false, code: 'malformed_proof' });
});

test('readback diagnostics accept only fixed states, bounded counts and nullable booleans', () => {
  const observations = { readbackState: null, readbackStopCount: null, readbackIdleCount: null,
    readbackIdleVisibleCount: null, readbackUnrecognizedCount: null, readbackLabelledByCount: null,
    readbackStopVisible: null, readbackControlsRecognized: null, readbackComplete: null };
  const proof = readStopResult(success(observations));
  assert.equal(proof.ok, true);
  for (const [key, value] of Object.entries(observations)) assert.equal(proof[key], value);
  for (const field of ['readbackStopCount', 'readbackIdleCount', 'readbackIdleVisibleCount',
    'readbackUnrecognizedCount', 'readbackLabelledByCount']) {
    assert.equal(readStopResult(success({ [field]: 1000 })).ok, true);
    for (const value of [-1, 1001, 1.5, '1', true, {}])
      assert.deepEqual(readStopResult(success({ [field]: value })), { ok: false, code: 'malformed_proof' });
  }
  for (const field of ['readbackStopVisible', 'readbackControlsRecognized', 'readbackComplete']) {
    for (const value of [false, true]) assert.equal(readStopResult(success({ [field]: value })).ok, true);
    for (const value of [0, 'false', {}])
      assert.deepEqual(readStopResult(success({ [field]: value })), { ok: false, code: 'malformed_proof' });
  }
  for (const value of ['private unknown state', 'active_readback', ['unconfirmed_readback'], {}])
    assert.deepEqual(readStopResult(success({ readbackState: value })), { ok: false, code: 'malformed_proof' });
});

test('inactivity evidence is required, discriminated and consistent with acknowledged click authority', () => {
  assert.equal(readStopResult(success({ inactivityEvidence: 'composer_restored' })).ok, true);
  for (const overrides of [
    { inactivityEvidence: undefined }, { inactivityEvidence: 'private invented evidence' },
    { inactivityEvidence: 'none' }, { inactivityEvidence: 'turn_complete', generationInactive: false },
    { inactivityEvidence: 'composer_restored', stopHidden: false },
    { inactivityEvidence: 'composer_restored', outcome: 'already_idle', stopClicked: false, clickAttempted: false },
    { inactivityEvidence: 'composer_restored', outcome: 'already_idle', stopClicked: false, clickError: true },
    { inactivityEvidence: 'composer_restored', outcome: 'blocked', stopClicked: false },
  ]) assert.equal(readStopResult(success(overrides)).ok, false);
  const blocked = readStopResult(success({ outcome: 'blocked', stage: 'stop_readback_visibility',
    generationInactive: false, inactivityEvidence: 'none', code: 'stop_confirmation_failed' }));
  assert.equal(blocked.ok, false); assert.equal(blocked.inactivityEvidence, 'none');
});

async function protocolFixture(t, toolHandler, options = {}) {
  const [clientWire, outerWire] = InMemoryTransport.createLinkedPair();
  const [childWire, serverWire] = InMemoryTransport.createLinkedPair();
  const callEvents = recordedEvents(t), cancellationEvents = recordedEvents(t), receiptEvents = recordedEvents(t);
  const innerEvents = recordedEvents(t), childTerminalEvents = recordedEvents(t);
  const calls = callEvents.values, cancellations = cancellationEvents.values, receipts = receiptEvents.values;
  const forwardedOuter = [], forwardedInner = innerEvents.values;
  const official = new Server({ name: 'official_fixture', version: 'fixture' }, {
    capabilities: { tools: {}, experimental: { 'codex/sandbox-state': {} } }, instructions: 'official fixture instructions' });
  const declarations = [{ name: 'js', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
    { name: 'turn_ended', inputSchema: { type: 'object' } }, { name: 'js_reset', inputSchema: { type: 'object' } }];
  official.setRequestHandler(ListToolsRequestSchema, () => ({ tools: declarations }));
  official.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    callEvents.record(request.params);
    extra.signal.addEventListener('abort', () => cancellationEvents.record(request.params), { once: true });
    return toolHandler(request.params, extra);
  });
  await official.connect(serverWire);
  const receiveOfficial = serverWire.onmessage;
  serverWire.onmessage = (message, extra) => { innerEvents.record(clone(message)); receiveOfficial(message, extra); };
  const sendTerminal = serverWire.send.bind(serverWire);
  serverWire.send = async message => {
    await sendTerminal(message);
    if (!message.method) childTerminalEvents.record(clone(message));
  };
  const bridge = new AdapterBridge({ outer: outerWire, child: childWire, stopConfig: STOP_CONFIG,
    generation: GENERATION, receipt: entry => receiptEvents.record(entry), ...options });
  const { promise: closed, resolve: didClose } = Promise.withResolvers();
  const close = bridge.close.bind(bridge);
  bridge.close = async () => {
    const firstClose = !bridge.closed;
    await close();
    if (firstClose) didClose();
  };
  const receiveOuter = outerWire.send.bind(outerWire);
  outerWire.send = async message => { forwardedOuter.push(clone(message)); return receiveOuter(message); };
  await bridge.start();
  const client = new Client({ name: 'codex_fixture', version: 'fixture' });
  await client.connect(clientWire);
  t.after(async () => { await bridge.close(); await client.close(); await official.close(); });
  return { client, bridge, closed, calls, cancellations, receipts, declarations, forwardedOuter, forwardedInner, serverWire,
    waitForCall: matches => callEvents.waitFor(matches), waitForCancellation: matches => cancellationEvents.waitFor(matches),
    waitForReceipt: (code, matches = () => true) => receiptEvents.waitFor(entry => entry.code === code && matches(entry)),
    waitForInner: matches => innerEvents.waitFor(matches),
    waitForChildTerminal: matches => childTerminalEvents.waitFor(matches) };
}

async function waitingFixture(t, toolHandler, options = {}) {
  const { brokerTransport = 'direct', ...bridgeOptions } = options;
  const broker = createWebToolBroker({ invocationTimeoutMs: 5000 });
  const service = await startWebMcp({ broker });
  t.after(() => service.close());
  const turn = broker.register({ threadId: APPROVED_THREAD, turnId: TURN,
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] });
  const source = ordinary();
  source.arguments.code = browserScript({ ...readBrowserProgram(source.arguments.code),
    observationWait: { url: service.observationUrl(turn.token, broker.revision(turn.token)) } });
  const f = await protocolFixture(t, toolHandler, { observationIntervalMs: 5, ...bridgeOptions });
  if (brokerTransport === 'direct') {
    // Scheduling cases control the broker through its actual revision/abort
    // events. Dedicated HTTP cases below retain the production HTTP boundary.
    f.bridge.waitForBroker = async pending => {
      const state = pending.wait;
      const value = await broker.waitForChange(turn.token, state.revision, { signal: state.abort.signal, timeoutMs: 25_000 });
      f.bridge.wakeObservation(pending, value.closed ? 'broker_closed' : value.revision !== state.revision ? 'broker_activity' : 'deadline');
    };
  }
  return { ...f, broker, service, turn, source };
}

async function observationServer(t, handler, port = 0) {
  const requests = recordedEvents(t);
  const server = createServer((request, response) => {
    requests.record({ method: request.method, url: request.url, accept: request.headers.accept });
    handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}/${'c'.repeat(64)}/observe/web_turn_${'d'.repeat(32)}?revision=0`;
  const source = ordinary();
  source.arguments.code = browserScript({ ...readBrowserProgram(source.arguments.code), observationWait: { url } });
  return { source, url, requests: requests.values, waitForRequest: () => requests.waitFor(() => true) };
}
function observationResult(params, fields = {}) {
  const config = readBrowserProgram(params.arguments.code);
  return { content: [{ type: 'text', text: config.frameBegin + JSON.stringify({ routerBrowser: {
    operation: 'observe', normal: true, completed: false, stopVisible: true, statusComplete: false, ...fields,
  } }) + config.frameEnd }] };
}
function sendResult(params, fields = {}) {
  const config = readBrowserProgram(params.arguments.code);
  return { content: [{ type: 'text', text: config.frameBegin + JSON.stringify({ routerBrowser: {
    operation: 'send', sent: true, normal: true, tabId: 'owned-tab', url: 'https://chatgpt.com/c/owned-chat',
    generationTurnKey: GENERATION, ...fields,
  } }) + config.frameEnd }] };
}

test('a confirmed Send terminal authorizes Stop before observation with only its exact delivery facts', async t => {
  const source = ordinary(TURN, 'send');
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : sendResult(params));
  await f.client.callTool(source);
  const delivery = { bindingId: 'fixtureBinding', tabId: 'owned-tab', url: 'https://chatgpt.com/c/owned-chat', generationTurnKey: GENERATION };
  assert.deepEqual(f.bridge.cache.delivery, delivery);
  assert.equal((await f.client.callTool(hook())).isError, undefined);
  assert.equal(f.calls.length, 2, 'Stop does not replay Send or require another observation.');
  assert.equal(f.calls[1].arguments.code, stopCode(STOP_CONFIG, cached(source).identity, f.calls[1].arguments.timeout_ms - 100, delivery));
  assert.deepEqual(f.calls[1]._meta, retainedMetadata(source._meta));
});

test('uncertain, malformed, foreign and failed Send terminals never authorize Stop', async t => {
  for (const branch of ['unconfirmed', 'abnormal', 'unsaved chat', 'malformed', 'foreign nonce', 'foreign tab', 'invalid generation', 'tool error', 'RPC error']) {
    await t.test(branch, async subtest => {
      const source = ordinary(TURN, 'send');
      if (branch === 'foreign tab') source.arguments.code = browserScript({ ...readBrowserProgram(source.arguments.code), tabId: 'expected-tab' });
      const f = await protocolFixture(subtest, params => {
        if (branch === 'RPC error') throw new McpError(-32603, 'synthetic Send error');
        const value = branch === 'malformed' ? ordinaryResult : sendResult(params,
          branch === 'unconfirmed' ? { sent: false } : branch === 'abnormal' ? { normal: false }
            : branch === 'unsaved chat' ? { url: 'https://chatgpt.com/' }
              : branch === 'invalid generation' ? { generationTurnKey: 'unproven' } : {});
        if (branch === 'foreign nonce') value.content[0].text = value.content[0].text.replaceAll('a'.repeat(48), 'b'.repeat(48));
        if (branch === 'tool error') value.isError = true;
        return value;
      });
      await f.client.callTool(source).catch(() => {});
      assert.equal((await f.client.callTool(hook())).isError, true);
      assert.deepEqual(f.calls, [source]);
      assert.equal(f.receipts.some(entry => entry.code === 'authority_cached'), false);
    });
  }
});

test('cancelling pending Send cannot acquire authority from its late successful frame', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const source = ordinary(TURN, 'send');
  const { promise: producedResult, resolve: produced } = Promise.withResolvers();
  const f = await protocolFixture(t, async params => {
    entered(); await terminal; const result = sendResult(params); produced(result); return result;
  });
  const control = new AbortController();
  const sending = f.client.callTool(source, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await started; control.abort(); assert.equal(await sending, 'cancelled');
  release(); const result = await producedResult;
  // The SDK fixture suppresses its handler's result after cancellation; the
  // official child can send one. Deliver the actual produced frame on its wire.
  const wire = f.forwardedInner.find(message => message.params?.arguments?.code === source.arguments.code);
  await f.serverWire.send({ jsonrpc: '2.0', id: wire.id, result });
  assert.equal((await f.client.callTool(hook())).isError, true);
  assert.deepEqual(f.calls, [source]);
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.receipts.some(entry => entry.code === 'authority_cached'), false);
});

test('a Send frame cannot acquire authority after an intervening native policy change', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const source = ordinary(TURN, 'send');
  const f = await protocolFixture(t, async params => {
    if (params.arguments.code === source.arguments.code) { entered(); await terminal; return sendResult(params); }
    return ordinaryResult;
  });
  const sending = f.client.callTool(source); await started;
  const conflicting = withAuthority(ordinary(), 'changed policy'); conflicting.arguments.code = 'void 0';
  await f.client.callTool(conflicting); release(); await sending;
  assert.equal((await f.client.callTool(hook())).isError, true);
  assert.equal(f.receipts.some(entry => entry.code === 'authority_cached'), false);
});

test('one actual MCP observation spans short private child reads and returns only the completed snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let reads = 0;
  const f = await waitingFixture(t, params => observationResult(params, { completed: ++reads === 3 }));
  f.source._meta['x-codex-turn-metadata'] = '  ' + JSON.stringify(canonical()) + '\n';
  f.source._meta.futureAuthority = { untouched: ['opaque policy'] };
  const answer = f.client.callTool(f.source);
  let previousId;
  for (let read = 0; read < 2; read++) {
    const terminal = await f.waitForChildTerminal(message => message.result?.content && message.id !== previousId);
    previousId = terminal.id;
    t.mock.timers.tick(5);
  }
  const result = await answer;
  assert.equal(reads, 3);
  assert.match(result.content[0].text, /"completed":true/u);
  assert.equal(f.forwardedOuter.filter(message => message.result?.content).length, 1);
  const children = f.forwardedInner.filter(message => message.method === 'tools/call');
  assert.equal(new Set(children.map(message => message.id)).size, 3);
  for (const child of children) {
    assert.match(child.id, /^router_observe_/u);
    assert.deepEqual(child.params._meta, f.source._meta);
    assert.equal(child.params.arguments.code, f.source.arguments.code);
    assert.ok(child.params.arguments.timeout_ms > 0 && child.params.arguments.timeout_ms <= 29000);
  }
  const receipt = f.receipts.find(entry => entry.code === 'observation_wait_finished');
  assert.equal(receipt.readCount, 3); assert.equal(receipt.wakeReason, 'browser_ready');
  assert.ok(!JSON.stringify(f.receipts).includes(f.turn.token));
});

test('canonical subagents hold exact read-only observations without acquiring primary Stop authority', async t => {
  for (const field of ['parent_thread_id', 'subagent_header', 'subagent_kind']) for (const serialized of [false, true]) {
    await t.test(`${field}, ${serialized ? 'JSON string' : 'object'}`, async subtest => {
      subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
      let reads = 0;
      const f = await waitingFixture(subtest, params => observationResult(params, { completed: ++reads === 3 }), { observationIntervalMs: 500 });
      f.source = asSubagent(f.source, field, serialized);
      assert.equal(readIdentity(f.source._meta), null);
      assert.equal(qualifyBrowserCall(f.source, STOP_CONFIG.runtimeModule), null);
      const answer = f.client.callTool(f.source);
      let previousId;
      for (let read = 0; read < 2; read++) {
        const terminal = await f.waitForChildTerminal(message => message.result?.content && message.id !== previousId);
        previousId = terminal.id;
        const pending = [...f.bridge.pending.values()][0];
        assert.equal(pending.qualified, false); assert.equal(pending.cache, null); assert.equal(pending.send, undefined);
        assert.equal(f.bridge.cache, null); assert.equal(f.bridge.currentAuthority, undefined);
        assert.equal(f.bridge.currentThread, undefined); assert.equal(f.bridge.currentTurn, undefined);
        assert.equal(f.bridge.graceDeadline, undefined); assert.equal(f.bridge.cleanupGroup, null);
        subtest.mock.timers.tick(499); await f.client.ping();
        assert.equal(reads, read + 1);
        subtest.mock.timers.tick(1);
      }
      assert.match((await answer).content[0].text, /"completed":true/u);
      assert.equal(reads, 3); assert.equal(f.forwardedOuter.filter(message => message.result?.content).length, 1);
      const children = f.forwardedInner.filter(message => message.method === 'tools/call');
      assert.equal(new Set(children.map(message => message.id)).size, 3);
      for (const child of children) {
        assert.match(child.id, /^router_observe_/u);
        assert.deepEqual(child.params._meta, f.source._meta);
        assert.equal(child.params.arguments.code, f.source.arguments.code);
        assert.ok(child.params.arguments.timeout_ms > 0 && child.params.arguments.timeout_ms <= 29000);
      }
      assert.equal((await f.client.callTool(hook())).isError, true);
      assert.equal(f.calls.length, 3); assert.equal(f.bridge.injected.size, 0);
      assert.equal(f.receipts.some(entry => entry.code === 'authority_cached' || entry.code === 'observation_cancel_deferred'), false);
    });
  }
});

test('subagent held observation returns truthful terminal, renewal and broker outcomes', async t => {
  for (const kind of ['completion', 'capacity', 'request failure', 'ownership loss', 'native error', 'malformed browser', 'renewal', 'broker activity', 'broker closed']) {
    await t.test(kind, async subtest => {
      subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
      const fields = kind === 'completion' ? { completed: true } : kind === 'capacity' ? { conversationFull: true }
        : kind === 'request failure' ? { requestError: 'unknown_error' }
        : kind === 'ownership loss' ? { replyUnavailableReason: 'generation-turn-not-latest' } : {};
      const nativeError = { isError: true, content: [{ type: 'text', text: 'synthetic child failure' }] };
      const f = await waitingFixture(subtest, params => kind === 'native error' ? nativeError
        : kind === 'malformed browser' ? ordinaryResult : observationResult(params, fields), { observationIntervalMs: 500, observationWaitMs: 25_000 });
      f.source = asSubagent(f.source);
      const answer = f.client.callTool(f.source).then(result => ({ result }), error => ({ error }));
      await f.waitForChildTerminal(message => message.result?.content);
      if (kind === 'renewal') subtest.mock.timers.tick(25_000);
      if (kind === 'broker activity') {
        const invocation = f.broker.invoke(f.turn.token, { wireName: 'read', arguments: {} }).catch(() => {});
        subtest.after(() => { f.broker.cancel(f.turn.token); return invocation; });
      }
      if (kind === 'broker closed') f.broker.cancel(f.turn.token);
      const outcome = await answer;
      if (kind === 'broker closed') assert.match(outcome.error.message, /observation channel is unavailable/u);
      else {
        assert.equal(outcome.error, undefined);
        if (kind === 'native error' || kind === 'malformed browser') assert.deepEqual(outcome.result, kind === 'native error' ? nativeError : ordinaryResult);
        else assert.equal(parseBrowserOutput(outcome.result, readBrowserProgram(f.source.arguments.code).frameToken).completed, kind === 'completion');
      }
      const expectedReason = ['native error', 'malformed browser'].includes(kind) ? 'browser_error'
        : kind === 'renewal' ? 'deadline' : kind.startsWith('broker ') ? kind.replace(' ', '_') : 'browser_ready';
      assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, expectedReason);
      if (kind !== 'renewal') assert.equal(f.calls.length, 1);
      assert.equal(f.bridge.cache, null); assert.equal(f.bridge.currentAuthority, undefined);
    });
  }
});

test('subagent broker transport failures and malformed envelopes fail closed after the real browser terminal', async t => {
  for (const kind of ['closed socket', 'malformed JSON', 'backward revision']) await t.test(kind, async subtest => {
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const server = await observationServer(subtest, (request, response) => {
      if (kind === 'closed socket') return request.socket.destroy();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(kind === 'malformed JSON' ? '{' : JSON.stringify({ closed: false, revision: -1 }));
    });
    const f = await protocolFixture(subtest, async params => { await gate; return observationResult(params); });
    subtest.after(release);
    const answer = f.client.callTool(asSubagent(server.source)).then(result => ({ result }), error => ({ error }));
    await f.waitForCall(() => true);
    assert.equal(await brokerWake(subtest, [...f.bridge.pending.values()][0]), 'broker_error');
    assert.equal(f.bridge.observationChildren.size, 1);
    release();
    const outcome = await answer;
    assert.match(outcome.error.message, /observation channel is unavailable/u);
    assert.equal(f.bridge.observationChildren.size, 0); assert.equal(f.calls.length, 1);
  });
});

test('subagent hold admission preserves exact native, program, broker and configured thread boundaries', async t => {
  for (const kind of ['no wait', 'generic JS', 'changed program', 'foreign binding', 'foreign helper', 'foreign runtime',
    'send', 'retain', 'missing callId', 'missing sandbox', 'conflicting sandbox', 'missing session alias', 'invalid session alias',
    'canonical alias conflict', 'invalid native flag', 'invalid canonical UUID', 'oversized canonical string', 'excluded thread',
    'foreign broker', 'broker credentials', 'broker revision', 'broker extra query']) await t.test(kind, async subtest => {
    const f = await waitingFixture(subtest, () => ordinaryResult, kind === 'excluded thread'
      ? { stopConfig: { ...STOP_CONFIG, threadIds: [SESSION] } } : {});
    const source = asSubagent(f.source), config = readBrowserProgram(source.arguments.code);
    if (kind === 'no wait') { delete config.observationWait; source.arguments.code = browserScript(config); }
    if (kind === 'generic JS') source.arguments.code = 'void 0';
    if (kind === 'changed program') source.arguments.code += '\n// changed';
    if (kind === 'foreign binding') source.arguments.code = source.arguments.code.replaceAll('routerWeb_fixtureBinding', 'routerWeb_foreignBinding');
    if (kind === 'foreign helper') source.arguments.code = source.arguments.code.replace(browserHelperVersion, '0'.repeat(64));
    if (kind === 'foreign runtime') source.arguments.code = browserScript({ ...config, runtimeModule: 'E:\\other-runtime.mjs' });
    if (kind === 'send' || kind === 'retain') {
      source.arguments.code = ordinary(TURN, kind).arguments.code;
    }
    if (kind === 'missing callId') delete source._meta.callId;
    if (kind === 'missing sandbox') delete source._meta['codex/sandbox-launcher'];
    if (kind === 'conflicting sandbox') source._meta['codex/sandbox-state-meta'].changed = true;
    if (kind === 'missing session alias') delete source._meta.sessionId;
    if (kind === 'invalid session alias') source._meta.sessionId = 'invalid';
    if (kind === 'canonical alias conflict') source._meta.turnId = TURN2;
    if (kind === 'invalid native flag') source._meta['x-codex-turn-metadata'].node_repl_disabled = 'false';
    if (kind === 'invalid canonical UUID') source._meta['x-codex-turn-metadata'].turn_id = 'invalid';
    if (kind === 'oversized canonical string') source._meta['x-codex-turn-metadata'] = ' '.repeat(262145) + JSON.stringify(source._meta['x-codex-turn-metadata']);
    if (kind.startsWith('broker ') || kind === 'foreign broker') {
      const url = new URL(config.observationWait.url);
      if (kind === 'foreign broker') url.hostname = 'localhost';
      if (kind === 'broker credentials') url.username = 'untrusted';
      if (kind === 'broker revision') url.searchParams.set('revision', '01');
      if (kind === 'broker extra query') url.searchParams.set('extra', '1');
      source.arguments.code = browserScript({ ...config, observationWait: { url: url.href } });
    }
    assert.deepEqual(await f.client.callTool(source), ordinaryResult);
    assert.deepEqual(f.calls, [source]);
    assert.equal(f.forwardedInner.some(message => /^router_observe_/u.test(message.id)), false);
    assert.equal(f.receipts.some(entry => entry.code === 'observation_wait_started' || entry.code === 'authority_cached'), false);
  });
});

test('subagent cancellation immediately targets an active internal read and keeps custody until its real terminal', async t => {
  for (const childError of [false, true]) await t.test(childError ? 'RPC terminal error' : 'browser result terminal', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const { promise: produced, resolve: didProduce } = Promise.withResolvers();
    let reads = 0;
    const f = await waitingFixture(subtest, async params => {
      if (params.arguments.code.includes('stopOwnedWebTurn')) return success();
      if (++reads > 1) return observationResult(params, { completed: true });
      await gate;
      const result = observationResult(params); didProduce(result); return result;
    }, { observationIntervalMs: 500 });
    subtest.after(release);
    const source = asSubagent(f.source), control = new AbortController();
    const answer = f.client.callTool(source, undefined, { signal: control.signal }).catch(() => 'cancelled');
    await f.waitForCall(() => true);
    const child = f.forwardedInner.find(message => message.method === 'tools/call');
    assert.match(child.id, /^router_observe_/u);
    const pending = f.bridge.observationChildren.get(child.id);
    control.abort(); await f.waitForCancellation(() => true);
    assert.equal(await answer, 'cancelled');
    assert.equal(f.bridge.pending.size, 0); assert.equal(f.bridge.observationChildren.get(child.id), pending);
    assert.equal(await pending.settled, false, 'Outer retirement does not report a real child terminal.');
    assert.equal(pending.wait.abort.signal.aborted, true);
    const cancelled = f.forwardedInner.filter(message => message.method === 'notifications/cancelled');
    assert.equal(cancelled.length, 1); assert.equal(cancelled[0].params.requestId, child.id);
    assert.equal(f.receipts.some(entry => entry.code === 'observation_cancel_deferred'), false);
    assert.equal(f.bridge.graceDeadline, undefined);
    // The orphan mapping blocks a successor hold and fresh primary Stop
    // authority, while ordinary calls keep their native forwarding behavior.
    await f.client.callTool(source);
    await f.client.callTool(ordinary());
    assert.equal(f.bridge.cache, null); assert.equal((await f.client.callTool(hook())).isError, true);
    assert.equal(f.receipts.filter(entry => entry.code === 'observation_wait_started').length, 1);
    subtest.mock.timers.tick(1000); await f.client.ping();
    assert.equal(reads, 3); assert.equal(f.bridge.observationChildren.size, 1);
    release(); const result = await produced;
    // The SDK suppresses a cancelled handler's result. Pass its actual output
    // on the fixture child wire, or its actual terminal RPC error, explicitly.
    const terminal = childError ? { jsonrpc: '2.0', id: child.id, error: { code: -32000, message: 'synthetic child terminal' } }
      : { jsonrpc: '2.0', id: child.id, result };
    await f.serverWire.send(terminal);
    await f.waitForChildTerminal(message => message.id === child.id);
    assert.equal(f.bridge.observationChildren.size, 0);
    subtest.mock.timers.tick(1000); await f.client.ping(); assert.equal(reads, 3);
    await f.client.callTool(ordinary());
    assert.equal((await f.client.callTool(hook())).isError, undefined);
    assert.equal(f.calls.filter(params => params.arguments.code.includes('stopOwnedWebTurn')).length, 1);
  });
});

test('subagent cancellation between reads aborts broker waiting without cancelling an idle child or scheduling again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = await waitingFixture(t, params => observationResult(params), { observationIntervalMs: 500 });
  const control = new AbortController();
  const answer = f.client.callTool(asSubagent(f.source), undefined, { signal: control.signal }).catch(() => 'cancelled');
  await f.waitForChildTerminal(message => message.result?.content);
  const pending = [...f.bridge.pending.values()][0];
  control.abort(); assert.equal(await answer, 'cancelled');
  await f.waitForReceipt('ordinary_cancelled');
  assert.equal(pending.wait.abort.signal.aborted, true);
  assert.equal(f.bridge.pending.size, 0); assert.equal(f.bridge.observationChildren.size, 0);
  t.mock.timers.tick(1000); await f.client.ping();
  assert.equal(f.calls.length, 1); assert.equal(f.cancellations.length, 0);
  assert.equal((await f.client.callTool(hook())).isError, true);
});

test('subagent observe, Send and retention cannot inherit or revive primary cleanup authority', async t => {
  for (const prior of ['cold', 'primary cached', 'authority replaced', 'retired']) await t.test(prior, async subtest => {
    const f = await protocolFixture(subtest, params => {
      if (params.arguments.code.includes('stopOwnedWebTurn')) return success();
      const config = readBrowserProgram(params.arguments.code);
      return !config ? ordinaryResult : config.operation === 'send' ? sendResult(params) : observationResult(params, { completed: true });
    });
    if (prior !== 'cold') await f.client.callTool(ordinary());
    if (prior === 'authority replaced') {
      const generic = withAuthority(ordinary(), 'replacement policy'); generic.arguments.code = 'void 0';
      await f.client.callTool(generic);
    }
    if (prior === 'retired') assert.equal((await f.client.callTool(hook())).isError, undefined);
    const primaryAuthority = f.bridge.currentAuthority;
    const stops = f.calls.filter(params => params.arguments.code.includes('stopOwnedWebTurn')).length;
    const cachedCount = f.receipts.filter(entry => entry.code === 'authority_cached').length;
    for (const operation of ['observe', 'send', 'retain']) {
      await f.client.callTool(asSubagent(ordinary(TURN, operation)));
      assert.equal(f.bridge.cache, null); assert.equal(f.bridge.currentAuthority, primaryAuthority);
      assert.equal(f.bridge.graceDeadline, undefined); assert.equal(f.bridge.cleanupGroup, null);
      const forged = hook(); forged._meta = { ...retainedMetadata(asSubagent(ordinary())._meta) };
      assert.equal((await f.client.callTool(forged)).isError, true);
      assert.equal((await f.client.callTool(hook())).isError, true);
    }
    assert.equal(f.calls.filter(params => params.arguments.code.includes('stopOwnedWebTurn')).length, stops);
    assert.equal(f.receipts.filter(entry => entry.code === 'authority_cached').length, cachedCount);
  });
});

test('broker activity wakes the outstanding observation before another child read is scheduled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: seen, resolve: first } = Promise.withResolvers();
  const f = await waitingFixture(t, params => { first(); return observationResult(params); }, { observationIntervalMs: 1000, brokerTransport: 'http' });
  const chatgpt = new Client({ name: 'chatgpt-tool-fixture', version: 'fixture' });
  await chatgpt.connect(new StreamableHTTPClientTransport(new URL(f.service.url)));
  t.after(() => chatgpt.close());
  const answer = f.client.callTool(f.source);
  await seen; await f.waitForChildTerminal(message => message.result?.content);
  const invocation = chatgpt.callTool({ name: 'codex_tool_call', arguments: {
    turn_token: f.turn.token, wire_name: 'read', arguments: { path: 'fixture' } } });
  void invocation.catch(() => {});
  const result = await answer;
  assert.match(result.content[0].text, /"completed":false/u);
  t.mock.timers.tick(1000); await f.client.ping();
  assert.equal(f.calls.length, 1, 'The real broker revision wakes the call during its idle browser interval.');
  const [native] = f.broker.takeCalls(f.turn.token);
  f.broker.complete(f.turn.token, [{ type: 'function_call_output', call_id: native.call_id, output: 'actual result' }]);
  assert.equal((await invocation).content[0].text, 'actual result');
  assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'broker_activity');
});

test('the safety deadline returns the latest incomplete snapshot without repeating Send or inventing completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = await waitingFixture(t, params => observationResult(params), { observationWaitMs: 30 });
  const answer = f.client.callTool(f.source);
  await f.waitForChildTerminal(message => message.result?.content);
  t.mock.timers.tick(30);
  const result = await answer;
  assert.match(result.content[0].text, /"completed":false/u);
  assert.ok(f.calls.length >= 1);
  assert.ok(f.calls.every(params => readBrowserProgram(params.arguments.code).operation === 'observe'));
  const receipt = f.receipts.find(entry => entry.code === 'observation_wait_finished');
  assert.equal(receipt.wakeReason, 'deadline');
  assert.equal(receipt.elapsedMs, 30);
});

test('a read begun just before renewal can finish across that boundary without resetting its kernel', async t => {
  for (const childFails of [false, true]) await t.test(childFails ? 'actual child error still propagates' : 'incomplete read renews successfully', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    let clock = 1000, reads = 0, kernelResets = 0;
    const nativeError = { isError: true, content: [{ type: 'text', text: 'js execution timed out; kernel reset, rerun your request' }] };
    const f = await waitingFixture(subtest, async params => {
      reads += 1;
      if (reads === 1) { clock = 1995; return observationResult(params); }
      if (reads > 2) return observationResult(params, { completed: true });
      // Place controlled work five milliseconds before the renewal boundary.
      // The fixture implements Node REPL's consequential timeout: losing the
      // deadline returns no nonce frame and resets the resident browser kernel.
      return new Promise(resolve => {
        const work = setTimeout(() => {
          clearTimeout(timeout); clock = 2015;
          resolve(childFails ? nativeError : observationResult(params));
        }, 20);
        const timeout = setTimeout(() => {
          clearTimeout(work); kernelResets += 1; clock = 2000; resolve(nativeError);
        }, params.arguments.timeout_ms);
      });
    }, { now: () => clock, observationWaitMs: 1000, observationIntervalMs: 1 });
    const answer = f.client.callTool(f.source);
    await f.waitForChildTerminal(message => message.result?.content);
    subtest.mock.timers.tick(1);
    await f.waitForCall(params => params === f.calls[1]);
    subtest.mock.timers.tick(20);
    const result = await answer;
    if (childFails) {
      assert.deepEqual(result, nativeError);
      assert.equal(reads, 2);
      await f.waitForReceipt('ordinary_js_failed');
      assert.equal((await f.client.callTool(hook())).isError, true);
    } else {
      assert.equal(result.isError, undefined, 'A renewal deadline must not create a native execution timeout.');
      assert.match(result.content[0].text, /"completed":false/u);
      assert.equal(kernelResets, 0);
      assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'deadline');
      const renewed = clone(f.source), config = readBrowserProgram(renewed.arguments.code);
      renewed.arguments.code = browserScript({ ...config, frameToken: 'b'.repeat(48) });
      renewed._meta.callId = `call_router_web_${'b'.repeat(32)}`;
      assert.match((await f.client.callTool(renewed)).content[0].text, /"completed":true/u);
      assert.equal(reads, 3, 'Renewal observes the same generation; it does not repeat Send.');
    }
  });
});

test('Stop during the last read headroom still waits for its actual terminal within the original cleanup budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let clock = 1000, reads = 0;
  const { promise: activeRead, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const f = await waitingFixture(t, async params => {
    if (params.arguments.code.includes('stopOwnedWebTurn')) return success();
    reads += 1;
    if (reads === 1) { clock = 1995; return observationResult(params); }
    clock = 2015; entered(); await terminal;
    return observationResult(params);
  }, { now: () => clock, observationWaitMs: 1000, observationIntervalMs: 1 });
  const control = new AbortController();
  const answer = f.client.callTool(f.source, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await f.waitForChildTerminal(message => message.result?.content);
  t.mock.timers.tick(1);
  await activeRead; control.abort();
  const stopped = f.client.callTool(hook());
  await f.waitForReceipt('cleanup_authority_consumed');
  assert.equal(f.calls.length, 2, 'Neither soft renewal nor native Stop establishes the active read terminal.');
  release();
  assert.equal((await stopped).isError, undefined); assert.equal(await answer, 'cancelled');
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[2].arguments.code.includes('stopOwnedWebTurn'));
  assert.ok(f.calls[2].arguments.timeout_ms <= 2500, 'Read headroom cannot create a new cleanup allowance.');
  assert.ok(f.receipts.some(entry => entry.code === 'interrupted_observation_terminal' && entry.childTerminalObserved));
  assert.ok(f.receipts.some(entry => entry.code === 'stop_confirmed'));
});

test('a true last-child error remains intact when broker closure wakes its held request first', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: activeRead, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const nativeError = { isError: true, content: [{ type: 'text', text: 'actual native execution failure' }] };
  const f = await waitingFixture(t, async () => { entered(); await terminal; return nativeError; }, { brokerTransport: 'http' });
  const answer = f.client.callTool(f.source); await activeRead;
  const pending = [...f.bridge.pending.values()][0];
  const woken = brokerWake(t, pending);
  f.broker.cancel(f.turn.token); await woken;
  release();
  assert.deepEqual(await answer, nativeError, 'A broker wake cannot replace an actual child terminal error.');
  assert.equal(f.calls.length, 1);
});

test('actual child errors and malformed browser output end the held call without another browser read', async t => {
  for (const result of [{ isError: true, content: [{ type: 'text', text: 'actual child failure' }] }, ordinaryResult]) {
    await t.test(result.isError ? 'child failure' : 'malformed output', async subtest => {
      subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
      const f = await waitingFixture(subtest, () => result);
      assert.deepEqual(await f.client.callTool(f.source), result);
      subtest.mock.timers.tick(1000); await f.client.ping();
      assert.equal(f.calls.length, 1);
      assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'browser_error');
    });
  }
});

test('a failed protected broker channel ends the native request with an explicit error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = await waitingFixture(t, params => observationResult(params), { observationIntervalMs: 1000, brokerTransport: 'http' });
  const config = readBrowserProgram(f.source.arguments.code);
  const url = new URL(config.observationWait.url); url.pathname = url.pathname.replace(/^\/[^/]+/u, '/' + 'b'.repeat(64));
  f.source.arguments.code = browserScript({ ...config, observationWait: { url: url.href } });
  await assert.rejects(f.client.callTool(f.source), /Router browser observation channel is unavailable/u);
  assert.equal(f.calls.length, 1);
});

test('Stop freezes repeated observation between reads and during a real active child invocation', async t => {
  for (const activeChild of [false, true]) await t.test(activeChild ? 'active child' : 'idle interval', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { promise: seen, resolve: first } = Promise.withResolvers();
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const f = await waitingFixture(subtest, async params => {
      if (params.arguments.code.includes('stopOwnedWebTurn')) return success();
      first(); if (activeChild) await gate;
      return observationResult(params);
    }, { observationIntervalMs: 1000 });
    const control = new AbortController();
    const answer = f.client.callTool(f.source, undefined, { signal: control.signal }).catch(() => 'cancelled');
    await seen;
    if (!activeChild) await f.waitForChildTerminal(message => message.result?.content);
    control.abort();
    const stop = f.client.callTool(hook());
    await f.waitForReceipt('cleanup_authority_consumed');
    if (activeChild) assert.equal(f.calls.length, 1, 'Stop cannot enter Node REPL before its real child terminal.');
    release();
    assert.equal((await stop).isError, undefined);
    assert.equal(await answer, 'cancelled');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1]._meta, retainedMetadata(f.source._meta));
    assert.ok(f.receipts.some(entry => entry.code === 'stop_confirmed'));
    subtest.mock.timers.tick(1000); await f.client.ping();
    assert.equal(f.calls.length, 2);
  });
});

test('changed authority retires an idle wait and cannot authorize Stop or later repeated reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: seen, resolve: first } = Promise.withResolvers();
  const f = await waitingFixture(t, params => {
    if (!readBrowserProgram(params.arguments.code)) return ordinaryResult;
    first(); return observationResult(params);
  }, { observationIntervalMs: 1000 });
  const answer = f.client.callTool(f.source); await seen;
  await f.waitForChildTerminal(message => message.result?.content);
  const other = withAuthority(ordinary(), 'changed policy'); other.arguments.code = 'ordinary JS';
  await f.client.callTool(other); await answer;
  assert.equal((await f.client.callTool(hook())).isError, true);
  t.mock.timers.tick(1000); await f.client.ping();
  assert.equal(f.calls.length, 2);
  assert.ok(f.receipts.some(entry => entry.code === 'authority_replaced'));
});

test('an unsettled private observation forwards cancellation to its actual child ID once grace expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: seen, resolve: first } = Promise.withResolvers();
  const f = await waitingFixture(t, async (params, extra) => {
    first();
    await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
    return observationResult(params);
  }, { graceMs: 25 });
  const control = new AbortController();
  const answer = f.client.callTool(f.source, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await seen; control.abort();
  assert.equal(await answer, 'cancelled');
  await f.waitForReceipt('observation_cancel_deferred');
  t.mock.timers.tick(25);
  await f.waitForReceipt('cancel_grace_expired');
  await f.waitForCancellation(() => true);
  assert.equal(f.cancellations.length, 1);
  const childCall = f.forwardedInner.find(message => message.method === 'tools/call');
  const cancelled = f.forwardedInner.filter(message => message.method === 'notifications/cancelled');
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0].params.requestId, childCall.id);
  assert.equal((await f.client.callTool(hook())).isError, true);
  assert.equal(f.calls.length, 1);
});

test('a closed broker turn and lost browser ownership wake immediately without a successful final answer', async t => {
  for (const kind of ['closed broker', 'lost browser ownership']) await t.test(kind, async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { promise: seen, resolve: first } = Promise.withResolvers();
    const f = await waitingFixture(subtest, params => {
      first(); return observationResult(params, kind === 'lost browser ownership' ? { replyUnavailableReason: 'generation-turn-not-latest' } : {});
    }, { observationIntervalMs: 1000, brokerTransport: kind === 'closed broker' ? 'http' : 'direct' });
    const answer = f.client.callTool(f.source);
    await seen;
    if (kind === 'closed broker') {
      f.broker.cancel(f.turn.token);
      await assert.rejects(answer, /Router browser observation channel is unavailable/u);
    } else {
      assert.match((await answer).content[0].text, /generation-turn-not-latest/u);
      assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'browser_ready');
    }
    assert.equal(f.calls.length, 1);
  });
});

test('a broker transport rejection before an ownership-loss terminal remains an explicit failure', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const server = await observationServer(t, request => request.socket.destroy());
  const f = await protocolFixture(t, async params => {
    entered(); await terminal;
    return observationResult(params, { replyUnavailableReason: 'generation-turn-not-latest' });
  });
  t.after(release);
  const rejected = assert.rejects(f.client.callTool(server.source), /Router browser observation channel is unavailable/u);
  await started;
  const pending = [...f.bridge.pending.values()][0];
  assert.equal(await brokerWake(t, pending), 'broker_error');
  assert.equal((await server.waitForRequest()).method, 'GET');
  release(); await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'broker_error');
});

test('private broker HTTP reaches a real listener on Fetch-forbidden port 10080', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const server = await observationServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ closed: false, revision: 1 }));
  }, 10080);
  const f = await protocolFixture(t, async params => { entered(); await terminal; return observationResult(params); });
  t.after(release);
  const answer = f.client.callTool(server.source).then(result => ({ result }), error => ({ error }));
  await started;
  const pending = [...f.bridge.pending.values()][0];
  assert.equal(await brokerWake(t, pending), 'broker_activity');
  const request = await server.waitForRequest();
  assert.deepEqual(request, { method: 'GET', url: new URL(server.url).pathname + '?revision=0', accept: 'application/json' });
  release();
  const outcome = await answer;
  assert.equal(outcome.error, undefined);
  assert.match(outcome.result.content[0].text, /"completed":false/u);
  assert.equal(f.calls.length, 1);
  assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'broker_activity');
});

test('private broker HTTP bounds its control body and rejects redirects, malformed output and invalid revisions', async t => {
  const valid = JSON.stringify({ closed: false, revision: 1 });
  for (const branch of [
    { name: '4096-byte valid envelope', body: valid.padEnd(4096), ok: true },
    { name: '4097-byte envelope', body: valid.padEnd(4097) },
    { name: 'malformed JSON', body: '{' },
    { name: 'invalid UTF-8', body: Buffer.from([0xff]) },
    { name: 'truncated body', body: valid, headers: { 'content-length': Buffer.byteLength(valid) + 1 } },
    { name: 'redirect', body: valid, status: 302, headers: { location: '/must-not-follow' } },
    { name: 'backward revision', body: JSON.stringify({ closed: false, revision: -1 }) },
    { name: 'extra schema field', body: JSON.stringify({ closed: false, revision: 1, extra: true }) },
  ]) await t.test(branch.name, async subtest => {
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: terminal, resolve: release } = Promise.withResolvers();
    const server = await observationServer(subtest, (_request, response) => {
      response.writeHead(branch.status ?? 200, { 'content-type': 'application/json', ...branch.headers });
      response.end(branch.body);
    });
    const f = await protocolFixture(subtest, async params => { entered(); await terminal; return observationResult(params); });
    subtest.after(release);
    const answer = f.client.callTool(server.source).then(result => ({ result }), error => ({ error }));
    await started;
    const pending = [...f.bridge.pending.values()][0];
    assert.equal(await brokerWake(subtest, pending), branch.ok ? 'broker_activity' : 'broker_error');
    release();
    const outcome = await answer;
    if (branch.ok) assert.match(outcome.result.content[0].text, /"completed":false/u);
    else { assert.equal(outcome.error.code, -32603); assert.match(outcome.error.message, /observation channel is unavailable/u); }
    assert.equal(server.requests.length, 1, 'The private channel never follows a redirect or retries.');
    assert.equal(f.calls.length, 1);
  });
});

test('browser completion aborts the owned broker HTTP request before headers and during its body', async t => {
  for (const headersStarted of [false, true]) await t.test(headersStarted ? 'partial body' : 'before headers', async subtest => {
    const { promise: terminal, resolve: release } = Promise.withResolvers();
    const connectionEvents = recordedEvents(subtest);
    const clientPhases = recordedEvents(subtest);
    let partialResponse;
    const server = await observationServer(subtest, (_request, response) => {
      response.once('close', () => connectionEvents.record('closed'));
      if (headersStarted) {
        partialResponse = response;
        response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
      }
    });
    if (headersStarted) {
      const endpoint = new URL(server.url), starts = channel('http.client.request.start');
      const observeClient = ({ request }) => {
        if (request.method !== 'GET' || request.getHeader('host') !== endpoint.host || request.path !== endpoint.pathname + endpoint.search) return;
        request.once('response', response => {
          clientPhases.record({ phase: 'headers', status: response.statusCode });
          response.once('readable', () => clientPhases.record({ phase: 'body', bytes: response.readableLength, complete: response.complete }));
        });
      };
      starts.subscribe(observeClient); subtest.after(() => starts.unsubscribe(observeClient));
    }
    const f = await protocolFixture(subtest, async params => { await terminal; return observationResult(params, { completed: true }); });
    subtest.after(release);
    const answer = f.client.callTool(server.source);
    await server.waitForRequest();
    if (headersStarted) {
      assert.equal((await clientPhases.waitFor(event => event.phase === 'headers')).status, 200);
      partialResponse.write('{"closed":');
      assert.deepEqual(await clientPhases.waitFor(event => event.phase === 'body'), {
        phase: 'body', bytes: Buffer.byteLength('{"closed":'), complete: false,
      });
    }
    release();
    assert.match((await answer).content[0].text, /"completed":true/u);
    await connectionEvents.waitFor(() => true);
    assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'browser_ready');
    assert.equal(f.calls.length, 1);
  });
});

test('SDK protocol preserves declarations, capabilities, instructions and explicit adapter identity', async t => {
  const f = await protocolFixture(t, () => ordinaryResult);
  assert.deepEqual(f.client.getServerVersion(), ADAPTER_INFO);
  assert.deepEqual(f.client.getServerCapabilities(), { tools: {}, experimental: { 'codex/sandbox-state': {} } });
  assert.equal(f.client.getInstructions(), 'official fixture instructions');
  assert.deepEqual((await f.client.listTools()).tools, f.declarations);
  for (const params of [{ name: 'unknown_tool', arguments: { future: true }, _meta: { opaque: ['preserved'] } },
    { name: 'js', arguments: { code: 'ordinary fixture' }, _meta: { opaque: { preserve: true } } }]) {
    await f.client.callTool(params); assert.deepEqual(f.calls.at(-1), params);
  }
  await f.client.ping();
  assert.ok(f.forwardedInner.some(message => message.method === 'ping'));
});

test('cold owned callback reports refusal while a cold builtin forwards without mutation', async t => {
  const f = await protocolFixture(t, () => ordinaryResult);
  assert.equal((await f.client.callTool(hook())).isError, true);
  await f.client.callTool(builtin());
  assert.deepEqual(f.calls, [builtin()]);
});

test('either callback arrival order gives cleanup exclusively to the owned callback', async t => {
  for (const builtinFirst of [false, true]) await t.test(builtinFirst ? 'builtin first' : 'owned first', async subtest => {
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await gate; return success(); }
      return ordinaryResult;
    });
    await f.client.callTool(ordinary());
    let original, owned;
    if (builtinFirst) { original = f.client.callTool(builtin()); await f.waitForReceipt('builtin_interrupt_waiting'); owned = f.client.callTool(hook()); }
    else { owned = f.client.callTool(hook()); await started; original = f.client.callTool(builtin()); }
    await started;
    if (!builtinFirst) await f.waitForReceipt('builtin_interrupt_queued');
    assert.equal(f.calls.length, 2); assert.equal(f.calls.some(params => params.name === 'turn_ended'), false);
    release();
    assert.equal((await owned).isError, undefined); await original;
    assert.deepEqual(f.calls[2], builtin());
    assert.equal(f.calls.some(params => params.name === INTERRUPT_TOOL), false);
    assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 1);
  });
});

test('builtin cancellation never aborts the separately owned cleanup, for either arrival order', async t => {
  for (const builtinFirst of [false, true]) await t.test(builtinFirst ? 'builtin first' : 'owned first', async subtest => {
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await gate; return success(); }
      return ordinaryResult;
    });
    await f.client.callTool(ordinary());
    const control = new AbortController(); let original, owned;
    const callBuiltin = () => f.client.callTool(builtin(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    if (builtinFirst) {
      original = callBuiltin(); await f.waitForReceipt('builtin_interrupt_waiting'); control.abort();
      await f.waitForReceipt('builtin_cancel_queued'); owned = f.client.callTool(hook());
    } else {
      owned = f.client.callTool(hook()); await started; original = callBuiltin();
      await f.waitForReceipt('builtin_interrupt_queued'); control.abort(); await f.waitForReceipt('builtin_cancel_queued');
    }
    await started;
    assert.equal(f.cancellations.length, 0);
    release(); assert.equal((await owned).isError, undefined); assert.equal(await original, 'cancelled');
    const wire = await f.waitForInner(message => message.params?.name === 'turn_ended');
    await f.waitForInner(message => message.method === 'notifications/cancelled' && message.params.requestId === wire.id);
    assert.ok(wire);
    assert.ok(f.forwardedInner.some(message => message.method === 'notifications/cancelled' && message.params.requestId === wire.id));
    assert.equal(f.cancellations.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
    assert.equal(f.receipts.some(entry => entry.code === 'cleanup_owner_cancel_received'), false);
    assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 1);
  });
});

test('builtin coalescing expiry alone never starts Stop and preserves a later trusted callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult, { builtinWaitMs: 10 });
  await f.client.callTool(ordinary());
  const original = f.client.callTool(builtin()); await f.waitForReceipt('builtin_interrupt_waiting');
  t.mock.timers.tick(10); await original;
  assert.deepEqual(f.calls, [ordinary(), builtin()]);
  assert.equal((await f.client.callTool(hook())).isError, undefined);
  assert.equal(f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn')).length, 1);
});

test('late owned cleanup waits for a forwarded builtin actual terminal, including terminal errors', async t => {
  for (const rpcError of [false, true]) await t.test(rpcError ? 'RPC error' : 'tool result', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    let builtinRunning = false;
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: terminal, resolve: release } = Promise.withResolvers();
    const f = await protocolFixture(subtest, async params => {
      if (params.name === 'turn_ended') {
        builtinRunning = true; entered(); await terminal; builtinRunning = false;
        if (rpcError) throw new McpError(-32603, 'synthetic builtin terminal error');
        return ordinaryResult;
      }
      if (params.arguments?.code?.includes('stopOwnedWebTurn')) { assert.equal(builtinRunning, false); return success(); }
      return ordinaryResult;
    }, { builtinWaitMs: 10 });
    await f.client.callTool(ordinary());
    const original = f.client.callTool(builtin()).catch(() => 'actual terminal error');
    await f.waitForReceipt('builtin_interrupt_waiting'); subtest.mock.timers.tick(10); await started;
    const owned = f.client.callTool(hook()); await f.waitForReceipt('cleanup_authority_consumed');
    assert.equal(f.calls.length, 2, 'Forwarding a callback is not its terminal response.');
    release();
    assert.equal((await owned).isError, undefined);
    assert.deepEqual(await original, rpcError ? 'actual terminal error' : ordinaryResult);
    assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 1);
    assert.equal(f.receipts.some(entry => entry.code === 'builtin_terminal_observed'), true);
  });
});

test('late owned cleanup cannot cross a new ordinary turn after builtin coalescing expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult, { builtinWaitMs: 10 });
  await f.client.callTool(ordinary());
  const original = f.client.callTool(builtin()); await f.waitForReceipt('builtin_interrupt_waiting');
  t.mock.timers.tick(10); await original;
  await f.client.callTool(ordinary(TURN2));
  assert.equal((await f.client.callTool(hook())).isError, true);
  assert.equal((await f.client.callTool(hook(TURN2))).isError, undefined);
  assert.equal(f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn')).length, 1);
});

test('deadline or owner cancellation while awaiting a forwarded builtin cannot authorize Stop', async t => {
  for (const cancelOwner of [false, true]) await t.test(cancelOwner ? 'owner cancellation' : 'shared deadline', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: terminal, resolve: release } = Promise.withResolvers();
    const f = await protocolFixture(subtest, async params => {
      if (params.name === 'turn_ended') { entered(); await terminal; }
      return ordinaryResult;
    }, { builtinWaitMs: 5, graceMs: 40, cleanupMs: 10 });
    await f.client.callTool(ordinary());
    const original = f.client.callTool(builtin()); await f.waitForReceipt('builtin_interrupt_waiting');
    subtest.mock.timers.tick(5); await started;
    const control = new AbortController();
    const owned = f.client.callTool(hook(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    await f.waitForReceipt('cleanup_authority_consumed');
    if (cancelOwner) control.abort();
    else subtest.mock.timers.tick(40);
    const proof = await owned;
    assert.equal(cancelOwner ? proof : proof.isError, cancelOwner ? 'cancelled' : true);
    if (cancelOwner) await f.waitForReceipt('cleanup_owner_cancel_received');
    assert.equal(f.calls.length, 2);
    assert.equal(f.cancellations.length, 0, 'Owned cleanup cannot cancel an original builtin.');
    release(); assert.deepEqual(await original, ordinaryResult);
    assert.equal((await f.client.callTool(hook())).isError, true, 'A late builtin terminal cannot revive consumed cleanup.');
    assert.equal(f.calls.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
  });
});

test('all released builtins form the barrier before a backpressured first request is sent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: transportBlocked, resolve: blocked } = Promise.withResolvers();
  const { promise: transportGate, resolve: unblock } = Promise.withResolvers();
  const { promise: secondStarted, resolve: secondEntered } = Promise.withResolvers();
  const { promise: secondTerminal, resolve: releaseSecond } = Promise.withResolvers();
  let builtinCount = 0;
  const f = await protocolFixture(t, async params => {
    if (params.name === 'turn_ended' && ++builtinCount === 2) { secondEntered(); await secondTerminal; }
    return params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult;
  }, { builtinWaitMs: 10 });
  const send = f.bridge.child.send.bind(f.bridge.child);
  let first = true;
  f.bridge.child.send = async message => {
    if (message.params?.name === 'turn_ended' && first) { first = false; blocked(); await transportGate; }
    return send(message);
  };
  await f.client.callTool(ordinary());
  const originals = [f.client.callTool(builtin()), f.client.callTool(builtin())];
  await f.waitForReceipt('builtin_interrupt_waiting', () => f.receipts.filter(entry => entry.code === 'builtin_interrupt_waiting').length === 2);
  t.mock.timers.tick(10);
  await transportBlocked;
  const owned = f.client.callTool(hook()); await f.waitForReceipt('cleanup_authority_consumed');
  unblock(); await secondStarted;
  assert.equal(f.calls.length, 3, 'The first actual terminal cannot release cleanup ahead of the second builtin.');
  releaseSecond();
  assert.equal((await owned).isError, undefined); await Promise.all(originals);
  assert.equal(f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn')).length, 1);
});

test('an inactive generation after a rejected click keeps the uncertainty in the successful receipt', async t => {
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn')
    ? success({ outcome: 'already_idle', stopClicked: false, clickError: true }) : ordinaryResult);
  await f.client.callTool(ordinary());
  assert.equal((await f.client.callTool(hook())).isError, undefined);
  const receipt = f.receipts.find(entry => entry.code === 'stop_confirmed');
  assert.equal(receipt.clickAttempted, true); assert.equal(receipt.clickError, true);
  assert.equal(receipt.stopClicked, false); assert.equal(receipt.generationInactive, true); assert.equal(receipt.stopHidden, true);
  assert.equal(receipt.inactivityEvidence, 'turn_complete');
});

test('the successful receipt preserves composer-restored evidence through the ordinary adapter hook path', async t => {
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn')
    ? success({ inactivityEvidence: 'composer_restored' }) : ordinaryResult);
  await f.client.callTool(ordinary());
  assert.equal((await f.client.callTool(hook())).isError, undefined);
  const receipt = f.receipts.find(entry => entry.code === 'stop_confirmed');
  assert.equal(receipt.inactivityEvidence, 'composer_restored');
  assert.equal(receipt.generationInactive, true); assert.equal(receipt.stopClicked, true);
  assert.equal(receipt.clickAttempted, true); assert.equal(receipt.clickError, false);
});

test('transport backpressure cannot forward a builtin cancellation before its original request', async t => {
  for (const blockedTransport of ['owned_reply', 'builtin_request']) await t.test(blockedTransport, async subtest => {
    const { promise: started, resolve: stopEntered } = Promise.withResolvers();
    const { promise: stopGate, resolve: releaseStop } = Promise.withResolvers();
    const { promise: transportBlocked, resolve: transportEntered } = Promise.withResolvers();
    const { promise: transportGate, resolve: releaseTransport } = Promise.withResolvers();
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code?.includes('stopOwnedWebTurn')) { stopEntered(); await stopGate; return success(); }
      return ordinaryResult;
    });
    subtest.after(() => { releaseStop(); releaseTransport(); });
    const transport = blockedTransport === 'owned_reply' ? f.bridge.outer : f.bridge.child;
    const send = transport.send.bind(transport);
    transport.send = async message => {
      const matches = blockedTransport === 'owned_reply'
        ? message.result?.content?.[0]?.text?.includes('ROUTER_WEB_STOP_ADAPTER ')
        : message.method === 'tools/call' && message.params?.name === 'turn_ended';
      if (matches) { transportEntered(); await transportGate; }
      return send(message);
    };
    await f.client.callTool(ordinary());
    const owned = f.client.callTool(hook()); await started;
    const control = new AbortController();
    const original = f.client.callTool(builtin(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    await f.waitForReceipt('builtin_interrupt_queued'); releaseStop(); await transportBlocked;
    control.abort(); await f.waitForReceipt('builtin_cancel_queued');
    assert.equal(f.forwardedInner.some(message => message.method === 'notifications/cancelled'), false);
    assert.equal(f.forwardedInner.some(message => message.params?.name === 'turn_ended'), false);
    if (blockedTransport === 'builtin_request') {
      // An old callback still draining through the transport cannot make a new
      // ordinary turn overlap a cleanup operation that has already completed.
      assert.equal((await owned).isError, undefined);
      await f.client.callTool(ordinary(TURN2));
      assert.equal((await f.client.callTool(hook(TURN2))).isError, undefined);
    }
    releaseTransport(); assert.equal((await owned).isError, undefined);
    assert.equal(await original, 'cancelled');
    const wire = await f.waitForInner(message => message.method === 'tools/call' && message.params?.name === 'turn_ended');
    await f.waitForInner(message => message.method === 'notifications/cancelled' && message.params.requestId === wire.id);
    const requestIndex = f.forwardedInner.findIndex(message => message.method === 'tools/call' && message.params?.name === 'turn_ended');
    assert.ok(requestIndex >= 0);
    const request = f.forwardedInner[requestIndex];
    const cancelIndex = f.forwardedInner.findIndex(message => message.method === 'notifications/cancelled' && message.params.requestId === request.id);
    assert.ok(cancelIndex > requestIndex);
    assert.equal(f.cancellations.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
    assert.equal(f.receipts.some(entry => entry.code === 'cleanup_owner_cancel_received'), false);
  });
});

test('ordinary calls carrying callId remain ordinary even with lifecycle names and arguments', async t => {
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult);
  await f.client.callTool(ordinary());
  for (const name of ['turn_ended', INTERRUPT_TOOL]) {
    const params = { ...hook(), name, _meta: { ...hook()._meta, callId: 'ordinary_call' } };
    await f.client.callTool(params); assert.deepEqual(f.calls.at(-1), params);
  }
  assert.equal(f.receipts.some(entry => entry.code === 'cleanup_authority_consumed'), false);
});

test('owner cancellation cancels only injected Stop and preserves queued builtin message and cancellation', async t => {
  let clock = 1000;
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const f = await protocolFixture(t, async (params, extra) => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) {
      entered(); await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true })); return success();
    }
    return ordinaryResult;
  }, { now: () => clock });
  await f.client.callTool(ordinary());
  const ownerControl = new AbortController(), builtinControl = new AbortController();
  const owned = f.client.callTool(hook(), undefined, { signal: ownerControl.signal }).catch(() => 'cancelled');
  await started;
  const original = f.client.callTool(builtin(), undefined, { signal: builtinControl.signal }).catch(() => 'cancelled');
  await f.waitForReceipt('builtin_interrupt_queued'); builtinControl.abort(); await f.waitForReceipt('builtin_cancel_queued');
  clock = 2012; ownerControl.abort();
  assert.equal(await owned, 'cancelled'); assert.equal(await original, 'cancelled');
  await f.waitForCancellation(params => params.arguments?.code?.includes('stopOwnedWebTurn'));
  const builtinWire = await f.waitForInner(message => message.params?.name === 'turn_ended');
  await f.waitForInner(message => message.method === 'notifications/cancelled' && message.params.requestId === builtinWire.id);
  assert.equal(f.cancellations.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn')).length, 1);
  assert.equal(f.calls.some(params => params.name === INTERRUPT_TOOL), false);
  assert.deepEqual(f.calls.at(-1), builtin());
  assert.deepEqual(f.receipts.find(entry => entry.code === 'cleanup_owner_cancel_received'), {
    at: new Date(clock).toISOString(), code: 'cleanup_owner_cancel_received', generation: GENERATION, elapsedMs: 1012 });
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
  const injected = f.forwardedInner.find(message => message.params?.arguments?.code?.includes('stopOwnedWebTurn'));
  const hookReplies = f.forwardedOuter.filter(message => message.result?.content?.[0]?.text?.includes('ROUTER_WEB_STOP_ADAPTER')).length;
  // Cancellation notification is not a terminal callback. The fixture SDK
  // suppresses its cancelled handler's return, so deliver the real child frame.
  await f.serverWire.send({ jsonrpc: '2.0', id: injected.id, result: success() });
  await f.waitForReceipt('stop_terminal_after_retirement');
  const historical = f.receipts.find(entry => entry.code === 'stop_terminal_after_retirement');
  assert.equal(historical.retirementReason, 'cleanup_cancelled'); assert.equal(historical.proofOk, true);
  assert.equal(historical.requestDigest, f.receipts.find(entry => entry.code === 'stop_native_dispatched').requestDigest);
  assert.match(historical.requestDigest, /^[a-f0-9]{64}$/u);
  assert.equal(historical.childTerminalObserved, true);
  assert.equal(f.forwardedOuter.some(message => message.id === injected.id), false);
  assert.equal(f.forwardedOuter.filter(message => message.result?.content?.[0]?.text?.includes('ROUTER_WEB_STOP_ADAPTER')).length, hookReplies);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
});

test('duplicate owned and builtin callbacks share one attempt without replacing originals', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await gate; return success(); }
    return ordinaryResult;
  });
  await f.client.callTool(ordinary()); const first = f.client.callTool(hook()); await started;
  const duplicate = f.client.callTool(hook()), one = f.client.callTool(builtin()), two = f.client.callTool(builtin());
  await f.waitForReceipt('cleanup_duplicate_queued');
  await f.waitForReceipt('builtin_interrupt_queued', () => f.receipts.filter(entry => entry.code === 'builtin_interrupt_queued').length === 2);
  release(); const results = await Promise.all([first, duplicate, one, two]);
  assert.equal(results[0].isError, undefined); assert.deepEqual(results[0], results[1]);
  assert.equal(f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn')).length, 1);
  assert.deepEqual(f.calls.filter(params => params.name === 'turn_ended'), [builtin(), builtin()]);
});

test('subagents cannot acquire authority even when their Router script and sandbox are otherwise valid', async t => {
  for (const field of ['parent_thread_id', 'subagent_header', 'subagent_kind']) await t.test(field, async subtest => {
    const source = ordinary(); source._meta['x-codex-turn-metadata'][field] = field === 'parent_thread_id' ? SESSION : 'worker';
    assert.equal(readIdentity(source._meta), null);
    assert.equal(qualifyBrowserCall(source, STOP_CONFIG.runtimeModule), null);
    const f = await protocolFixture(subtest, () => ordinaryResult);
    await f.client.callTool(source); assert.equal((await f.client.callTool(hook())).isError, true);
    assert.deepEqual(f.calls, [source]);
  });
});

function inThread(params, threadId) {
  const result = clone(params), original = result._meta.threadId;
  result._meta.threadId = threadId;
  if (result._meta['x-codex-turn-metadata']) result._meta['x-codex-turn-metadata'].thread_id = threadId;
  if (result.arguments?.code) result.arguments.code = result.arguments.code.replaceAll(original, threadId);
  return result;
}

test('two ordinary chats obtain independent thread identities even with the same turn token', async t => {
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult);
  const first = ordinary(), second = inThread(ordinary(), SESSION);
  await f.client.callTool(first); await f.client.callTool(hook());
  await f.client.callTool(second); await f.client.callTool(inThread(hook(), SESSION));
  const injected = f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn'));
  assert.equal(injected.length, 2);
  assert.deepEqual(injected[0]._meta, retainedMetadata(first._meta));
  assert.deepEqual(injected[1]._meta, retainedMetadata(second._meta));
  assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 2);
});

test('narrow thread configuration excludes other ordinary chats without altering their calls', async t => {
  const f = await protocolFixture(t, () => ordinaryResult, { stopConfig: { ...STOP_CONFIG, threadIds: [APPROVED_THREAD] } });
  const source = inThread(ordinary(), SESSION);
  await f.client.callTool(source); await f.client.callTool(inThread(hook(), SESSION));
  assert.deepEqual(f.calls, [source]); assert.equal(f.receipts.some(entry => entry.code === 'authority_cached'), false);
});

test('long ordinary conversations continue to acquire fresh authority after 128 retired turns', async t => {
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult);
  for (let index = 0; index < 135; index++) {
    const turn = `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;
    await f.client.callTool(ordinary(turn)); await f.client.callTool(hook(turn));
  }
  assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 135);
});

test('opaque authority replacement is sticky within a turn and a new turn retains its own complete authority', async t => {
  const f = await protocolFixture(t, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult);
  await f.client.callTool(withAuthority(ordinary(), 'first'));
  await f.client.callTool(withAuthority(ordinary(), 'changed'));
  await f.client.callTool(withAuthority(ordinary(), 'first'));
  assert.equal((await f.client.callTool(hook())).isError, true);
  const next = withAuthority(ordinary(TURN2), 'next');
  await f.client.callTool(next); await f.client.callTool(hook(TURN2));
  assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 1);
  assert.deepEqual(f.calls.find(params => params.arguments?.code?.includes('stopOwnedWebTurn'))._meta, retainedMetadata(next._meta));
});

test('generic JS and reset invalidate cached authority and keep changed current-turn authority sticky', async t => {
  for (const name of ['js', 'js_reset']) await t.test(name, async subtest => {
    const f = await protocolFixture(subtest, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult);
    const generic = { name, arguments: name === 'js' ? { code: 'void 0' } : {}, _meta: clone(ordinary()._meta) };
    generic._meta.callId = 'ordinary_generic'; generic._meta['x-codex-turn-metadata'].node_repl_disabled = true;
    await f.client.callTool(ordinary()); await f.client.callTool(generic); await f.client.callTool(ordinary());
    assert.equal((await f.client.callTool(hook())).isError, true);
    assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
    assert.ok(f.receipts.some(entry => entry.code === 'authority_replaced'));
  });
});

test('stale, forged and conflicting owned callbacks never reach the official child', async t => {
  for (const branch of ['thread', 'turn', 'session', 'authority', 'event']) await t.test(branch, async subtest => {
    const f = await protocolFixture(subtest, () => ordinaryResult); await f.client.callTool(ordinary());
    const forged = hook();
    if (branch === 'thread') forged._meta.threadId = SESSION;
    if (branch === 'turn') forged.arguments.turn_id = TURN2;
    if (branch === 'session') forged.arguments.session_id = SESSION;
    if (branch === 'authority') forged._meta.unknownAuthority = true;
    if (branch === 'event') forged.arguments.hook_event_name = 'Stop';
    assert.equal((await f.client.callTool(forged)).isError, true); assert.deepEqual(f.calls, [ordinary()]);
  });
});

test('unqualified ordinary cancellation reaches the official child immediately without Stop', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const f = await protocolFixture(t, async (params, extra) => {
    entered(); await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true })); return ordinaryResult;
  });
  const control = new AbortController();
  const pending = f.client.callTool({ name: 'js', arguments: { code: 'unqualified' } }, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await started; control.abort(); await f.waitForCancellation(() => true);
  assert.equal(await pending, 'cancelled'); assert.equal(f.cancellations.length, 1); assert.equal(f.calls.length, 1);
});

test('observation cancellation can settle before owned cleanup; no callback expires the original cancellation once', async t => {
  for (const useOwned of [true, false]) await t.test(useOwned ? 'owned cleanup' : 'no callback', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const f = await protocolFixture(subtest, async (params, extra) => {
      if (params.arguments?.code === ordinary().arguments.code) {
        entered(); if (useOwned) await gate;
        else await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
      }
      return params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult;
    }, useOwned ? {} : { graceMs: 40, cleanupMs: 10 });
    const control = new AbortController();
    const pending = f.client.callTool(ordinary(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    await started; control.abort(); await f.waitForReceipt('observation_cancel_deferred'); assert.equal(f.cancellations.length, 0);
    if (useOwned) { const owned = f.client.callTool(hook()); release(); await owned; assert.ok(f.receipts.some(entry => entry.code === 'stop_confirmed')); }
    else {
      subtest.mock.timers.tick(40); await f.waitForReceipt('cancel_grace_expired'); await f.waitForCancellation(() => true);
      assert.equal(f.cancellations.length, 1);
    }
    await pending;
  });
});

test('a terminal observation error releases owned cleanup without changing the original error or overlapping JS', async t => {
  for (const rpcError of [false, true]) await t.test(rpcError ? 'RPC error' : 'tool error', async subtest => {
    let running = true;
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const source = ordinary(), errorResult = { isError: true, content: [{ type: 'text', text: 'Synthetic interrupted observation' }] };
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code === source.arguments.code) {
        entered(); await gate; running = false;
        if (rpcError) throw new McpError(-32000, 'Synthetic interrupted observation', { fixture: true });
        return errorResult;
      }
      if (params.arguments?.code?.includes('stopOwnedWebTurn')) {
        assert.equal(running, false); return success();
      }
      return ordinaryResult;
    });
    const observation = f.client.callTool(source).then(result => ({ result }), error => ({ error }));
    await started;
    const owned = f.client.callTool(hook()), originals = Array.from({ length: 3 }, () => f.client.callTool(builtin()));
    await f.waitForReceipt('cleanup_authority_consumed');
    await f.waitForReceipt('builtin_interrupt_queued', () => f.receipts.filter(entry => entry.code === 'builtin_interrupt_queued').length === 3);
    assert.ok(f.receipts.some(entry => entry.code === 'cleanup_authority_consumed'));
    assert.deepEqual(f.calls, [source]);
    release();
    const outcome = await observation;
    const [ownedResult] = await Promise.all([owned, ...originals]);
    assert.equal(ownedResult.isError, undefined);
    const sourceWire = f.forwardedInner.find(message => message.method === 'tools/call' && message.params.arguments?.code === source.arguments.code);
    const response = f.forwardedOuter.find(message => message.id === sourceWire.id && !message.method);
    if (rpcError) {
      assert.equal(outcome.error.code, -32000);
      assert.deepEqual(response.error, { code: -32000, message: 'MCP error -32000: Synthetic interrupted observation', data: { fixture: true } });
    } else {
      assert.deepEqual(outcome.result, errorResult); assert.deepEqual(response.result, errorResult);
    }
    const injected = f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn'));
    assert.equal(injected.length, 1); assert.deepEqual(injected[0]._meta, retainedMetadata(source._meta));
    assert.deepEqual(f.calls.filter(params => params.name === 'turn_ended'), [builtin(), builtin(), builtin()]);
    assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 1);
    assert.equal(f.receipts.some(entry => entry.code === 'observe_not_settled'), false);
    const terminal = f.receipts.find(entry => entry.code === 'interrupted_observation_terminal');
    assert.equal(terminal.childTerminalObserved, true); assert.equal(terminal.cleanupActive, true);
    assert.equal(terminal.rpcError, rpcError); assert.equal(terminal.toolError, !rpcError);
    assert.equal(terminal.resultSucceeded, false);
  });
});

test('a real child return after 500 ms releases one Stop within the original shared callback deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let running = true;
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const { promise: cleanupStarted, resolve: cleanupEntered } = Promise.withResolvers();
  const source = ordinary();
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code === source.arguments.code) { entered(); await gate; running = false; return ordinaryResult; }
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) { assert.equal(running, false); return success(); }
    return ordinaryResult;
  });
  t.after(release);
  const receipt = f.bridge.receipt;
  f.bridge.receipt = entry => { receipt(entry); if (entry.code === 'cleanup_authority_consumed') cleanupEntered(); };
  const control = new AbortController();
  const observation = f.client.callTool(source, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await started; control.abort();
  assert.equal(await observation, 'cancelled');
  assert.ok(f.receipts.some(entry => entry.code === 'observation_cancel_deferred'));
  t.mock.timers.tick(200);
  const owned = f.client.callTool(hook()), original = f.client.callTool(builtin());
  await cleanupStarted;
  t.mock.timers.tick(500);
  await f.client.ping();
  assert.equal(f.calls.length, 1, 'The outer cancellation and 500 elapsed ms do not end the child invocation.');
  assert.equal(f.receipts.some(entry => entry.code === 'interrupted_observation_terminal'), false);
  release();
  assert.equal((await owned).isError, undefined); await original;
  const injected = f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn'));
  assert.equal(injected.length, 1);
  assert.equal(injected[0].arguments.timeout_ms, 2150);
  for (const elapsedMs of [2050, 2051]) {
    let started = false, readLedger = false;
    const context = vm.createContext({ Date: { now: () => { if (!started) { started = true; return 0; } return elapsedMs; } },
      nodeRepl: { write: value => assert.deepEqual(JSON.parse(value), {}) },
      __publicImport: async () => ({ lstatSync: () => { readLedger = true; throw Object.assign(new Error(), { code: 'ENOENT' }); } }) });
    const program = injected[0].arguments.code.replaceAll('import(', '__publicImport(');
    await new vm.Script(`(async () => { ${program} })()`).runInContext(context, { timeout: 1000 });
    assert.equal(readLedger, elapsedMs === 2050, 'The generated cleanup uses only its 2050 ms remaining browser budget.');
  }
  assert.deepEqual(injected[0]._meta, retainedMetadata(source._meta));
  const terminal = f.receipts.find(entry => entry.code === 'interrupted_observation_terminal');
  assert.deepEqual({ elapsedMs: terminal.elapsedMs, callbackElapsedMs: terminal.callbackElapsedMs,
    childTerminalObserved: terminal.childTerminalObserved, rpcError: terminal.rpcError, toolError: terminal.toolError }, {
    elapsedMs: 700, callbackElapsedMs: 500, childTerminalObserved: true, rpcError: false, toolError: false });
  assert.equal(terminal.resultSucceeded, true);
  assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 1);
  assert(Date.now() <= 3850, 'The original 2850 ms deadline is never renewed.');
  const sourceWire = f.forwardedInner.find(message => message.params?.arguments?.code === source.arguments.code);
  assert.deepEqual(f.forwardedOuter.filter(message => message.id === sourceWire.id && !message.method).map(message => message.result), [ordinaryResult]);
  assert.deepEqual(f.calls.filter(params => params.name === 'turn_ended'), [builtin()]);
});

test('a failed observation outside owned cleanup revokes cached authority', async t => {
  const errorResult = { isError: true, content: [{ type: 'text', text: 'Synthetic observation failure' }] };
  const f = await protocolFixture(t, () => errorResult);
  assert.deepEqual(await f.client.callTool(ordinary()), errorResult);
  assert.equal(f.receipts.some(entry => entry.code === 'interrupted_observation_terminal'), false);
  assert.equal((await f.client.callTool(hook())).isError, true);
  assert.deepEqual(f.calls, [ordinary()]);
  assert.ok(f.receipts.some(entry => entry.code === 'ordinary_js_failed'));
});

test('a terminal observation error cannot revive cleanup after owner cancellation or authority replacement', async t => {
  for (const replaceAuthority of [false, true]) await t.test(replaceAuthority ? 'authority replacement' : 'owner cancellation', async subtest => {
    const { promise: started, resolve: entered } = Promise.withResolvers();
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const source = ordinary(), errorResult = { isError: true, content: [{ type: 'text', text: 'Synthetic interrupted observation' }] };
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code === source.arguments.code) { entered(); await gate; return errorResult; }
      return ordinaryResult;
    });
    const observation = f.client.callTool(source); await started;
    const control = new AbortController();
    const owned = f.client.callTool(hook(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    await f.waitForReceipt('cleanup_authority_consumed');
    if (replaceAuthority) {
      const generic = withAuthority(source, 'replacement'); generic.arguments = { code: 'void 0' };
      await f.client.callTool(generic);
      assert.ok(f.receipts.some(entry => entry.code === 'authority_replaced'));
    } else {
      control.abort(); await f.waitForReceipt('cleanup_owner_cancel_received');
    }
    release(); assert.deepEqual(await observation, errorResult);
    const result = await owned;
    assert.equal(replaceAuthority ? result.isError : result, replaceAuthority ? true : 'cancelled');
    assert.equal(f.calls.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
    assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
  });
});

test('owner cancellation releases the child-terminal wait before the child returns and preserves its late actual result', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const source = ordinary(), errorResult = { isError: true, content: [{ type: 'text', text: 'Synthetic interrupted observation' }] };
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code === source.arguments.code) { entered(); await gate; return errorResult; }
    return ordinaryResult;
  });
  t.after(release);
  const observation = f.client.callTool(source); await started;
  const control = new AbortController();
  const owned = f.client.callTool(hook(), undefined, { signal: control.signal }).catch(() => 'cancelled');
  const original = f.client.callTool(builtin());
  await f.waitForReceipt('builtin_interrupt_queued'); control.abort();
  assert.equal(await owned, 'cancelled');
  assert.deepEqual(await original, ordinaryResult, 'The builtin is released without waiting for a child result.');
  assert.deepEqual(f.calls, [source, builtin()]);
  assert.equal(f.receipts.some(entry => entry.code === 'interrupted_observation_terminal'), false);
  release(); assert.deepEqual(await observation, errorResult);
  assert.deepEqual(f.calls, [source, builtin()]);
  const terminal = f.receipts.find(entry => entry.code === 'interrupted_observation_terminal');
  assert.equal(terminal.childTerminalObserved, true); assert.equal(terminal.cleanupActive, false);
  assert.equal(terminal.toolError, true); assert.equal(terminal.resultSucceeded, false);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
  const diagnostic = JSON.stringify(terminal);
  for (const secret of [APPROVED_THREAD, TURN, 'Synthetic interrupted observation', 'private opaque value']) assert.equal(diagnostic.includes(secret), false);
  const sourceWire = f.forwardedInner.find(message => message.params?.arguments?.code === source.arguments.code);
  assert.deepEqual(f.forwardedOuter.filter(message => message.id === sourceWire.id && !message.method).map(message => message.result), [errorResult]);
});

test('blocked Stop exposes only validated progress; errors or malformed proof cannot become success', async t => {
  for (const branch of ['blocked', 'malformed', 'native_error']) await t.test(branch, async subtest => {
    const progress = { outcome: 'blocked', stage: 'handoff', freshController: true,
      clickAttempted: true, clickError: false, stopClicked: true, stopHidden: true, generationInactive: true, inactivityEvidence: 'turn_complete',
      retained: false, elapsedMs: 1012, code: 'browser_operation_failed' };
    const result = success({ ...progress, ...(branch === 'malformed' ? { privatePayload: 'secret output' } : {}) });
    if (branch === 'native_error') result.isError = true;
    const f = await protocolFixture(subtest, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? result : ordinaryResult);
    await f.client.callTool(ordinary()); assert.equal((await f.client.callTool(hook())).isError, true);
    const diagnostic = f.receipts.find(entry => entry.code === 'stop_unconfirmed');
    assert.ok(diagnostic); assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
    if (branch === 'blocked') assert.equal(diagnostic.stage, 'handoff');
    const receipts = JSON.stringify(f.receipts);
    for (const secret of ['secret output', 'private opaque value', 'private launcher value', 'private originating policy']) assert.equal(receipts.includes(secret), false);
  });
});

test('blocked Stop receipts retain safe readback observations and exclude unrecognized payloads', async t => {
  const observations = { readbackState: 'invalid_controls', readbackStopCount: 2, readbackIdleCount: 1,
    readbackIdleVisibleCount: 0, readbackUnrecognizedCount: 1, readbackLabelledByCount: 1,
    readbackStopVisible: true, readbackControlsRecognized: false, readbackComplete: null };
  for (const branch of ['valid', 'unconfirmed', 'unrecognized', 'malicious']) await t.test(branch, async subtest => {
    const privateText = 'synthetic-private-readback-url-and-key';
    const diagnostic = { ...observations,
      ...(branch === 'unconfirmed' ? { readbackState: 'unconfirmed_readback', readbackStopCount: 1,
        readbackUnrecognizedCount: 0, readbackControlsRecognized: true,
        readbackComplete: false } : {}),
      ...(branch === 'unrecognized' ? { readbackState: privateText } : {}),
      ...(branch === 'malicious' ? { readbackStopCount: { url: privateText }, privatePayload: privateText } : {}) };
    const result = success({ outcome: 'blocked', stage: 'stop_readback_visibility', stopHidden: false,
      generationInactive: false, inactivityEvidence: 'none', code: 'stop_confirmation_failed', ...diagnostic });
    const f = await protocolFixture(subtest, params => params.arguments?.code?.includes('stopOwnedWebTurn') ? result : ordinaryResult);
    await f.client.callTool(ordinary()); assert.equal((await f.client.callTool(hook())).isError, true);
    const receipt = f.receipts.find(entry => entry.code === 'stop_unconfirmed');
    assert.ok(receipt); assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
    if (branch === 'valid' || branch === 'unconfirmed') {
      assert.equal(receipt.resultCode, 'stop_confirmation_failed');
      for (const [key, value] of Object.entries(diagnostic)) assert.equal(receipt[key], value);
    } else {
      assert.equal(receipt.resultCode, 'malformed_proof');
      for (const key of Object.keys(observations)) assert.equal(Object.hasOwn(receipt, key), false);
    }
    assert.equal(JSON.stringify(f.receipts).includes(privateText), false);
  });
});

test('native Stop failures distinguish RPC rejection and tool errors without retaining private error data', async t => {
  for (const branch of ['rpc', 'tool', 'structured', 'unknown']) await t.test(branch, async subtest => {
    const privateText = 'synthetic-private-credential';
    const message = branch === 'rpc' ? 'js execution cancelled before execution'
      : branch === 'tool' ? `TypeError: ${privateText}` : branch === 'structured'
        ? JSON.stringify({ error: privateText, error_kind: 'reference_error' }) : `Cannot find package 'TypeError': ${privateText}`;
    const f = await protocolFixture(subtest, params => {
      if (!params.arguments?.code?.includes('stopOwnedWebTurn')) return ordinaryResult;
      if (branch === 'rpc') throw new McpError(-32602, message, { secret: privateText });
      return { isError: true, content: [{ type: 'text', text: message }] };
    });
    await f.client.callTool(ordinary());
    assert.equal((await f.client.callTool(hook())).isError, true);
    const diagnostic = f.receipts.find(entry => entry.code === 'stop_unconfirmed');
    assert.equal(diagnostic.resultCode, 'native_error');
    const failure = diagnostic.nativeFailure;
    assert.equal(failure.source, branch === 'rpc' ? 'rpc_error' : 'tool_error');
    assert.equal(failure.rpcCode, branch === 'rpc' ? -32602 : undefined);
    assert.deepEqual(failure.signatures, branch === 'rpc' ? ['cancelled_before_execution'] : []);
    assert.deepEqual(failure.errorClasses, branch === 'tool' ? ['TypeError'] : []);
    assert.deepEqual(failure.errorKinds, branch === 'structured' ? ['reference_error'] : []);
    assert.ok(failure.textBytes > 0);
    assert.match(failure.textSha256, /^[a-f0-9]{64}$/u);
    assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
    assert.equal(JSON.stringify(f.receipts).includes(privateText), false);
  });
});

test('overlapping ordinary JS cancels injected cleanup and prevents late success', async t => {
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const f = await protocolFixture(t, async (params, extra) => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) {
      entered(); await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true })); return success();
    }
    return ordinaryResult;
  });
  await f.client.callTool(ordinary()); const owned = f.client.callTool(hook()); await started;
  await f.client.callTool({ name: 'js', arguments: { code: 'ordinary overlap' } });
  assert.equal((await owned).isError, true);
  assert.equal(f.cancellations.length, 1); assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
});

test('conflicting ordinary authority after a forwarded builtin prevents later reacquisition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = await protocolFixture(t, () => ordinaryResult);
  await f.client.callTool(ordinary()); const original = f.client.callTool(builtin());
  await f.waitForReceipt('builtin_interrupt_waiting'); t.mock.timers.tick(150);
  await f.waitForCall(params => params.name === 'turn_ended');
  const conflicting = withAuthority(ordinary(), 'changed policy'); conflicting.arguments.code = 'ordinary invalidation';
  await f.client.callTool(conflicting); await original;
  await f.client.callTool(ordinary()); assert.equal((await f.client.callTool(hook())).isError, true);
  assert.equal(f.calls.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
});

test('unsettled observation refuses cleanup and releases the original native cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const f = await protocolFixture(t, async (params, extra) => {
    if (params.arguments?.code === ordinary().arguments.code) {
      entered(); await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
    }
    return ordinaryResult;
  }, { graceMs: 40 });
  const control = new AbortController();
  const pending = f.client.callTool(ordinary(), undefined, { signal: control.signal }).catch(() => 'cancelled');
  await started; control.abort(); await f.waitForReceipt('observation_cancel_deferred');
  const owned = f.client.callTool(hook()); await f.waitForReceipt('cleanup_authority_consumed');
  t.mock.timers.tick(40);
  assert.equal((await owned).isError, true); await pending; await f.waitForCancellation(() => true);
  assert.equal(f.cancellations.length, 1); assert.equal(f.calls.length, 1);
  assert.ok(f.receipts.some(entry => entry.code === 'observe_not_settled' || entry.code === 'cancel_grace_expired'));
  assert.equal(f.receipts.some(entry => entry.code === 'interrupted_observation_terminal'), false);
  const sourceWire = f.forwardedInner.find(message => message.params?.arguments?.code === ordinary().arguments.code);
  assert.equal(f.forwardedInner.filter(message => message.method === 'notifications/cancelled' && message.params.requestId === sourceWire.id).length, 1);
  const expired = f.receipts.find(entry => ['cancel_grace_expired', 'observation_terminal_unavailable'].includes(entry.code));
  assert.equal(expired.childTerminalObserved, false);
});

test('Stop accepts an actual terminal after its execution allowance within the original callback deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await terminal; return success(); }
    return ordinaryResult;
  });
  t.after(release);
  await f.client.callTool(ordinary());
  const owned = f.client.callTool(hook()); await started;
  t.mock.timers.tick(2600); release();
  assert.equal((await owned).isError, undefined);
  const dispatched = f.receipts.find(entry => entry.code === 'stop_native_dispatched');
  assert.equal(dispatched.executionTimeoutMs, 2500); assert.equal(dispatched.scriptBudgetMs, 2400);
  assert.ok(dispatched.receiptTimeoutMs <= 2850 && dispatched.receiptTimeoutMs > 2500);
  const confirmed = f.receipts.find(entry => entry.code === 'stop_confirmed');
  assert.equal(confirmed.childTerminalObserved, true);
  assert.ok(confirmed.nativeElapsedMs > 2500 && confirmed.callbackElapsedMs <= 2850);
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_terminal_after_retirement'), false);
});

test('callback deadline reports missing acknowledgement and passively consumes a late terminal without new authority', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let stopCalls = 0;
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const { promise: handlerReturned, resolve: returned } = Promise.withResolvers();
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) {
      if (++stopCalls === 1) { entered(); await terminal; returned(); }
      return success();
    }
    return readBrowserProgram(params.arguments?.code)?.operation === 'send' ? sendResult(params) : ordinaryResult;
  }, { graceMs: 250, cleanupMs: 150 });
  t.after(release);
  await f.client.callTool(ordinary()); const owned = f.client.callTool(hook()); await started;
  t.mock.timers.tick(175); await f.client.ping();
  assert.equal(f.cancellations.length, 0, 'The execution allowance is not the terminal receipt deadline.');
  t.mock.timers.tick(75);
  const result = await owned;
  assert.equal(result.isError, true); assert.match(result.content[0].text, /acknowledgement_timeout/u);
  await f.waitForCancellation(params => params.arguments?.code?.includes('stopOwnedWebTurn'));
  assert.equal(f.cancellations.length, 1); assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
  const missing = f.receipts.find(entry => entry.code === 'stop_unconfirmed');
  assert.equal(missing.resultCode, 'acknowledgement_timeout'); assert.equal(missing.childTerminalObserved, false);
  assert.equal(missing.nativeFailure, undefined);
  const nextObservation = ordinary(TURN2), nextSend = ordinary(TURN2, 'send');
  await f.client.callTool(nextObservation); await f.client.callTool(nextSend);
  assert.equal((await f.client.callTool(hook(TURN2))).isError, true);
  const replacement = withAuthority(nextObservation, 'replacement after local retirement');
  await f.client.callTool(replacement);
  assert.equal((await f.client.callTool(hook(TURN2))).isError, true);
  assert.ok(f.calls.some(params => params.arguments?.code === nextSend.arguments.code), 'Ordinary MCP calls still reach the child.');
  assert.equal(stopCalls, 1, 'An outstanding native cleanup blocks another adapter UI cleanup.');
  const injected = f.forwardedInner.find(message => message.params?.arguments?.code?.includes('stopOwnedWebTurn'));
  const hookReplies = f.forwardedOuter.filter(message => message.result?.content?.[0]?.text?.includes('ROUTER_WEB_STOP_ADAPTER')).length;
  release(); await handlerReturned; await f.client.ping();
  assert.equal(f.bridge.injected.size, 1, 'A cancellation notification or suppressed fixture result is not a terminal.');
  await f.serverWire.send({ jsonrpc: '2.0', id: injected.id, result: success() });
  await f.waitForReceipt('stop_terminal_after_retirement');
  const historical = f.receipts.find(entry => entry.code === 'stop_terminal_after_retirement');
  assert.equal(historical.retirementReason, 'acknowledgement_timeout'); assert.equal(historical.proofOk, true);
  assert.equal(historical.requestDigest, f.receipts.find(entry => entry.code === 'stop_native_dispatched').requestDigest);
  assert.equal(historical.requestDigest, missing.requestDigest);
  assert.match(historical.requestDigest, /^[a-f0-9]{64}$/u);
  assert.equal(historical.outcome, 'cancelled'); assert.equal(historical.stage, 'complete');
  assert.equal(historical.childTerminalObserved, true);
  assert.equal(f.bridge.injected.size, 0); assert.equal(f.bridge.cache, null);
  assert.equal(f.forwardedOuter.some(message => message.id === injected.id), false);
  assert.equal(f.forwardedOuter.filter(message => message.result?.content?.[0]?.text?.includes('ROUTER_WEB_STOP_ADAPTER')).length, hookReplies);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
  for (const secret of [APPROVED_THREAD, TURN, 'private opaque value', 'private launcher value', 'private originating policy']) {
    assert.equal(JSON.stringify(historical).includes(secret), false);
  }
  assert.equal((await f.client.callTool(hook(TURN2))).isError, true, 'A late terminal never restores cached cleanup authority.');
  const nextTurn = '01a14b65-a7a8-7b41-bd33-7c19d3c6df88';
  await f.client.callTool(ordinary(nextTurn));
  assert.equal((await f.client.callTool(hook(nextTurn))).isError, undefined);
  assert.equal(stopCalls, 2, 'Fresh authority can arm only after actual settlement.');
});

test('a terminal received after the deadline cannot gain authority from a delayed local timer', async t => {
  let clock = 1000;
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await terminal; return success(); }
    return ordinaryResult;
  }, { graceMs: 250, cleanupMs: 150, now: () => clock });
  t.after(release);
  await f.client.callTool(ordinary()); const owned = f.client.callTool(hook()); await started;
  clock = 1251; release();
  const result = await owned;
  assert.equal(result.isError, true); assert.match(result.content[0].text, /acknowledgement_timeout/u);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
  assert.equal(f.receipts.find(entry => entry.code === 'stop_terminal_after_retirement').proofOk, true);
  assert.equal(f.cancellations.length, 0, 'A received terminal does not need a cancellation notification.');
});

test('late native errors keep sanitized failure evidence without changing the completed hook result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await terminal; return success(); }
    return ordinaryResult;
  }, { graceMs: 150, cleanupMs: 125 });
  t.after(release);
  await f.client.callTool(ordinary()); const owned = f.client.callTool(hook()); await started;
  t.mock.timers.tick(150);
  assert.match((await owned).content[0].text, /acknowledgement_timeout/u);
  const injected = f.forwardedInner.find(message => message.params?.arguments?.code?.includes('stopOwnedWebTurn'));
  const replyCount = f.forwardedOuter.length;
  const privateText = 'private late failure payload';
  await f.serverWire.send({ jsonrpc: '2.0', id: injected.id,
    error: { code: -32602, message: 'js execution cancelled before execution', data: { privateText } } });
  await f.waitForReceipt('stop_terminal_after_retirement');
  const historical = f.receipts.find(entry => entry.code === 'stop_terminal_after_retirement');
  assert.equal(historical.proofOk, false); assert.equal(historical.resultCode, 'native_error');
  assert.equal(historical.nativeFailure.source, 'rpc_error'); assert.equal(historical.nativeFailure.rpcCode, -32602);
  assert.deepEqual(historical.nativeFailure.signatures, ['cancelled_before_execution']);
  assert.equal(historical.requestDigest, f.receipts.find(entry => entry.code === 'stop_native_dispatched').requestDigest);
  assert.equal(JSON.stringify(f.receipts).includes(privateText), false);
  assert.equal(f.forwardedOuter.length, replyCount);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
});

test('actual child closure releases passive cleanup ownership without interpreting a terminal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: terminal, resolve: release } = Promise.withResolvers();
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await terminal; return success(); }
    return ordinaryResult;
  }, { graceMs: 150, cleanupMs: 125 });
  t.after(release);
  await f.client.callTool(ordinary()); const owned = f.client.callTool(hook()); await started;
  t.mock.timers.tick(150);
  assert.equal((await owned).isError, true); assert.equal(f.bridge.injected.size, 1);
  await f.serverWire.close(); await f.closed;
  assert.equal(f.bridge.closed, true); assert.equal(f.bridge.injected.size, 0);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_terminal_after_retirement' || entry.code === 'stop_confirmed'), false);
});

test('native identities reject coercible non-string tokens', () => {
  for (const field of ['turn_id', 'session_id']) {
    const source = ordinary(); source._meta['x-codex-turn-metadata'][field] = [TURN];
    assert.equal(readIdentity(source._meta), null);
  }
  assert.equal(readIdentity({ ...ordinary()._meta, sessionId: [SESSION] }), null);
});

test('versioned installed configuration binds the official child hash, SDK and explicit thread scope', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'router-adapter-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = path.join(directory, 'official-fixture.exe'), receiptPath = path.join(directory, 'events.jsonl');
  const sdkPackageJson = path.join(directory, 'package.json'), filename = path.join(directory, 'config.json');
  writeFileSync(server, 'synthetic official child bytes'); writeFileSync(receiptPath, '');
  writeFileSync(sdkPackageJson, JSON.stringify({ name: '@modelcontextprotocol/sdk' }));
  const config = { version: 1, server, serverSha256: createHash('sha256').update(readFileSync(server)).digest('hex'),
    stateDir: directory, runtimeModule: fileURLToPath(new URL('../src/web-browser.mjs', import.meta.url)),
    sdkPackageJson, threadIds: null, receiptPath };
  const read = value => { writeFileSync(filename, JSON.stringify(value)); return readConfig(filename); };
  assert.deepEqual(read(config), config);
  assert.deepEqual(read({ ...config, threadIds: [APPROVED_THREAD] }).threadIds, [APPROVED_THREAD]);
  for (const value of [{ ...config, version: 2 }, { ...config, threadIds: ['not-a-uuid'] },
    { ...config, threadIds: [APPROVED_THREAD, APPROVED_THREAD] }, { ...config, threadIds: [] },
    { ...config, serverSha256: '0'.repeat(64) }, { ...config, futureField: true }]) assert.throws(() => read(value));
  writeFileSync(sdkPackageJson, JSON.stringify({ name: 'unexpected-package' }));
  assert.throws(() => read(config), /sdk_identity_refused/u);
});
