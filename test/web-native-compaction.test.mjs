import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createNativeCompactionWitness, validNativeCompactionWitness, validNativeCompactionReference,
  nativeCompactionWitnessReference, nativeCompactionWitnessPath, readNativeCompactionWitness,
  expandNativeCompactionWitnesses, nativeCompactionResponse } from "../src/web-native-compaction.mjs";

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
