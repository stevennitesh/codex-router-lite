import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createNativeCompactionWitness, validNativeCompactionWitness, validNativeCompactionReference,
  nativeCompactionWitnessReference, nativeCompactionWitnessPath, readNativeCompactionWitness,
  expandNativeCompactionWitnesses, nativeCompactionResponse, readNativeCompactionContext, readCanonicalNativeSource,
  MAX_CANONICAL_NATIVE_SOURCE_BYTES, MAX_NATIVE_COMPACTION_WITNESS_BYTES } from "../src/web-native-compaction.mjs";
import { webCompactOutput } from "../src/web-response.mjs";
import { renderCompactionValue } from "../src/compaction-checkpoint.mjs";

const threadId = "00112233-4455-6677-8899-aabbccddeeff";
const requestId = "11002233-4455-6677-8899-aabbccddeeff";
const otherId = "22002233-4455-6677-8899-aabbccddeeff";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const original = { role: "developer", content: "Original accepted instruction." };
const tail = { role: "user", content: "Undelivered native request." };
const opaqueItem = { type: "compaction", id: "cmp_native", encrypted_content: "synthetic-private-ciphertext" };
const make = (overrides = {}) => createNativeCompactionWitness({ threadId, source: [original, tail], opaqueItem,
  responseId: "resp_native", checkpoint: [digest(original)], provenance: { kind: "router-native-request", requestId }, ...overrides });
const frame = value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const completed = { type: "response.completed", response: { id: "resp_native", status: "completed", output: [opaqueItem] } };

function contextProofFixture(t) {
  const scratch = path.resolve(".tmp"); mkdirSync(scratch, { recursive: true });
  const codexHome = mkdtempSync(path.join(scratch, "native-context-proof-"));
  t.after(() => rmSync(codexHome, { recursive: true, force: true }));
  const directory = path.join(codexHome, "sessions", "2026", "11", "01"); mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-11-01T05-00-00-${threadId}.jsonl`);
  const carrier = webCompactOutput({ input: [] }, { compactV2: true })[0];
  const prefix = [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Exact retained native context" }],
    internal_chat_message_metadata_passthrough: { turn_id: requestId, content_item_kinds: ["memories.instructions"],
      content_item_metadata: [{ provenance: { type: "harness", hook: false } }] } }];
  const rows = [{ timestamp: "2026-11-01T05:00:00.000Z", type: "session_meta", payload: { id: threadId, session_id: threadId } },
    { timestamp: "2026-11-01T05:01:00.000Z", type: "compacted", payload: { replacement_history: [...prefix, structuredClone(carrier)],
      resume_metadata: { last_started_turn_id: requestId, turn_attribution: { turn_id: requestId }, dynamic_tools: { thread_id: threadId } },
      latest_token_usage_record: { thread_id: threadId, session_id: threadId } } }];
  const options = { codexHome, threadId, carrier, encryptedSha256: createHash("sha256").update(carrier.encrypted_content).digest("hex"),
    carrierSha256: digest({ role: "developer", content: renderCompactionValue(carrier.encrypted_content) }), sourceSha256: "a".repeat(64) };
  const publish = () => writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  publish(); return { file, rows, options, prefix, publish };
}

test("canonical context acquisition binds one native session and exact trusted local carrier without changing originals", async t => {
  const fixture = contextProofFixture(t), original = readFileSync(fixture.file);
  const proof = await readNativeCompactionContext(fixture.options);
  assert.equal(proof.turnId, requestId); assert.equal(proof.sourceSha256, fixture.options.sourceSha256);
  assert.deepEqual(proof.prefix, fixture.prefix); assert.match(proof.recordSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(readFileSync(fixture.file), original);
  assert.deepEqual(await readNativeCompactionContext(fixture.options), proof);
});

test("long native histories retain exact context proof without enlarging compaction witness authority", async t => {
  const f = contextProofFixture(t);
  const padding = { timestamp: f.rows[0].timestamp, type: 'event_msg', payload: { type: 'token_count',
    diagnostic: 'x'.repeat(1024 * 1024) } };
  f.rows.splice(1, 0, ...Array.from({length:17}, () => padding)); f.publish();
  const original = readFileSync(f.file);
  assert(original.length > MAX_NATIVE_COMPACTION_WITNESS_BYTES);
  assert.deepEqual((await readNativeCompactionContext(f.options)).prefix, f.prefix);
  assert.deepEqual(readFileSync(f.file), original);
  assert.throws(() => make({source:[{role:'user',content:'x'.repeat(MAX_NATIVE_COMPACTION_WITNESS_BYTES / 2)}]}),
    {code:'web_native_compaction_state'});
  truncateSync(f.file, MAX_CANONICAL_NATIVE_SOURCE_BYTES + 1);
  assert.throws(() => readCanonicalNativeSource(f.file), /bounded regular file/u);
});

test('historical context crosses a quarantine fence only with unique ordered canonical turn boundaries', async t => {
  for (const variant of ['later','earlier','missing boundary','missing cohort','duplicate boundary','duplicate cohort']) await t.test(variant, async t => {
    const f=contextProofFixture(t);
    f.options.boundaryOwner={threadId,turnId:otherId};
    const ids=variant==='earlier'?[requestId,otherId]:[otherId,requestId];
    const starts=ids.filter(id=>!(variant==='missing boundary'&&id===otherId)&&!(variant==='missing cohort'&&id===requestId));
    if(variant==='duplicate boundary')starts.push(otherId);
    if(variant==='duplicate cohort')starts.push(requestId);
    f.rows.splice(1,0,...starts.map((id,index)=>({timestamp:`2026-11-01T05:00:0${index+1}.000Z`,type:'event_msg',payload:{type:'task_started',turn_id:id}})));
    f.publish();const proof=await readNativeCompactionContext(f.options);
    assert.equal(proof.afterQuarantineBoundary,variant==='later');
  });
});

test("canonical context acquisition refuses foreign owners, ambiguity and changed or incomplete evidence", async t => {
  for (const kind of ["foreign thread", "foreign session", "foreign usage", "foreign dynamic owner", "foreign turn", "changed carrier", "changed carrier receipt",
    "changed readable receipt", "duplicate carrier", "duplicate record", "multiple rollouts", "trailing source", "partial line", "ambiguous JSON"]) await t.test(kind, async t => {
    const f = contextProofFixture(t), compact = f.rows[1].payload;
    if (kind === "foreign thread") f.rows[0].payload.id = otherId;
    else if (kind === "foreign session") f.rows[0].payload.session_id = otherId;
    else if (kind === "foreign usage") compact.latest_token_usage_record.session_id = otherId;
    else if (kind === "foreign dynamic owner") compact.resume_metadata.dynamic_tools.thread_id = otherId;
    else if (kind === "foreign turn") compact.resume_metadata.turn_attribution.turn_id = otherId;
    else if (kind === "changed carrier") compact.replacement_history.at(-1).encrypted_content += " changed";
    else if (kind === "changed carrier receipt") f.options.encryptedSha256 = "0".repeat(64);
    else if (kind === "changed readable receipt") f.options.carrierSha256 = "0".repeat(64);
    else if (kind === "duplicate carrier") compact.replacement_history.push(structuredClone(f.options.carrier));
    else if (kind === "duplicate record") f.rows.push(structuredClone(f.rows[1]));
    else if (kind === "trailing source") compact.replacement_history.push(original);
    f.publish();
    if (kind === "multiple rollouts") writeFileSync(path.join(path.dirname(f.file), `rollout-2026-11-01T05-00-01-${threadId}.jsonl`), readFileSync(f.file));
    else if (kind === "partial line") writeFileSync(f.file, readFileSync(f.file).subarray(0, -1));
    else if (kind === "ambiguous JSON") writeFileSync(f.file, readFileSync(f.file, "utf8").replace('"type":"compacted"', '"type":"compacted","type":"compacted"'), "utf8");
    const before = readFileSync(f.file);
    await assert.rejects(readNativeCompactionContext(f.options), { code: "web_native_context_proof_unavailable" });
    assert.deepEqual(readFileSync(f.file), before);
  });
});

test("native witness exact immutable identities survive restart and reject foreign or tampered evidence", t => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "web-native-witness-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const witness = make(), reference = nativeCompactionWitnessReference(witness);
  const filePath = nativeCompactionWitnessPath(stateDir, threadId, reference.opaqueSha256);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(witness), "utf8");
  const restored = readNativeCompactionWitness({ stateDir, threadId, reference, stateIsProtected: () => true });
  assert.deepEqual(expandNativeCompactionWitnesses([opaqueItem, { role: "user", content: "New current request." }], [restored], { threadId }),
    [original, tail, { role: "user", content: "New current request." }]);
  assert.equal(validNativeCompactionWitness(witness, { threadId: otherId }), false);
  assert.equal(validNativeCompactionWitness(witness, { opaqueItem: { ...opaqueItem, id: "cmp_other" } }), false);
  assert.equal(validNativeCompactionReference({ ...reference, path: filePath }), false);
  assert.throws(() => readNativeCompactionWitness({ stateDir, threadId, reference, stateIsProtected: () => false }));
  writeFileSync(filePath, JSON.stringify({ ...witness, source: [original] }), "utf8");
  assert.throws(() => readNativeCompactionWitness({ stateDir, threadId, reference, stateIsProtected: () => true }));
  assert.throws(() => nativeCompactionWitnessPath(stateDir, "../foreign", reference.opaqueSha256));
});

test("prefix reconciliation counts repeated occurrences and preserves changed current prefix and new suffix", () => {
  const witness = make({ source: [original, original, tail] });
  const changed = { ...original, content: "Current instruction overrides historical instruction." };
  const additional = { type: "additional_tools", tools: [{ name: "current" }] };
  const suffix = { role: "user", content: "New request." };
  assert.deepEqual(expandNativeCompactionWitnesses([original, changed, original, original, additional, opaqueItem, suffix], [witness], { threadId }),
    [original, original, tail, changed, original, additional, suffix]);
  const foreign = { ...opaqueItem, encrypted_content: "foreign" };
  assert.deepEqual(expandNativeCompactionWitnesses([foreign], [witness], { threadId }), [foreign]);
});

test("canonical restoration keeps distinct provenance and refuses hidden opaque source or invalid checkpoint", () => {
  const canonical = make({ responseId: null, provenance: { kind: "canonical-readable-history", rolloutSha256: "a".repeat(64) } });
  assert.equal(validNativeCompactionWitness(canonical), true);
  assert.equal(validNativeCompactionWitness({ ...canonical, provenance: { kind: "router-native-request", requestId } }), false);
  assert.throws(() => make({ source: [opaqueItem] }));
  assert.throws(() => make({ checkpoint: ["unknown"] }));
});

test("runtime semantic projection reconciles metadata-only message differences without removing changed content", () => {
  const witness = make({ source: [{ ...original, id: "source_native_id", type: "message", status: "completed" }, tail] });
  const currentCopy = { ...original, id: "retained_native_id", type: "message" };
  const changed = { ...currentCopy, content: "Changed current instruction." };
  const itemIdentity = item => item.role ? digest({ role: item.role, content: item.content }) : null;
  assert.deepEqual(expandNativeCompactionWitnesses([currentCopy, changed, opaqueItem], [witness], { threadId, itemIdentity }),
    [...witness.source, changed]);
});

test("complete native V1 JSON and V2 SSE preserve original bytes while binding exact response output", async () => {
  const v1 = Buffer.from(` { "id": "compact_native", "output": ${JSON.stringify([original, opaqueItem])} } \n`);
  const copy = Buffer.from(v1);
  assert.deepEqual(await nativeCompactionResponse(v1, "application/json", { compactV1: true }),
    { responseId: "compact_native", output: [original, opaqueItem], opaqueItem });
  assert.deepEqual(v1, copy);
  const v2 = Buffer.from(frame({ type: "response.created", response: { id: "resp_native", status: "in_progress", output: [] } })
    + frame({ type: "response.output_item.done", item: opaqueItem }) + frame(completed) + "data: [DONE]\r\n\r\n");
  const v2copy = Buffer.from(v2);
  assert.deepEqual(await nativeCompactionResponse(v2, "text/event-stream"), { responseId: "resp_native", output: [opaqueItem], opaqueItem });
  assert.deepEqual(v2, v2copy);
});

test("incomplete, malformed, conflicting, duplicated, and spoofed terminal streams cannot authorize witness publication", async () => {
  for (const wire of [
    frame(completed).trimEnd(), frame(completed) + frame(completed),
    frame({ type: "response.incomplete", response: { id: "resp_native", status: "incomplete" } }) + frame(completed),
    frame({ type: "response.created", response: { id: "resp_foreign", status: "in_progress" } }) + frame(completed),
    frame({ type: "response.compaction.delta", response_id: "resp_foreign", delta: "partial" }) + frame(completed),
    frame({ type: "response.output_item.done", item: { ...opaqueItem, encrypted_content: "spoof" } }) + frame(completed),
    'data: {"type":"response.completed","type":"response.failed"}\n\n',
    frame({ ...completed, response: { ...completed.response, output: [opaqueItem, opaqueItem] } }),
    frame({ ...completed, response: { ...completed.response, output: [{ ...opaqueItem, status: "in_progress" }] } }),
    frame({ ...completed, response: { ...completed.response, status: "failed" } }),
    frame({ ...completed, response: { ...completed.response, id: undefined } }),
  ]) await assert.rejects(nativeCompactionResponse(Buffer.from(wire), "text/event-stream"));
});
