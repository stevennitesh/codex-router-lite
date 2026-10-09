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
