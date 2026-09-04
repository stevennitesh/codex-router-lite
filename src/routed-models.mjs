import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILES = Object.freeze([
  "config/openrouter/openrouter.json",
  "config/openrouter/glm-5.3-flash.json",
  "config/switchyard/switchyard.json",
  "config/switchyard/auto.json",
]);
const EXPECTED_PROVIDERS = new Set(["openrouter", "switchyard"]);
const EXPECTED_MODELS = new Set(["openrouter/glm-5.3-flash", "switchyard/auto"]);
const EXPECTED_REQUEST_PROFILES = new Map([
  ["openrouter/glm-5.3-flash", "glm-5.3-flash"],
  ["switchyard/auto", "switchyard-native"],
]);
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

const providerRecords = [
  ...load(CONFIG_FILES[0]).providers,
  ...load(CONFIG_FILES[2]).providers,
];
const modelRecords = [
  ...load(CONFIG_FILES[1]).models,
  ...load(CONFIG_FILES[3]).models,
];

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
  const policy = model?.openRouterProviderPolicy;
  const order = Array.isArray(policy?.order) ? policy.order : [];
  const only = Array.isArray(policy?.only) ? policy.only : [];
  const oneEndpoint = order.length === 1 && only.length === 1 && order[0] === only[0];
  if (
    model?.upstreamModel !== "z-ai/glm-5.3-flash" ||
    !oneEndpoint ||
    !OPENROUTER_PROVIDER_ID.test(String(only[0] || "")) ||
    policy?.allow_fallbacks !== false ||
    policy?.require_parameters !== true ||
    model?.supportsSearchHistory !== true
  ) {
    throw new Error(
      "OpenRouter GLM-5.3-Flash must select one endpoint provider with fallback disabled, parameter support required, and completed search-history replay enabled.",
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

const openRouter = validateOpenRouterRoute(
  modelRecords.find((model) => model.slug === "openrouter/glm-5.3-flash"),
);

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
