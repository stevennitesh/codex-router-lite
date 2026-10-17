import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";
import { openPort } from "./port-pool.mjs";

const CALLER = "native-byte-fixture-caller-capability-long-enough";
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const responseIdentity = { id: "resp_compact_fixture", created_at: 123, model: "gpt-6.1-sol" };
const created = { type: "response.created", sequence_number: 0,
  response: { ...responseIdentity, status: "in_progress", output: [] } };
const completed = { type: "response.completed", sequence_number: 1,
  response: { ...responseIdentity, status: "completed", output: [{ type: "compaction", id: "cmp_fixture", encrypted_content: "synthetic-ciphertext" }] } };
const eventsFrom = wire => wire.split(/\r?\n\r?\n/u).flatMap(block => {
  const data = block.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  try { return [JSON.parse(data)]; } catch { return []; }
});

async function fixture(t, handle, { observeFetch = false } = {}) {
  const state = mkdtempSync(path.join(os.tmpdir(), "native-byte-relay-"));
  const catalog = path.join(state, "merged-models.json");
  const publish = efforts => writeFileSync(catalog, JSON.stringify({ models: [{
    slug: "gpt-6.1-sol", supported_reasoning_levels: efforts.map(effort => ({ effort })),
  }] }));
  publish(["low", "medium"]);
  const seen = [], sockets = new Set();
  const upstream = http.createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const decoded = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
      const entry = { raw, decoded, body: JSON.parse(decoded), headers: request.headers, path: request.url, method: request.method };
      seen.push(entry);
      if (handle) return handle(entry, response);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Result 42."}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":3}}}\n\n');
    })().catch(error => { response.destroy(error); });
  });
  upstream.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const nativeBase = `http://127.0.0.1:${upstream.address().port}/backend-api/codex`;
  const nodeArgs = [];
  if (observeFetch) {
    const preload = path.join(state, "observe-native-fetch.mjs");
    writeFileSync(preload, `const nativeFetch = globalThis.fetch;
globalThis.fetch = (target, init) => {
  if (String(target) === ${JSON.stringify(`${nativeBase}/responses`)}) {
    console.error("[fixture] native-redirect-policy=" + String(init?.redirect));
  }
  return nativeFetch(target, init);
};\n`, "utf8");
    nodeArgs.push("--import", pathToFileURL(preload).href);
  }
  const port = await openPort();
  const router = launch("router.mjs", {
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    CODEX_HOME: state, MODEL_ROUTER_CODEX_AUTH: path.join(state, "missing-auth.json"),
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: CALLER,
    CODEX_ROUTER_INTERNAL_KEY: "native-byte-fixture-internal-key-long-enough",
    CODEX_NATIVE_BASE_URL: nativeBase,
    CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0", CODEX_ROUTER_QUIET: "1",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
  }, { nodeArgs });
  t.after(async () => {
    await stop(router);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  });
  const base = callerBaseUrl(port, CALLER);
  await ready(`${base}/models`, router);
  const post = (body, { encoding, compact = false } = {}) =>
    fetch(`${base}/responses${compact ? "/compact" : ""}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer native-synthetic-session",
        "chatgpt-account-id": "synthetic-account", ...(encoding ? { "Content-Encoding": encoding } : {}) },
      body, signal: AbortSignal.timeout(5000),
    });
  const send = async (body, encoding) => {
    const response = await post(body, { encoding });
    assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve("")));
    assert.match(await response.text(), /Result 42/);
    return seen.at(-1);
  };
  return { send, post, publish, router, seen };
}

test("unchanged native requests retain JSON bytes and the caller's zstd frame", async t => {
  const { send } = await fixture(t);
  const small = Buffer.from('{ "model" : "gpt-6.1-sol", "reasoning":{"effort":"medium"}, "input":[{"role":"user","content":"Value \\u0034\\u0032."}] }\n');
  assert.deepEqual((await send(small)).raw, small);
  const large = Buffer.from(JSON.stringify({ model: "gpt-6.1-sol", input: "Synthetic " + "abc 42 ".repeat(5000) }, null, 2));
  const compressed = zstdCompressSync(large, { params: { [constants.ZSTD_c_compressionLevel]: 9 } });
  const observed = await send(compressed, "zstd");
  assert.equal(observed.headers["content-encoding"], "zstd");
  assert.deepEqual(observed.raw, compressed);
  assert.deepEqual(observed.decoded, large);
});

test("native byte reuse yields to history, effort and trusted-field changes", async t => {
  const { send, publish, router } = await fixture(t);
  const original = { model: "gpt-6.1-sol", reasoning: { effort: "high" }, previous_response_id: "resp_previous",
    x_codex_router_task_projection: "untrusted", input: [{ type: "message", role: "assistant", id: "foreign_item",
      content: [{ type: "output_text", text: "Synthetic prior 42." }] }] };
  const body = zstdCompressSync(Buffer.from(JSON.stringify(original)));
  const observed = await send(body, "zstd");
  assert.equal(observed.body.reasoning.effort, "medium");
  assert.equal(observed.body.previous_response_id, undefined);
  assert.equal(observed.body.x_codex_router_task_projection, undefined);
  assert.equal(observed.body.input[0].id, undefined);
  publish(["low", "high"]);
  assert.equal((await send(body, "zstd")).body.reasoning.effort, "high");
  const timing = router.errors().split(/\r?\n/u).find(line => line.startsWith("[codex-router] timing "));
  assert.ok(timing, "native request records timing");
  const fields = new Map([...timing.matchAll(/(?:^|\s)([a-z_]+)=([^\s]+)/gu)].map(match => [match[1], match[2]]));
  for (const field of ["preparation_ms", "upstream_headers_ms", "first_token_ms"]) {
    assert.ok(fields.has(field), `${field} is recorded`);
    const value = Number(fields.get(field));
    assert.ok(Number.isFinite(value) && value >= 0, `${field}=${fields.get(field)}`);
  }
});

test("native inference rejects 307 and 308 redirects after one POST without reaching their targets", async t => {
  let redirectedRequests = 0;
  const destination = http.createServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(frame(completed));
  });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  t.after(async () => { destination.closeAllConnections(); await new Promise(resolve => destination.close(resolve)); });
  const f = await fixture(t, (entry, response) => {
    response.writeHead(entry.body.metadata.redirectStatus, {
      Location: `http://127.0.0.1:${destination.address().port}/redirected`,
    });
    response.end();
  }, { observeFetch: true });
  for (const redirectStatus of [307, 308]) {
    const before = f.seen.length;
    const response = await f.post(JSON.stringify({ model: responseIdentity.model, stream: true,
      input: "Synthetic redirect fixture.", metadata: { redirectStatus } }));
    assert.equal(response.status, 502);
    const wire = await response.text();
    assert.doesNotMatch(wire, /synthetic-account|native-synthetic-session|Synthetic redirect fixture|redirected/u);
    assert.equal(f.seen.length - before, 1);
    assert.equal(f.seen.at(-1).method, "POST");
    assert.equal(f.seen.at(-1).path, "/backend-api/codex/responses");
    assert.equal(redirectedRequests, 0);
  }
  // Some Node builds fail automatic Buffer redirects before reaching their
  // target. Assert the real Fetch policy as well as the observable POST count.
  assert.deepEqual(f.router.errors().split(/\r?\n/u).filter(line => line.startsWith("[fixture] native-redirect-policy=")),
    ["[fixture] native-redirect-policy=error", "[fixture] native-redirect-policy=error"]);
  assert.doesNotMatch(f.router.errors(), /native upstream retry/u);
});

for (const [name, initial, contentType, fullIdentity, compact] of [
  ["missing sequence", frame({ ...created, sequence_number: undefined }), "text/event-stream", false, true],
  ["unknown compaction metadata", frame({ type: "response.compaction.delta", delta: "synthetic partial" }), "text/event-stream", false, true],
  ["missing content type", frame(created), undefined, true, true],
  ["ordinary response without identity", frame({ type: "response.output_text.delta", delta: "synthetic partial" }), "text/event-stream", false, false],
]) {
  test(`native stream reset with ${name} retains the diagnosed failure without replay`, async t => {
    const f = await fixture(t, (_entry, response) => {
      response.writeHead(200, contentType ? { "Content-Type": contentType } : {});
      response.write(initial);
      setTimeout(() => response.destroy(), 50);
    });
    const response = await f.post(JSON.stringify({ model: responseIdentity.model, stream: true,
      input: [{ role: "user", content: "Synthetic stream fixture." }, ...(compact ? [{ type: "compaction_trigger" }] : [])] }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/u);
    const wire = await response.text();
    const events = eventsFrom(wire);
    const failures = events.filter(event => event.type === "response.failed");
    assert.equal(failures.length, 1, wire);
    const failure = failures[0];
    assert.equal(failure.response.status, "failed");
    assert.equal(failure.response.error.code, "server_error");
    assert.match(failure.response.error.message, /upstream.*(?:reset|closed|connection)/iu);
    assert.equal(events.some(event => event.type === "response.completed" || event.type === "error"), false);
    if (fullIdentity) assert.equal(failure.response.id, responseIdentity.id);
    else assert.deepEqual(failure, { type: "response.failed", code: "local_router_stream_failed",
      response: { status: "failed", error: failure.response.error } });
    assert.equal(f.seen.length, 1);
    if (compact) assert.equal(f.seen[0].body.input.at(-1).type, "compaction_trigger");
    assert.doesNotMatch(f.router.errors(), /native upstream retry/u);
  });
}

test("headerless native compact success preserves its ciphertext and one completion", async t => {
  const f = await fixture(t, (_entry, response) => {
    response.writeHead(200);
    response.end(frame(created) + frame(completed));
  });
  const response = await f.post(JSON.stringify({ model: responseIdentity.model, stream: true,
    input: [{ role: "user", content: "Synthetic compact success." }, { type: "compaction_trigger" }] }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/u);
  assert.deepEqual(eventsFrom(await response.text()), [created, completed]);
  assert.equal(f.seen.length, 1);
});

test("native V1 compact, nonstream, explicit non-SSE and failed headerless responses retain their body contract", async t => {
  const f = await fixture(t, (entry, response) => {
    const { status, contentType } = entry.body.metadata;
    response.writeHead(status, contentType !== undefined ? { "Content-Type": contentType } : {});
    response.end('{"output":[],"synthetic":true}');
  });
  for (const [compact, stream, status, contentType] of [
    [true, true, 200, undefined], [false, false, 200, undefined],
    [false, true, 200, "application/json"], [false, true, 200, ""], [false, true, 500, undefined],
  ]) {
    const response = await f.post(JSON.stringify({ model: responseIdentity.model, stream, input: "Synthetic body fixture.",
      metadata: { status, contentType } }), { compact });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), contentType ?? null);
    assert.equal(await response.text(), '{"output":[],"synthetic":true}');
  }
  assert.equal(f.seen.length, 5);
});
