import { PORTS, TARGET, loopback } from "./paths.mjs";
import { conclusivelyRefused } from "./transport-error-graph.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const ROUTER_SERVICE = "codex-router";
const SUPPORTED_TARGETS = new Set(["codex"]);

export async function waitForRouterHealth({
  target = TARGET,
  url = loopback(PORTS.router, "/live"),
  timeoutMs = 30_000,
  requestTimeoutMs = 4_000,
  intervalMs = 250,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!SUPPORTED_TARGETS.has(target)) throw new Error(`Unknown router target: ${target}`);
  const expectedService = ROUTER_SERVICE;

  const overallTimeoutMs = Math.max(0, timeoutMs);
  const deadline = Date.now() + overallTimeoutMs;
  let lastError = "service unavailable";
  // A router that answers but reports a dependency down is a different failure
  // from a router that is not listening, and only the first one is survivable
  // (the gateway is restarted in place). Keep the last such payload so the
  // caller can say which of the two happened instead of "not ready".
  let lastPayload;
  // A health failure normally cannot prove that no router process exists: a
  // live process may be starting, wedged, or closing a connection. An exact
  // loopback ECONNREFUSED is the one useful negative signal because the OS
  // found no listener at that instant. Credential-publication guards consume
  // this bit and fail closed on every other failure shape.
  let connectionRefused = false;
  do {
    signal?.throwIfAborted();
    // The overall health budget is authoritative. A slow TCP/HTTP attempt near
    // its end must not consume a fresh full request timeout and make callers
    // wait past the deadline they supplied. Keep timeoutMs=0 as the existing
    // one-shot probe: tests and diagnostic callers use it to sample once.
    const remainingRequestMs = deadline - Date.now();
    const attemptTimeoutMs =
      overallTimeoutMs === 0
        ? requestTimeoutMs
        : Math.max(1, Math.min(requestTimeoutMs, remainingRequestMs));
    try {
      const response = await fetchImpl(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)])
          : AbortSignal.timeout(attemptTimeoutMs),
      });
      connectionRefused = false;
      const body = await response.text();
      signal?.throwIfAborted();
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        lastError = "health response was not JSON";
      }
      if (response.ok && payload.service === expectedService) {
        return { ok: true, payload };
      }
      if (payload.service && payload.service !== expectedService) {
        lastError = `a different service (${payload.service}) is listening on the router port`;
      } else if (payload.service === expectedService) {
        lastPayload = payload;
        const down = Array.isArray(payload.degraded) ? payload.degraded : [];
        lastError = down.length
          ? `it is listening but reports ${down.join(", ")} unreachable (HTTP ${response.status})`
          : `it is listening but answered HTTP ${response.status}`;
      } else if (response.status) {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      signal?.throwIfAborted();
      connectionRefused = conclusivelyRefused(error);
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs), undefined, { signal });
  } while (Date.now() <= deadline);

  return {
    ok: false,
    error: lastError,
    degradedPayload: lastPayload,
    connectionRefused,
  };
}
