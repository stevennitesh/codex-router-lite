import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";
import { openPort } from "./port-pool.mjs";

const CALLER = "native-byte-fixture-caller-capability-long-enough";

async function fixture(t) {
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
      seen.push({ raw, decoded, body: JSON.parse(decoded), headers: request.headers });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Result 42."}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":3}}}\n\n');
    })().catch(error => { response.destroy(error); });
  });
  upstream.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = await openPort();
  const router = launch("router.mjs", {
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    CODEX_HOME: state, MODEL_ROUTER_CODEX_AUTH: path.join(state, "missing-auth.json"),
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: CALLER,
    CODEX_ROUTER_INTERNAL_KEY: "native-byte-fixture-internal-key-long-enough",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0", CODEX_ROUTER_QUIET: "1",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
  });
  t.after(async () => {
    await stop(router);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  });
  const base = callerBaseUrl(port, CALLER);
  await ready(`${base}/models`, router);
  const send = async (body, encoding) => {
    const response = await fetch(`${base}/responses`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer native-synthetic-session",
        "chatgpt-account-id": "synthetic-account", ...(encoding ? { "Content-Encoding": encoding } : {}) },
      body, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve("")));
    assert.match(await response.text(), /Result 42/);
    return seen.at(-1);
  };
  return { send, publish, router };
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
  assert.match(router.errors(), /preparation_ms=\d+ upstream_headers_ms=\d+ first_token_ms=\d+/);
});
