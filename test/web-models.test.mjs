import assert from "node:assert/strict";
import test from "node:test";

import { buildWebBridgeModels, webModelSelection } from "../src/web-models.mjs";

const allCapabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };
const model = "chatgpt-web/gpt-6-sol";

test("Web catalog names the serving families and exposes only account-supported effort choices", () => {
  const models = buildWebBridgeModels(allCapabilities);
  assert.equal(models.find(row => row.slug === "chatgpt-web/gpt-6-pro").displayName, "GPT-6 Astra Pro (Web)");
  assert.equal(models.find(row => row.slug === "chatgpt-web/gpt-5.6-pro").displayName, "GPT-5.6 Sol Pro (Web)");
  assert.deepEqual(models.map(row => [row.slug, row.supported_reasoning_levels.map(level => level.effort), row.defaultEffort]), [
    ["chatgpt-web/gpt-6-sol-instant", ["low"], "low"],
    ["chatgpt-web/gpt-6-sol", ["medium", "high", "xhigh"], "medium"],
    ["chatgpt-web/gpt-5.6-sol-instant", ["low"], "low"],
    ["chatgpt-web/gpt-5.6-sol", ["medium", "high", "xhigh"], "medium"],
    ["chatgpt-web/gpt-5.6-pro", ["max"], "max"],
    ["chatgpt-web/gpt-6-pro", ["max"], "max"],
  ]);
  const reduced = buildWebBridgeModels({ solAvailable: true, extraHighAvailable: false, proAvailable: false });
  assert.equal(reduced.length, 4);
  assert.deepEqual(reduced.find(row => row.slug === model).supported_reasoning_levels.map(level => level.effort), ["medium", "high"]);
  assert.deepEqual(buildWebBridgeModels({ solAvailable: false, extraHighAvailable: false, proAvailable: false }), []);
  assert.ok(models.every(row => row.multi_agent_version === "v1"));
  for (const capabilities of [undefined, {}, { solAvailable: true, extraHighAvailable: "yes", proAvailable: false }]) {
    assert.throws(() => buildWebBridgeModels(capabilities), /capabilities/u);
  }
});

test("advertised Web routes select exact browser families and Power values", () => {
  const expected = [
    ["chatgpt-web/gpt-6-sol-instant", "GPT-6", { low: 0 }],
    ["chatgpt-web/gpt-6-sol", "GPT-6", { medium: 1, high: 2, xhigh: 3 }],
    ["chatgpt-web/gpt-5.6-sol-instant", "GPT-5.6 Sol", { low: 0 }],
    ["chatgpt-web/gpt-5.6-sol", "GPT-5.6 Sol", { medium: 1, high: 2, xhigh: 3 }],
    ["chatgpt-web/gpt-5.6-pro", "GPT-5.6 Sol", { max: 4 }],
    ["chatgpt-web/gpt-6-pro", "GPT-6", { max: 4 }],
  ];
  for (const [slug, family, powers] of expected) {
    const advertised = buildWebBridgeModels(allCapabilities).find(row => row.slug === slug);
    assert.deepEqual(advertised.supported_reasoning_levels.map(row => row.effort), Object.keys(powers));
    assert.deepEqual(webModelSelection(slug), { family, power: powers[advertised.defaultEffort] });
    for (const [effort, power] of Object.entries(powers)) assert.deepEqual(webModelSelection(slug, effort), { family, power });
  }
  for (const [slug, effort] of [["chatgpt-web/sol", "medium"], [model, "low"], [model, "max"], [model, "toString"]]) {
    assert.throws(() => webModelSelection(slug, effort), { status: 400, code: "web_model_unverified" });
  }
});
