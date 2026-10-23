import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { decodeCompaction } from "../src/compaction-checkpoint.mjs";
import { SseFrameBuffer, sseFrameFields } from "../src/sse-framing.mjs";
import { openPort } from "./port-pool.mjs";
import { launch, ready, stop } from "./router-fixture.mjs";

// Set both homes before importing stateful owners. No test reads the signed-in
// user's bridge, Codex configuration, browser profile, or provider credentials.
const state = mkdtempSync(path.join(os.tmpdir(), "router-web-"));
process.env.CODEX_HOME = path.join(state, "codex");
process.env.MODEL_ROUTER_STATE_DIR = state;
mkdirSync(process.env.CODEX_HOME);
const web = await import("../src/chatgpt-web.mjs");
const settingsPath = path.join(state, "chatgpt-web.json");
after(() => rmSync(state, { recursive: true, force: true }));

const allCapabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };
const callerKey = "web-fixture-caller-capability-long-enough";
const model = "chatgpt-web/gpt-6-sol";
const completed = { id: "resp_web", status: "completed", output: [
  { id: "fc_web", type: "custom_tool_call", call_id: "call_web", name: "functions.apply_patch", input: "*** Begin Patch\n*** End Patch" },
] };

function saveSettings({ enabled = true, capabilities = allCapabilities, directory = state, ...extra } = {}) {
  const runtimeModule = path.join(directory, "inert-browser-runtime.mjs");
  const executable = path.join(directory, "inert-tunnel-client.exe");
  writeFileSync(runtimeModule, 'throw new Error("This fixture must not execute the browser runtime.");\n', "utf8");
  writeFileSync(executable, "Synthetic tunnel path; never execute.\n", "utf8");
  writeFileSync(path.join(directory, "chatgpt-web.json"), JSON.stringify({ version: 1, enabled, capabilities,
    browser: { runtimeModule, pluginName: "Router local tools", pluginAppId: "asdk_app_fixture", pluginSelectionButtonName: "Router local tools, Connectors" },
    tunnel: { id: "tunnel_fixture", executable }, ...extra }));
}

async function listener(t, handle) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const observed = { request, response, path: request.url, method: request.method, headers: request.headers,
      payload: bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined };
    requests.push(observed);
    try { await handle(observed); }
    catch (error) { response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, requests, port: server.address().port, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function json(response, value, status = 200, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

async function routerFixture(t, handle, options = {}) {
  const bridge = await listener(t, handle);
  const native = await listener(t, ({ response }) => json(response, { error: "unexpected native request" }, 500));
  const directory = mkdtempSync(path.join(state, "http-"));
  const codexHome = path.join(directory, "codex");
  mkdirSync(codexHome);
  const { realRuntime = false, runtimeStates = [], ...settings } = options;
  saveSettings({ directory, ...settings, ...(realRuntime ? { enabled: false } : {}) });
  // Replace only the in-app runtime dependency. The real Router and settings
  // owner still validate and dispatch the ordinary request. Browser scheduling,
  // native tool execution and compaction have their own real-runtime coverage.
  const runtimeStub = path.join(directory, "runtime-stub.mjs"), preload = path.join(directory, "preload.mjs");
  writeFileSync(runtimeStub, `let maintenance = {activeTurns:0,uncertainSends:0,unresolvedActions:0};
  const states = ${JSON.stringify(runtimeStates)};
  export function inAppWebMaintenanceState() { return {...maintenance}; }
  export function startInAppWebBridge() {}\nexport function closeInAppWebBridge() {}\nexport async function requestInAppWebBridge(payload, {compact, compactV2, signal, headers}) {
    const response = await fetch(${JSON.stringify(bridge.baseUrl)} + (compact ? '/compact' : '/request'), {method:'POST',signal,
      headers:{...headers,'x-fixture-compact-v2':String(compactV2)},body:JSON.stringify(payload)});
    maintenance = states.shift() ?? maintenance;
    return response;
  }\n`, "utf8");
  writeFileSync(preload, `import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier, context, nextResolve) { const result=nextResolve(specifier,context);
      return result.url===${JSON.stringify(pathToFileURL(path.resolve("src/web-runtime.mjs")).href)}
        ? {url:${JSON.stringify(pathToFileURL(runtimeStub).href)},shortCircuit:true} : result; }});\n`, "utf8");
  const catalog = path.join(directory, "native-models.json");
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", supported_reasoning_levels: ["medium", "high"] }] }));
  const port = await openPort();
  const child = launch("router.mjs", {
    CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: directory,
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: callerKey,
    CODEX_ROUTER_INTERNAL_KEY: "web-fixture-internal-capability-long-enough",
    CODEX_ROUTER_CATALOG: catalog, CODEX_ROUTER_QUIET: "1",
    CODEX_NATIVE_BASE_URL: native.baseUrl.replace(/\/v1$/u, ""),
    CODEX_ROUTER_API_BASE_URL: native.baseUrl, CODEX_ROUTER_GATEWAY_BASE_URL: native.baseUrl,
  }, { nodeArgs: realRuntime ? [] : ["--import", pathToFileURL(preload).href] });
  t.after(() => stop(child));
  await ready(`http://127.0.0.1:${port}/live`, child);
  if (realRuntime) saveSettings({ directory, ...settings });
  return { bridge, native, port, directory, child, url: callerBaseUrl(port, callerKey),
    post: (payload, suffix = "/responses", headers = {}, fetchOptions = {}) => fetch(`${callerBaseUrl(port, callerKey)}${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), ...fetchOptions,
    }) };
}

test("Router defers drain for Web work created by an admitted HTTP round and during its native-tool gap", async t => {
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  let calls = 0;
  const fixture = await routerFixture(t, async ({ response }) => {
    if (++calls === 1) { started.resolve(); await released.promise; }
    json(response, completed);
  }, { runtimeStates: [
    { activeTurns: 1, uncertainSends: 0, unresolvedActions: 0 },
    { activeTurns: 0, uncertainSends: 0, unresolvedActions: 0 },
  ] });
  const lifecycle = (operation = "", body) => fetch(`http://127.0.0.1:${fixture.port}/internal/lifecycle${operation ? `/${operation}` : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer web-fixture-internal-capability-long-enough", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = fixture.post({ model, input: [] });
  await started.promise;
  const draining = lifecycle("drain", { timeout_ms: 1_000 });
  let state;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    state = await (await lifecycle()).json();
    if (state.state === "draining") break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(state.state, "draining");
  released.resolve();
  assert.equal((await response).status, 200);
  const result = await draining;
  assert.equal(result.status, 409);
  const deferred = await result.json();
  assert.equal(deferred.reason, "web-workflow-active");
  assert.equal(deferred.activeRequests, 0);
  assert.equal(deferred.webRuntime.activeTurns, 1);
  assert.equal(deferred.state, "open");
  assert.equal((await lifecycle("drain", { timeout_ms: 1_000 })).status, 409);
  assert.equal((await fixture.post({ model, input: [{ role: "user", content: "Continue the native tool round." }] })).status, 200);
  const finished = await lifecycle("drain", { timeout_ms: 1_000 });
  assert.equal(finished.status, 200);
  assert.equal((await finished.json()).status, "drained");
});

test("Web compact forwards canonical header-only turn metadata without native credentials", async t => {
  const metadata = JSON.stringify({ thread_id: "synthetic-thread", turn_id: "synthetic-turn" });
  const fixture = await routerFixture(t, ({ response }) => json(response, { output: [{ type: "compaction", encrypted_content: "bridge-checkpoint" }] }));
  const response = await fixture.post({ model, input: [{ role: "user", content: "compact this task" }] }, "/responses/compact", {
    "x-codex-turn-metadata": metadata, Authorization: "Bearer private-native-credential",
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.bridge.requests[0].headers["x-codex-turn-metadata"], metadata);
  assert.equal(fixture.bridge.requests[0].headers.authorization, undefined);
  assert.equal(fixture.bridge.requests[0].payload.client_metadata, undefined);
});

test("Web child effort overrides apply only to child turns and invalid saved effort fails before sending", async t => {
  const fixture = await routerFixture(t, ({ response }) => json(response, { output: [] }));
  const settings = { version: 2, mode: "proven", enabled: [], disabled: [], efforts: { [model]: "xhigh" } };
  writeFileSync(path.join(fixture.directory, "multi-agent-settings.json"), JSON.stringify(settings));
  const payload = { model, input: [], reasoning: { effort: "medium" } };
  let response = await fixture.post(payload);
  assert.equal(response.status, 200);
  assert.equal(fixture.bridge.requests[0].payload.reasoning.effort, "medium");
  response = await fixture.post(payload, "/responses", { "x-openai-subagent": "1" });
  assert.equal(response.status, 200);
  assert.equal(fixture.bridge.requests[1].payload.reasoning.effort, "xhigh");
  settings.efforts[model] = "ultra";
  writeFileSync(path.join(fixture.directory, "multi-agent-settings.json"), JSON.stringify(settings));
  response = await fixture.post(payload, "/responses", { "x-openai-subagent": "1" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "unsupported_reasoning_effort");
  assert.equal(fixture.bridge.requests.length, 2);
  assert.equal(fixture.native.requests.length, 0);
});

test("missing settings are disabled, persisted model lists cannot invent availability, and corrupt settings fail closed", () => {
  rmSync(settingsPath, { force: true });
  assert.equal(web.readWebBridgeSettings().enabled, false);
  assert.deepEqual(web.webBridgeModels(), []);
  saveSettings({ capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false },
    models: [{ slug: "chatgpt-web/anything", displayName: "invented" }] });
  assert.equal(web.webBridgeModels().some(row => row.slug.endsWith("anything")), false);
  assert.equal(web.webBridgeModels().some(row => row.slug.endsWith("pro")), false);
  writeFileSync(settingsPath, "not json");
  assert.throws(() => web.readWebBridgeSettings(), /invalid state/u);
});

test("Router forwards tools, history, exact selected effort and safe turn identity without native or Router credentials", async t => {
  const metadata = JSON.stringify({ thread_id: "fixture-thread", turn_id: "fixture-turn" });
  const payload = { model, stream: false, input: [
    { role: "user", content: "Edit the file" },
    { type: "function_call", name: "functions.exec", call_id: "call_previous", arguments: "{}" },
    { type: "function_call_output", call_id: "call_previous", output: "prior result" },
  ], tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch",
    description: "Patch files", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] }],
  previous_response_id: "resp_previous", client_metadata: { "x-codex-turn-metadata": metadata, custom: "retained" },
  reasoning: { effort: "high", summary: "auto" }, context_management: [{ type: "compaction", compact_threshold: 12000 }],
  parallel_tool_calls: false, store: false };
  const fixture = await routerFixture(t, ({ response }) => json(response, completed, 200, { "set-cookie": "private=session" }));
  const response = await fixture.post(payload, "/responses", {
    authorization: "Bearer native-secret", "chatgpt-account-id": "native-account", "openai-organization": "native-org",
    "x-openai-internal-codex-residency": "us", "x-api-key": "private-router-key", "x-codex-router-key": "private-capability",
    "x-codex-thread-id": "fixture-thread", "x-codex-turn-id": "fixture-turn", "x-codex-client-metadata": "safe-metadata",
    "x-codex-parent-thread-id": "fixture-parent", session_id: "fixture-session", "session-id": "fixture-session",
    "x-codex-session-id": "fixture-session", "x-codex-turn-metadata": metadata,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completed);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(fixture.bridge.requests.length, 1);
  assert.deepEqual(fixture.bridge.requests[0].payload, payload);
  const headers = fixture.bridge.requests[0].headers;
  for (const name of ["authorization", "chatgpt-account-id", "openai-organization", "x-openai-internal-codex-residency", "x-api-key", "x-codex-router-key",
    "x-codex-thread-id", "x-codex-turn-id", "x-codex-parent-thread-id", "x-codex-client-metadata", "x-codex-session-id", "session_id", "session-id"]) {
    assert.equal(headers[name], undefined, `${name} must not reach the browser service`);
  }
  assert.equal(headers["x-codex-turn-metadata"], metadata);
  assert.equal(fixture.native.requests.length, 0);
});

test("Router supplies only the selected model's default effort and relays SSE without rewriting custom tools", async t => {
  const events = `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: completed.output[0] })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;
  const fixture = await routerFixture(t, ({ response }) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(events); });
  const payload = { model: "chatgpt-web/gpt-6-pro", stream: true, input: [], reasoning: { summary: "auto" } };
  const response = await fixture.post(payload);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), events);
  assert.deepEqual(fixture.bridge.requests[0].payload, { ...payload, reasoning: { summary: "auto", effort: "max" } });
  assert.equal(fixture.bridge.requests[0].headers.accept, "text/event-stream");
  assert.equal(fixture.native.requests.length, 0);
});

test("real compact route preserves the bridge's compaction envelope and history", async t => {
  const result = { output: [{ type: "compaction", id: "compact_web", encrypted_content: "bridge-local-checkpoint" }] };
  const fixture = await routerFixture(t, ({ response }) => json(response, result));
  const payload = { model, reasoning: { effort: "medium" }, input: [
    { role: "user", content: "Keep this requirement" }, { type: "function_call_output", call_id: "call_file", output: "file content" },
  ], previous_response_id: "resp_before_compact", instructions: "Preserve constraints", tools: [{ type: "custom", name: "apply_patch" }] };
  const response = await fixture.post(payload, "/responses/compact");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(fixture.bridge.requests[0].path, "/v1/compact");
  assert.deepEqual(fixture.bridge.requests[0].payload, payload);
  assert.equal(fixture.native.requests.length, 0);
});

test("ordinary Web V2 compaction reaches the actual in-app backend without browser execution or service startup", async t => {
  const fixture = await routerFixture(t, ({ response }) => json(response, { error: "unexpected runtime stub request" }, 500), { realRuntime: true });
  const runtimeModule = path.join(fixture.directory, "inert-browser-runtime.mjs");
  const executable = path.join(fixture.directory, "inert-tunnel-client.exe");
  writeFileSync(runtimeModule, 'throw new Error("Compaction must not import the browser runtime.");\n', "utf8");
  writeFileSync(executable, "Synthetic tunnel path; compaction must never execute it.\n", "utf8");
  // Startup owns service activation. Flip only this isolated fixture after /live
  // so this regression observes compaction, independently of startup behavior.
  saveSettings({ directory: fixture.directory,
    browser: { runtimeModule, pluginName: "Router local tools", pluginAppId: "asdk_app_fixture", pluginSelectionButtonName: "Router local tools, Connectors" },
    tunnel: { id: "tunnel_fixture", executable } });
  const metadata = JSON.stringify({ thread_id: "22222222-2222-4222-8222-222222222222", turn_id: "33333333-3333-4333-8333-333333333333" });
  const input = [
    { role: "user", content: "Keep the fixture requirement unchanged." },
    { type: "function_call", call_id: "call_compact_fixture", name: "read", arguments: '{"path":"fixture.txt"}' },
    { type: "function_call_output", call_id: "call_compact_fixture", output: "Actual fixture tool result." },
    { type: "compaction_trigger" },
  ];
  for (const stream of [false, true]) await t.test(stream ? "SSE" : "JSON", async () => {
    // No executor or tools are declared: an erroneous generation dispatch must
    // reject at discovery, before cancellation monitoring or MCP/tunnel startup.
    const response = await fixture.post({ model, input, stream }, "/responses", { "x-codex-turn-metadata": metadata });
    const wire = await response.text();
    assert.equal(response.status, 200, wire);
    let output;
    if (stream) {
      assert.match(response.headers.get("content-type"), /text\/event-stream/u);
      const frames = new SseFrameBuffer(), events = [];
      let done = 0;
      for (const frame of frames.write(Buffer.from(wire))) {
        const fields = sseFrameFields(frame.bytes, frame.atStreamStart);
        if (fields.data === "[DONE]") { done += 1; continue; }
        if (!fields.hasData) continue;
        const event = JSON.parse(fields.data);
        assert.equal(fields.eventName, event.type);
        events.push(event);
      }
      assert.equal(frames.pendingBytes, 0);
      assert.equal(done, 1);
      const items = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
      const terminal = events.filter(event => event.type === "response.completed");
      assert.equal(terminal.length, 1);
      output = terminal[0].response.output;
      assert.deepEqual(items.filter(item => item.type === "compaction"), output.filter(item => item.type === "compaction"));
      assert.equal(items.some(item => ["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)), false);
    } else {
      assert.match(response.headers.get("content-type"), /application\/json/u);
      const body = JSON.parse(wire);
      assert.equal(body.object, "response");
      assert.equal(body.status, "completed");
      output = body.output;
    }
    const compacted = output.filter(item => item.type === "compaction");
    assert.equal(compacted.length, 1);
    assert.equal(typeof compacted[0].encrypted_content, "string");
    const retained = JSON.stringify(decodeCompaction(compacted[0].encrypted_content));
    assert.match(retained, /Keep the fixture requirement unchanged/u);
    assert.match(retained, /Actual fixture tool result/u);
    assert.equal(output.some(item => ["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)), false);
    assert.equal(fixture.bridge.requests.length, 0);
    assert.equal(fixture.native.requests.length, 0);
    assert.equal(existsSync(path.join(fixture.directory, "web-in-app")), false);
    assert.equal(existsSync(path.join(fixture.directory, "chatgpt-web-runtime-key.secret")), false);
  });
});

test("Web model requests retain public Router authentication even while the bridge is enabled", async t => {
  const fixture = await routerFixture(t, ({ response }) => json(response, completed));
  const response = await fetch(`http://127.0.0.1:${fixture.port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: [] }),
  });
  assert.equal(response.status, 401);
  await response.arrayBuffer();
  assert.equal(fixture.bridge.requests.length, 0);
  assert.equal(fixture.native.requests.length, 0);
});

test("unavailable models, aliases and unsupported efforts reject without a backend fallback", async t => {
  const fixture = await routerFixture(t, ({ response }) => json(response, completed), {
    capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false },
  });
  for (const payload of [{ model: "chatgpt-web/gpt-6-pro" }, { model: "chatgpt-web/sol" },
    { model, reasoning: { effort: "xhigh" } }, { model: "chatgpt-web/gpt-6-sol-instant", reasoning: { effort: "high" } }]) {
    const response = await fixture.post({ input: [], ...payload });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  saveSettings({ directory: fixture.directory, enabled: false });
  const disabled = await fixture.post({ model, input: [] });
  assert.equal(disabled.status, 409);
  await disabled.arrayBuffer();
  assert.equal(fixture.bridge.requests.length, 0);
  assert.equal(fixture.native.requests.length, 0);
});

test("bridge quota and encrypted V2 rejection pass through exactly once without native inference", async t => {
  const fixture = await routerFixture(t, ({ payload, response }) => {
    if (payload.input[0]?.type === "compaction") json(response, { error: { code: "encrypted_v2_unsupported", message: "Use V1" } }, 422);
    else json(response, { error: { code: "chatgpt_limit", message: "Web allowance reached" } }, 429, { "retry-after": "60" });
  });
  const limited = await fixture.post({ model, input: [] });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await limited.json(), { error: { code: "chatgpt_limit", message: "Web allowance reached" } });
  const encrypted = { model, input: [{ type: "compaction", encrypted_content: "opaque-native-handoff" }] };
  const rejected = await fixture.post(encrypted);
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: { code: "encrypted_v2_unsupported", message: "Use V1" } });
  assert.deepEqual(fixture.bridge.requests[1].payload.input, encrypted.input);
  assert.equal(fixture.bridge.requests.length, 2);
  assert.equal(fixture.native.requests.length, 0);
});

test("transport failure is surfaced without replaying a browser turn or using native quota", async t => {
  const fixture = await routerFixture(t, ({ request }) => request.socket.destroy());
  const response = await fixture.post({ model, input: [{ role: "user", content: "perform one action" }] });
  assert.ok(response.status >= 500);
  await response.arrayBuffer();
  assert.equal(fixture.bridge.requests.length, 1);
  assert.equal(fixture.native.requests.length, 0);
});

test("client cancellation closes the in-flight browser turn without retry or native fallback", { timeout: 7000 }, async t => {
  let began;
  let closed;
  const started = new Promise(resolve => { began = resolve; });
  const canceled = new Promise(resolve => { closed = resolve; });
  const fixture = await routerFixture(t, ({ response }) => {
    response.on("close", closed);
    began();
  });
  const controller = new AbortController();
  const requested = fixture.post({ model, input: [{ role: "user", content: "long browser task" }] }, "/responses", {}, { signal: controller.signal });
  const rejection = assert.rejects(requested, error => error.name === "AbortError");
  await started;
  controller.abort();
  await rejection;
  await canceled;
  assert.equal(fixture.bridge.requests.length, 1);
  assert.equal(fixture.native.requests.length, 0);
});
