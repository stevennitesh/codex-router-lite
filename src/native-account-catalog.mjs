import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import { secretEqual } from "./caller-auth.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { codexVersion } from "./codex-binary.mjs";
import { nativeAccountCatalogHeaders } from "./codex-native-session.mjs";
import { writePrivateJsonAsync } from "./file-security.mjs";
import { NATIVE_ACCOUNT_CATALOG_PATH } from "./paths.mjs";
import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";
import { MODEL_BY_SLUG } from "./routed-models.mjs";

export const NATIVE_ACCOUNT_CATALOG_TTL_MS = 5 * 60_000;
const MAX_ACCOUNT_CATALOG_BYTES = 32 * 1024 * 1024;
const ACCOUNT_CATALOG_TIMEOUT_MS = 5_000;
// Credential-bearing requests are intentionally unable to choose a destination.
const ACCOUNT_CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";

function validCatalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length === 0) return false;
  for (const model of value.models) {
    const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
    if (!slug) return false;
  }
  return true;
}

function containsRoutedSlugs(catalog) {
  return Boolean(catalog?.models?.some((model) =>
    MODEL_BY_SLUG.has(String(model?.slug || ""))));
}

function modelsFingerprint(models) {
  return createHash("sha256").update(JSON.stringify(models)).digest("hex");
}

function safeEtag(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\0\r\n]/u.test(value)
    ? value
    : undefined;
}

function sameAccountSession(before, after) {
  if (!after?.authorization) return false;
  const beforeAccount = before?.["chatgpt-account-id"];
  const afterAccount = after?.["chatgpt-account-id"];
  const sameAccount = beforeAccount || afterAccount
    ? Boolean(beforeAccount && afterAccount && secretEqual(beforeAccount, afterAccount))
    : secretEqual(before.authorization, after.authorization);
  return sameAccount
    && String(before?.["x-openai-residency"] || "") === String(after?.["x-openai-residency"] || "")
    && String(before?.["x-openai-fedramp"] || "") === String(after?.["x-openai-fedramp"] || "");
}

export function nativeAccountCatalogIdentity(headers) {
  if (!headers?.authorization) return undefined;
  const account = headers["chatgpt-account-id"];
  const authorization = account ? undefined : headers.authorization;
  return createHash("sha256").update(JSON.stringify({
    account: account || null,
    authorization: authorization || null,
    residency: headers["x-openai-residency"] || null,
    fedramp: headers["x-openai-fedramp"] || null,
  })).digest("hex");
}

export function readNativeAccountCatalog(cachePath = NATIVE_ACCOUNT_CATALOG_PATH) {
  const missing = { catalog: undefined, fingerprint: undefined };
  if (!existsSync(cachePath)) return missing;
  try {
    const catalog = JSON.parse(readFileSync(cachePath, "utf8"));
    if (
      catalog?.version !== 1
      || typeof catalog.identity !== "string"
      || !validCatalog(catalog)
      || containsRoutedSlugs(catalog)
    ) return missing;
    return { catalog, fingerprint: modelsFingerprint(catalog.models) };
  } catch {
    return missing;
  }
}

export function codexClientVersion(value = codexVersion()) {
  return /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(
    String(value || ""),
  )?.[1];
}

function cacheIsFresh(cache, clientVersion, identity, now) {
  if (!validCatalog(cache) || containsRoutedSlugs(cache)) return false;
  if (cache.identity !== identity) return false;
  if (cache.client_version !== clientVersion) return false;
  const fetchedAt = Date.parse(cache.fetched_at);
  const age = now - fetchedAt;
  return Number.isFinite(fetchedAt) && age >= 0 && age < NATIVE_ACCOUNT_CATALOG_TTL_MS;
}

async function boundedJson(response, maxBytes = MAX_ACCOUNT_CATALOG_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function accountCatalogDispatcher({
  environment = process.env,
  execArgv = process.execArgv,
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
} = {}) {
  const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
    ? EnvHttpProxyAgentClass
    : AgentClass;
  return new DispatcherClass({
    allowH2: false,
    pipelining: 1,
    headersTimeout: ACCOUNT_CATALOG_TIMEOUT_MS,
    bodyTimeout: ACCOUNT_CATALOG_TIMEOUT_MS,
  });
}

// Caller must hold the catalog publication lock. Failures retain the previous
// snapshot and return status only; credentials never enter errors or results.
export async function refreshNativeAccountCatalogUnlocked({
  cachePath = NATIVE_ACCOUNT_CATALOG_PATH,
  force = false,
  now = Date.now(),
  version,
  versionProvider = codexClientVersion,
  fetchImpl = undiciFetch,
  headersProvider = nativeAccountCatalogHeaders,
  dispatcherFactory = accountCatalogDispatcher,
  writeCache = writePrivateJsonAsync,
  timeoutMs = ACCOUNT_CATALOG_TIMEOUT_MS,
} = {}) {
  const clientVersion = version || versionProvider();
  if (!clientVersion) return { status: "unavailable" };

  const current = readNativeAccountCatalog(cachePath);
  const invalidSnapshot = existsSync(cachePath) && !current.catalog;
  const accountHeaders = await headersProvider();
  if (!accountHeaders?.authorization) {
    return {
      status: "unavailable",
      ...(invalidSnapshot ? { native_source_invalid: true } : {}),
    };
  }
  const identity = nativeAccountCatalogIdentity(accountHeaders);
  const identityMatches = current.catalog?.identity === identity;
  const identityChanged = Boolean(current.catalog && !identityMatches);
  const failed = (identityChange = identityChanged) => ({
    status: "failed",
    ...(identityChange ? { identity_changed: true } : {}),
    ...(invalidSnapshot ? { native_source_invalid: true } : {}),
  });
  if (!force && cacheIsFresh(current.catalog, clientVersion, identity, now)) {
    return { status: "fresh", fingerprint: current.fingerprint };
  }

  const safeCurrent = identityMatches
    && validCatalog(current.catalog)
    && !containsRoutedSlugs(current.catalog);
  const triple = (value) => /^(\d+)\.(\d+)\.(\d+)/u.exec(String(value || ""))?.slice(1).map(Number);
  const candidate = triple(clientVersion);
  const previous = triple(current.catalog?.client_version);
  const differing = candidate && previous && candidate.findIndex((part, index) => part !== previous[index]);
  if (safeCurrent && differing >= 0 && candidate[differing] < previous[differing]) {
    return { status: "stale-client", fingerprint: current.fingerprint };
  }
  // Validators belong to the client version and account identity that obtained
  // the model list. A changed account or residency fetches unconditionally.
  const etag = safeCurrent && current.catalog.client_version === clientVersion
    ? safeEtag(current.catalog.etag) : undefined;
  const url = new URL(ACCOUNT_CATALOG_URL);
  url.searchParams.set("client_version", clientVersion);
  const headers = {
    ...accountHeaders,
    accept: "application/json",
    // Match the established Codex Router client identity accepted by this
    // Codex-owned endpoint; product branding must not invent a new protocol.
    originator: "codex_router",
    "user-agent": `codex-router/${clientVersion}`,
    ...(etag ? { "if-none-match": etag } : {}),
  };

  let dispatcher;
  try {
    dispatcher = fetchImpl === undiciFetch ? dispatcherFactory() : undefined;
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (response.status === 304) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      if (!etag) return failed();
      if (!sameAccountSession(accountHeaders, await headersProvider())) {
        return failed(true);
      }
      return { status: "not-modified", fingerprint: current.fingerprint };
    }
    if (!response.ok || response.status >= 300) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      return failed();
    }
    const parsed = await boundedJson(response);
    if (!validCatalog(parsed) || containsRoutedSlugs(parsed)) {
      return failed();
    }
    if (!sameAccountSession(accountHeaders, await headersProvider())) {
      return failed(true);
    }

    const fingerprint = modelsFingerprint(parsed.models);
    const responseEtag = safeEtag(response.headers.get("etag"));
    if (
      safeCurrent && fingerprint === current.fingerprint
      && current.catalog.client_version === clientVersion
      && (!responseEtag || responseEtag === etag)
    ) {
      return { status: "unchanged", fingerprint };
    }
    await writeCache(cachePath, {
      version: 1,
      identity,
      fetched_at: new Date(now).toISOString(),
      ...(responseEtag ? { etag: responseEtag } : {}),
      client_version: clientVersion,
      models: parsed.models,
    });
    return {
      status: safeCurrent && fingerprint === current.fingerprint ? "revalidated" : "updated",
      fingerprint,
    };
  } catch {
    return failed();
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

export function refreshNativeAccountCatalog({
  lock = withCatalogPublicationLock,
  lockOptions,
  ...options
} = {}) {
  return lock(() => refreshNativeAccountCatalogUnlocked(options), lockOptions);
}
