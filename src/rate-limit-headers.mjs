// Passive rate-limit discovery.
//
// Most OpenAI-compatible providers report the caller's remaining quota on every
// response through `x-ratelimit-*` headers, and Anthropic reports the same facts
// under an `anthropic-ratelimit-*` prefix. Reading them costs no extra request
// and needs no provider-specific balance endpoint, so a provider reports its own
// limits as soon as the user makes a real call.
//
// This module is pure parsing. Persistence lives in rate-limit-state.mjs.

const DURATION_PATTERN = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)m?s)?$/;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function count(value) {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}

// Providers express resets three different ways: a Go-style duration
// ("2m59.56s", "7.66s"), bare seconds ("60"), or an absolute timestamp. All three
// normalize to an absolute epoch milliseconds value so consumers never re-parse.
export function resetAt(value, now = Date.now()) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;

  const bare = finiteNumber(text);
  if (bare !== undefined) {
    // A plain number is seconds-from-now when small, and an epoch when it is
    // large enough to be a real timestamp (some gateways send epoch seconds).
    if (bare >= 1_000_000_000) return Math.round(bare * (bare >= 1e12 ? 1 : 1000));
    return bare >= 0 ? now + Math.round(bare * 1000) : undefined;
  }

  const duration = DURATION_PATTERN.exec(text.toLowerCase());
  if (duration && duration.slice(1).some(Boolean)) {
    const hours = finiteNumber(duration[1]) || 0;
    const minutes = finiteNumber(duration[2]) || 0;
    const seconds = finiteNumber(duration[3]) || 0;
    const ms = text.toLowerCase().endsWith("ms") ? seconds : seconds * 1000;
    return now + Math.round(hours * 3_600_000 + minutes * 60_000 + ms);
  }

  const absolute = Date.parse(text);
  return Number.isFinite(absolute) ? absolute : undefined;
}

function window(headers, limitKeys, remainingKeys, resetKeys, now) {
  const read = (keys) => {
    for (const key of keys) {
      const value = headers.get(key);
      if (value !== null && value !== undefined && String(value).trim() !== "") return value;
    }
    return undefined;
  };
  const limit = count(read(limitKeys));
  const remaining = count(read(remainingKeys));
  const reset = resetAt(read(resetKeys), now);
  if (limit === undefined && remaining === undefined && reset === undefined) return undefined;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined ? { resetAt: new Date(reset).toISOString() } : {}),
  };
}

// `headers` is a fetch Headers instance (case-insensitive lookup).
export function parseRateLimitHeaders(headers, { now = Date.now() } = {}) {
  if (!headers || typeof headers.get !== "function") return undefined;

  const requests = window(
    headers,
    ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit", "x-ratelimit-limit"],
    [
      "x-ratelimit-remaining-requests",
      "anthropic-ratelimit-requests-remaining",
      "x-ratelimit-remaining",
    ],
    ["x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset", "x-ratelimit-reset"],
    now,
  );
  const tokens = window(
    headers,
    ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"],
    ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"],
    ["x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset"],
    now,
  );
  const retryAt = resetAt(headers.get("retry-after"), now);

  if (!requests && !tokens && retryAt === undefined) return undefined;
  return {
    ...(requests ? { requests } : {}),
    ...(tokens ? { tokens } : {}),
    ...(retryAt !== undefined ? { retryAt: new Date(retryAt).toISOString() } : {}),
  };
}

// Pool selection needs one unambiguous unit per credential. Only a complete
// request window is safe to attach to the key that produced this response;
// token windows are intentionally left in provider-level telemetry because a
// streamed usage event is not guaranteed to retain the winning credential id.
export function requestQuotaFromRateLimitHeaders(headers, { now = Date.now() } = {}) {
  const requests = parseRateLimitHeaders(headers, { now })?.requests;
  if (!(requests?.limit > 0) || !Number.isFinite(requests.remaining)) return undefined;
  return {
    unit: "requests",
    limit: requests.limit,
    remaining: requests.remaining,
    ...(requests.resetAt ? { resetAt: requests.resetAt } : {}),
    observedAt: new Date(now).toISOString(),
  };
}

// `Retry-After` may be either delay-seconds or an HTTP-date. Keep an absent or
// invalid header distinct from an explicit zero so callers do not invent a
// retry window or silently ignore a valid dated one.
export function retryAfterSeconds(headers, { now = Date.now() } = {}) {
  if (!headers || typeof headers.get !== "function") return undefined;
  const at = resetAt(headers.get("retry-after"), now);
  if (at === undefined) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1_000));
}

// The soonest moment a provider is worth retrying, or undefined when nothing in
// the response says the caller is currently limited. A cooldown map reads this.
export function cooldownUntil(snapshot) {
  if (!snapshot) return undefined;
  const candidates = [
    snapshot.retryAt,
    snapshot.requests?.remaining === 0 ? snapshot.requests.resetAt : undefined,
    snapshot.tokens?.remaining === 0 ? snapshot.tokens.resetAt : undefined,
  ].filter(Boolean);
  if (!candidates.length) return undefined;
  return candidates.sort()[candidates.length - 1];
}
