import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { readSwitchyardConfigContract } from "../scripts/switchyard-config-contract.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, responseJson, stop } from "./router-fixture.mjs";

const PARETO = "openrouter/pareto";
const GLM = "openrouter/glm-5.3-flash-streamlake";
const GLM_TOGETHER = "openrouter/glm-5.3-flash-together";
const SWITCHYARD = "switchyard/auto";
const SWITCHYARD_DISPATCH = readSwitchyardConfigContract().dispatchId;
const CALLER = "stress-fixture-caller-capability-long-enough";
const INTERNAL = "stress-fixture-internal-capability-long-enough";
const SWITCHYARD_CAPABILITY = "stress-switchyard-local-hop-capability";
const SECRET = "STRESS_SYNTHETIC_CREDENTIAL";
const PRIVATE_SENTINELS = [SECRET, "SYNTHETIC_PRIVATE_PROMPT", "SYNTHETIC_PRIVATE_ARGUMENT", "SYNTHETIC_NATIVE_PRIVATE", "SYNTHETIC_ACCOUNT_PRIVATE"];
const tools = (namespace = "fixture") => [{ type: "namespace", name: namespace, tools: [
  { type: "function", name: "inspect", parameters: { type: "object", properties: {} } },
] }];
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const message = (text, id = "msg_stress") => ({ type: "message", role: "assistant", id,
  content: [{ type: "output_text", text }] });
const eventsFrom = wire => wire.split(/\r?\n\r?\n/u).flatMap(block => {
  const data = block.split(/\r?\n/u).find(line => line.startsWith("data: "))?.slice(6);
  if (!data || data === "[DONE]") return [];
  try { return [JSON.parse(data)]; } catch { return []; }
});
const terminalOutcome = events => events.some(event =>
  event.type === "response.completed" || event.type === "response.failed" || event.type === "error");
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function bounded(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function requestBody(bytes, headers) {
  const decoded = headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes;
  return JSON.parse(decoded.toString("utf8"));
}

async function fixture(t, handler, extraEnv = {}) {
  const state = mkdtempSync(path.join(os.tmpdir(), "router-stress-"));
  const switchyardRoot = path.join(state, "switchyard-runtime");
  mkdirSync(switchyardRoot);
  writeFileSync(path.join(switchyardRoot, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
  writeFileSync(path.join(switchyardRoot, "routes.toml"), "# fixture\n");
  writeFileSync(path.join(state, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["openrouter", "switchyard"] })}\n`);
  const children = [], sockets = new Set(), controllers = new Set(), seen = [], failures = [];
  const upstream = http.createServer((request, response) => {
    (async () => {
      if (request.method === "GET" && request.url === "/health") return responseJson(response, { ok: true });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = requestBody(Buffer.concat(chunks), request.headers);
      const entry = { body, headers: request.headers, path: request.url };
      seen.push(entry);
      await handler(entry, response, request);
    })().catch(error => { failures.push(error); response.destroy(); });
  });
  upstream.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.all(children.map(stop));
    for (const socket of sockets) socket.destroy();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(state), path.resolve(os.tmpdir()));
    rmSync(state, { recursive: true, force: true });
    assert.equal(existsSync(state), false);
    assert.equal(upstream.listening, false);
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.deepEqual(failures, [], "local provider handler failed");
  });
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  const [apiPort, routerPort] = await Promise.all([openPort(), openPort()]);
  const upstreamRoot = `http://127.0.0.1:${upstream.address().port}`;
  const env = { CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL, CODEX_ROUTER_CALLER_KEY: CALLER,
    CODEX_ROUTER_API_PORT: String(apiPort), CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`, CODEX_ROUTER_GATEWAY_BASE_URL: `${upstreamRoot}/v1`,
    CODEX_NATIVE_BASE_URL: `${upstreamRoot}/backend-api/codex`, CODEX_ROUTER_SWITCHYARD_BASE_URL: `${upstreamRoot}/v1`,
    CODEX_ROUTER_SWITCHYARD_ROOT: switchyardRoot,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: SWITCHYARD_CAPABILITY, CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    OPENROUTER_API_KEY: SECRET, OPENROUTER_API_BASE_URL: `${upstreamRoot}/v1`,
    ...extraEnv };
  const forwarder = launch("api-forwarder.mjs", env); children.push(forwarder);
  const router = launch("router.mjs", env); children.push(router);
  const base = callerBaseUrl(routerPort, CALLER);
  await ready(`${base}/models`, router);
  await ready(`http://127.0.0.1:${apiPort}/v1/responses`, forwarder, { Authorization: `Bearer ${INTERNAL}` });
  return { seen, errors: () => children.map(child => child.errors()).join("\n"),
    controller() { const controller = new AbortController(); controllers.add(controller); return controller; },
    post(body, endpoint = "responses", signal = AbortSignal.timeout(10000)) {
      return fetch(`${base}/${endpoint}`, { method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer SYNTHETIC_NATIVE_PRIVATE",
          "ChatGPT-Account-Id": "SYNTHETIC_ACCOUNT_PRIVATE" },
        body: JSON.stringify({ model: PARETO, input: [{ role: "user", content: "SYNTHETIC_PRIVATE_PROMPT" }], ...body }) });
    } };
}

test("native, direct Responses and translated routes retain a single typed disconnect cause", { timeout: 30000 }, async t => {
  const f = await fixture(t, async (_context, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.created", sequence_number: 0,
      response: { id: "resp_disconnect", model: "fixture-upstream", created_at: 123, status: "in_progress", output: [] } }));
    response.write(frame({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: message("", "msg_disconnect") }));
    response.write(frame({ type: "response.output_text.delta", sequence_number: 2, output_index: 0,
      content_index: 0, item_id: "msg_disconnect", delta: "partial evidence" }));
    await new Promise(resolve => setTimeout(resolve, 25));
    response.destroy();
  });
  for (const model of ["gpt-6.1-sol", PARETO, GLM]) {
    const prior = f.seen.length;
    const response = await f.post({ model, stream: true });
    const wire = await response.text();
    const failures = eventsFrom(wire).filter(event => event.type === "response.failed");
    assert.equal(failures.length, 1, `${model} keeps one failure`);
    assert.equal(failures[0].response.id, "resp_disconnect");
    assert.equal(failures[0].sequence_number, 3);
    assert.equal(failures[0].response.status, "failed");
    assert.equal(failures[0].response.error.code, "server_error");
    assert.match(failures[0].response.error.message, /lost|disconnected|reset|closed early/iu);
    assert.doesNotMatch(wire, /response\.completed/u);
    assert.equal(f.seen.length, prior + 1, "partial response must never trigger a replay");
  }
});

async function fragmented(response, events, seed) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const bytes = Buffer.from(events.map(frame).join(""));
  let random = seed >>> 0;
  for (let offset = 0; offset < bytes.length;) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const size = 1 + random % 37;
    response.write(bytes.subarray(offset, offset += size));
    await setImmediate();
  }
  response.end();
}

test("stress: complete reasoning frames reach callers before a gated terminal across SSE endings", { timeout: 20000 }, async t => {
  const gates = new Map();
  t.after(() => { for (const gate of gates.values()) gate.resolve(); });
  const delimiters = { lf: "\n\n", crlf: "\r\n\r\n", mixed: "\n\r\n", cr: "\r\r" };
  const f = await fixture(t, async ({ body }, response) => {
    const label = /FRAMING_TEST:([a-z-]+)/.exec(JSON.stringify(body.input))[1];
    const delimiter = delimiters[label.split("-").at(-1)];
    const encode = event => `data: ${JSON.stringify(event)}${delimiter}`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(encode({ type: "response.reasoning_summary_text.delta", delta: "visible progress" }));
    await gates.get(label).promise;
    response.end(encode({ type: "response.completed", response: { id: `resp_${label}`, status: "completed", output: [message("answer")] } }));
  }, { CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS: "1000", CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: "3000" });
  for (const [transport, model] of [["native", "gpt-5.6-sol"], ["routed", PARETO]]) {
    for (const ending of Object.keys(delimiters)) {
      const label = `${transport}-${ending}`;
      const gate = deferred(); gates.set(label, gate);
      const response = await f.post({ model, stream: true, input: `FRAMING_TEST:${label}` });
      let wire = "", progressDelivered = false;
      try {
        for await (const bytes of response.body) {
          wire += Buffer.from(bytes).toString("utf8");
          if (!progressDelivered && wire.includes("visible progress")) {
            assert.ok(!wire.includes('"type":"response.completed"'), "the origin is still gated");
            progressDelivered = true;
            gate.resolve();
          }
        }
      } finally { gate.resolve(); }
      assert.equal(response.status, 200, `${label}: ${wire}`);
      assert.equal(progressDelivered, true, `${label}: framing must not hide progress`);
      assert.match(wire, /answer/);
    }
  }
  assert.equal(f.seen.length, 8, "all framing variants use one accepted request");
});

test("stress: unknown pre-content failures are not replayed while completed-empty repair remains", { timeout: 20000 }, async t => {
  const attempts = new Map(), closures = new Map();
  const f = await fixture(t, ({ body }, response) => {
    const scenario = /REPLAY_TEST:([a-z-]+)/.exec(JSON.stringify(body.input))[1];
    const count = (attempts.get(scenario) || 0) + 1;
    attempts.set(scenario, count);
    if (!closures.has(scenario)) closures.set(scenario, deferred());
    response.once("close", closures.get(scenario).resolve);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    if (scenario === "stall") return;
    if (scenario === "byte-limit") return response.end(`:${"x".repeat(1024)}\n\n`);
    if (scenario === "visible-stall") {
      response.write(frame({ type: "response.reasoning_summary_text.delta", delta: "visible reasoning" }));
      return;
    }
    response.end(frame({ type: "response.completed", response: { status: "completed", output:
      scenario === "empty" && count === 1 ? [] : [message("repaired answer")] } }));
  }, { CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS: "50", CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_BYTES: "512",
    CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: "1000", CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1" });
  for (const scenario of ["stall", "byte-limit", "visible-stall", "empty", "ordinary"]) {
    const response = await f.post({ model: GLM, stream: true, input: `REPLAY_TEST:${scenario}` });
    const wire = await response.text();
    await bounded(closures.get(scenario).promise, "original upstream closes");
    assert.equal(attempts.get(scenario), scenario === "empty" ? 2 : 1, scenario);
    if (scenario === "stall" || scenario === "byte-limit") {
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(wire).error.code, "precontent_limit");
      assert.match(wire, /outcome is unknown/);
    } else if (scenario === "visible-stall") {
      assert.match(wire, /visible reasoning/);
      assert.match(wire, /precontent_limit/);
      assert.doesNotMatch(wire, /response.completed/);
    } else {
      assert.equal(response.status, 200);
      assert.match(wire, /repaired answer/);
    }
    for (const sentinel of PRIVATE_SENTINELS) assert.ok(!wire.includes(sentinel));
  }
});

test("stress: representative routes preserve their distinct boundaries", { timeout: 20000 }, async t => {
  const f = await fixture(t, ({ body }, response) => responseJson(response, {
    id: `resp_${body.model}`, status: "completed", output: [message(`control:${body.model}`)],
  }));
  for (const [model, extra] of [
    ["gpt-5.6-sol", { input: "native control" }],
    [GLM, { input: "gateway control" }],
    [GLM, { tools: [{ type: "web_search" }], tool_choice: "auto", input: "hosted search control" }],
    [GLM_TOGETHER, { tools: [{ type: "web_search" }], tool_choice: { type: "web_search" }, input: "hosted search control" }],
    [PARETO, { input: "direct responses control" }],
    [SWITCHYARD, { input: "switchyard control" }],
  ]) {
    const response = await f.post({ model, ...extra });
    const responseBody = await response.arrayBuffer();
    assert.equal(response.status, 200, Buffer.from(responseBody).toString());
  }
  const [nativeSeen, gatewaySeen, streamlakeSeen, togetherSeen, paretoSeen, switchyardSeen] = f.seen;
  assert.equal(nativeSeen.path, "/backend-api/codex/responses");
  assert.equal(nativeSeen.body.model, "gpt-5.6-sol");
  assert.equal(nativeSeen.headers.authorization, "Bearer SYNTHETIC_NATIVE_PRIVATE");
  assert.equal(gatewaySeen.body.model, "openrouter-glm-5-3-flash-streamlake");
  assert.equal(streamlakeSeen.body.model, "z-ai/glm-5.3-flash");
  assert.deepEqual(streamlakeSeen.body.provider.only, ["streamlake/fp8"]);
  assert.deepEqual(togetherSeen.body.provider.only, ["together"]);
  assert.equal(paretoSeen.body.model, "unbiased/pareto");
  assert.deepEqual(paretoSeen.body.provider.only, ["unbiased"]);
  for (const external of [gatewaySeen, streamlakeSeen, togetherSeen, paretoSeen])
    assert.equal(external.headers["chatgpt-account-id"], undefined);
  assert.equal(switchyardSeen.body.model, SWITCHYARD_DISPATCH);
  assert.equal(switchyardSeen.headers["x-codex-router-switchyard-capability"], SWITCHYARD_CAPABILITY);
  assert.equal(switchyardSeen.headers.authorization, "Bearer SYNTHETIC_NATIVE_PRIVATE");
});

test("stress: routed POSTs reject redirects without replaying prompts or credentials", { timeout: 20000 }, async t => {
  const crossOriginRequests = [];
  const redirectTarget = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      crossOriginRequests.push({
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      responseJson(response, {
        id: "resp_cross_origin", status: "completed", output: [message("redirect followed")],
      });
    });
  });
  await new Promise((resolve, reject) => {
    redirectTarget.once("error", reject);
    redirectTarget.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    if (redirectTarget.listening) {
      await new Promise(resolve => redirectTarget.close(resolve));
    }
  });
  const crossOrigin = `http://127.0.0.1:${redirectTarget.address().port}/redirected`;
  const f = await fixture(t, (entry, response) => {
    if (entry.path === "/redirected") {
      return responseJson(response, {
        id: "resp_redirected", status: "completed", output: [message("redirect followed")],
      });
    }
    response.writeHead(entry.body.metadata?.redirect_status || 307, {
      Location: entry.body.metadata?.cross_origin ? crossOrigin : "/redirected",
    });
    response.end();
  });
  for (const [model, metadata] of [
    [GLM, { redirect_status: 307 }],
    [PARETO, { redirect_status: 308, cross_origin: true }],
    [SWITCHYARD, { redirect_status: 308, cross_origin: true }],
  ]) {
    const before = f.seen.length;
    const response = await f.post({ model, metadata, input: `redirect control for ${model}` });
    await response.arrayBuffer();
    assert.equal(response.status, 502);
    assert.equal(f.seen.length - before, 1, `${model} must not replay a redirected POST`);
    assert.notEqual(f.seen.at(-1).path, "/redirected");
  }
  for (const [model, metadata] of [
    [GLM, { redirect_status: 307, cross_origin: true }],
    [PARETO, { redirect_status: 308 }],
  ]) {
    const before = f.seen.length;
    const response = await f.post({
      model,
      metadata,
      input: [{ role: "user", content: `compact redirect control for ${model}` }],
    }, "responses/compact");
    await response.arrayBuffer();
    assert.equal(response.status, 502);
    assert.equal(f.seen.length - before, 1, `${model} compaction must not replay a redirected POST`);
    assert.notEqual(f.seen.at(-1).path, "/redirected");
  }
  assert.deepEqual(crossOriginRequests, []);
});

test("stress: provider stream failures remain failures after partial output", { timeout: 20000 }, async t => {
  let release = deferred(), scenario = "disconnect";
  const f = await fixture(t, async (_entry, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(frame({ type: "response.output_text.delta", item_id: "msg_stress", delta: "partial evidence" }));
    await release.promise;
    if (scenario === "explicit") response.end(frame({ type: "error", code: "fixture_failure", message: "synthetic failure" }));
    else response.destroy();
  });
  const response = await f.post({ stream: true });
  const reader = response.body.getReader();
  const first = await bounded(reader.read(), "partial output reaches caller");
  release.resolve();
  let wire = Buffer.from(first.value).toString();
  for (;;) { const part = await reader.read(); if (part.done) break; wire += Buffer.from(part.value).toString(); }
  assert.match(wire, /partial evidence/u);
  assert.equal(terminalOutcome(eventsFrom(wire)), true);
  assert.doesNotMatch(wire, /response\.completed|final_answer/u);
  assert.equal(f.seen.length, 1, "partial output cannot be retried");
  scenario = "explicit"; release = deferred();
  const explicitResponse = await f.post({ stream: true });
  release.resolve();
  const explicitWire = await explicitResponse.text();
  assert.match(explicitWire, /fixture_failure/u);
  assert.doesNotMatch(explicitWire, /response\.completed|final_answer/u);
  assert.equal(f.seen.length, 2);
});

test("stress: canceling a routed body after response.completed keeps successful accounting", { timeout: 20000 }, async t => {
  const release = deferred();
  const upstreamClosed = deferred();
  const f = await fixture(t, (_entry, response) => {
    response.once("close", upstreamClosed.resolve);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(frame({
      type: "response.output_text.delta", item_id: "msg_terminal_accounting", delta: "done",
    }));
    response.write(frame({
      type: "response.completed",
      response: { id: "resp_terminal_accounting", status: "completed", output: [] },
    }));
    return release.promise;
  });
  t.after(release.resolve);
  const response = await f.post({ stream: true, metadata: { scenario: "terminal-accounting" } });
  const reader = response.body.getReader();
  let wire = "";
  while (!wire.includes("response.completed")) {
    const part = await bounded(reader.read(), "completed terminal reaches caller");
    assert.equal(part.done, false);
    wire += Buffer.from(part.value).toString("utf8");
  }
  await reader.cancel();
  await bounded(upstreamClosed.promise, "completed upstream closes after caller cancel");
  let timing;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    timing = f.errors().split(/\r?\n/u).find(line =>
      line.includes(`model=${PARETO}`) && line.includes("provider=openrouter")
    );
    if (timing) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.match(timing || "", /status=200\b/u);
  assert.doesNotMatch(timing || "", /status=0\b/u);
  release.resolve();
});

test("stress: seeded function arguments preserve identity and never invent content", { timeout: 30000 }, async t => {
  const privateArgs = JSON.stringify({ value: "SYNTHETIC_PRIVATE_ARGUMENT_λ🌲" });
  const f = await fixture(t, async ({ body }, response) => {
    const { seed, mode } = body.metadata;
    const item = { type: "function_call", id: "fc_stress", call_id: `call_${seed}`, name: body.tools[0].name, arguments: "" };
    const streamed = mode === "empty" ? "" : privateArgs;
    const completed = mode === "control" ? privateArgs : "";
    await fragmented(response, [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: streamed },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: streamed },
      { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: completed } },
      { type: "response.completed", response: { status: "completed", output: [{ ...item, arguments: completed }] } },
    ], seed);
  });
  const controls = [];
  for (const [seed, mode] of [[17, "control"], [17, "control"], [23, "empty"], [101, "inconsistent"]]) {
    const response = await f.post({ tools: tools(), stream: true, metadata: { seed, mode } });
    assert.equal(response.status, 200);
    const events = eventsFrom(await response.text());
    const call = events.find(event => event.type === "response.output_item.done").item;
    assert.equal(call.call_id, `call_${seed}`); assert.equal(call.namespace, "fixture"); assert.equal(call.name, "inspect");
    assert.equal(call.arguments, mode === "control" ? privateArgs : "");
    if (mode === "control") controls.push(events);
  }
  assert.deepEqual(controls[0], controls[1]);
  const diagnostics = () => f.errors().split(/\r?\n/u).slice(0, -1)
    .flatMap(line => {
      const match = /^\[codex-router\] tool-protocol .*? (\{.*\})$/u.exec(line);
      return match ? [JSON.parse(match[1])] : [];
    });
  const inconsistentDiagnostic = () => diagnostics().find(diagnostic =>
    diagnostic.code === "empty_function_arguments" && diagnostic.deltaCharacters === privateArgs.length);
  for (let attempt = 0; attempt < 100 && !inconsistentDiagnostic(); attempt += 1)
    await new Promise(resolve => setTimeout(resolve, 10));
  const diagnostic = inconsistentDiagnostic();
  assert.ok(diagnostic, "contradictory empty provider close records its observed argument counts");
  for (const [field, expected] of Object.entries({ code: "empty_function_arguments", sourceCharacters: 0,
    restoredCharacters: 0, deltaCharacters: privateArgs.length, doneCharacters: privateArgs.length })) {
    assert.equal(diagnostic[field], expected, field);
  }
  for (const sentinel of PRIVATE_SENTINELS) assert.ok(!f.errors().includes(sentinel));
  assert.equal(f.seen.length, 4);
});

test("stress: native and provider POST refusals never trigger automatic status replay", { timeout: 20000 }, async t => {
  const f = await fixture(t, ({ body }, response) => {
    const status = body.metadata.status;
    response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "7" });
    response.end(JSON.stringify({ error: { message: `Synthetic provider HTTP ${status}` } }));
  });
  for (const model of ["gpt-6.1-sol", "openrouter/deepseek-v4.1-flash-together"]) {
    for (const status of [429, 502, 503, 504, 520]) {
      const before = f.seen.length;
      const response = await f.post({ model, metadata: { status } });
      assert.equal(response.status, status); assert.equal(response.headers.get("retry-after"), "7");
      assert.ok((await response.json()).error); assert.equal(f.seen.length - before, 1);
    }
  }
});

test("stress: accepted POST disconnects are returned once through native and provider callers", { timeout: 20000 }, async t => {
  const f = await fixture(t, ({ body }, response, request) => {
    if (body.metadata?.scenario === "positive-control") {
      return responseJson(response, {
        id: "resp_control", status: "completed", output: [message("completed")],
      });
    }
    request.socket.destroy();
  }, { CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS: "40" });
  for (const model of ["gpt-6.1-sol", "openrouter/deepseek-v4.1-flash-together"]) {
    const before = f.seen.length;
    const failed = await f.post({ model, metadata: { scenario: "disconnect-after-acceptance" } });
    assert.equal(failed.status, 502); await failed.arrayBuffer();
    assert.equal(f.seen.length - before, 1);
    const control = await f.post({ model, metadata: { scenario: "positive-control" } });
    assert.equal(control.status, 200); await control.arrayBuffer();
    assert.equal(f.seen.length - before, 2);
  }
});

test("stress: routed error bodies have a separate total budget and release upstream work", { timeout: 20000 }, async t => {
  let closed = 0;
  const entered = deferred();
  const f = await fixture(t, ({ body }, response) => {
    const { mode, status = 429 } = body.metadata;
    if (mode === "success") {
      return new Promise(resolve => setTimeout(() => {
        responseJson(response, { id: "slow_success", status: "completed", output: [message("done")] }); resolve();
      }, 160));
    }
    response.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
    if (mode === "absent") { response.end(); return; }
    if (mode === "oversized") { response.end(JSON.stringify({ error: { message: "x".repeat(2048) } })); return; }
    if (mode === "truncated") { response.write('{"error":{"message":"insufficient quota'); setImmediate().then(() => response.destroy()); return; }
    if (mode === "complete") { response.end('{"error":{"message":"synthetic useful refusal"}}'); return; }
    if (mode === "context") { response.end('{"error":{"message":"context_length_exceeded"}}'); return; }
    if (mode === "quota") { response.end('{"error":{"message":"insufficient quota","type":"insufficient_quota"}}'); return; }
    response.once("close", () => closed++);
    response.write('{"error":{"message":"insufficient quota"}}');
    if (mode === "trickle") {
      const timer = setInterval(() => response.write(" "), 10);
      response.once("close", () => clearInterval(timer));
    }
    if (mode === "cancel") entered.resolve();
  }, { CODEX_ROUTER_ERROR_BODY_TIMEOUT_MS: "80", MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: "1000", MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES: "1024" });
  const model = "openrouter/deepseek-v4.1-flash-together";
  for (const mode of ["stall", "trickle", "truncated", "oversized", "absent"]) {
    const response = await f.post({ model, metadata: { mode } });
    assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "7");
    const { error } = await response.json();
    assert.equal(error.type, "rate_limit_error", `${mode}: incomplete diagnostics cannot classify a quota rejection`);
    assert.match(error.message, /Retry in about 7s/);
    assert.doesNotMatch(error.message, /insufficient quota|execution deadline/);
  }
  for (const status of [400, 401, 429, 503]) {
    const response = await f.post({ model, metadata: { mode: "complete", status } });
    assert.equal(response.status, status);
    assert.match((await response.json()).error.message, /synthetic useful refusal/);
  }
  const quota = await f.post({ model, metadata: { mode: "quota" } });
  assert.equal(quota.status, 429); assert.equal((await quota.json()).error.type, "billing_error");
  const context = await f.post({ model, metadata: { mode: "context", status: 500 } });
  assert.equal(context.status, 400); assert.equal((await context.json()).error.code, "context_length_exceeded");
  const slow = await f.post({ model, metadata: { mode: "success" } });
  assert.equal(slow.status, 200); assert.equal((await slow.json()).status, "completed");
  const controller = f.controller();
  const pending = f.post({ model, metadata: { mode: "cancel" } }, "responses", controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await bounded(entered.promise, "provider received the canceled request"); controller.abort(); await rejected;
  for (let attempt = 0; closed < 3 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, 3, "stall, trickle and caller cancellation release actual provider responses");
});

function checkpointText(body) { return body.output.at(-1).content.at(-1).text; }
function checkpointFrom(text) {
  const match = /BEGIN_CODEX_ROUTER_CHECKPOINT_V2\n([\s\S]+?)\nEND_CODEX_ROUTER_CHECKPOINT_V2/u.exec(text);
  assert.ok(match, "compaction response contains a Router checkpoint");
  return JSON.parse(match[1]);
}

test("stress: produced tool history survives model switching and repeated compaction", { timeout: 30000 }, async t => {
  let compactions = 0;
  const f = await fixture(t, ({ body }, response) => {
    if (JSON.stringify(body.input).includes("ROUTER SOURCE CATALOG")) {
      compactions += 1;
      const summary = compactions === 1
        ? { objective: "Preserve the synthetic requirement", requirement_refs: ["U001"], attempt_refs: ["C001"], observation_refs: ["R001"], unverified: [], unknowns: [], blockers: ["waiting on fixture"], next_step: "resolve fixture" }
        : { objective: "Preserve the synthetic requirement", requirement_refs: ["U001"], attempt_refs: ["C001"], observation_refs: ["R001"], unverified: [], unknowns: [], blockers: [], next_step: "continue verified work" };
      return responseJson(response, { status: "completed", output: [message(JSON.stringify(summary), `compact_${compactions}`)] });
    }
    if (body.metadata?.stage === "glm")
      return responseJson(response, { status: "completed", output: [message("SYNTHETIC_GLM_OUTPUT", "glm_fixture")] });
    if (body.metadata?.stage === "checkpoint-replay")
      return responseJson(response, { status: "completed", output: [message("checkpoint consumed", "replay_fixture")] });
    const call = { type: "function_call", id: "fc_produced", call_id: "call_produced", name: body.tools[0].name, arguments: "{}" };
    return responseJson(response, { status: "completed", output: [call] });
  });
  const first = await f.post({ tools: tools(), input: "Keep the synthetic requirement." });
  const producedCall = (await first.json()).output[0];
  assert.equal(producedCall.namespace, "fixture");
  const history = [{ role: "user", content: "Keep the synthetic requirement." }, producedCall,
    { type: "function_call_output", call_id: producedCall.call_id, output: "SYNTHETIC_TOOL_RESULT" }];
  const switched = await f.post({ model: GLM, tools: tools(), input: history, metadata: { stage: "glm" } });
  const producedMessage = (await switched.json()).output[0];
  assert.equal(producedMessage.content[0].text, "SYNTHETIC_GLM_OUTPUT");
  const switchedBody = f.seen.at(-1).body;
  const switchedCall = switchedBody.input.find(item => item.type === "function_call");
  const switchedResult = switchedBody.input.find(item => item.type === "function_call_output");
  assert.equal(switchedCall.name, "fixture__inspect");
  assert.equal(switchedCall.namespace, undefined);
  assert.equal(switchedCall.call_id, producedCall.call_id);
  assert.equal(switchedResult.call_id, switchedCall.call_id);
  assert.equal(switchedResult.output, "SYNTHETIC_TOOL_RESULT");
  assert.ok(switchedBody.tools.some(tool => tool.name === switchedCall.name));
  const firstCompact = await f.post({ model: GLM, input: [...history, producedMessage] }, "responses/compact");
  assert.equal(firstCompact.status, 200);
  const firstText = checkpointText(await firstCompact.json());
  const firstCheckpoint = checkpointFrom(firstText);
  assert.deepEqual(firstCheckpoint.orientation.blockers, ["waiting on fixture"]);
  assert.ok(firstCheckpoint.sources.R001.excerpt.includes("SYNTHETIC_TOOL_RESULT"));
  const secondCompact = await f.post({ model: GLM, input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: firstText }] },
    { role: "user", content: "The fixture is resolved; retain the requirement and evidence." },
  ] }, "responses/compact");
  assert.equal(secondCompact.status, 200);
  const secondText = checkpointText(await secondCompact.json());
  const secondCheckpoint = checkpointFrom(secondText);
  assert.deepEqual(secondCheckpoint.orientation.blockers, []);
  assert.equal(secondCheckpoint.orientation.next_step, "continue verified work");
  assert.ok(secondCheckpoint.source_refs.requirements.includes("U001"));
  assert.ok(secondCheckpoint.source_refs.observations.includes("R001"));
  assert.equal(compactions, 2);
  const replay = await f.post({ model: GLM, metadata: { stage: "checkpoint-replay" }, input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: secondText }] },
  ] });
  assert.equal(replay.status, 200);
  await replay.arrayBuffer();
  const replayedInput = JSON.stringify(f.seen.at(-1).body.input);
  assert.match(replayedInput, /Preserve the synthetic requirement/u);
  assert.match(replayedInput, /SYNTHETIC_TOOL_RESULT/u);
});

test("stress: concurrent requests isolate a healthy turn and cancel stalled work", { timeout: 25000 }, async t => {
  const stalled = deferred(), streaming = deferred();
  const stalledReceived = deferred(), stalledClosed = deferred(), streamingClosed = deferred();
  const f = await fixture(t, async ({ body }, response) => {
    const scenario = body.metadata?.scenario;
    if (scenario === "stalled") {
      response.once("close", stalledClosed.resolve);
      stalledReceived.resolve();
      await stalled.promise; return;
    }
    if (scenario === "streaming") {
      response.once("close", streamingClosed.resolve);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(frame({ type: "response.output_text.delta", delta: "stream started" }));
      await streaming.promise; return;
    }
    responseJson(response, { status: "completed", output: [message("healthy isolated response")] });
  });
  t.after(() => { stalled.resolve(); streaming.resolve(); });
  const stalledController = f.controller();
  const stalledRequest = f.post({ metadata: { scenario: "stalled" } }, "responses", stalledController.signal);
  const stalledRejected = assert.rejects(stalledRequest, { name: "AbortError" });
  await bounded(stalledReceived.promise, "stalled request reaches provider");
  const healthy = await bounded(f.post({ metadata: { scenario: "healthy" } }), "healthy request beside stall");
  assert.equal(healthy.status, 200); assert.match(await healthy.text(), /healthy isolated response/u);
  stalledController.abort(); await stalledRejected;
  await bounded(stalledClosed.promise, "stalled upstream closes");
  stalled.resolve();
  const streamController = f.controller();
  const streamed = await f.post({ stream: true, metadata: { scenario: "streaming" } }, "responses", streamController.signal);
  const reader = streamed.body.getReader();
  assert.match(Buffer.from((await bounded(reader.read(), "stream starts")).value).toString(), /stream started/u);
  streamController.abort(); await assert.rejects(reader.read(), { name: "AbortError" });
  await bounded(streamingClosed.promise, "streaming upstream closes");
  streaming.resolve();
  assert.equal(f.seen.filter(({ body }) => body.metadata?.scenario === "stalled").length, 1);
  assert.equal(f.seen.filter(({ body }) => body.metadata?.scenario === "streaming").length, 1);
});

test("Router keeps original snapshots and uncertain outcomes without replay on both profiles", { timeout: 30000 }, async t => {
  const original = message("ORIGINAL_漢🙂");
  const completed = output => ({ type: "response.completed", response: { status: "completed", output } });
  const cases = new Map([
    ["generic", `event: message\ndata: ${JSON.stringify(completed([original]))}\n\n`],
    ["done", `data: ${JSON.stringify({ ...completed([original]), type: "response.done" })}\n\n`],
    ["failed", frame({ type: "response.completed", response: { status: "failed", error: { message: "ORIGINAL_FAILURE" }, output: [] } })],
    ["incomplete", frame({ type: "response.completed", response: { status: "incomplete", output: [] } })],
    ["duplicate", 'data: {"type":"response.completed","response":{"status":"failed","sta\\u0074us":"completed","output":[]}}\n\n'],
    ["conflict", 'event: response.completed\ndata: {"type":"response.failed","response":{"status":"failed","output":[]}}\n\n'],
    ["lossy", 'data: {"type":"response.completed","sequence_number":18446744073709551615,"response":{"status":"completed","output":[]}}\n\n'],
    ["malformed", 'event: response.completed\ndata: {"type":"response.completed",\n\n'],
    ["utf8", Buffer.concat([Buffer.from('data: {"type":"response.completed","response":{"status":"completed","output":[],"id":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}\n\n')])],
    ["empty", frame(completed([]))],
    ["ordinary", frame(completed([original]))],
  ]);
  const attempts = new Map(), requests = new Map();
  const f = await fixture(t, ({ body }, response) => {
    const label = /VERDICT_TEST:([a-z0-9-]+)/u.exec(JSON.stringify(body.input))[1];
    const scenario = label.split("-").at(-1);
    const count = (attempts.get(label) || 0) + 1;
    attempts.set(label, count);
    requests.set(label, [...(requests.get(label) || []), body]);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const reasoning = label.includes("-released-") ? frame({ type: "response.reasoning_summary_text.delta", delta: "visible progress" }) : "";
    response.end(Buffer.concat([Buffer.from(reasoning), Buffer.from(count === 1 ? cases.get(scenario)
      : frame(completed([message("REPAIRED_CONTROL")]))), Buffer.from("data: [DONE]\n\n")]));
  }, { CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1" });
  for (const [profile, model] of [["direct", PARETO], ["translated", GLM]]) {
    for (const released of [false, true]) for (const scenario of cases.keys()) {
      const label = `${profile}-${released ? "released" : "held"}-${scenario}`;
      const response = await f.post({ model, stream: true, input: `VERDICT_TEST:${label}` });
      const wire = await response.text();
      assert.equal(response.status, 200, `${label}: ${wire}`);
      assert.equal(attempts.get(label), scenario === "empty" && !released ? 2 : 1, label);
      if (scenario === "empty" && !released) {
        assert.match(wire, /REPAIRED_CONTROL/u);
        assert.deepEqual(requests.get(label)[0], requests.get(label)[1], "quiet repair preserves the provider payload");
      } else {
        assert.doesNotMatch(wire, /REPAIRED_CONTROL/u, label);
        if (scenario === "empty") {
          assert.match(wire, /empty_completion/u, "reasoning release retains the existing no-replay error");
          assert.doesNotMatch(wire, /response\.completed/u, "empty success is held after reasoning release");
        }
        if (["generic", "done", "ordinary"].includes(scenario)) assert.match(wire, /ORIGINAL_漢🙂/u, label);
        if (scenario === "failed") assert.match(wire, /ORIGINAL_FAILURE/u, label);
      }
    }
  }
  const native = await f.post({ model: "gpt-6.1-sol", stream: true, input: "VERDICT_TEST:native-generic" });
  assert.match(await native.text(), /ORIGINAL_漢🙂/u);
  assert.equal(attempts.get("native-generic"), 1);
});

test("compaction validates raw provider envelopes before checkpoint fallback on both profiles and versions", { timeout: 30000 }, async t => {
  const summary = JSON.stringify([message("A completed summary may miss the checkpoint schema.")]);
  const cases = new Map([
    ["completed", `{"status":"completed","output":${summary}}`],
    ["legacy", `{"output":${summary}}`],
    ["empty", '{"status":"completed","output":[]}'],
    ["null-status", `{"status":null,"output":${summary}}`],
    ["boolean-status", `{"status":false,"output":${summary}}`],
    ["object-status", `{"status":{},"output":${summary}}`],
    ["duplicate-status", `{"status":"failed","sta\\u0074us":"completed","output":${summary}}`],
    ["duplicate-error", `{"status":"completed","error":{"message":"failure"},"err\\u006fr":null,"output":${summary}}`],
    ["duplicate-output", `{"status":"completed","output":[],"out\\u0070ut":${summary}}`],
    ["lossy", `{"status":"completed","output":${summary},"usage":{"input_tokens":18446744073709551615,"output_tokens":1}}`],
    ["malformed", '{"status":"completed","output":'],
    ["utf8", Buffer.concat([Buffer.from('{"status":"completed","output":[],"id":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])],
    ["failed", `{"status":"failed","output":${summary}}`],
    ["incomplete", `{"status":"incomplete","output":${summary}}`],
  ]);
  const f = await fixture(t, ({ body }, response) => {
    const scenario = /COMPACT_TEST:([a-z0-9-]+)/u.exec(JSON.stringify(body.input))[1];
    assert.equal(body.stream, false);
    assert.equal(body.tools?.length || 0, 0, "compaction remains tool-free");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(cases.get(scenario));
  });
  for (const model of [PARETO, GLM]) for (const endpoint of ["responses/compact", "responses"]) {
    for (const scenario of cases.keys()) {
      const before = f.seen.length;
      const input = [{ role: "user", content: `COMPACT_TEST:${scenario}` },
        ...(endpoint === "responses" ? [{ type: "compaction_trigger" }] : [])];
      const response = await f.post({ model, stream: false, input }, endpoint);
      const result = await response.json();
      const admitted = ["completed", "legacy", "empty"].includes(scenario);
      assert.equal(response.status, admitted ? 200 : 502, `${model}/${endpoint}/${scenario}: ${JSON.stringify(result)}`);
      assert.equal(f.seen.length, before + 1, "compaction makes one provider call");
      if (admitted) {
        if (endpoint === "responses") {
          assert.equal(result.output[0].type, "compaction");
          assert.match(result.output[0].encrypted_content, /^kcr2:/u);
        } else assert.match(checkpointText(result), /BEGIN_CODEX_ROUTER_CHECKPOINT_V2/u,
          "only admitted envelopes get deterministic checkpoint fallback");
      } else {
        assert.equal(result.error.code, scenario === "failed" ? "compaction_failed"
          : scenario === "incomplete" ? "compaction_incomplete" : "compaction_invalid_response");
        assert.doesNotMatch(JSON.stringify(result), /BEGIN_CODEX_ROUTER_CHECKPOINT_V2/u);
        assert.equal(result.usage, undefined, "rejected ambiguous usage is not accepted");
      }
    }
  }
  for (const model of [PARETO, GLM]) for (const scenario of ["completed", "duplicate-status"]) {
    const before = f.seen.length;
    const response = await f.post({ model, stream: true, input: [
      { role: "user", content: `COMPACT_TEST:${scenario}` }, { type: "compaction_trigger" },
    ] });
    const wire = await response.text();
    assert.equal(response.status, scenario === "completed" ? 200 : 502);
    assert.equal(f.seen.length, before + 1);
    if (scenario === "completed") {
      assert.match(wire, /"type":"compaction"/u);
      assert.match(wire, /"encrypted_content":"kcr2:/u);
      assert.match(wire, /response\.completed/u);
    } else {
      assert.equal(JSON.parse(wire).error.code, "compaction_invalid_response");
      assert.doesNotMatch(wire, /kcr2:|response\.completed/u);
    }
  }
});

test("both GLM routes preserve visible fallback and fail after lifecycle reordering commits", { timeout: 20000 }, async t => {
  const visible = { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg", delta: "VISIBLE_漢🙂" };
  const open = { type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", role: "assistant", content: [] } };
  const close = { type: "response.output_item.done", output_index: 0, item: message(visible.delta, "msg") };
  const completed = { type: "response.completed", response: { id: "resp_glm", status: "completed", output: [] } };
  const hidden = [open, visible,
    { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "msg", part: { type: "output_text", text: "HIDDEN_FIXTURE", reasoning: "PRIVATE_FIXTURE" } },
    { ...close, item: { ...close.item, content: [{ type: "reasoning_text", reasoning: "PRIVATE_FIXTURE" }] } }, completed].map(frame).join("");
  const held = [
    { type: "response.output_item.added", output_index: 1, item: { id: "fc", type: "function_call", call_id: "call", name: "lookup", arguments: "" } },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc", call_id: "call", name: "lookup", arguments: "{}" },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc", type: "function_call", call_id: "call", name: "lookup", arguments: "{}" } },
  ];
  const ambiguous = 'data: {"type":"response.output_text.delta","item_id":"late","delta":"A","delt\\u0061":"B"}\n\n';
  const reordered = [open, visible, ...held, close].map(frame).join("") + ambiguous + frame(completed);
  const f = await fixture(t, ({ body }, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(JSON.stringify(body.input).includes("GLM_TEST:hidden") ? hidden : reordered);
  }, { CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1" });
  for (const model of [GLM, GLM_TOGETHER]) for (const scenario of ["hidden", "order"]) {
    const before = f.seen.length;
    const response = await f.post({ model, stream: true, input: `GLM_TEST:${scenario}`,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] });
    const wire = await response.text();
    assert.equal(response.status, 200);
    assert.equal(f.seen.length, before + 1, `${model}/${scenario} never replays`);
    assert.match(wire, /VISIBLE_漢🙂/u);
    if (scenario === "hidden") {
      assert.doesNotMatch(wire, /HIDDEN_FIXTURE|PRIVATE_FIXTURE/u);
      const done = eventsFrom(wire).find(event => event.type === "response.output_item.done");
      assert.equal(done.item.content[0].text, visible.delta);
      assert.equal(done.item.phase, "final_answer");
    } else {
      assert.match(wire, /local_router_stream_failed/u);
      assert.doesNotMatch(wire, /response\.completed/u);
      assert.ok(!wire.includes(ambiguous), "unsafe tail is not forwarded after order repair");
      assert.deepEqual(eventsFrom(wire).filter(event => event.output_index !== undefined).slice(0, 6)
        .map(event => event.output_index), [0, 0, 0, 1, 1, 1]);
    }
  }
});
