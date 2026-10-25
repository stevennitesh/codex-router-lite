// Read-only evidence for the agent-driven desktop Web check. The agent sends
// prompts through the app and presses its native Stop through computer use.
// This helper never sends a model request, drives a browser, or changes runtime state.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexExecutableIdentity, assertCodexExecutableIdentity } from '../src/codex-binary.mjs';
import { writePrivateFile, writePrivateJson } from '../src/file-security.mjs';
import { CODEX_HOME, INSTALL_MANIFEST_PATH, SOURCE_ROOT, STATE_DIR } from '../src/paths.mjs';
import { isSavedChatUrl, parseBrowserOutput, readBrowserProgram } from '../src/web-browser.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PHASES = ['native', 'recall', 'ready', 'stop', 'continuation'];
const MAX_BYTES = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = text => JSON.parse(text);
class WebVerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new WebVerificationError(code); };
const failureCode = error => error instanceof WebVerificationError ? error.code
  : error?.code === 'codex_binary_changed' ? 'codex_binary_changed' : 'unsupported_evidence';
const requireValue = (condition, code) => { if (!condition) fail(code); };
const normalize = value => value.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
const identity = ledger => ({ chatUrl: ledger.chatUrl, tabId: String(ledger.tabId), bindingId: ledger.bindingId });
const sameIdentity = (a, b) => a.chatUrl === b.chatUrl && a.tabId === b.tabId && a.bindingId === b.bindingId;

function bytes(file) {
  const metadata = lstatSync(file);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= MAX_BYTES, 'unsupported_evidence_file');
  return readFileSync(file);
}

// A partial final line is not a record. Invalid newline-terminated JSON fails;
// it must never disappear from the evidence as it did in ad hoc collectors.
export function parseWebJsonLines(text) {
  requireValue(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES, 'evidence_limit');
  const lines = text.split('\n');
  lines.pop();
  return lines.filter(line => line.trim()).map(line => {
    let value; try { value = json(line); } catch { fail('unsupported_jsonl'); }
    requireValue(object(value), 'unsupported_jsonl');
    return value;
  });
}

function findRollout(threadId, codexHome, explicit, now) {
  let candidates;
  if (explicit) candidates = [path.resolve(explicit)];
  else {
    // Current local/UTC dates cover resumed chats created today; UUIDv7's
    // creation date covers older chats without walking private session history.
    const creation = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
    const dates = new Set();
    for (const time of [now, creation]) for (const offset of [-86400000, 0, 86400000]) {
      const date = new Date(time + offset);
      if (!Number.isFinite(date.valueOf())) continue;
      dates.add(date.toISOString().slice(0, 10));
      dates.add([date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'));
    }
    candidates = [...dates].flatMap(date => {
      const directory = path.join(codexHome, 'sessions', ...date.split('-'));
      return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(`-${threadId}.jsonl`)).map(name => path.join(directory, name)) : [];
    });
  }
  requireValue(candidates.length === 1, 'exact_rollout_required_use_rollout_option');
  const rows = parseWebJsonLines(bytes(candidates[0]).toString('utf8'));
  const metas = rows.filter(row => row.type === 'session_meta');
  requireValue(metas.length === 1 && metas[0].payload?.id === threadId, 'session_thread_mismatch');
  return candidates[0];
}

function validLedger(ledger, threadId, { requireIdle = false } = {}) {
  requireValue(ledger?.version === 1 && ledger.threadId === threadId && isSavedChatUrl(ledger.chatUrl)
    && typeof ledger.bindingId === 'string' && ledger.bindingId.length > 0
    && ['string', 'number'].includes(typeof ledger.tabId) && String(ledger.tabId).length > 0
    && Array.isArray(ledger.unresolvedCoding) && object(ledger.lastTurn)
    && typeof ledger.uncertainSend === 'boolean', 'unsupported_ledger');
  if (requireIdle) requireValue(ledger.uncertainSend === false && ledger.unresolvedCoding.length === 0, 'unsafe_ledger');
}

export function prepareWebVerification(options, dependencies = {}) {
  const { threadId, output, rollout, protectLedger } = options;
  requireValue(UUID.test(threadId ?? ''), 'exact_thread_required');
  const sourceRoot = dependencies.sourceRoot ?? SOURCE_ROOT;
  const directory = path.resolve(output ?? '');
  const generated = path.join(sourceRoot, 'generated');
  const relative = path.relative(generated, directory);
  requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !existsSync(directory), 'fresh_generated_directory_required');
  const stateDir = dependencies.stateDir ?? STATE_DIR, codexHome = dependencies.codexHome ?? CODEX_HOME;
  const ledgerPath = path.join(stateDir, 'web-in-app', 'conversations', `${threadId}.json`);
  const ledgerBytes = bytes(ledgerPath), ledger = json(ledgerBytes.toString('utf8'));
  validLedger(ledger, threadId, { requireIdle: true });
  requireValue(ledger.lastTurn.completed === true && ledger.generationCompleted === true, 'baseline_not_completed');
  const rolloutPath = findRollout(threadId, codexHome, rollout, dependencies.now ?? Date.now());
  const adapterPath = path.join(stateDir, 'web-stop-adapter', 'ownership.json');
  const ownership = json(bytes(adapterPath).toString('utf8'));
  requireValue(ownership.owner === 'codex-router-web-stop-adapter-v1' && ownership.version === 1 && ownership.state === 'installed'
    && HASH.test(ownership.generation ?? '') && typeof ownership.managedDirectory === 'string', 'adapter_not_installed');
  const eventPath = path.join(stateDir, 'web-stop-adapter', 'events.jsonl');
  const eventBytes = bytes(eventPath);
  requireValue(!eventBytes.length || eventBytes.at(-1) === 10, 'partial_baseline_events');
  const selected = (dependencies.codexIdentity ?? codexExecutableIdentity)();
  requireValue(selected?.binary && selected.fingerprint && selected.version, 'official_identity_unknown');
  const files = [adapterPath, path.join(ownership.managedDirectory, 'manifest.json'),
    dependencies.installManifestPath ?? INSTALL_MANIFEST_PATH, path.join(codexHome, 'hooks.json')];
  const snapshots = files.map(file => ({ path: file, sha256: hash(bytes(file)) }));
  const protectedLedger = protectLedger ? { path: path.resolve(protectLedger), sha256: hash(bytes(path.resolve(protectLedger))) } : null;
  if (protectedLedger) {
    const protectedValue = json(bytes(protectedLedger.path).toString('utf8'));
    requireValue(protectedValue.version === 1 && UUID.test(protectedValue.threadId ?? '') && protectedValue.threadId !== threadId, 'protected_ledger_invalid');
  }
  const writeFile = dependencies.writeFile ?? writePrivateFile, writeJson = dependencies.writeJson ?? writePrivateJson;
  mkdirSync(directory, { recursive: true });
  const marker = `WEB_NATIVE_MARKER_${randomBytes(16).toString('hex')}`;
  const fixturePath = path.join(directory, 'native-fixture.txt');
  writeFile(fixturePath, `${marker}\n`);
  writeFile(path.join(directory, 'baseline-ledger.json'), ledgerBytes);
  for (let index = 0; index < snapshots.length; index++) writeFile(path.join(directory, `runtime-snapshot-${index}.json`), bytes(snapshots[index].path));
  const run = { version: 1, createdAt: new Date(dependencies.now ?? Date.now()).toISOString(), threadId,
    fixturePath, marker, fixtureSha256: hash(bytes(fixturePath)), baseline: identity(ledger),
    ledgerPath, rolloutPath, eventPath, eventOffset: eventBytes.length, rolloutOffset: statSync(rolloutPath).size,
    officialIdentity: selected, snapshots, protectedLedger, phases: {}, ready: null };
  const runPath = path.join(directory, 'run.json');
  writeJson(runPath, run);
  return { runPath, fixturePath, threadId, prepared: true };
}

export function webVerificationPrompt(run, phase) {
  requireValue(run?.version === 1 && UUID.test(run.threadId ?? '') && PHASES.includes(phase), 'invalid_run_or_phase');
  if (phase === 'native') {
    requireValue(!run.fixturePath.includes("'"), 'unsupported_fixture_path');
    return `Run exactly one native exec_command with default sandbox permissions and this exact PowerShell command: Get-Content -LiteralPath '${run.fixturePath}' -Raw -Encoding UTF8\nUse no other execution tools, edits, or retries. Verify exit code 0. Reply only with the exact marker read from the fixture. Keep that marker in this saved conversation for later recall.`;
  }
  if (['recall', 'continuation'].includes(phase)) return 'Recall the exact verification marker you read from the native fixture earlier in this saved conversation. Reply only with that marker. Do not use any tool, read any file, execute a command, or resume the interrupted task.';
  requireValue(phase === 'ready', 'stop_has_no_prompt');
  return 'For this authorized native Stop verification, call codex_tools_list exactly once with the query exec_command to discover the native tool. Do not invoke the discovered tool or any other execution tool or native command, read files, edit anything, or request approval. After that single discovery, generate a long numbered explanation of how a compiler works, at least 5000 numbered sentences, without summarizing early. A later native Codex Stop will interrupt this response. Do not call Stop or browser cleanup yourself.';
}

function selectedTurn(rows, threadId, turnId, createdAt) {
  const metas = rows.filter(row => row.type === 'session_meta');
  requireValue(metas.length === 1 && metas[0].payload?.id === threadId, 'session_thread_mismatch');
  const starts = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.type === 'event_msg' && row.payload?.type === 'task_started' && row.payload.turn_id === turnId);
  requireValue(starts.length <= 1, 'duplicate_turn');
  if (!starts.length) return null;
  const { row: start, index } = starts[0];
  requireValue(typeof start.timestamp === 'string' && start.timestamp >= createdAt, 'stale_turn');
  let end = rows.findIndex((row, offset) => offset > index && row.type === 'event_msg' && row.payload?.type === 'task_started');
  if (end < 0) end = rows.length;
  return rows.slice(index, end);
}

function nested(value, visit, depth = 0) {
  requireValue(depth <= 16, 'unsupported_output_depth');
  visit(value);
  if (typeof value === 'string') { let parsed; try { parsed = json(value); } catch { return; } if (typeof parsed !== 'string') nested(parsed, visit, depth + 1); }
  else if (Array.isArray(value)) value.forEach(item => nested(item, visit, depth + 1));
  else if (object(value)) Object.values(value).forEach(item => nested(item, visit, depth + 1));
}

function nativeOutput(output, marker) {
  let exact = false, error = false; const exits = new Set();
  nested(output, value => {
    if (object(value)) {
      if (value.isError === true) error = true;
      if (Number.isInteger(value.exit_code)) exits.add(value.exit_code);
      if (typeof value.output === 'string' && normalize(value.output) === marker) exact = true;
    }
    if (typeof value !== 'string') return;
    const match = /(?:^|\n)Process exited with code (-?\d+)(?:\n|$)/u.exec(value);
    if (match) exits.add(Number(match[1]));
    if (normalize(value) === marker) exact = true;
    const framed = /(?:^|\n)(?:Final output|Output):\n/u.exec(value);
    if (framed && normalize(value.slice(framed.index + framed[0].length)) === marker) exact = true;
  });
  return !error && exits.size === 1 && exits.has(0) && exact;
}

// Returns only fixed facts plus an internal checkpoint. Never print/publish the
// input rows, browser code, prompts, provider prose, raw URLs or authority data.
export function evaluateWebPhase({ run, phase, turnId, sessionRows, eventRows, ledger, fixtureText }) {
  const receipt = { version: 1, phase, threadId: run.threadId, turnId, status: 'pending', code: 'awaiting_evidence',
    nativeCommandCount: 0, nativeCompleted: false, nativeInterrupted: false, sameBinding: null,
    acceptedSend: null, currentGenerationObserved: null, stopVisible: null, completedRetain: null,
    exactMarker: null, recoveryBranchExecuted: null, adapterStopConfirmed: null, childTerminalObserved: null };
  try {
    requireValue(PHASES.includes(phase) && UUID.test(turnId ?? ''), 'invalid_phase_or_turn');
    validLedger(ledger, run.threadId);
    receipt.sameBinding = sameIdentity(identity(ledger), run.baseline);
    requireValue(receipt.sameBinding, 'saved_binding_changed');
    const rows = selectedTurn(sessionRows, run.threadId, turnId, run.createdAt);
    if (!rows) return { receipt };
    const events = rows.filter(row => row.type === 'event_msg').map(row => row.payload);
    requireValue(!events.some(event => event.turn_id && event.turn_id !== turnId), 'turn_boundary_mismatch');
    receipt.nativeCompleted = events.some(event => event.type === 'task_complete');
    receipt.nativeInterrupted = events.some(event => event.type === 'turn_aborted' && event.reason === 'interrupted');
    requireValue(!events.some(event => event.type === 'turn_aborted' && event.reason !== 'interrupted'), 'unsupported_native_abort');
    if (['ready', 'stop'].includes(phase)) requireValue(!receipt.nativeCompleted, 'completed_before_native_stop');
    else requireValue(!receipt.nativeInterrupted, 'unexpected_native_interruption');
    const calls = new Map(), outputs = new Map(), finals = [];
    let firstResponseItem = true;
    for (const row of rows) {
      if (row.type !== 'response_item') continue;
      const p = row.payload;
      if (p?.type === 'function_call_output' && !Object.hasOwn(p, 'call_id')) {
        // The desktop app records an incoming send_message_to_thread prompt as
        // its first response item. It is not a result of a target-thread call.
        // Recognize only that observed ingress envelope, never arbitrary orphan
        // outputs or a second ingress mixed into the selected native turn.
        requireValue(firstResponseItem && p.name === 'send_message_to_thread' && p.namespace === 'codex_app'
          && typeof p.id === 'string' && p.id.length > 0 && typeof p.output === 'string'
          && object(p.internal_chat_message_metadata_passthrough)
          && p.internal_chat_message_metadata_passthrough.turn_id === turnId
          && Number.isFinite(p.internal_chat_message_metadata_passthrough.create_time), 'unsupported_app_prompt_ingress');
        firstResponseItem = false;
        continue;
      }
      firstResponseItem = false;
      if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(p?.type)) {
        requireValue(typeof p.call_id === 'string' && !calls.has(p.call_id), 'duplicate_or_invalid_call'); calls.set(p.call_id, p);
      }
      if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(p?.type)) {
        requireValue(typeof p.call_id === 'string' && !outputs.has(p.call_id), 'duplicate_or_invalid_output'); outputs.set(p.call_id, p.output);
      }
      if (p?.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer') {
        requireValue(Array.isArray(p.content) && p.content.every(block => block.type === 'output_text' && typeof block.text === 'string'), 'unsupported_final_message');
        finals.push(p.content.map(block => block.text).join('\n'));
      }
    }
    for (const id of outputs.keys()) requireValue(calls.has(id), 'unpaired_output');
    const browser = [], native = [], discovery = []; let pending = false;
    for (const [id, call] of calls) {
      const paired = outputs.has(id), result = outputs.get(id);
      if (!paired) pending = true;
      if (/^call_router_web_[a-f0-9]{32}$/u.test(id)) {
        let args; try { args = json(call.arguments); } catch { fail('unsupported_browser_call'); }
        const config = readBrowserProgram(args?.code);
        requireValue(config && config.sessionId === run.threadId && config.turnId === turnId && config.bindingId === run.baseline.bindingId, 'browser_identity_mismatch');
        requireValue(['continue', 'send', 'observe', 'retain'].includes(config.operation), 'unexpected_browser_operation');
        if (['recall', 'ready', 'continuation'].includes(phase) && config.operation === 'send') requireValue(typeof config.prompt === 'string' && !config.prompt.includes(run.marker), 'marker_supplied_to_recall');
        if (!paired) continue;
        let frame;
        try { frame = parseBrowserOutput(result, config.frameToken); }
        catch {
          // Codex's actual native interruption terminal for the final owned
          // observation has no browser frame. Merely recognizing this shape
          // grants no success: the Stop phase below still requires the actual
          // interrupted event and its exact positive adapter terminal receipt.
          if (phase === 'stop' && config.operation === 'observe' && id === [...calls.keys()].at(-1)
            && typeof result === 'string' && /^aborted by user after \d+(?:\.\d+)?s$/u.test(result)) continue;
          fail('unsupported_browser_output');
        }
        requireValue(frame.operation === config.operation && frame.normal === true, 'browser_operation_failed');
        requireValue(frame.url === run.baseline.chatUrl && String(frame.tabId) === run.baseline.tabId, 'browser_binding_changed');
        requireValue(frame.recovered !== true && frame.conversationFull !== true && frame.needsHistory !== true, 'browser_recovery_or_rollover');
        if (config.operation === 'continue') receipt.recoveryBranchExecuted = false;
        requireValue(frame.requestError == null, 'browser_request_error');
        browser.push({ config, frame });
      } else if (call.type === 'tool_search_call') discovery.push(call);
      else {
        const name = (call.name ?? '').split('.').at(-1);
        requireValue(name === 'exec_command', 'unexpected_native_tool');
        native.push({ call, paired, result });
      }
    }
    receipt.nativeCommandCount = native.length;
    requireValue(phase === 'native' ? native.length <= 1 : native.length === 0, 'unexpected_native_execution');
    requireValue(['ready', 'stop'].includes(phase) || discovery.length === 0, 'unexpected_discovery');
    const accepted = ledger.lastTurn.turnId === turnId && ledger.lastTurn.sendState === 'sent' && ledger.uncertainSend === false;
    receipt.acceptedSend = accepted;
    const observations = browser.filter(item => item.config.operation === 'observe');
    const observation = observations.at(-1)?.frame;
    receipt.currentGenerationObserved = observation ? typeof observation.generationTurnKey === 'string' && observation.generationTurnKey === ledger.generationTurnKey : null;
    receipt.stopVisible = typeof observation?.stopVisible === 'boolean' ? observation.stopVisible : null;
    const sends = browser.filter(item => item.config.operation === 'send' && item.frame.sent === true);
    requireValue(sends.length <= 1, 'duplicate_send');
    const retention = browser.filter(item => item.config.operation === 'retain');
    receipt.completedRetain = retention.length ? retention.some(item => item.frame.retained === true && item.frame.completed === true && item.frame.stopVisible === false) : null;
    const authorities = eventRows.filter(row => row.code === 'authority_cached' && row.threadId === run.threadId && row.turnId === turnId);
    const authority = authorities.at(-1);
    if (authority) {
      requireValue(UUID.test(authority.generation ?? '') && HASH.test(authority.authorityDigest ?? '') && HASH.test(authority.canonicalDigest ?? ''), 'unsupported_adapter_authority');
      requireValue(typeof authority.at === 'string' && Number.isFinite(Date.parse(authority.at)) && authority.at >= run.createdAt, 'stale_adapter_authority');
      requireValue(authorities.every(row => row.generation === authority.generation && row.authorityDigest === authority.authorityDigest && row.canonicalDigest === authority.canonicalDigest), 'adapter_authority_changed');
      requireValue(!eventRows.some(row => row.generation === authority.generation && row.at >= authority.at
        && ['authority_replaced', 'hook_authority_invalidated', 'hook_scope_closed', 'transport_error', 'request_id_collision'].includes(row.code)), 'adapter_authority_invalidated');
    }
    if (phase === 'ready') {
      if (!accepted || ledger.unresolvedCoding.length !== 0 || sends.length !== 1 || !receipt.currentGenerationObserved || observation.stopVisible !== true || observation.completed !== false || ledger.generationCompleted !== false || !authority) return { receipt };
      requireValue(!receipt.nativeInterrupted, 'stop_preceded_readiness');
      requireValue(!eventRows.some(row => row.generation === authority.generation && row.code === 'stop_native_dispatched'), 'stop_preceded_readiness');
      receipt.status = 'passed'; receipt.code = 'ready_for_native_stop';
      return { receipt, checkpoint: { turnId, generationTurnKey: ledger.generationTurnKey, ...authority } };
    }
    if (phase === 'stop') {
      requireValue(ledger.uncertainSend === false && ledger.unresolvedCoding.length === 0, 'unsafe_stop_ledger');
      requireValue(run.ready?.turnId === turnId, 'readiness_receipt_required');
      requireValue(ledger.generationTurnKey === run.ready.generationTurnKey && authority?.generation === run.ready.generation
        && authority?.authorityDigest === run.ready.authorityDigest && authority?.canonicalDigest === run.ready.canonicalDigest, 'stop_authority_mismatch');
      const scoped = eventRows.filter(row => row.generation === run.ready.generation && row.at >= run.ready.at);
      requireValue(!scoped.some(row => row.code === 'authority_cached' && (row.threadId !== run.threadId || row.turnId !== turnId)), 'stop_authority_replaced');
      const dispatches = scoped.filter(row => row.code === 'stop_native_dispatched');
      requireValue(dispatches.length <= 1, 'duplicate_stop_dispatch');
      const results = scoped.filter(row => ['stop_confirmed', 'stop_unconfirmed', 'stop_terminal_after_retirement'].includes(row.code));
      requireValue(results.length <= 1, 'duplicate_stop_result');
      if (results.length) {
        const result = results[0];
        requireValue(dispatches.length === 1 && HASH.test(dispatches[0].requestDigest ?? '') && result.requestDigest === dispatches[0].requestDigest && result.at >= dispatches[0].at, 'stop_request_mismatch');
        receipt.childTerminalObserved = typeof result.childTerminalObserved === 'boolean' ? result.childTerminalObserved : null;
        receipt.adapterStopConfirmed = result.code === 'stop_confirmed' && result.outcome === 'cancelled' && result.stage === 'complete'
          && result.clickAttempted === true && result.clickError === false && result.stopClicked === true && result.stopHidden === true
          && ['composer_restored', 'turn_complete'].includes(result.inactivityEvidence)
          && result.generationInactive === true && result.retained === true && result.childTerminalObserved === true;
        requireValue(receipt.adapterStopConfirmed, 'native_stop_unconfirmed');
      }
      if (!receipt.nativeInterrupted || !receipt.adapterStopConfirmed) return { receipt };
      receipt.status = 'passed'; receipt.code = 'native_interruption_and_adapter_stop_confirmed';
      return { receipt };
    }
    if (!receipt.nativeCompleted) return { receipt };
    if (phase === 'native') requireValue(native.length === 1, 'native_command_missing');
    requireValue(!pending, 'missing_terminal_tool_output');
    requireValue(accepted && ledger.unresolvedCoding.length === 0 && ledger.lastTurn.completed === true && ledger.generationCompleted === true && sends.length === 1 && receipt.completedRetain === true, 'completed_delivery_missing');
    requireValue(finals.length === 1, 'exact_final_required');
    receipt.exactMarker = normalize(finals[0]) === run.marker;
    requireValue(receipt.exactMarker, 'marker_not_recalled');
    if (phase === 'native') {
      let args; try { args = json(native[0].call.arguments); } catch { fail('unsupported_native_arguments'); }
      requireValue(args.cmd === `Get-Content -LiteralPath '${run.fixturePath}' -Raw -Encoding UTF8`
        && (!Object.hasOwn(args, 'sandbox_permissions') || args.sandbox_permissions === 'use_default')
        && !Object.hasOwn(args, 'justification') && !Object.hasOwn(args, 'prefix_rule'), 'native_command_mismatch');
      requireValue(native[0].paired && nativeOutput(native[0].result, run.marker) && normalize(fixtureText) === run.marker, 'native_command_output_failed');
    }
    if (phase === 'continuation') requireValue(run.phases.stop?.status === 'passed' && receipt.recoveryBranchExecuted === false, 'continuation_without_retained_native_stop');
    receipt.status = 'passed'; receipt.code = 'verified';
    return { receipt };
  } catch (error) {
    return { receipt: { ...receipt, status: 'failed', code: failureCode(error) } };
  }
}

// Register before inspecting, so an append between initial inspection and watch
// setup cannot be missed. The sole timer is a failure deadline, never a poll.
export function watchWebEvidence(files, inspect, { timeoutMs = 120000, watchFile = watch } = {}) {
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000, 'invalid_deadline');
  return new Promise((resolve, reject) => {
    const watchers = []; let timer, closed = false, queued = false;
    const finish = (error, result) => {
      if (closed) return;
      closed = true; clearTimeout(timer); watchers.forEach(watcher => watcher.close());
      if (error) reject(error); else resolve(result);
    };
    const inspectNow = () => {
      if (closed) return;
      queued = false;
      try { const result = inspect(); if (result.receipt.status !== 'pending') finish(null, result); }
      catch { finish(Object.assign(new Error('evidence_read_failed'), { code: 'evidence_read_failed' })); }
    };
    const directories = new Map();
    for (const file of files) {
      const directory = path.dirname(file), names = directories.get(directory) ?? new Set();
      names.add(path.basename(file)); directories.set(directory, names);
    }
    try {
      for (const [directory, names] of directories) {
        const watcher = watchFile(directory, (_event, filename) => {
          if (filename != null && !names.has(filename.toString()) || queued || closed) return;
          queued = true; queueMicrotask(inspectNow);
        });
        watcher.on('error', () => finish(Object.assign(new Error('evidence_watch_failed'), { code: 'evidence_watch_failed' })));
        watchers.push(watcher);
      }
      timer = setTimeout(() => finish(Object.assign(new Error('evidence_deadline'), { code: 'evidence_deadline' })), timeoutMs);
      inspectNow();
    } catch { finish(Object.assign(new Error('evidence_watch_failed'), { code: 'evidence_watch_failed' })); }
  });
}

export async function waitWebVerification({ runPath, phase, turnId, timeoutMs = 120000 }, dependencies = {}) {
  const run = json(bytes(runPath).toString('utf8'));
  requireValue(run.version === 1 && UUID.test(run.threadId ?? '') && PHASES.includes(phase) && UUID.test(turnId ?? ''), 'invalid_run_or_phase');
  const predecessor = { recall: 'native', ready: 'recall', stop: 'ready', continuation: 'stop' }[phase];
  requireValue(!predecessor || run.phases[predecessor]?.status === 'passed', 'preceding_phase_required');
  requireValue(!run.phases[phase], 'phase_already_recorded_no_retry');
  requireValue(!Object.entries(run.phases).some(([key, result]) => key !== 'ready' && result.turnId === turnId), 'turn_reused');
  const checkRuntime = () => {
    (dependencies.assertIdentity ?? assertCodexExecutableIdentity)(run.officialIdentity);
    requireValue(run.snapshots.every(item => hash(bytes(item.path)) === item.sha256), 'installed_identity_changed');
    requireValue(!run.protectedLedger || hash(bytes(run.protectedLedger.path)) === run.protectedLedger.sha256, 'protected_ledger_changed');
    requireValue(hash(bytes(run.fixturePath)) === run.fixtureSha256, 'fixture_changed');
  };
  const inspect = () => {
    try {
      checkRuntime();
      const events = bytes(run.eventPath);
      requireValue(events.length >= run.eventOffset, 'adapter_events_truncated');
      return evaluateWebPhase({ run, phase, turnId, sessionRows: parseWebJsonLines(bytes(run.rolloutPath).toString('utf8')),
        eventRows: parseWebJsonLines(events.subarray(run.eventOffset).toString('utf8')),
        ledger: json(bytes(run.ledgerPath).toString('utf8')), fixtureText: bytes(run.fixturePath).toString('utf8') });
    } catch (error) { return { receipt: { version: 1, phase, threadId: run.threadId, turnId, status: 'failed', code: failureCode(error) } }; }
  };
  const watched = [run.rolloutPath, run.eventPath, run.ledgerPath, run.fixturePath, ...run.snapshots.map(item => item.path),
    ...(typeof run.officialIdentity?.binary === 'string' ? [run.officialIdentity.binary] : []), ...(run.protectedLedger ? [run.protectedLedger.path] : [])];
  let result;
  try { result = await watchWebEvidence(watched, inspect, { timeoutMs, watchFile: dependencies.watchFile ?? watch }); }
  catch (error) { result = { receipt: { ...inspect().receipt, status: 'failed', code: error.code === 'evidence_deadline' ? 'evidence_deadline' : 'evidence_watch_failed' } }; }
  result.receipt.observedAt = new Date().toISOString();
  run.phases[phase] = result.receipt;
  if (phase === 'ready' && result.receipt.status === 'passed') run.ready = result.checkpoint;
  const writeJson = dependencies.writeJson ?? writePrivateJson;
  writeJson(path.join(path.dirname(runPath), `receipt-${phase}.json`), result.receipt);
  writeJson(runPath, run);
  return result.receipt;
}

function argumentsFor(argv) {
  const [command, ...args] = argv, values = {};
  requireValue(['prepare', 'prompt', 'wait'].includes(command), 'usage_prepare_prompt_wait');
  const allowed = command === 'prepare' ? ['thread', 'output', 'rollout', 'protect-ledger'] : command === 'prompt' ? ['run', 'phase'] : ['run', 'phase', 'turn', 'timeout-ms'];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].slice(2), value = args[index + 1];
    requireValue(args[index].startsWith('--') && allowed.includes(key) && !Object.hasOwn(values, key) && value && !value.startsWith('--'), 'invalid_arguments');
    values[key] = value;
  }
  return { command, values };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, values } = argumentsFor(process.argv.slice(2));
    let result;
    if (command === 'prepare') result = prepareWebVerification({ threadId: values.thread, output: values.output, rollout: values.rollout, protectLedger: values['protect-ledger'] });
    else {
      requireValue(values.run && values.phase, 'run_and_phase_required');
      if (command === 'prompt') { console.log(webVerificationPrompt(json(bytes(values.run).toString('utf8')), values.phase)); process.exitCode = 0; }
      else result = await waitWebVerification({ runPath: path.resolve(values.run), phase: values.phase, turnId: values.turn, timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : 120000 });
    }
    if (result) { console.log(JSON.stringify(result)); process.exitCode = result.status === 'failed' ? 1 : 0; }
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', code: failureCode(error) }));
    process.exitCode = 1;
  }
}
