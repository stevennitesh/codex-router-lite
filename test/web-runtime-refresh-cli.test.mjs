import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("runtime refresh CLI defaults to planning and rejects ambiguous mutation arguments", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-web-refresh-cli-"));
  const control = path.resolve(import.meta.dirname, "../src/control.mjs");
  const stub = path.join(directory, "refresh.mjs"), loader = path.join(directory, "loader.mjs");
  writeFileSync(stub, "export async function refreshWebRuntime(options) { return options; }\n", "utf8");
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    if (context.parentURL === ${JSON.stringify(pathToFileURL(control).href)} && specifier === './web-runtime-refresh.mjs') {
      return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
    }
    return next(specifier, context);
  }\n`, "utf8");
  const run = arguments_ => spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href,
    control, "web", "refresh-runtime", ...arguments_], {
    cwd: directory, encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, CODEX_HOME: directory, MODEL_ROUTER_STATE_DIR: directory },
  });
  try {
    const plan = run([]);
    assert.equal(plan.error, undefined);
    assert.equal(plan.status, 0, plan.stderr);
    assert.deepEqual(JSON.parse(plan.stdout), { apply: false });

    const apply = run(["--manifest", "candidate.json", "--apply"]);
    assert.equal(apply.error, undefined);
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(JSON.parse(apply.stdout), { apply: true, manifestPath: path.join(directory, "candidate.json") });

    for (const arguments_ of [["--apply", "--apply"], ["--manifest"], ["--manifest", "--apply"],
      ["--manifest", "a.json", "--manifest", "b.json"], ["--force-service-replacement"], ["unexpected"]]) {
      const result = run(arguments_);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "", "invalid arguments must not reach the refresh operation");
      assert.match(result.stderr, /Usage: control web refresh-runtime/u);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
