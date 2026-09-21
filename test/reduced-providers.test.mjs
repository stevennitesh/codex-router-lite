import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderLiteLlmConfig } from "../src/litellm-config.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-internal-key-with-sufficient-length";

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
  response.end(body);
}

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", resolve);
  });
  return { instance, port: instance.address().port };
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`forwarder exited ${child.exitCode}`);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${internalKey}` } });
      if (response.status === 200) return;
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("forwarder did not become ready");
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

test("checked-in routed config contains only GLM, Pareto, and Switchyard", () => {
  const jsonFiles = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith(".json")) jsonFiles.push(path.relative(root, target).replaceAll("\\", "/"));
    }
  };
  walk(path.join(root, "config"));
  assert.deepEqual(jsonFiles.sort(), [
    "config/openrouter/glm-5.3-flash-gmicloud.json",
    "config/openrouter/glm-5.3-flash.json",
    "config/openrouter/openrouter.json",
    "config/openrouter/pareto.json",
    "config/switchyard/auto.json",
    "config/switchyard/switchyard.json",
  ]);
});

test("LiteLLM config owns only the ordinary OpenRouter GLM hop", () => {
  const config = renderLiteLlmConfig();
  assert.match(config, /openrouter-glm-5-3-flash/u);
  assert.match(config, /openrouter-glm-5-3-flash-gmicloud/u);
  assert.match(config, /^general_settings:\r?\n  allow_client_side_credentials: false$/mu);
  assert.doesNotMatch(config, /pareto|union-alpha|switchyard|fallback|failover/u);
});

test("OpenRouter hop applies the selected endpoint contract and accepts only translated search", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "router-lite-provider-"));
  writeFileSync(path.join(state, "openrouter-api-key.secret"), "TEST_OPENROUTER_KEY\n", { mode: 0o600 });
  const seen = [];
  const upstream = await server(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ url: request.url, headers: request.headers, body });
    if (body.parallel_tool_calls !== undefined) {
      json(response, 404, {
        error: { message: "No endpoints found that can handle the requested parameters." },
      });
      return;
    }
    json(response, 200, { choices: [] });
  });
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_API_PORT: String(port),
      CODEX_ROUTER_INTERNAL_KEY: internalKey,
      CODEX_ROUTER_STATE_DIR: state,
      OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
      CODEX_ROUTER_QUIET: "1",
      OPENROUTER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, child);
    const input = [{
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    }];
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "ChatGPT-Account-Id": "must-not-leave",
        "X-Codex-Installation-Id": "must-not-leave",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter-glm-5-3-flash",
        input,
        client_metadata: { account: "must-not-leave" },
        parallel_tool_calls: true,
        reasoning: { effort: "high" },
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 128,
        tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        tool_choice: "auto",
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.authorization, "Bearer TEST_OPENROUTER_KEY");
    assert.equal(seen[0].headers["chatgpt-account-id"], undefined);
    assert.equal(seen[0].headers["x-codex-installation-id"], undefined);
    assert.equal(seen[0].body.client_metadata, undefined);
    assert.equal(seen[0].body.parallel_tool_calls, undefined);
    assert.equal(seen[0].body.model, "z-ai/glm-5.3-flash");
    assert.deepEqual(seen[0].body.input, input);
    assert.deepEqual(seen[0].body.reasoning, { effort: "high" });
    assert.deepEqual(seen[0].body.include, ["reasoning.encrypted_content"]);
    assert.equal(seen[0].body.max_output_tokens, 128);
    assert.deepEqual(seen[0].body.tools, [
      { type: "function", name: "exec_command", parameters: { type: "object" } },
    ]);
    assert.equal(seen[0].body.tool_choice, "auto");
    assert.deepEqual(seen[0].body.provider, {
      order: ["novita"],
      only: ["novita"],
      allow_fallbacks: false,
      require_parameters: true,
    });

    const emptyTools = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter-glm-5-3-flash",
        tools: [],
        tool_choice: "none",
      }),
    });
    assert.equal(emptyTools.status, 200, await emptyTools.text());
    assert.equal(seen.length, 2);
    assert.equal(seen[1].body.tools, undefined);
    assert.equal(seen[1].body.tool_choice, undefined);

    for (const tool_choice of ["required", { type: "function", name: "must_run" },
      { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "must_run" }] }]) {
      const forced = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openrouter-glm-5-3-flash", tools: [], tool_choice }),
      });
      assert.equal(forced.status, 400);
      assert.equal((await forced.json()).error.code, "unsupported_tool_choice");
      assert.equal(seen.length, 2, "unsatisfiable tool choice reached the provider");
    }

    const gmiCloud = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter-glm-5-3-flash-gmicloud",
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        tool_choice: "auto",
      }),
    });
    assert.equal(gmiCloud.status, 200, await gmiCloud.text());
    assert.equal(seen.length, 3);
    assert.equal(seen[2].body.parallel_tool_calls, undefined);
    assert.deepEqual(seen[2].body.provider, {
      order: ["gmicloud"],
      only: ["gmicloud"],
      allow_fallbacks: false,
      require_parameters: true,
    });

    const rejected = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter-glm-5-3-flash",
        tools: [{ type: "web_search" }],
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(seen.length, 3, "unsupported search reached OpenRouter");

    const hosted = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter-glm-5-3-flash",
        input: "Current documentation",
        tools: [{
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            mode: "fast",
            max_results: 5,
            max_total_results: 15,
            max_uses: 3,
          },
        }],
        max_tool_calls: 3,
      }),
    });
    assert.equal(hosted.status, 200, await hosted.text());
    assert.equal(seen.length, 4);
    assert.equal(seen[3].url, "/v1/responses");
    assert.equal(seen[3].body.tools[0].type, "openrouter:web_search");
    assert.deepEqual(seen[3].body.provider, {
      order: ["novita"],
      only: ["novita"],
      allow_fallbacks: false,
      require_parameters: true,
    });

    const overLimit = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter-glm-5-3-flash",
        tools: [{
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            mode: "fast",
            max_results: 6,
            max_total_results: 15,
            max_uses: 3,
          },
        }],
        max_tool_calls: 3,
      }),
    });
    assert.equal(overLimit.status, 400);
    assert.equal(seen.length, 4, "an unbounded hosted-search request reached OpenRouter");
  } finally {
    await stop(child);
    await new Promise((resolve) => upstream.instance.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
