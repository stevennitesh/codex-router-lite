import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// One explicit registration per retained model. Catalog data stays in JSON;
// the independent product-boundary check still controls the allowed file set.
const MODEL_REGISTRATIONS = [
  ["openrouter/glm-5.3-flash", "glm-5.3-flash"],
  ["openrouter/glm-5.3-flash-gmicloud", "glm-5.3-flash"],
  ["openrouter/union-alpha", "union-alpha"],
  ["switchyard/auto", "switchyard-native"],
];
const CONFIG_FILES = ["config/openrouter/openrouter.json", "config/switchyard/switchyard.json",
  ...MODEL_REGISTRATIONS.map(([slug]) => `config/${slug}.json`)];
const EXPECTED_PROVIDERS = new Set(["openrouter", "switchyard"]);
const EXPECTED_MODELS = new Set(MODEL_REGISTRATIONS.map(([slug]) => slug));
const EXPECTED_REQUEST_PROFILES = new Map(MODEL_REGISTRATIONS.map(([slug, profile]) => [slug, profile]));
const TRANSPORTS = new Map([
  ["glm-5.3-flash", "chat"], ["union-alpha", "responses"], ["switchyard-native", "native"],
]);

export function routedTransport(route) {
  const transport = TRANSPORTS.get(route?.requestProfile);
  if (!transport) throw new Error(`Unknown routed request profile: ${route?.requestProfile}`);
  return transport;
}
const OPENROUTER_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/u;

function load(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function exactIds(records, expected, label) {
  const ids = records.map((record) => String(record.id || record.slug || ""));
  if (ids.length !== expected.size || ids.some((id) => !expected.has(id))) {
    throw new Error(`${label} must contain exactly: ${[...expected].join(", ")}.`);
  }
}

const records = CONFIG_FILES.map(load);
const providerRecords = records.flatMap((record) => record.providers || []);
const modelRecords = records.flatMap((record) => record.models || []);

exactIds(providerRecords, EXPECTED_PROVIDERS, "Routed providers");
exactIds(modelRecords, EXPECTED_MODELS, "Routed models");

for (const model of modelRecords) {
  if (!EXPECTED_PROVIDERS.has(model.provider)) {
    throw new Error(`Routed model ${model.slug} names unsupported provider ${model.provider}.`);
  }
  if (model.requestProfile !== EXPECTED_REQUEST_PROFILES.get(model.slug)) {
    throw new Error(`Routed model ${model.slug} has unsupported request profile ${model.requestProfile}.`);
  }
}

export function validateOpenRouterRoute(model) {
  if (model?.slug === "openrouter/union-alpha") {
    const policy = model.openRouterProviderPolicy;
    if (model.upstreamModel !== "stealth/union-alpha" ||
        policy?.only?.length !== 1 || policy.only[0] !== "stealth" ||
        policy?.order?.length !== 1 || policy.order[0] !== "stealth" ||
        policy.allow_fallbacks !== false || policy.require_parameters !== true ||
        model.requestProfile !== "union-alpha" ||
        model.openRouterEndpointCompatibility?.dropParallelToolCalls !== true ||
        model.searchTool !== undefined || model.supportsSearchHistory === true) {
      throw new Error("Union Alpha must select the exact Stealth endpoint with fallback disabled, parameter support required, and no hosted-search claim.");
    }
    return model;
  }
  const policy = model?.openRouterProviderPolicy;
  const order = Array.isArray(policy?.order) ? policy.order : [];
  const only = Array.isArray(policy?.only) ? policy.only : [];
  const oneEndpoint = order.length === 1 && only.length === 1 && order[0] === only[0];
  const search = model?.searchTool;
  const searchParameters = search?.parameters;
  const validSearch =
    search?.mode === "hosted" &&
    search?.serverType === "openrouter:web_search" &&
    Number.isInteger(search?.maxToolCalls) &&
    search.maxToolCalls > 0 &&
    search.maxToolCalls <= 3 &&
    searchParameters?.engine === "exa" &&
    searchParameters?.mode === "fast" &&
    Number.isInteger(searchParameters?.max_results) &&
    searchParameters.max_results > 0 &&
    searchParameters.max_results <= 10 &&
    Number.isInteger(searchParameters?.max_total_results) &&
    searchParameters.max_total_results >= searchParameters.max_results &&
    searchParameters.max_total_results <= 30 &&
    Number.isInteger(searchParameters?.max_uses) &&
    searchParameters.max_uses > 0 &&
    searchParameters.max_uses <= 3 &&
    Object.keys(search).every((key) =>
      ["mode", "serverType", "parameters", "maxToolCalls"].includes(key)) &&
    Object.keys(searchParameters || {}).every((key) =>
      ["engine", "mode", "max_results", "max_total_results", "max_uses"].includes(key));
  if (
    model?.upstreamModel !== "z-ai/glm-5.3-flash" ||
    !oneEndpoint ||
    !OPENROUTER_PROVIDER_ID.test(String(only[0] || "")) ||
    policy?.allow_fallbacks !== false ||
    policy?.require_parameters !== true ||
    model?.supportsSearchHistory !== true ||
    !validSearch
  ) {
    throw new Error(
      "OpenRouter GLM-5.3-Flash must select one endpoint provider with fallback disabled, parameter support required, bounded hosted search, and completed search-history replay.",
    );
  }
  const endpointCompatibility = model.openRouterEndpointCompatibility;
  if (
    !endpointCompatibility ||
    typeof endpointCompatibility.dropParallelToolCalls !== "boolean" ||
    Object.keys(endpointCompatibility).some((key) => key !== "dropParallelToolCalls")
  ) {
    throw new Error(
      "OpenRouter GLM-5.3-Flash must declare its selected endpoint compatibility flags.",
    );
  }
  return model;
}

for (const model of modelRecords.filter((candidate) => candidate.provider === "openrouter")) {
  validateOpenRouterRoute(model);
}

export const PROVIDERS = new Map(providerRecords.map((provider) => [provider.id, Object.freeze(provider)]));
export const CHECKED_IN_MODELS = Object.freeze(modelRecords.map((model) => Object.freeze(model)));
const MODELS = CHECKED_IN_MODELS;
export const LISTED_MODELS = Object.freeze(MODELS.filter((model) => model.listed));
export const MODEL_BY_SLUG = new Map(MODELS.map((model) => [model.slug, model]));
export const MODEL_BY_GATEWAY_ID = new Map(MODELS.map((model) => [model.gatewayModel, model]));

export function providerForModel(model) {
  const provider = PROVIDERS.get(model?.provider);
  if (!provider) throw new Error(`Unknown routed provider for ${model?.slug || "model"}.`);
  return provider;
}

export function resolveProviderBaseUrl(provider, env = process.env) {
  if (!provider) throw new Error("Routed provider is required.");
  const configured = provider.baseUrlEnv ? String(env[provider.baseUrlEnv] || "").trim() : "";
  const candidate = configured || provider.baseUrl;
  const parsed = new URL(candidate);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.|$)/u.test(host);
  const refusedOverride = provider.id === "switchyard" && configured !== "" && !loopback;
  return { baseUrl: refusedOverride ? provider.baseUrl : parsed.href.replace(/\/$/u, ""), refusedOverride };
}
