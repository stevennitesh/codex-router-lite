import http from "node:http";

import {
  applyKeepAliveTimeouts,
  HOP_BY_HOP_HEADERS,
  installGracefulShutdown,
  pipeResponse,
  readRequestBody,
  reportListenFailure,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS } from "./paths.mjs";
import { CHECKED_IN_MODELS, MODEL_BY_GATEWAY_ID, MODEL_BY_SLUG, PROVIDERS, resolveProviderBaseUrl } from "./routed-models.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { fetchWithRetry } from "./upstream-retry.mjs";
import { zaiCacheUsageTransform } from "./zai-cache-usage.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";

installStableFetchTransport();

const HOST = process.env.CODEX_ROUTER_API_HOST || "127.0.0.1";
const PORT = Number(process.env.CODEX_ROUTER_API_PORT || PORTS.api);
const INTERNAL_KEY = process.env.CODEX_ROUTER_INTERNAL_KEY || process.env.MODEL_ROUTER_INTERNAL_KEY;
if (!INTERNAL_KEY) throw new Error("CODEX_ROUTER_INTERNAL_KEY is required.");

const provider = PROVIDERS.get("openrouter");
const routes = CHECKED_IN_MODELS.filter((model) => model.provider === "openrouter");
const defaultRoute = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");

function targetFor(requestUrl) {
  const pathname = new URL(requestUrl, "http://loopback").pathname.replace(/^\/v1/u, "");
  if (!["/chat/completions", "/responses", "/models"].includes(pathname)) {
    throw new Error(`Unsupported OpenRouter path: ${pathname}`);
  }
  return `${resolveProviderBaseUrl(provider).baseUrl}${pathname}`;
}

function hasNativeSearch(payload) {
  return payload?.web_search_options !== undefined ||
    (Array.isArray(payload?.tools) && payload.tools.some((tool) =>
      ["web_search", "web_search_preview"].includes(tool?.type))) ||
    ["web_search", "web_search_preview"].includes(payload?.tool_choice?.type);
}

function validHostedSearchTool(tool, route) {
  const parameters = tool?.parameters;
  const limits = route.searchTool.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return false;
  if (parameters.engine !== limits.engine || parameters.mode !== limits.mode) return false;
  if (!Number.isInteger(parameters.max_results) || parameters.max_results < 1 || parameters.max_results > limits.max_results) return false;
  if (
    !Number.isInteger(parameters.max_total_results) ||
    parameters.max_total_results < parameters.max_results ||
    parameters.max_total_results > limits.max_total_results
  ) return false;
  if (!Number.isInteger(parameters.max_uses) || parameters.max_uses < 1 || parameters.max_uses > limits.max_uses) return false;
  if (
    parameters.search_context_size !== undefined &&
    !["low", "medium", "high"].includes(parameters.search_context_size)
  ) return false;
  if (
    parameters.user_location !== undefined &&
    (!parameters.user_location ||
      typeof parameters.user_location !== "object" ||
      Array.isArray(parameters.user_location))
  ) return false;
  return Object.keys(parameters).every((key) => [
    "engine",
    "mode",
    "max_results",
    "max_total_results",
    "max_uses",
    "search_context_size",
    "user_location",
  ].includes(key));
}

function sanitizePayload(payload) {
  const selected = MODEL_BY_GATEWAY_ID.get(payload?.model) ||
    MODEL_BY_SLUG.get(payload?.model) ||
    (payload?.model === defaultRoute.upstreamModel ? defaultRoute : undefined);
  if (!routes.includes(selected)) {
    throw new Error(`Only ${routes.map((route) => route.slug).join(" and ")} are supported.`);
  }
  if (hasNativeSearch(payload)) {
    const error = new Error("Codex hosted-search fields must be translated before the OpenRouter hop.");
    error.code = "model_search_not_supported";
    throw error;
  }
  const serverSearchTools = Array.isArray(payload?.tools)
    ? payload.tools.filter((tool) => tool?.type === "openrouter:web_search")
    : [];
  if (
    serverSearchTools.length > 1 ||
    serverSearchTools.some((tool) => !validHostedSearchTool(tool, selected)) ||
    (serverSearchTools.length > 0 &&
      (!Number.isInteger(payload.max_tool_calls) ||
        payload.max_tool_calls < 0 ||
        payload.max_tool_calls > selected.searchTool.maxToolCalls)) ||
    (Array.isArray(payload?.tools) && payload.tools.some((tool) =>
      typeof tool?.type === "string" &&
      tool.type.startsWith("openrouter:") &&
      tool.type !== "openrouter:web_search"))
  ) {
    const error = new Error("OpenRouter hosted search must use the checked-in bounded route contract.");
    error.code = "model_search_not_supported";
    throw error;
  }
  const {
    client_metadata: _clientMetadata,
    prompt_cache_retention: _promptCacheRetention,
    ...clean
  } = payload;
  // Endpoint quirks belong to the selected and certified endpoint record. A
  // provider change must update this flag and refresh exact-route proof rather
  // than inheriting Novita's measured behavior by accident.
  if (selected.openRouterEndpointCompatibility.dropParallelToolCalls) {
    delete clean.parallel_tool_calls;
  }
  // Codex sends an empty tool list on compaction and plain turns. Omitting it
  // has the same meaning and avoids strict OpenAI-compatible validators that
  // reject `tools: []`. Drop tool_choice only when that empty list was present;
  // a request that never sent tools keeps its original choice contract.
  if (Array.isArray(clean.tools) && clean.tools.length === 0) {
    delete clean.tools;
    delete clean.tool_choice;
  }
  return {
    ...clean,
    model: selected.upstreamModel,
    provider: selected.openRouterProviderPolicy,
  };
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
    payload = sanitizePayload(JSON.parse((await readRequestBody(request)).toString("utf8")));
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
  request.once("aborted", () => abort.abort(new Error("Caller disconnected.")));
  let upstream;
  try {
    ({ response: upstream } = await fetchWithRetry(targetFor(request.url), {
      method: "POST",
      headers: upstreamHeaders(credential),
      body: JSON.stringify(payload),
      signal: abort.signal,
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
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (!response.headersSent) {
      writeJson(response, 502, {
        error: { type: "provider_error", message: error instanceof Error ? error.message : String(error) },
      });
    } else {
      response.end();
    }
  });
});
applyKeepAliveTimeouts(server);
reportListenFailure(server, { label: "api-forwarder", host: HOST, port: PORT });
server.listen(PORT, HOST, () => {
  if (process.env.CODEX_ROUTER_QUIET !== "1") console.error(`[api-forwarder] listening on ${HOST}:${PORT}`);
});
installGracefulShutdown(server, { label: "api-forwarder" });
