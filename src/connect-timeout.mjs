// Dependency-free by design: upstream-retry derives its default budget from
// this bound and can be imported by setup/diagnostic paths before npm
// dependencies are installed. Do not import Undici here.
export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const MIN_CONNECT_TIMEOUT_MS = 500;
export const MAX_CONNECT_TIMEOUT_MS = 30_000;

export function connectTimeoutMs(environment = process.env) {
  const raw = Number(environment.CODEX_ROUTER_CONNECT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_CONNECT_TIMEOUT_MS;
  return Math.min(
    MAX_CONNECT_TIMEOUT_MS,
    Math.max(MIN_CONNECT_TIMEOUT_MS, Math.floor(raw)),
  );
}
