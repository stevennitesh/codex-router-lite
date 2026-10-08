import assert from "node:assert/strict";
import test from "node:test";
import { readResponseBody } from "../src/http-utils.mjs";

test("body read deadline settles even when producer cancellation never acknowledges", async () => {
  let cancellations = 0;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("incomplete")); },
    cancel() { cancellations++; return new Promise(() => {}); },
  }));
  await assert.rejects(readResponseBody(response, { timeoutMs: 20 }), { code: "ERR_UPSTREAM_RESPONSE_TIMEOUT" });
  assert.equal(cancellations, 1);
  assert.equal(response.body.locked, false);
});

test("byte overflow does not await stalled cancellation or return a partial body", async () => {
  let cancellations = 0;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("larger than limit")); },
    cancel() { cancellations++; return new Promise(() => {}); },
  }));
  await assert.rejects(readResponseBody(response, { maxBytes: 4, timeoutMs: 20 }), { code: "ERR_UPSTREAM_RESPONSE_TOO_LARGE" });
  assert.equal(cancellations, 1);
  assert.equal(response.body.locked, false);
});

test("caller abort wins over the diagnostic deadline and releases the reader", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic caller cancellation");
  const response = new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }));
  const pending = readResponseBody(response, { signal: controller.signal, timeoutMs: 1000 });
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(response.body.locked, false);
});

test("total deadline cannot be extended by a body trickling bytes", async () => {
  let interval;
  const response = new Response(new ReadableStream({
    start(controller) { interval = setInterval(() => controller.enqueue(Buffer.from("x")), 5); },
    cancel() { clearInterval(interval); },
  }));
  try { await assert.rejects(readResponseBody(response, { timeoutMs: 25 }), { code: "ERR_UPSTREAM_RESPONSE_TIMEOUT" }); }
  finally { clearInterval(interval); }
});

test("complete and absent bodies retain ordinary bounded reads and clear deadline state", async () => {
  const value = Buffer.from("complete Unicode 漢🙂");
  assert.deepEqual(await readResponseBody(new Response(value), { timeoutMs: 1000 }), value);
  assert.deepEqual(await readResponseBody(new Response(null, { status: 204 }), { timeoutMs: 20 }), Buffer.alloc(0));
  // No deadline is imposed unless its caller selects one.
  const response = new Response(new ReadableStream({ start(controller) {
    setTimeout(() => { controller.enqueue(value); controller.close(); }, 30);
  } }));
  assert.deepEqual(await readResponseBody(response), value);
});
