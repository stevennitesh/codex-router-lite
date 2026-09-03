import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { checkRetainedBoundary, normalizeRepoPath } from "../scripts/check-retained-boundary.mjs";

const fixtureRoots = new Set();
afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

function fixture(files, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "retained-boundary-"));
  fixtureRoots.add(root);
  const allFiles = {
    "config/openrouter/openrouter.json": "{}\n",
    "src/adapter-target.mjs": "export const legacy = true;\n",
    "src/compat/retirement/adapter.mjs": "export { legacy } from '../../adapter-target.mjs';\n",
    ...files,
  };
  for (const [name, contents] of Object.entries(allFiles)) {
    const target = path.join(root, ...name.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const manifest = {
    version: 1,
    retainedRoots: ["src/retained.mjs"],
    retainedConfigFiles: ["config/openrouter/openrouter.json"],
    processScriptReferences: ["src/retained.mjs"],
    powershellReferences: [],
    excludedOwnershipGroups: {
      legacy: ["src/adapter-target.mjs"],
    },
    temporaryAdapters: [{
      path: "src/compat/retirement/adapter.mjs",
      caller: "src/retained.mjs",
      excludedTargets: ["src/adapter-target.mjs"],
      removalIssues: [4],
    }],
    temporaryPowerShellAdapters: [],
    temporaryProcessAdapters: [],
    ...overrides,
  };
  return { root, manifest };
}

test("normalizes Windows repository paths", () => {
  assert.equal(normalizeRepoPath(".\\src\\compat\\..\\router.mjs"), "src/router.mjs");
});

test("accepts an exact adapter as a terminal boundary", () => {
  const { root, manifest } = fixture({
    "src/retained.mjs": "export { legacy } from './compat/retirement/adapter.mjs';\n",
  });
  assert.deepEqual(checkRetainedBoundary({ root, manifest }).errors, []);
});

test("reports the full transitive chain to an excluded dependency", () => {
  const { root, manifest } = fixture({
    "src/retained.mjs": "import './helper.mjs';\n",
    "src/helper.mjs": "import './excluded.mjs';\n",
    "src/excluded.mjs": "export const excluded = true;\n",
  }, {
    excludedOwnershipGroups: {
      legacy: ["src/adapter-target.mjs", "src/excluded.mjs"],
    },
  });
  const { errors } = checkRetainedBoundary({ root, manifest });
  assert.ok(errors.includes(
    "excluded dependency (legacy): src/retained.mjs -> src/helper.mjs -> src/excluded.mjs",
  ));
});

test("rejects an installer PowerShell reference to an excluded client", () => {
  const { root, manifest } = fixture({
    "install.ps1": "& \"$PSScriptRoot\\src\\excluded-client.mjs\"\n",
    "src/excluded-client.mjs": "export const client = true;\n",
  }, {
    retainedRoots: ["install.ps1"],
    processScriptReferences: [],
    powershellReferences: ["install.ps1"],
    excludedOwnershipGroups: {
      legacy: ["src/adapter-target.mjs", "src/excluded-client.mjs"],
    },
    temporaryAdapters: [{
      path: "src/compat/retirement/adapter.mjs",
      caller: "install.ps1",
      excludedTargets: ["src/adapter-target.mjs"],
      removalIssues: [4],
    }],
  });
  const { errors } = checkRetainedBoundary({ root, manifest });
  assert.ok(errors.includes(
    "excluded dependency (legacy): install.ps1 -> src/excluded-client.mjs",
  ));
});

test("follows a literal child-process script reference", () => {
  const { root, manifest } = fixture({
    "src/retained.mjs": [
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, ['./excluded.mjs']);",
    ].join("\n"),
    "src/excluded.mjs": "export const excluded = true;\n",
  }, {
    excludedOwnershipGroups: {
      legacy: ["src/adapter-target.mjs", "src/excluded.mjs"],
    },
  });
  const { errors } = checkRetainedBoundary({ root, manifest });
  assert.ok(errors.includes(
    "excluded dependency (legacy): src/retained.mjs -> src/excluded.mjs",
  ));
});

test("requires every helper-returned process target on the caller adapter edge", () => {
  const { root, manifest } = fixture({
    "src/retained.mjs": [
      "import { helperScript } from './compat/retirement/adapter.mjs';",
      "spawn(process.execPath, [helperScript(repoRoot, 'trayService')]);",
    ].join("\n"),
    "src/worker.mjs": "export const worker = true;\n",
    "src/tray-service.mjs": "export const tray = true;\n",
    "src/compat/retirement/adapter.mjs": [
      "import path from 'node:path';",
      "export { legacy } from '../../adapter-target.mjs';",
      "export function helperScript(repoRoot, key) {",
      "  switch (key) {",
      "    case 'worker': return path.join(repoRoot, 'src', 'worker.mjs');",
      "    case 'trayService': return path.join(repoRoot, 'src', 'tray-service.mjs');",
      "    default: throw new Error(key);",
      "  }",
      "}",
    ].join("\n"),
  }, {
    excludedOwnershipGroups: {
      legacy: ["src/adapter-target.mjs", "src/worker.mjs", "src/tray-service.mjs"],
    },
    temporaryAdapters: [{
      path: "src/compat/retirement/adapter.mjs",
      caller: "src/retained.mjs",
      excludedTargets: ["src/adapter-target.mjs", "src/worker.mjs", "src/tray-service.mjs"],
      removalIssues: [4],
    }],
    temporaryProcessAdapters: [{
      caller: "src/retained.mjs",
      adapter: "src/compat/retirement/adapter.mjs",
      helper: "helperScript",
      targets: [{ selector: "trayService", target: "src/tray-service.mjs" }],
    }],
  });
  const missing = checkRetainedBoundary({ root, manifest }).errors;
  assert.ok(missing.includes(
    "src/compat/retirement/adapter.mjs process targets for helperScript differ: expected [trayService=src/tray-service.mjs], found [trayService=src/tray-service.mjs, worker=src/worker.mjs]",
  ));
  manifest.temporaryProcessAdapters[0].targets.push({ selector: "worker", target: "src/worker.mjs" });
  assert.deepEqual(checkRetainedBoundary({ root, manifest }).errors, []);
});

test("rejects nonliteral dynamic imports and unlisted config", () => {
  const { root, manifest } = fixture({
    "src/retained.mjs": [
      "const local = './helper.mjs';",
      "await import(local);",
      "export const config = '../config/legacy/client.json';",
    ].join("\n"),
  });
  const { errors } = checkRetainedBoundary({ root, manifest });
  assert.ok(errors.some((error) => error.startsWith("nonliteral dynamic import in retained closure:")));
  assert.ok(errors.includes(
    "retained config is not allowlisted: src/retained.mjs -> config/legacy/client.json",
  ));
});

test("ignores config-looking strings in JavaScript comments", () => {
  const { root, manifest } = fixture({
    "src/retained.mjs": [
      "// config/legacy/client.json",
      "/* configRoot points at '../config/legacy/other.json' */",
      "export { legacy } from './compat/retirement/adapter.mjs';",
      "export const retained = true;",
    ].join("\n"),
  });
  assert.deepEqual(checkRetainedBoundary({ root, manifest }).errors, []);
});
