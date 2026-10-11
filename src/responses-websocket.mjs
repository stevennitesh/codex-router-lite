import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import { authenticatedRoute, secretEqual } from "./caller-auth.mjs";
import {
  MAX_BODY_BYTES,
  MAX_BUFFERED_RESPONSE_BYTES,
  readResponseBody,
} from "./http-utils.mjs";
import { HeaderlessSseDetector } from "./sse-prefix.mjs";
import { SseLineScanner } from "./sse-framing.mjs";
import { isInterruptedResponse, NativeResponsesWebSocket } from "./native-responses-websocket.mjs";

const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";

const RESPONSE_ROUTES = new Set(["/responses", "/v1/responses"]);
const FORWARDED_REQUEST_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "x-session-id",
  "thread-id",
  "x-codex-routing-hint",
  "traceparent",
  "tracestate",
  "user-agent",
  "version",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-fedramp",
  "x-openai-internal-codex-residency",
  "x-openai-internal-codex-responses-lite",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);
const SAFE_RESPONSE_HEADERS = new Set([
  "openai-model",
  "retry-after",
  "x-codex-safety-buffering-enabled",
  "x-codex-safety-buffering-faster-model",
  "x-codex-turn-state",
  "x-models-etag",
  "x-reasoning-included",
]);
const WS_ONLY_CLIENT_METADATA_KEYS = new Set([
  "ws_request_header_traceparent",
  "ws_request_header_tracestate",
  "ws_request_header_x_openai_internal_codex_responses_lite",
  "x-codex-ws-stream-request-start-ms",
]);
const PER_REQUEST_IDENTITY_HEADERS = new Set([
  "session_id",
  "session-id",
  "thread-id",
  "traceparent",
  "tracestate",
  "x-client-request-id",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-openai-internal-codex-responses-lite",
  "x-openai-subagent",
]);
const MAX_QUEUED_REQUESTS = 2;
const MAX_FRAGMENT_FRAMES = 1_024;
const MAX_TURN_METADATA_HEADER_BYTES = 8 * 1_024;
const MAX_RATE_LIMIT_FAMILIES = 16;
const MAX_RATE_LIMIT_FAMILY_CANDIDATES = 64;
const MAX_RATE_LIMIT_ID_BYTES = 64;
const MAX_RATE_LIMIT_NUMBER_BYTES = 64;
const MAX_RATE_LIMIT_TEXT_BYTES = 256;
const MAX_ERROR_PLAN_TYPE_BYTES = 128;
// openai/codex@63d2138 deserializes `resets_at` as an i64, then accepts it
// only when chrono 0.4.43 can construct a DateTime<Utc> from the seconds.
const MIN_CODEX_RESET_AT = -8_334_601_228_800;
const MAX_CODEX_RESET_AT = 8_210_266_876_799;
const RATE_LIMIT_FAMILY_ANCHOR = /^x-([a-z0-9]+(?:-[a-z0-9]+)*)-primary-used-percent$/;
const RATE_LIMIT_FAMILY_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i;
const RATE_LIMIT_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

function headerTokens(value) {
  return String(value || "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function requestHasBeta(request) {
  return String(request.headers["openai-beta"] || "")
    .split(",")
    .map((value) => value.trim())
    .includes(RESPONSES_WEBSOCKET_BETA);
}

function validWebSocketKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 16 && decoded.toString("base64") === value;
}

function rejectUpgrade(socket, status, message, extraHeaders = {}) {
  if (socket.destroyed) return;
  const body = Buffer.from(
    JSON.stringify({ error: { type: "websocket_upgrade_rejected", message } }),
    "utf8",
  );
  const reason = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    426: "Upgrade Required",
  }[status] || "Error";
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${body.length}`,
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n"), "ascii"), body]));
}

function acceptUpgrade(request, socket) {
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data], header.length + data.length);
}

function closePayload(code, reason) {
  const text = Buffer.from(String(reason || ""), "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

function validCloseCode(code) {
  return (
    [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]
      .includes(code) ||
    (code >= 3000 && code <= 4999)
  );
}

function isCallerAuthorization(value, callerKey) {
  if (typeof value !== "string") return false;
  const [scheme, ...rest] = value.trim().split(/[ \t]+/);
  return (
    scheme?.toLowerCase() === "bearer" &&
    rest.length === 1 &&
    secretEqual(rest[0], callerKey)
  );
}

function safeHeaderValue(value) {
  return typeof value === "string" && !value.includes("\r") && !value.includes("\n")
    ? value
    : undefined;
}

function metadataObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function canonicalClientMetadata(value) {
  const metadata = metadataObject(value);
  if (!metadata) return value;
  const canonical = { ...metadata };
  for (const name of WS_ONLY_CLIENT_METADATA_KEYS) delete canonical[name];
  return Object.keys(canonical).length > 0 ? canonical : undefined;
}

function compatibilityTurnMetadataHeader(value) {
  const encoded = safeHeaderValue(value);
  if (encoded === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  const metadata = metadataObject(parsed);
  if (!metadata) return undefined;
  const compatibility = { ...metadata };
  // Official Codex deliberately keeps this unbounded inventory in canonical
  // client_metadata only. Projecting it into a header can exceed Node's
  // aggregate header limit before the loopback request reaches the router.
  delete compatibility.tool_namespaces_info;
  const headerValue = JSON.stringify(compatibility).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return Buffer.byteLength(headerValue, "utf8") <= MAX_TURN_METADATA_HEADER_BYTES
    ? headerValue
    : undefined;
}

function metadataHeaderProjections(value) {
  const metadata = metadataObject(value);
  if (!metadata) return new Map();
  const projected = new Map();
  for (const [metadataName, headerNames] of [
    ["session_id", ["session-id"]],
    ["thread_id", ["thread-id", "x-client-request-id"]],
    ["traceparent", ["traceparent"]],
    ["tracestate", ["tracestate"]],
    ["x-codex-installation-id", ["x-codex-installation-id"]],
    ["x-codex-parent-thread-id", ["x-codex-parent-thread-id"]],
    ["x-codex-turn-metadata", ["x-codex-turn-metadata"]],
    ["x-codex-turn-state", ["x-codex-turn-state"]],
    ["x-codex-window-id", ["x-codex-window-id"]],
    ["x-openai-subagent", ["x-openai-subagent"]],
    ["ws_request_header_traceparent", ["traceparent"]],
    ["ws_request_header_tracestate", ["tracestate"]],
    [
      "ws_request_header_x_openai_internal_codex_responses_lite",
      ["x-openai-internal-codex-responses-lite"],
    ],
  ]) {
    const headerValue = metadataName === "x-codex-turn-metadata"
      ? compatibilityTurnMetadataHeader(metadata[metadataName])
      : safeHeaderValue(metadata[metadataName]);
    if (headerValue !== undefined) {
      for (const headerName of headerNames) projected.set(headerName, headerValue);
    }
  }
  return projected;
}

function metadataTurnId(value) {
  const metadata = metadataObject(value);
  const encoded = metadata?.["x-codex-turn-metadata"];
  if (typeof encoded !== "string") return undefined;
  try {
    const parsed = JSON.parse(encoded);
    return typeof parsed?.turn_id === "string" && parsed.turn_id ? parsed.turn_id : undefined;
  } catch {
    return undefined;
  }
}

function loopbackHeaders(
  request,
  callerKey,
  clientMetadata,
  turnState,
  internalAuthorization,
) {
  const headers = {
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    let value = request.headers[name];
    if (value === undefined) continue;
    if (name === "authorization" && isCallerAuthorization(value, callerKey)) continue;
    // This beta token describes the edge transport. The internal hop is plain
    // HTTP Responses and must not advertise a WebSocket protocol to either the
    // router's native forwarder or a provider. Preserve any unrelated beta
    // flags the caller supplied.
    if (name === "openai-beta") {
      value = String(value)
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token && token !== RESPONSES_WEBSOCKET_BETA)
        .join(", ");
      if (!value) continue;
    }
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The handshake can be a startup prewarm, while each frame carries the
  // authoritative paid-turn metadata. Never let compatibility headers frozen
  // at upgrade time win over the per-request projection (or survive when the
  // current frame deliberately omits them).
  for (const name of PER_REQUEST_IDENTITY_HEADERS) delete headers[name];
  for (const [name, value] of metadataHeaderProjections(clientMetadata)) {
    headers[name] = value;
  }
  const currentTurnId = metadataTurnId(clientMetadata);
  const storedTurnState =
    turnState && (!currentTurnId || !turnState.turnId || currentTurnId === turnState.turnId)
      ? turnState.value
      : undefined;
  if (!headers["x-codex-turn-state"] && storedTurnState) {
    headers["x-codex-turn-state"] = storedTurnState;
  }
  const internalAuth = safeHeaderValue(internalAuthorization);
  if (internalAuth) headers.authorization = internalAuth;
  return headers;
}

function responseHeaders(response, { includeRateLimits = false } = {}) {
  const headers = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  if (includeRateLimits) Object.assign(headers, rateLimitResponseHeaders(response.headers));
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function sendSuccessfulResponseHeaders(peer, response) {
  const headers = responseHeaders(response) || {};
  const turnState = headers["x-codex-turn-state"];
  if (turnState !== undefined) {
    // Current Codex accepts sticky state only from response.metadata.
    if (!(await peer.sendJsonWithBackpressure({
      type: "response.metadata",
      headers: { "x-codex-turn-state": turnState },
    }))) return false;
  }

  const codexMetadataHeaders = {};
  for (const name of [
    "openai-model",
    "x-codex-safety-buffering-enabled",
    "x-codex-safety-buffering-faster-model",
    "x-models-etag",
  ]) {
    if (headers[name] !== undefined) codexMetadataHeaders[name] = headers[name];
  }
  if (Object.keys(codexMetadataHeaders).length > 0) {
    if (!(await peer.sendJsonWithBackpressure({
      type: "codex.response.metadata",
      headers: codexMetadataHeaders,
    }))) return false;
  }

  for (const rateLimits of rateLimitEvents(response.headers)) {
    if (!(await peer.sendJsonWithBackpressure(rateLimits))) return false;
  }

  if (headers["x-reasoning-included"] !== undefined) {
    // Codex reads this flag only from the HTTP 101 response. The internal HTTP
    // response arrives after that handshake, so no truthful WebSocket event can
    // retrofit it. Intentionally omit it instead of claiming transport parity.
  }
  return true;
}

function boundedRateLimitHeader(headers, name, maxBytes = MAX_RATE_LIMIT_TEXT_BYTES) {
  const raw = headers.get(name);
  if (
    raw === null ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) return undefined;
  return raw;
}

function finiteHeaderNumber(headers, name, { integer = false } = {}) {
  const raw = boundedRateLimitHeader(headers, name, MAX_RATE_LIMIT_NUMBER_BYTES);
  if (raw === undefined) return undefined;
  const pattern = integer
    ? /^[+-]?\d+$/
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!pattern.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  if (integer && !Number.isSafeInteger(value)) return undefined;
  return value;
}

function booleanHeader(headers, name) {
  const value = boundedRateLimitHeader(headers, name, 5)?.toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function rateLimitWindow(headers, prefix) {
  const usedPercent = finiteHeaderNumber(headers, `${prefix}-used-percent`);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = finiteHeaderNumber(headers, `${prefix}-window-minutes`, {
    integer: true,
  });
  const resetAt = finiteHeaderNumber(headers, `${prefix}-reset-at`, { integer: true });
  if (usedPercent === 0 && (!windowMinutes || windowMinutes === 0) && resetAt === undefined) {
    return undefined;
  }
  return {
    used_percent: usedPercent,
    ...(windowMinutes !== undefined ? { window_minutes: windowMinutes } : {}),
    ...(resetAt !== undefined ? { reset_at: resetAt } : {}),
  };
}

function rateLimitSnapshot(headers, familyId) {
  const headerFamilyId = familyId.replaceAll("_", "-");
  const prefix = `x-${headerFamilyId}`;
  const primary = rateLimitWindow(headers, `${prefix}-primary`);
  const secondary = rateLimitWindow(headers, `${prefix}-secondary`);
  const hasCredits = booleanHeader(headers, "x-codex-credits-has-credits");
  const unlimited = booleanHeader(headers, "x-codex-credits-unlimited");
  const balance = boundedRateLimitHeader(headers, "x-codex-credits-balance")?.trim();
  const credits = hasCredits !== undefined && unlimited !== undefined
    ? {
      has_credits: hasCredits,
      unlimited,
      ...(balance ? { balance } : {}),
    }
    : undefined;
  const limitName = boundedRateLimitHeader(headers, `${prefix}-limit-name`)?.trim();
  return {
    familyId,
    primary,
    secondary,
    credits,
    ...(limitName ? { limitName } : {}),
  };
}

function rateLimitEvent(snapshot) {
  const { familyId, primary, secondary, credits, limitName } = snapshot;
  return {
    type: "codex.rate_limits",
    metered_limit_name: familyId,
    ...(limitName ? { limit_name: limitName } : {}),
    ...(primary || secondary
      ? { rate_limits: { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) } }
      : {}),
    ...(credits ? { credits } : {}),
  };
}

function rateLimitSnapshots(headers) {
  const familyIds = new Set();
  for (const [name] of headers) {
    const match = RATE_LIMIT_FAMILY_ANCHOR.exec(name);
    if (!match) continue;
    const rawFamilyId = match[1];
    if (Buffer.byteLength(rawFamilyId, "ascii") > MAX_RATE_LIMIT_ID_BYTES) continue;
    const familyId = rawFamilyId.replaceAll("-", "_");
    if (familyId === "codex") continue;
    familyIds.add(familyId);
    if (familyIds.size >= MAX_RATE_LIMIT_FAMILY_CANDIDATES) break;
  }

  const snapshots = [];
  const defaultSnapshot = rateLimitSnapshot(headers, "codex");
  if (defaultSnapshot.primary || defaultSnapshot.secondary || defaultSnapshot.credits) {
    snapshots.push(defaultSnapshot);
  }
  for (const familyId of [...familyIds].sort()) {
    const snapshot = rateLimitSnapshot(headers, familyId);
    if (snapshot.primary || snapshot.secondary || snapshot.credits) snapshots.push(snapshot);
    if (snapshots.length >= MAX_RATE_LIMIT_FAMILIES) break;
  }
  return snapshots;
}

function rateLimitEvents(headers) {
  return rateLimitSnapshots(headers).map(rateLimitEvent);
}

function rateLimitResponseHeaders(headers) {
  const projected = {};
  const projectedFamilyIds = new Set();
  for (const snapshot of rateLimitSnapshots(headers)) {
    const prefix = `x-${snapshot.familyId.replaceAll("_", "-")}`;
    const discoveryUsedPercent = finiteHeaderNumber(headers, `${prefix}-primary-used-percent`);
    if (snapshot.familyId !== "codex" && discoveryUsedPercent === undefined) continue;
    if (snapshot.familyId !== "codex" && !snapshot.primary) {
      // A valid all-zero primary window is still the header that lets Codex
      // rediscover this named family after unwrapping the WebSocket error.
      projected[`${prefix}-primary-used-percent`] = String(discoveryUsedPercent);
    }
    for (const [windowName, window] of [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ]) {
      if (!window) continue;
      projected[`${prefix}-${windowName}-used-percent`] = String(window.used_percent);
      if (window.window_minutes !== undefined) {
        projected[`${prefix}-${windowName}-window-minutes`] = String(window.window_minutes);
      }
      if (window.reset_at !== undefined) {
        projected[`${prefix}-${windowName}-reset-at`] = String(window.reset_at);
      }
    }
    if (snapshot.limitName) projected[`${prefix}-limit-name`] = snapshot.limitName;
    if (snapshot.credits) {
      projected["x-codex-credits-has-credits"] = String(snapshot.credits.has_credits);
      projected["x-codex-credits-unlimited"] = String(snapshot.credits.unlimited);
      if (snapshot.credits.balance !== undefined) {
        projected["x-codex-credits-balance"] = snapshot.credits.balance;
      }
    }
    projectedFamilyIds.add(snapshot.familyId);
  }
  const activeLimit = boundedRateLimitHeader(
    headers,
    "x-codex-active-limit",
    MAX_RATE_LIMIT_ID_BYTES,
  )?.trim();
  if (activeLimit && RATE_LIMIT_FAMILY_ID.test(activeLimit)) {
    const normalizedActiveLimit = activeLimit.toLowerCase().replaceAll("-", "_");
    if (projectedFamilyIds.has(normalizedActiveLimit)) {
      projected["x-codex-active-limit"] = normalizedActiveLimit;
    }
  }
  const reachedType = boundedRateLimitHeader(
    headers,
    "x-codex-rate-limit-reached-type",
    MAX_RATE_LIMIT_ID_BYTES,
  )?.trim();
  if (RATE_LIMIT_REACHED_TYPES.has(reachedType)) {
    projected["x-codex-rate-limit-reached-type"] = reachedType;
  }
  return projected;
}

function continuationState(input, output, maxBytes) {
  const encoded = Buffer.from(JSON.stringify({ input, output }), "utf8");
  return encoded.length <= maxBytes ? { input, output } : undefined;
}

function validCompletedResponse(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.status === "completed" &&
    Array.isArray(value.output)
  );
}

function continuationItemKey(item) {
  if (typeof item?.call_id === "string" && item.call_id) return `call:${item.call_id}`;
  if (typeof item?.id === "string" && item.id) return `id:${item.id}`;
  return undefined;
}

function reconciledContinuationOutput(completedOutput, outputItems) {
  if (!Array.isArray(completedOutput)) return outputItems;
  if (!Array.isArray(outputItems) || outputItems.length === 0) return completedOutput;

  const doneByKey = new Map();
  for (const item of outputItems) {
    const key = continuationItemKey(item);
    if (key) doneByKey.set(key, item);
  }

  const used = new Set();
  const reconciled = completedOutput.map((item) => {
    const key = continuationItemKey(item);
    const done = key ? doneByKey.get(key) : undefined;
    if (!done) return item;
    used.add(done);
    return done;
  });
  for (const item of outputItems) {
    if (!used.has(item)) reconciled.push(item);
  }
  return reconciled;
}
function errorShape(body, fallback) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const source = parsed?.error && typeof parsed.error === "object"
    ? parsed.error
    : parsed && typeof parsed === "object"
      ? parsed
      : {};
  const planType = typeof source.plan_type === "string" &&
      Buffer.byteLength(source.plan_type, "utf8") <= MAX_ERROR_PLAN_TYPE_BYTES
    ? source.plan_type
    : undefined;
  const resetsAt = Number.isSafeInteger(source.resets_at) &&
      source.resets_at >= MIN_CODEX_RESET_AT &&
      source.resets_at <= MAX_CODEX_RESET_AT
    ? source.resets_at
    : undefined;
  return {
    type: typeof source.type === "string" ? source.type : fallback.type,
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    message: typeof source.message === "string" ? source.message : fallback.message,
    ...(planType !== undefined ? { plan_type: planType } : {}),
    ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}),
  };
}

function responseWithBody(upstream, body) {
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function sniffUndeclaredResponse(upstream, signal) {
  if (!upstream.body) return { kind: "other", response: upstream };
  const [probe, relay] = upstream.body.tee();
  const reader = probe.getReader();
  const detector = new HeaderlessSseDetector();
  let decision = "pending";
  try {
    while (decision === "pending") {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) {
        decision = detector.end().decision;
        break;
      }
      decision = detector.write(result.value).decision;
    }
  } catch (error) {
    void relay.cancel().catch(() => {});
    throw error;
  } finally {
    void reader.cancel().catch(() => {});
  }
  return {
    kind: decision === "event-stream" ? "event-stream" : "other",
    response: responseWithBody(upstream, relay),
  };
}

async function relaySse(body, onEvent, { signal, maxEventBytes }) {
  if (!body) throw new Error("The internal Responses endpoint returned no stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const lines = new SseLineScanner();
  let lineParts = [];
  let lineBytes = 0;
  let dataLines = [];
  let dataChars = 0;
  const dispatch = async () => {
    if (dataLines.length === 0) return true;
    const data = dataLines.join("\n");
    dataLines = [];
    dataChars = 0;
    if (data === "[DONE]") return true;
    return onEvent(data);
  };
  const assertLineBound = () => {
    if (lineBytes <= maxEventBytes) return;
    const error = new Error(`Responses SSE line exceeds ${maxEventBytes} bytes.`);
    error.code = "ERR_RESPONSES_WS_EVENT_TOO_LARGE";
    throw error;
  };
  const appendLinePart = (part) => {
    if (!part) return;
    lineParts.push(part);
    lineBytes += Buffer.byteLength(part, "utf8");
    assertLineBound();
  };
  const consumeLine = async (line) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return true;
    if (!line.startsWith("data:")) return true;
    let value = line.slice(5);
    if (value.startsWith(" ")) value = value.slice(1);
    // Count the separator as well as the data. Without that byte, an event
    // made from an unbounded number of empty `data:` lines could grow the
    // line array without ever advancing the payload limit.
    dataChars += Buffer.byteLength(value, "utf8") + 1;
    if (dataChars > maxEventBytes) {
      const error = new Error(`Responses SSE event exceeds ${maxEventBytes} bytes.`);
      error.code = "ERR_RESPONSES_WS_EVENT_TOO_LARGE";
      throw error;
    }
    dataLines.push(value);
    return true;
  };
  try {
    while (true) {
      if (signal.aborted) throw signal.reason || new Error("WebSocket closed.");
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const piece of lines.scan(text)) {
        appendLinePart(piece.content);
        if (!piece.endLine) continue;
        const line = lineParts.join("");
        lineParts = [];
        lineBytes = 0;
        if ((await consumeLine(line)) === false) return;
      }
    }
    appendLinePart(decoder.decode());
    assertLineBound();
    // EOF does not terminate an SSE event. Discard any unfinished line/event;
    // the caller's existing missing-completion path reports the failed stream.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

class ResponsesWebSocketPeer {
  constructor(socket, request, options) {
    this.socket = socket;
    this.request = request;
    this.options = options;
    this.frameHeader = Buffer.allocUnsafe(14);
    this.frameHeaderBytes = 0;
    this.frameHeaderNeeded = 2;
    this.frame = undefined;
    this.fragmentOpcode = undefined;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentFrames = 0;
    this.closed = false;
    this.closeSent = false;
    this.pendingRequests = 0;
    this.queue = Promise.resolve();
    this.abortController = new AbortController();
    this.continuations = new Map();
    this.turnState = undefined;
  }

  start(head) {
    this.socket.on("error", () => this.abort());
    this.socket.on("close", () => this.abort());
    this.socket.on("end", () => this.abort());
    this.socket.on("data", (chunk) => this.feed(chunk));
    if (head?.length) this.feed(head);
    this.socket.resume?.();
  }

  abort({ graceful = false } = {}) {
    if (!this.closed) {
      this.closed = true;
      this.abortController.abort(new Error("Responses WebSocket closed."));
      this.nativeTransport?.close();
      this.continuations.clear();
      this.options.unregisterPeer?.();
    }
    // HTTP upgrades leave their sockets half-open. FIN/error must destroy the
    // writable half even after a graceful close began under backpressure.
    if (graceful) this.socket.destroySoon?.();
    else this.socket.destroy?.();
  }

  forceClose() {
    this.fail(1012, "The local router is restarting.");
  }

  send(opcode, payload) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(encodeFrame(opcode, payload));
  }

  sendJson(value) {
    return this.send(0x1, Buffer.from(JSON.stringify(value), "utf8"));
  }

  async sendJsonWithBackpressure(value, rawJson) {
    // Upstream events are already parsed for protocol and continuation checks.
    // Forward their validated JSON without serializing large unchanged output
    // again. Locally generated metadata/errors retain ordinary serialization.
    if (rawJson === undefined ? this.sendJson(value) : this.send(0x1, Buffer.from(rawJson, "utf8"))) return true;
    if (this.closed || this.socket.destroyed) return false;
    await new Promise((resolve) => {
      const finish = () => {
        this.socket.off("drain", finish);
        this.socket.off("close", finish);
        this.socket.off("error", finish);
        resolve();
      };
      this.socket.once("drain", finish);
      this.socket.once("close", finish);
      this.socket.once("error", finish);
    });
    return !this.closed && !this.socket.destroyed;
  }

  sendError(status, error, headers) {
    this.sendJson({
      type: "error",
      status,
      error,
      ...(headers ? { headers } : {}),
    });
  }

  fail(code, reason) {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.send(0x8, closePayload(code, reason));
    }
    this.socket.end();
    this.abort({ graceful: true });
  }

  feed(chunk) {
    if (this.closed || !chunk?.length) return;
    let offset = 0;
    while (!this.closed && offset < chunk.length) {
      if (!this.frame) {
        const copied = Math.min(this.frameHeaderNeeded - this.frameHeaderBytes, chunk.length - offset);
        chunk.copy(this.frameHeader, this.frameHeaderBytes, offset, offset + copied);
        this.frameHeaderBytes += copied;
        offset += copied;
        if (this.frameHeaderBytes < this.frameHeaderNeeded) return;
        if (this.frameHeaderNeeded === 2) {
          if (this.frameHeader[0] & 0x70) return this.fail(1002, "WebSocket extensions were not negotiated.");
          if (!(this.frameHeader[1] & 0x80)) return this.fail(1002, "Client frames must be masked.");
          const lengthCode = this.frameHeader[1] & 0x7f;
          this.frameHeaderNeeded = (lengthCode === 127 ? 10 : lengthCode === 126 ? 4 : 2) + 4;
          continue;
        }
        const first = this.frameHeader[0];
        const second = this.frameHeader[1];
        const fin = Boolean(first & 0x80);
        const opcode = first & 0x0f;
        let length = second & 0x7f;
        let maskOffset = 2;
        if (length === 126) {
          length = this.frameHeader.readUInt16BE(2);
          maskOffset = 4;
        } else if (length === 127) {
          const longLength = this.frameHeader.readBigUInt64BE(2);
          if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            return this.fail(1009, "WebSocket frame is too large.");
          }
          length = Number(longLength);
          maskOffset = 10;
        }
        const control = opcode >= 0x8;
        if (control && (!fin || length > 125)) {
          return this.fail(1002, "Invalid WebSocket control frame.");
        }
        if (length > this.options.maxMessageBytes) {
          return this.fail(1009, "WebSocket message is too large.");
        }
        this.frame = { fin, opcode, length, payload: Buffer.alloc(0), bytes: 0, maskOffset };
      }
      const frame = this.frame;
      const count = Math.min(frame.length - frame.bytes, chunk.length - offset);
      const required = frame.bytes + count;
      if (required > frame.payload.length) {
        // Grow with received bytes, not an untrusted declared length. Doubling
        // keeps capture linear without reserving a large frame for a tiny header.
        const capacity = Math.min(frame.length, Math.max(required, frame.payload.length * 2, 16 * 1_024));
        const payload = Buffer.allocUnsafe(capacity);
        frame.payload.copy(payload, 0, 0, frame.bytes);
        frame.payload = payload;
      }
      for (let index = 0; index < count; index += 1) {
        const position = frame.bytes + index;
        frame.payload[position] = chunk[offset + index] ^ this.frameHeader[frame.maskOffset + (position & 3)];
      }
      frame.bytes += count;
      offset += count;
      if (frame.bytes < frame.length) return;
      this.frame = undefined;
      this.frameHeaderBytes = 0;
      this.frameHeaderNeeded = 2;
      this.handleFrame(frame);
    }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      if (payload.length === 1) return this.fail(1002, "Invalid WebSocket close frame.");
      if (payload.length >= 2) {
        const code = payload.readUInt16BE(0);
        if (!validCloseCode(code)) return this.fail(1002, "Invalid WebSocket close code.");
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
        } catch {
          return this.fail(1007, "Invalid WebSocket close reason.");
        }
      }
      if (!this.closeSent) {
        this.closeSent = true;
        this.send(0x8, payload);
      }
      this.socket.end();
      this.abort({ graceful: true });
      return;
    }
    if (opcode === 0x9) {
      this.send(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (![0x0, 0x1, 0x2].includes(opcode)) {
      this.fail(1002, "Unsupported WebSocket opcode.");
      return;
    }
    if (opcode === 0x2 || (opcode === 0x0 && this.fragmentOpcode === 0x2)) {
      this.fail(1003, "Binary Responses WebSocket messages are not supported.");
      return;
    }
    if (opcode === 0x0) {
      if (this.fragmentOpcode === undefined) {
        this.fail(1002, "Unexpected WebSocket continuation frame.");
        return;
      }
    } else if (this.fragmentOpcode !== undefined) {
      this.fail(1002, "A fragmented WebSocket message is already in progress.");
      return;
    } else if (!fin) {
      this.fragmentOpcode = opcode;
    }
    this.fragmentBytes += payload.length;
    this.fragmentFrames += 1;
    if (this.fragmentFrames > this.options.maxFragmentFrames) {
      this.fail(1009, "WebSocket message has too many fragments.");
      return;
    }
    if (this.fragmentBytes > this.options.maxMessageBytes) {
      this.fail(1009, "WebSocket message is too large.");
      return;
    }
    this.fragments.push(payload);
    if (!fin) return;
    const complete = this.fragments.length === 1
      ? payload
      : Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentFrames = 0;
    this.fragmentOpcode = undefined;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(complete);
    } catch {
      this.fail(1007, "WebSocket text is not valid UTF-8.");
      return;
    }
    this.enqueue(text);
  }

  enqueue(text) {
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      this.sendError(400, {
        type: "invalid_request_error",
        message: "Responses WebSocket messages must contain valid JSON.",
      });
      return;
    }
    if (request?.type === "response.interrupt") {
      // Codex sends this control while response.create is still running. It
      // belongs to that response, not to the serialized generation queue or
      // new-request admission (which may already be draining).
      if (typeof request.response_id !== "string" || !request.response_id ||
          request.mode !== "discard_partial_items") {
        this.sendError(400, {
          type: "invalid_request_error", code: "invalid_response_interrupt",
          message: "response.interrupt requires a response_id and mode=discard_partial_items.",
        });
      } else if (!this.nativeTransport?.interrupt(request.response_id)) {
        this.sendError(400, {
          type: "invalid_request_error", code: "response_not_in_progress",
          message: "response.interrupt must identify this connection's native response.",
        });
      }
      return;
    }
    this.pendingRequests += 1;
    if (this.pendingRequests > MAX_QUEUED_REQUESTS) {
      this.fail(1008, "Too many queued Responses requests.");
      return;
    }
    this.queue = this.queue
      .then(() => this.process(request))
      .catch(() => {
        if (!this.closed) {
          this.sendError(500, {
            type: "local_router_error",
            message: "The local router could not complete the WebSocket request.",
          });
        }
      })
      .finally(() => {
        this.pendingRequests -= 1;
      });
  }

  async processNative(request, fullRequest, clientMetadata, previous) {
    if (!this.options.prepareNativeRequest) return false;
    const controller = new AbortController();
    const onClose = () => controller.abort(this.abortController.signal.reason);
    this.abortController.signal.addEventListener("abort", onClose, { once: true });
    const startedAt = Date.now();
    let prepared;
    let terminal;
    let outputObservation;
    let firstTokenMs;
    let status = 502;
    let outcome = "transport_error";
    try {
      const payload = { ...request };
      delete payload.type;
      const headers = loopbackHeaders(
        this.request, this.options.callerKey, clientMetadata, this.turnState,
        this.options.internalAuthorization,
      );
      // This hop is a real WebSocket. Its native beta and frame metadata must
      // survive, while HTTP re-entry below keeps its existing projections.
      headers["openai-beta"] = String(this.request.headers["openai-beta"]);
      prepared = await this.options.prepareNativeRequest({
        request: { headers, url: this.request.url, method: "POST" },
        payload, controller, signal: controller.signal,
      });
      if (!prepared) {
        this.nativeTransport?.close();
        return false;
      }
      this.nativeTransport ??= new NativeResponsesWebSocket({
        maxEventBytes: this.options.maxEventBytes,
        maxErrorBytes: this.options.maxErrorBytes,
        maxFragmentFrames: this.options.maxFragmentFrames,
      });
      if (request.previous_response_id && !this.nativeTransport.canContinue(prepared, request.previous_response_id)) {
        if (!previous) {
          status = 409;
          outcome = "failed";
          this.sendError(status, {
            type: "invalid_request_error", code: "previous_response_not_found",
            message: "Previous response was not found. Retrying the full request.",
          });
          return true;
        }
        prepared.payload = prepared.rebuildPayload(fullRequest.input);
        delete prepared.payload.previous_response_id;
      }
      // Input is already a normalized JSON array. Reuse its serialization for
      // the outgoing frame and exact continuation accounting, including UTF-8
      // and escapes, rather than serializing large tool results twice.
      const { input: normalizedInput, ...envelope } = prepared.payload;
      const inputJson = JSON.stringify(normalizedInput);
      const normalizedInputBytes = Buffer.byteLength(inputJson, "utf8");
      const envelopeJson = JSON.stringify({ ...envelope, type: "response.create" });
      prepared.encoded = `${envelopeJson.slice(0, -1)},"input":${inputJson}}`;
      const requestBytes = Buffer.byteLength(envelopeJson, "utf8") + normalizedInputBytes + 9;
      if (requestBytes > this.options.maxMessageBytes) {
        status = 413;
        outcome = "failed";
        this.sendError(status, { type: "request_too_large", message: "Native Responses request exceeds its byte bound." });
        return true;
      }
      const continuing = Boolean(prepared.payload.previous_response_id && previous);
      const knownBaseline = !prepared.payload.previous_response_id || Boolean(previous);
      const input = continuing
        ? [...previous.input, ...previous.output, ...normalizedInput]
        : normalizedInput;
      // Account for each incremental suffix once. Native turns need not
      // repeatedly serialize all previous input to bound their fallback state.
      const inputBytes = (continuing ? previous.inputBytes + previous.outputBytes : 0) +
        normalizedInputBytes;
      let outputItems = [];
      let outputItemsBytes = 0;
      let continuationOverflow = false;
      terminal = await this.nativeTransport.run(prepared, {
        signal: controller.signal,
        onHeaders: (upstreamHeaders) => {
          const value = safeHeaderValue(upstreamHeaders.get("x-codex-turn-state"));
          if (value) this.turnState = { value, turnId: metadataTurnId(clientMetadata) };
          return sendSuccessfulResponseHeaders(this, { headers: upstreamHeaders });
        },
        onEvent: async (event, rawJson) => {
          if (event.type === "response.completed" && !validCompletedResponse(event.response)) {
            const error = new Error("Native Responses emitted an invalid completed response.");
            error.code = "local_router_protocol_error";
            throw error;
          }
          if (event.type === "response.incomplete" && event.response?.incomplete_details?.reason === "interrupted" &&
              !isInterruptedResponse(event)) {
            const error = new Error("Native Responses emitted an invalid interrupted response.");
            error.code = "local_router_protocol_error";
            throw error;
          }
          if (event.type === "response.metadata") {
            const value = safeHeaderValue(event.headers?.["x-codex-turn-state"]);
            if (value) this.turnState = { value, turnId: metadataTurnId(clientMetadata) };
          }
          if (event.type === "response.output_item.done" && event.item && !continuationOverflow) {
            outputItemsBytes += Buffer.byteLength(JSON.stringify(event.item), "utf8");
            if (outputItemsBytes <= this.options.maxContinuationBytes) outputItems.push(event.item);
            else { continuationOverflow = true; outputItems = []; }
          }
          if (firstTokenMs === undefined && (
            event.type === "response.output_text.delta" ||
            event.type === "response.function_call_arguments.delta" ||
            event.type === "response.custom_tool_call_input.delta" ||
            event.type === "response.reasoning_summary_text.delta"
          )) firstTokenMs = Date.now() - startedAt;
          return this.sendJsonWithBackpressure(event, rawJson);
        },
      });
      const interrupted = isInterruptedResponse(terminal);
      const completed = terminal?.type === "response.completed";
      status = completed || interrupted ? 200 : Number(terminal?.status) || 502;
      outcome = completed ? "completed" : interrupted ? "interrupted" : "failed";
      this.continuations.clear();
      if (completed || interrupted) {
        // discard_partial_items makes the interrupted terminal's output the
        // retained history. Do not restore discarded items from the stream.
        outputItems = interrupted ? terminal.response.output
          : reconciledContinuationOutput(terminal.response.output, outputItems);
        outputObservation = { output: outputItems, complete: !continuationOverflow };
        const outputBytes = Buffer.byteLength(JSON.stringify(outputItems), "utf8");
        if (knownBaseline && !continuationOverflow && inputBytes + outputBytes + 32 <= this.options.maxContinuationBytes) {
          this.continuations.set(terminal.response.id, { input, output: outputItems, inputBytes, outputBytes });
        }
      }
      return true;
    } catch (error) {
      if (!prepared && error?.status) status = error.status;
      else if (error?.status) status = error.status;
      if (prepared && !error?.sent && [404, 405, 426].includes(error?.status)) {
        // A rejected handshake has sent no response.create and cannot have
        // generated a response. Preserve compatibility with HTTP-only backends.
        return false;
      }
      if (!this.closed && controller.signal.aborted) {
        status = Number(controller.signal.reason?.status) || 499;
        outcome = status === 504 ? "failed" : "canceled";
        this.sendError(status, {
          type: controller.signal.reason?.code || "local_router_stream_failed",
          message: status === 504
            ? "Router request exceeded its execution deadline."
            : "The native Responses request was canceled.",
        });
      } else if (!this.closed) {
        const body = error?.body ? Buffer.from(error.body, "utf8") : Buffer.alloc(0);
        this.sendError(status, errorShape(body, {
          type: error?.code || "local_router_stream_failed",
          message: "The local router lost the native Responses WebSocket.",
        }), error?.headers ? responseHeaders({ headers: error.headers }, { includeRateLimits: true }) : undefined);
      }
      this.continuations.clear();
      return true;
    } finally {
      if (controller.signal.aborted) {
        status = Number(controller.signal.reason?.status) || 499;
        outcome = status === 504 ? "failed" : "canceled";
      }
      prepared?.finish?.({ status, outcome, response: terminal?.response, outputObservation,
        usage: terminal?.response?.usage, firstTokenMs, latencyMs: Date.now() - startedAt });
      this.abortController.signal.removeEventListener("abort", onClose);
      controller.abort();
    }
  }

  async process(request) {
    if (this.closed) return;
    try {
      this.options.admitRequest?.();
    } catch {
      this.sendError(503, {
        type: "local_router_draining",
        message: "The local router is draining for a service operation.",
      });
      return;
    }
    if (!request || Array.isArray(request) || request.type !== "response.create") {
      // Retain only shape categories. The rejected value may contain private
      // history, so never log its body, keys, arbitrary type value or identity.
      const messageShape = request === null ? "null"
        : Array.isArray(request) ? "array" : typeof request;
      const typeShape = request && typeof request === "object" && !Array.isArray(request)
        ? Object.hasOwn(request, "type") ? typeof request.type : "missing"
        : "not_object";
      console.warn(`[codex-router] websocket-protocol at=${new Date().toISOString()} code=invalid_websocket_message_type message_shape=${messageShape} type_shape=${typeShape}`);
      this.sendError(400, {
        type: "invalid_request_error",
        code: "invalid_websocket_message_type",
        param: "type",
        message: "Responses WebSocket messages must have type response.create or response.interrupt.",
      });
      return;
    }
    if (!Array.isArray(request.input) || request.stream !== true) {
      this.sendError(400, {
        type: "invalid_request_error",
        message: "response.create requires an input array and stream=true.",
      });
      return;
    }

    const fullRequest = { ...request };
    const clientMetadata = fullRequest.client_metadata;
    delete fullRequest.type;
    delete fullRequest.generate;
    delete fullRequest.previous_response_id;
    // client_metadata is the canonical per-request Codex metadata transport.
    // Keep it on the internal HTTP body so native traffic receives it; the
    // ordinary router path already removes it from routed-provider payloads.
    // Only WebSocket timing/trace projections are translated to headers and
    // removed from the HTTP body.
    const canonicalMetadata = canonicalClientMetadata(clientMetadata);
    if (canonicalMetadata === undefined) delete fullRequest.client_metadata;
    else fullRequest.client_metadata = canonicalMetadata;
    const previousId = typeof request.previous_response_id === "string"
      ? request.previous_response_id
      : undefined;
    const previous = previousId ? this.continuations.get(previousId) : undefined;
    if (previousId && previous) {
      fullRequest.input = [...previous.input, ...previous.output, ...request.input];
    }
    if (await this.processNative(request, fullRequest, clientMetadata, previous)) return;
    if (previousId && !previous) {
        this.sendError(409, {
          type: "invalid_request_error",
          code: "previous_response_not_found",
          message: "Previous response was not found. Retrying the full request.",
        });
        return;
    }
    // Codex's ResponseCreateWsRequest serializes every stable non-input field
    // on incremental frames; only `input` becomes the suffix and
    // `previous_response_id` names its baseline. Keep the current envelope as
    // authority. Inheriting absent fields from an earlier request would turn a
    // meaningful omission (for example no tools) into stale configuration.
    const encoded = Buffer.from(JSON.stringify(fullRequest), "utf8");
    if (encoded.length > this.options.maxMessageBytes) {
      this.sendError(413, {
        type: "request_too_large",
        message: `Reconstructed Responses request exceeds ${this.options.maxMessageBytes} bytes.`,
      });
      return;
    }

    if (request.generate === false) {
      const responseId = `resp_router_prewarm_${randomUUID().replaceAll("-", "")}`;
      this.continuations.clear();
      this.continuations.set(responseId, { input: fullRequest.input, output: [] });
      await this.sendJsonWithBackpressure({
        type: "response.created",
        response: { id: responseId },
      });
      await this.sendJsonWithBackpressure({
        type: "response.completed",
        response: {
          id: responseId,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      });
      return;
    }

    const controller = new AbortController();
    const onClose = () => controller.abort(this.abortController.signal.reason);
    this.abortController.signal.addEventListener("abort", onClose, { once: true });
    let upstream;
    let terminalSeen = false;
    try {
      upstream = await this.options.fetchImpl(this.options.responsesUrl, {
        method: "POST",
        headers: loopbackHeaders(
          this.request,
          this.options.callerKey,
          clientMetadata,
          this.turnState,
          this.options.internalAuthorization,
        ),
        body: encoded,
        signal: controller.signal,
        // This is a fixed loopback re-entry into the Router. A redirect would
        // replay the complete request outside the authenticated path owner.
        redirect: "error",
      });
      if (!upstream.ok) {
        const body = await readResponseBody(upstream, {
          maxBytes: this.options.maxErrorBytes,
          signal: controller.signal,
        });
        this.sendError(
          upstream.status,
          errorShape(body, {
            type: "local_router_error",
            message: "The local router rejected the Responses request.",
          }),
          responseHeaders(upstream, { includeRateLimits: true }),
        );
        return;
      }
      const responseTurnState = safeHeaderValue(upstream.headers.get("x-codex-turn-state"));
      const currentTurnId = metadataTurnId(clientMetadata);
      if (
        responseTurnState &&
        (!this.turnState?.value || (currentTurnId && currentTurnId !== this.turnState.turnId))
      ) {
        this.turnState = { value: responseTurnState, turnId: currentTurnId };
      }
      let contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
      const declaredMediaType = contentType.split(";", 1)[0].trim();
      const declaredJson =
        declaredMediaType === "application/json" || declaredMediaType.endsWith("+json");
      if (!contentType.includes("text/event-stream") && !declaredJson) {
        // A completed internal request must not be discarded solely because a
        // loopback hop omitted or misdeclared Content-Type. Sniff only enough
        // bytes to prove SSE framing; otherwise retain the untouched body and
        // validate it through the bounded completed-JSON path below.
        const detected = await sniffUndeclaredResponse(upstream, controller.signal);
        upstream = detected.response;
        if (detected.kind === "event-stream") contentType = "text/event-stream";
      }
      if (!contentType.includes("text/event-stream")) {
        const body = await readResponseBody(upstream, {
          maxBytes: this.options.maxEventBytes,
          signal: controller.signal,
        });
        let completedResponse;
        try {
          completedResponse = JSON.parse(body.toString("utf8"));
        } catch {
          this.sendError(502, {
            type: "local_router_protocol_error",
            message: "The internal Responses endpoint returned invalid response JSON.",
          });
          return;
        }
        if (!validCompletedResponse(completedResponse)) {
          this.continuations.clear();
          this.sendError(502, {
            type: "local_router_protocol_error",
            message: "The internal Responses endpoint returned an invalid completed response.",
          });
          return;
        }
        if (!(await sendSuccessfulResponseHeaders(this, upstream))) return;
        if (!(await this.sendJsonWithBackpressure({
          type: "response.created",
          response: { ...completedResponse, status: "in_progress", output: [] },
        }))) return;
        for (const [outputIndex, item] of completedResponse.output.entries()) {
          if (!(await this.sendJsonWithBackpressure({
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          }))) return;
        }
        if (!(await this.sendJsonWithBackpressure({
          type: "response.completed",
          response: completedResponse,
        }))) return;
        this.continuations.clear();
        const continuation = continuationState(
          fullRequest.input,
          completedResponse.output,
          this.options.maxContinuationBytes,
        );
        if (continuation) this.continuations.set(completedResponse.id, continuation);
        return;
      }
      if (!(await sendSuccessfulResponseHeaders(this, upstream))) return;
      const outputItems = [];
      let outputItemsBytes = 0;
      let continuationOverflow = false;
      await relaySse(
        upstream.body,
        async (data) => {
          // The first terminal ends the logical response. The accepted outcome
          // is committed below, then the remaining body is canceled so trailers
          // cannot block this serialized queue or replace that outcome.
          if (terminalSeen) return true;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            const error = new Error("The internal Responses endpoint emitted invalid SSE JSON.");
            error.code = "ERR_RESPONSES_WS_INVALID_SSE";
            throw error;
          }
          if (!event || typeof event !== "object" || Array.isArray(event)) return true;
          if (event.type === "response.completed" && !validCompletedResponse(event.response)) {
            // A completion without a usable id cannot become the baseline for
            // the next WebSocket frame. Reject it before the client observes a
            // successful terminal and discard any older baseline so a later
            // incremental frame cannot replay stale history accidentally.
            this.continuations.clear();
            const error = new Error(
              "The internal Responses endpoint emitted an invalid completed response.",
            );
            error.code = "local_router_protocol_error";
            throw error;
          }
          if (!(await this.sendJsonWithBackpressure(event, data))) return false;
          if (event.type === "response.output_item.done" && event.item) {
            const itemBytes = Buffer.byteLength(JSON.stringify(event.item), "utf8");
            if (outputItemsBytes + itemBytes <= this.options.maxContinuationBytes) {
              outputItems.push(event.item);
              outputItemsBytes += itemBytes;
            } else {
              continuationOverflow = true;
            }
          }
          if (event.type === "response.completed") {
            terminalSeen = true;
            const output = reconciledContinuationOutput(event.response.output, outputItems);
            this.continuations.clear();
            const continuation = !continuationOverflow
              ? continuationState(
                fullRequest.input,
                output,
                this.options.maxContinuationBytes,
              )
              : undefined;
            if (continuation) this.continuations.set(event.response.id, continuation);
            // The terminal is complete and the continuation is committed.
            // Cancel the remaining HTTP body so this serialized WebSocket can
            // accept its next frame even if an upstream keeps the stream open.
            return false;
          }
          if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
            terminalSeen = true;
            return false;
          }
          return true;
        },
        {
          signal: controller.signal,
          maxEventBytes: this.options.maxEventBytes,
        },
      );
      if (!terminalSeen && !this.closed) {
        this.sendError(502, {
          type: "local_router_stream_failed",
          message: "The internal Responses stream ended before response.completed.",
        });
      }
    } catch (error) {
      if (!terminalSeen && !this.closed && !controller.signal.aborted) {
        this.sendError(502, {
          type: error?.code || "local_router_stream_failed",
          message: "The local router lost the internal Responses stream.",
        });
      }
    } finally {
      this.abortController.signal.removeEventListener("abort", onClose);
      controller.abort();
    }
  }
}

export function handleResponsesWebSocketUpgrade(
  request,
  socket,
  head,
  {
    callerKey,
    responsesUrl,
    authenticateUpgrade,
    internalAuthorization,
    fetchImpl = fetch,
    maxMessageBytes = MAX_BODY_BYTES,
    maxEventBytes = MAX_BUFFERED_RESPONSE_BYTES,
    maxErrorBytes = MAX_BUFFERED_RESPONSE_BYTES,
    maxContinuationBytes = maxMessageBytes,
    maxFragmentFrames = MAX_FRAGMENT_FRAMES,
    admitUpgrade,
    admitRequest,
    prepareNativeRequest,
    onPeer,
  },
) {
  maxMessageBytes = Number.isFinite(maxMessageBytes) && maxMessageBytes > 0
    ? Math.floor(maxMessageBytes)
    : MAX_BODY_BYTES;
  maxEventBytes = Number.isFinite(maxEventBytes) && maxEventBytes > 0
    ? Math.floor(maxEventBytes)
    : MAX_BUFFERED_RESPONSE_BYTES;
  maxErrorBytes = Number.isFinite(maxErrorBytes) && maxErrorBytes > 0
    ? Math.floor(maxErrorBytes)
    : MAX_BUFFERED_RESPONSE_BYTES;
  maxContinuationBytes = Number.isFinite(maxContinuationBytes) && maxContinuationBytes > 0
    ? Math.floor(maxContinuationBytes)
    : maxMessageBytes;
  maxFragmentFrames = Number.isFinite(maxFragmentFrames) && maxFragmentFrames > 0
    ? Math.floor(maxFragmentFrames)
    : MAX_FRAGMENT_FRAMES;
  socket.on("error", () => {});
  let requestUrl;
  try {
    requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  } catch {
    rejectUpgrade(socket, 400, "Invalid WebSocket request URL.");
    return false;
  }
  // Keep authentication policy outside the frame/parser implementation. Main
  // uses the capability-bearing path today; a caller surface that validates a
  // direct bearer can inject the same pre-101 decision without weakening or
  // duplicating the WebSocket protocol boundary.
  let route;
  try {
    route = authenticateUpgrade
      ? authenticateUpgrade(request, requestUrl)
      : authenticatedRoute(requestUrl.pathname, callerKey);
  } catch {
    route = undefined;
  }
  if (!route) {
    rejectUpgrade(
      socket,
      401,
      "This local router endpoint requires its configured caller authentication.",
    );
    return false;
  }
  if (!RESPONSE_ROUTES.has(route)) {
    rejectUpgrade(socket, 404, "Unsupported router WebSocket route.");
    return false;
  }
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    rejectUpgrade(socket, 403, "Browser-originated WebSocket requests are not accepted.");
    return false;
  }
  if (
    request.method !== "GET" ||
    String(request.headers.upgrade || "").toLowerCase() !== "websocket" ||
    !headerTokens(request.headers.connection).includes("upgrade") ||
    request.headers["sec-websocket-version"] !== "13" ||
    !validWebSocketKey(request.headers["sec-websocket-key"])
  ) {
    rejectUpgrade(socket, 426, "A valid RFC 6455 WebSocket upgrade is required.", {
      "Sec-WebSocket-Version": "13",
    });
    return false;
  }
  if (!requestHasBeta(request)) {
    rejectUpgrade(
      socket,
      426,
      `OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA} is required.`,
      { "OpenAI-Beta": RESPONSES_WEBSOCKET_BETA },
    );
    return false;
  }
  try {
    admitUpgrade?.();
  } catch {
    rejectUpgrade(socket, 503, "The local router is draining for a service operation.");
    return false;
  }
  acceptUpgrade(request, socket);
  const peer = new ResponsesWebSocketPeer(socket, request, {
    callerKey,
    responsesUrl,
    internalAuthorization,
    fetchImpl,
    maxMessageBytes,
    maxEventBytes,
    maxErrorBytes,
    maxContinuationBytes,
    maxFragmentFrames,
    admitRequest,
    prepareNativeRequest,
  });
  peer.options.unregisterPeer = onPeer?.(peer);
  peer.start(head);
  return true;
}
