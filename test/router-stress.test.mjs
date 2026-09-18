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
const GLM = "openrouter/glm-5.3-flash";
const GLM_GMICLOUD = "openrouter/glm-5.3-flash-gmicloud";
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

test("stress: representative routes preserve their distinct boundaries", { timeout: 20000 }, async t => {
  const f = await fixture(t, ({ body }, response) => responseJson(response, {
    id: `resp_${body.model}`, status: "completed", output: [message(`control:${body.model}`)],
  }));
  for (const [model, extra] of [
    ["gpt-5.6-sol", { input: "native control" }],
    [GLM, { input: "gateway control" }],
    [GLM, { tools: [{ type: "web_search" }], tool_choice: { type: "web_search" }, input: "hosted search control" }],
    [GLM_GMICLOUD, { tools: [{ type: "web_search" }], tool_choice: { type: "web_search" }, input: "hosted search control" }],
    [PARETO, { input: "direct responses control" }],
    [SWITCHYARD, { input: "switchyard control" }],
  ]) {
    const response = await f.post({ model, ...extra });
    const responseBody = await response.arrayBuffer();
    assert.equal(response.status, 200, Buffer.from(responseBody).toString());
  }
  const [nativeSeen, gatewaySeen, novitaSeen, gmiSeen, paretoSeen, switchyardSeen] = f.seen;
  assert.equal(nativeSeen.path, "/backend-api/codex/responses");
  assert.equal(nativeSeen.body.model, "gpt-5.6-sol");
  assert.equal(nativeSeen.headers.authorization, "Bearer SYNTHETIC_NATIVE_PRIVATE");
  assert.equal(gatewaySeen.body.model, "openrouter-glm-5-3-flash");
  assert.equal(novitaSeen.body.model, "z-ai/glm-5.3-flash");
  assert.deepEqual(novitaSeen.body.provider.only, ["novita"]);
  assert.deepEqual(gmiSeen.body.provider.only, ["gmicloud"]);
  assert.equal(paretoSeen.body.model, "unbiased/pareto");
  assert.deepEqual(paretoSeen.body.provider.only, ["unbiased"]);
  for (const external of [gatewaySeen, novitaSeen, gmiSeen, paretoSeen])
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
  assert.equal(terminalOutcome(eventsFrom(frame({ type: "response.output_text.delta", delta: "known-bad EOF" }))), false);
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
  for (let attempt = 0; attempt < 100 && !f.errors().includes("empty_function_arguments"); attempt += 1)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.errors(), /empty_function_arguments/u);
  assert.ok(f.errors().includes(`"sourceCharacters":0,"restoredCharacters":0,"deltaCharacters":${privateArgs.length},"doneCharacters":${privateArgs.length}`));
  for (const sentinel of PRIVATE_SENTINELS) assert.ok(!f.errors().includes(sentinel));
  assert.equal(f.seen.length, 4);
});

test("stress: retryable status attempts are bounded and preserve request identity", { timeout: 20000 }, async t => {
  const f = await fixture(t, ({ body }, response) => {
    const status = body.metadata.status;
    response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "7" });
    response.end(JSON.stringify({ error: { message: `Synthetic provider HTTP ${status}` } }));
  });
  for (const [status, attempts] of [[429, 1], [504, 2]]) {
    const before = f.seen.length;
    const response = await f.post({ metadata: { status } });
    assert.equal(response.status, status); assert.equal(response.headers.get("retry-after"), "7");
    assert.ok((await response.json()).error); assert.equal(f.seen.length - before, attempts);
    for (const attempt of f.seen.slice(before)) assert.deepEqual(attempt.body, f.seen[before].body);
  }
});

test("stress: caller cancellation during provider backoff prevents a duplicate attempt", { timeout: 20000 }, async t => {
  const answered = deferred();
  const attempts = new Map();
  const f = await fixture(t, ({ body }, response) => {
    const scenario = body.metadata?.scenario;
    const attempt = (attempts.get(scenario) || 0) + 1;
    attempts.set(scenario, attempt);
    if (scenario === "positive-control" && attempt === 2) {
      return responseJson(response, {
        id: "resp_retry_control", status: "completed", output: [message("retried")],
      });
    }
    response.writeHead(504, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "synthetic retryable response" } }));
    if (scenario === "cancel-during-backoff") answered.resolve();
  }, { CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS: "40" });
  const controller = f.controller();
  const request = f.post({ metadata: { scenario: "cancel-during-backoff" } }, "responses", controller.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  await bounded(answered.promise, "first retryable response returned");
  await setImmediate();
  controller.abort();
  await rejected;
  // Observe beyond the configured retry window. A broken cancellation path
  // would have reached the provider again by now.
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(attempts.get("cancel-during-backoff"), 1);
  const control = await f.post({ metadata: { scenario: "positive-control" } });
  assert.equal(control.status, 200);
  await control.arrayBuffer();
  assert.equal(attempts.get("positive-control"), 2);
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

test("stress: a missing lifecycle event times out without background polling", async () => {
  const eventThatNeverArrives = deferred();
  await assert.rejects(
    bounded(eventThatNeverArrives.promise, "negative-control missing close", 25),
    /Timed out: negative-control missing close/u,
  );
  await setImmediate();
});
