import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSanitized,
  measureIsolatedRouterStartup,
  measurementHarness,
  parseLsTree,
  sourceMetrics,
  summarizeWorktree,
  withTemporaryDirectory,
} from "../scripts/capture-retained-baseline.mjs";
import {
  discoverLiteralTopLevelTests,
  parseTapSummary,
  runRetainedTests,
  validateManifest,
} from "../scripts/run-retained-tests.mjs";

test("retained baseline metrics count Git payload and source bytes exactly", () => {
  const files = parseLsTree([
    "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tsrc/a.mjs",
    "100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 5\tdocs/a.md",
    "100644 blob cccccccccccccccccccccccccccccccccccccccc 7\tinstall.ps1",
  ].join("\n"));
  assert.deepEqual(sourceMetrics(files), {
    trackedFiles: 3,
    trackedBlobBytes: 24,
    sourceFiles: 2,
    sourceBlobBytes: 19,
  });
});

test("worktree evidence records counts without retaining repository paths", () => {
  assert.deepEqual(summarizeWorktree(" M src/private-name.mjs\n?? generated/secret.txt\n"), {
    clean: false,
    changedPathCount: 2,
    trackedChangeCount: 1,
    untrackedPathCount: 1,
  });
});

test("baseline cleanup removes its exact temporary directory after failure", () => {
  let created;
  assert.throws(() => withTemporaryDirectory((directory) => {
    created = directory;
    writeFileSync(path.join(directory, "owned.txt"), "fixture");
    throw new Error("fixture failure");
  }, { tempRoot: os.tmpdir() }), /fixture failure/);
  assert.equal(existsSync(created), false);
});

test("baseline sanitization rejects secret-bearing and process-command fields", () => {
  assert.throws(() => assertSanitized({ environment: { bearerToken: "x" } }), /sensitive field/);
  assert.throws(() => assertSanitized({ process: { commandLine: "node private.js" } }), /sensitive field/);
  assert.doesNotThrow(() => assertSanitized({ environment: { cpuModel: "fixture", node: "v24" } }));
});

test("isolated Router entrypoint measures authenticated readiness and cleans up", { timeout: 20_000 }, async () => {
  const result = await measureIsolatedRouterStartup({
    quietMilliseconds: 0,
    sampleCount: 1,
    sampleIntervalMilliseconds: 0,
  });
  assert.equal(result.status, "measured");
  assert.equal(result.topology, "isolated-router-entrypoint-startup");
  assert.equal(result.authenticatedHealth.service, "codex-router");
  assert.equal(result.authenticatedHealth.router, "ready");
  assert.ok(result.raw.readinessMilliseconds > 0);
  assert.equal(result.raw.fixtureChildCount, 1);
  assert.equal(result.raw.memorySamples.length, 1);
  assert.deepEqual(result.cleanup, {
    fixtureProcessExited: true,
    temporaryStateRemoved: true,
  });
});

test("literal top-level test discovery decodes quote escapes", () => {
  assert.deepEqual(discoverLiteralTopLevelTests([
    "test(\"double \\\"quote\\\"\", () => {});",
    "test('single \\\'quote\\\'', () => {});",
    "  test(\"nested indentation\", () => {});",
  ].join("\n")), ['double "quote"', "single 'quote'"]);
});

test("retained test patterns fail before spawn when no source name matches", () => {
  withTemporaryDirectory((repoRoot) => {
    const testDirectory = path.join(repoRoot, "test");
    mkdirSync(testDirectory);
    writeFileSync(path.join(testDirectory, "fixture.test.mjs"), "test(\"actual \\\"quoted\\\" name\", () => {});\n");
    assert.throws(() => validateManifest({
      schemaVersion: 1,
      selections: [{
        id: "zero-match",
        surfaces: [
          "native-codex",
          "openrouter-glm-5.3-flash",
          "switchyard",
          "app-function-restoration",
          "namespace-restoration",
          "collaboration-relay",
          "collaboration-v2",
          "windows-lifecycle",
        ],
        file: "test/fixture.test.mjs",
        testNamePattern: "NEVERMATCHXYZ",
      }],
    }, { repoRoot }), /matched zero statically discovered tests/);

    writeFileSync(path.join(testDirectory, "fixture.test.mjs"), "const name = \"dynamic\";\ntest(name, () => {});\n");
    assert.throws(() => validateManifest({
      schemaVersion: 1,
      selections: [{
        id: "no-static-name",
        surfaces: [
          "native-codex",
          "openrouter-glm-5.3-flash",
          "switchyard",
          "app-function-restoration",
          "namespace-restoration",
          "collaboration-relay",
          "collaboration-v2",
          "windows-lifecycle",
        ],
        file: "test/fixture.test.mjs",
        testNamePattern: "^dynamic$",
      }],
    }, { repoRoot }), /no statically discoverable literal top-level test names/);
  });
});

test("retained manifest refuses excluded-only files", () => {
  assert.throws(() => validateManifest({
    schemaVersion: 1,
    selections: [{
      id: "excluded",
      surfaces: ["native-codex"],
      file: "test/subagent-ui.test.mjs",
    }],
  }), /excluded-only/);
});

test("retained runner validates and spawns against an explicit repository root", () => {
  withTemporaryDirectory((repoRoot) => {
    const testDirectory = path.join(repoRoot, "test");
    mkdirSync(testDirectory);
    writeFileSync(path.join(testDirectory, "fixture.test.mjs"), "test(\"fixture\", () => {});\n");
    const manifestPath = path.join(repoRoot, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      selections: [{
        id: "fixture",
        surfaces: [
          "native-codex",
          "openrouter-glm-5.3-flash",
          "switchyard",
          "app-function-restoration",
          "namespace-restoration",
          "collaboration-relay",
          "collaboration-v2",
          "windows-lifecycle",
        ],
        file: "test/fixture.test.mjs",
        testNamePattern: "^fixture$",
      }],
    }));
    let observedCwd;
    const result = runRetainedTests({
      manifestPath,
      repoRoot,
      spawn: (_executable, _args, options) => {
        observedCwd = options.cwd;
        return {
          status: 0,
          stdout: "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.5\n",
          stderr: "",
        };
      },
    });
    assert.equal(observedCwd, repoRoot);
    assert.equal(result.matchedTests, 1);
  });
});

test("pinned historical baseline stays sanitized and separates live diagnostics", () => {
  const artifact = JSON.parse(readFileSync(
    new URL("../docs/research/retained-runtime-baseline-2026-09-02-82a85a8-windows-x64.json", import.meta.url),
    "utf8",
  ));
  assert.equal(artifact.repository.commit, "82a85a8226bfda8ff5e14d648289c339c165f20c");
  assert.equal(artifact.repository.worktree.clean, true);
  assert.equal(artifact.measurements.isolatedStartup.status, "measured");
  assert.equal(artifact.measurements.isolatedStartup.topology, "isolated-router-entrypoint-startup");
  assert.equal(artifact.measurements.liveRuntimeDiagnostic.isolated, false);
  assert.equal(artifact.measurements.package.raw.bytes, 14437736);
  assert.equal(artifact.measurements.legacyBroadTestDiagnostic.rawSummary.pass, 464);
  assert.equal(artifact.measurements.maintainedRetainedTests.matchedTests, 110);
  assert.equal(artifact.measurements.maintainedRetainedTests.rawRuns.length, 15);
  const harness = measurementHarness();
  assert.deepEqual(artifact.measurementHarness, harness);
  for (const identity of artifact.measurementHarness.files) {
    const actual = createHash("sha256").update(readFileSync(new URL(`../${identity.file}`, import.meta.url))).digest("hex");
    assert.equal(identity.sha256, actual);
  }
  assert.deepEqual(
    artifact.measurementHarness.retainedManifest.selections,
    JSON.parse(readFileSync(new URL("../maintenance/retained-tests.json", import.meta.url), "utf8")).selections,
  );
  assert.doesNotThrow(() => assertSanitized(artifact));
});
