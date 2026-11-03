import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pruneObsoleteRouterSettings } from "../src/uninstall-cleanup.mjs";

test("uninstall prunes orphan hook trust and the disabled Router skill while preserving live hooks and other skills", () => {
  const codexHome = path.resolve("fixture", "codex");
  const sourceRoot = path.resolve("fixture", "router");
  const userHooks = path.join(codexHome, "hooks.json");
  const checkoutHooks = path.join(sourceRoot, ".codex", "hooks.json");
  const unrelatedHooks = path.resolve("other", "hooks.json");
  const userTrust = "[hooks.state.'" + userHooks + ":interrupt:0:0']\nenabled = false\n";
  const projectTrust = "[hooks.state.'" + checkoutHooks + ":stop:0:0']\nenabled = false\n";
  const unrelatedTrust = "[hooks.state.'" + unrelatedHooks + ":interrupt:0:0']\nenabled = true\n";
  const disabled = "[[skills.config]]\npath = '" + path.join(codexHome, "skills", "codex-router-media", "SKILL.md") + "'\nenabled = false\n";
  const unrelatedSkill = "[[skills.config]]\nname = 'local'\nenabled = false\n";
  const contents = userTrust + projectTrust + unrelatedTrust + disabled + unrelatedSkill;
  const options = { codexHome, sourceRoot, adapterRemoved: true };
  assert.equal(pruneObsoleteRouterSettings(contents, { ...options, hookFileExists: file => file === userHooks }),
    userTrust + unrelatedTrust + unrelatedSkill);
  assert.equal(pruneObsoleteRouterSettings(contents, { ...options, hookFileExists: () => false }),
    unrelatedTrust + unrelatedSkill);
  assert.equal(pruneObsoleteRouterSettings(contents, { ...options, adapterRemoved: false, hookFileExists: () => false }),
    userTrust + unrelatedTrust + unrelatedSkill);
});

test("uninstall preserves recovery files by default and purges them only on request", t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-router-uninstall-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, "codex-router");
  const agents = path.join(home, "agents");
  mkdirSync(state);
  mkdirSync(agents);
  const backup = path.join(home, "config.toml.pre-codex-router");
  const config = path.join(home, "config.toml");
  const routerAgent = path.join(agents, "router-model-example.toml");
  const userAgent = path.join(agents, "local.toml");
  const credentials = path.join(home, "auth.json");
  for (const file of [backup, routerAgent, userAgent, credentials]) writeFileSync(file, "fixture");
  writeFileSync(config, 'model = "native"\n');
  const env = { ...process.env, CODEX_HOME: home, MODEL_ROUTER_STATE_DIR: state };
  const run = (...args) => spawnSync(process.execPath, ["src/uninstall-cleanup.mjs", ...args], { env, encoding: "utf8", timeout: 30_000 });
  const normal = run();
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(existsSync(routerAgent), false);
  assert.equal(existsSync(state), true);
  assert.equal(existsSync(backup), true);
  const purge = run("--purge-owned-state");
  assert.equal(purge.status, 0, purge.stderr);
  assert.equal(existsSync(state), false);
  assert.equal(existsSync(backup), false);
  for (const file of [userAgent, credentials]) assert.equal(readFileSync(file, "utf8"), "fixture");
  assert.equal(readFileSync(config, "utf8"), 'model = "native"\n');
});
