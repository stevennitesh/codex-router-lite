import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openPort } from "./port-pool.mjs";
import { serviceProcessOwns } from "../src/service-process.mjs";
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

for (const foreground of [false, true]) {
for (const selectedProviders of [[], ["openrouter"]]) {
for (const gatewayFails of [false, true]) {
  test(`${foreground ? "foreground" : "managed"} startup supports native requests without a provider key (${selectedProviders.length ? "OpenRouter selected" : "native only"}, ${gatewayFails ? "optional spawn failure" : "healthy gateway"})`,
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
      const gatewayCommand = path.join(state, gatewayFails ? "unusable-gateway.exe" : "gateway.cmd");
      if (gatewayFails) mkdirSync(gatewayCommand);
      else writeFileSync(
        gatewayCommand,
        `@echo off\r\n"${process.execPath}" "${path.join(root, "test", "managed-startup-gateway-fixture.mjs")}" %*\r\n`,
      );
      writeFileSync(path.join(state, "internal-secret"), "internal-startup-capability-long-enough\n");
      writeFileSync(path.join(state, "caller-secret"), "caller-startup-capability-long-enough\n");
      writeFileSync(
        path.join(state, "enabled-providers.json"),
        `${JSON.stringify({ version: 1, providers: selectedProviders })}\n`,
      );
      const recordPath = path.join(state, "service-process.json");
      const previousRecord = '{"version":1,"managed":true,"synthetic":"prior managed record"}\n';
      if (foreground) writeFileSync(recordPath, previousRecord);
      const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = spawn(foreground ? shell : process.execPath, foreground
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "model-router.ps1"), "codex", "start", "--foreground"]
        : [path.join(root, "src", "start.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          CODEX_HOME: path.join(state, "codex"),
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

      const healthUrl = `http://127.0.0.1:${routerPort}/${gatewayFails ? "live" : "health"}`;
      assert.equal((await waitForHealth(healthUrl, child)).ok, true);
      if (gatewayFails) {
        const deadline = Date.now() + 5_000;
        while (!child.errors().includes("spawn ") && Date.now() < deadline) {
          assert.equal(child.exitCode, null, child.errors());
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.match(child.errors(), /spawn .*ENOENT/u);
        assert.doesNotMatch(child.errors(), /Unhandled 'error' event/u);
        assert.equal(child.exitCode, null);
      }
      if (foreground) {
        assert.equal(readFileSync(recordPath, "utf8"), previousRecord, "foreground startup preserves the managed record");
      } else {
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        assert.equal(record.pid, child.pid);
        assert.equal(serviceProcessOwns(record, { sourceRoot: root, stateDir: state }), true);
      }
      const fullHealth = await fetch(
        `http://127.0.0.1:${routerPort}/_codex-router/caller-startup-capability-long-enough/v1/health`,
      );
      assert.equal(fullHealth.status, gatewayFails ? 503 : 200);
      const health = await fullHealth.json();
      if (gatewayFails) assert.ok(health.degraded.includes("gateway"));
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
}
}
