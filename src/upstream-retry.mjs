// Bounded recovery before caller output. Non-idempotent requests such as
// inference POSTs only retry conclusive connection failures: missing response
// headers, socket resets and edge statuses do not prove the request was unapplied.
// Caller permission and the elapsed budget are checked after every retry wait.

import { connectTimeoutMs } from "./connect-timeout.mjs";
import { transportErrorGraph } from "./transport-error-graph.mjs";

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 5_000;
const MAX_BUDGET_MS = 60_000;

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
// Backoff grows 250ms -> 750ms, so two retries add at most one second of
// waiting to a request that was going to fail anyway. Codex retries roughly
// five times on its own and the two loops multiply, so the router's share has
// to stay small enough that the product is still a fast failure.
const BACKOFF_FACTOR = 3;
// Slow edge failures remain outside the retry budget, but TCP connect timeout
// is different: the dispatcher now gives it an explicit bound, so a transient
// connect failure is cheap enough to retry. Derive the default budget from the
// same bound so the retryable error and the budget cannot drift apart again.
const DEFAULT_BUDGET_MS = Math.min(
  MAX_BUDGET_MS,
  Math.max(5_000, 3 * connectTimeoutMs()),
);

function clampedInteger(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const NATIVE_RETRY_LIMIT = clampedInteger(
  process.env.CODEX_ROUTER_NATIVE_RETRIES,
  DEFAULT_RETRIES,
  0,
  MAX_RETRIES,
);
const NATIVE_RETRY_BACKOFF_MS = clampedInteger(
  process.env.CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS,
  DEFAULT_BACKOFF_MS,
  0,
  MAX_BACKOFF_MS,
);
const NATIVE_RETRY_BUDGET_MS = clampedInteger(
  process.env.CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS,
  DEFAULT_BUDGET_MS,
  0,
  MAX_BUDGET_MS,
);

// Status recovery is limited to idempotent methods. Neither a 5xx nor a
// Retry-After establishes safe POST replay. Rate limits and origin 500s pass
// through even for idempotent requests.
const RETRYABLE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);

// Fetch wraps socket codes in error causes/aggregates. Some of these errors
// also occur after a POST was accepted; those require idempotent semantics.
const RETRYABLE_ERROR_CODES = new Set([
  "EADDRNOTAVAIL",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOBUFS",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const PRECONNECT_ERROR_CODES = new Set([
  "EADDRNOTAVAIL", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT",
]);

function conclusiveConnectError(node) {
  return PRECONNECT_ERROR_CODES.has(node.code) ||
    (node.syscall === "connect" && typeof node.code === "string" &&
      node.code.startsWith("E") && RETRYABLE_ERROR_CODES.has(node.code));
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

function isRetryableTransportError(error, idempotent) {
  if (!error) return false;
  // An abort is the caller leaving, and a router-side error (a body that is too
  // large, an unsupported encoding) carries its own HTTP status and would fail
  // identically every time.
  const graph = transportErrorGraph(error);
  if (!graph.complete || !graph.leaves.length || graph.nodes.some(node =>
    node.name === "AbortError" || node.name === "TimeoutError" || node.status ||
    (typeof node.code === "string" && !(idempotent
      ? RETRYABLE_ERROR_CODES.has(node.code) : conclusiveConnectError(node))))) return false;
  return graph.leaves.every(node => idempotent
    ? RETRYABLE_ERROR_CODES.has(node.code) : conclusiveConnectError(node));
}

// A backoff that a departing caller does not have to sit through: an abort
// resolves the wait immediately so the loop can stop on its next check.
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The upstream request was aborted by the caller.");
  error.name = "AbortError";
  return error;
}

// A failed attempt still owns a socket until its body is drained or cancelled.
function discardBody(response) {
  try {
    void response?.body?.cancel().catch(() => {});
  } catch {
    // The connection is already gone, which is the state we wanted anyway.
  }
}

function settle(response, failure, retries) {
  if (failure) throw failure;
  return { response, retries };
}

// Returns `{ response, retries }` where `retries` counts the attempts beyond
// the first, so a caller can tell "succeeded immediately" from "succeeded on
// the second try" and record the difference.
export async function fetchWithRetry(target, init = {}, options = {}) {
  const {
    retries = NATIVE_RETRY_LIMIT,
    backoffMs = NATIVE_RETRY_BACKOFF_MS,
    budgetMs = NATIVE_RETRY_BUDGET_MS,
    signal = init.signal,
    canRetry,
    onRetry,
    fetchImpl = fetch,
    sleepImpl = sleep,
    now = Date.now,
  } = options;
  const startedAt = now();
  const idempotent = IDEMPOTENT_METHODS.has(String(init.method ?? target?.method ?? "GET").toUpperCase());
  const eligible = () => canRetry?.() !== false && now() - startedAt < budgetMs;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    let response;
    let failure;
    try {
      response = await fetchImpl(target, init);
    } catch (error) {
      failure = error;
    }
    if (attempt >= retries) return settle(response, failure, attempt);
    const retryable = failure
      ? isRetryableTransportError(failure, idempotent)
      : idempotent && isRetryableStatus(response?.status);
    if (!retryable) return settle(response, failure, attempt);
    // The caller is gone, or has already relayed something. Either way this
    // request is over: a retry would be work for nobody, or a duplicated
    // stream.
    if (signal?.aborted) {
      discardBody(response);
      throw abortError(signal);
    }
    // This attempt was not cheap, so the failure was not the fast one a retry
    // absorbs. Relay it rather than spending the same time again.
    if (!eligible()) return settle(response, failure, attempt);
    const delayMs = backoffMs * BACKOFF_FACTOR ** attempt;
    if (delayMs >= budgetMs - (now() - startedAt)) return settle(response, failure, attempt);
    // Keep the refusal readable until a retry actually qualifies after waiting.
    await sleepImpl(delayMs, signal);
    if (signal?.aborted) {
      discardBody(response);
      throw abortError(signal);
    }
    if (!eligible()) return settle(response, failure, attempt);
    discardBody(response);
    if (signal?.aborted) throw abortError(signal);
    if (!eligible()) {
      // Cancellation has consumed the body; its status/headers remain known.
      const headers = response && new Headers(response.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers?.delete(name);
      const refusal = response ? new Response(null, {
        status: response.status, statusText: response.statusText, headers,
      }) : undefined;
      return settle(refusal, failure, attempt);
    }
    attempt += 1;
    onRetry?.({
      attempt,
      retries,
      status: response?.status,
      error: failure,
      delayMs,
    });
  }
}
