// Explicit Router MCP adapter around an unchanged official Node REPL child.
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readBrowserProgram } from './web-browser.mjs';
import { createWebStopCode } from './web-stop-hook.mjs';
import { INTERRUPT_TOOL, validAdapterThreadIds, validateAdapterConfig, STOP_STAGES, STOP_CODES } from './web-stop-contract.mjs';

export { INTERRUPT_TOOL } from './web-stop-contract.mjs';
export const ADAPTER_INFO = Object.freeze({ name: 'codex_router_web_stop_adapter', version: '1.0.0' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const uuid = value => typeof value === 'string' && UUID.test(value);
const SANDBOX_KEYS = ['codex/sandbox-state', 'codex/sandbox-state-meta', 'codex/sandbox-launcher'];
const CORRELATION_KEYS = new Set(['callId', 'itemId', 'progressToken']);
const TRACE_KEYS = new Set(['traceparent', 'tracestate']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = value => { if (record(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const snapshot = value => freeze(structuredClone(value));
const validThreadIds = validAdapterThreadIds;
const threadAllowed = (threadId, threadIds) => uuid(threadId) && (threadIds === null || threadIds.includes(threadId));
const turnKey = (threadId, turnId) => `${threadId}:${turnId}`;

// Do not reconstruct a sandbox object or infer a launcher. Preserve every field.
export function readIdentity(meta, threadIds = null) {
  try {
    if (!validThreadIds(threadIds) || !record(meta) || !threadAllowed(meta.threadId, threadIds)) return null;
    const raw = meta['x-codex-turn-metadata'];
    if (typeof raw === 'string' && raw.length > 262144) return null;
    const canonical = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!record(canonical) || canonical.thread_id !== meta.threadId
        || !uuid(canonical.turn_id) || !uuid(canonical.session_id)) return null;
    if (['parent_thread_id', 'subagent_header', 'subagent_kind'].some(key => canonical[key] != null)) return null;
    for (const field of ['auto_review_enabled', 'node_repl_auto_review_required', 'node_repl_disabled']) {
      if (typeof canonical[field] !== 'boolean') return null;
    }
    for (const [alias, expected] of [['thread_id', canonical.thread_id], ['turnId', canonical.turn_id],
      ['turn_id', canonical.turn_id], ['session_id', canonical.session_id]]) {
      if (own(meta, alias) && meta[alias] !== expected) return null;
    }
    if (own(meta, 'sessionId') && !uuid(meta.sessionId)) return null;
    return { threadId: canonical.thread_id, turnId: canonical.turn_id, sessionId: canonical.session_id, canonical };
  } catch { return null; }
}

export function readSandbox(meta) {
  if (!record(meta) || !SANDBOX_KEYS.every(key => record(meta[key]))
      || !isDeepStrictEqual(meta[SANDBOX_KEYS[0]], meta[SANDBOX_KEYS[1]])) return null;
  return Object.fromEntries(SANDBOX_KEYS.map(key => [key, meta[key]]));
}

// Exact regeneration is required: a marker or a lookalike script is insufficient.
export function qualifyBrowserCall(params, runtimeModule, threadIds = null) {
  try {
    if (params?.name !== 'js' || typeof params.arguments?.code !== 'string'
        || params.arguments.code.length > 1048576 || !/^call_router_web_[a-f0-9]{32}$/u.test(params._meta?.callId ?? '')) return null;
    const identity = readIdentity(params._meta, threadIds), sandbox = readSandbox(params._meta);
    if (!identity || !sandbox || !own(params._meta, 'sessionId')) return null;
    const config = readBrowserProgram(params.arguments.code);
    if (!config || config.sessionId !== identity.threadId || config.turnId !== identity.turnId
        || config.runtimeModule !== runtimeModule
        || config.ui.stopButtonExactName !== 'Stop') return null;
    return { identity, sandbox, config, observation: config.operation === 'observe' };
  } catch { return null; }
}

// Authority belongs to the originating ordinary operation. Retain the raw
// canonical value, every opaque/unknown field, and original aliases unchanged.
// These three per-RPC correlation fields cannot identify a new injected call.
export function retainedMetadata(meta) {
  return snapshot(Object.fromEntries(Object.entries(meta).filter(([key]) => !CORRELATION_KEYS.has(key))));
}
const authorityView = meta => Object.fromEntries(Object.entries(meta).filter(([key]) => !CORRELATION_KEYS.has(key) && !TRACE_KEYS.has(key)));

export function cleanupDecision(hook, cached, generation) {
  const reject = reason => ({ reason, meta: null });
  if (!cached) return reject('origin_missing');
  if (generation !== cached.generation) return reject('child_generation_mismatch');
  if (![INTERRUPT_TOOL, 'turn_ended'].includes(hook?.name) || !record(hook._meta)
      || hook._meta.threadId !== cached.identity.threadId) return reject('hook_thread_mismatch');
  // Native ordinary MCP calls always carry callId. They must not be interpreted
  // as a bundled lifecycle callback, even if their arguments resemble one.
  if (own(hook._meta, 'callId')) return reject('ordinary_call');
  if (hook.arguments?.hook_event_name !== 'Interrupt') return reject('hook_event_mismatch');
  if (hook.arguments.session_id !== cached.aliasSessionId) return reject('hook_session_mismatch');
  if (hook.arguments.turn_id !== cached.identity.turnId) return reject('hook_turn_mismatch');
  for (const [key, value] of Object.entries(hook._meta)) {
    if (CORRELATION_KEYS.has(key) || TRACE_KEYS.has(key)) continue;
    if (!own(cached.nativeMeta, key) || !isDeepStrictEqual(value, cached.nativeMeta[key])) return reject('hook_authority_conflict');
  }
  return { reason: 'retained_originating_authority', meta: retainedMetadata(cached.nativeMeta) };
}

export function stopCode(stopConfig, identity, budgetMs = 2400) {
  if (!threadAllowed(identity?.threadId, stopConfig.threadIds ?? null)
      || !uuid(identity.turnId) || !uuid(identity.sessionId)) throw new Error('identity_refused');
  const template = createWebStopCode(stopConfig, { budgetMs });
  let code = template;
  for (const [placeholder, value] of [['${session_id}', identity.threadId], ['${turn_id}', identity.turnId], ['${hook_event_name}', 'Interrupt']]) {
    if (code.split(placeholder).length !== 2) throw new Error('template_refused');
    code = code.replace(placeholder, value);
  }
  return code;
}

// Parse the actual native text envelope, including {systemMessage: ...}. No raw
// output/error ever reaches receipts. Success must contain explicit readback.
export function readStopResult(result) {
  const fail = code => ({ ok: false, code });
  if (!record(result) || result.isError === true || !Array.isArray(result.content) || result.content.length > 16) return fail('native_error');
  let proof;
  const visit = (value, depth = 0) => {
    if (depth > 4 || !record(value) || value.isError === true) return false;
    if (typeof value.systemMessage === 'string' && value.systemMessage.startsWith('ROUTER_WEB_STOP ')) {
      if (proof) return false;
      try { proof = JSON.parse(value.systemMessage.slice(16)); } catch { return false; }
    }
    for (const key of ['result', 'structuredContent']) if (own(value, key) && !visit(value[key], depth + 1)) return false;
    if (Array.isArray(value.content)) {
      if (value.content.length > 16) return false;
      for (const block of value.content) {
        if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 16384) return false;
        let parsed;
        try { parsed = JSON.parse(block.text); } catch { return false; }
        if (!visit(parsed, depth + 1)) return false;
      }
    }
    return true;
  };
  if (!visit(result)) return fail('malformed_result');
  if (!record(proof)) return fail('no_stop_proof');
  const allowed = ['outcome', 'stage', 'freshController', 'stopClicked', 'stopHidden', 'retained', 'code', 'elapsedMs'];
  if (Object.keys(proof).some(key => !allowed.includes(key)) || !['cancelled', 'already_idle', 'blocked'].includes(proof.outcome)
      || !STOP_STAGES.includes(proof.stage) || ['freshController', 'stopClicked', 'stopHidden', 'retained'].some(key => typeof proof[key] !== 'boolean')
      || !Number.isInteger(proof.elapsedMs) || proof.elapsedMs < 0 || proof.elapsedMs > 3000
      || proof.code !== undefined && !STOP_CODES.includes(proof.code)) return fail('malformed_proof');
  if (proof.outcome === 'blocked') return { ok: false, ...proof, code: proof.code ?? 'blocked' };
  if (proof.stage !== 'complete' || proof.retained !== true || own(proof, 'code')
      || proof.outcome === 'cancelled' && (!proof.stopClicked || !proof.stopHidden)
      || proof.outcome === 'already_idle' && (proof.stopClicked || proof.stopHidden)) return fail('incomplete_proof');
  return { ok: true, ...proof };
}

// SDK transports are deliberately bridged below their Client/Server handlers:
// every unknown method/result/notification retains its actual wire payload.
// MCP offers no signed per-call hook provenance. Trust is in the explicit
// adapter registration and host-owned canonical metadata, not the tool name.
export class AdapterBridge {
  constructor({ outer, child, stopConfig, generation = randomUUID(), receipt = () => {}, now = Date.now,
    graceMs = 2850, cleanupMs = 2500, builtinWaitMs = 150 }) {
    if (!uuid(generation) || graceMs < 1 || graceMs > 2850
        || cleanupMs < 1 || cleanupMs > 2500 || builtinWaitMs < 1 || builtinWaitMs > 300
        || !validThreadIds(stopConfig.threadIds ?? null)) throw new Error('bounds_refused');
    Object.assign(this, { outer, child, stopConfig: snapshot(stopConfig), generation, receipt, now, graceMs, cleanupMs, builtinWaitMs });
    this.cache = null; this.epoch = 0; this.pending = new Map(); this.injected = new Map(); this.hooks = new Map();
    this.initializeIds = new Set(); this.closed = false; this.authorityDisabled = false; this.graceDeadline = undefined;
    this.currentThread = undefined; this.currentTurn = undefined; this.retiredTurns = new Set(); this.turnSandbox = undefined; this.currentAuthority = undefined;
    this.cleanupGroup = null; this.builtinWait = null;
  }
  event(code, flags = {}) {
    try { this.receipt({ at: new Date(this.now()).toISOString(), code, generation: this.generation, ...flags }); }
    catch {
      if (!this.receiptFailed) { this.receiptFailed = true; void this.close().catch(() => {}); }
    }
  }
  sendDetached(message) { void this.child.send(message).catch(() => this.fail()).catch(() => {}); }
  retirePending(id, terminalResponse) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id); pending.settle(terminalResponse);
  }
  async start() {
    this.outer.onmessage = message => { void this.fromOuter(message).catch(() => this.fail()).catch(() => {}); };
    this.child.onmessage = message => { void this.fromChild(message).catch(() => this.fail()).catch(() => {}); };
    this.outer.onerror = this.child.onerror = () => this.event('transport_error');
    this.outer.onclose = this.child.onclose = () => { void this.close().catch(() => {}); };
    await this.child.start(); await this.outer.start();
  }
  invalidate(code, flags = {}) {
    this.epoch += 1; this.cache = null; this.graceDeadline = undefined;
    this.cleanupGroup?.abort();
    for (const [id, pending] of this.pending) {
      if (pending.deferred) { pending.deferred = false; this.retirePending(id, false); this.sendDetached(pending.cancel); }
    }
    for (const injected of this.injected.values()) injected.cancel();
    if (this.builtinWait) void this.releaseBuiltinWait(this.builtinWait, code).catch(() => this.fail());
    this.event(code, flags);
  }
  async fromOuter(message) {
    if (this.closed) return;
    if (this.injected.has(message.id)) { this.invalidate('request_id_collision'); return this.outer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Adapter request refused' } }); }
    if (message.method === 'initialize') this.initializeIds.add(message.id);
    if (message.method === 'notifications/cancelled') {
      const pending = this.pending.get(message.params?.requestId);
      const observationAuthority = this.cleanupGroup
        ? !this.cleanupGroup.aborted && this.cleanupGroup.epoch === this.epoch ? this.cleanupGroup.authority : null
        : this.cache;
      if (pending?.qualified && observationAuthority === pending.cache && this.pending.size === 1) {
        if (!pending.cancel) {
          pending.cancel = message; pending.deferred = true; pending.cancelAt = this.now(); this.graceDeadline = pending.cancelAt + this.graceMs;
          pending.interruptedAt ??= pending.cancelAt;
          pending.timer = setTimeout(() => {
            if (!pending.deferred) return;
            pending.deferred = false; this.retirePending(message.params.requestId, false);
            this.invalidate('cancel_grace_expired', { childTerminalObserved: false, elapsedMs: Math.max(0, this.now() - pending.cancelAt) }); this.sendDetached(message);
          }, this.graceMs);
          this.event('observation_cancel_deferred');
        }
        return;
      }
      const hook = this.hooks.get(message.params?.requestId);
      if (hook && !hook.forwarded) {
        hook.cancel = message;
        const elapsedMs = Math.min(this.graceMs, Math.max(0, this.now() - hook.group.startedAt));
        if (hook.owner) {
          this.event('cleanup_owner_cancel_received', { elapsedMs });
          hook.group.abort();
        } else this.event(hook.message.params.name === 'turn_ended' ? 'builtin_cancel_queued' : 'cleanup_duplicate_cancel_queued', { elapsedMs });
        return;
      }
      if (pending) { this.retirePending(message.params.requestId, false); this.invalidate('ordinary_cancelled'); }
      return this.child.send(message);
    }
    if (message.method !== 'tools/call') return this.child.send(message);
    const params = message.params;
    if (params?.name === 'turn_ended' || params?.name === INTERRUPT_TOOL) return this.handleHook(message);
    if (params?.name !== 'js' && params?.name !== 'js_reset') return this.child.send(message);
    // Policy observation is independent of Router script qualification. A
    // genuine ordinary call may expose a changed current-turn authority even
    // when its code is generic; it may invalidate, never acquire, authority.
    const actualIdentity = readIdentity(params._meta, this.stopConfig.threadIds ?? null);
    if (actualIdentity?.threadId === this.currentThread && actualIdentity?.turnId === this.currentTurn && this.currentAuthority
        && own(params._meta, 'sessionId') && readSandbox(params._meta)
        && !isDeepStrictEqual(authorityView(this.currentAuthority.meta), authorityView(params._meta))) {
      this.authorityDisabled = true; this.invalidate('authority_replaced');
    }
    const guard = qualifyBrowserCall(params, this.stopConfig.runtimeModule, this.stopConfig.threadIds ?? null);
    const overlapping = this.pending.size > 0 || [...this.hooks.values()].some(entry => !entry.group.retired) || this.injected.size > 0;
    if (overlapping || !guard?.observation) this.invalidate('scope_invalidated');
    if (guard && this.retiredTurns.has(turnKey(guard.identity.threadId, guard.identity.turnId))) this.invalidate('retired_turn_refused');
    else if (guard) {
      if (this.currentThread !== guard.identity.threadId || this.currentTurn !== guard.identity.turnId) {
        if (this.currentTurn !== undefined) this.retiredTurns.add(turnKey(this.currentThread, this.currentTurn));
        this.invalidate('new_turn');
        // Native turns may supply different opaque authority in one official
        // child. Acquire this turn's actual snapshot afresh; never carry the
        // previous turn's policy or its mismatch-disable decision forward.
        this.authorityDisabled = false;
        this.currentThread = guard.identity.threadId;
        this.currentTurn = guard.identity.turnId;
        this.currentAuthority = snapshot({ meta: retainedMetadata(params._meta), aliasSessionId: params._meta.sessionId });
        this.turnSandbox = snapshot(guard.sandbox);
      }
      if (!isDeepStrictEqual(this.turnSandbox, guard.sandbox)
          || !isDeepStrictEqual(authorityView(this.currentAuthority.meta), authorityView(params._meta))) {
        this.authorityDisabled = true; this.invalidate('authority_replaced');
      }
      if (guard.observation && !overlapping && !this.authorityDisabled && this.pending.size === 0) {
        this.cache = snapshot({ identity: guard.identity, sandbox: guard.sandbox,
          nativeMeta: params._meta, aliasSessionId: params._meta.sessionId, generation: this.generation });
        this.event('authority_cached', { threadId: guard.identity.threadId, turnId: guard.identity.turnId,
          authorityDigest: digest(guard.sandbox), canonicalDigest: digest(guard.identity.canonical) });
      }
    }
    let settle;
    const pending = { qualified: Boolean(guard?.observation && this.cache && this.pending.size === 0), cache: this.cache,
      settled: new Promise(resolvePromise => { settle = resolvePromise; }), settle };
    // Assignment after creation keeps the resolver distinct from Promise.resolve.
    pending.settle = settle;
    this.pending.set(message.id, pending);
    return this.child.send(message);
  }
  async fromChild(message) {
    if (this.closed) return;
    const internal = this.injected.get(message.id);
    if (internal && !message.method) { this.injected.delete(message.id); internal.finish(message); return; }
    const pending = this.pending.get(message.id);
    if (pending && !message.method) {
      const group = this.cleanupGroup;
      if (pending.interruptedAt !== undefined) this.event('interrupted_observation_terminal', {
        elapsedMs: Math.max(0, this.now() - pending.interruptedAt),
        ...(pending.cleanupStartedAt !== undefined ? { callbackElapsedMs: Math.max(0, this.now() - pending.cleanupStartedAt) } : {}),
        childTerminalObserved: true, rpcError: own(message, 'error'), toolError: message.result?.isError === true,
        resultSucceeded: own(message, 'result') && message.result?.isError !== true,
        cleanupActive: group?.pending === pending && !group.retired && !group.aborted,
      });
      const ownedObservation = pending.qualified && group?.pending === pending && group.authority === pending.cache
        && !group.aborted && group.epoch === this.epoch
        && this.currentThread === group.authority.identity.threadId && this.currentTurn === group.authority.identity.turnId;
      // A real terminal error also ends the ordinary invocation. Only its
      // already accepted cleanup may retain authority; local cancellation or
      // timeout retirement never proves execution ended. Forward the error intact.
      this.retirePending(message.id, true);
      if ((message.error || message.result?.isError === true) && !ownedObservation) this.invalidate('ordinary_js_failed');
    }
    if (this.initializeIds.has(message.id) && !message.method) {
      this.initializeIds.delete(message.id);
      if (record(message.result)) message = { ...message, result: { ...message.result, serverInfo: { ...ADAPTER_INFO } } };
    }
    return this.outer.send(message);
  }
  async waitFor(promise, ms) {
    let timer;
    try { return await Promise.race([promise, new Promise(resolvePromise => { timer = setTimeout(() => resolvePromise(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async inject(params, ms) {
    const id = `router_stop_${randomUUID()}`;
    let finish, timer, complete = false;
    const result = new Promise(resolvePromise => { finish = value => { if (complete) return; complete = true; clearTimeout(timer); resolvePromise(value); }; });
    const cancel = () => { if (complete) return; this.sendDetached({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }); finish(null); };
    this.injected.set(id, { finish, cancel });
    timer = setTimeout(cancel, ms);
    try { await this.child.send({ jsonrpc: '2.0', id, method: 'tools/call', params }); return await result; }
    finally { clearTimeout(timer); this.injected.delete(id); }
  }
  async handleHook(message) {
    const params = message.params, hookMeta = record(params?._meta) ? params._meta : {};
    const owned = params?.name === INTERRUPT_TOOL;
    // An ordinary model tool call cannot acquire lifecycle authority, including
    // an ordinary call using the adapter's private callback name.
    if (own(hookMeta, 'callId')) {
      if (hookMeta.threadId === this.currentThread && params?.arguments?.turn_id === this.currentTurn) {
        this.authorityDisabled = true; this.invalidate('ordinary_lifecycle_call');
      }
      return this.child.send(message);
    }
    if (this.currentTurn !== undefined && this.currentAuthority) this.event('lifecycle_input', {
      eventName: ['Stop', 'Interrupt'].includes(params?.arguments?.hook_event_name) ? params.arguments.hook_event_name : 'other',
      hasCanonical: own(hookMeta, 'x-codex-turn-metadata'), hasCallId: own(hookMeta, 'callId'),
      threadMatches: hookMeta.threadId === this.currentThread,
      argsSessionMatchesCurrentAlias: params?.arguments?.session_id === this.currentAuthority.aliasSessionId,
      argsTurnMatchesCurrent: params?.arguments?.turn_id === this.currentTurn,
      hasSandbox: SANDBOX_KEYS.some(key => own(hookMeta, key)),
    });
    const active = this.cleanupGroup, cached = active?.authority ?? this.cache;
    const decision = cleanupDecision(params, cached, this.generation);
    const matchingCurrent = hookMeta.threadId === this.currentThread && params?.arguments?.turn_id === this.currentTurn;
    if (active) {
      if (!decision.meta) {
        this.event('hook_forwarded_without_stop', { reason: decision.reason });
        if (matchingCurrent && decision.reason === 'hook_authority_conflict') {
          this.authorityDisabled = true; this.invalidate('hook_authority_invalidated');
        }
        return owned ? this.replyOwned(message, { ok: false, code: decision.reason }) : this.child.send(message);
      }
      this.event(owned ? 'cleanup_duplicate_queued' : 'builtin_interrupt_queued');
      this.enqueueHook(active, message, false);
      return active.done;
    }
    if (this.retiredTurns.has(turnKey(hookMeta.threadId, params?.arguments?.turn_id))) {
      this.event('retired_hook_forwarded_without_stop');
      return owned ? this.replyOwned(message, { ok: false, code: 'retired_turn' }) : this.child.send(message);
    }
    const scopeMatches = this.pending.size <= 1 && [...this.pending.values()].every(value => value.qualified && value.cache === cached);
    if (!decision.meta || !scopeMatches || this.authorityDisabled) {
      this.event('hook_forwarded_without_stop', { reason: !decision.meta ? decision.reason : 'observation_scope_mismatch' });
      if (matchingCurrent && decision.reason === 'hook_authority_conflict') {
        this.authorityDisabled = true; this.invalidate('hook_authority_invalidated');
      } else if (decision.meta && !scopeMatches) this.invalidate('hook_scope_closed');
      return owned ? this.replyOwned(message, { ok: false, code: !decision.meta ? decision.reason : 'observation_scope_mismatch' }) : this.child.send(message);
    }
    // Stock callbacks retain their own one-second budget. They may wait briefly
    // for the separately configured three-second callback, but never start Stop.
    if (!owned) {
      let waiting = this.builtinWait;
      if (!waiting) {
        let finish;
        waiting = { authority: cached, epoch: this.epoch, startedAt: this.now(), entries: [],
          done: new Promise(resolvePromise => { finish = resolvePromise; }), finish };
        waiting.finish = finish;
        this.builtinWait = waiting;
        waiting.timer = setTimeout(() => { void this.releaseBuiltinWait(waiting, 'owned_callback_missing').catch(() => this.fail()); }, this.builtinWaitMs);
      }
      this.enqueueHook(waiting, message, false);
      this.event('builtin_interrupt_waiting');
      return waiting.done;
    }
    const pending = [...this.pending.values()][0];
    const startedAt = this.now(), deadline = Math.min(startedAt + this.graceMs, this.graceDeadline ?? Infinity);
    let finish, abortWait;
    const group = { authority: cached, meta: decision.meta, epoch: this.epoch, startedAt, deadline, pending, entries: [], aborted: false,
      done: new Promise(resolvePromise => { finish = resolvePromise; }), finish,
      abortedWait: new Promise(resolvePromise => { abortWait = resolvePromise; }),
      abort: () => { group.aborted = true; abortWait(false); for (const value of this.injected.values()) value.cancel(); } };
    group.finish = finish;
    if (pending) { pending.interruptedAt ??= startedAt; pending.cleanupStartedAt = startedAt; }
    // Consume the originating operation before awaiting anything. No later
    // observation of this native turn may reacquire it, even after refusal.
    this.cache = null; this.retiredTurns.add(turnKey(cached.identity.threadId, cached.identity.turnId)); this.authorityDisabled = true;
    this.cleanupGroup = group;
    const waiting = this.builtinWait;
    if (waiting) {
      clearTimeout(waiting.timer); this.builtinWait = null;
      group.waiting = waiting;
      for (const entry of waiting.entries) { entry.group = group; group.entries.push(entry); }
    }
    this.enqueueHook(group, message, true);
    this.event('cleanup_authority_consumed');
    return this.runCleanup(group);
  }
  enqueueHook(group, message, owner) {
    const entry = { message, group, owner, forwarded: false };
    group.entries.push(entry); this.hooks.set(message.id, entry);
  }
  async replyOwned(message, proof) {
    return this.outer.send({ jsonrpc: '2.0', id: message.id, result: {
      ...(proof.ok ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify({ systemMessage: 'ROUTER_WEB_STOP_ADAPTER ' + JSON.stringify(proof) }) }],
    } });
  }
  async forwardBuiltin(entry) {
    await this.child.send(entry.message);
    entry.forwarded = true;
    if (entry.cancel) await this.child.send(entry.cancel);
    this.hooks.delete(entry.message.id);
  }
  async releaseBuiltinWait(waiting, reason) {
    if (this.builtinWait !== waiting) return;
    this.builtinWait = null; clearTimeout(waiting.timer);
    // Once the real lifecycle callback reaches the official child, this old
    // originating authority cannot authorize a later injected operation.
    const identity = waiting.authority.identity;
    this.retiredTurns.add(turnKey(identity.threadId, identity.turnId));
    if (this.cache === waiting.authority) this.cache = null;
    if (this.currentThread === identity.threadId && this.currentTurn === identity.turnId) this.authorityDisabled = true;
    this.event('builtin_forwarded_without_owned_callback', { reason });
    try { for (const entry of waiting.entries) await this.forwardBuiltin(entry); }
    finally { waiting.finish(); }
  }
  async runCleanup(group) {
    const { authority: cached, pending, deadline } = group;
    const current = () => !group.aborted && !this.closed && this.epoch === group.epoch
      && this.currentThread === cached.identity.threadId && this.currentTurn === cached.identity.turnId && this.cleanupGroup === group;
    let proof = { ok: false, code: 'cleanup_cancelled' };
    try {
      // Only the actual child's result/error ends observation execution. Native
      // outer cancellation and local timeout retirement never prove it ended.
      if (pending && !await this.waitFor(Promise.race([pending.settled, group.abortedWait]), Math.max(0, deadline - this.now()))) {
        if (!current()) return;
        proof = { ok: false, code: 'observe_not_settled' };
        this.event('observation_terminal_unavailable', { childTerminalObserved: false, elapsedMs: Math.max(0, this.now() - group.startedAt) });
        this.invalidate('observe_not_settled'); return;
      }
      const timeoutMs = Math.floor(Math.min(this.cleanupMs, deadline - this.now()));
      // Preserve the existing 100 ms transport margin. Child observation and
      // cleanup consume one callback deadline; neither acquires a fresh budget.
      const budgetMs = timeoutMs - 100;
      if (!current() || budgetMs < 1) {
        proof = { ok: false, code: 'stop_budget_refused' }; this.event('stop_budget_refused'); return;
      }
      const code = stopCode(this.stopConfig, cached.identity, budgetMs);
      const response = await this.inject({ name: 'js', arguments: { code, timeout_ms: timeoutMs,
        title: 'Stop owned ChatGPT Web generation and retain its tab' }, _meta: group.meta }, Math.min(timeoutMs, Math.max(0, deadline - this.now())));
      if (!current() || this.now() > deadline) { this.event('stop_result_stale'); return; }
      proof = response?.error ? { ok: false, code: 'native_error' } : readStopResult(response?.result);
      this.event(proof.ok ? 'stop_confirmed' : 'stop_unconfirmed', proof.ok
        ? { stopClicked: proof.stopClicked, stopHidden: proof.stopHidden, retained: proof.retained }
        : { resultCode: proof.code, ...(proof.outcome === 'blocked' ? {
          outcome: proof.outcome, stage: proof.stage, freshController: proof.freshController,
          stopClicked: proof.stopClicked, stopHidden: proof.stopHidden, retained: proof.retained, elapsedMs: proof.elapsedMs,
        } : {}) });
    } finally {
      // Only the explicit callback owns this result. Original bundled messages
      // and their cancellations pass through without fabricated acknowledgments.
      // Retire this group before publishing any response. A native caller may
      // immediately start a new turn when it receives that response; completion
      // of the old group must not invalidate that new turn's authority.
      if (this.cleanupGroup === group) this.cleanupGroup = null;
      group.retired = true;
      for (const entry of group.entries) {
        // Keep unsent builtins addressable while an earlier owned response or
        // the child transport is backpressured. Their cancellation must follow
        // their actual request, including after cleanup authority has retired.
        if (entry.message.params.name !== 'turn_ended') {
          entry.forwarded = true; this.hooks.delete(entry.message.id);
        }
      }
      this.invalidate('hook_completed');
      try {
        for (const entry of group.entries) {
          if (entry.message.params.name === 'turn_ended') await this.forwardBuiltin(entry);
          else {
            entry.forwarded = true;
            await this.replyOwned(entry.message, proof);
            this.hooks.delete(entry.message.id);
          }
        }
      } finally {
        group.waiting?.finish(); group.finish();
      }
    }
  }
  async fail() { this.event('bridge_failed'); await this.close(); }
  async close() {
    if (this.closed) return;
    this.closed = true; this.invalidate('bridge_closed');
    await Promise.allSettled([this.outer.close(), this.child.close()]);
  }
}

export function readConfig(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename)) throw new Error('config_refused');
  const file = statSync(filename);
  if (!file.isFile() || file.size > 16384) throw new Error('config_refused');
  const value = validateAdapterConfig(JSON.parse(readFileSync(filename, 'utf8')));
  const receiptFile = lstatSync(value.receiptPath);
  if (!receiptFile.isFile() || receiptFile.isSymbolicLink()
      || realpathSync(value.receiptPath).toLowerCase() !== resolve(value.receiptPath).toLowerCase()) throw new Error('receipt_refused');
  const actual = createHash('sha256').update(readFileSync(value.server)).digest('hex');
  if (actual !== value.serverSha256 || realpathSync(value.server).toLowerCase() !== resolve(value.server).toLowerCase()) throw new Error('child_identity_refused');
  const sdk = JSON.parse(readFileSync(value.sdkPackageJson, 'utf8'));
  if (sdk.name !== '@modelcontextprotocol/sdk') throw new Error('sdk_identity_refused');
  const sample = value.threadIds?.[0] ?? '00000000-0000-0000-0000-000000000000';
  stopCode(value, { threadId: sample, turnId: sample, sessionId: sample });
  return snapshot(value);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('arguments_refused');
  const config = readConfig(args[1]);
  // The staged adapter is independent of checkout-relative node_modules. The
  // installer records the SDK package location, whose normal export map resolves
  // both transports without copying or inventing protocol implementations.
  const requireSdk = createRequire(config.sdkPackageJson);
  const [{ StdioClientTransport }, { StdioServerTransport }] = await Promise.all([
    import(pathToFileURL(requireSdk.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href),
    import(pathToFileURL(requireSdk.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href),
  ]);
  const before = lstatSync(config.receiptPath), receiptFd = openSync(config.receiptPath, 'a');
  const opened = fstatSync(receiptFd);
  if (!opened.isFile() || !before.isFile() || before.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(receiptFd); throw new Error('receipt_refused');
  }
  const receipt = value => appendFileSync(receiptFd, JSON.stringify(value) + '\n', 'utf8');
  // SDK merges its defaults first and this complete current environment last.
  // It is never enumerated for inspection, serialized, or logged by this code.
  const child = new StdioClientTransport({ command: config.server, args: [], env: process.env, stderr: 'ignore' });
  const bridge = new AdapterBridge({ outer: new StdioServerTransport(), child, stopConfig: config, receipt });
  let closing;
  const close = () => closing ??= bridge.close().finally(() => closeSync(receiptFd));
  const closeQuietly = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.stdin.once('end', closeQuietly);
  process.once('SIGTERM', closeQuietly);
  try {
    await bridge.start();
    receipt({ at: new Date().toISOString(), code: 'adapter_started', generation: bridge.generation, serverSha256: config.serverSha256 });
  } catch { await close(); throw new Error('startup_refused'); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(() => {
  process.stderr.write('ROUTER_STOP_ADAPTER {"code":"startup_refused"}\n'); process.exitCode = 1;
});
