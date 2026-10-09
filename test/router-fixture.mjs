import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ownedState = new WeakMap();

export function launch(script, env, { nodeArgs = [], stateDirPrefix } = {}) {
  const temporaryState = stateDirPrefix && !env?.MODEL_ROUTER_STATE_DIR && !env?.CODEX_ROUTER_STATE_DIR
    ? mkdtempSync(path.join(os.tmpdir(), stateDirPrefix)) : undefined;
  const child = spawn(process.execPath, [...nodeArgs, path.join(root, "src", script)], {
    cwd: root, env: { ...process.env, ...(temporaryState ? { MODEL_ROUTER_STATE_DIR: temporaryState } : {}), ...env },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  if (temporaryState) ownedState.set(child, temporaryState);
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", bytes => { errors += bytes; });
  child.errors = () => errors;
  return child;
}

export async function ready(url, child, headers = {}, {
  timeoutMs = 5_000, probeTimeoutMs = 500, accept = response => response.status < 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const alive = () => {
    assert.equal(child.exitCode, null, child.errors());
    assert.equal(child.signalCode, null, child.errors());
  };
  while (Date.now() < deadline) {
    alive();
    let accepted = false;
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(Math.max(1, Math.min(probeTimeoutMs, deadline - Date.now()))) });
      await response.arrayBuffer();
      accepted = accept(response);
    } catch {}
    alive();
    if (accepted) return;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(20, deadline - Date.now()))));
  }
  throw new Error("Isolated service not ready: " + child.errors());
}

export async function stop(child) {
  try {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit"); child.kill(); await ended;
    }
  } finally {
    const directory = ownedState.get(child);
    if (directory) { rmSync(directory, { recursive: true, force: true }); ownedState.delete(child); }
  }
}

export function responseJson(response, value) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
