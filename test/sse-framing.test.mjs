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

test("raw frame ceiling counts split final CRLF across every byte partition", () => {
  const wire = Buffer.from('data: 1\r\n\r\n');
  assert.equal(wire.length, 11);
  // Enumerate every subset of the ten byte boundaries, independently of the
  // scanner's line tokens. A frame's raw size cannot depend on that partition.
  for (let mask = 0; mask < 2 ** (wire.length - 1); mask += 1) {
    const chunks = [];
    let start = 0;
    for (let index = 1; index < wire.length; index += 1) {
      if (mask & (1 << (index - 1))) {
        chunks.push(wire.subarray(start, index));
        start = index;
      }
    }
    chunks.push(wire.subarray(start));
    const exact = new SseFrameBuffer({ maxFrameBytes: 11, maxLineBytes: 7 });
    const emitted = chunks.flatMap(chunk => [...exact.write(chunk)].map(frame => frame.bytes));
    assert.deepEqual(Buffer.concat(emitted), wire, `exact limit, partition ${mask}`);
    assert.equal(exact.pendingBytes, 0);
    const over = new SseFrameBuffer({ maxFrameBytes: 10, maxLineBytes: 7 });
    assert.throws(() => { for (const chunk of chunks) [...over.write(chunk)]; },
      { code: "SSE_FRAME_LIMIT" }, `over limit, partition ${mask}`);
  }
});

test("frame ceilings reset after continuations and preserve immediate bare-CR dispatch", () => {
  const crlf = Buffer.from('data: 1\r\n\r\n');
  const bounded = new SseFrameBuffer({ maxFrameBytes: 11, maxLineBytes: 7 });
  const initial = [...bounded.write(crlf.subarray(0, -1))];
  assert.equal(initial.length, 1);
  assert.equal(initial[0].continuation, false);
  assert.deepEqual(initial[0].bytes, crlf.subarray(0, -1));
  assert.equal(bounded.pendingBytes, 0, "bare CR dispatch is immediate");
  const next = [...bounded.write(Buffer.concat([Buffer.from('\n'), crlf, crlf]))];
  assert.deepEqual(next.map(frame => frame.continuation), [true, false, false]);
  assert.deepEqual(Buffer.concat([...initial, ...next].map(frame => frame.bytes)),
    Buffer.concat([crlf, crlf, crlf]));

  const bare = new SseFrameBuffer({ maxFrameBytes: 9, maxLineBytes: 7 });
  const bareFrame = Buffer.from('data: 1\r\r');
  assert.deepEqual([...bare.write(bareFrame)].map(frame => frame.bytes), [bareFrame]);
  const lfFrame = Buffer.from('data: 2\n\n');
  assert.deepEqual([...bare.write(lfFrame)].map(frame => frame.bytes), [lfFrame]);

  const over = new SseFrameBuffer({ maxFrameBytes: 10 });
  assert.equal([...over.write(crlf.subarray(0, -1))].length, 1);
  assert.throws(() => [...over.write(Buffer.from('\n'))], { code: "SSE_FRAME_LIMIT" });
});
