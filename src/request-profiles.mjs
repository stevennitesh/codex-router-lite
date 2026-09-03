// Request profiles are executable router behavior, not free-form metadata.
// Keep the complete set closed here so neither a live provider catalog nor a
// hand-edited model overlay can mint a new behavior merely by naming it.
export const REQUEST_PROFILES = Object.freeze(["glm-5.3-flash", "switchyard-native"]);

const PROFILE_SET = new Set(REQUEST_PROFILES);

// The lite product has no user-curated behavior profiles.
export const CURATABLE_REQUEST_PROFILES = Object.freeze([]);

const CURATABLE_PROFILE_SET = new Set(CURATABLE_REQUEST_PROFILES);

export function requestProfileKnown(value) {
  return typeof value === "string" && PROFILE_SET.has(value);
}

export function curatableRequestProfile(value) {
  return typeof value === "string" && CURATABLE_PROFILE_SET.has(value);
}
