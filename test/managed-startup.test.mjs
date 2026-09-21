import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openPort } from "./port-pool.mjs";
import { processCommandLine } from "../src/process-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const managedProcessProbeAvailable = Boolean(processCommandLine(process.pid));

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("managed startup did not stop")), 8_000)),
  ]);
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`managed startup exited: ${child.errors()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // The managed path has not bound the Router port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`managed startup did not become healthy: ${child.errors()}`);
}

for (const selectedProviders of [[], ["openrouter"]]) {
  test(`managed startup supports native requests without a provider key (${selectedProviders.length ? "OpenRouter selected" : "native only"})`,
    {
      skip: process.platform !== "win32" || !managedProcessProbeAvailable,
      timeout: 30_000,
    }, async t => {
      const state = mkdtempSync(path.join(os.tmpdir(), "codex-router-startup-"));
      const [nativePort, gatewayPort, apiPort, routerPort] = await Promise.all([
        openPort(), openPort(), openPort(), openPort(),
      ]);
      const nativeRequests = [];
      const native = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        nativeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        json(response, 200, {
          id: "resp_native_startup",
          status: "completed",
          model: "gpt-5.6-sol",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "native ready" }] }],
        });
      });
      await listen(native, nativePort);
      const gatewayCommand = path.join(state, "gateway.cmd");
      writeFileSync(
        gatewayCommand,
        `@echo off\r\n"${process.execPath}" "${path.join(root, "test", "managed-startup-gateway-fixture.mjs")}" %*\r\n`,
      );
      writeFileSync(path.join(state, "internal-secret"), "internal-startup-capability-long-enough\n");
      writeFileSync(path.join(state, "caller-secret"), "caller-startup-capability-long-enough\n");
      writeFileSync(
        path.join(state, "enabled-providers.json"),
        `${JSON.stringify({ version: 1, providers: selectedProviders })}\n`,
      );
      const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          OPENROUTER_API_KEY: "",
          MODEL_ROUTER_STATE_DIR: state,
          CODEX_ROUTER_STATE_DIR: state,
          MODEL_ROUTER_LITELLM_BIN: gatewayCommand,
          CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}/backend-api/codex`,
          MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
          MODEL_ROUTER_API_PORT: String(apiPort),
          MODEL_ROUTER_PORT: String(routerPort),
          CODEX_ROUTER_CATALOG_REFRESH_MS: "600000",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      const errors = [];
      child.stderr.on("data", (chunk) => errors.push(chunk));
      child.errors = () => Buffer.concat(errors).toString("utf8");
      t.after(async () => {
        await stopChild(child).catch(() => child.kill("SIGKILL"));
        native.closeAllConnections();
        await new Promise((resolve) => native.close(resolve));
        rmSync(state, { recursive: true, force: true });
      });

      const healthUrl = `http://127.0.0.1:${routerPort}/health`;
      assert.equal((await waitForHealth(healthUrl, child)).ok, true);
      const fullHealth = await fetch(
        `http://127.0.0.1:${routerPort}/_codex-router/caller-startup-capability-long-enough/v1/health`,
      );
      assert.equal(fullHealth.status, 200);
      const health = await fullHealth.json();
      if (selectedProviders.length) {
        assert.equal(health.api.reachable, true);
        assert.equal(health.api.ready, false);
        assert.equal(health.api.credential_present, false);
      } else {
        assert.deepEqual(health.api, { reachable: true, enabled: false });
      }

      const nativeResponse = await fetch(
        `http://127.0.0.1:${routerPort}/_codex-router/caller-startup-capability-long-enough/v1/responses`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-native-session",
            "chatgpt-account-id": "synthetic-account",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "native startup proof", stream: false }),
        },
      );
      assert.equal(nativeResponse.status, 200, await nativeResponse.text());
      assert.equal(nativeRequests.length, 1);

      const external = await fetch(
        `http://127.0.0.1:${routerPort}/_codex-router/caller-startup-capability-long-enough/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openrouter/pareto", input: "must remain unavailable" }),
        },
      );
      assert.equal(external.status, selectedProviders.length ? 401 : 409);
    });
}
