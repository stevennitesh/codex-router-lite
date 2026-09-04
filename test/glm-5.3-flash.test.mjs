import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry and synthetic account
// fixtures, so the machine's own models, credentials, and quota history must
// not leak in; the imports are dynamic for that reason.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "glm-5.3-flash-test-"));
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG, validateOpenRouterRoute } = await import("../src/routed-models.mjs");

test("OpenRouter GLM owns its Codex prompt and selected endpoint policy", () => {
  const model = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");
  assert.equal(model.behaviorTemplate, "gpt-5.6-sol");
  assert.equal(model.instructionProfile, "glm-5.3-flash-codex");
  assert.equal(model.supportsParallelToolCalls, undefined);
  assert.equal(model.supportsSearchHistory, true);
  assert.equal(model.multiAgentVersion, "v2");
  assert.deepEqual(model.openRouterProviderPolicy, {
    order: ["novita"],
    only: ["novita"],
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.deepEqual(model.openRouterEndpointCompatibility, {
    dropParallelToolCalls: true,
  });
});

test("OpenRouter GLM accepts any one explicitly selected endpoint", () => {
  const model = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");
  assert.doesNotThrow(() => validateOpenRouterRoute({
    ...model,
    openRouterProviderPolicy: {
      ...model.openRouterProviderPolicy,
      order: ["another-provider"],
      only: ["another-provider"],
    },
    openRouterEndpointCompatibility: { dropParallelToolCalls: false },
  }));
});

test("OpenRouter GLM refuses unbounded or ambiguous endpoint routing", () => {
  const model = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");
  for (const openRouterProviderPolicy of [
    { ...model.openRouterProviderPolicy, allow_fallbacks: true },
    { ...model.openRouterProviderPolicy, only: ["novita", "another-provider"] },
    { ...model.openRouterProviderPolicy, order: ["another-provider"] },
  ]) {
    assert.throws(
      () => validateOpenRouterRoute({ ...model, openRouterProviderPolicy }),
      /select one endpoint provider/u,
    );
  }
  assert.throws(
    () => validateOpenRouterRoute({ ...model, supportsSearchHistory: false }),
    /search-history replay/u,
  );
});
