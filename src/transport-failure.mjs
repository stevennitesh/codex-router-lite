import { isIP } from "node:net";
import { environmentProxyOptedIn } from "./proxy-environment.mjs";
import { transportErrorGraph } from "./transport-error-graph.mjs";

// The router reaches every upstream through Undici's `fetch`, which reports a
// socket failure as a bare `TypeError: fetch failed` and buries the code that
// names it on `cause`. Both places the router turns such a failure into a
// response body used to say only "the local router could not complete the
// request", so a Codex user saw no cause at all: a poisoned DNS answer, a
// captive portal, a stopped gateway and a missing proxy were one message.
//
// This module answers the two questions that message left open -- which host
// could not be reached, and what went wrong reaching it -- in the same shape
// `error-translation.mjs` uses for upstream *bodies*. The two are deliberately
// separate: that module reads what an origin said, this one runs when nothing
// was ever said.
// Node DNS/TLS errors expose hostname; connect errors expose address. These
// identify a failed endpoint, which can also be a proxy, not its ownership.
const HOST_PATTERNS = [
  /attempted address(?:es)?:\s*(\[[^\]\s]+\]|[^\s:,)]+)/i,
  /getaddrinfo\s+\w+\s+([^\s,)]+)/i,
  /Host:\s*([^\s:,]+?)\.?\s/i,
];
const CONNECT_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

function displayHost(value) {
  if (typeof value !== "string" || !value || value.length > 253) return undefined;
  if (isIP(value)) return value;
  if (value.startsWith("[") && value.endsWith("]") && isIP(value.slice(1, -1)) === 6) return value;
  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  return hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))
    ? value : undefined;
}

function transportFailureHost(nodes) {
  for (const link of nodes) {
    const hostname = displayHost(link.hostname);
    if (hostname) return hostname;
    if (link.syscall === "connect" && CONNECT_CODES.has(link.code)) {
      const address = displayHost(link.address);
      if (address && isIP(address.replace(/^\[|\]$/gu, ""))) return address;
    }
    const message = typeof link.message === "string" ? link.message : "";
    for (const pattern of HOST_PATTERNS) {
      const match = message.match(pattern);
      const host = displayHost(match?.[1]);
      if (host) return host;
    }
  }
  return undefined;
}

function transportFailureCode(nodes) {
  for (const link of nodes) {
    if (typeof link.code === "string" && link.code) return link.code;
  }
  return undefined;
}

// Every branch names the host, because "connection timed out" without it does
// not tell an operator whether their own gateway or the public internet is the
// broken hop. `reachable: false` marks the failures a proxy can plausibly fix,
// which is the only condition under which advising one is not noise.
const DIAGNOSES = new Map([
  ["UND_ERR_CONNECT_TIMEOUT", { reachable: false, describe: (host) => `timed out connecting to ${host}` }],
  ["ETIMEDOUT", { reachable: false, describe: (host) => `timed out connecting to ${host}` }],
  ["ENOTFOUND", { reachable: false, describe: (host) => `could not resolve ${host}` }],
  ["EAI_AGAIN", { reachable: false, describe: (host) => `could not resolve ${host} (DNS lookup failed)` }],
  ["ECONNREFUSED", { reachable: false, describe: (host) => `${host} refused the connection` }],
  ["EHOSTUNREACH", { reachable: false, describe: (host) => `no route to ${host}` }],
  ["ENETUNREACH", { reachable: false, describe: (host) => `no route to ${host}` }],
  ["ECONNRESET", { reachable: true, describe: (host) => `${host} reset the connection` }],
  ["UND_ERR_SOCKET", { reachable: true, describe: (host) => `the connection to ${host} closed early` }],
  ["UND_ERR_HEADERS_TIMEOUT", { reachable: true, describe: (host) => `${host} sent no response headers in time` }],
  ["UND_ERR_BODY_TIMEOUT", { reachable: true, describe: (host) => `${host} stopped sending the response body` }],
  // A certificate that does not match the host is not a broken origin: some
  // box in the path answered for it. Say so, because the remedies for an
  // intercepted connection share nothing with the remedies for a down origin.
  ["ERR_TLS_CERT_ALTNAME_INVALID", {
    reachable: false,
    describe: (host) =>
      `the TLS certificate served for ${host} belongs to a different host, so something on this network is intercepting the connection`,
  }],
  ["SELF_SIGNED_CERT_IN_CHAIN", {
    reachable: false,
    describe: (host) => `the TLS chain for ${host} is self-signed, so something on this network is intercepting the connection`,
  }],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", {
    reachable: false,
    describe: (host) => `the TLS certificate for ${host} could not be verified`,
  }],
  ["CERT_HAS_EXPIRED", { reachable: true, describe: (host) => `the TLS certificate for ${host} has expired` }],
]);

const PROXY_HINT =
  " If this network needs an outbound proxy, set NODE_USE_ENV_PROXY=1 with http_proxy/https_proxy/no_proxy and rerun install.";

const LOCAL_HINT = " Check the local endpoint's service and configuration; for Router services, run .\\install.ps1 -Target codex.";
const LOCAL_PROXY_HINT = " Check the local service or configured proxy at that endpoint.";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function localTransportHost(host) {
  if (typeof host !== "string" || !host) return false;
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOCAL_HOSTS.has(bare) || (isIP(bare) === 4 && bare.startsWith("127."));
}

// Returns a `cause` fragment rather than a finished sentence, because the two
// callers have already committed to different openings: one failed before a
// head existed ("could not complete the request"), the other after it
// ("lost the upstream response stream"). Only the second half -- which host,
// what went wrong -- is common to both, and a diagnosis that overwrote the
// opening would have claimed a stream that died halfway was never reached.
//
// Undefined for anything that is not a recognized transport failure, so a
// router bug keeps its honest generic wording instead of borrowing a network
// cause there is no evidence for.
function hintFor(host, diagnosis, proxyConfigured) {
  if (localTransportHost(host)) return proxyConfigured ? LOCAL_PROXY_HINT : LOCAL_HINT;
  if (diagnosis.reachable || proxyConfigured) return "";
  return PROXY_HINT;
}

export function describeTransportFailure(
  error,
  { proxyConfigured = environmentProxyOptedIn() } = {},
) {
  const { nodes } = transportErrorGraph(error);
  const code = transportFailureCode(nodes);
  const diagnosis = code ? DIAGNOSES.get(code) : undefined;
  if (!diagnosis) return undefined;
  const host = transportFailureHost(nodes) || "the upstream";
  return {
    code,
    cause: diagnosis.describe(host),
    hint: hintFor(host, diagnosis, proxyConfigured),
  };
}
