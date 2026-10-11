import { isIP } from "node:net";
import { Agent, Dispatcher, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { connectTimeoutMs } from "./connect-timeout.mjs";
import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";

// Node 26's bundled fetch negotiates HTTP/2 by default. A live router process
// observed its pooled session remain destroyed after ERR_HTTP2_INVALID_SESSION,
// so every later native Codex request failed until the service restarted.
// Codex uses streaming Responses over ordinary HTTPS and does not
// require HTTP/2; an HTTP/1.1-only dispatcher removes that poisoned-session
// state while retaining keep-alive connection reuse.
//
// Concurrent Codex turns each hold one HTTP/1.1 streaming socket for the
// whole generation. Do not cap `connections`: Undici's HTTP/1.1 pool is
// unbounded by default, and one router plane serves every installed client.
// A numeric ceiling queues the next turn once it fills and recreates
// "waiting for network".
//
// Leave `keepAliveTimeout` at Undici's 4s default. This pool is shared by
// every outbound provider request, and an upstream that idle-closes without
// advertising `Keep-Alive: timeout=` hands back a half-closed socket once we
// hold connections longer than it does -- surfacing as UND_ERR_SOCKET on a
// POST Undici will not retry. Only the loopback probe pool below, whose one
// origin is our own server, raises it.
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 250;

function fetchDispatcherOptions(environment = process.env) {
  return {
    allowH2: false,
    pipelining: 1,
    connectTimeout: connectTimeoutMs(environment),
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
}

function isLoopbackOrigin(origin) {
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname === "[::1]" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
}

// Private Router, gateway and forwarder hops carry credentials and request
// bodies. Their literal loopback destinations must never depend on NO_PROXY.
// Leave every other origin with Undici's existing environment proxy policy;
// do not resolve names or expand this boundary to private networks or aliases.
class LoopbackIsolatingDispatcher extends Dispatcher {
  #direct;
  #external;

  constructor(direct, external) {
    super();
    this.#direct = direct;
    this.#external = external;
  }

  dispatch(options, handler) {
    const dispatcher = isLoopbackOrigin(options.origin) ? this.#direct : this.#external;
    return dispatcher.dispatch(options, handler);
  }

  get closed() { return this.#direct.closed && this.#external.closed; }
  get destroyed() { return this.#direct.destroyed && this.#external.destroyed; }
  get webSocketOptions() { return this.#external.webSocketOptions; }
  get eventSourceOptions() { return this.#external.eventSourceOptions; }

  close(callback) {
    return this.#finish("close", undefined, callback);
  }

  destroy(error, callback) {
    if (typeof error === "function") { callback = error; error = undefined; }
    return this.#finish("destroy", error, callback);
  }

  #finish(method, error, callback) {
    if (callback !== undefined && typeof callback !== "function") throw new TypeError("invalid callback");
    const done = Promise.allSettled([this.#direct, this.#external].map(dispatcher =>
      Promise.resolve().then(() => dispatcher[method](error)))).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    if (callback) { done.then(() => callback(null), callback); return; }
    return done;
  }
}

export function installStableFetchTransport({
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  setDispatcher = setGlobalDispatcher,
  environment = process.env,
  execArgv = process.execArgv,
} = {}) {
  const options = fetchDispatcherOptions(environment);
  const direct = new AgentClass(options);
  const dispatcher = environmentHttpProxyConfigured(environment, execArgv)
    ? new LoopbackIsolatingDispatcher(direct, new EnvHttpProxyAgentClass(options))
    : direct;
  setDispatcher(dispatcher);
  return dispatcher;
}

// Health probes must not share the streaming pool. A GET /health/liveliness
// that queues behind five SSE POSTs to the same origin is what made the
// unauthenticated `/health` leaf hang long enough for doctor or readiness
// checks to call the router dead.
//
// Use undici's own `fetch` with this Agent. Passing an npm-undici dispatcher
// into Node's builtin `fetch` throws `invalid onRequestStart method`, every
// probe looks unreachable, and `/health` stays 503 until startup gives up.
function createLoopbackProbeDispatcher({
  AgentClass = Agent,
  timeoutMs = 3_000,
} = {}) {
  return new AgentClass({
    allowH2: false,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}

// One pool for the whole process. Building the Agent in a default parameter
// made a fresh connection pool on every probe instead, so each `/health` poll
// left another dispatcher -- and its sockets -- behind with nothing to close
// them. Created on first use so importing this module opens nothing.
let sharedProbeDispatcher;

function loopbackProbeDispatcher() {
  sharedProbeDispatcher ??= createLoopbackProbeDispatcher();
  return sharedProbeDispatcher;
}

export function loopbackProbeFetch(url, init = {}, dispatcher = loopbackProbeDispatcher()) {
  if (!isLoopbackOrigin(url)) throw new TypeError("Health probes require a literal loopback origin.");
  return undiciFetch(url, { ...init, dispatcher });
}
