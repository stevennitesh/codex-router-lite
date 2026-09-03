const DURATION_PATTERN = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)m?s)?$/;

function resetAt(value, now = Date.now()) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  const bare = Number(text);
  if (Number.isFinite(bare)) {
    if (bare >= 1_000_000_000) return Math.round(bare * (bare >= 1e12 ? 1 : 1000));
    return bare >= 0 ? now + Math.round(bare * 1000) : undefined;
  }
  const duration = DURATION_PATTERN.exec(text.toLowerCase());
  if (duration && duration.slice(1).some(Boolean)) {
    const hours = Number(duration[1] || 0);
    const minutes = Number(duration[2] || 0);
    const seconds = Number(duration[3] || 0);
    return now + Math.round(hours * 3_600_000 + minutes * 60_000 +
      (text.toLowerCase().endsWith("ms") ? seconds : seconds * 1000));
  }
  const absolute = Date.parse(text);
  return Number.isFinite(absolute) ? absolute : undefined;
}

export function retryAfterSeconds(headers, { now = Date.now() } = {}) {
  if (!headers || typeof headers.get !== "function") return undefined;
  const at = resetAt(headers.get("retry-after"), now);
  return at === undefined ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}
