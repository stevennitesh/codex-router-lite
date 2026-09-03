import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry and synthetic account
// fixtures, so the machine's own models, credentials, and quota history must
// not leak in; the imports are dynamic for that reason.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "glm-5.3-flash-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG, MODEL_SLUG_ALIASES } = await import("../src/model-registry.mjs");
const { REQUEST_PROFILES } = await import("../src/request-profiles.mjs");

// This inventory asserts checked-in metadata only. The Ollama Cloud entry is a
// candidate until its own current-head router-level exact-route certificate is
// recorded; presence in this array is not that proof.
const ROUTES = [
  ["opencode-go/glm-5.3-flash", "glm-5.3-flash", "glm-5.3-flash", 1_000_000, 400_000, ["text", "image"]],
  ["ollama-cloud/glm-5.3-flash", "glm-5.3-flash:cloud", "ollama-cloud-glm-5-3-flash", 1_000_000, 400_000, ["text", "image"]],
  ["openrouter/glm-5.3-flash", "z-ai/glm-5.3-flash", "glm-5.3-flash", 1_048_576, 900_000, ["text", "image"]],
  ["zai-api/glm-5.3-flash", "glm-5.3-flash", "glm-thinking", 1_000_000, 400_000, ["text"]],
  ["zai-coding/glm-5.3-flash", "glm-5.3-flash", "glm-thinking", 1_000_000, 400_000, ["text"]],
];

test("every checked-in GLM-5.3-Flash route records its static metadata", () => {
  for (const [slug, upstreamModel, requestProfile, contextWindow, autoCompact, inputModalities] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["low", "high", "max"]);
    assert.equal(model.defaultEffort, "max");
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
    assert.deepEqual(model.inputModalities, inputModalities);
    assert.equal(model.requestProfile, requestProfile);
  }
});

test("OpenRouter GLM owns its Codex prompt and Novita provider policy", () => {
  const model = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");
  assert.equal(model.behaviorTemplate, "gpt-5.6-sol");
  assert.equal(model.instructionProfile, "glm-5.3-flash-codex");
  assert.equal(model.supportsParallelToolCalls, undefined);
  assert.equal(model.multiAgentVersion, "v2");
  assert.deepEqual(model.openRouterProviderPolicy, {
    order: ["novita"],
    only: ["novita"],
    allow_fallbacks: false,
    require_parameters: true,
  });
});

test("the live registry contains no Ox compatibility identity", () => {
  assert.equal(REQUEST_PROFILES.some((profile) => profile.includes("ox")), false);
  assert.equal([...MODEL_SLUG_ALIASES.keys()].some((slug) => slug.includes("ox-alpha")), false);
  assert.equal([...MODEL_BY_SLUG.keys()].some((slug) => slug.includes("ox-alpha")), false);
});

test("withdrawn or uncertified reseller routes stay absent while direct-proven routes remain", () => {
  for (const slug of [
    "commandcode/ox-alpha",
    "nousresearch/ox-alpha",
    "opencode-free/ox-alpha",
    "openrouter/ox-alpha",
    "venice/ox-alpha",
  ]) {
    assert.equal(MODEL_BY_SLUG.has(slug), false, `${slug} should not exist`);
  }
  for (const slug of [
    "commandcode/glm-5.3-flash",
    "nousresearch/glm-5.3-flash",
    "venice/glm-5.3-flash",
  ]) {
    assert.equal(MODEL_BY_SLUG.has(slug), false, `${slug} is not route-certified`);
  }
  assert.equal(MODEL_BY_SLUG.has("openrouter/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("zai-api/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("zai-coding/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("opencode-go/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("ollama-cloud/glm-5.3-flash"), true);
});
