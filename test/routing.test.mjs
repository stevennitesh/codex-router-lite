import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { readSwitchyardConfigContract } from "../scripts/switchyard-config-contract.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const SWITCHYARD_CONTRACT = readSwitchyardConfigContract(root);

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

test("Router withholds data-only empty success after reasoning and recovers replaceable empty turns", async () => {
  let mode, attempts;
  const hop = await mockServer(async (request, response) => {
    await bodyJson(request);
    attempts += 1;
    const encode = data => `data: ${JSON.stringify(data)}\n\n`;
    const output = mode === "answer" || attempts === 2 ? [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: "real answer" }] }] : [];
    const prelude = mode === "reasoning" ? encode({ type: "response.reasoning_summary_text.delta", delta: "thinking" }) : "";
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(prelude + encode({ type: "response.completed", response: { id: "resp_data_only", status: "completed", output } })
      + (mode === "reasoning" ? "data: [DONE]\n\n" : ""));
  });
  const state = mkdtempSync(path.join(os.tmpdir(), "data-only-guard-"));
  const port = await openPort();
  const router = run("router.mjs", { CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${hop.port}/v1`,
    CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1", CODEX_ROUTER_QUIET: "1" });
  try {
    await waitFor(`${routerBase(port)}/models`, router);
    for (mode of ["reasoning", "empty", "answer"]) {
      attempts = 0;
      const response = await fetch(`${routerBase(port)}/responses`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openrouter/glm-5.3-flash", input: "Synthetic data-only completion test", stream: true }) });
      const wire = await response.text();
      assert.equal(response.status, 200, wire);
      if (mode === "reasoning") {
        assert.match(wire, /thinking/);
        assert.match(wire, /empty_completion/);
        assert.doesNotMatch(wire, /response\.completed|\[DONE\]/);
      } else {
        assert.match(wire, /real answer/);
        assert.match(wire, /response\.completed/);
        assert.doesNotMatch(wire, /empty_completion/);
      }
      assert.equal(attempts, mode === "empty" ? 2 : 1);
    }
  } finally {
    await stopChild(router);
    await closeServer(hop.server);
    rmSync(state, { recursive: true, force: true });
  }
});

for (const model of ["switchyard/auto", "openrouter/glm-5.3-flash"]) {
  test(`${model} empty-completion recovery preserves its no-redirect boundary`, async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "retry-boundary-"));
    const switchyardRoot = path.join(stateDir, "switchyard");
    mkdirSync(switchyardRoot);
    writeFileSync(path.join(switchyardRoot, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
    writeFileSync(path.join(switchyardRoot, "routes.toml"), "# fixture\n");
    writeFileSync(path.join(stateDir, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["openrouter", "switchyard"] }));
    let redirectedRequests = 0;
    const destination = await mockServer(async (request, response) => {
      redirectedRequests += 1;
      request.resume();
      json(response, 200, { output: [] });
    });
    let attempts = [];
    let outcome;
    const hop = await mockServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      attempts.push({ body: Buffer.concat(chunks), headers: request.headers });
      if (attempts.length === 2 && outcome !== "success") {
        response.writeHead(outcome, { Location: `http://127.0.0.1:${destination.port}/redirected` });
        response.end();
        return;
      }
      const output = attempts.length === 1 ? [] : [{
        type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "recovered" }],
      }];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
        id: "resp_retry_fixture", status: "completed", output,
      } })}\n\n`);
    });
    const port = await openPort();
    const router = run("router.mjs", {
      CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_SWITCHYARD_ROOT: switchyardRoot,
      CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${hop.port}/v1`,
      CODEX_ROUTER_SWITCHYARD_CAPABILITY: "synthetic-retry-capability",
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${hop.port}/v1`,
      CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1", CODEX_ROUTER_QUIET: "1",
    });
    try {
      await waitFor(`${routerBase(port)}/models`, router);
      for (outcome of [307, 308, "success"]) {
        attempts = [];
        const response = await fetch(`${routerBase(port)}/responses`, {
          method: "POST", headers: { "Content-Type": "application/json",
            Authorization: "Bearer synthetic-native-token", "chatgpt-account-id": "synthetic-account" },
          body: JSON.stringify({ model, stream: true, input: "Synthetic retry boundary test" }),
        });
        const wire = await response.text();
        assert.equal(response.status, outcome === "success" ? 200 : 502, wire);
        if (outcome === "success") assert.match(wire, /recovered/);
        else {
          assert.equal(JSON.parse(wire).error.code, "empty_completion_retry_failed");
          assert.doesNotMatch(wire, /synthetic-native-token|synthetic-account|synthetic-retry-capability|redirected/);
        }
        assert.equal(attempts.length, 2, "exactly one recovery attempt");
        assert.deepEqual(attempts[1], attempts[0], "retry preserves headers and Buffer body bytes");
        assert.equal(redirectedRequests, 0);
      }
    } finally {
      await stopChild(router);
      await Promise.all([closeServer(hop.server), closeServer(destination.server)]);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("GLM keeps colliding tool identities distinct in declarations, forced choices, and replay", async () => {
  const seen = [];
  const gateway = await mockServer(async (request, response) => {
    const body = await bodyJson(request); seen.push(body);
    const choice = body.tool_choice?.tools?.[0] ?? body.tool_choice;
    json(response, 200, { status: "completed", output: [
      { type: "function_call", name: choice.name, call_id: "forced_fixture", arguments: "{}" },
    ] });
  });
  const port = await openPort();
  const router = run("router.mjs", { CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`, CODEX_ROUTER_QUIET: "1" });
  const tools = [{ type: "function", name: "fixture__read", parameters: { type: "object" } },
    { type: "namespace", name: "fixture", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }];
  try {
    await waitFor(`${routerBase(port)}/models`, router);
    for (const choice of [{ type: "function", name: "fixture__read" }, { type: "function", namespace: "fixture", name: "read" }]) {
      let history = [{ role: "user", content: "Synthetic tool identity test" }];
      for (const tool_choice of [choice, { type: "allowed_tools", mode: "required", tools: [choice] }]) {
        const response = await fetch(`${routerBase(port)}/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "openrouter/glm-5.3-flash", tools, tool_choice, input: history, stream: false }) });
        assert.equal(response.status, 200);
        const [call] = (await response.json()).output;
        assert.equal(call.name, choice.name); assert.equal(call.namespace, choice.namespace);
        const sent = seen.at(-1), index = choice.namespace ? 1 : 0;
        assert.equal(new Set(sent.tools.map(tool => tool.name)).size, 2);
        assert.equal((sent.tool_choice.tools?.[0] ?? sent.tool_choice).name, sent.tools[index].name);
        if (history.length > 1) assert.equal(sent.input[1].name, sent.tools[index].name);
        history = [history[0], call, { type: "function_call_output", call_id: call.call_id, output: "fixture" }];
      }
    }
  } finally { await stopChild(router); await closeServer(gateway.server); }
});

test("native replay removes only foreign item IDs and unknown routed models stay local", async () => {
  const seen = [];
  const native = await mockServer(async (request, response) => {
    seen.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, {
      status: "completed",
      model: "gpt-5.6-sol",
      service_tier: "default",
      output: [],
      usage: {
        input_tokens: 12_000,
        input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 4_000 },
        output_tokens: 100,
        total_tokens: 12_100,
      },
    });
  });
  const observationRoot = mkdtempSync(path.join(os.tmpdir(), "native-attempt-observation-"));
  const observationPath = path.join(observationRoot, "attempts.jsonl");
  const switchyardCapability = "test-switchyard-observation-capability";
  const observationMarker = createHash("sha256")
    .update(switchyardCapability)
    .digest("hex");
  const port = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(port),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: switchyardCapability,
    CODEX_ROUTER_SWITCHYARD_ATTEMPT_OBSERVATION: "1",
    CODEX_ROUTER_SWITCHYARD_ATTEMPT_LOG: observationPath,
    CODEX_ROUTER_QUIET: "1",
  });
  const input = [
    { type: "message", role: "assistant", id: "chatcmpl_foreign", content: [] },
    { type: "function_call", id: "call_foreign", call_id: "paired", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "paired", output: "ok" },
    { type: "custom_tool_call", id: "tool_foreign", call_id: "custom_paired", name: "exec", input: "1" },
    { type: "custom_tool_call_output", call_id: "custom_paired", output: "1" },
    { type: "message", role: "assistant", id: "msg_native", phase: "final_answer", content: [] },
    { type: "function_call", id: "fc_native", call_id: "native", name: "lookup", arguments: "{}" },
    { type: "custom_tool_call", id: "ctc_native", call_id: "native_custom", name: "exec", input: "1" },
    { type: "item_reference", id: "msg_reference" },
  ];
  const tools = [
    { type: "function", name: "fixture_lookup", description: "Synthetic lookup", parameters: { type: "object" } },
    { type: "custom", name: "fixture_patch", description: "Synthetic patch", format: { type: "text" } },
  ];
  try {
    await waitFor(`${routerBase(port)}/models`, router);
    for (const endpoint of ["responses", "responses", "responses/compact"]) {
      const response = await fetch(`${routerBase(port)}/${endpoint}`, {
        method: "POST", headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer fixture-native",
          "session-id": "synthetic-observation-session",
          "x-codex-router-switchyard-observation": observationMarker,
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input,
          instructions: "Stable synthetic instruction prefix.",
          tools,
          tool_choice: "auto",
          prompt_cache_options: { ttl: "30m" },
          prompt_cache_key: "synthetic-stable-prefix-key",
          reasoning: { effort: "medium" },
          service_tier: "default",
        }),
      });
      assert.equal(response.status, 200, router.testErrors());
      await response.arrayBuffer();
      assert.deepEqual(seen.at(-1).body.input, input.map((item, index) => {
        if (![0, 1, 3].includes(index)) return item;
        const { id: _id, ...rest } = item;
        return rest;
      }));
      assert.equal(seen.at(-1).headers["x-codex-router-switchyard-observation"], undefined);
    }
    assert.deepEqual(seen[0].body, seen[1].body,
      "repeated answering requests preserve prefix, tool order and ids, and supported cache options");
    assert.equal(seen[0].body.prompt_cache_key, "synthetic-stable-prefix-key");
    const attempts = readFileSync(observationPath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    assert.equal(attempts.filter((record) => record.event === "native_attempt").length, 2,
      "answering requests are observed once and compaction is excluded");
    assert.deepEqual(attempts.at(-1), {
      schemaVersion: 1,
      event: "native_attempt",
      association: 1,
      request: 2,
      attempt: 1,
      model: "gpt-5.6-sol",
      effort: "medium",
      requestedTier: "default",
      compactionItems: "absent",
      elapsedMs: attempts.at(-1).elapsedMs,
      httpStatus: 200,
      outcome: "completed",
      returnedModel: "gpt-5.6-sol",
      returnedTier: "default",
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 8_000,
        cacheWriteTokens: 4_000,
        outputTokens: 100,
      },
    });
    const count = seen.length;
    const retired = await fetch(`${routerBase(port)}/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/union-alpha", input: "must stay local" }),
    });
    assert.equal(retired.status, 400);
    const retiredError = (await retired.json()).error;
    assert.equal(retiredError.code, "retired_model");
    assert.match(retiredError.message, /retired.*openrouter\/pareto/is);
    for (const model of ["openrouter/missing", "switchyard/missing", "unknown/model"]) {
      const response = await fetch(`${routerBase(port)}/responses`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: "must stay local" }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "unrouted_model");
    }
    assert.equal(seen.length, count);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(observationRoot, { recursive: true, force: true });
  }
});

test("GLM restores preflattened harness tools after a fragmented prelude and labels messages", async () => {
  const bodies = [];
  const msg = { type: "message", role: "assistant", id: "msg_fixture", content: [{ type: "output_text", text: "Checking" }] };
  const call = { type: "function_call", id: "fc_fixture", call_id: "paired", name: "harness__lookup", arguments: "{}" };
  const gateway = await mockServer(async (request, response) => {
    bodies.push(await bodyJson(request));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const prelude = frame({ type: "response.created", response: { id: "resp_fixture", metadata: { padding: "x".repeat(1100000) } } });
    response.write(prelude.slice(0, 1050000));
    await new Promise(resolve => setTimeout(resolve, 10));
    response.write(prelude.slice(1050000));
    for (const item of [msg, call]) {
      response.write(frame({ type: "response.output_item.added", item }));
      response.write(frame({ type: "response.output_item.done", item }));
    }
    response.end(frame({ type: "response.completed", response: { id: "resp_fixture", output: [msg, call] } }));
  });
  const port = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(port)}/models`, router);
    const response = await fetch(`${routerBase(port)}/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/glm-5.3-flash", stream: true, input: "lookup",
        tools: [{ type: "function", name: "harness__lookup", parameters: { type: "object" } }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ tool_namespaces_info: {
          harness: { name: "harness", functions: { lookup: { name: "lookup", direct: true, source: { kind: "harness" } } } },
        } }) },
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const events = text.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: ")).slice(6)));
    const items = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
    assert.equal(items[0].phase, "commentary");
    assert.equal(items[1].namespace, "harness");
    assert.equal(items[1].name, "lookup");
    assert.equal(bodies.length, 1, "a legitimate fragmented prelude must not trigger a retry");
    assert.equal(bodies[0].client_metadata, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

function json(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    ...headers,
  });
  response.end(body);
}

function checkpointFromCompactResponse(body) {
  const text = body?.output?.at(-1)?.content?.[0]?.text;
  assert.equal(typeof text, "string", "compact response did not end with a text checkpoint");
  const match = /BEGIN_CODEX_ROUTER_CHECKPOINT_V2\n([\s\S]+?)\nEND_CODEX_ROUTER_CHECKPOINT_V2/u.exec(
    text,
  );
  assert.ok(match, "compact response did not contain a rendered kcr2 checkpoint");
  return JSON.parse(match[1]);
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  // The router compresses large bodies on the way to the native backend, the
  // way Codex itself does on the way in, so a mock backend has to decode one.
  const body = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
  return JSON.parse(body.toString("utf8"));
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, port: address.port };
}

function run(script, env, { nodeArgs = [] } = {}) {
  // Isolate from the user's real router state.
  // unless the test provides its own state directory.
  const stateIsolation =
    env?.MODEL_ROUTER_STATE_DIR || env?.CODEX_ROUTER_STATE_DIR
      ? {}
      : { MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "routing-state-")) };
  const child = spawn(process.execPath, [...nodeArgs, path.join(root, "src", script)], {
    cwd: root,
    env: {
      ...process.env,
      ...stateIsolation,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

function relayState(catalog = { models: [{ slug: "gpt-5.6-sol" }] }) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "relay-selection-state-"));
  if (catalog === "missing") return stateDir;
  const catalogPath = path.join(stateDir, "native-models.json");
  if (catalog === "unreadable") mkdirSync(catalogPath);
  else writeFileSync(
    catalogPath,
    typeof catalog === "string" ? catalog : JSON.stringify(catalog),
  );
  return stateDir;
}

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("router preserves native auth and isolates every external route", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "native-auth-isolation-"));
  const nativeRequests = [];
  const routedRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ url: request.url, headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { route: "native", output: [] });
  });
  const gateway = await mockServer(async (request, response) => {
    const body = await bodyJson(request);
    routedRequests.push({ url: request.url, headers: request.headers, body });
    if (body.stream === false && Array.isArray(body.input)) {
      json(response, 200, {
        id: "resp-summary",
        object: "response",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "compact summary" }],
          },
        ],
      });
    } else {
      json(response, 200, { route: "external" });
    }
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const callerHeaders = {
      Authorization: "Bearer CODEX_CALLER_SECRET",
      "ChatGPT-Account-Id": "account-secret",
      "X-Codex-Installation-Id": "installation-secret",
      Traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      Tracestate: "vendor=value",
      "X-Codex-Routing-Hint": "route-affinity",
      "X-OpenAI-Fedramp": "true",
      "X-OpenAI-Internal-Codex-Residency": "us",
      "X-OpenAI-Internal-Codex-Responses-Lite": "true",
      "X-Session-Id": "session-affinity",
      "X-Private-Header": "must-not-forward",
      "Content-Type": "application/json",
    };
    const nativePayload = zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          model: "gpt-5.6-sol",
          input: "native test",
          previous_response_id: "remove-me",
          prompt_cache_retention: "24h",
          prompt_cache_options: { ttl: "30m" },
          client_metadata: {
            workspace: "caller-owned",
            "x-codex-turn-metadata": "native-canonical-turn-metadata",
          },
        }),
      ),
    );
    const nativeResponse = await fetch(
      `${routerBase(routerPort)}/responses?api_key=PROVIDER_QUERY_SECRET&source=provider`,
      {
      method: "POST",
      headers: { ...callerHeaders, "Content-Encoding": "zstd" },
      body: nativePayload,
      },
    );
    assert.equal(nativeResponse.status, 200);
    assert.equal(
      existsSync(path.join(stateDir, "native-auth-observation.json")),
      false,
      "an unrelated caller credential must not authorize the desktop native catalog",
    );

    for (const [encoding, compress] of [
      ["gzip", gzipSync],
      ["deflate", deflateSync],
      ["br", brotliCompressSync],
    ]) {
      const compressedResponse = await fetch(`${routerBase(routerPort)}/responses`, {
        method: "POST",
        headers: { ...callerHeaders, "Content-Encoding": encoding },
        body: compress(Buffer.from(JSON.stringify({
          model: "gpt-5.6-sol",
          input: `${encoding} native test`,
        }))),
      });
      assert.equal(compressedResponse.status, 200, router.testErrors());
      assert.equal(nativeRequests.at(-1).body.input, `${encoding} native test`);
    }

    const imageResponse = await fetch(`${routerBase(routerPort)}/images/generations`, {
      method: "POST",
      headers: callerHeaders,
      body: JSON.stringify({ model: "gpt-image-2", prompt: "native image test" }),
    });
    assert.equal(imageResponse.status, 200, router.testErrors());
    assert.equal(nativeRequests.at(-1).url, "/backend-api/codex/images/generations");
    assert.equal(nativeRequests.at(-1).body.prompt, "native image test");

    for (const [model, gatewayModel] of [
      ["openrouter/glm-5.3-flash", "openrouter-glm-5-3-flash"],
      ["openrouter/glm-5.3-flash-gmicloud", "openrouter-glm-5-3-flash-gmicloud"],
    ]) {
      const response = await fetch(`${routerBase(routerPort)}/responses`, {
        method: "POST",
        headers: callerHeaders,
        body: JSON.stringify({
          model,
          input: "external test",
          client_metadata: {
            workspace: "caller-owned",
            "x-codex-turn-metadata": "routed-canonical-turn-metadata",
            "x-codex-turn-state": "routed-turn-state",
          },
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(routedRequests.at(-1).body.model, gatewayModel);
    }

    assert.equal(nativeRequests[0].headers.authorization, "Bearer CODEX_CALLER_SECRET");
    assert.equal(nativeRequests[0].headers["chatgpt-account-id"], "account-secret");
    assert.equal(
      nativeRequests[0].headers.traceparent,
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    assert.equal(nativeRequests[0].headers.tracestate, "vendor=value");
    assert.equal(nativeRequests[0].headers["x-codex-routing-hint"], "route-affinity");
    assert.equal(nativeRequests[0].headers["x-openai-fedramp"], "true");
    assert.equal(nativeRequests[0].headers["x-openai-internal-codex-residency"], "us");
    assert.equal(nativeRequests[0].headers["x-openai-internal-codex-responses-lite"], "true");
    assert.equal(nativeRequests[0].headers["x-session-id"], "session-affinity");
    assert.equal(nativeRequests[0].headers["x-private-header"], undefined);
    assert.equal(nativeRequests[0].url, "/backend-api/codex/responses");
    assert.doesNotMatch(nativeRequests[0].url, /PROVIDER_QUERY_SECRET/);
    assert.equal(nativeRequests[0].body.previous_response_id, undefined);
    assert.equal(nativeRequests[0].body.prompt_cache_retention, undefined);
    assert.deepEqual(nativeRequests[0].body.prompt_cache_options, { ttl: "30m" });
    // Native OpenAI traffic owns client_metadata; only routed traffic drops it.
    assert.deepEqual(nativeRequests[0].body.client_metadata, {
      workspace: "caller-owned",
      "x-codex-turn-metadata": "native-canonical-turn-metadata",
    });
    const completedChildResponse = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: callerHeaders,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{ type: "agent_message", content: "Message Type: FINAL_ANSWER\nSender: /root/child\nPayload: done" }],
        tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "interrupt_agent" }] }],
      }),
    });
    assert.deepEqual(await completedChildResponse.json(), { route: "native", output: [] },
      "Router must not add child interrupts to a native response");
    for (const request of routedRequests) {
      assert.equal(request.headers.authorization, `Bearer ${INTERNAL_KEY}`);
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.headers["x-codex-installation-id"], undefined);
      assert.equal(request.headers.traceparent, undefined);
      assert.equal(request.headers.tracestate, undefined);
      assert.equal(request.headers["x-openai-fedramp"], undefined);
      assert.equal(request.headers["x-openai-internal-codex-residency"], undefined);
      assert.equal(request.headers["x-openai-internal-codex-responses-lite"], undefined);
      assert.equal(request.headers["x-private-header"], undefined);
      assert.equal(request.body.client_metadata, undefined);
    }
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("malformed request JSON returns safe stable diagnostics without input disclosure", async () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER_7f3b";
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = { "Content-Type": "application/json" };
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const malformed = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: `{"model":"gpt-5.6-sol","input":"${marker}"`,
    });
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json();
    assert.deepEqual(malformedBody, {
      error: {
        type: "local_router_error",
        code: "invalid_request_json",
        message: "Request body must contain valid JSON.",
      },
    });
    assert.doesNotMatch(JSON.stringify(malformedBody), new RegExp(marker));
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(router.testErrors(), new RegExp(marker));

    for (const value of [null, [], "text", 7]) {
      const response = await fetch(`${routerBase(routerPort)}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: {
          type: "local_router_error",
          code: "invalid_request_json_object",
          message: "Request JSON must be an object.",
        },
      });
    }
  } finally {
    await stopChild(router);
  }
});

test("oversized Router requests retain safe 413 diagnostics without provider traffic", async () => {
  const marker = "PRIVATE_OVERSIZE_ROUTER_MARKER";
  let gatewayRequests = 0;
  const gateway = await mockServer(async (_request, response) => {
    gatewayRequests += 1;
    json(response, 200, { output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_MAX_BODY_BYTES: "256",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/glm-5.3-flash",
        input: `${marker}:${"x".repeat(512)}`,
      }),
    });
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.deepEqual(payload, {
      error: {
        type: "local_router_error",
        code: "request_body_too_large",
        message: "Request body is too large.",
      },
    });
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(marker));
    assert.doesNotMatch(router.testErrors(), new RegExp(marker));
    assert.equal(gatewayRequests, 0);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("native agent relay selection is deterministic and fails before unavailable upstream calls", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    const body = await bodyJson(request);
    nativeRequests.push(body);
    if (body.model === "fixture-explicit-failure") {
      json(response, 404, { error: { message: "fixture model unavailable" } });
      return;
    }
    json(response, 200, { status: "completed", output: [{
      type: "function_call",
      id: "fc_deterministic",
      name: "relay_external_agent_payload",
      arguments: JSON.stringify({ payload: "DETERMINISTIC_PAYLOAD" }),
    }] });
  });
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { output: [] });
  });
  const requestBody = (token) => JSON.stringify({
    model: "openrouter/glm-5.3-flash",
    input: [{
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: token },
      ],
    }],
  });
  const runCase = async ({ catalog, override = "", token }) => {
    const stateDir = relayState(catalog);
    const port = await openPort();
    const router = run("router.mjs", {
      CODEX_ROUTER_PORT: String(port),
      CODEX_ROUTER_STATE_DIR: stateDir,
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      MODEL_ROUTER_AGENT_RELAY_MODEL: override,
      CODEX_ROUTER_QUIET: "1",
    });
    try {
      await waitFor(`${routerBase(port)}/models`, router);
      const response = await fetch(`${routerBase(port)}/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
        body: requestBody(token),
      });
      return { response, body: await response.json() };
    } finally {
      await stopChild(router);
      rmSync(stateDir, { recursive: true, force: true });
    }
  };

  try {
    const unavailable = [
      ["missing", "gAAAAA-missing-catalog="],
      ["{not-json", "gAAAAA-malformed-json="],
      [[], "gAAAAA-malformed-root="],
      [{ models: {} }, "gAAAAA-malformed-models="],
      [{ models: [{ slug: "gpt-6-astra", visibility: "list" }, { slug: "gpt-5.6-luna" }] }, "gAAAAA-sol-absent="],
      ["unreadable", "gAAAAA-unreadable-catalog="],
    ];
    for (const [catalog, token] of unavailable) {
      const nativeBefore = nativeRequests.length;
      const gatewayBefore = gatewayRequests.length;
      const { response, body } = await runCase({ catalog, token });
      assert.equal(response.status, 503);
      assert.equal(body.error.code, "native_agent_relay_unavailable");
      assert.equal(nativeRequests.length, nativeBefore, token);
      assert.equal(gatewayRequests.length, gatewayBefore, token);
    }

    const whitespace = await runCase({
      catalog: { models: [{ slug: "gpt-6-astra" }, { slug: "gpt-5.6-sol" }] },
      override: "  \t ",
      token: "gAAAAA-whitespace-override=",
    });
    assert.equal(whitespace.response.status, 200);
    assert.equal(nativeRequests.at(-1).model, "gpt-5.6-sol");

    const explicit = await runCase({
      catalog: "missing",
      override: "fixture-explicit-model",
      token: "gAAAAA-explicit-model=",
    });
    assert.equal(explicit.response.status, 200);
    assert.equal(nativeRequests.at(-1).model, "fixture-explicit-model");

    const nativeBeforeFailure = nativeRequests.length;
    const gatewayBeforeFailure = gatewayRequests.length;
    const failedExplicit = await runCase({
      catalog: { models: [{ slug: "gpt-5.6-sol" }] },
      override: "fixture-explicit-failure",
      token: "gAAAAA-explicit-failure=",
    });
    assert.equal(failedExplicit.response.status, 502);
    assert.deepEqual(
      nativeRequests.slice(nativeBeforeFailure).map(({ model }) => model),
      ["fixture-explicit-failure"],
    );
    assert.equal(gatewayRequests.length, gatewayBeforeFailure);
  } finally {
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("Switchyard projects null without a relay call when Sol selection is unavailable", async () => {
  const stateDir = relayState("missing");
  const switchyardRoot = path.join(stateDir, "switchyard-runtime");
  mkdirSync(switchyardRoot, { recursive: true });
  writeFileSync(path.join(switchyardRoot, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
  writeFileSync(path.join(switchyardRoot, "routes.toml"), "# fixture\n");
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["switchyard"] })}\n`,
  );
  let nativeRequests = 0;
  const native = await mockServer(async (_request, response) => {
    nativeRequests += 1;
    json(response, 500, {});
  });
  const switchyardRequests = [];
  const switchyard = await mockServer(async (request, response) => {
    switchyardRequests.push(await bodyJson(request));
    json(response, 200, { model: "gpt-5.6-sol", output: [] });
  });
  const port = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SWITCHYARD_ROOT: switchyardRoot,
    CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${switchyard.port}/v1`,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: "fixture-switchyard-capability",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    MODEL_ROUTER_AGENT_RELAY_MODEL: "",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(port)}/models`, router);
    const response = await fetch(`${routerBase(port)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        input: [{
          type: "agent_message",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: "gAAAAA-switchyard-no-sol=" },
          ],
        }],
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(nativeRequests, 0);
    assert.equal(switchyardRequests.length, 1);
    assert.equal(switchyardRequests[0].x_codex_router_task_projection, null);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(switchyard.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("router relays encrypted Codex subagent payloads before external routing", async () => {
  const stateDir = relayState({
    models: [{ slug: "gpt-6-astra", visibility: "list" }, { slug: "gpt-5.6-sol" }],
  });
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ headers: request.headers, body: await bodyJson(request) });
    const relayArguments = JSON.stringify({ payload: "Inspect /tmp/capture.png harshly." });
    const relayCall = {
      type: "function_call",
      id: "fc_relay",
      call_id: "call_relay",
      name: "relay_external_agent_payload",
      arguments: relayArguments,
    };
    const relayEvents = [
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_relay",
          call_id: "call_relay",
          name: "relay_external_agent_payload",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        call_id: "call_relay",
        delta: relayArguments.slice(0, 17),
      },
      {
        type: "response.function_call_arguments.delta",
        call_id: "call_relay",
        delta: relayArguments.slice(17),
      },
      {
        type: "response.function_call_arguments.done",
        call_id: "call_relay",
        arguments: relayArguments,
      },
      {
        type: "response.completed",
        response: { status: "completed", output: [relayCall] },
      },
    ];
    const event = `${relayEvents
      .map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`)
      .join("")}data: [DONE]\n\n`;
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write(event.slice(0, 37));
    response.write(event.slice(37, 103));
    response.end(event.slice(103));
  });
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_AGENT_RELAY_MODEL: "",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "ChatGPT-Account-Id": "account-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/glm-5.3-flash",
        stream: false,
        input: [
          {
            type: "agent_message",
            author: "/root",
            recipient: "/root/critic",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
              },
              { type: "encrypted_content", encrypted_content: "gAAAAA-test-payload=" },
            ],
          },
        ],
      }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");
    assert.equal(nativeRequests[0].headers["chatgpt-account-id"], "account-id");
    assert.equal(nativeRequests[0].body.model, "gpt-5.6-sol");
    assert.equal(nativeRequests[0].body.stream, true);
    assert.equal(nativeRequests[0].body.parallel_tool_calls, false);
    assert.deepEqual(nativeRequests[0].body.reasoning, { context: "all_turns" });
    assert.equal(nativeRequests[0].body.tool_choice.name, "relay_external_agent_payload");
    assert.equal(gatewayRequests.length, 1);
    const content = gatewayRequests[0].body.input[0].content;
    assert.equal(content.some((part) => part.type === "encrypted_content"), false);
    assert.equal(content.at(-1).text, "Inspect /tmp/capture.png harshly.");

    const cachedResponse = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "ChatGPT-Account-Id": "account-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/glm-5.3-flash",
        stream: false,
        input: [
          {
            type: "agent_message",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
              },
              { type: "encrypted_content", encrypted_content: "gAAAAA-test-payload=" },
            ],
          },
        ],
      }),
    });
    assert.equal(cachedResponse.status, 200, await cachedResponse.text());
    assert.equal(nativeRequests.length, 1);

    const plaintextResponse = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "ChatGPT-Account-Id": "account-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/glm-5.3-flash",
        stream: false,
        input: [
          {
            type: "agent_message",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
              },
              {
                type: "encrypted_content",
                encrypted_content: "External parent returned plaintext directly.",
              },
            ],
          },
        ],
      }),
    });
    assert.equal(plaintextResponse.status, 200, await plaintextResponse.text());
    assert.equal(nativeRequests.length, 1);
    const plaintextContent = gatewayRequests[2].body.input[0].content;
    assert.equal(plaintextContent.some((part) => part.type === "encrypted_content"), false);
    assert.equal(
      plaintextContent.at(-1).text,
      "External parent returned plaintext directly.",
    );
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("relay extraction requires one completed final call and caches only success", async () => {
  const attempts = new Map();
  const relayCall = (payload, id = "fc_relay", callId) => ({
    type: "function_call",
    id,
    ...(callId ? { call_id: callId } : {}),
    name: "relay_external_agent_payload",
    arguments: JSON.stringify({ payload }),
  });
  const sse = (response, events) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  };
  const native = await mockServer(async (request, response) => {
    const body = await bodyJson(request);
    const token = body.input?.[0]?.content?.at(-1)?.encrypted_content;
    const attempt = (attempts.get(token) || 0) + 1;
    attempts.set(token, attempt);
    if (token === "gAAAAA-failure-then-success=") {
      const call = relayCall("CACHE_ONLY_COMPLETED");
      if (attempt === 1) {
        sse(response, [
          { type: "response.output_item.added", item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.done", item_id: call.id, arguments: call.arguments },
          { type: "response.failed", response: { status: "failed", output: [call] } },
        ]);
      } else {
        sse(response, [{
          type: "response.completed",
          response: { status: "completed", output: [call] },
        }]);
      }
      return;
    }
    const call = relayCall(`payload:${token}`);
    if (token === "gAAAAA-lite-completed=") {
      sse(response, [
        { type: "response.output_item.added", item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.done", item_id: call.id, arguments: call.arguments },
        { type: "response.output_item.done", item: call },
        { type: "response.completed", response: { status: "completed", output: [] } },
      ]);
    } else if (["gAAAAA-lite-failed=", "gAAAAA-lite-incomplete=", "gAAAAA-lite-duplicate="].includes(token)) {
      const status = token.includes("failed") ? "failed" : token.includes("incomplete") ? "incomplete" : "completed";
      sse(response, [
        { type: "response.output_item.done", item: call },
        ...(token.includes("duplicate") ? [{ type: "response.output_item.done", item: call }] : []),
        { type: `response.${status}`, response: { status, output: [] } },
      ]);
    } else if (token === "gAAAAA-unicode-json=") {
      json(response, 200, {
        status: "completed",
        output: [relayCall('Unicode: café 🌍\n"quoted"')],
      });
    } else if (token === "gAAAAA-comment-crlf-sse=") {
      const completed = {
        type: "response.completed",
        response: { status: "completed", output: [relayCall("CRLF_KEEPALIVE_OK")] },
      };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`: heartbeat\r\n\r\nevent: ping\r\n\r\ndata:\r\n\r\ndata: ${JSON.stringify(completed)}\r\n\r\ndata: [DONE]\r\n\r\n`);
    } else if (token === "gAAAAA-invalid-utf8-json=") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(Buffer.concat([
        Buffer.from('{"status":"completed","output":[{"type":"function_call","id":"fc_relay","name":"relay_external_agent_payload","arguments":{"payload":"before'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('after"}}]}'),
      ]));
    } else if (token === "gAAAAA-invalid-utf8-sse=") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(Buffer.concat([
        Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [call] } })}\n\n`),
        Buffer.from(": "),
        Buffer.from([0xc3, 0x28]),
        Buffer.from("\n\n"),
      ]));
    } else if (token === "gAAAAA-unterminated-completion-sse=") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [call] } })}`);
    } else if (token === "gAAAAA-malformed-after-completion-sse=") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [call] } })}\n\ndata: {\n\n`);
    } else if (token === "gAAAAA-unfinished-after-completion-sse=") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [call] } })}\n\ndata: {"type":"error"`);
    } else if (token === "gAAAAA-duplicate-envelope-json=") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(`{"status":"failed","\\u0073tatus":"completed","output":[${JSON.stringify(call)}]}`);
    } else if (token === "gAAAAA-duplicate-arguments-json=") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "completed",
        output: [{ ...call, arguments: '{"payload":"first","pay\\u006coad":"second"}' }],
      }));
    } else if (token === "gAAAAA-duplicate-event-sse=") {
      const completed = JSON.stringify({
        type: "response.completed",
        response: { status: "failed", output: [] },
      });
      const duplicate = completed.replace(
        '"response":{"status":"failed","output":[]}',
        `"response":{"status":"failed","output":[]},"\\u0072esponse":{"status":"completed","output":[${JSON.stringify(call)}]}`,
      );
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${duplicate}\n\n`);
    } else if (token === "gAAAAA-incomplete-json=") {
      json(response, 200, { status: "incomplete", output: [call] });
    } else if (token === "gAAAAA-multiple-json=") {
      json(response, 200, { status: "completed", output: [call, relayCall("other", "fc_other")] });
    } else if (token === "gAAAAA-malformed-json-args=") {
      json(response, 200, { status: "completed", output: [{ ...call, arguments: "{" }] });
    } else if (token === "gAAAAA-missing-identity=") {
      const { id: _id, ...unidentified } = call;
      json(response, 200, { status: "completed", output: [unidentified] });
    } else if (token === "gAAAAA-missing-identity-sse=") {
      const { id: _id, ...unidentified } = call;
      sse(response, [{
        type: "response.completed",
        response: { status: "completed", output: [unidentified] },
      }]);
    } else if (token === "gAAAAA-truncated-sse=") {
      sse(response, [{ type: "response.output_item.done", item: call }]);
    } else if (token === "gAAAAA-incomplete-sse=") {
      sse(response, [
        { type: "response.output_item.added", item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.done", item_id: call.id, arguments: call.arguments },
        { type: "response.incomplete", response: { status: "incomplete", output: [call] } },
      ]);
    } else if (token === "gAAAAA-error-sse=") {
      sse(response, [
        { type: "response.output_item.added", item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.done", item_id: call.id, arguments: call.arguments },
        { type: "error", error: { code: "fixture_error" } },
      ]);
    } else if (token === "gAAAAA-unbound-sse=") {
      sse(response, [
        { type: "response.function_call_arguments.done", item_id: "fc_unknown", arguments: call.arguments },
        { type: "response.completed", response: { status: "completed", output: [call] } },
      ]);
    } else if (token === "gAAAAA-wrong-tool-sse=") {
      sse(response, [
        { type: "response.output_item.added", item: { ...call, name: "other_tool", arguments: "" } },
        { type: "response.function_call_arguments.done", item_id: call.id, arguments: call.arguments },
        { type: "response.completed", response: { status: "completed", output: [call] } },
      ]);
    } else if (token === "gAAAAA-conflict-sse=") {
      sse(response, [
        { type: "response.output_item.added", item: { ...call, arguments: "" } },
        { type: "response.completed", response: { status: "completed", output: [relayCall("conflict", "fc_conflict")] } },
      ]);
    } else if (token === "gAAAAA-call-id-conflict-sse=") {
      const observed = relayCall("observed", "fc_shared", "call_observed");
      const completed = relayCall("completed", "fc_shared", "call_changed");
      sse(response, [
        { type: "response.output_item.added", item: { ...observed, arguments: "" } },
        { type: "response.completed", response: { status: "completed", output: [completed] } },
      ]);
    } else {
      json(response, 500, { error: { message: "unexpected fixture token" } });
    }
  });
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { status: "completed", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_AGENT_RELAY_MODEL: "gpt-5.6-sol",
    CODEX_ROUTER_QUIET: "1",
  });
  const send = async (token) => fetch(`${routerBase(routerPort)}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer relay-validation-session",
      "ChatGPT-Account-Id": "relay-validation-account",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openrouter/glm-5.3-flash",
      input: [{
        type: "agent_message",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: token },
        ],
      }],
    }),
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    for (const token of [
      "gAAAAA-incomplete-json=",
      "gAAAAA-multiple-json=",
      "gAAAAA-malformed-json-args=",
      "gAAAAA-missing-identity=",
      "gAAAAA-missing-identity-sse=",
      "gAAAAA-truncated-sse=",
      "gAAAAA-incomplete-sse=",
      "gAAAAA-error-sse=",
      "gAAAAA-unbound-sse=",
      "gAAAAA-wrong-tool-sse=",
      "gAAAAA-conflict-sse=",
      "gAAAAA-call-id-conflict-sse=",
      "gAAAAA-invalid-utf8-json=",
      "gAAAAA-invalid-utf8-sse=",
      "gAAAAA-unterminated-completion-sse=",
      "gAAAAA-malformed-after-completion-sse=",
      "gAAAAA-unfinished-after-completion-sse=",
      "gAAAAA-duplicate-envelope-json=",
      "gAAAAA-duplicate-arguments-json=",
      "gAAAAA-duplicate-event-sse=",
      "gAAAAA-lite-failed=",
      "gAAAAA-lite-incomplete=",
      "gAAAAA-lite-duplicate=",
    ]) {
      const before = gatewayRequests.length;
      const response = await send(token);
      assert.equal(response.status, 502, token);
      assert.equal(gatewayRequests.length, before, `${token} reached the external provider`);
    }

    for (const [token, expected] of [
      ["gAAAAA-unicode-json=", 'Unicode: café 🌍\n"quoted"'],
      ["gAAAAA-comment-crlf-sse=", "CRLF_KEEPALIVE_OK"],
      ["gAAAAA-lite-completed=", "payload:gAAAAA-lite-completed="],
    ]) {
      const response = await send(token);
      assert.equal(response.status, 200, await response.text());
      assert.equal(gatewayRequests.at(-1).input[0].content.at(-1).text, expected);
    }

    const token = "gAAAAA-failure-then-success=";
    const failed = await send(token);
    assert.equal(failed.status, 502);
    assert.equal(attempts.get(token), 1);
    assert.equal(gatewayRequests.length, 3);
    const succeeded = await send(token);
    assert.equal(succeeded.status, 200, await succeeded.text());
    assert.equal(attempts.get(token), 2, "failed extraction must not populate the cache");
    assert.equal(gatewayRequests.at(-1).input[0].content.at(-1).text, "CACHE_ONLY_COMPLETED");
    const cached = await send(token);
    assert.equal(cached.status, 200, await cached.text());
    assert.equal(attempts.get(token), 2, "completed extraction should be reused");
    assert.equal(gatewayRequests.length, 5);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("encrypted payload relay coalesces concurrent waiters when one caller cancels", async () => {
  const relayStarted = Promise.withResolvers();
  const releaseRelay = Promise.withResolvers();
  let nativeRequests = 0;
  const native = await mockServer(async (request, response) => {
    nativeRequests += 1;
    await bodyJson(request);
    relayStarted.resolve();
    await releaseRelay.promise;
    json(response, 200, { status: "completed", output: [{
      type: "function_call",
      id: "fc_coalesced",
      name: "relay_external_agent_payload",
      arguments: JSON.stringify({ payload: "COALESCED_PAYLOAD" }),
    }] });
  });
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { status: "completed", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_AGENT_RELAY_MODEL: "gpt-5.6-sol",
    CODEX_ROUTER_QUIET: "1",
  });
  const body = JSON.stringify({
    model: "openrouter/glm-5.3-flash",
    input: [{
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAA-coalesced-payload=" },
      ],
    }],
  });
  const headers = {
    Authorization: "Bearer shared-session",
    "ChatGPT-Account-Id": "shared-account",
    "Content-Type": "application/json",
  };
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const canceledController = new AbortController();
    const canceled = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST", headers, body, signal: canceledController.signal,
    });
    const canceledResult = assert.rejects(canceled, { name: "AbortError" });
    await relayStarted.promise;
    const survivor = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST", headers, body,
    });
    let coalesced = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const health = await fetch(`${routerBase(routerPort)}/health`);
      const resources = (await health.json()).resources;
      if (resources.inFlightRequests === 2 && resources.agentPayloadCache.inFlight === 1) {
        coalesced = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(coalesced, true, router.testErrors());
    canceledController.abort();
    await canceledResult;
    releaseRelay.resolve();
    const response = await survivor;
    const responseBody = await response.text();
    assert.equal(response.status, 200, responseBody);
    assert.equal(nativeRequests, 1);
    assert.equal(gatewayRequests.length, 1);
    assert.equal(gatewayRequests[0].input[0].content.at(-1).text, "COALESCED_PAYLOAD");
  } finally {
    releaseRelay.resolve();
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("router fails closed when an encrypted subagent payload cannot be relayed", async () => {
  const native = await mockServer(async (_request, response) => {
    json(response, 401, { error: { message: "native sign-in required" } });
  });
  let gatewayRequests = 0;
  const gateway = await mockServer(async (_request, response) => {
    gatewayRequests += 1;
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_AGENT_RELAY_MODEL: "gpt-5.6-sol",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer expired-session",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/glm-5.3-flash",
        input: [
          {
            type: "agent_message",
            content: [
              { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
              { type: "encrypted_content", encrypted_content: "gAAAAA-unreadable=" },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(gatewayRequests, 0);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("rate-limited child handoffs cool down per account without reaching the gateway", async () => {
  let nativeRequests = 0;
  let gatewayRequests = 0;
  const native = await mockServer(async (_request, response) => {
    nativeRequests += 1;
    json(response, 429, { error: { message: "quota" } });
  });
  const gateway = await mockServer(async (_request, response) => {
    gatewayRequests += 1;
    json(response, 200, {});
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_AGENT_RELAY_MODEL: "gpt-5.6-sol",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    for (const account of ["account-a", "account-a", "account-b"]) {
      const response = await fetch(`${routerBase(routerPort)}/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer test-session", "chatgpt-account-id": account, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openrouter/glm-5.3-flash", input: [{
          type: "agent_message", content: [
            { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: "gAAAAA-rate-limited=" },
          ],
        }] }),
      });
      assert.equal(response.status, 429);
      await response.text();
    }
    assert.equal(nativeRequests, 2);
    assert.equal(gatewayRequests, 0);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("Switchyard preserves native requests and leaves compaction on the native backend", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "switchyard-routing-state-"));
  const switchyardRoot = path.join(stateDir, "switchyard-runtime");
  mkdirSync(switchyardRoot, { recursive: true });
  writeFileSync(path.join(switchyardRoot, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
  writeFileSync(path.join(switchyardRoot, "routes.toml"), "# fixture\n");
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["switchyard"] })}\n`,
    { mode: 0o600 },
  );
  const switchyardRequests = [];
  const switchyard = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 503, { status: "degraded" });
      return;
    }
    const requestBody = await bodyJson(request);
    switchyardRequests.push({
      url: request.url,
      headers: request.headers,
      body: requestBody,
    });
    if (JSON.stringify(requestBody.input).includes("SWITCHYARD_429")) {
      response.setHeader("Retry-After", "120");
      json(response, 429, {
        error: { message: "switchyard target is rate limited", type: "rate_limit_error" },
      });
      return;
    }
    if (requestBody.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        'data: {"type":"response.output_text.delta","delta":"switchyard-stream"}\n\n' +
        'data: {"type":"response.completed","response":{"id":"switchyard-stream","model":"gpt-6-astra","output":[]}}\n\n' +
        "data: [DONE]\n\n",
      );
      return;
    }
    json(response, 200, { id: "switchyard-response", model: "gpt-6-astra", output: [] });
  });
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    const observed = {
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    };
    nativeRequests.push(observed);
    if (observed.body.input?.at(-1)?.type === "compaction_trigger") {
      const item = { id: "cmp_switchyard", type: "compaction", encrypted_content: "gAAAAA-compacted=" };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "native-v2-compaction", status: "completed", model: "gpt-5.6-sol", output: [item] } })}\n\n` +
        "data: [DONE]\n\n",
      );
      return;
    }
    if (observed.body.model === "gpt-6-astra") {
      json(response, 200, {
        id: "astra-direct",
        model: "gpt-6-astra",
        output: [{
          id: "rs_astra_history",
          type: "reasoning",
          encrypted_content: "gAAAAA-astra-history=",
          summary: [],
        }],
      });
      return;
    }
    json(response, 200, { id: "native-compaction", output: [] });
  });
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push({ url: request.url, body: await bodyJson(request) });
    json(response, 200, { id: "unexpected-gateway", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_SWITCHYARD_ROOT: switchyardRoot,
    CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${switchyard.port}/v1`,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: "test-switchyard-local-hop-capability",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${native.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${native.port}/health`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: "Bearer CHATGPT_SESSION_TOKEN",
    "ChatGPT-Account-Id": "account-id",
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const directAstra = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-6-astra", input: "produce Astra history" }),
    });
    assert.equal(directAstra.status, 200);
    const directAstraBody = await directAstra.json();
    assert.equal(directAstraBody.model, "gpt-6-astra");
    assert.equal(nativeRequests[0].body.model, "gpt-6-astra");
    const input = [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `route me ${"x".repeat(20_000)}` },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "original" },
      ],
    }, ...directAstraBody.output];
    const tools = [
      { type: "function", name: "mcp__example__read", description: "Read", parameters: { type: "object" } },
      { type: "custom", name: "apply_patch", description: "Patch", format: { type: "text" } },
      { type: "web_search", search_context_size: "medium" },
    ];
    const nativeControls = {
      text: { verbosity: "low" },
      parallel_tool_calls: true,
      tool_choice: "auto",
      include: ["reasoning.encrypted_content"],
      service_tier: "priority",
    };
    const turn = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "switchyard/auto",
        input,
        tools,
        reasoning: { effort: "xhigh" },
        ...nativeControls,
        stream: false,
      }),
    });
    assert.equal(turn.status, 200);
    assert.equal((await turn.json()).model, "switchyard/auto");
    assert.equal(switchyardRequests.length, 1);
    assert.equal(switchyardRequests[0].url, "/v1/responses");
    assert.equal(switchyardRequests[0].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");
    assert.equal(switchyardRequests[0].headers["chatgpt-account-id"], "account-id");
    assert.equal(
      switchyardRequests[0].headers["x-codex-router-switchyard-capability"],
      "test-switchyard-local-hop-capability",
    );
    assert.equal(switchyardRequests[0].headers["content-encoding"], undefined);
    assert.equal(switchyardRequests[0].body.model, SWITCHYARD_CONTRACT.dispatchId);
    assert.deepEqual(switchyardRequests[0].body.input, input);
    assert.deepEqual(switchyardRequests[0].body.tools, tools);
    assert.deepEqual(switchyardRequests[0].body.reasoning, { effort: "xhigh" });
    for (const [field, value] of Object.entries(nativeControls)) {
      assert.deepEqual(switchyardRequests[0].body[field], value);
    }
    assert.equal(gatewayRequests.length, 0);

    const streamed = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "switchyard/auto", input, stream: true }),
    });
    assert.equal(streamed.status, 200);
    const streamedText = await streamed.text();
    assert.match(streamedText, /switchyard-stream/);
    assert.match(streamedText, /"model":"switchyard\/auto"/u);
    assert.doesNotMatch(streamedText, /"model":"gpt-6-astra"/u);
    assert.equal(switchyardRequests.length, 2);

    const rateLimited = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "switchyard/auto",
        input: [{ type: "message", role: "user", content: "SWITCHYARD_429" }],
      }),
    });
    assert.equal(rateLimited.status, 429);
    assert.match(await rateLimited.text(), /switchyard target is rate limited/);
    assert.equal(switchyardRequests.length, 3);
    assert.equal(gatewayRequests.length, 0);

    const compact = await fetch(`${routerBase(routerPort)}/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "switchyard/auto", input }),
    });
    assert.equal(compact.status, 200);
    assert.equal(switchyardRequests.length, 3);
    assert.equal(nativeRequests.length, 2);
    assert.equal(nativeRequests[1].url, "/backend-api/codex/responses/compact");
    assert.equal(nativeRequests[1].body.model, "gpt-5.6-sol");
    assert.equal(nativeRequests[1].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");
    assert.equal(nativeRequests[1].headers["chatgpt-account-id"], "account-id");
    assert.equal(nativeRequests[1].headers["x-codex-router-switchyard-capability"], undefined);
    assert.equal(nativeRequests[1].headers["content-encoding"], "zstd");

    const compactV2 = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "switchyard/auto",
        input: [...input, { type: "compaction_trigger" }],
        stream: true,
      }),
    });
    assert.equal(compactV2.status, 200);
    assert.match(await compactV2.text(), /cmp_switchyard/u);
    assert.equal(switchyardRequests.length, 3);
    assert.equal(nativeRequests.length, 3);
    assert.equal(nativeRequests[2].url, "/backend-api/codex/responses");
    assert.equal(nativeRequests[2].body.model, "gpt-5.6-sol");
    assert.equal(nativeRequests[2].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");
    assert.equal(nativeRequests[2].headers["chatgpt-account-id"], "account-id");
    assert.equal(nativeRequests[2].headers["x-codex-router-switchyard-capability"], undefined);
    assert.equal(nativeRequests[2].headers["content-encoding"], "zstd");

    const health = await fetch(`${routerBase(routerPort)}/health`);
    assert.equal(health.status, 503);
    const healthBody = await health.json();
    assert.deepEqual(healthBody.degraded, ["switchyard"]);
    assert.equal(healthBody.switchyard.reachable, false);
    assert.equal("activity" in healthBody, false);
    assert.equal("activityRecordRetentionMs" in healthBody.resources, false);
    assert.equal(healthBody.resources.inFlightRequests, 0);
    assert.equal(healthBody.resources.maxActiveRequests, 64);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    await closeServer(native.server);
    await closeServer(switchyard.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Switchyard classifies only the current authenticated task projection", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "switchyard-child-projection-"));
  const switchyardRoot = path.join(stateDir, "switchyard-runtime");
  mkdirSync(switchyardRoot, { recursive: true });
  writeFileSync(path.join(switchyardRoot, process.platform === "win32" ? "switchyard-server.exe" : "switchyard-server"), "fixture");
  writeFileSync(path.join(switchyardRoot, "routes.toml"), "# fixture\n");
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["switchyard"] })}\n`,
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] }),
  );
  const plaintextByToken = new Map([
    ["gAAAAA-current-task=", "CURRENT_TASK"],
    ["gAAAAA-oversize-task=", "x".repeat(32 * 1024 + 1)],
  ]);
  const slowRelayStarted = Promise.withResolvers();
  const deadlineRelayStarted = Promise.withResolvers();
  const releaseDeadlineRelay = Promise.withResolvers();
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    const body = await bodyJson(request);
    nativeRequests.push({ headers: request.headers, body });
    const token = body.input?.at(-1)?.content?.at(-1)?.encrypted_content;
    if (["gAAAAA-failed-terminal-task=", "gAAAAA-incomplete-terminal-task="].includes(token)) {
      const status = token.includes("incomplete") ? "incomplete" : "failed";
      const call = {
        type: "function_call",
        id: `fc_${status}`,
        call_id: `call_${status}`,
        name: "relay_external_agent_payload",
        arguments: JSON.stringify({ payload: `PARTIAL_${status.toUpperCase()}_TASK` }),
      };
      const events = [
        { type: "response.output_item.added", item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.done", call_id: call.call_id, arguments: call.arguments },
        { type: `response.${status}`, response: { status, output: [call] } },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
      return;
    }
    if (token === "gAAAAA-slow-task=") {
      slowRelayStarted.resolve();
      await new Promise(resolve => response.once("close", resolve));
      return;
    }
    if (token === "gAAAAA-deadline-task=") {
      deadlineRelayStarted.resolve();
      await releaseDeadlineRelay.promise;
      json(response, 200, { status: "completed", output: [{
        type: "function_call",
        id: "fc_deadline",
        name: "relay_external_agent_payload",
        arguments: JSON.stringify({ payload: "DEADLINE_SHARED_TASK" }),
      }] });
      return;
    }
    const plaintext = plaintextByToken.get(token);
    if (plaintext === undefined) {
      json(response, 200, { status: "completed", output: [] });
      return;
    }
    json(response, 200, { status: "completed", output: [{
      type: "function_call",
      id: "fc_projection",
      name: "relay_external_agent_payload",
      arguments: JSON.stringify({ payload: plaintext }),
    }] });
  });
  const switchyardRequests = [];
  const switchyardAffinity = new Map();
  const switchyard = await mockServer(async (request, response) => {
    const body = await bodyJson(request);
    switchyardRequests.push(body);
    let threadId;
    try {
      const encoded = body.client_metadata?.["x-codex-turn-metadata"];
      threadId = typeof encoded === "string" ? JSON.parse(encoded).thread_id : undefined;
    } catch {}
    let selected = threadId ? switchyardAffinity.get(threadId) : undefined;
    if (body.x_codex_router_task_projection === null) selected = "switchyard/sol-medium";
    else if (typeof body.x_codex_router_task_projection === "string") {
      selected = body.x_codex_router_task_projection.includes("Review")
        ? "switchyard/astra-medium"
        : "switchyard/sol-medium";
    }
    selected ||= "switchyard/sol-medium";
    if (threadId) switchyardAffinity.set(threadId, selected);
    json(
      response,
      200,
      { id: "projection", model: "gpt-5.6-sol", output: [] },
      { "x-switchyard-selected-model": selected },
    );
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SWITCHYARD_ROOT: switchyardRoot,
    CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://127.0.0.1:${switchyard.port}/v1`,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: "test-switchyard-local-hop-capability",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    MODEL_ROUTER_AGENT_RELAY_MODEL: "",
    CODEX_ROUTER_QUIET: "1",
  });
  const task = (token, type = "NEW_TASK", extra = []) => ({
    type: "agent_message",
    content: [
      { type: "input_text", text: `Message Type: ${type}\nTask name: /root/child\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: token },
      ...extra,
    ],
  });
  const headers = (account = "account-a") => ({
    Authorization: "Bearer CHATGPT_SESSION_TOKEN",
    "ChatGPT-Account-Id": account,
    "Content-Type": "application/json",
  });
  const send = async (input, account = "account-a", extraBody = {}) => {
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: headers(account),
      body: JSON.stringify({
        model: "switchyard/auto",
        input,
        ...extraBody,
        x_codex_router_task_projection: "CALLER_SPOOF",
      }),
    });
    assert.equal(response.status, 200, await response.text());
    return response.headers.get("x-switchyard-selected-model");
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const old = task("gAAAAA-old-task=");
    const current = task("gAAAAA-current-task=");
    await send([old, current]);
    assert.equal(nativeRequests.length, 1);
    assert.deepEqual(switchyardRequests[0].input, [old, current]);
    assert.equal(switchyardRequests[0].x_codex_router_task_projection, "CURRENT_TASK");

    // The second request uses the account-scoped relay cache. A different
    // account must not reuse it.
    await send([current]);
    assert.equal(nativeRequests.length, 1);
    await send([current], "account-b");
    assert.equal(nativeRequests.length, 2);

    // A tool continuation retains Switchyard affinity and does not substitute
    // the preceding handoff as a fresh task.
    await send([current, { type: "function_call_output", call_id: "call-1", output: "ok" }]);
    assert.equal(nativeRequests.length, 2);
    assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);

    await send([task("READABLE_FOLLOWUP", "FOLLOWUP_TASK")]);
    assert.equal(nativeRequests.length, 2);
    assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, "READABLE_FOLLOWUP");

    // Parseable relay arguments followed by an unsuccessful terminal never
    // become classifier text. Switchyard receives the original encrypted input
    // plus a null projection, which selects its existing zero-Jev fallback.
    for (const token of [
      "gAAAAA-failed-terminal-task=",
      "gAAAAA-incomplete-terminal-task=",
    ]) {
      const input = [task(token)];
      const selected = await send(input);
      const forwarded = switchyardRequests.at(-1);
      assert.deepEqual(forwarded.input, input);
      assert.equal(forwarded.x_codex_router_task_projection, null);
      assert.equal(selected, "switchyard/sol-medium");
      assert.doesNotMatch(JSON.stringify(forwarded), /PARTIAL_(?:FAILED|INCOMPLETE)_TASK/);
    }
    const nativeAfterRejectedTerminals = nativeRequests.length;
    assert.equal(nativeAfterRejectedTerminals, 4);

    const appTurn = "01a0be86-5a57-7733-930c-b715dee4edc5";
    const appThread = "01a0be80-76c5-7d67-8dd4-f4ff86e5e126";
    const sourceThread = "01a070b8-92cb-72d0-995e-4c34ae25dd53";
    const appDelivery = (overrides = {}) => ({
      type: "function_call_output",
      id: `fco_${appTurn}`,
      name: "send_message_to_thread",
      namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${sourceThread}</source_thread_id>\n  <input>Review A &amp; B &gt; C</input>\n</codex_delegation>`,
      internal_chat_message_metadata_passthrough: { turn_id: appTurn, create_time: 1 },
      ...overrides,
    });
    const appMetadata = (turnId = appTurn) => ({
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ turn_id: turnId, thread_id: appThread }),
      },
    });

    // App-created task and follow-up delivery are standalone function outputs.
    // The exact final-item contract exposes only the delegated input to Jev
    // while preserving the native answer input.
    const currentAppDelivery = appDelivery({ name: "create_thread" });
    delete currentAppDelivery.internal_chat_message_metadata_passthrough;
    const appSelected = await send([currentAppDelivery], "account-a", appMetadata());
    assert.deepEqual(switchyardRequests.at(-1).input, [currentAppDelivery]);
    assert.equal(
      switchyardRequests.at(-1).x_codex_router_task_projection,
      "Review A & B > C",
    );
    assert.equal(
      nativeRequests.length,
      nativeAfterRejectedTerminals,
      "plaintext app delivery must not use native relay",
    );
    assert.equal(appSelected, "switchyard/astra-medium");

    // Ordinary tool continuation retains affinity.
    const continuation = { type: "function_call_output", call_id: "call-app", output: "ok" };
    const continuationSelected = await send(
      [currentAppDelivery, continuation],
      "account-a",
      appMetadata(),
    );
    assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);
    assert.deepEqual(switchyardRequests.at(-1).input, [currentAppDelivery, continuation]);
    assert.equal(
      continuationSelected,
      "switchyard/astra-medium",
      "ordinary continuation must retain non-Sol affinity through the local integration path",
    );

    // A paired lookalike is an ordinary tool result even when every app
    // delivery field and envelope is otherwise valid. Null remains unpaired.
    const lookalikeSelected = await send(
      [appDelivery({ call_id: "call-app-lookalike" })],
      "account-a",
      appMetadata(),
    );
    assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);
    assert.equal(lookalikeSelected, "switchyard/astra-medium");
    const nullCallId = appDelivery({ call_id: null });
    await send([nullCallId], "account-a", appMetadata());
    assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, "Review A & B > C");
    assert.deepEqual(switchyardRequests.at(-1).input, [nullCallId]);

    // A task cannot delegate to itself. UUID hex case does not create a
    // distinct identity, and self-delivery retains the selected target.
    const selfDelivery = appDelivery({
      output: `<codex_delegation>\n  <source_thread_id>${appThread.toUpperCase()}</source_thread_id>\n  <input>Do not reclassify this</input>\n</codex_delegation>`,
    });
    const selfSelected = await send([selfDelivery], "account-a", appMetadata());
    assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);
    assert.equal(selfSelected, "switchyard/astra-medium");

    // A same-operation item explicitly linked to an earlier turn is historical
    // even when it is the final item in the replayed current-turn request.
    await send([appDelivery()], "account-a", appMetadata("01a0be90-0000-7000-8000-000000000000"));
    assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);

    const nextTurn = "01a0be87-401d-79b3-b3d2-2c5a69f54eb9";
    const nextDelivery = appDelivery({
      id: `fco_${nextTurn}`,
      output: `<codex_delegation>\n  <source_thread_id>${sourceThread}</source_thread_id>\n  <input>Architecture review only</input>\n</codex_delegation>`,
      internal_chat_message_metadata_passthrough: { turn_id: nextTurn, create_time: 2 },
    });
    await send([nextDelivery], "account-a", appMetadata(nextTurn));
    assert.equal(
      switchyardRequests.at(-1).x_codex_router_task_projection,
      "Architecture review only",
    );

    // Structurally current deliveries with malformed envelopes or oversized
    // input release affinity to the zero-Jev Sol fallback.
    for (const invalid of [
      { item: appDelivery({ id: "fco_not-a-native-id" }), metadata: appMetadata() },
      { item: appDelivery({ id: [`fco_${appTurn}`] }), metadata: appMetadata() },
      { item: appDelivery({ internal_chat_message_metadata_passthrough: { turn_id: "invalid", create_time: 1 } }), metadata: appMetadata() },
      { item: appDelivery({ internal_chat_message_metadata_passthrough: { turn_id: [appTurn], create_time: 1 } }), metadata: appMetadata() },
      { item: appDelivery({ output: "<codex_delegation>\n  <source_thread_id>invalid</source_thread_id>\n  <input>missing source identity</input>\n</codex_delegation>" }), metadata: appMetadata() },
      { item: appDelivery({ output: "prefix <codex_delegation>not canonical</codex_delegation>" }), metadata: appMetadata() },
      { item: appDelivery({ output: "<codex_delegation>\n  <source_thread_id>01a070b8-92cb-72d0-995e-4c34ae25dd53</source_thread_id>\n  <input>raw <shape> tag</input>\n</codex_delegation>" }), metadata: appMetadata() },
      { item: appDelivery({ output: "<codex_delegation>\n  <source_thread_id>01a070b8-92cb-72d0-995e-4c34ae25dd53</source_thread_id>\n  <input>ambiguous &unknown; entity</input>\n</codex_delegation>" }), metadata: appMetadata() },
      { item: appDelivery({ output: `<codex_delegation>\n  <source_thread_id>01a070b8-92cb-72d0-995e-4c34ae25dd53</source_thread_id>\n  <input>${"x".repeat(32 * 1024 + 1)}</input>\n</codex_delegation>` }), metadata: appMetadata() },
    ]) {
      await send([invalid.item], "account-a", invalid.metadata);
      assert.deepEqual(switchyardRequests.at(-1).input, [invalid.item]);
      assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, null);
    }

    // Ambiguous current-turn metadata cannot qualify an app delivery.
    const duplicateTurnMetadata = {
      client_metadata: {
        "x-codex-turn-metadata": `{"turn_id":"${appTurn}","turn_id":"${appTurn}","thread_id":"${appThread}"}`,
      },
    };
    await send([appDelivery()], "account-a", duplicateTurnMetadata);
    assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, null);

    // Missing, invalid, or ambiguous receiver identity is a recognized new
    // assignment with no safe projection, so Switchyard takes its zero-Jev Sol fallback.
    for (const metadata of [
      { client_metadata: {} },
      { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: appTurn }) } },
      { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: [appTurn], thread_id: appThread }) } },
      { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: appTurn, thread_id: "invalid" }) } },
      { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: appTurn, thread_id: [appThread] }) } },
      { client_metadata: { "x-codex-turn-metadata": `{"turn_id":"${appTurn}","thread_id":"${appThread}","thread_id":"${appThread}"}` } },
    ]) {
      await send([appDelivery()], "account-a", metadata);
      assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, null);
    }

    // A wrapper-shaped arbitrary tool output has no app-delivery authority.
    const spoofedApp = appDelivery({ namespace: "untrusted_app" });
    await send([spoofedApp], "account-a", appMetadata());
    assert.deepEqual(switchyardRequests.at(-1).input, [spoofedApp]);
    assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);
    const tuiDelivery = appDelivery({ namespace: "codex_tui" });
    await send([tuiDelivery], "account-a", appMetadata());
    assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);

    // Ambiguous content, completed-child traffic, relay failure, and an
    // oversized projection all reach unchanged Switchyard input with no Jev
    // projection and no caller-spoofed substitute.
    for (const input of [
      [task("gAAAAA-current-task=", "NEW_TASK", [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }])],
      [task("gAAAAA-current-task=", "FINAL_ANSWER")],
      [task("gAAAAA-malformed-relay=")],
      [task("gAAAAA-oversize-task=")],
    ]) {
      const before = nativeRequests.length;
      await send(input);
      assert.deepEqual(switchyardRequests.at(-1).input, input);
      const completed = input[0].content[0].text.includes("FINAL_ANSWER");
      if (completed) {
        assert.equal("x_codex_router_task_projection" in switchyardRequests.at(-1), false);
      } else {
        assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, null);
      }
      if (input[0].content.length !== 2 || completed) {
        assert.equal(nativeRequests.length, before);
      }
    }

    const deadlineInput = [task("gAAAAA-deadline-task=")];
    const deadlineBody = JSON.stringify({ model: "switchyard/auto", input: deadlineInput });
    const deadlineStarted = Date.now();
    const timedOut = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST", headers: headers(), body: deadlineBody,
    });
    await deadlineRelayStarted.promise;
    await new Promise(resolve => setTimeout(resolve, 250));
    const survivor = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST", headers: headers(), body: deadlineBody,
    });
    const timedOutResponse = await timedOut;
    const deadlineElapsed = Date.now() - deadlineStarted;
    assert.equal(timedOutResponse.status, 200, await timedOutResponse.text());
    assert.ok(deadlineElapsed >= 4_500 && deadlineElapsed < 7_500, `${deadlineElapsed}ms`);
    assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, null);
    releaseDeadlineRelay.resolve();
    const survivorResponse = await survivor;
    assert.equal(survivorResponse.status, 200, await survivorResponse.text());
    assert.equal(switchyardRequests.at(-1).x_codex_router_task_projection, "DEADLINE_SHARED_TASK");

    const beforeCanceled = switchyardRequests.length;
    const cancel = new AbortController();
    const canceled = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: headers(),
      signal: cancel.signal,
      body: JSON.stringify({ model: "switchyard/auto", input: [task("gAAAAA-slow-task=")] }),
    });
    await slowRelayStarted.promise;
    cancel.abort();
    await assert.rejects(canceled, { name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(switchyardRequests.length, beforeCanceled);
  } finally {
    releaseDeadlineRelay.resolve();
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(switchyard.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("OpenRouter GLM sends fresh hosted search through the direct Responses hop", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "openrouter-hosted-search-router-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["openrouter"] })}\n`,
  );
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 500, { error: { message: "hosted search must bypass LiteLLM" } });
  });
  const apiRequests = [];
  const api = await mockServer(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, { ok: true, credential_present: true });
      return;
    }
    apiRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, {
      id: "resp_hosted_search",
      object: "response",
      status: "completed",
      output: [
        {
          type: "openrouter:web_search",
          id: "ws_live",
          status: "completed",
          action: {
            type: "search",
            query: "current docs",
            sources: [{ type: "url", url: "https://openrouter.ai/docs" }],
          },
        },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{
            type: "output_text",
            text: "Current.",
            annotations: [{ type: "url_citation", url: "https://openrouter.ai/docs" }],
          }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        server_tool_use_details: { web_search_requests: 1 },
      },
    });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${api.port}/v1`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${api.port}/health`,
    OPENROUTER_API_KEY: "TEST_OPENROUTER_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/glm-5.3-flash",
        stream: false,
        input: [
          {
            type: "web_search_call",
            id: "ws_previous",
            status: "completed",
            action: { type: "search", query: "previous docs" },
          },
          { type: "message", role: "user", content: "Refresh it." },
        ],
        tools: [
          { type: "web_search", search_context_size: "medium" },
          { type: "function", name: "web_search", parameters: { type: "object" } },
        ],
        tool_choice: { type: "web_search" },
        include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
      }),
    });
    const bodyText = await response.text();
    assert.equal(response.status, 200, bodyText);
    const body = JSON.parse(bodyText);
    assert.equal(gatewayRequests.length, 0);
    assert.equal(apiRequests.length, 1);
    assert.equal(apiRequests[0].headers.authorization, `Bearer ${INTERNAL_KEY}`);
    assert.equal(apiRequests[0].body.input[0].type, "openrouter:web_search");
    assert.equal(apiRequests[0].body.tool_choice.type, "openrouter:web_search");
    const serverSearch = apiRequests[0].body.tools.find(
      (tool) => tool.type === "openrouter:web_search",
    );
    assert.deepEqual(serverSearch.parameters, {
      engine: "exa",
      mode: "fast",
      max_results: 5,
      max_total_results: 15,
      max_uses: 3,
      search_context_size: "medium",
    });
    assert.ok(apiRequests[0].body.tools.some(
      (tool) => tool.type === "function" && tool.name === "web_search",
    ));
    assert.deepEqual(apiRequests[0].body.include, ["reasoning.encrypted_content"]);
    assert.equal(apiRequests[0].body.max_tool_calls, 3);
    assert.equal(body.output[0].type, "web_search_call");
    assert.deepEqual(body.output[0].action.sources, [
      { type: "url", url: "https://openrouter.ai/docs" },
    ]);
    assert.deepEqual(body.output[1].content[0].annotations, [
      { type: "url_citation", url: "https://openrouter.ai/docs" },
    ]);
    assert.equal(body.usage.server_tool_use_details.web_search_requests, 1);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(gateway.server), closeServer(api.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("OpenRouter GLM replays completed search history through the ordinary route", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "openrouter-glm-search-history-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["openrouter"] })}\n`,
  );
  const requests = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, { ok: true, credential_present: true, credential_source: "test" });
      return;
    }
    requests.push(await bodyJson(request));
    json(response, 200, {
      id: "resp_search_history",
      object: "response",
      status: "completed",
      output: [],
    });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    OPENROUTER_API_KEY: "TEST_OPENROUTER_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });
  const input = [
    {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "Codex Router compatibility" },
    },
    { type: "message", role: "user", content: "Use the completed search result." },
  ];
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/glm-5.3-flash", input }),
    });
    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].input, input);
    assert.equal(requests[0].web_search_options, undefined);
    assert.equal(requests[0].tools, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("router repairs malformed OpenRouter GLM-5.3-Flash message envelopes after LiteLLM translation", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "openrouter-glm-responses-compat-router-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["openrouter"] })}\n`,
  );
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, { ok: true, credential_present: true, credential_source: "test" });
      return;
    }
    await bodyJson(request);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "response.output_item.added", output_index: 0, model: "openrouter-glm-5-3-flash", item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: [] } },
      { type: "response.output_item.done", output_index: 0, sequence_number: 6, model: "openrouter-glm-5-3-flash", item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", model: "openrouter-glm-5-3-flash", delta: "ROUTER_OK" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_1", model: "openrouter-glm-5-3-flash", text: "ROUTER_OK" },
      { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "msg_1", model: "openrouter-glm-5-3-flash", part: { type: "reasoning_text", reasoning: "private reasoning" } },
      { type: "response.output_item.done", output_index: 0, sequence_number: 1, model: "openrouter-glm-5-3-flash", item: { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ROUTER_OK", annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    OPENROUTER_API_KEY: "TEST_OPENROUTER_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/glm-5.3-flash", input: "test", stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const events = text.split(/\r?\n/)
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    const deltaIndex = events.findIndex((event) => event.type === "response.output_text.delta");
    assert.equal(events[deltaIndex - 2]?.type, "response.output_item.added");
    assert.equal(events[deltaIndex - 2]?.item?.type, "message");
    assert.equal(events[deltaIndex - 2]?.output_index, 1);
    assert.equal(events[deltaIndex - 1]?.type, "response.content_part.added");
    assert.equal(events[deltaIndex]?.output_index, 1);
    const partDone = events.find((event) => event.type === "response.content_part.done");
    assert.deepEqual(partDone?.part, { type: "output_text", text: "ROUTER_OK", annotations: [] });
    assert.ok(!text.includes("private reasoning"));
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});
