import { getGlobalDispatcher, WebSocket } from "undici";

import { connectTimeoutMs } from "./connect-timeout.mjs";

const TERMINALS = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);
const PER_TURN_HEADERS = new Set([
  "x-codex-installation-id",
  "x-codex-parent-thread-id", "x-codex-window-id", "x-openai-subagent",
  "traceparent", "tracestate", "x-client-request-id", "x-codex-turn-metadata",
  "x-codex-turn-state", "x-openai-internal-codex-responses-lite",
]);
const IDLE_METADATA = new Set(["response.metadata", "codex.response.metadata", "codex.rate_limits"]);

function failure(code, message, properties = {}) {
  return Object.assign(new Error(message), { code, ...properties });
}

function connectionKey(prepared) {
  const headers = [...new Headers(prepared.headers).entries()]
    .filter(([name]) => !PER_TURN_HEADERS.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([prepared.target, prepared.payload.model, headers]);
}

export function isInterruptedResponse(event) {
  const response = event?.response;
  return event?.type === "response.incomplete" && response &&
    typeof response === "object" && !Array.isArray(response) &&
    typeof response.id === "string" && response.id.length > 0 &&
    response.status === "incomplete" && response.incomplete_details?.reason === "interrupted" &&
    Array.isArray(response.output);
}

// Each client connection owns its upstream connection and its most recent
// produced response. No credentials, prompt cache or response IDs are shared.
export class NativeResponsesWebSocket {
  constructor({ maxEventBytes, maxErrorBytes, maxFragmentFrames, timeoutMs = connectTimeoutMs() }) {
    this.bounds = { maxEventBytes, maxErrorBytes, maxFragmentFrames };
    this.timeoutMs = timeoutMs;
  }

  canContinue(prepared, previousId) {
    return this.connection?.websocket.readyState === WebSocket.OPEN &&
      this.connection.key === connectionKey(prepared) &&
      this.connection.responseId === previousId;
  }

  interrupt(responseId) {
    const connection = this.connection;
    if (!connection || connection.error || connection.websocket.readyState !== WebSocket.OPEN) return false;
    if (connection.activeResponseId !== responseId) {
      // A completion can race the client's interrupt. Never apply an old ID to
      // the next response, but allow an interrupt of the just-finished response.
      return connection.responseId === responseId;
    }
    if (!connection.interruptSent) {
      connection.websocket.send(JSON.stringify({
        type: "response.interrupt", response_id: responseId, mode: "discard_partial_items",
      }));
      connection.interruptSent = true;
    }
    return true;
  }

  close() {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    connection.fail(failure("local_router_stream_failed", "Native Responses connection closed."));
    // Destroy the owned socket on cancellation instead of waiting indefinitely
    // for a peer close handshake while a billable response keeps running.
    connection.socket?.destroy();
    try { connection.websocket.close(); } catch { /* Already closing. */ }
  }

  async connect(prepared, signal) {
    const key = connectionKey(prepared);
    if (this.connection?.key === key && this.connection.websocket.readyState === WebSocket.OPEN) {
      return { connection: this.connection, fresh: false };
    }
    this.close();
    signal.throwIfAborted();
    const connection = { key, headers: new Headers(), queued: [], queuedBytes: 0, idle: [], sent: false };
    let settleOpen;
    const opened = new Promise((resolve, reject) => { settleOpen = { resolve, reject }; });
    connection.fail = (error) => {
      if (connection.error) return;
      connection.error = error;
      settleOpen.reject(error);
      connection.waiting?.reject(error);
      connection.waiting = undefined;
    };
    const parentDispatcher = getGlobalDispatcher();
    const dispatcher = {
      webSocketOptions: {
        maxPayloadSize: this.bounds.maxEventBytes,
        maxFragments: this.bounds.maxFragmentFrames,
      },
      dispatch: (options, handler) => {
        const wrapped = Object.create(handler);
        wrapped.onRequestUpgrade = (controller, status, headers, socket) => {
          connection.socket = socket;
          connection.headers = new Headers(headers);
          return handler.onRequestUpgrade.call(handler, controller, status, headers, socket);
        };
        wrapped.onResponseStart = (controller, status, headers, statusText) => {
          connection.status = status;
          connection.headers = new Headers(headers);
          return handler.onResponseStart.call(handler, controller, status, headers, statusText);
        };
        wrapped.onResponseData = (controller, chunk) => {
          if ((connection.errorBodyBytes || 0) + chunk.length <= this.bounds.maxErrorBytes) {
            connection.errorBody = (connection.errorBody || "") + chunk.toString("utf8");
            connection.errorBodyBytes = (connection.errorBodyBytes || 0) + chunk.length;
          }
          return handler.onResponseData.call(handler, controller, chunk);
        };
        return parentDispatcher.dispatch(options, wrapped);
      },
    };
    const url = new URL(prepared.target);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw failure("local_router_protocol_error", "Invalid native Responses target.");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    connection.websocket = new WebSocket(url.href, { headers: prepared.headers, dispatcher });
    this.connection = connection;
    connection.websocket.addEventListener("open", () => settleOpen.resolve());
    connection.websocket.addEventListener("error", () => {
      connection.fail(failure("local_router_stream_failed", "Native Responses WebSocket failed.", {
        status: connection.status,
        headers: connection.headers,
        body: connection.errorBody,
        sent: connection.sent,
      }));
    });
    connection.websocket.addEventListener("close", () => {
      connection.fail(failure("local_router_stream_failed", "Native Responses WebSocket ended before completion.", {
        status: connection.status, headers: connection.headers, body: connection.errorBody, sent: connection.sent,
      }));
    });
    connection.websocket.addEventListener("message", ({ data }) => {
      if (connection.error) return;
      const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : Infinity;
      if (typeof data !== "string" || bytes > this.bounds.maxEventBytes) {
        connection.fail(failure("ERR_RESPONSES_WS_EVENT_TOO_LARGE", "Native Responses event exceeds its bound."));
        connection.socket?.destroy();
        return;
      }
      let event;
      try { event = JSON.parse(data); } catch {
        connection.fail(failure("local_router_protocol_error", "Native Responses emitted invalid JSON."));
        connection.socket?.destroy();
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
        connection.fail(failure("local_router_protocol_error", "Native Responses emitted an invalid event."));
        connection.socket?.destroy();
        return;
      }
      if (!connection.active) {
        if (IDLE_METADATA.has(event.type) && connection.idle.length < 16) connection.idle.push(event);
        else {
          connection.fail(failure("local_router_protocol_error", "Native Responses emitted an unsolicited event."));
          connection.socket?.destroy();
        }
        return;
      }
      connection.queuedBytes += bytes;
      if (connection.queuedBytes > this.bounds.maxEventBytes * 2) {
        connection.fail(failure("ERR_RESPONSES_WS_EVENT_TOO_LARGE", "Native Responses queue exceeds its bound."));
        connection.socket?.destroy();
      } else if (connection.waiting) {
        connection.waiting.resolve({ event, bytes, rawJson: data });
        connection.waiting = undefined;
      } else {
        connection.queued.push({ event, bytes, rawJson: data });
        connection.socket?.pause();
      }
    });
    const abort = () => this.close();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      connection.fail(failure("local_router_stream_failed", "Native Responses WebSocket handshake timed out."));
      this.close();
    }, this.timeoutMs);
    try {
      await opened;
      signal.throwIfAborted();
      return { connection, fresh: true };
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  async run(prepared, { signal, onEvent, onHeaders }) {
    const { connection, fresh } = await this.connect(prepared, signal);
    if (fresh && !(await onHeaders(connection.headers))) return undefined;
    signal.throwIfAborted();
    const abort = () => this.close();
    signal.addEventListener("abort", abort, { once: true });
    connection.active = true;
    connection.activeResponseId = undefined;
    connection.interruptSent = false;
    connection.sent = true;
    try {
      for (const event of connection.idle.splice(0)) {
        if (!(await onEvent(event))) return undefined;
      }
      connection.websocket.send(prepared.encoded || JSON.stringify({ ...prepared.payload, type: "response.create" }));
      while (true) {
        signal.throwIfAborted();
        if (connection.error) throw connection.error;
        const next = connection.queued.shift() || await new Promise((resolve, reject) => {
          connection.waiting = { resolve, reject };
        });
        connection.socket?.pause();
        if (next.event.type === "response.created" && typeof next.event.response?.id === "string") {
          connection.activeResponseId = next.event.response.id;
        }
        if (TERMINALS.has(next.event.type)) {
          // Update identity before forwarding: a client can interrupt as soon
          // as it receives an event, including while forwarding awaits drain.
          connection.activeResponseId = undefined;
          connection.responseId = next.event.type === "response.completed" || isInterruptedResponse(next.event)
            ? next.event.response?.id : undefined;
        }
        // Keep the parsed event for protocol/state decisions, while the edge
        // can forward unchanged native JSON without serializing it again.
        const forwarded = await onEvent(next.event, next.rawJson);
        connection.queuedBytes -= next.bytes;
        if (TERMINALS.has(next.event.type)) {
          // Rate-limit/transport metadata may share the terminal's network
          // packet. Retain the same bounded idle metadata accepted between
          // requests; response output after a terminal remains a violation.
          const trailing = connection.queued.splice(0);
          if (trailing.some(({ event }) => !IDLE_METADATA.has(event.type)) ||
              connection.idle.length + trailing.length > 16) this.close();
          else connection.idle.push(...trailing.map(({ event }) => event));
          connection.queuedBytes = 0;
          return next.event;
        }
        if (!forwarded) { this.close(); return undefined; }
        if (!connection.queued.length) connection.socket?.resume();
      }
    } catch (error) {
      this.close();
      throw error;
    } finally {
      connection.active = false;
      connection.activeResponseId = undefined;
      connection.socket?.resume();
      signal.removeEventListener("abort", abort);
    }
  }
}
