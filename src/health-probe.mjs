import { probeDelayMs, probeTimeoutMs } from "./health-backoff.mjs";

// A failed connection backs off; a timed-out probe retries immediately with a
// wider window because its wait already consumed time without proving failure.
// Check actual HTTP readiness, including service identity when requested.
// The final probe can exceed the overall deadline by one bounded probe window.

function hasExited(child) {
  return Boolean(child) && (child.exitCode !== null || child.signalCode !== null);
}

async function drainResponse(response) {
  if (typeof response?.arrayBuffer === "function") {
    await response.arrayBuffer().catch(() => {});
  } else if (typeof response?.body?.cancel === "function") {
    await response.body.cancel().catch(() => {});
  }
}

/**
 * Poll `url` until the service behind it is healthy.
 *
 * Rejects when the child exits, when startup is interrupted, or when the
 * budget runs out. Child exit and shutdown are checked between probes and
 * sleeps; an in-flight probe or backoff interval can delay their detection.
 */
export async function waitForHealth({
  label,
  url,
  headers = {},
  timeoutMs = 30_000,
  expectedService,
  child,
  fetchImpl = fetch,
  isShuttingDown = () => false,
}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastFailure = "the service never answered";

  const assertStillStarting = () => {
    if (hasExited(child)) throw new Error(`${label} exited before becoming healthy.`);
    if (isShuttingDown()) throw new Error("Service startup was interrupted.");
  };

  // Do not wake this loop from a child exit callback: doing so while Windows
  // startup unwound caused libuv UV_HANDLE_CLOSING assertions (0xC0000409).
  const sleep = (ms) =>
    ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

  {
    while (Date.now() < deadline) {
      assertStillStarting();

      const windowMs = probeTimeoutMs(attempt);
      let timedOut = false;
      try {
        // Keep Node-owned timeout cancellation. A manually timed controller
        // also triggered the Windows libuv assertion during startup failure.
        const response = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(windowMs),
        });
        if (response.ok) {
          if (!expectedService) {
            await drainResponse(response);
            return;
          }
          const payload = await response.json().catch(() => ({}));
          if (payload.service === expectedService) return;
          lastFailure = `the health response did not identify ${expectedService}`;
        } else {
          await drainResponse(response);
          lastFailure = `the service answered HTTP ${response.status}`;
        }
      } catch (error) {
        // The distinction the whole fix rests on. A refusal is conclusive; a
        // window we closed ourselves concluded nothing. AbortSignal.timeout
        // rejects with a TimeoutError, and undici surfaces it either directly
        // or wrapped, so check both.
        timedOut = error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";
        lastFailure = timedOut
          ? `the service did not answer within ${windowMs} ms`
          : "the connection was refused";
      }

      const wait = timedOut
        ? 0
        : Math.min(probeDelayMs(attempt), Math.max(0, deadline - Date.now()));
      attempt += 1;
      assertStillStarting();
      await sleep(wait);
    }
    throw new Error(`Timed out waiting for ${label} to become healthy (${lastFailure}).`);
  }
}
