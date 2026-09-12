import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

test("native replay removes only foreign item IDs and unknown routed models stay local", async () => {
  const seen = [];
  const native = await mockServer(async (request, response) => {
    seen.push(await bodyJson(request));
    json(response, 200, { output: [] });
  });
  const port = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(port),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
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
  try {
    await waitFor(`${routerBase(port)}/models`, router);
    for (const endpoint of ["responses", "responses/compact"]) {
      const response = await fetch(`${routerBase(port)}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-native" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input }),
      });
      assert.equal(response.status, 200, router.testErrors());
      await response.arrayBuffer();
      assert.deepEqual(seen.at(-1).input, input.map((item, index) => {
        if (![0, 1, 3].includes(index)) return item;
        const { id: _id, ...rest } = item;
        return rest;
      }));
    }
    const count = seen.length;
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

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
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

test("router relays encrypted Codex subagent payloads before external routing", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ headers: request.headers, body: await bodyJson(request) });
    const relayArguments = JSON.stringify({ payload: "Inspect /tmp/capture.png harshly." });
    const relayEvents = [
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_relay",
          name: "relay_external_agent_payload",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_relay",
        delta: relayArguments.slice(0, 17),
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_relay",
        delta: relayArguments.slice(17),
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_relay",
        arguments: relayArguments,
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
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
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
        'data: {"type":"response.completed","response":{"id":"switchyard-stream","output":[]}}\n\n' +
        "data: [DONE]\n\n",
      );
      return;
    }
    json(response, 200, { id: "switchyard-response", output: [] });
  });
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    nativeRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
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
    const input = [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `route me ${"x".repeat(20_000)}` },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "original" },
      ],
    }];
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
    assert.equal(switchyardRequests.length, 1);
    assert.equal(switchyardRequests[0].url, "/v1/responses");
    assert.equal(switchyardRequests[0].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");
    assert.equal(switchyardRequests[0].headers["chatgpt-account-id"], "account-id");
    assert.equal(
      switchyardRequests[0].headers["x-codex-router-switchyard-capability"],
      "test-switchyard-local-hop-capability",
    );
    assert.equal(switchyardRequests[0].headers["content-encoding"], undefined);
    assert.equal(switchyardRequests[0].body.model, "gpt-5.6-sol");
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
    assert.match(await streamed.text(), /switchyard-stream/);
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
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].url, "/backend-api/codex/responses/compact");
    assert.equal(nativeRequests[0].body.model, "gpt-5.6-sol");
    assert.equal(nativeRequests[0].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");

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
