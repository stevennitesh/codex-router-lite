// Routed failures stay on the selected route. The only automatic retry is the
// same-request, pre-response retry owned by upstream-retry.mjs.
export const FAILOVER_BUDGET_MS = 0;
export const MAX_FAILOVER_HOPS = 1;

export function classifyRoutedFailure() {
  return { swap: false };
}

export function rankFailoverCandidates() {
  return [];
}

export function readFailoverSettings() {
  return { enabled: false, chain: [] };
}

export function providerCooldown() {
  return undefined;
}

export function recordProviderCooldown() {
  return undefined;
}

export function clearProviderCooldown() {
  return false;
}

export function cooldownScope(providerId) {
  return String(providerId || "");
}
