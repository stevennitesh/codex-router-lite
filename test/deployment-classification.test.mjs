import assert from "node:assert/strict";
import test from "node:test";

import { classifyDeploymentChange } from "../src/deployment-classification.mjs";

test("deployment classification distinguishes no-op, documentation, catalog publication, and runtime", () => {
  assert.equal(classifyDeploymentChange(), "no-op");
  assert.equal(classifyDeploymentChange({
    paths: ["docs/INSTALL.md", "test/router.test.mjs", "v2_agent/proof.json", "LICENSE", "NOTICE.md"],
  }), "documentation-only");
  assert.equal(classifyDeploymentChange({ knownCatalogPublication: true }), "catalog-only");
  for (const candidate of [
    "src/router.mjs",
    "config/switchyard/auto.json",
    "config/openrouter/openrouter.json",
    "maintenance/windows-package.json",
    "unknown.file",
  ]) {
    assert.equal(classifyDeploymentChange({ paths: [candidate] }), "runtime", candidate);
  }
  assert.equal(classifyDeploymentChange({
    paths: ["docs/INSTALL.md"],
    knownCatalogPublication: true,
  }), "runtime");
});
