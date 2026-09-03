import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, env) {
  const result = spawnSync(process.execPath, [path.join(root, "src", "config-manager.mjs"), command], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("Codex config enable and disable preserve user TOML and restore the native catalog", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-lite-"));
  const codexHome = path.join(testRoot, "codex");
  const state = path.join(testRoot, "state");
  const nativeCatalog = path.join(testRoot, "native-models.json");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`, { mode: 0o600 });
  writeFileSync(nativeCatalog, '{"models":[]}\n');
  writeFileSync(
    path.join(state, "native-catalog-source.json"),
    `${JSON.stringify({ version: 1, path: nativeCatalog, status: "active" })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `model_catalog_json = ${JSON.stringify(nativeCatalog)}\n\n[features]\napps = true\n\n[desktop]\nnotifications = true\n`,
  );
  const env = {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  };
  try {
    const enabled = run("enable", env);
    assert.equal(enabled.mode, "router");
    const routed = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.match(routed, /# BEGIN codex-router-managed/u);
    assert.match(routed, /# BEGIN codex-router-provider-managed/u);
    assert.match(routed, /# BEGIN codex-router-multi-agent-v2-managed/u);
    assert.match(routed, /\[desktop\]\nnotifications = true/u);

    const disabled = run("disable", env);
    assert.equal(disabled.mode, "native");
    const restored = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.doesNotMatch(restored, /codex-router-managed/u);
    assert.match(restored, new RegExp(`model_catalog_json = ${JSON.stringify(nativeCatalog).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
    assert.match(restored, /\[features\]\napps = true/u);
    assert.match(restored, /\[desktop\]\nnotifications = true/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
