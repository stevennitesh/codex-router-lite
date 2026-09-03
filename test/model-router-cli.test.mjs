import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "model-router.ps1"), "utf8");

test("the Windows dispatcher accepts only the Codex target", () => {
  assert.match(source, /\[ValidateSet\("codex"\)\]/);
  assert.doesNotMatch(source, /"dsh"|"gemini"|"cursor"|"claude"|"openclaw"/);
  assert.doesNotMatch(source, /codex-router\.ps1/);
});

test("the Windows dispatcher exposes retained lifecycle and provider operations", () => {
  for (const command of [
    "doctor", "status", "providers", "provider-key", "caller-key", "key-pool",
    "enable", "disable", "chatgpt-session", "skills", "uninstall", "update", "rollback",
    "support-bundle", "smoke-test", "start", "stop", "restart", "test-model", "subagents",
    "refresh-catalog",
  ]) {
    assert.match(source, new RegExp(`"${command.replaceAll("-", "\\-")}"`));
  }
  assert.match(source, /"restart"\s*\{ Invoke-RouterNode "src\\service\.mjs" @\("restart"\) \}/);
  assert.match(source, /"start"[\s\S]*--foreground[\s\S]*src\\foreground-start\.mjs/);
});

test("removed UI and alternate-platform commands are unsupported", () => {
  for (const command of ["tray", "panel", "companion", "local-mlx", "discover-models", "media"] ) {
    assert.doesNotMatch(source, new RegExp(`"${command}"`));
  }
});
