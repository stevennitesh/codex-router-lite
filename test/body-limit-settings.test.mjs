import assert from "node:assert/strict";
import { Readable } from "node:stream";
import http from "node:http";
import test from "node:test";

const names = ["MODEL_ROUTER_MAX_BODY_BYTES", "CODEX_ROUTER_MAX_BODY_BYTES", "MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES", "CODEX_ROUTER_MAX_BUFFERED_RESPONSE_BYTES"];
let serial = 0;
async function configured(values, operation) {
  const before = names.map(name => process.env[name]);
  try {
    for (const name of names) { if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name]; }
    return await operation(() => import(`../src/http-utils.mjs?byte-settings=${++serial}`));
  } finally {
    names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
  }
}

test("body-limit configuration rejects values that could remove bounds", async () => {
  for (const name of names) for (const value of ["8MiB", "Infinity", "NaN", "0", "-1", "1.5", "9007199254740992"]) {
    await configured({ [name]: value }, load => assert.rejects(load(), error => error instanceof TypeError && error.message.includes(name)));
  }
});

test("defaults, compatibility aliases and primary precedence retain bounded real readers", async () => {
  await configured({}, async load => {
    const module = await load();
    assert.equal(module.MAX_BODY_BYTES, 128 * 1024 * 1024);
    assert.equal(module.MAX_BUFFERED_RESPONSE_BYTES, 8 * 1024 * 1024);
  });
  for (const primary of [true, false]) await configured({
    [primary ? names[0] : names[1]]: "32", [primary ? names[2] : names[3]]: "32",
    ...(primary ? { [names[1]]: "Infinity", [names[3]]: "Infinity" } : { [names[0]]: "", [names[2]]: "" }),
  }, async load => {
    const module = await load();
    assert.equal(module.MAX_BODY_BYTES, 32);
    assert.equal(module.MAX_BUFFERED_RESPONSE_BYTES, 32);
    await assert.rejects(module.readRequestBody(Readable.from([Buffer.alloc(33)])), { status: 413, code: "request_body_too_large" });
    await assert.rejects(module.readResponseBody(new Response(Buffer.alloc(33))), { code: "ERR_UPSTREAM_RESPONSE_TOO_LARGE" });
    assert.equal((await module.readRequestBody(Readable.from([Buffer.alloc(32)]))).length, 32);
  });
});

test("overflow drains a rejected prefix and tail before returning 413 without altering caller buffers", async () => {
  const { readRequestBody } = await import("../src/http-utils.mjs");
  const prefix = Buffer.from("1234"), overflow = Buffer.from("5678"), tail = Buffer.from("tail");
  let releaseTail, reachedTail;
  const tailReady = new Promise(resolve => { reachedTail = resolve; });
  const tailGate = new Promise(resolve => { releaseTail = resolve; });
  let destroyed = false, settled = false;
  const request = {
    destroy() { destroyed = true; },
    async *[Symbol.asyncIterator]() { yield prefix; yield overflow; reachedTail(); await tailGate; yield tail; },
  };
  const result = readRequestBody(request, { maxBytes: 6 }).then(
    () => assert.fail("oversized body accepted"), error => { settled = true; return error; },
  );
  await tailReady;
  assert.equal(settled, false); assert.equal(destroyed, false);
  releaseTail();
  const error = await result;
  assert.equal(error.status, 413); assert.equal(error.code, "request_body_too_large");
  assert.deepEqual([prefix.toString(), overflow.toString(), tail.toString()], ["1234", "5678", "tail"]);
  const iterationFailure = new Error("body transport failed");
  await assert.rejects(readRequestBody({ async *[Symbol.asyncIterator]() { yield overflow; throw iterationFailure; } }, { maxBytes: 1 }), error => error === iterationFailure);
  const controller = new AbortController(), cancellation = new Error("cancelled while draining");
  await assert.rejects(readRequestBody({
    destroy(error) { assert.equal(error, cancellation); },
    async *[Symbol.asyncIterator]() { yield overflow; controller.abort(cancellation); throw cancellation; },
  }, { maxBytes: 1, signal: controller.signal }), error => error === cancellation);
});

test("a rejected HTTP body is drained before the next request on the same connection", async t => {
  const { readRequestBody } = await import("../src/http-utils.mjs");
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    sockets.add(request.socket);
    try { response.end(await readRequestBody(request, { maxBytes: 2 })); }
    catch (error) { response.writeHead(error.status || 500); response.end(error.code); }
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => { agent.destroy(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const send = body => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", agent }, async response => {
      try {
        const parts = []; for await (const part of response) parts.push(part);
        resolve({ status: response.statusCode, body: Buffer.concat(parts).toString() });
      } catch (error) { reject(error); }
    });
    request.on("error", reject); request.end(body);
  });
  assert.deepEqual(await send("oversized body"), { status: 413, body: "request_body_too_large" });
  assert.deepEqual(await send("ok"), { status: 200, body: "ok" });
  assert.equal(sockets.size, 1);
});
