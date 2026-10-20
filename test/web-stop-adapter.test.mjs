import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { browserHelperVersion, browserScript, readBrowserProgram } from '../src/web-browser.mjs';
import { createWebStopCode } from '../src/web-stop-hook.mjs';
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
function cached(params = ordinary()) {
  const qualified = qualifyBrowserCall(params, STOP_CONFIG.runtimeModule);
  assert.ok(qualified);
  return { ...qualified, nativeMeta: clone(params._meta), aliasSessionId: params._meta.sessionId, generation: GENERATION };
}
const success = (overrides = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ systemMessage: 'ROUTER_WEB_STOP ' + JSON.stringify({
  outcome: 'cancelled', stage: 'complete', freshController: false, stopClicked: true, stopHidden: true, retained: true, elapsedMs: 25, ...overrides }) }) }] });
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

test('Stop generator replaces only three validated native literal identities', () => {
  const template = createWebStopCode(STOP_CONFIG);
  const output = stopCode(STOP_CONFIG, cached().identity);
  assert.equal(output, template.replace('${session_id}', APPROVED_THREAD).replace('${turn_id}', TURN).replace('${hook_event_name}', 'Interrupt'));
  assert.throws(() => stopCode(STOP_CONFIG, { threadId: APPROVED_THREAD, turnId: "';evil()//", sessionId: SESSION }));
});

test('bounded actual native output envelope distinguishes explicit success, no-scope, malformed and nested errors', () => {
  assert.equal(readStopResult(success()).ok, true);
  assert.equal(readStopResult(success({ outcome: 'already_idle', stopClicked: false, stopHidden: false })).ok, true);
  assert.equal(readStopResult({ ...success(), isError: true }).ok, false);
  assert.equal(readStopResult({ content: [{ type: 'text', text: JSON.stringify({ isError: true, result: success() }) }] }).ok, false);
  assert.equal(readStopResult({ content: [{ type: 'text', text: '{}' }] }).ok, false);
  assert.equal(readStopResult(success({ outcome: 'blocked', stage: 'metadata', code: 'metadata_mismatch' })).ok, false);
  assert.equal(readStopResult(success({ stopHidden: false })).ok, false);
  assert.equal(readStopResult(success({ elapsedMs: 3001 })).ok, false);
  assert.equal(readStopResult(success({ rawPayload: 'must refuse' })).ok, false);
});

test('validated blocked proof retains bounded stage and progress without acquiring success', () => {
  const proof = { outcome: 'blocked', stage: 'stop_readback_visibility', freshController: true,
    stopClicked: true, stopHidden: false, retained: false, elapsedMs: 1012, code: 'browser_operation_failed' };
  for (const stage of ['stop_click', 'stop_readback_visibility', 'handoff']) {
    assert.deepEqual(readStopResult(success({ ...proof, stage })), { ok: false, ...proof, stage });
  }
  assert.deepEqual(readStopResult(success({ ...proof, stage: 'private unknown stage' })), { ok: false, code: 'malformed_proof' });
  assert.deepEqual(readStopResult(success({ ...proof, elapsedMs: 3001 })), { ok: false, code: 'malformed_proof' });
});

async function protocolFixture(t, toolHandler, options = {}) {
  const [clientWire, outerWire] = InMemoryTransport.createLinkedPair();
  const [childWire, serverWire] = InMemoryTransport.createLinkedPair();
  const calls = [], cancellations = [], receipts = [], forwardedOuter = [], forwardedInner = [];
  const official = new Server({ name: 'official_fixture', version: 'fixture' }, {
    capabilities: { tools: {}, experimental: { 'codex/sandbox-state': {} } }, instructions: 'official fixture instructions' });
  const declarations = [{ name: 'js', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
    { name: 'turn_ended', inputSchema: { type: 'object' } }, { name: 'js_reset', inputSchema: { type: 'object' } }];
  official.setRequestHandler(ListToolsRequestSchema, () => ({ tools: declarations }));
  official.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    calls.push(request.params);
    extra.signal.addEventListener('abort', () => cancellations.push(request.params), { once: true });
    return toolHandler(request.params, extra);
  });
  await official.connect(serverWire);
  const receiveOfficial = serverWire.onmessage;
  serverWire.onmessage = (message, extra) => { forwardedInner.push(clone(message)); receiveOfficial(message, extra); };
  const bridge = new AdapterBridge({ outer: outerWire, child: childWire, stopConfig: STOP_CONFIG,
    generation: GENERATION, receipt: entry => receipts.push(entry), ...options });
  const receiveOuter = outerWire.send.bind(outerWire);
  outerWire.send = async message => { forwardedOuter.push(clone(message)); return receiveOuter(message); };
  await bridge.start();
  const client = new Client({ name: 'codex_fixture', version: 'fixture' });
  await client.connect(clientWire);
  t.after(async () => { await bridge.close(); await client.close(); await official.close(); });
  return { client, bridge, calls, cancellations, receipts, declarations, forwardedOuter, forwardedInner };
}

async function waitingFixture(t, toolHandler, options = {}) {
  const broker = createWebToolBroker({ invocationTimeoutMs: 5000 });
  const service = await startWebMcp({ broker });
  t.after(() => service.close());
  const turn = broker.register({ threadId: APPROVED_THREAD, turnId: TURN,
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] });
  const source = ordinary();
  source.arguments.code = browserScript({ ...readBrowserProgram(source.arguments.code),
    observationWait: { url: service.observationUrl(turn.token, broker.revision(turn.token)) } });
  const f = await protocolFixture(t, toolHandler, { observationIntervalMs: 5, ...options });
  return { ...f, broker, service, turn, source };
}
function observationResult(params, fields = {}) {
  const config = readBrowserProgram(params.arguments.code);
  return { content: [{ type: 'text', text: config.frameBegin + JSON.stringify({ routerBrowser: {
    operation: 'observe', normal: true, completed: false, stopVisible: true, statusComplete: false, ...fields,
  } }) + config.frameEnd }] };
}

test('one actual MCP observation spans short private child reads and returns only the completed snapshot', async t => {
  let reads = 0;
  const f = await waitingFixture(t, params => observationResult(params, { completed: ++reads === 3 }));
  f.source._meta['x-codex-turn-metadata'] = '  ' + JSON.stringify(canonical()) + '\n';
  f.source._meta.futureAuthority = { untouched: ['opaque policy'] };
  const result = await f.client.callTool(f.source);
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

test('broker activity wakes the outstanding observation before another child read is scheduled', async t => {
  let first;
  const seen = new Promise(resolve => { first = resolve; });
  const f = await waitingFixture(t, params => { first(); return observationResult(params); }, { observationIntervalMs: 1000 });
  const chatgpt = new Client({ name: 'chatgpt-tool-fixture', version: 'fixture' });
  await chatgpt.connect(new StreamableHTTPClientTransport(new URL(f.service.url)));
  t.after(() => chatgpt.close());
  const answer = f.client.callTool(f.source);
  await seen;
  const invocation = chatgpt.callTool({ name: 'codex_tool_call', arguments: {
    turn_token: f.turn.token, wire_name: 'read', arguments: { path: 'fixture' } } });
  const result = await answer;
  assert.match(result.content[0].text, /"completed":false/u);
  assert.equal(f.calls.length, 1, 'The real broker revision wakes the call during its idle browser interval.');
  const [native] = f.broker.takeCalls(f.turn.token);
  f.broker.complete(f.turn.token, [{ type: 'function_call_output', call_id: native.call_id, output: 'actual result' }]);
  assert.equal((await invocation).content[0].text, 'actual result');
  assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'broker_activity');
});

test('the safety deadline returns the latest incomplete snapshot without repeating Send or inventing completion', async t => {
  const f = await waitingFixture(t, params => observationResult(params), { observationWaitMs: 30 });
  const result = await f.client.callTool(f.source);
  assert.match(result.content[0].text, /"completed":false/u);
  assert.ok(f.calls.length >= 1);
  assert.ok(f.calls.every(params => readBrowserProgram(params.arguments.code).operation === 'observe'));
  const receipt = f.receipts.find(entry => entry.code === 'observation_wait_finished');
  assert.equal(receipt.wakeReason, 'deadline');
  assert.ok(receipt.elapsedMs < 1000);
});

test('a read begun just before renewal can finish across that boundary without resetting its kernel', async t => {
  for (const childFails of [false, true]) await t.test(childFails ? 'actual child error still propagates' : 'incomplete read renews successfully', async subtest => {
    let clock = 1000, reads = 0, kernelResets = 0;
    const nativeError = { isError: true, content: [{ type: 'text', text: 'js execution timed out; kernel reset, rerun your request' }] };
    const f = await waitingFixture(subtest, async params => {
      reads += 1;
      if (reads === 1) { clock = 1995; return observationResult(params); }
      if (reads > 2) return observationResult(params, { completed: true });
      // Place actual timed work five milliseconds before the renewal boundary.
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
    const result = await f.client.callTool(f.source);
    if (childFails) {
      assert.deepEqual(result, nativeError);
      assert.equal(reads, 2);
      await delay(0);
      assert.ok(f.receipts.some(entry => entry.code === 'ordinary_js_failed'));
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
  let clock = 1000, reads = 0, entered, release;
  const activeRead = new Promise(resolve => { entered = resolve; });
  const terminal = new Promise(resolve => { release = resolve; });
  const f = await waitingFixture(t, async params => {
    if (params.arguments.code.includes('stopOwnedWebTurn')) return success();
    reads += 1;
    if (reads === 1) { clock = 1995; return observationResult(params); }
    clock = 2015; entered(); await terminal;
    return observationResult(params);
  }, { now: () => clock, observationWaitMs: 1000, observationIntervalMs: 1 });
  const control = new AbortController();
  const answer = f.client.callTool(f.source, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await activeRead; control.abort();
  const stopped = f.client.callTool(hook());
  await delay(0);
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
  let entered, release;
  const activeRead = new Promise(resolve => { entered = resolve; });
  const terminal = new Promise(resolve => { release = resolve; });
  const nativeError = { isError: true, content: [{ type: 'text', text: 'actual native execution failure' }] };
  const f = await waitingFixture(t, async () => { entered(); await terminal; return nativeError; });
  const answer = f.client.callTool(f.source); await activeRead;
  const pending = [...f.bridge.pending.values()][0];
  const woken = new Promise(resolve => pending.wait.abort.signal.addEventListener('abort', resolve, { once: true }));
  f.broker.cancel(f.turn.token); await woken;
  release();
  assert.deepEqual(await answer, nativeError, 'A broker wake cannot replace an actual child terminal error.');
  assert.equal(f.calls.length, 1);
});

test('actual child errors and malformed browser output end the held call without another browser read', async t => {
  for (const result of [{ isError: true, content: [{ type: 'text', text: 'actual child failure' }] }, ordinaryResult]) {
    await t.test(result.isError ? 'child failure' : 'malformed output', async subtest => {
      const f = await waitingFixture(subtest, () => result);
      assert.deepEqual(await f.client.callTool(f.source), result);
      await delay(15); assert.equal(f.calls.length, 1);
      assert.equal(f.receipts.find(entry => entry.code === 'observation_wait_finished').wakeReason, 'browser_error');
    });
  }
});

test('a failed protected broker channel ends the native request with an explicit error', async t => {
  const f = await waitingFixture(t, params => observationResult(params), { observationIntervalMs: 1000 });
  const config = readBrowserProgram(f.source.arguments.code);
  const url = new URL(config.observationWait.url); url.pathname = url.pathname.replace(/^\/[^/]+/u, '/' + 'b'.repeat(64));
  f.source.arguments.code = browserScript({ ...config, observationWait: { url: url.href } });
  await assert.rejects(f.client.callTool(f.source), /Router browser observation channel is unavailable/u);
  assert.equal(f.calls.length, 1);
});

test('Stop freezes repeated observation between reads and during a real active child invocation', async t => {
  for (const activeChild of [false, true]) await t.test(activeChild ? 'active child' : 'idle interval', async subtest => {
    let first, release;
    const seen = new Promise(resolve => { first = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = await waitingFixture(subtest, async params => {
      if (params.arguments.code.includes('stopOwnedWebTurn')) return success();
      first(); if (activeChild) await gate;
      return observationResult(params);
    }, { observationIntervalMs: 1000 });
    const control = new AbortController();
    const answer = f.client.callTool(f.source, undefined, { signal: control.signal }).catch(() => 'cancelled');
    await seen; if (!activeChild) await delay(0);
    control.abort();
    const stop = f.client.callTool(hook());
    await delay(0);
    if (activeChild) assert.equal(f.calls.length, 1, 'Stop cannot enter Node REPL before its real child terminal.');
    release();
    assert.equal((await stop).isError, undefined);
    assert.equal(await answer, 'cancelled');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1]._meta, retainedMetadata(f.source._meta));
    assert.ok(f.receipts.some(entry => entry.code === 'stop_confirmed'));
    await delay(15); assert.equal(f.calls.length, 2);
  });
});

test('changed authority retires an idle wait and cannot authorize Stop or later repeated reads', async t => {
  let first;
  const seen = new Promise(resolve => { first = resolve; });
  const f = await waitingFixture(t, params => {
    if (!readBrowserProgram(params.arguments.code)) return ordinaryResult;
    first(); return observationResult(params);
  }, { observationIntervalMs: 1000 });
  const answer = f.client.callTool(f.source); await seen; await delay(0);
  const other = withAuthority(ordinary(), 'changed policy'); other.arguments.code = 'ordinary JS';
  await f.client.callTool(other); await answer;
  assert.equal((await f.client.callTool(hook())).isError, true);
  await delay(15); assert.equal(f.calls.length, 2);
  assert.ok(f.receipts.some(entry => entry.code === 'authority_replaced'));
});

test('an unsettled private observation forwards cancellation to its actual child ID once grace expires', async t => {
  let first;
  const seen = new Promise(resolve => { first = resolve; });
  const f = await waitingFixture(t, async (params, extra) => {
    first();
    await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
    return observationResult(params);
  }, { graceMs: 25 });
  const control = new AbortController();
  const answer = f.client.callTool(f.source, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await seen; control.abort();
  assert.equal(await answer, 'cancelled');
  await delay(60);
  assert.equal(f.cancellations.length, 1);
  const childCall = f.forwardedInner.find(message => message.method === 'tools/call');
  const cancelled = f.forwardedInner.filter(message => message.method === 'notifications/cancelled');
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0].params.requestId, childCall.id);
  assert.equal((await f.client.callTool(hook())).isError, true);
  assert.equal(f.calls.length, 1);
});

test('a closed broker turn and lost browser ownership wake immediately without a successful final answer', async t => {
  for (const kind of ['closed broker', 'lost browser ownership']) await t.test(kind, async subtest => {
    let first;
    const seen = new Promise(resolve => { first = resolve; });
    const f = await waitingFixture(subtest, params => {
      first(); return observationResult(params, kind === 'lost browser ownership' ? { replyUnavailableReason: 'generation-turn-not-latest' } : {});
    }, { observationIntervalMs: 1000 });
    const answer = f.client.callTool(f.source);
    await seen;
    if (kind === 'closed broker') {
      f.broker.cancel(f.turn.token);
      await assert.rejects(answer, /Router browser observation channel is unavailable/u);
    } else assert.match((await answer).content[0].text, /generation-turn-not-latest/u);
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
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await gate; return success(); }
      return ordinaryResult;
    });
    await f.client.callTool(ordinary());
    let original, owned;
    if (builtinFirst) { original = f.client.callTool(builtin()); await delay(0); owned = f.client.callTool(hook()); }
    else { owned = f.client.callTool(hook()); await started; original = f.client.callTool(builtin()); }
    await started; await delay(0);
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
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await gate; return success(); }
      return ordinaryResult;
    });
    await f.client.callTool(ordinary());
    const control = new AbortController(); let original, owned;
    const callBuiltin = () => f.client.callTool(builtin(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    if (builtinFirst) { original = callBuiltin(); await delay(0); control.abort(); await delay(0); owned = f.client.callTool(hook()); }
    else { owned = f.client.callTool(hook()); await started; original = callBuiltin(); await delay(0); control.abort(); }
    await started; await delay(0);
    assert.equal(f.cancellations.length, 0);
    release(); assert.equal((await owned).isError, undefined); assert.equal(await original, 'cancelled'); await delay(0);
    const wire = f.forwardedInner.find(message => message.params?.name === 'turn_ended');
    assert.ok(wire);
    assert.ok(f.forwardedInner.some(message => message.method === 'notifications/cancelled' && message.params.requestId === wire.id));
    assert.equal(f.cancellations.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
    assert.equal(f.receipts.some(entry => entry.code === 'cleanup_owner_cancel_received'), false);
    assert.equal(f.receipts.filter(entry => entry.code === 'stop_confirmed').length, 1);
  });
});

test('builtin without owned callback expires its short wait and cannot authorize a late Stop', async t => {
  const f = await protocolFixture(t, () => ordinaryResult, { builtinWaitMs: 10 });
  await f.client.callTool(ordinary()); await f.client.callTool(builtin());
  assert.deepEqual(f.calls, [ordinary(), builtin()]);
  assert.equal((await f.client.callTool(hook())).isError, true);
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
});

test('transport backpressure cannot forward a builtin cancellation before its original request', async t => {
  for (const blockedTransport of ['owned_reply', 'builtin_request']) await t.test(blockedTransport, async subtest => {
    let stopEntered, releaseStop, transportEntered, releaseTransport;
    const started = new Promise(resolve => { stopEntered = resolve; });
    const stopGate = new Promise(resolve => { releaseStop = resolve; });
    const transportBlocked = new Promise(resolve => { transportEntered = resolve; });
    const transportGate = new Promise(resolve => { releaseTransport = resolve; });
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
    await delay(0); releaseStop(); await transportBlocked;
    control.abort(); await delay(0);
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
    assert.equal(await original, 'cancelled'); await delay(0);
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
  let entered, clock = 1000;
  const started = new Promise(resolve => { entered = resolve; });
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
  await delay(0); builtinControl.abort(); await delay(0); clock = 2012; ownerControl.abort();
  assert.equal(await owned, 'cancelled'); assert.equal(await original, 'cancelled'); await delay(10);
  assert.equal(f.cancellations.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn')).length, 1);
  assert.equal(f.calls.some(params => params.name === INTERRUPT_TOOL), false);
  assert.deepEqual(f.calls.at(-1), builtin());
  assert.deepEqual(f.receipts.find(entry => entry.code === 'cleanup_owner_cancel_received'), {
    at: new Date(clock).toISOString(), code: 'cleanup_owner_cancel_received', generation: GENERATION, elapsedMs: 1012 });
  assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
});

test('duplicate owned and builtin callbacks share one attempt without replacing originals', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await protocolFixture(t, async params => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) { entered(); await gate; return success(); }
    return ordinaryResult;
  });
  await f.client.callTool(ordinary()); const first = f.client.callTool(hook()); await started;
  const duplicate = f.client.callTool(hook()), one = f.client.callTool(builtin()), two = f.client.callTool(builtin());
  await delay(0); release(); const results = await Promise.all([first, duplicate, one, two]);
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
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await protocolFixture(t, async (params, extra) => {
    entered(); await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true })); return ordinaryResult;
  });
  const control = new AbortController();
  const pending = f.client.callTool({ name: 'js', arguments: { code: 'unqualified' } }, undefined, { signal: control.signal }).catch(() => 'cancelled');
  await started; control.abort(); await delay(0);
  assert.equal(await pending, 'cancelled'); assert.equal(f.cancellations.length, 1); assert.equal(f.calls.length, 1);
});

test('observation cancellation can settle before owned cleanup; no callback expires the original cancellation once', async t => {
  for (const useOwned of [true, false]) await t.test(useOwned ? 'owned cleanup' : 'no callback', async subtest => {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const f = await protocolFixture(subtest, async (params, extra) => {
      if (params.arguments?.code === ordinary().arguments.code) {
        entered(); if (useOwned) await gate;
        else await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
      }
      return params.arguments?.code?.includes('stopOwnedWebTurn') ? success() : ordinaryResult;
    }, useOwned ? {} : { graceMs: 40, cleanupMs: 10 });
    const control = new AbortController();
    const pending = f.client.callTool(ordinary(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    await started; control.abort(); await delay(0); assert.equal(f.cancellations.length, 0);
    if (useOwned) { const owned = f.client.callTool(hook()); release(); await owned; assert.ok(f.receipts.some(entry => entry.code === 'stop_confirmed')); }
    else { await delay(60); assert.equal(f.cancellations.length, 1); assert.ok(f.receipts.some(entry => entry.code === 'cancel_grace_expired')); }
    await pending;
  });
});

test('a terminal observation error releases owned cleanup without changing the original error or overlapping JS', async t => {
  for (const rpcError of [false, true]) await t.test(rpcError ? 'RPC error' : 'tool error', async subtest => {
    let entered, release, running = true;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
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
    await delay(0);
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
  let entered, release, cleanupEntered, running = true;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const cleanupStarted = new Promise(resolve => { cleanupEntered = resolve; });
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1, 'The outer cancellation and 500 elapsed ms do not end the child invocation.');
  assert.equal(f.receipts.some(entry => entry.code === 'interrupted_observation_terminal'), false);
  release();
  assert.equal((await owned).isError, undefined); await original;
  const injected = f.calls.filter(params => params.arguments?.code?.includes('stopOwnedWebTurn'));
  assert.equal(injected.length, 1);
  assert.equal(injected[0].arguments.timeout_ms, 2150);
  assert.match(injected[0].arguments.code, /deadline = started \+ 2050;/u);
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
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const source = ordinary(), errorResult = { isError: true, content: [{ type: 'text', text: 'Synthetic interrupted observation' }] };
    const f = await protocolFixture(subtest, async params => {
      if (params.arguments?.code === source.arguments.code) { entered(); await gate; return errorResult; }
      return ordinaryResult;
    });
    const observation = f.client.callTool(source); await started;
    const control = new AbortController();
    const owned = f.client.callTool(hook(), undefined, { signal: control.signal }).catch(() => 'cancelled');
    await delay(0);
    if (replaceAuthority) {
      const generic = withAuthority(source, 'replacement'); generic.arguments = { code: 'void 0' };
      await f.client.callTool(generic);
      assert.ok(f.receipts.some(entry => entry.code === 'authority_replaced'));
    } else {
      control.abort(); await delay(0);
      assert.ok(f.receipts.some(entry => entry.code === 'cleanup_owner_cancel_received'));
    }
    release(); assert.deepEqual(await observation, errorResult);
    const result = await owned;
    assert.equal(replaceAuthority ? result.isError : result, replaceAuthority ? true : 'cancelled');
    assert.equal(f.calls.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
    assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
  });
});

test('owner cancellation releases the child-terminal wait before the child returns and preserves its late actual result', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
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
  await delay(0); control.abort();
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
      stopClicked: true, stopHidden: true, retained: false, elapsedMs: 1012, code: 'browser_operation_failed' };
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

test('overlapping ordinary JS cancels injected cleanup and prevents late success', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
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

test('forwarding a waiting builtin after generic JS prevents later reacquisition of its old authority', async t => {
  const f = await protocolFixture(t, () => ordinaryResult);
  await f.client.callTool(ordinary()); const original = f.client.callTool(builtin()); await delay(0);
  await f.client.callTool({ name: 'js', arguments: { code: 'ordinary invalidation' } }); await original;
  await f.client.callTool(ordinary()); assert.equal((await f.client.callTool(hook())).isError, true);
  assert.equal(f.calls.some(params => params.arguments?.code?.includes('stopOwnedWebTurn')), false);
});

test('unsettled observation refuses cleanup and releases the original native cancellation', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await protocolFixture(t, async (params, extra) => {
    if (params.arguments?.code === ordinary().arguments.code) {
      entered(); await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
    }
    return ordinaryResult;
  }, { graceMs: 40 });
  const control = new AbortController();
  const pending = f.client.callTool(ordinary(), undefined, { signal: control.signal }).catch(() => 'cancelled');
  await started; control.abort(); await delay(0);
  assert.equal((await f.client.callTool(hook())).isError, true); await pending; await delay(0);
  assert.equal(f.cancellations.length, 1); assert.equal(f.calls.length, 1);
  assert.ok(f.receipts.some(entry => entry.code === 'observe_not_settled' || entry.code === 'cancel_grace_expired'));
  assert.equal(f.receipts.some(entry => entry.code === 'interrupted_observation_terminal'), false);
  const sourceWire = f.forwardedInner.find(message => message.params?.arguments?.code === ordinary().arguments.code);
  assert.equal(f.forwardedInner.filter(message => message.method === 'notifications/cancelled' && message.params.requestId === sourceWire.id).length, 1);
  const expired = f.receipts.find(entry => ['cancel_grace_expired', 'observation_terminal_unavailable'].includes(entry.code));
  assert.equal(expired.childTerminalObserved, false);
});

test('cleanup deadline cancels the injected request once and cannot accept a late success', async t => {
  const f = await protocolFixture(t, async (params, extra) => {
    if (params.arguments?.code?.includes('stopOwnedWebTurn')) {
      await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true })); return success();
    }
    return ordinaryResult;
  }, { graceMs: 250, cleanupMs: 150 });
  await f.client.callTool(ordinary()); assert.equal((await f.client.callTool(hook())).isError, true); await delay(0);
  assert.equal(f.cancellations.length, 1); assert.equal(f.receipts.some(entry => entry.code === 'stop_confirmed'), false);
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
