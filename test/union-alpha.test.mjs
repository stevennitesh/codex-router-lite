import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { routedModel } from "../src/catalog.mjs";
import { MODEL_BY_SLUG, validateOpenRouterRoute } from "../src/routed-models.mjs";
import { prepareUnionAlphaRequest } from "../src/union-alpha-compat.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const route = MODEL_BY_SLUG.get("openrouter/union-alpha");
const caller = "union-fixture-caller-capability-long-enough";
const internal = "union-fixture-internal-capability-long-enough";
const fn = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };

test("Union Alpha advertises its measured contract without guessed identity and with exact-route v2", () => {
  assert.equal(validateOpenRouterRoute(route), route);
  const built = routedModel({ base_instructions: "You are Codex.", model_messages: {} }, route);
  assert.equal(built.context_window, 262144);
  assert.equal(built.auto_compact_token_limit, 220000);
  assert.ok(built.auto_compact_token_limit < Math.floor(built.context_window * 0.9));
  assert.equal(built.default_reasoning_level, "none");
  assert.equal(built.supports_reasoning_summary_parameter, false);
  assert.equal(built.support_verbosity, false);
  assert.equal(built.supports_search_tool, true);
  assert.equal(route.searchTool, undefined);
  assert.equal(built.multi_agent_version, "v2");
  assert.throws(() => validateOpenRouterRoute({ ...route, openRouterProviderPolicy: { ...route.openRouterProviderPolicy, only: ["novita"] } }), /exact Stealth/);
  assert.throws(() => validateOpenRouterRoute({ ...route, openRouterProviderPolicy: { ...route.openRouterProviderPolicy, allow_fallbacks: true } }), /fallback disabled/);
});

test("Union Alpha strips unsupported controls and implements none without weakening forced choices", () => {
  const original = { tools: [fn], tool_choice: "auto", reasoning: { effort: "max" }, reasoning_effort: "max", text: { verbosity: "high", format: { type: "json_object" } }, max_output_tokens: 256, parallel_tool_calls: true };
  const next = prepareUnionAlphaRequest(original, route);
  assert.equal(next.reasoning, undefined);
  assert.equal(next.reasoning_effort, undefined);
  assert.deepEqual(next.text, { format: { type: "json_object" } });
  assert.equal(next.max_output_tokens, 256);
  assert.equal(next.parallel_tool_calls, true);
  assert.equal(original.text.verbosity, "high");
  assert.deepEqual(original.reasoning, { effort: "max" });
  const noTools = prepareUnionAlphaRequest({ ...original, tool_choice: "none" }, route);
  assert.equal(noTools.tools, undefined);
  assert.equal(noTools.tool_choice, undefined);
  for (const tool_choice of ["required", { type: "function", name: "lookup" }, { type: "allowed_tools", mode: "required", tools: [fn] }]) {
    assert.throws(() => prepareUnionAlphaRequest({ ...original, tool_choice }, route), { code: "unsupported_tool_choice", status: 400 });
  }
  assert.equal(prepareUnionAlphaRequest(original, MODEL_BY_SLUG.get("openrouter/glm-5.3-flash")), original);
});

function launch(script, env) {
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  let errors = "";
  child.stderr.on("data", bytes => { errors += bytes; });
  child.errors = () => errors;
  return child;
}
async function ready(url, child, headers = {}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, child.errors());
    try { if ((await fetch(url, { headers })).status < 500) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Isolated service not ready: " + child.errors());
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const ended = once(child, "exit"); child.kill(); await ended;
  }
}
function responseJson(response, value) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

test("Union Alpha uses the authenticated direct Responses hop for native tools, replay, and compaction", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "union-router-"));
  const seen = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    seen.push({ body, headers: request.headers, path: request.url });
    if (body.max_output_tokens === 20) {
      const item = { type: "function_call", id: "empty_fixture", call_id: "empty_fixture", name: body.tools[0].name, arguments: "" };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [{ type: "response.output_item.done", item }, { type: "response.completed", response: { status: "completed", output: [item] } }];
      return response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    }
    if (body.max_output_tokens === 19) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      return response.end('event: error\ndata: {"type":"error","code":"provider_error","message":"Synthetic stream failure"}\n\ndata: [DONE]\n\n');
    }
    if (body.max_output_tokens === 11) {
      return responseJson(response, { status: "completed", output: body.tools.map((tool, index) =>
        ({ type: "function_call", name: tool.name, call_id: `collision_${index}`, arguments: "{}" })) });
    }
    if ([12, 13, 14, 15].includes(body.max_output_tokens)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(({ 12: "null", 13: "{}", 14: "[]", 15: "not-json" })[body.max_output_tokens]);
    }
    if (body.max_output_tokens === 16) {
      response.writeHead(400, { "Content-Type": "text/html" });
      return response.end("Synthetic provider rejection");
    }
    if (body.max_output_tokens === 17) {
      const tool = body.tools.find(tool => tool.parameters?.properties?.input);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_partial", call_id: "partial", name: tool.name, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_partial", delta: '{"input":"unfinished' },
      ];
      return response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    }
    if (body.max_output_tokens === 18) {
      const item = { type: "message", id: "msg_partial", role: "assistant", content: [{ type: "output_text", text: "Partial answer" }] };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "Partial answer" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.failed", response: { status: "failed", output: [item], error: { code: "fixture_failure", message: "Synthetic provider failure" } } },
      ];
      return response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    }
    if ([8, 9].includes(body.max_output_tokens)) {
      return responseJson(response, { status: body.max_output_tokens === 8 ? "failed" : "incomplete", output: [],
        ...(body.max_output_tokens === 8 ? { error: { code: "server_error", message: "Synthetic failure" } } : { incomplete_details: { reason: "max_output_tokens" } }) });
    }
    if ([5, 6, 7].includes(body.max_output_tokens)) {
      const status = { 5: "incomplete", 6: "failed", 7: "completed" }[body.max_output_tokens];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const terminal = { type: `response.${status}`, response: { id: "resp_short", status, output: [],
        ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        ...(status === "failed" ? { error: { code: "server_error", message: "Synthetic upstream failure" } } : {}),
      } };
      response.end(`event: ${terminal.type}\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`);
      return;
    }
    const custom = body.tools?.find(tool => tool.parameters?.properties?.input);
    const call = custom
      ? { type: "function_call", id: "fc_fixture", call_id: "union_custom", name: custom.name, arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) }
      : body.tools?.some(tool => tool.name === "mcp__codex_app__list_projects")
        ? { type: "function_call", id: "fc_fixture", call_id: "union_app", name: "mcp__codex_app__list_projects", arguments: "{}" }
        : { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "UNION_DONE" }] };
    if (!body.stream) return responseJson(response, { id: "resp_fixture", status: "completed", output: [call] });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: call.arguments },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: call.id, arguments: call.arguments },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [call] } },
    ];
    for (const event of events) {
      const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      response.write(frame.slice(0, 23)); response.write(frame.slice(23));
    }
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const [apiPort, routerPort] = await Promise.all([openPort(), openPort()]);
  const env = { CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_INTERNAL_KEY: internal, CODEX_ROUTER_CALLER_KEY: caller,
    CODEX_ROUTER_API_PORT: String(apiPort), CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_GATEWAY_BASE_URL: "http://127.0.0.1:1/v1", CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    OPENROUTER_API_KEY: "UNION_SYNTHETIC_CREDENTIAL", OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1` };
  const forwarder = launch("api-forwarder.mjs", env);
  const router = launch("router.mjs", env);
  const base = callerBaseUrl(routerPort, caller);
  const post = (body, endpoint = "responses") => fetch(`${base}/${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer native-must-not-leave", "ChatGPT-Account-Id": "must-not-leave" },
    body: JSON.stringify({ model: route.slug, input: [{ role: "user", content: "synthetic task" }], ...body }),
  });
  try {
    await ready(`${base}/models`, router);
    // An authenticated invalid method proves the forwarder's listener is ready
    // without writing a real credential merely to satisfy /health.
    await ready(`http://127.0.0.1:${apiPort}/v1/responses`, forwarder, { Authorization: `Bearer ${internal}` });
    const tools = [{ type: "namespace", name: "mcp__codex_app", tools: [{ ...fn, name: "list_projects" }] }];
    const first = await post({ tools, tool_choice: "auto", stream: false, parallel_tool_calls: true, reasoning: { effort: "high" }, text: { verbosity: "medium" } });
    assert.equal(first.status, 200, router.errors());
    const appCall = (await first.json()).output[0];
    assert.equal(appCall.namespace, "mcp__codex_app");
    assert.equal(appCall.name, "list_projects");
    assert.equal(seen[0].path, "/v1/responses");
    assert.equal(seen[0].body.model, "stealth/union-alpha");
    assert.deepEqual(seen[0].body.provider, route.openRouterProviderPolicy);
    assert.equal(seen[0].body.reasoning, undefined);
    assert.equal(seen[0].body.parallel_tool_calls, undefined);
    assert.equal(seen[0].body.text, undefined);
    assert.equal(seen[0].headers.authorization, "Bearer UNION_SYNTHETIC_CREDENTIAL");
    assert.equal(seen[0].headers["chatgpt-account-id"], undefined);
    const replay = await post({ tools, tool_choice: "none", input: [appCall, { type: "function_call_output", call_id: appCall.call_id, output: "[]" }] });
    assert.equal(replay.status, 200);
    await replay.text();
    assert.equal(seen[1].body.input[0].name, "mcp__codex_app__list_projects");
    assert.equal(seen[1].body.input[1].call_id, "union_app");
    assert.equal(seen[1].body.tools, undefined);
    assert.equal(seen[1].body.tool_choice, undefined);
    const collisionTools = [{ ...fn, name: "fixture__read" },
      { type: "namespace", name: "fixture", tools: [{ ...fn, name: "read" }] }];
    const collisionResponse = await post({ tools: collisionTools, max_output_tokens: 11 });
    assert.equal(collisionResponse.status, 200);
    const collisions = (await collisionResponse.json()).output;
    assert.equal(new Set(seen.at(-1).body.tools.map(tool => tool.name)).size, 2, "different native tools need distinct provider names");
    assert.equal(collisions[0].name, "fixture__read");
    assert.equal(collisions[0].namespace, undefined);
    assert.equal(collisions[1].name, "read");
    assert.equal(collisions[1].namespace, "fixture");
    const collisionReplay = await post({ tools: collisionTools, input: collisions.flatMap(item =>
      [item, { type: "function_call_output", call_id: item.call_id, output: "synthetic result" }]) });
    assert.equal(collisionReplay.status, 200); await collisionReplay.text();
    assert.deepEqual(seen.at(-1).body.input.filter(item => item.type === "function_call").map(item => item.name),
      seen.at(-1).body.tools.map(tool => tool.name));
    const customTools = [{ type: "custom", name: "apply_patch", description: "Submit a patch." }];
    const customResponse = await post({ tools: customTools, stream: true });
    assert.equal(customResponse.status, 200);
    const events = (await customResponse.text()).split("\n\n").flatMap(frame => {
      const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    const customCall = events.find(event => event.type === "response.output_item.done")?.item;
    assert.equal(customCall?.type, "custom_tool_call");
    assert.equal(customCall.name, "apply_patch");
    assert.equal(customCall.input, "*** Begin Patch\n*** End Patch");
    const customReplay = await post({ tools: customTools, input: [{ ...customCall, id: "ctc_native" }, { type: "custom_tool_call_output", id: "ctco_native", call_id: customCall.call_id, output: "success" }] });
    assert.equal(customReplay.status, 200);
    await customReplay.text();
    assert.equal(seen.at(-1).body.input[0].type, "function_call");
    assert.equal(seen.at(-1).body.input[0].id, undefined);
    assert.deepEqual(JSON.parse(seen.at(-1).body.input[0].arguments), { input: customCall.input });
    assert.equal(seen.at(-1).body.input[1].call_id, customCall.call_id);
    const count = seen.length;
    for (const tool_choice of ["required", { type: "function", name: "lookup" }]) {
      const rejected = await post({ tools: [fn], tool_choice });
      assert.equal(rejected.status, 400);
      assert.match(await rejected.text(), /automatic tool selection/);
    }
    assert.equal(seen.length, count, "forced choice must fail before provider traffic");
    const unsupportedSearch = await post({ tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } });
    assert.equal(unsupportedSearch.status, 400);
    const hostileSearch = await fetch(`http://127.0.0.1:${apiPort}/v1/responses`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${internal}` },
      body: JSON.stringify({ model: route.slug, tools: [{ type: "openrouter:web_search", parameters: {} }] }),
    });
    assert.equal(hostileSearch.status, 400);
    assert.equal(seen.length, count);
    const beforePartial = seen.length;
    const interrupted = await post({ tools: customTools, stream: true, max_output_tokens: 17 });
    const partialWire = await interrupted.text();
    assert.match(partialWire, /event: error/);
    assert.doesNotMatch(partialWire, /response\.output_item\.done|response\.completed|response\.custom_tool_call_input\.done/);
    assert.equal(seen.length, beforePartial + 1, "partial tool output must not be automatically executed again");
    const beforeFailedText = seen.length;
    const failedText = await post({ stream: true, max_output_tokens: 18 });
    const failedWire = await failedText.text();
    assert.match(failedWire, /Partial answer/);
    assert.match(failedWire, /fixture_failure/);
    assert.doesNotMatch(failedWire, /final_answer|response\.completed/);
    assert.equal(seen.length, beforeFailedText + 1, "a partial failed answer must preserve the failure without a retry");
    const compact = await post({ tools: [], reasoning: { effort: "high" }, input: [
      { ...customCall, id: "ctc_compact" },
      { type: "custom_tool_call_output", id: "ctco_compact", call_id: customCall.call_id, output: "success" },
    ] }, "responses/compact");
    assert.equal(compact.status, 200, await compact.text());
    assert.equal(seen.at(-1).path, "/v1/responses");
    assert.equal(seen.at(-1).body.tools, undefined);
    assert.equal(seen.at(-1).body.reasoning, undefined);
    assert.equal(seen.at(-1).body.input[0].type, "function_call");
    assert.deepEqual(JSON.parse(seen.at(-1).body.input[0].arguments), { input: customCall.input });
    assert.equal(seen.at(-1).body.input[0].id, undefined);
    assert.equal(seen.at(-1).body.input[1].type, "function_call_output");
    assert.equal(seen.at(-1).body.input[1].call_id, customCall.call_id);
    const namespacedCustom = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
    const namespacedResponse = await post({ tools: namespacedCustom });
    assert.equal(namespacedResponse.status, 200);
    const namespacedCall = (await namespacedResponse.json()).output[0];
    assert.equal(namespacedCall.type, "custom_tool_call");
    assert.equal(namespacedCall.namespace, "functions");
    assert.equal(namespacedCall.name, "exec");
    const namespacedHistory = [namespacedCall, { type: "custom_tool_call_output", call_id: namespacedCall.call_id, output: "executed" }];
    for (const endpoint of ["responses", "responses/compact"]) {
      const next = await post({ tools: namespacedCustom, input: namespacedHistory }, endpoint);
      assert.equal(next.status, 200);
      await next.text();
      assert.equal(seen.at(-1).body.input[0].name, "functions__exec");
      assert.equal(seen.at(-1).body.input[0].namespace, undefined);
      assert.deepEqual(JSON.parse(seen.at(-1).body.input[0].arguments), { input: namespacedCall.input });
      assert.equal(seen.at(-1).body.input[1].call_id, namespacedCall.call_id);
    }
    const { namespace: _defaultNamespace, ...nativeDefaultCall } = namespacedCall;
    const defaultReplay = await post({ tools: namespacedCustom, input: [nativeDefaultCall, namespacedHistory[1]] });
    assert.equal(defaultReplay.status, 200);
    await defaultReplay.text();
    assert.equal(seen.at(-1).body.input[0].name, seen.at(-1).body.tools[0].name);
    const discoveryInput = [
      { type: "message", role: "user", content: "Remember the synthetic count." },
      { type: "tool_search_call", execution: "client", call_id: "search_fixture", arguments: { query: "desktop_probe list_projects" } },
      { type: "tool_search_output", execution: "client", status: "completed", call_id: "search_fixture", tools: [
        { type: "namespace", name: "desktop_probe", tools: [{ ...fn, name: "list_projects" }] },
      ] },
      { type: "function_call", namespace: "desktop_probe", name: "list_projects", arguments: "{}", call_id: "discovered" },
      { type: "function_call_output", call_id: "discovered", output: '{"projectCount":3}' },
    ];
    const discoveryCompact = await post({ input: discoveryInput }, "responses/compact");
    assert.equal(discoveryCompact.status, 200);
    await discoveryCompact.text();
    const compactBody = seen.at(-1).body;
    assert.ok(!compactBody.input.some(item => item.type === "tool_search_call" || item.type === "tool_search_output"));
    assert.equal(compactBody.input.find(item => item.type === "function_call").name, "desktop_probe__list_projects");
    assert.equal(compactBody.input.find(item => item.type === "function_call_output").call_id, "discovered");
    assert.equal(compactBody.tools, undefined, "historical discovery cannot enable fresh tools during compaction");
    assert.match(JSON.stringify(compactBody.input), /ROUTER SOURCE CATALOG.*tool_search/s, "discovery evidence remains in the source catalog");
    const rejectedHistory = [
      { type: "function_call", name: "desktop_probe.list_projects", arguments: "{}", call_id: "rejected" },
      { type: "function_call_output", call_id: "rejected", output: "unsupported call: desktop_probe.list_projects" },
    ];
    for (const endpoint of ["responses", "responses/compact"]) {
      const recovered = await post({ input: rejectedHistory }, endpoint);
      assert.equal(recovered.status, 200); await recovered.text();
      const sent = seen.at(-1).body;
      assert.match(sent.input[0].name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.notEqual(sent.input[0].name, rejectedHistory[0].name);
      assert.equal(sent.input[0].call_id, "rejected");
      assert.deepEqual(sent.input[1], rejectedHistory[1]);
      assert.equal(sent.tools, undefined);
    }
    for (const [max_output_tokens, status] of [[5, "incomplete"], [6, "failed"]]) {
      const before = seen.length;
      const partial = await post({ stream: true, max_output_tokens });
      assert.equal(partial.status, 200);
      const wire = await partial.text();
      assert.ok(wire.includes(`"status":"${status}"`));
      assert.ok(wire.includes("data: [DONE]"));
      assert.ok(!wire.includes("empty_completion"));
      assert.equal(seen.length, before + 1, "explicit failure must not be retried as empty success");
    }
    const beforeError = seen.length;
    const emptyCall = await post({ tools, stream: true, max_output_tokens: 20 });
    assert.equal(emptyCall.status, 200);
    assert.match(await emptyCall.text(), /"arguments":""/);
    // The warning precedes response completion but crosses a separate stderr pipe.
    for (let i = 0; i < 50 && !router.errors().includes("empty_function_arguments"); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(router.errors(), /tool-protocol.*"sourceCharacters":0,"restoredCharacters":0,"deltaCharacters":null,"doneCharacters":null/);
    const providerError = await post({ stream: true, max_output_tokens: 19 });
    assert.equal(providerError.status, 200);
    const errorWire = await providerError.text();
    assert.match(errorWire, /"code":"provider_error"/);
    assert.ok(!errorWire.includes("empty_completion"));
    assert.equal(seen.length, beforeError + 2, "empty calls and generic SSE errors must not trigger extra provider requests");
    const beforeEmpty = seen.length;
    const empty = await post({ stream: true, max_output_tokens: 7 });
    assert.equal(empty.status, 502);
    assert.match(await empty.text(), /empty_completion/);
    assert.equal(seen.length, beforeEmpty + 2, "genuinely empty success keeps its bounded retry");
    for (const max_output_tokens of [8, 9]) for (const endpoint of ["responses/compact", "responses"]) {
      const failedCompact = await post({ max_output_tokens,
        ...(endpoint === "responses" ? { input: [{ type: "message", role: "user", content: "Keep history" }, { type: "compaction_trigger" }], stream: true } : {}),
      }, endpoint);
      assert.equal(failedCompact.status, 502, "unsuccessful provider compaction must not become a successful checkpoint");
      const failure = await failedCompact.json();
      assert.equal(failure.error.code, max_output_tokens === 8 ? "compaction_failed" : "compaction_incomplete");
      assert.equal(failure.output, undefined);
    }
    for (const max_output_tokens of [12, 13, 14, 15, 16]) for (const endpoint of ["responses/compact", "responses"]) {
      const malformed = await post({ max_output_tokens,
        ...(endpoint === "responses" ? { input: [{ role: "user", content: "Keep history" }, { type: "compaction_trigger" }], stream: true } : {}),
      }, endpoint);
      assert.equal(malformed.status, max_output_tokens === 16 ? 400 : 502, "invalid provider envelope cannot compact history");
      const failure = await malformed.json();
      assert.equal(failure.error.code, max_output_tokens === 16 ? "compaction_upstream_error" : "compaction_invalid_response");
      assert.equal(failure.output, undefined);
    }
  } finally {
    await Promise.all([stop(router), stop(forwarder)]);
    await new Promise(resolve => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});

test("OpenRouter forwarder cancels Union and GLM work before headers and during streaming", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "union-cancel-"));
  let receivedResolve, closedResolve;
  let sendHeaders = false, upstreamRequests = 0;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the complete POST before cancellation */ }
    upstreamRequests++;
    response.once("close", closedResolve);
    if (sendHeaders) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    }
    receivedResolve();
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const apiPort = await openPort();
  const forwarder = launch("api-forwarder.mjs", { MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_INTERNAL_KEY: internal, CODEX_ROUTER_API_PORT: String(apiPort), CODEX_ROUTER_QUIET: "1",
    OPENROUTER_API_KEY: "UNION_SYNTHETIC_CREDENTIAL", OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1` });
  let controller;
  let timer;
  try {
    const url = `http://127.0.0.1:${apiPort}/v1/responses`;
    await ready(url, forwarder, { Authorization: `Bearer ${internal}` });
    for (const model of [route.slug, "openrouter/glm-5.3-flash"]) for (const headers of [false, true]) {
      sendHeaders = headers;
      const received = new Promise(resolve => { receivedResolve = resolve; });
      const closed = new Promise(resolve => { closedResolve = resolve; });
      const count = upstreamRequests;
      controller = new AbortController();
      let headersResolve;
      const gotHeaders = new Promise(resolve => { headersResolve = resolve; });
      const request = fetch(url, { method: "POST", headers: { Authorization: `Bearer ${internal}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: "synthetic cancellation", stream: true }), signal: controller.signal })
        .then(response => { headersResolve(); return response.text(); });
      const rejected = assert.rejects(request, { name: "AbortError" });
      await received;
      if (headers) await gotHeaders;
      controller.abort();
      await rejected;
      const promptlyClosed = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
      clearTimeout(timer);
      assert.equal(promptlyClosed, true, `${model}: provider request remains alive after client cancellation (headers=${headers})`);
      assert.equal(upstreamRequests, count + 1, "cancellation must not retry provider work");
    }
  } finally {
    clearTimeout(timer); controller?.abort(); await stop(forwarder);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
