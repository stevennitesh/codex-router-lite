import { secretEqual } from "./caller-auth.mjs";

const BEARER_PREFIX = "bearer";
const NATIVE_UNSUPPORTED_PARAMS = Object.freeze([
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "max_tokens",
  "max_output_tokens",
  "metadata",
  "seed",
  "user",
  "truncation",
]);
const NATIVE_STATELESS_REASONING_INCLUDE = "reasoning.encrypted_content";

// Parse rather than match. A regular expression with overlapping whitespace
// quantifiers can backtrack on a caller-controlled header containing many
// spaces and no token.
export function bearerToken(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= BEARER_PREFIX.length) return undefined;
  if (trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return undefined;
  }
  const separator = trimmed[BEARER_PREFIX.length];
  if (separator !== " " && separator !== "\t") return undefined;
  const token = trimmed.slice(BEARER_PREFIX.length + 1).trim();
  return token || undefined;
}

export function callerBroughtNoUpstreamCredential(
  headers = {},
  { callerKey = "", internalKey = "" } = {},
) {
  const presented = bearerToken(headers.authorization);
  if (presented === undefined) return headers.authorization === undefined;
  return secretEqual(presented, callerKey) || secretEqual(presented, internalKey);
}

// Apply this only after the Router substitutes the local Codex session. Native
// Codex traffic already has the correct contract and must pass through intact.
export function normalizeNativeForSubstitutedCaller(payload, { compact = false } = {}) {
  if (compact) {
    delete payload.store;
    delete payload.include;
  } else {
    payload.store = false;
    if (payload.include === undefined) {
      payload.include = [NATIVE_STATELESS_REASONING_INCLUDE];
    } else if (
      Array.isArray(payload.include) &&
      !payload.include.includes(NATIVE_STATELESS_REASONING_INCLUDE)
    ) {
      payload.include = [...payload.include, NATIVE_STATELESS_REASONING_INCLUDE];
    }
  }
  for (const key of NATIVE_UNSUPPORTED_PARAMS) delete payload[key];
  return payload;
}

// Current Codex builds can still emit this legacy field on later GPT-5.6
// turns. Omitting it keeps implicit prompt caching active.
export function normalizeNativePromptCacheCompatibility(payload) {
  if (/^gpt-5\.6(?:-|$)/.test(String(payload.model || ""))) {
    delete payload.prompt_cache_retention;
  }
  return payload;
}

export const NATIVE_REASONING_EFFORT_LADDER = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function supportedNativeEfforts(model) {
  if (!Array.isArray(model?.supported_reasoning_levels)) return [];
  return [...new Set(
    model.supported_reasoning_levels
      .map((level) => (typeof level === "string" ? level : level?.effort))
      .filter((effort) => NATIVE_REASONING_EFFORT_LADDER.includes(effort)),
  )];
}

export function clampNativeReasoningEffort(requested, supported) {
  if (typeof requested !== "string" || supported.includes(requested)) return requested;
  const requestedIndex = NATIVE_REASONING_EFFORT_LADDER.indexOf(requested);
  if (requestedIndex < 0) return requested;
  const ordered = supported
    .filter((effort) => NATIVE_REASONING_EFFORT_LADDER.includes(effort))
    .sort(
      (left, right) =>
        NATIVE_REASONING_EFFORT_LADDER.indexOf(left) -
        NATIVE_REASONING_EFFORT_LADDER.indexOf(right),
    );
  if (!ordered.length) return requested;
  const atOrBelow = ordered.filter(
    (effort) => NATIVE_REASONING_EFFORT_LADDER.indexOf(effort) <= requestedIndex,
  );
  return atOrBelow.at(-1) || ordered[0];
}

// Codex can apply a newly selected native model before its effort picker has
// replaced the previous model's value. Repair only known Codex effort names
// against the current catalog; unknown future values and missing catalog
// metadata remain fail-open so the upstream validator still exposes real drift.
export function normalizeNativeReasoningEffort(payload, models = []) {
  const model = models.find((candidate) => candidate?.slug === payload?.model);
  const supported = supportedNativeEfforts(model);
  if (!supported.length) return [];

  const changes = [];
  const nested = payload?.reasoning?.effort;
  const normalizedNested = clampNativeReasoningEffort(nested, supported);
  if (normalizedNested !== nested) {
    payload.reasoning = { ...payload.reasoning, effort: normalizedNested };
    changes.push({ field: "reasoning.effort", from: nested, to: normalizedNested });
  }

  const flat = payload?.reasoning_effort;
  const normalizedFlat = clampNativeReasoningEffort(flat, supported);
  if (normalizedFlat !== flat) {
    payload.reasoning_effort = normalizedFlat;
    changes.push({ field: "reasoning_effort", from: flat, to: normalizedFlat });
  }
  return changes;
}
