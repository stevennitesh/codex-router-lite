import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname.slice(1));

function runControl(args, environment = {}) {
  return spawnSync(process.execPath, [path.join(root, "src", "control.mjs"), ...args], {
    cwd: root,
    env: { ...process.env, CODEX_ROUTER_OPERATION_CHILD: "1", ...environment },
    encoding: "utf8",
  });
}

test("removed UI and alternate-client control commands are unsupported", () => {
  for (const command of ["tray", "presence", "harness", "client-setup", "client-export", "--probe"]) {
    const result = runControl([command]);
    assert.notEqual(result.status, 0, `${command} unexpectedly remained supported`);
    assert.match(result.stderr, /Unknown command|Usage|unsupported/i);
  }
});

test("control rejects alternate target selection", () => {
  const result = runControl(["set", "openrouter", "on", "--targets", "gemini"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only the codex target is supported/i);
});

test("control imports no issue-4 retirement adapter", () => {
  const source = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
  assert.doesNotMatch(source, /legacy-control-features|legacyControlScript|importLegacyControlModule/);
});
