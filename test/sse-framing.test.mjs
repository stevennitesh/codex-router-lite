import assert from "node:assert/strict";
import test from "node:test";
import { SseFrameBuffer, SseLineScanner, sseFrameFields, rewriteSseFrameData } from "../src/sse-framing.mjs";

test("SSE line/framing partitions preserve all raw bytes and immediate CR dispatch", () => {
  const wire = Buffer.from('\uFEFF: comment\r\n\r\ndata: {"text":"漢🙂"}\n\r\ndata: first\rdata: second\r\r');
  const reference = wire.toString("utf8").split(/\r\n|\r|\n/).slice(0, -1);
  for (let size = 1; size <= wire.length; size += 1) {
    const lines = new SseLineScanner();
    const frames = new SseFrameBuffer();
    const observedLines = [], rawPieces = [], emitted = [];
    let pending = [];
    for (let offset = 0; offset < wire.length; offset += size) {
      const chunk = wire.subarray(offset, offset + size);
      for (const piece of lines.scan(chunk)) {
        rawPieces.push(piece.content, piece.ending);
        pending.push(piece.content);
        if (piece.endLine) {
          observedLines.push(Buffer.concat(pending).toString("utf8"));
          pending = [];
        }
      }
      for (const frame of frames.write(chunk)) emitted.push(frame.bytes);
    }
    assert.deepEqual(observedLines, reference);
    assert.deepEqual(Buffer.concat(rawPieces), wire);
    assert.equal(frames.pendingBytes, 0, "final bare CR dispatch does not wait for EOF");
    assert.deepEqual(Buffer.concat(emitted), wire);
  }
});

test("complete SSE fields use final event and joined data while preserving other fields", () => {
  const raw = Buffer.from('\uFEFFevent: old\r: comment\r\nevent: fixture\ndata: {\rdata: "type": "fixture"}\rid: 7\r\r');
  const fields = sseFrameFields(raw, true);
  assert.equal(fields.eventName, "fixture");
  assert.equal(fields.data, '{\n"type": "fixture"}');
  assert.equal(rewriteSseFrameData(fields, '{"type":"fixture","ok":true}'),
    '\uFEFF: comment\r\nevent: fixture\ndata: {"type":"fixture","ok":true}\rid: 7\r\r');
  assert.throws(() => sseFrameFields(Buffer.from([0xff]), true), /encoded data/u);
});

test("frame and line ceilings reject coalesced and fragmented input equally", () => {
  for (const chunks of [[Buffer.from('data: 12345\n\n')], [...Buffer.from('data: 12345\n\n')].map(b => Buffer.from([b]))]) {
    const frames = new SseFrameBuffer({ maxFrameBytes: 12 });
    assert.throws(() => { for (const chunk of chunks) [...frames.write(chunk)]; }, /frame exceeds 12/u);
  }
  const frames = new SseFrameBuffer({ maxLineBytes: 3 });
  assert.throws(() => [...frames.write(Buffer.from('abcd'))], /line exceeds 3/u);
});
