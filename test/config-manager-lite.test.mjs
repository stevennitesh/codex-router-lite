import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("missing multi-agent end marker is repaired only for the exact owned feature", t => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-agent-marker-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  const codexHome = path.join(testRoot, "codex"), state = path.join(testRoot, "state");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`);
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, '[features]\napps = true\n\n[desktop]\nnotifications = true\n');
  const env = { CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: state, CODEX_BIN: process.execPath };
  run("enable", env);
  const end = "# END codex-router-multi-agent-v2-managed";
  const damaged = readFileSync(configPath, "utf8").replace(end, 'user_feature = true\n# user-owned note');
  writeFileSync(configPath, damaged);
  assert.equal(run("validate-enable", env).mode, "router");
  assert.equal(readFileSync(configPath, "utf8"), damaged, "preflight remains read-only");
  run("enable", env);
  const repaired = readFileSync(configPath, "utf8");
  assert.equal(repaired.split(end).length - 1, 1);
  assert.match(repaired, /user_feature = true\n# user-owned note/u);
  assert.match(repaired, /apps = true/u);
  assert.match(repaired, /\[desktop\]\nnotifications = true/u);

  const modified = repaired.replace(end, "").replace(
    "max_concurrent_threads_per_session = 6", "max_concurrent_threads_per_session = 7",
  );
  writeFileSync(configPath, modified);
  const rejected = spawnSync(process.execPath, [path.join(root, "src", "config-manager.mjs"), "enable"], {
    cwd: root, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Refusing to edit an unterminated managed block/u);
  assert.equal(readFileSync(configPath, "utf8"), modified, "a changed feature cannot authorize removal");
});

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

function configFixture(t) {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-boundary-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  const home = path.join(testRoot, "codex"), state = path.join(testRoot, "state");
  mkdirSync(home, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), "a".repeat(48));
  return { config: path.join(home, "config.toml"), state,
    env: { CODEX_HOME: home, MODEL_ROUTER_STATE_DIR: state, CODEX_BIN: process.execPath } };
}

test("quoted foreign keys and mixed-spelling duplicates are refused before config mutation", t => {
  const f = configFixture(t);
  for (const original of [
    '"openai_base_url" = "https://example.invalid/v1"\n',
    String.raw`"openai_\u0062ase_url" = "https://example.invalid/v1"` + "\n",
    "'model_catalog_json' = 'C:/user/models.json'\n",
    `model_catalog_json = ${JSON.stringify(path.join(f.state, "merged-models.json"))}\n"model_catalog_json" = 'C:/user/models.json'\n`,
    '[model_providers."codex-router"]\nbase_url = "https://example.invalid/v1"\n',
  ]) {
    writeFileSync(f.config, original);
    for (const command of ["validate-enable", "enable"]) {
      const result = spawnSync(process.execPath, [path.join(root, "src/config-manager.mjs"), command], {
        env: { ...process.env, ...f.env }, encoding: "utf8", windowsHide: true,
      });
      assert.notEqual(result.status, 0, original);
      assert.equal(readFileSync(f.config, "utf8"), original);
    }
  }
});

test("managed marker and assignment examples in both multiline string types survive enable and disable", t => {
  const f = configFixture(t);
  for (const quote of ['"""', "'''"]) {
    const instructions = [
      `developer_instructions = ${quote}`,
      "# BEGIN codex-router-managed", "KEEP_ROOT", "# END codex-router-managed",
      "# BEGIN codex-router-provider-managed", "KEEP_PROVIDER", "# END codex-router-provider-managed",
      "# BEGIN codex-router-multi-agent-v2-managed", "KEEP_AGENTS", "# END codex-router-multi-agent-v2-managed",
      "[features.multi_agent_v2]", 'openai_base_url = "https://example.invalid"',
      `model_catalog_json = ${JSON.stringify(path.join(f.state, "merged-models.json"))}`,
      quote, "",
    ].join("\n");
    const userRealtime = '"experimental_realtime_ws_base_url" = "wss://example.invalid/ws#fragment"\n';
    writeFileSync(f.config, instructions + userRealtime + '"model" = "gpt-5.5"\n');
    assert.equal(run("status", f.env).managed_router_artifacts_present, false);
    assert.equal(run("enable", f.env).model, "gpt-5.5");
    const enabled = readFileSync(f.config, "utf8");
    assert.ok(enabled.includes(instructions));
    assert.ok(enabled.includes(userRealtime));
    assert.equal((enabled.match(/^experimental_realtime_ws_base_url\s*=/gmu) || []).length, 0);
    assert.match(enabled, /^multi_agent_v2 = \{ enabled = true/mu, "string example does not prevent real managed feature");
    run("enable", f.env);
    assert.equal(readFileSync(f.config, "utf8"), enabled, "second enable does not duplicate owned fields");
    run("disable", f.env);
    const disabled = readFileSync(f.config, "utf8");
    assert.ok(disabled.includes(instructions));
    assert.ok(disabled.includes(userRealtime));
    assert.equal(run("status", f.env).openai_base_url, null);
    assert.equal(run("status", f.env).managed_router_artifacts_present, false);
  }
});

test("quoted user feature configuration is preserved without a second multi-agent setting", t => {
  const f = configFixture(t);
  const original = '["features"]\n"multi_agent_v2" = { enabled = false }\n';
  writeFileSync(f.config, original); run("enable", f.env);
  const enabled = readFileSync(f.config, "utf8");
  assert.ok(enabled.includes(original));
  assert.doesNotMatch(enabled, /# BEGIN codex-router-multi-agent-v2-managed/u);
});

test("disable preserves foreign catalog assignments and restores only a known adopted source", t => {
  const f = configFixture(t);
  for (const key of ["model_catalog_json", '"model_catalog_json"']) {
    const original = `${key} = 'C:/user/models.json' # keep comment\nmodel = "gpt-5.5"\n`;
    writeFileSync(f.config, original); run("disable", f.env);
    assert.equal(readFileSync(f.config, "utf8"), original);
  }
  const sourcePath = path.join(f.state, "native-catalog-source.json");
  const original = '"model_catalog_json" = "C:/user/models.json" # keep comment\n';
  writeFileSync(f.config, original);
  writeFileSync(sourcePath, JSON.stringify({ version: 1, status: "active", path: "C:/user/models.json" }));
  if (process.platform === "win32") {
    run("disable", f.env);
    assert.equal(readFileSync(f.config, "utf8"), original);
  }
  writeFileSync(sourcePath, "{");
  const failed = spawnSync(process.execPath, [path.join(root, "src/config-manager.mjs"), "disable"], {
    env: { ...process.env, ...f.env }, encoding: "utf8", windowsHide: true,
  });
  assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(f.config, "utf8"), original);
});

test("disable refuses inaccessible adoption state without changing user or managed config", t => {
  const f = configFixture(t);
  const source = path.join(f.state, "native-catalog-source.json");
  writeFileSync(source, JSON.stringify({ version: 1, status: "active", path: path.join(f.state, "native.json") }));
  writeFileSync(f.config, 'model = "gpt-5.5"\n'); run("enable", f.env);
  const before = readFileSync(f.config, "utf8");
  const preload = path.join(f.state, "deny-source.mjs");
  writeFileSync(preload, `import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
const old=fs[process.env.DENY_METHOD];fs[process.env.DENY_METHOD]=function(p,...a){if(path.resolve(String(p))===path.resolve(process.env.DENY_SOURCE)){throw Object.assign(new Error('synthetic source denial'),{code:'EACCES'});}return old(p,...a);};syncBuiltinESMExports();`);
  for (const method of ["readFileSync", "lstatSync"]) {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(root, "src/config-manager.mjs"), "disable"], {
      env: { ...process.env, ...f.env, DENY_METHOD: method, DENY_SOURCE: source }, encoding: "utf8", windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid native catalog source state/u);
    assert.equal(readFileSync(f.config, "utf8"), before);
  }
});

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
