import http from "node:http";

import {
  applyKeepAliveTimeouts,
  endStreamedResponse,
  HOP_BY_HOP_HEADERS,
  installGracefulShutdown,
  pipeResponse,
  readRequestBody,
  reportListenFailure,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS } from "./paths.mjs";
import { OPENROUTER_MODELS as routes, CANONICAL_OPENROUTER_ROUTE as defaultRoute, PROVIDERS, resolveProviderBaseUrl } from "./routed-models.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { fetchWithRetry } from "./upstream-retry.mjs";
import { zaiCacheUsageTransform } from "./zai-cache-usage.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";
import { prepareOpenRouterRequest } from "./openrouter-request.mjs";

installStableFetchTransport();

const HOST = process.env.CODEX_ROUTER_API_HOST || "127.0.0.1";
const PORT = Number(process.env.CODEX_ROUTER_API_PORT || PORTS.api);
const INTERNAL_KEY = process.env.CODEX_ROUTER_INTERNAL_KEY || process.env.MODEL_ROUTER_INTERNAL_KEY;
if (!INTERNAL_KEY) throw new Error("CODEX_ROUTER_INTERNAL_KEY is required.");

const provider = PROVIDERS.get("openrouter");

function targetFor(requestUrl) {
  const pathname = new URL(requestUrl, "http://loopback").pathname.replace(/^\/v1/u, "");
  if (!["/chat/completions", "/responses", "/models"].includes(pathname)) {
    throw new Error(`Unsupported OpenRouter path: ${pathname}`);
  }
  return `${resolveProviderBaseUrl(provider).baseUrl}${pathname}`;
}

function upstreamHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.value}`,
    "Content-Type": "application/json",
    Accept: "*/*",
    "Accept-Encoding": "identity",
  };
}

async function handle(request, response) {
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;
  const requestUrl = new URL(request.url || "/", "http://loopback");
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const credential = resolveProviderCredential(provider, { persistent: true });
    writeJson(response, credential?.value ? 200 : 503, {
      ok: Boolean(credential?.value),
      provider: "openrouter",
      model: defaultRoute.slug,
      endpoint_provider: defaultRoute.openRouterProviderPolicy.only[0],
      credential_present: Boolean(credential?.value),
      fallback: defaultRoute.openRouterProviderPolicy.allow_fallbacks,
      routes: routes.map((candidate) => ({
        model: candidate.slug,
        endpoint_provider: candidate.openRouterProviderPolicy.only[0],
        fallback: candidate.openRouterProviderPolicy.allow_fallbacks,
      })),
    });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: { type: "invalid_request_error", message: "POST required." } });
    return;
  }
  const credential = resolveProviderCredential(provider);
  if (!credential?.value) {
    writeJson(response, 401, { error: { type: "authentication_error", message: "OpenRouter API key is not configured." } });
    return;
  }
  let payload;
  try {
    payload = prepareOpenRouterRequest(JSON.parse((await readRequestBody(request)).toString("utf8")));
  } catch (error) {
    writeJson(response, 400, {
      error: {
        type: "invalid_request_error",
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  const abort = new AbortController();
  const onAborted = () => abort.abort(new Error("Caller disconnected."));
  const onClosed = () => {
    if (!response.writableFinished) onAborted();
  };
  request.once("aborted", onAborted);
  response.once("close", onClosed);
  try {
    // The POST body may already be complete when its caller disconnects. The
    // request's aborted event then never fires; response close owns cancellation
    // during both the wait for provider headers and the response body.
    if (request.aborted || response.destroyed) return;
    let upstream;
    try {
      ({ response: upstream } = await fetchWithRetry(targetFor(request.url), {
        method: "POST",
        headers: upstreamHeaders(credential),
        body: JSON.stringify(payload),
        signal: abort.signal,
        // OpenRouter's endpoint is fixed by the provider registry. Following
        // a 307/308 would replay a billable prompt outside that contract.
        redirect: "error",
      }, {
        retries: 1,
        signal: abort.signal,
      }));
    } catch (error) {
      if (abort.signal.aborted) return;
      writeJson(response, 502, {
        error: {
          type: "provider_transport_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    const contentType = upstream.headers.get("content-type") || "";
    const transform = zaiCacheUsageTransform("openrouter", contentType);
    await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS, transform);
  } finally {
    request.off("aborted", onAborted);
    response.off("close", onClosed);
  }
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (!response.headersSent) {
      writeJson(response, 502, {
        error: { type: "provider_error", message: error instanceof Error ? error.message : String(error) },
      });
    } else {
      endStreamedResponse(response, { message: "The OpenRouter provider response stream disconnected before completion." });
    }
  });
});
applyKeepAliveTimeouts(server);
reportListenFailure(server, { label: "api-forwarder", host: HOST, port: PORT });
server.listen(PORT, HOST, () => {
  if (process.env.CODEX_ROUTER_QUIET !== "1") console.error(`[api-forwarder] listening on ${HOST}:${PORT}`);
});
installGracefulShutdown(server, { label: "api-forwarder" });
