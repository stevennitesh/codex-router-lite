import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callerKey = "codex-only-caller-capability-0123456789";
const internalKey = "codex-only-internal-capability-0123456789";

function removedRouteUrl(port, route) {
  return `http://127.0.0.1:${port}/_codex-router/${callerKey}${route}`;
}

async function requestWhenReady(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`router exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timed out waiting for the router: ${child.testErrors()}`);
}

test("router rejects removed panel and alternate-client protocol leaves", async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-only-router-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_PORT: String(port),
      CODEX_ROUTER_CALLER_KEY: callerKey,
      CODEX_ROUTER_INTERNAL_KEY: internalKey,
      CODEX_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;

  try {
    const routes = [
      "/panel/",
      "/cursor/v1/models",
      "/anthropic/v1/models",
      "/gemini/v1beta/models/example:generateContent",
    ];
    for (const [index, route] of routes.entries()) {
      const response = index === 0
        ? await requestWhenReady(removedRouteUrl(port, route), child)
        : await fetch(removedRouteUrl(port, route));
      assert.equal(response.status, 404, `${route} remained dispatchable`);
      const payload = await response.json();
      assert.equal(payload?.error?.type, "proxy_route_not_found");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("retained entrypoints contain no removed client, UI, or platform startup hooks", () => {
  const router = readFileSync(path.join(root, "src", "router.mjs"), "utf8");
  const start = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  const routerForbidden =
    /legacy-router-surfaces|desktop-panel|gemini-surface|cursor-surface|claude-surface|routed-client-models|handle(?:Panel|Gemini|Cursor|Claude)Request|is(?:Panel|Gemini|Cursor|Claude)Route/;
  const startupForbidden =
    /legacy-startup-features|cursor-public-edge|cursor-cloudflare-tunnel|cursorTunnelRunSpec|CURSOR_CATALOG_PATH|MODEL_ROUTER_CURSOR_PUBLIC_PORT|tray-service|service-(?:macos|linux)|TARGET ===/;

  assert.match("handlePanelRequest", routerForbidden, "router detector lost its positive control");
  assert.match("cursor-public-edge.mjs", startupForbidden, "startup detector lost its positive control");
  assert.doesNotMatch(router, routerForbidden);
  assert.doesNotMatch(start, startupForbidden);
  assert.match(start, /MODEL_ROUTER_TARGET: "codex"/);
});
