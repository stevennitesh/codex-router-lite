import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import http from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { callerBaseUrl } from "../src/caller-auth.mjs";
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

function saveSettings(baseUrl, { enabled = true, capabilities = allCapabilities, directory = state, ...extra } = {}) {
  writeFileSync(path.join(directory, "chatgpt-web.json"), JSON.stringify({ version: 1, enabled, baseUrl, capabilities, ...extra }));
}

function launcherConfig(port, overrides = {}) {
  return { version: 3, mode: "full", browserInteractionMode: "automatic", experimentalBiggerContext: false,
    host: "127.0.0.1", port, ...allCapabilities, ...overrides };
}

function saveLauncherConfig(value) {
  mkdirSync(web.WEB_BRIDGE_HOME, { recursive: true });
  writeFileSync(path.join(web.WEB_BRIDGE_HOME, "config.json"), JSON.stringify(value));
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
  saveSettings(bridge.baseUrl, { directory, ...options });
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
  });
  t.after(() => stop(child));
  await ready(`http://127.0.0.1:${port}/live`, child);
  return { bridge, native, port, directory, child, url: callerBaseUrl(port, callerKey),
    post: (payload, suffix = "/responses", headers = {}, fetchOptions = {}) => fetch(`${callerBaseUrl(port, callerKey)}${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), ...fetchOptions,
    }) };
}

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

test("Web catalog names the serving families and exposes only account-supported effort choices", () => {
  const models = web.buildWebBridgeModels(allCapabilities);
  assert.equal(models.find(row => row.slug === "chatgpt-web/gpt-6-pro").displayName, "GPT-6 Astra Pro (Web)");
  assert.equal(models.find(row => row.slug === "chatgpt-web/gpt-5.6-pro").displayName, "GPT-5.6 Sol Pro (Web)");
  assert.deepEqual(models.map(row => [row.slug, row.supported_reasoning_levels.map(level => level.effort), row.defaultEffort]), [
    ["chatgpt-web/gpt-6-sol-instant", ["low"], "low"],
    ["chatgpt-web/gpt-6-sol", ["medium", "high", "xhigh"], "medium"],
    ["chatgpt-web/gpt-5.6-sol-instant", ["low"], "low"],
    ["chatgpt-web/gpt-5.6-sol", ["medium", "high", "xhigh"], "medium"],
    ["chatgpt-web/gpt-5.6-pro", ["max"], "max"],
    ["chatgpt-web/gpt-6-pro", ["max"], "max"],
  ]);
  const reduced = web.buildWebBridgeModels({ solAvailable: true, extraHighAvailable: false, proAvailable: false });
  assert.equal(reduced.length, 4);
  assert.deepEqual(reduced.find(row => row.slug === model).supported_reasoning_levels.map(level => level.effort), ["medium", "high"]);
  const [luna] = web.buildWebBridgeModels({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
  assert.match(luna.displayName, /Luna.*version unverified/u);
  assert.deepEqual(luna.supported_reasoning_levels, [{ effort: "low", description: "Ordinary Luna" }, { effort: "medium", description: "Think" }]);
  assert.ok(models.every(row => row.multi_agent_version === "v1"));
  for (const capabilities of [undefined, {}, { solAvailable: true, extraHighAvailable: "yes", proAvailable: false }]) {
    assert.throws(() => web.buildWebBridgeModels(capabilities), /capabilities/u);
  }
});

test("bridge address accepts a dedicated loopback service and rejects remote, credential, redirect-path and Router hops", () => {
  assert.equal(web.validateWebBridgeBaseUrl("http://127.0.0.1:17841/v1/"), "http://127.0.0.1:17841/v1");
  for (const address of ["https://127.0.0.1:17841/v1", "http://localhost:17841/v1", "http://192.0.2.1:17841/v1",
    "http://secret@127.0.0.1:17841/v1", "http://127.0.0.1:17841/v1?token=secret", "http://127.0.0.1:17841/v1#secret",
    "http://127.0.0.1:17841/other", "http://127.0.0.1:4200/v1", "http://127.0.0.1:4202/v1", "http://127.0.0.1:4203/v1"]) {
    assert.throws(() => web.validateWebBridgeBaseUrl(address), Error, address);
  }
});

test("missing settings are disabled, persisted model lists cannot invent availability, and corrupt settings fail closed", () => {
  rmSync(settingsPath, { force: true });
  assert.equal(web.readWebBridgeSettings().enabled, false);
  assert.deepEqual(web.webBridgeModels(), []);
  saveSettings("http://127.0.0.1:17841/v1", { capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false },
    models: [{ slug: "chatgpt-web/anything", displayName: "invented" }] });
  assert.equal(web.webBridgeModels().some(row => row.slug.endsWith("anything")), false);
  assert.equal(web.webBridgeModels().some(row => row.slug.endsWith("pro")), false);
  writeFileSync(settingsPath, "not json");
  assert.throws(() => web.readWebBridgeSettings(), /invalid state/u);
});

test("connect checks credential-free health and stores only safe account observations; disconnect stops publication", async t => {
  const bridge = await listener(t, ({ path: requestPath, method, headers, response }) => {
    assert.equal(requestPath, "/healthz");
    assert.equal(method, "GET");
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["chatgpt-account-id"], undefined);
    json(response, { service: "codex-chatgpt-web", status: "ok", mode: "full", accepting_turns: true, version: "6.1.9" });
  });
  saveLauncherConfig(launcherConfig(bridge.port, { tunnelToken: "private-tunnel", controlToken: "private-control", browserCookie: "private-cookie" }));
  await web.connectWebBridge(bridge.baseUrl);
  assert.equal(bridge.requests.length, 1);
  const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["baseUrl", "bridgeVersion", "capabilities", "connectedAt", "enabled", "mode", "version"]);
  assert.deepEqual(stored.capabilities, allCapabilities);
  assert.equal(stored.enabled, true);
  assert.equal(stored.bridgeVersion, "6.1.9");
  assert.equal(web.webBridgeModels().length, 6);
  await web.disconnectWebBridge();
  assert.deepEqual(web.webBridgeModels(), []);
  await assert.rejects(web.requestWebBridge({ model }), error => error.status === 409);
  assert.equal(bridge.requests.length, 1, "disabled forwarding must not touch the bridge");
});

test("connect rejects non-production launcher modes before probing and rejects a non-accepting service", async t => {
  const bridge = await listener(t, ({ response }) => json(response,
    { service: "codex-chatgpt-web", status: "ok", mode: "full", accepting_turns: false }));
  for (const overrides of [{ mode: "invalid" }, { browserInteractionMode: "manual" }, { experimentalBiggerContext: true },
    { purpose: "dev-harness" }, { host: "0.0.0.0" }, { port: bridge.port + 1 }, { version: 2 }]) {
    saveLauncherConfig(launcherConfig(bridge.port, overrides));
    await assert.rejects(web.connectWebBridge(bridge.baseUrl), /isolated production launcher setup/u);
  }
  assert.equal(bridge.requests.length, 0);
  saveLauncherConfig(launcherConfig(bridge.port));
  await assert.rejects(web.connectWebBridge(bridge.baseUrl), /not an accepting ChatGPT Web bridge/u);
  assert.equal(bridge.requests.length, 1);
});

test("browser-only connection publishes actual models without claiming local tools or subagents", async t => {
  const bridge = await listener(t, ({ response }) => json(response,
    { service: "codex-chatgpt-web", status: "ok", mode: "browser-only", accepting_turns: true, version: "6.1.9" }));
  saveLauncherConfig(launcherConfig(bridge.port, { mode: "browser-only" }));
  const status = await web.connectWebBridge(bridge.baseUrl);
  assert.equal(status.mode, "browser-only");
  assert.equal(status.localToolsConfigured, false);
  assert.equal(web.webBridgeModels().length, 6);
  assert.ok(web.webBridgeModels().every(model => model.supportsSubagents === false && model.description.includes("local coding tools are unavailable")));
});

test("launcher exposes native rollouts through the expected junction while keeping configuration and credentials isolated", async () => {
  const nativeSessions = path.join(process.env.CODEX_HOME, "sessions");
  const isolatedSessions = path.join(web.WEB_BRIDGE_CODEX_HOME, "sessions");
  mkdirSync(nativeSessions);
  mkdirSync(web.WEB_BRIDGE_CODEX_HOME, { recursive: true });
  writeFileSync(path.join(nativeSessions, "rollout-fixture.jsonl"), "native rollout fixture\n");
  writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), 'model = "native-fixture"\n');
  writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), '{"fixtureCredential":"must-stay-isolated"}\n');
  const isolatedConfig = path.join(web.WEB_BRIDGE_CODEX_HOME, "config.toml");
  writeFileSync(isolatedConfig, 'model = "bridge-fixture"\n');

  // Running Node with no arguments and ignored stdin exits immediately. This
  // exercises the real Windows launch path without executing a Web launcher.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await web.launchWebBridge(process.execPath);
    assert.equal(result.launched, true);
    assert.ok(Number.isInteger(result.processId));
    assert.equal(result.isolatedCodexHome, web.WEB_BRIDGE_CODEX_HOME);
    assert.equal(lstatSync(isolatedSessions).isSymbolicLink(), true);
    assert.equal(realpathSync(isolatedSessions).toLowerCase(), realpathSync(nativeSessions).toLowerCase());
    assert.equal(readFileSync(path.join(isolatedSessions, "rollout-fixture.jsonl"), "utf8"), "native rollout fixture\n");
    assert.equal(readFileSync(isolatedConfig, "utf8"), 'model = "bridge-fixture"\n');
    assert.equal(lstatSync(isolatedConfig).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"), 'model = "native-fixture"\n');
    assert.equal(existsSync(path.join(web.WEB_BRIDGE_CODEX_HOME, "auth.json")), false);
    assert.equal(existsSync(path.join(web.WEB_BRIDGE_HOME, "auth.json")), false);
  }

  // Removing the junction alone must leave native rollouts intact. A real
  // directory at that path belongs to its owner and must never be replaced.
  unlinkSync(isolatedSessions);
  mkdirSync(isolatedSessions);
  writeFileSync(path.join(isolatedSessions, "owned-rollout.jsonl"), "keep this isolated rollout\n");
  await assert.rejects(web.launchWebBridge(process.execPath), /not the expected native-rollout junction/u);
  assert.equal(lstatSync(isolatedSessions).isSymbolicLink(), false);
  assert.equal(readFileSync(path.join(isolatedSessions, "owned-rollout.jsonl"), "utf8"), "keep this isolated rollout\n");
  assert.equal(readFileSync(path.join(nativeSessions, "rollout-fixture.jsonl"), "utf8"), "native rollout fixture\n");
  assert.equal(readFileSync(isolatedConfig, "utf8"), 'model = "bridge-fixture"\n');
  assert.equal(existsSync(path.join(web.WEB_BRIDGE_CODEX_HOME, "auth.json")), false);
});

test("Router forwards tools, history, exact selected effort and safe turn identity without native or Router credentials", async t => {
  const payload = { model, stream: false, input: [
    { role: "user", content: "Edit the file" },
    { type: "function_call", name: "functions.exec", call_id: "call_previous", arguments: "{}" },
    { type: "function_call_output", call_id: "call_previous", output: "prior result" },
  ], tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch",
    description: "Patch files", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] }],
  previous_response_id: "resp_previous", client_metadata: { thread_id: "fixture-thread", turn_id: "fixture-turn", custom: "retained" },
  reasoning: { effort: "high", summary: "auto" }, context_management: [{ type: "compaction", compact_threshold: 12000 }],
  parallel_tool_calls: false, store: false };
  const fixture = await routerFixture(t, ({ response }) => json(response, completed, 200, { "set-cookie": "private=session" }));
  const response = await fixture.post(payload, "/responses", {
    authorization: "Bearer native-secret", "chatgpt-account-id": "native-account", "openai-organization": "native-org",
    "x-openai-internal-codex-residency": "us", "x-api-key": "private-router-key", "x-codex-router-key": "private-capability",
    "x-codex-thread-id": "fixture-thread", "x-codex-turn-id": "fixture-turn", "x-codex-client-metadata": "safe-metadata",
    "x-codex-parent-thread-id": "fixture-parent", session_id: "fixture-session",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completed);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(fixture.bridge.requests.length, 1);
  assert.deepEqual(fixture.bridge.requests[0].payload, payload);
  const headers = fixture.bridge.requests[0].headers;
  for (const name of ["authorization", "chatgpt-account-id", "openai-organization", "x-openai-internal-codex-residency", "x-api-key", "x-codex-router-key"]) {
    assert.equal(headers[name], undefined, `${name} must not reach the browser service`);
  }
  assert.equal(headers["x-codex-thread-id"], "fixture-thread");
  assert.equal(headers["x-codex-turn-id"], "fixture-turn");
  assert.equal(headers["x-codex-parent-thread-id"], "fixture-parent");
  assert.equal(headers.session_id, "fixture-session");
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
  assert.equal(fixture.bridge.requests[0].path, "/v1/responses/compact");
  assert.deepEqual(fixture.bridge.requests[0].payload, payload);
  assert.equal(fixture.native.requests.length, 0);
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
  saveSettings(fixture.bridge.baseUrl, { directory: fixture.directory, enabled: false });
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
