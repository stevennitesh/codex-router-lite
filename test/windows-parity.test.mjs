import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Maintenance effects and upstream authority retain independent source guards.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the compatibility refresh stays read-only", () => {
  const refresh = readFileSync(
    path.join(root, "maintenance", "refresh-compatibility-state.ps1"),
    "utf8",
  );
  assert.match(refresh, /check-codex-catalog-compat\.mjs/);
  assert.match(refresh, /src\/doctor\.mjs/);
  assert.match(refresh, /@\("run", "check"\)/);
  assert.match(refresh, /@\("test"\)/);
  assert.match(refresh, /AnalyzeUpstream/);
  assert.match(refresh, /upstream-router\.json/);
  assert.match(refresh, /git -C \$analysisRoot apply --check/);
  assert.match(refresh, /GetTempPath\(\)\)\.TrimEnd/);
  assert.match(refresh, /GetDirectoryName\(\$analysisRoot\)/);
  assert.match(refresh, /Bundled codex-app-tools plugin/);
  assert.match(refresh, /request-local client definitions and discoveries/);
  assert.doesNotMatch(refresh, /Codex app mismatch branch/);
  assert.doesNotMatch(refresh, /service\.mjs.*(?:install|start|stop|restart)/);
  assert.doesNotMatch(refresh, /provider-key|caller-key|codex exec/);
});

test("Router upstream review uses an explicit immutable baseline", () => {
  const watch = JSON.parse(readFileSync(
    path.join(root, "maintenance", "upstream-router.json"),
    "utf8",
  ));
  assert.equal(watch.version, 1);
  assert.equal(watch.repository, "https://github.com/duolahypercho/codex-router.git");
  assert.equal(watch.branch, "main");
  assert.equal(watch.remoteRef, "upstream/main");
  assert.match(watch.lastReviewedCommit, /^[0-9a-f]{40}$/u);
  assert.ok(Array.isArray(watch.deferredCandidates));
  for (const candidate of watch.deferredCandidates) {
    assert.equal(typeof candidate, "string");
    assert.match(candidate, /^[0-9a-f]{8}.*: .+/u, "deferrals identify the upstream change and reason");
  }
});
