import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-targets-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");

const {
  installedTargets,
  refreshTargetPickerIfInstalled,
  runTargetPublicationProcess,
  targetPickerName,
} = await import("../src/target-integration.mjs");
const { CONFIG_PATH, NATIVE_CATALOG_PATH } = await import("../src/paths.mjs");

function stageFile(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

test("only a managed Codex config marks the integration installed", () => {
  try {
    stageFile(NATIVE_CATALOG_PATH, "{}");
    assert.deepEqual(installedTargets(), []);
    stageFile(CONFIG_PATH, "# BEGIN codex-router-managed\n# END codex-router-managed\n");
    assert.deepEqual(installedTargets(), ["codex"]);
    assert.equal(targetPickerName(), "Codex");
  } finally {
    rmSync(CONFIG_PATH, { recursive: true, force: true });
    rmSync(NATIVE_CATALOG_PATH, { force: true });
  }
});

test("publication refuses an aborted activation before touching Codex", async () => {
  const controller = new AbortController();
  const aborted = new Error("planned publication abort");
  controller.abort(aborted);
  await assert.rejects(
    refreshTargetPickerIfInstalled({ signal: controller.signal, deadline: Date.now() + 10_000 }),
    (error) => error === aborted,
  );
});

test("Codex publication owns a finite process tree and child deadline", async () => {
  let invocation;
  const deadline = Date.now() + 60_000;
  await runTargetPublicationProcess("catalog.mjs", [], {
    sourceRoot: "C:/stable/router",
    executable: "C:/runtime/node.exe",
    environment: { SENTINEL: "present" },
    deadline,
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(invocation.command, "C:/runtime/node.exe");
  assert.deepEqual(invocation.args, [path.join("C:/stable/router", "src", "catalog.mjs")]);
  assert.equal(invocation.options.deadline, deadline);
  assert.equal(invocation.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS, String(deadline - 10_000));
});

test.after(() => rmSync(testRoot, { recursive: true, force: true }));
