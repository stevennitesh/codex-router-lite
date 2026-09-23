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
    `model_catalog_json = ${JSON.stringify(nativeCatalog)}\ndeveloper_instructions = "USER_POLICY"\n\n[features]\napps = true\n\n[desktop]\nnotifications = true\n`,
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
    assert.match(routed, /## Delegated-agent waiting/u);
    assert.match(routed, /Wait again without commentary/u);
    assert.match(routed, /call interrupt_agent on that child/u);
    assert.match(routed, /## Delegation routing/u);
    assert.match(routed, /may intentionally be on the critical path/u);
    assert.match(routed, /fork_turns=\\\"none\\\"/u);
    assert.match(routed, /developer_instructions = "USER_POLICY"/u);
    assert.match(routed, /\[desktop\]\nnotifications = true/u);

    writeFileSync(
      path.join(codexHome, "config.toml"),
      routed.replace("## Delegated-agent waiting", "OLD_ROUTER_HINT"),
    );
    run("enable", env);
    const refreshed = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.match(refreshed, /## Delegated-agent waiting/u);
    assert.doesNotMatch(refreshed, /OLD_ROUTER_HINT/u);
    assert.match(refreshed, /developer_instructions = "USER_POLICY"/u);

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

test("Codex config enable repairs a recognizable missing Router root end marker", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-repair-"));
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
    `model_catalog_json = ${JSON.stringify(nativeCatalog)}\n\n[desktop]\nnotifications = true\n`,
  );
  const env = {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  };
  try {
    run("enable", env);
    const configPath = path.join(codexHome, "config.toml");
    const damaged = readFileSync(configPath, "utf8").replace(
      "# END codex-router-managed\n",
      "",
    );
    writeFileSync(configPath, damaged);

    const validated = run("validate-enable", env);
    assert.equal(validated.mode, "router");
    assert.equal(readFileSync(configPath, "utf8"), damaged);

    const repaired = run("enable", env);
    assert.equal(repaired.mode, "router");
    const contents = readFileSync(configPath, "utf8");
    assert.equal((contents.match(/# BEGIN codex-router-managed/gu) || []).length, 1);
    assert.equal((contents.match(/# END codex-router-managed/gu) || []).length, 1);
    assert.match(contents, /\[desktop\]\nnotifications = true/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Codex config enable preserves a user root value after a recognizable managed prefix", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-refusal-"));
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
  const configPath = path.join(codexHome, "config.toml");
  const damaged = [
    "# BEGIN codex-router-managed",
    'openai_base_url = "http://127.0.0.1:4202/v1"',
    `model_catalog_json = ${JSON.stringify(path.join(state, "merged-models.json"))}`,
    "user_owned = true",
    "",
    "[desktop]",
    "notifications = true",
    "",
  ].join("\n");
  writeFileSync(configPath, damaged);
  const env = {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  };
  try {
    const result = run("enable", env);
    assert.equal(result.mode, "router");
    const repaired = readFileSync(configPath, "utf8");
    assert.match(repaired, /user_owned = true/u);
    assert.equal((repaired.match(/# END codex-router-managed/gu) || []).length, 1);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Codex config enable preserves user content after a recognizable managed prefix", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-owned-"));
  const codexHome = path.join(testRoot, "codex");
  const state = path.join(testRoot, "state");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`, { mode: 0o600 });
  const configPath = path.join(codexHome, "config.toml");
  const damaged = [
    "# BEGIN codex-router-managed",
    'openai_base_url = "http://127.0.0.1:4202/v1"',
    `model_catalog_json = ${JSON.stringify(path.join(state, "merged-models.json"))}`,
    'experimental_realtime_ws_base_url = "https://example.test/v1"',
    "# user-owned note",
    "",
    "[desktop]",
    "notifications = true",
    "",
  ].join("\n");
  writeFileSync(configPath, damaged);
  const result = run("enable", {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  });
  try {
    assert.equal(result.mode, "router");
    const repaired = readFileSync(configPath, "utf8");
    assert.match(repaired, /experimental_realtime_ws_base_url = "https:\/\/example\.test\/v1"/u);
    assert.match(repaired, /# user-owned note/u);
    assert.equal((repaired.match(/# END codex-router-managed/gu) || []).length, 1);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
