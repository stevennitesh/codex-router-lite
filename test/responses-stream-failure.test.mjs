import assert from "node:assert/strict";
import { Readable, Transform, Writable } from "node:stream";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { markResponsesStream, observeResponsesStream } from "../src/responses-stream-failure.mjs";
import { endStreamedResponse, pipeResponse, writeStreamErrorEvent } from "../src/http-utils.mjs";

const created = { type: "response.created", sequence_number: 0,
  response: { id: "resp_fixture", model: "fixture-model", created_at: 123, status: "in_progress", output: [] } };
const frame = (event, newline = "\n") => `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
class ResponseSink extends Writable {
  headers = new Map([["content-type", "text/event-stream"]]);
  chunks = [];
  headersSent = false;
  _write(chunk, _encoding, callback) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); callback(); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  text() { return Buffer.concat(this.chunks).toString("utf8"); }
}

function observe(bytes, options) {
  const response = new ResponseSink();
  markResponsesStream(response, { model: "fixture-model" });
  observeResponsesStream(response, "text/event-stream", options);
  for (const byte of bytes) response.write(Buffer.from([byte]));
  return { response };
}
function appended(response, offset) {
  return response.text().slice(offset).split(/\r?\n/u).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
}

test("typed failures use final rewritten identity, sequences and the diagnosed cause", async () => {
  const response = new ResponseSink();
  markResponsesStream(response, { model: "requested-alias" });
  const source = Readable.toWeb(Readable.from((async function* () {
    yield frame(created);
    yield frame({ type: "response.output_text.delta", sequence_number: 4, response_id: "resp_fixture", delta: "partial text" });
    yield 'data: {"type":"response.output_text.delta",';
    await setImmediate();
    throw new Error("synthetic connection reset");
  })()));
  await assert.rejects(pipeResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), response, new Set()), /synthetic connection reset/u);
  const offset = response.text().length;
  endStreamedResponse(response, { message: "The provider connection was reset." });
  const [failure] = appended(response, offset);
  assert.equal(failure.type, "response.failed");
  assert.equal(failure.sequence_number, 5);
  assert.deepEqual(failure.response.error, { code: "server_error", message: "The provider connection was reset." });
  assert.equal(failure.response.id, "resp_fixture");
  assert.equal(failure.response.model, "fixture-model");
  assert.equal(failure.response.created_at, 123);
  assert.equal(failure.response.status, "failed");
  assert.deepEqual(failure.response.output, []);
});

test("BOM, multiline data and split CR/LF framing retain exact client bytes", () => {
  for (const newline of ["\n", "\r", "\r\n"]) {
    const wire = Buffer.from(`\uFEFF: heartbeat${newline}${newline}event: message${newline}data: {"type":"response.created",${newline}data: "sequence_number":0,"response":{"id":"resp_fixture","created_at":123}}${newline}${newline}`);
    const { response } = observe(wire);
    assert.deepEqual(Buffer.concat(response.chunks), wire);
    const offset = response.text().length;
    assert.equal(writeStreamErrorEvent(response, { code: "fixture_disconnect", message: "connection lost" }), true);
    assert.equal(appended(response, offset)[0].type, "response.failed");
  }
});

test("completed, failed and incomplete frames are not followed by another terminal", () => {
  for (const type of ["response.completed", "response.failed", "response.incomplete"]) {
    for (const terminated of [true, false]) {
      const event = { type, sequence_number: 1, response: { id: "resp_fixture", status: type.slice(9) } };
      const wire = frame(created) + (terminated ? frame(event) : `data: ${JSON.stringify(event)}`);
      const { response } = observe(Buffer.from(wire));
      const offset = response.text().length;
      assert.equal(writeStreamErrorEvent(response, { code: "trailing_disconnect", message: "disconnect" }), false);
      assert.deepEqual(appended(response, offset), []);
      assert.equal(response.text().slice(offset), terminated ? "" : "\n\n");
    }
  }
});

test("ambiguous, malformed, contradictory and oversized metadata retain generic fallback", () => {
  const cases = [
    'data: {"type":"response.created","type":"response.in_progress","sequence_number":0,"response":{"id":"resp_other","created_at":123}}\n\n',
    'data: {broken json}\n\n',
    frame({ ...created, response: { ...created.response, id: "resp_other" }, sequence_number: 1 }),
    frame({ type: "response.output_text.delta", sequence_number: 0, delta: "repeated sequence" }),
    `data: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, delta: "x".repeat(1000) })}\n\n`,
    'event: response.failed\ndata: {"type":"response.created","sequence_number":1}\n\n',
  ];
  for (const extra of cases) {
    const { response } = observe(Buffer.from(frame(created) + extra), { maxEventBytes: 512 });
    const offset = response.text().length;
    writeStreamErrorEvent(response, { code: "disconnect", message: "lost" });
    assert.equal(appended(response, offset)[0].type, "error");
  }
  const { response } = observe(Buffer.from('data: {"type":"response.created","response":{"id":"resp_missing"}}\n\n'));
  const offset = response.text().length;
  writeStreamErrorEvent(response, { code: "disconnect", message: "lost" });
  assert.equal(appended(response, offset)[0].type, "error");
});

test("a discarded pipeline cannot lend its identity to a replacement attempt", () => {
  const { response } = observe(Buffer.from(frame(created)));
  response.headersSent = false;
  observeResponsesStream(response, "text/event-stream");
  response.write(Buffer.from('data: {"type":"response.output_text.delta","sequence_number":1,"delta":"new attempt"}\n\n'));
  const offset = response.text().length;
  writeStreamErrorEvent(response, { code: "disconnect", message: "lost" });
  assert.equal(appended(response, offset)[0].type, "error");
});

test("unmarked chat SSE and non-SSE output retain their existing contracts", () => {
  const response = new ResponseSink();
  assert.equal(observeResponsesStream(response, "text/event-stream"), undefined);
  writeStreamErrorEvent(response, { code: "chat_failure", message: "lost" });
  assert.equal(appended(response, 0)[0].type, "error");
  markResponsesStream(response, { model: "fixture-model" });
  assert.equal(observeResponsesStream(response, "application/json"), undefined);
});

test("backpressure cannot lend undelivered sequence or terminal metadata to a failure", async () => {
  for (const terminal of ["absent", "complete", "unfinished"]) {
    let releaseWrite;
    class BlockedResponse extends ResponseSink {
      constructor() { super({ highWaterMark: 1 }); }
      _write(chunk, encoding, callback) {
        if (!releaseWrite) {
          super._write(chunk, encoding, () => { releaseWrite = callback; });
        } else super._write(chunk, encoding, callback);
      }
    }
    const response = new BlockedResponse();
    markResponsesStream(response, { model: "fixture-model" });
    const upstream = Readable.toWeb(Readable.from((async function* () {
      yield frame(created);
      yield frame({ type: "response.output_text.delta", sequence_number: 1, delta: "undelivered" });
      const completed = { type: "response.completed", sequence_number: 2, response: { ...created.response, status: "completed" } };
      if (terminal === "complete") yield frame(completed);
      if (terminal === "unfinished") yield `data: ${JSON.stringify(completed)}`;
      await setImmediate();
      throw new Error("disconnect under backpressure");
    })()));
    // A final pass-through stage can still hold bytes in its readable buffer.
    const stage = new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } });
    await assert.rejects(pipeResponse(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), response, new Set(), stage), /disconnect under backpressure/u);
    assert.equal(response.text(), frame(created));
    assert.ok(stage.destroyed);
    assert.equal(writeStreamErrorEvent(response, { code: "disconnect", message: "lost under backpressure" }), true);
    const finished = once(response, "finish");
    response.end();
    releaseWrite();
    await finished;
    const [failure] = appended(response, frame(created).length);
    assert.equal(failure.type, "response.failed", terminal);
    assert.equal(failure.sequence_number, 1, terminal);
    assert.equal(failure.response.id, "resp_fixture");
    assert.equal(failure.response.error.message, "lost under backpressure");
  }
});

test("terminal bytes already accepted by a backpressured response still suppress another terminal", async () => {
  let releaseWrite;
  class QueuedResponse extends ResponseSink {
    constructor() { super({ highWaterMark: 1 }); }
    _write(chunk, encoding, callback) {
      if (!releaseWrite) super._write(chunk, encoding, () => { releaseWrite = callback; });
      else super._write(chunk, encoding, callback);
    }
  }
  const response = new QueuedResponse();
  markResponsesStream(response, { model: "fixture-model" });
  observeResponsesStream(response, "text/event-stream");
  assert.equal(response.write(frame(created)), false);
  const completed = frame({ type: "response.completed", sequence_number: 1, response: { ...created.response, status: "completed" } });
  assert.equal(response.write(completed), false);
  assert.equal(response.text(), frame(created));
  assert.equal(writeStreamErrorEvent(response, { code: "trailing_disconnect", message: "disconnect" }), false);
  const finished = once(response, "finish");
  response.end();
  releaseWrite();
  await finished;
  assert.equal(response.text(), frame(created) + completed);
});
