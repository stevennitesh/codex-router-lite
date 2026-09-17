import assert from "node:assert/strict";
import test from "node:test";
import { CHECKED_IN_MODELS, PROVIDERS, validateRoutedRegistry, validateOpenRouterRoute } from "../src/routed-models.mjs";
import { prepareOpenRouterRequest } from "../src/openrouter-request.mjs";

const externalRoutes = CHECKED_IN_MODELS.filter(route => route.provider === "openrouter");

test("final OpenRouter preparation pins each endpoint and preserves caller input", () => {
  for (const route of externalRoutes) {
    for (const model of [route.slug, route.gatewayModel]) {
      const input = { model, input: [{ role: "user", content: "Synthetic marker" }],
        tools: [], tool_choice: "auto", client_metadata: { synthetic: true },
        prompt_cache_retention: "24h", parallel_tool_calls: true,
        provider: { only: ["untrusted"], allow_fallbacks: true } };
      const original = structuredClone(input);
      const output = prepareOpenRouterRequest(input);
      assert.deepEqual(input, original);
      assert.equal(output.model, route.upstreamModel);
      assert.deepEqual(output.provider, route.openRouterProviderPolicy);
      for (const key of ["tools", "tool_choice", "client_metadata", "prompt_cache_retention", "parallel_tool_calls"]) {
        assert.equal(Object.hasOwn(output, key), false, key);
      }
      assert.deepEqual(output.input, input.input);
    }
  }
  // This gateway alias deliberately retains its existing canonical Novita binding.
  const alias = prepareOpenRouterRequest({ model: "z-ai/glm-5.3-flash", input: "marker" });
  assert.deepEqual(alias.provider.only, ["novita"]);
  for (const model of ["unknown/model", "switchyard/auto", "gpt-5.6-luna"]) {
    assert.throws(() => prepareOpenRouterRequest({ model }), /Only /);
  }
});

test("internal callers cannot bypass final hosted-search bounds", () => {
  for (const route of externalRoutes) {
    for (const tools of [[{ type: "web_search" }], [{ type: "openrouter:unknown" }],
      [{ type: "openrouter:web_search", parameters: { max_results: 100 } }]]) {
      assert.throws(() => prepareOpenRouterRequest({ model: route.slug, tools }),
        error => error.code === "model_search_not_supported");
    }
    if (!route.searchTool) continue;
    const tool = { type: "openrouter:web_search", parameters: structuredClone(route.searchTool.parameters) };
    const output = prepareOpenRouterRequest({ model: route.slug, tools: [tool], max_tool_calls: 0 });
    assert.deepEqual(output.tools, [tool]);
    assert.equal(output.max_tool_calls, 0);
    for (const max_tool_calls of [-1, 4, 1.5]) {
      assert.throws(() => prepareOpenRouterRequest({ model: route.slug, tools: [tool], max_tool_calls }),
        error => error.code === "model_search_not_supported");
    }
  }
});

test("registry rejects ambiguous identities before creating route maps", () => {
  const providers = [...PROVIDERS.values()];
  assert.doesNotThrow(() => validateRoutedRegistry(providers, CHECKED_IN_MODELS));
  assert.throws(() => validateRoutedRegistry([providers[0], providers[0]], CHECKED_IN_MODELS), /Routed providers must contain exactly/);
  const duplicate = structuredClone(CHECKED_IN_MODELS);
  duplicate[1] = structuredClone(duplicate[0]);
  assert.throws(() => validateRoutedRegistry(providers, duplicate), /Routed models must contain exactly/);
  for (const gatewayModel of ["", "  ", CHECKED_IN_MODELS[0].gatewayModel, CHECKED_IN_MODELS[0].slug]) {
    const models = structuredClone(CHECKED_IN_MODELS);
    models[1].gatewayModel = gatewayModel;
    assert.throws(() => validateRoutedRegistry(providers, models), /unique nonempty gatewayModel/);
  }
  const wrongProvider = structuredClone(CHECKED_IN_MODELS);
  wrongProvider[0].provider = "switchyard";
  assert.throws(() => validateRoutedRegistry(providers, wrongProvider), /unsupported provider/);
  const wrongProfile = structuredClone(CHECKED_IN_MODELS);
  wrongProfile[0].requestProfile = "union-alpha";
  assert.throws(() => validateRoutedRegistry(providers, wrongProfile), /unsupported request profile/);
  assert.throws(() => validateOpenRouterRoute({ ...externalRoutes[0], requestProfile: "unknown" }), /Unsupported OpenRouter request profile/);
});
