// Historical observation vocabulary, shared by the sanitized writer and reader.
// This does not derive past log identities from today's routing configuration.
export const OBSERVED_NATIVE_MODELS = Object.freeze({
  "gpt-5.6-luna": "luna",
  "gpt-5.6-sol": "sol",
  "gpt-6.1-sol": "sol",
  "gpt-6-astra": "astra",
});
export const OBSERVED_NATIVE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const OBSERVED_NATIVE_TIERS = Object.freeze(["default", "priority", "flex"]);
export const OBSERVED_NATIVE_OUTCOMES = Object.freeze([
  "completed", "incomplete", "cancelled", "http_error", "stream_error",
  "transport_error", "empty_completion", "retryable_http", "unknown",
]);
export const OBSERVED_TARGETS = Object.freeze({
  "switchyard/luna-max": Object.freeze({ key: "lunaMax", model: "gpt-5.6-luna", effort: "max", label: "luna_max" }),
  "switchyard/luna-high": Object.freeze({ key: "lunaHigh", model: "gpt-5.6-luna", effort: "high", label: "luna_high" }),
  "switchyard/sol-medium": Object.freeze({ key: "solMedium", model: "gpt-5.6-sol", effort: "medium", label: "sol_medium" }),
  "switchyard/sol-high": Object.freeze({ key: "solHigh", model: "gpt-6.1-sol", effort: "high", label: "sol_high" }),
  "switchyard/astra-medium": Object.freeze({ key: "astraMedium", model: "gpt-6-astra", effort: "medium", label: "astra_medium" }),
  "switchyard/astra-xhigh": Object.freeze({ key: "astraXhigh", model: "gpt-6-astra", effort: "xhigh", label: "astra_xhigh" }),
});
export const OBSERVED_CLASSIFIER_LABELS = Object.freeze(Object.values(OBSERVED_TARGETS).map(target => target.label));
export const OBSERVED_CLASSIFIER_LABEL_SETS = Object.freeze([
  Object.freeze(["luna_max", "sol_medium", "astra_medium", "astra_xhigh"]),
  Object.freeze(["luna_max", "sol_high", "astra_medium", "astra_xhigh"]),
]);
export const OBSERVED_FALLBACK_REASONS = Object.freeze([
  "empty_state", "non_text_state", "low_confidence", "classifier_unavailable",
  "classifier_timeout", "provider_http_error", "malformed_response", "state_too_large",
  "invalid_confidence", "unresolved_label",
]);
export const OBSERVED_CLASSIFIER_REASONS = Object.freeze(["selected", ...OBSERVED_FALLBACK_REASONS]);
const JEV_FAMILY = "typesafe/jev-1.13";
const OBSERVED_CLASSIFIER_BUILDS = new Set(["typesafe/jev-1.13-20260917"]);

// Family and nonempty build presence preserve the live observer's predicate.
// They are observed structure, not an endorsement of an unknown build string.
// Only historically approved identities may be copied into presentation.
export function observedClassifierProvider(value) {
  const family = value === JEV_FAMILY || typeof value === "string" && value.startsWith(`${JEV_FAMILY}-`);
  const buildObserved = family && value.length > JEV_FAMILY.length + 1;
  return {
    providerModel: OBSERVED_CLASSIFIER_BUILDS.has(value) || value === JEV_FAMILY ? value : buildObserved ? "jev-1.13 build" : "unknown",
    providerFamily: family ? "jev-1.13" : "unknown",
    providerBuildObserved: Boolean(buildObserved),
  };
}
