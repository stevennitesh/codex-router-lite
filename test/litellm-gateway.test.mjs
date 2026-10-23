import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { writeLiteLlmConfig } from "../src/litellm-config.mjs";
import { CHECKED_IN_MODELS } from "../src/routed-models.mjs";
import { prepareRoutedRequest } from "../src/routed-request.mjs";
import { openPort } from "./port-pool.mjs";
import { ready, stop } from "./router-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const localPython = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.MODEL_ROUTER_TEST_LITELLM_PYTHON || (existsSync(localPython) ? localPython : undefined);
const caller = "gateway-synthetic-caller-key-with-sufficient-length";
const internal = "sk-gateway-synthetic-internal-key-with-sufficient-length";
const providerKey = "GATEWAY_SYNTHETIC_PROVIDER_KEY";
const pattern = "^(?<word>[a-z]+)$";
const gatewayBootstrap = String.raw`
import ipaddress, sys
def offline_network(event, args):
    if event in ('socket.getaddrinfo', 'socket.gethostbyname'):
        host = args[0]
    elif event == 'socket.connect':
        address = args[1]
        if not isinstance(address, tuple): return
        host = address[0]
    else:
        return
    if host == 'localhost': return
    try:
        if ipaddress.ip_address(host).is_loopback: return
    except ValueError:
        pass
    raise RuntimeError('offline gateway fixture forbids non-loopback network')
sys.addaudithook(offline_network)
from litellm import run_server
run_server()
`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function service(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", bytes => { logs = (logs + bytes.toString("utf8")).slice(-65536); });
  }
  child.errors = () => logs;
  return child;
}

test("pinned GLM gateway preserves schemas and cancels pending/acquired private-forwarder work", {
  skip: python ? false : "supply the hash-locked gateway interpreter with MODEL_ROUTER_TEST_LITELLM_PYTHON",
  timeout: 90000,
}, async t => {
  assert.equal(new RegExp(pattern).test("alice"), true);
  assert.equal(new RegExp(pattern).test("123"), false);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-gateway-integration-"));
  const sockets = new Set(), children = [];
  let upstream;
  // Register ownership before private publication or service startup can fail.
  t.after(async () => {
    await Promise.all(children.map(stop));
    for (const socket of sockets) socket.destroy();
    if (upstream?.listening) await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    assert.ok(path.basename(scratch).startsWith("router-gateway-integration-"));
    rmSync(scratch, { recursive: true, force: true });
  });
  const state = path.join(scratch, "state"), home = path.join(scratch, "home"), temporary = path.join(scratch, "temp");
  for (const directory of [state, home, temporary]) mkdirSync(directory);
  writeLiteLlmConfig(path.join(scratch, "litellm.yaml"));
  const captures = [];
  let active;
  upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const current = active;
    captures.push({ mode: current.mode, url: request.url, body, headers: request.headers });
    response.once("close", () => current.closed.resolve());
    current.received.resolve();
    if (current.mode === "pending") return;
    if (current.mode === "partial-json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"id":"chatcmpl_fixture",');
      current.headers.resolve();
      return;
    }
    if (current.mode === "acquired") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 42,
        model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "VISIBLE" }, finish_reason: null }] })}\n\n`);
      return;
    }
    if (current.mode === "refused") {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic provider refusal", type: "rate_limit_error", code: "synthetic_rate_limit" } }));
      return;
    }
    if (["length", "stop"].includes(current.mode) && body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: current.mode }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      ]) {
        response.write(`data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 42,
          model: body.model, ...chunk })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url.endsWith("/chat/completions")) {
      const callsTool = ["tool-call", "custom-call"].includes(current.mode);
      const message = callsTool
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_fixture", type: "function",
          function: { name: body.tools[0].function.name, arguments: current.mode === "custom-call"
            ? '{"input":"synthetic custom input"}' : '{"word":"alice"}' } }] }
        : { role: "assistant", content: "OK" };
      response.end(JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion", created: 42,
        model: body.model, choices: [{ index: 0, message, finish_reason: callsTool ? "tool_calls" : current.mode === "length" ? "length" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    } else {
      response.end(JSON.stringify({ id: "resp_fixture", object: "response", status: "completed",
        output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "OK", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    }
  });
  upstream.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const [apiPort, gatewayPort, routerPort] = await Promise.all([openPort(), openPort(), openPort()]);
  // Deliberately do not inherit provider credentials, live Codex state, proxy
  // settings, callback configuration or gateway credentials from the host.
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  Object.assign(env, {
    CODEX_HOME: home, HOME: home, USERPROFILE: home, MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    TEMP: temporary, TMP: temporary, CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal,
    CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_API_PORT: String(apiPort),
    CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_API_FORWARD_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    OPENROUTER_API_KEY: providerKey, OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    NO_PROXY: "*", no_proxy: "*", NODE_USE_ENV_PROXY: "0", CODEX_ROUTER_USE_ENV_PROXY: "0",
    PYTHONDONTWRITEBYTECODE: "1", LITELLM_MASTER_KEY: internal, LITELLM_LOCAL_MODEL_COST_MAP: "True",
    LITELLM_TELEMETRY: "False", LITELLM_LOG: "ERROR", NO_COLOR: "1", PYTHONIOENCODING: "utf-8",
  });
  const forwarder = service(process.execPath, [path.join(root, "src/api-forwarder.mjs")], root, env);
  children.push(forwarder);
  const gateway = service(python, ["-I", "-B", "-X", "utf8", "-c", gatewayBootstrap,
    "--config", path.join(scratch, "litellm.yaml"), "--host", "127.0.0.1", "--port", String(gatewayPort), "--num_workers", "1"], scratch, env);
  children.push(gateway);
  const router = service(process.execPath, [path.join(root, "src/router.mjs")], root, env);
  children.push(router);
  const base = callerBaseUrl(routerPort, caller);
  const routes = CHECKED_IN_MODELS.filter(route => route.slug.startsWith("openrouter/glm-5.3-flash-"));
  assert.equal(routes.length, 2);
  const tools = [{ type: "function", name: "match_word", strict: true, parameters: {
    type: "object", $defs: { word: { type: "string", pattern } },
    properties: { word: { $ref: "#/$defs/word" }, plain: { type: "string", pattern: "^[a-z]+$" } },
    patternProperties: { [pattern]: { type: "string", pattern } }, required: ["word"], additionalProperties: false,
  } }, { type: "function", name: "select_branch", strict: true, parameters: {
    oneOf: [{ $ref: "#/$defs/first" }, { $ref: "#/$defs/second" }],
    $defs: {
      first: { type: "object", properties: { mode: { const: "first" }, word: { type: "string", pattern } }, required: ["mode", "word"], additionalProperties: false },
      second: { type: "object", properties: { mode: { const: "second" }, count: { type: "integer" } }, required: ["mode", "count"], additionalProperties: false },
    },
  } }];
  function begin(mode) {
    active = { mode, received: deferred(), closed: deferred(), headers: deferred() };
    return { ...active, before: captures.length };
  }
  function post(payload, signal = AbortSignal.timeout(15000)) {
    return fetch(`${base}/responses`, { method: "POST", headers: { "Content-Type": "application/json", "ChatGPT-Account-Id": "synthetic-native-header" },
      body: JSON.stringify({ input: "synthetic offline request", stream: false, ...payload }), signal });
  }
  {
    await ready(`http://127.0.0.1:${apiPort}/health`, forwarder, { Authorization: `Bearer ${internal}` });
    await ready(`http://127.0.0.1:${gatewayPort}/health/liveliness`, gateway, { Authorization: `Bearer ${internal}` }, { timeoutMs: 45000 });
    await ready(`${base}/models`, router);
    for (const route of routes) {
      await t.test(`${route.slug}: schema fidelity and produced tool history`, async () => {
        const input = { model: route.slug, input: "synthetic schema request", tools };
        const original = structuredClone(input);
        const prepared = prepareRoutedRequest(input, route);
        const current = begin("schema");
        const response = await post(input);
        assert.equal(response.status, 200, await response.text());
        assert.equal(captures.length, current.before + 1);
        const captured = captures.at(-1);
        assert.equal(captured.url, "/v1/chat/completions");
        for (let i = 0; i < prepared.payload.tools.length; i++) {
          assert.deepEqual(captured.body.tools[i].function.parameters, prepared.payload.tools[i].parameters);
          assert.equal(captured.body.tools[i].function.strict, true);
        }
        assert.deepEqual(input, original);
        assert.deepEqual(captured.body.provider, route.openRouterProviderPolicy);
        const callRun = begin("tool-call");
        const called = await post({ model: route.slug, tools: [tools[0]] });
        assert.equal(called.status, 200);
        const call = (await called.json()).output.find(item => item.type === "function_call");
        assert.equal(call.name, "match_word");
        assert.equal(call.arguments, '{"word":"alice"}');
        assert.equal(captures.length, callRun.before + 1);
        const replay = begin("history");
        const resumed = await post({ model: route.slug, tools: [tools[0]], input: [call,
          { type: "function_call_output", call_id: call.call_id, output: "synthetic returned value" }, { role: "user", content: "Continue." }] });
        assert.equal(resumed.status, 200, await resumed.text());
        assert.equal(captures.length, replay.before + 1);
        assert.ok(captures.at(-1).body.messages.some(message => message.role === "tool" && message.tool_call_id === call.call_id && message.content === "synthetic returned value"));
        const customTools = [{ type: "custom", name: "custom_exec", format: { type: "text" } }];
        const customRun = begin("custom-call");
        const customResponse = await post({ model: route.slug, tools: customTools });
        assert.equal(customResponse.status, 200);
        const customCall = (await customResponse.json()).output.find(item => item.type === "custom_tool_call");
        assert.equal(customCall.name, "custom_exec");
        assert.equal(customCall.input, "synthetic custom input");
        assert.equal(captures.length, customRun.before + 1);
        const customReplay = begin("custom-history");
        const customResumed = await post({ model: route.slug, tools: customTools, input: [customCall,
          { type: "custom_tool_call_output", call_id: customCall.call_id, output: "synthetic custom result" }, { role: "user", content: "Continue." }] });
        assert.equal(customResumed.status, 200, await customResumed.text());
        assert.equal(captures.length, customReplay.before + 1);
        assert.ok(captures.at(-1).body.messages.some(message => message.role === "tool" && message.tool_call_id === customCall.call_id && message.content === "synthetic custom result"));
      });
      for (const finish of ["length", "stop"]) for (const stream of [false, true]) {
        await t.test(`${route.slug}: ${stream ? "streamed" : "nonstream"} ${finish} preserves terminal status and visible output`, async () => {
          const current = begin(finish);
          const response = await post({ model: route.slug, stream, max_output_tokens: 2 });
          assert.equal(response.status, 200);
          let result;
          if (stream) {
            const events = (await response.text()).split(/\r?\n/u)
              .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
              .map(line => JSON.parse(line.slice(6)));
            const terminals = events.filter(event => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type));
            assert.equal(terminals.length, 1);
            assert.equal(terminals[0].type, finish === "length" ? "response.incomplete" : "response.completed");
            assert.equal(events.at(-1), terminals[0]);
            result = terminals[0].response;
          } else result = await response.json();
          assert.equal(result.status, finish === "length" ? "incomplete" : "completed");
          assert.deepEqual(result.incomplete_details ?? null, finish === "length" ? { reason: "max_output_tokens" } : null);
          assert.equal(result.output.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join(""), "OK");
          assert.equal(result.max_output_tokens, 2);
          assert.equal(result.usage.output_tokens, 2);
          assert.equal(captures.length, current.before + 1, "terminal outcome caused a provider replay");
          assert.equal(captures.at(-1).body.max_tokens, 2);
        });
      }
      for (const stream of [true, false]) {
        await t.test(`${route.slug}: pending ${stream ? "stream acquisition" : "nonstream completion"} cancels once`, async () => {
          const current = begin("pending"), controller = new AbortController();
          const request = post({ model: route.slug, stream }, controller.signal);
          const rejected = assert.rejects(request, { name: "AbortError" });
          await within(current.received.promise, "provider never received pending request");
          controller.abort();
          await rejected;
          await within(current.closed.promise, "pending provider connection survived caller abort", 2500);
          assert.equal(captures.length, current.before + 1);
        });
      }
      await t.test(`${route.slug}: nonstream body wait cancels after provider headers`, async () => {
        const current = begin("partial-json"), controller = new AbortController();
        const request = post({ model: route.slug }, controller.signal);
        const rejected = assert.rejects(request, { name: "AbortError" });
        await within(current.headers.promise, "provider did not send partial JSON headers");
        controller.abort();
        await rejected;
        await within(current.closed.promise, "partial JSON provider connection survived caller abort", 2500);
        assert.equal(captures.length, current.before + 1);
      });
      await t.test(`${route.slug}: acquired stream closes and completed request tolerates late abort`, async () => {
        const current = begin("acquired"), controller = new AbortController();
        const response = await post({ model: route.slug, stream: true }, controller.signal);
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        assert.equal((await reader.read()).done, false);
        controller.abort();
        await assert.rejects(reader.read(), { name: "AbortError" });
        await within(current.closed.promise, "acquired provider stream survived caller abort", 2500);
        assert.equal(captures.length, current.before + 1);
        const normal = begin("normal"), late = new AbortController();
        const completed = await post({ model: route.slug }, late.signal);
        assert.equal(completed.status, 200);
        assert.equal((await completed.json()).status, "completed");
        late.abort();
        await within(normal.closed.promise, "completed provider connection stayed open");
        assert.equal(captures.length, normal.before + 1);
      });
    }
    await t.test("configured private pipeline denies endpoint/credential spoofing without provider sends", async () => {
      const before = captures.length;
      for (const extras of [{ api_base: `http://127.0.0.1:${upstream.address().port}/v1` },
        { api_base: env.CODEX_ROUTER_API_FORWARD_BASE_URL }, { api_key: "synthetic-spoof-key" }]) {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${internal}` },
          body: JSON.stringify({ model: routes[0].gatewayModel, input: "synthetic spoof control", stream: false, tools, ...extras }),
          signal: AbortSignal.timeout(10000) });
        const failure = await response.text();
        // Endpoint denial can expose the pinned auth ValueError as 500; a
        // spoofed key can instead reach the private forwarder's 401. Preserve
        // these existing statuses while proving no provider request occurs.
        assert.ok([400, 401, 403, 500].includes(response.status), failure);
        assert.equal(captures.length, before, "spoofed request reached a provider");
      }
      assert.equal(captures.length, before, "spoofed request reached a provider");
    });
    await t.test("direct Responses and provider refusal keep their existing boundary", async () => {
      const direct = begin("direct");
      const response = await post({ model: "openrouter/deepseek-v4.1-flash-together", tools });
      assert.equal(response.status, 200, await response.text());
      assert.equal(captures.length, direct.before + 1);
      assert.equal(captures.at(-1).url, "/v1/responses");
      assert.equal(captures.at(-1).body.tools[0].parameters.$defs.word.pattern, pattern);
      const search = begin("fresh-search");
      const searched = await post({ model: routes[0].slug, tools: [{ type: "web_search" }] });
      assert.equal(searched.status, 200, await searched.text());
      assert.equal(captures.length, search.before + 1);
      assert.equal(captures.at(-1).url, "/v1/responses");
      assert.equal(captures.at(-1).body.tools[0].type, "openrouter:web_search");
      const refused = begin("refused");
      const failure = await post({ model: routes[0].slug });
      assert.equal(failure.status, 429, await failure.text());
      assert.equal(captures.length, refused.before + 1, "provider refusal was replayed");
    });
    assert.ok(captures.every(capture => capture.headers.authorization === `Bearer ${providerKey}`
      && capture.headers["chatgpt-account-id"] === undefined));
  }
});
