import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebProcessSnapshot, processImageDigest, PROCESS_ASSOCIATION_LIMIT } from '../src/web-process-snapshot.mjs';
import { projectWebProcessDiagnostics, readWebProcessDiagnostics, readWebProcessEvents } from '../src/web-process-diagnostics.mjs';

const GENERATION = '01a14b65-a7a8-7b41-bd33-7c19d3c6df86';
const THREAD = '01a14b65-a7a8-7b41-bd33-7c19d3c6df82', SESSION = '01a14b65-a7a8-7b41-bd33-7c19d3c6df85';
const ENTRY = path.resolve('fixture-runtime/entry.exe'), NODE = path.resolve('fixture-runtime/node.exe'), REPL = path.resolve('fixture-runtime/node_repl.exe');
const identity = { threadId: THREAD, sessionId: SESSION, canonical: {} };
function fixture() {
  const observation = new WebProcessSnapshot({ pid: 100, parentPid: 90, image: NODE, childImage: REPL });
  observation.observeIdentity(identity, true);
  const state = observation.snapshot({ child: { pid: 110 }, hooks: new Map(), builtinTerminals: new Map(), pending: new Map(), closed: false });
  const startup = { code: 'adapter_process_started', schemaVersion: 1, generation: GENERATION, mode: 'bridge',
    entryPid: 90, entryStartedTicks: '638975000000000000', entryImageSha256: processImageDigest(ENTRY),
    pid: 100, startedTicks: '638975000000000100', imageSha256: processImageDigest(NODE) };
  const snapshot = { code: 'process_snapshot', generation: GENERATION, at: '2026-10-30T00:00:00.000Z', process: state };
  const row = (pid, parentPid, executablePath, startedTicks) => ({ pid, parentPid, executablePath, identity: `${startedTicks}|${executablePath}`,
    name: path.basename(executablePath), probeState: 'alive', commandLine: 'private command and token' });
  const census = { complete: true, processes: [row(90, 80, ENTRY, startup.entryStartedTicks), row(100, 90, NODE, startup.startedTicks),
    row(110, 100, REPL, '638975000000000200')] };
  return { observation, state, startup, snapshot, events: [startup, snapshot], census };
}

test('a current native launcher/bridge/SDK-child chain joins only its bounded canonical observations and remains protected when idle', () => {
  const f = fixture(), report = projectWebProcessDiagnostics(f.events, f.census);
  assert.equal(report.censusComplete, true); assert.equal(report.processes.length, 3);
  for (const row of report.processes) {
    assert.equal(row.identity, 'verified-current-generation'); assert.equal(row.activity, 'idle-observed');
    assert.equal(row.disposition, 'protected-state-retained'); assert.equal(row.cleanupAuthorized, false);
    assert.deepEqual(row.associations, [{ threadId: THREAD, sessionId: SESSION, subagent: false }]);
  }
  for (const secret of ['private command', ENTRY, NODE, REPL]) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.match(report.next, /fully quit Codex normally/u);
});

test('PID reuse, parent changes, missing native identity and image mismatch cannot claim a current chat association', async t => {
  for (const mutate of [f => { f.census.processes[1].identity = `638975000000000999|${NODE}`; },
    f => { f.census.processes[1].parentPid = 91; }, f => { f.census.processes[0].probeState = 'unknown'; },
    f => { f.census.processes[1].executablePath = REPL; }]) await t.test(mutate.toString().slice(0, 70), () => {
    const f = fixture(); mutate(f);
    const report = projectWebProcessDiagnostics(f.events, f.census);
    assert.ok(report.processes.every(row => row.cleanupAuthorized === false));
    assert.ok(report.processes.filter(row => row.role !== 'launcher').every(row => row.associationStatus === 'unknown-or-incomplete'));
  });
});

test('cancelled requests, retained hooks and observation waits keep a matched live process active until actual settlement', () => {
  for (const values of [{ childInflight: 1, childCancelledAwaitingTerminal: 1 }, { outerInflight: 1, outerCancelledAwaitingTerminal: 1 },
    { hookPending: true }, { cleanupActive: true }, { observationWaiting: true }]) {
    const f = fixture(); Object.assign(f.state, values);
    const report = projectWebProcessDiagnostics(f.events, f.census);
    assert.ok(report.processes.every(row => row.activity === 'active-or-waiting-observed' && row.disposition === 'protected'));
  }
});

test('legacy, malformed and incomplete evidence stay unknown and protected', () => {
  const f = fixture();
  const variants = [projectWebProcessDiagnostics([f.snapshot], f.census),
    projectWebProcessDiagnostics(f.events, f.census, { malformed: true }),
    projectWebProcessDiagnostics(f.events, { ...f.census, complete: false }),
    projectWebProcessDiagnostics([{ ...f.snapshot, process: { ...f.state, outerInflight: 'private malformed count' } }], f.census)];
  for (const report of variants) {
    assert.ok(report.processes.every(row => row.associationStatus === 'unknown-or-incomplete' && row.cleanupAuthorized === false));
    assert.ok(report.processes.every(row => row.activity === 'unknown'));
  }
  assert.doesNotThrow(() => projectWebProcessDiagnostics(null, { complete: true, processes: {} }));
  const duplicate = projectWebProcessDiagnostics(f.events, { complete: true, processes: [...f.census.processes, f.census.processes[0]] });
  assert.equal(duplicate.censusComplete, false); assert.ok(duplicate.processes.every(row => row.cleanupAuthorized === false));
});

test('direct CUA retains exact native generation evidence while its chat association and activity stay unknown', () => {
  const f = fixture();
  const report = projectWebProcessDiagnostics([{ ...f.startup, mode: 'cua-direct' }], f.census);
  const direct = report.processes.find(row => row.role === 'cua-direct');
  assert.equal(direct.identity, 'verified-current-generation'); assert.equal(direct.associationStatus, 'unknown-or-incomplete');
  assert.deepEqual(direct.associations, []); assert.equal(direct.activity, 'unknown'); assert.equal(direct.disposition, 'protected');
  assert.equal(direct.cleanupAuthorized, false);
});

test('validated partial observed associations remain useful with an explicit incomplete label and no termination authority', () => {
  const f = fixture(); f.state.associationComplete = false; f.state.requestsComplete = false;
  const report = projectWebProcessDiagnostics(f.events, f.census);
  for (const row of report.processes) {
    assert.deepEqual(row.associations, [{ threadId: THREAD, sessionId: SESSION, subagent: false }]);
    assert.equal(row.associationStatus, 'partial-observed-set'); assert.equal(row.activity, 'unknown');
    assert.equal(row.cleanupAuthorized, false); assert.equal(row.disposition, 'protected');
  }
});

test('association overflow and malformed metadata are sticky completeness gaps, while snapshots contain no request payloads', () => {
  const f = fixture();
  for (let index = 0; index < PROCESS_ASSOCIATION_LIMIT + 2; index++) {
    f.observation.observeIdentity({ ...identity, threadId: `${index.toString(16).padStart(8, '0')}-a7a8-7b41-bd33-7c19d3c6df82` }, true);
  }
  assert.equal(f.observation.associations.size, PROCESS_ASSOCIATION_LIMIT); assert.equal(f.observation.associationComplete, false);
  const clean = fixture().observation; clean.observeIdentity(null, true); clean.observeIdentity(identity, true);
  assert.equal(clean.associationComplete, false);
  clean.outerReceived({ id: 1, method: 'tools/call', params: { privatePayload: 'private code token and URL' } });
  assert.equal(JSON.stringify(clean.snapshot({ child: {}, hooks: new Map(), builtinTerminals: new Map(), pending: new Map() })).includes('private code'), false);
});

function directory(t) {
  const root = fileURLToPath(new URL('../.tmp/process-diagnostics/', import.meta.url)); mkdirSync(root, { recursive: true });
  const result = mkdtempSync(path.join(root, 'reader-'));
  t.after(() => rmSync(result, { recursive: true, force: true })); return result;
}
test('a log exceeding the tail bound retains useful current-lifetime evidence only when its exact native start and full snapshot are present', t => {
  const root = directory(t), filename = path.join(root, 'events.jsonl'), f = fixture();
  // The large older line is outside the current lifetime and starts before
  // the bounded tail; cutting that prefix is expected history truncation.
  const records = `${f.events.map(event => JSON.stringify(event)).join('\n')}\n`;
  let prefix = `${JSON.stringify({ historical: 'é'.repeat(5 * 1024 * 1024) })}\n`;
  const offset = Buffer.byteLength(prefix + records) - 8 * 1024 * 1024;
  if ((offset - Buffer.byteLength('{"historical":"')) % 2 === 0) prefix = `${prefix.slice(0, -1)} \n`;
  writeFileSync(filename, prefix + records, 'utf8');
  let evidence = readWebProcessEvents(filename, { isPrivate: () => true });
  assert.equal(evidence.truncated, true); assert.equal(evidence.malformed, false);
  let report = projectWebProcessDiagnostics(evidence.events, f.census, evidence);
  assert.equal(report.evidenceTruncated, true);
  assert.ok(report.processes.every(row => row.associationStatus === 'complete-observed-set' && row.activity === 'idle-observed'
    && row.disposition === 'protected-state-retained' && row.cleanupAuthorized === false));
  writeFileSync(filename, `${prefix}${JSON.stringify(f.snapshot)}\n`, 'utf8');
  evidence = readWebProcessEvents(filename, { isPrivate: () => true });
  report = projectWebProcessDiagnostics(evidence.events, f.census, evidence);
  assert.ok(report.processes.every(row => row.associationStatus === 'unknown-or-incomplete' && row.activity === 'unknown'
    && row.cleanupAuthorized === false));
});
test('the protected bounded receipt reader preserves a partial-append gap and never returns malformed private text', t => {
  const root = directory(t), filename = path.join(root, 'events.jsonl'), f = fixture();
  writeFileSync(filename, `${f.events.map(event => JSON.stringify(event)).join('\n')}\n{"privateToken":"partial`, 'utf8');
  const evidence = readWebProcessEvents(filename, { isPrivate: () => true });
  assert.equal(evidence.events.length, 2); assert.equal(evidence.malformed, true);
  assert.equal(JSON.stringify(projectWebProcessDiagnostics(evidence.events, f.census, evidence)).includes('privateToken'), false);
  assert.equal(readWebProcessEvents(filename, { isPrivate: () => false }).unavailable, true);
});

test('the public reader calls the existing census once using the owned cohort and accepts fixture evidence without live process probes', async t => {
  const root = directory(t), f = fixture(); writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ plan: { fixture: true } }), 'utf8');
  let calls = 0;
  const report = await readWebProcessDiagnostics({ stateDir: root,
    adapterStatus: options => { assert.equal(options.inspectRuntime, false); return { state: 'installed', ownershipVerified: true, managedDirectory: root, entryPath: ENTRY }; },
    census: adapter => { calls += 1; assert.deepEqual(adapter.currentRuntime, { fixture: true }); return f.census; },
    events: { events: f.events, truncated: false, malformed: false } });
  assert.equal(calls, 1); assert.equal(report.processes.length, 3); assert.equal(report.readOnly, true);
});
