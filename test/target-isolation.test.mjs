import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname.slice(1));

test("paths exposes Codex as the only target", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    'import { TARGET, TARGET_DISPLAY_NAME } from "./src/paths.mjs"; process.stdout.write(JSON.stringify({ TARGET, TARGET_DISPLAY_NAME }));',
  ], {
    cwd: root,
    env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    TARGET: "codex",
    TARGET_DISPLAY_NAME: "Codex Router",
  });
});

test("paths rejects an alternate client target", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    'await import("./src/paths.mjs");',
  ], {
    cwd: root,
    env: { ...process.env, MODEL_ROUTER_TARGET: "gemini" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supports only codex/i);
});
