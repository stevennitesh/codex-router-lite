import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve(import.meta.dirname, "..", "src", "provider-selection.mjs");

function ensureConfigured(providers) {
  const state = mkdtempSync(path.join(os.tmpdir(), "provider-selection-"));
  try {
    writeFileSync(
      path.join(state, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers })}\n`,
    );
    return spawnSync(process.execPath, [script, "ensure-configured"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "",
        MODEL_ROUTER_STATE_DIR: state,
        CODEX_ROUTER_STATE_DIR: state,
        CODEX_ROUTER_SWITCHYARD_ROOT: path.join(state, "missing-switchyard"),
      },
    });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

test("installation allows selected OpenRouter before its optional key is set", () => {
  const result = ensureConfigured(["openrouter"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { providers: ["openrouter"], idle: false });
});

test("installation still rejects a selected provider whose local runtime is missing", () => {
  const result = ensureConfigured(["switchyard"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Selected providers are unavailable: switchyard/u);
});
