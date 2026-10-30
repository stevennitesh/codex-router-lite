// Read-only process/chat evidence. No result from this module grants kill authority.
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.mjs';
import { privateFileIsProtected } from './file-security.mjs';
import { isProcessStartIdentity } from './process-identity.mjs';
import { readWebMaintenanceProcesses } from './web-maintenance-proof.mjs';
import { webStopAdapterStatus } from './web-stop-adapter-install.mjs';
import { PROCESS_ASSOCIATION_LIMIT, processImageDigest } from './web-process-snapshot.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const ticks = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value);
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024, MAX_LIFETIMES = 256;
const NEXT = 'Keep these processes protected. Close their owning chat through Codex, or fully quit Codex normally; idle observations do not authorize termination.';
const flags = ['associationComplete', 'requestsComplete', 'webAuthorityRetained', 'cleanupActive', 'hookPending', 'observationWaiting', 'closed'];
const counts = ['outerInflight', 'childInflight', 'outerCancelledAwaitingTerminal', 'childCancelledAwaitingTerminal'];

function validStartup(value) {
  return value.schemaVersion === 1 && UUID.test(value.generation ?? '') && ['bridge', 'cua-direct'].includes(value.mode)
    && pid(value.pid) && pid(value.entryPid) && value.pid !== value.entryPid && ticks(value.startedTicks) && ticks(value.entryStartedTicks)
    && SHA.test(value.imageSha256 ?? '') && SHA.test(value.entryImageSha256 ?? '');
}
function validSnapshot(value) {
  return object(value) && value.schemaVersion === 1 && pid(value.pid) && pid(value.parentPid)
    && SHA.test(value.imageSha256 ?? '') && (value.officialChildPid === null || pid(value.officialChildPid))
    && (value.childImageSha256 === null || SHA.test(value.childImageSha256 ?? ''))
    && flags.every(key => typeof value[key] === 'boolean') && counts.every(key => count(value[key]))
    && value.outerCancelledAwaitingTerminal <= value.outerInflight && value.childCancelledAwaitingTerminal <= value.childInflight
    && Array.isArray(value.associations) && value.associations.length <= PROCESS_ASSOCIATION_LIMIT
    && value.associations.every(item => object(item) && UUID.test(item.threadId ?? '') && UUID.test(item.sessionId ?? '') && typeof item.subagent === 'boolean');
}
function nativeIdentity(row) {
  if (row?.probeState !== 'alive' || !isProcessStartIdentity(row.identity) || typeof row.executablePath !== 'string'
      || processImageDigest(row.identity.split('|')[1]) !== processImageDigest(row.executablePath)) return null;
  const [startedTicks] = row.identity.split('|');
  return ticks(startedTicks) ? { startedTicks, imageSha256: processImageDigest(row.executablePath) } : null;
}
function exact(row, startedTicks, imageSha256, parentPid) {
  const identity = nativeIdentity(row);
  return Boolean(identity && identity.startedTicks === startedTicks && identity.imageSha256 === imageSha256
    && (parentPid === undefined || row.parentPid === parentPid));
}

export function projectWebProcessDiagnostics(events, census, { truncated = false, malformed = false } = {}) {
  const lifetimes = new Map(); let omitted = 0;
  if (!Array.isArray(events)) { malformed = true; events = []; }
  for (const event of events) {
    if (!object(event) || !UUID.test(event.generation ?? '')) continue;
    let lifetime = lifetimes.get(event.generation);
    if (!lifetime) {
      if (lifetimes.size >= MAX_LIFETIMES) { lifetimes.delete(lifetimes.keys().next().value); omitted += 1; }
      lifetime = { generation: event.generation }; lifetimes.set(event.generation, lifetime);
    }
    if (event.code === 'adapter_process_started') {
      if (!validStartup(event) || lifetime.startup) lifetime.invalid = true;
      else lifetime.startup = event;
    }
    if (Object.hasOwn(event, 'process')) {
      if (!validSnapshot(event.process)) lifetime.invalid = true;
      else { lifetime.snapshot = event.process; lifetime.observedAt = typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(event.at) ? event.at : null; }
    }
  }
  const rows = new Map(); let censusComplete = census?.complete === true && Array.isArray(census.processes);
  for (const row of Array.isArray(census?.processes) ? census.processes : []) {
    if (!object(row) || !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0
        || rows.has(row.pid) || typeof row.name !== 'string' || !['alive', 'absent', 'unknown'].includes(row.probeState)) { censusComplete = false; continue; }
    rows.set(row.pid, row);
  }
  const processes = [], seen = new Set();
  const add = (row, role, lifetime, status, identityVerified) => {
    if (!row || seen.has(row.pid)) return;
    seen.add(row.pid);
    const state = lifetime?.snapshot, startup = lifetime?.startup;
    const stateBound = startup?.mode === 'bridge' && state?.pid === startup.pid && state.parentPid === startup.entryPid
      && state.imageSha256 === startup.imageSha256;
    // Each snapshot contains the full bounded observed set for this lifetime.
    // An omitted older history prefix does not invalidate a retained native
    // start receipt and self-contained snapshot for this exact generation.
    const stateUsable = Boolean(censusComplete && !malformed && !lifetime?.invalid && identityVerified && stateBound && !state.closed);
    const requestsComplete = stateUsable && state.requestsComplete;
    const idle = requestsComplete && counts.every(key => state[key] === 0) && !state.cleanupActive && !state.hookPending && !state.observationWaiting;
    processes.push({ pid: row.pid, parentPid: row.parentPid, role, generation: lifetime?.generation ?? null,
      identity: identityVerified ? 'verified-current-generation' : status,
      startedTicks: nativeIdentity(row)?.startedTicks ?? null, imageSha256: nativeIdentity(row)?.imageSha256 ?? null,
      associations: stateUsable ? state.associations.map(({ threadId, sessionId, subagent }) => ({ threadId, sessionId, subagent })) : [],
      associationStatus: stateUsable ? state.associationComplete ? 'complete-observed-set' : 'partial-observed-set' : 'unknown-or-incomplete',
      observedAt: lifetime?.observedAt ?? null,
      activity: idle ? 'idle-observed' : requestsComplete ? 'active-or-waiting-observed' : 'unknown',
      ...(requestsComplete ? Object.fromEntries([...counts, 'webAuthorityRetained', 'cleanupActive', 'hookPending', 'observationWaiting'].map(key => [key, state[key]])) : {}),
      disposition: idle ? 'protected-state-retained' : 'protected', cleanupAuthorized: false });
  };
  for (const lifetime of [...lifetimes.values()].reverse()) {
    const startup = lifetime.startup, state = lifetime.snapshot;
    if (!startup) {
      if (state) add(rows.get(state.pid), 'bridge', lifetime, 'native-start-unknown', false);
      continue;
    }
    const entry = rows.get(startup.entryPid), bridge = rows.get(startup.pid);
    const entryExact = censusComplete && exact(entry, startup.entryStartedTicks, startup.entryImageSha256);
    const bridgeExact = entryExact && exact(bridge, startup.startedTicks, startup.imageSha256, startup.entryPid);
    const coherent = bridgeExact && !lifetime.invalid && state?.pid === startup.pid && state.parentPid === startup.entryPid
      && state.imageSha256 === startup.imageSha256 && startup.mode === 'bridge';
    add(entry, 'launcher', lifetime, 'native-identity-unknown-or-reused', entryExact && bridgeExact);
    add(bridge, startup.mode === 'bridge' ? 'bridge' : 'cua-direct', lifetime, 'native-identity-unknown-or-reused',
      coherent || startup.mode === 'cua-direct' && bridgeExact && !lifetime.invalid);
    if (state?.officialChildPid) {
      const child = rows.get(state.officialChildPid), identity = nativeIdentity(child);
      // The SDK child PID, current native creation/image and exact live parent
      // generation jointly identify this observed child; no PID-only inference.
      const childExact = coherent && identity && child.parentPid === startup.pid && identity.imageSha256 === state.childImageSha256
        && BigInt(identity.startedTicks) >= BigInt(startup.startedTicks);
      add(child, 'official-repl', lifetime, 'child-identity-unknown-or-reused', Boolean(childExact));
    }
  }
  for (const row of rows.values()) {
    if (/^(?:entry|node_repl)\.exe$/iu.test(row.name)
        || /web-stop-adapter\.mjs/iu.test(row.commandLine ?? '')) add(row, 'unassociated-runtime', null, 'association-unknown', false);
  }
  return { schemaVersion: 1, readOnly: true, cleanupAuthorized: false, censusComplete,
    evidenceTruncated: truncated || omitted > 0, evidenceMalformed: malformed || [...lifetimes.values()].some(item => item.invalid),
    processes: processes.slice(0, MAX_LIFETIMES), omitted: omitted + Math.max(0, processes.length - MAX_LIFETIMES),
    observationScope: 'Last recorded adapter state joined to one Windows census. These observations can become stale and never prove it is safe to terminate a process.', next: NEXT };
}

export function readWebProcessEvents(filename, { isPrivate = privateFileIsProtected } = {}) {
  let fd;
  try {
    const before = lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || realpathSync(filename).toLowerCase() !== path.resolve(filename).toLowerCase() || !isPrivate(filename)) throw new Error('unreadable');
    fd = openSync(filename, 'r'); const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('changed');
    const length = Math.min(opened.size, MAX_RECEIPT_BYTES), offset = opened.size - length, buffer = Buffer.alloc(length);
    if (readSync(fd, buffer, 0, length, offset) !== length) throw new Error('changed');
    // Discard an omitted leading line as bytes first: the tail may begin in
    // the middle of an older UTF-8 character, which says nothing about the
    // complete current-lifetime records after its newline.
    const firstCompleteLine = offset > 0 ? buffer.indexOf(10) + 1 : 0;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(offset > 0
      ? firstCompleteLine ? buffer.subarray(firstCompleteLine) : Buffer.alloc(0) : buffer), lines = text.split('\n');
    const partial = lines.pop(); // A concurrently appended partial line is unknown, never a terminal.
    const events = []; let malformed = Boolean(partial);
    for (const line of lines) {
      if (!line) continue;
      if (line.length > 65536) { malformed = true; continue; }
      try { events.push(JSON.parse(line)); } catch { malformed = true; }
    }
    return { events, truncated: offset > 0, malformed };
  } catch (error) { return { events: [], truncated: false, malformed: error.code !== 'ENOENT', unavailable: true }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function readWebProcessDiagnostics({ stateDir = STATE_DIR, adapterStatus = webStopAdapterStatus,
  census = readWebMaintenanceProcesses, isPrivate = privateFileIsProtected, events: suppliedEvents } = {}) {
  // Existing ownership validation selects the cohort; one existing Windows
  // census supplies every current row. Neither startup nor every endpoint probes.
  let adapter, processCensus = { complete: false, processes: [] }, status = 'unknown';
  try {
    const owned = await adapterStatus({ stateDir, inspectRuntime: false });
    status = owned.state;
    if (owned.ownershipVerified && owned.managedDirectory && owned.entryPath) {
      const manifest = JSON.parse(readFileSync(path.join(owned.managedDirectory, 'manifest.json'), 'utf8'));
      adapter = { currentRuntime: manifest.plan, candidate: manifest.plan, managedEntryPath: owned.entryPath };
      processCensus = census(adapter);
    }
  } catch { /* Content-free unknown state retains all protection. */ }
  const evidence = suppliedEvents ?? readWebProcessEvents(path.join(stateDir, 'web-stop-adapter', 'events.jsonl'), { isPrivate });
  return { adapterState: status, ...projectWebProcessDiagnostics(evidence.events, processCensus, evidence) };
}
