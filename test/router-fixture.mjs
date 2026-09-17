import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function launch(script, env) {
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  let errors = "";
  child.stderr.on("data", bytes => { errors += bytes; });
  child.errors = () => errors;
  return child;
}

export async function ready(url, child, headers = {}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, child.errors());
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.status < 500) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Isolated service not ready: " + child.errors());
}

export async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const ended = once(child, "exit"); child.kill(); await ended;
  }
}

export function responseJson(response, value) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
