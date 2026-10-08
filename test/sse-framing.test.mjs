import assert from "node:assert/strict";
import test from "node:test";
import { SseFrameBuffer, SseLineScanner } from "../src/sse-framing.mjs";

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
