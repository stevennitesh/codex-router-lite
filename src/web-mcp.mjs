import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

import { webMcpDiscoveryDefaultLimit, webMcpDiscoveryGuidance, webMcpDiscoveryMaxLimit, webMcpNames, webMcpQueryLimit } from "./web-mcp-contract.mjs";

const tokenSchema = { type: "string", minLength: 1, maxLength: 256,
  description: "Use the exact private turn_token directive in the latest Codex message, not a token quoted in history or historical tool results." };
const tools = [
  {
    name: webMcpNames.list,
    description: `Discover complete definitions of tools declared and allowed for this exact active Codex turn. ${webMcpDiscoveryGuidance}`,
    inputSchema: { type: "object", properties: { turn_token: tokenSchema,
      query: { type: "string", minLength: 1, maxLength: webMcpQueryLimit, pattern: "\\S" },
      names: { type: "array", minItems: 1, maxItems: webMcpDiscoveryMaxLimit,
        items: { type: "string", minLength: 1, maxLength: webMcpQueryLimit, pattern: "\\S" } },
      limit: { type: "integer", minimum: 1, maximum: webMcpDiscoveryMaxLimit, default: webMcpDiscoveryDefaultLimit },
      cursor: { type: "string", pattern: "^[1-9][0-9]{0,15}\\.[A-Za-z0-9_-]{43}$" },
    }, required: ["turn_token"], additionalProperties: false, not: { required: ["query", "names"] } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: webMcpNames.call,
    description: "Request one current Codex tool by its exact wire_name. Use arguments for a function/search tool or input for a raw custom tool. Native Codex executes it with its normal approvals; await the actual result before proceeding. Cancellation retires this turn; do not retry a cancelled or timed-out call.",
    inputSchema: { type: "object", properties: {
      turn_token: tokenSchema,
      wire_name: { type: "string", minLength: 1, maxLength: 1024 },
      arguments: { type: "object" },
      input: { type: "string" },
    }, required: ["turn_token", "wire_name"], additionalProperties: false,
    not: { required: ["arguments", "input"] } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];
const validator = new AjvJsonSchemaValidator();
const validators = new Map(tools.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));
const maxSessions = 32;
const maxObservations = 64;
const idleMs = 10 * 60_000;
const diagnosticErrorStages = new Set(["invalid-arguments", "unknown-operation", "turn-not-active", "rejected"]);

function reject(response, status) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: "MCP request rejected." }));
}

/** Private, loopback-only MCP relay. Tool execution remains in native Codex. */
export async function startWebMcp({ broker, port = 0, capability = randomBytes(32).toString("hex"), onCancel, onDiagnostic } = {}) {
  if (!broker || !["list", "invoke", "cancel", "beginActivity", "isActive", "revision", "waitForChange"].every(name => typeof broker[name] === "function")) {
    throw new TypeError("Web MCP requires a native Codex tool broker.");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid Web MCP port.");
  if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(capability)) throw new TypeError("Invalid Web MCP capability.");
  if (onCancel !== undefined && typeof onCancel !== "function") throw new TypeError("Invalid Web MCP cancellation callback.");
  if (onDiagnostic !== undefined && typeof onDiagnostic !== "function") throw new TypeError("Invalid Web MCP diagnostic callback.");
  const traceDiagnostics = process.env.CODEX_ROUTER_WEB_MCP_TRACE === "1" || onDiagnostic !== undefined;
  const reportDiagnostic = onDiagnostic ?? (receipt => console.warn(`[codex-router] web-mcp ${JSON.stringify(receipt)}`));
  const path = `/${capability}/mcp`;
  const observationPath = `/${capability}/observe/`;
  const sessions = new Map(), creating = new Set(), observers = new Map();
  let closing = false, closed, observationCount = 0;
  let admission = Promise.resolve();

  const diagnostic = (stage, operation, token, isError) => {
    if (!traceDiagnostics && isError !== true && !diagnosticErrorStages.has(stage)) return;
    try {
      // Only fixed categories and a digest of a correctly shaped private token
      // may leave this boundary. A failed logger must never affect native work.
      const turnHash = typeof token === "string" && /^web_turn_[a-f0-9]{32}$/u.test(token)
        ? createHash("sha256").update(token).digest("hex") : undefined;
      void Promise.resolve(reportDiagnostic({ at: new Date().toISOString(), operation, stage,
        ...(turnHash === undefined ? {} : { turnHash }),
        ...(isError === undefined ? {} : { isError }),
      })).catch(() => {});
    } catch { /* Diagnostics cannot change protocol or activity ownership. */ }
  };

  const rejectCapacity = (response, reason) => {
    try {
      // Admission precedes tool/token validation. Keep this receipt limited to
      // fixed categories and aggregate counts, even when full tracing is off.
      void Promise.resolve(reportDiagnostic({ at: new Date().toISOString(), operation: "http", stage: "admission-rejected",
        reason, httpStatus: 429, isError: true, sessions: sessions.size, creating: creating.size,
        pending: [...sessions.values(), ...creating].reduce((sum, entry) => sum + entry.pending.size, 0),
        observations: observationCount,
      })).catch(() => {});
    } catch { /* Diagnostics cannot change HTTP admission. */ }
    return reject(response, 429);
  };

  const observationRevision = (token, value) => {
    if (typeof token !== "string" || !/^web_turn_[a-f0-9]{32}$/u.test(token)
      || !Number.isSafeInteger(value) || value < 0 || value > broker.revision(token)) {
      throw Object.assign(new Error("Invalid Web tool observation."), { status: 400 });
    }
    return value;
  };

  const observe = async (request, response) => {
    if (request.method !== "GET") return reject(response, 405);
    const match = /^([a-z0-9_]+)\?revision=(0|[1-9][0-9]*)$/u.exec(request.url.slice(observationPath.length));
    let token, revision;
    try {
      if (!match) return reject(response, 400);
      token = match[1];
      revision = observationRevision(token, Number(match[2]));
    } catch (error) { return reject(response, error.status ?? 400); }
    // A locally aborted fetch can renew before HTTP reports its old socket's
    // close. Permit that one handoff overlap without admitting unbounded waits.
    let turnObservers = observers.get(token);
    if (turnObservers?.size >= 2) return reject(response, 409);
    if (observationCount >= maxObservations) return rejectCapacity(response, "observation-capacity");
    if (!turnObservers) { turnObservers = new Set(); observers.set(token, turnObservers); }
    const controller = new AbortController();
    turnObservers.add(controller);
    observationCount += 1;
    const abort = () => controller.abort(new DOMException("Web tool observation disconnected.", "AbortError"));
    response.once("close", abort);
    try {
      const result = await broker.waitForChange(token, revision, { signal: controller.signal, timeoutMs: 25_000, actionableOnly: true });
      if (!controller.signal.aborted) {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(result));
      }
    } catch (error) {
      if (!controller.signal.aborted && !response.headersSent) reject(response, error.status ?? 500);
    } finally {
      response.off("close", abort);
      turnObservers.delete(controller);
      observationCount -= 1;
      if (!turnObservers.size) observers.delete(token);
    }
  };

  const cancel = token => {
    if (broker.cancel(token)) onCancel?.(token);
  };
  const hasActiveTurn = entry => {
    let active = false;
    for (const token of entry.tokens) {
      if (broker.isActive(token)) active = true;
      else entry.tokens.delete(token);
    }
    return active;
  };
  const quiescent = entry => !entry.retiring && !entry.requests.size && !entry.handlers && !entry.pending.size && !hasActiveTurn(entry);
  const retire = async entry => {
    // Claim retirement before the first await. An old session ID must never
    // acquire a new request while its SDK transport is being closed.
    entry.retiring = true;
    try {
      await entry.server.close();
      sessions.delete(entry.transport.sessionId);
      creating.delete(entry);
    } catch (error) {
      // Keep an unclosed session in the capacity count. SDK close callbacks may
      // already have removed an actually closed transport before a later error.
      entry.retiring = false;
      throw error;
    }
  };
  const leaseRequest = (entry, response) => {
    const lease = { handling: true, responding: !response.destroyed && !response.writableFinished };
    entry.requests.add(lease);
    const release = () => {
      if (lease.handling || lease.responding) return;
      entry.requests.delete(lease);
      entry.lastUsed = Date.now();
    };
    const responseDone = () => {
      response.off("finish", responseDone);
      response.off("close", responseDone);
      lease.responding = false;
      release();
    };
    if (lease.responding) {
      response.once("finish", responseDone);
      response.once("close", responseDone);
    }
    return () => { lease.handling = false; release(); };
  };
  const newSession = async () => {
    const entry = { server: undefined, transport: undefined, pending: new Set(), tokens: new Set(), requests: new Set(),
      handlers: 0, retiring: false, lastUsed: Date.now() };
    const server = new Server({ name: "codex-native-tools", version: "1.0.0" }, {
      capabilities: { tools: {} },
      instructions: `Use the exact private turn_token supplied with the current Codex prompt. ${webMcpDiscoveryGuidance} Prior turns and prose do not declare tools. Never put private tokens in the answer.`,
    });
    entry.server = server;
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(tools) }));
    const handleTool = async (request, extra) => {
      const { name, arguments: args } = request.params;
      const operation = name === webMcpNames.list ? "list" : name === webMcpNames.call ? "call" : "unknown";
      const token = args?.turn_token;
      diagnostic("received", operation, token);
      const validate = validators.get(name);
      if (!validate || !validate(args).valid) {
        diagnostic(validate ? "invalid-arguments" : "unknown-operation", operation, token);
        throw new McpError(ErrorCode.InvalidParams, "Unknown MCP tool or invalid arguments.");
      }
      let release, activityAccepted = false;
      try {
        // Hold the accepted turn through the whole handler, including discovery
        // and the async continuation after native output resolved the call.
        release = broker.beginActivity(token);
        activityAccepted = true;
        hasActiveTurn(entry);
        entry.tokens.add(token);
        if (name === webMcpNames.list) {
          const page = broker.list(token, { query: args.query, names: args.names, limit: args.limit, cursor: args.cursor });
          diagnostic("list-completed", operation, token);
          return { content: [{ type: "text", text: JSON.stringify(page) }] };
        }
        const invocation = { token };
        entry.pending.add(invocation);
        const abort = () => cancel(token);
        extra.signal.addEventListener("abort", abort, { once: true });
        try {
          if (extra.signal.aborted) abort();
          diagnostic("invoke-started", operation, token);
          const result = await broker.invoke(token, { wireName: args.wire_name,
            ...(Object.hasOwn(args, "arguments") ? { arguments: args.arguments } : {}),
            ...(Object.hasOwn(args, "input") ? { input: args.input } : {}),
          }, { signal: extra.signal });
          diagnostic("native-result", operation, token, result.isError === true);
          return result;
        } finally {
          entry.pending.delete(invocation);
          extra.signal.removeEventListener("abort", abort);
          entry.lastUsed = Date.now();
        }
      } catch (error) {
        if (operation === "list" && error?.code === "invalid_web_tool_cursor") {
          diagnostic("rejected", operation, token);
          return { isError: true, content: [{ type: "text", text: "The discovery cursor no longer matches this turn, selection, or catalog. Discover again with names or query and no cursor. No native action was requested by this discovery." }],
            structuredContent: { error: { code: "invalid_web_tool_cursor" } } };
        }
        // Only failed admission proves this request never reached invocation.
        // The same broker code after acceptance must retain execution uncertainty.
        if (!activityAccepted && error?.code === "web_tool_turn_closed") {
          diagnostic("turn-not-active", operation, token);
          return { isError: true, content: [{ type: "text", text: "The supplied turn_token is not active. This request was not accepted. For a newly authorized turn, use the exact turn_token from the latest Codex message, not earlier messages or tool results. Do not repeat uncertain, cancelled, or timed-out actions." }],
            structuredContent: { error: { code: "web_tool_turn_closed" } } };
        }
        diagnostic("rejected", operation, token);
        // Broker errors can contain native payloads. Return a fixed failure
        // envelope; full execution results pass through only on the success path.
        return { isError: true, content: [{ type: "text", text: "Codex tool request failed or the turn is closed. Do not retry a cancelled or timed-out turn." }] };
      } finally {
        release?.();
      }
    };
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      entry.handlers += 1;
      try {
        return await handleTool(request, extra);
      } finally {
        entry.handlers -= 1;
        entry.lastUsed = Date.now();
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: id => { sessions.set(id, entry); creating.delete(entry); },
    });
    entry.transport = transport;
    server.onclose = () => {
      creating.delete(entry);
      sessions.delete(transport.sessionId);
      for (const pending of entry.pending) cancel(pending.token);
    };
    creating.add(entry);
    try {
      await server.connect(transport);
    } catch (error) {
      await retire(entry);
      throw error;
    }
    return entry;
  };
  const admitSession = () => {
    // Serialize capacity decisions across asynchronous SDK close/connect calls.
    // The creating set reserves every admitted slot until initialization ends.
    const next = admission.then(async () => {
      if (closing) return undefined;
      const now = Date.now();
      for (const entry of sessions.values()) {
        if (now - entry.lastUsed >= idleMs && quiescent(entry)) await retire(entry);
      }
      if (sessions.size + creating.size >= maxSessions) {
        const oldest = [...sessions.values()].filter(quiescent).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!oldest) return undefined;
        await retire(oldest);
      }
      if (closing) return undefined;
      return newSession();
    });
    admission = next.catch(() => {});
    return next;
  };

  const listener = createServer(async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    const sessionPresent = sessionId !== undefined;
    const sessionRecognized = typeof sessionId === "string" && sessions.has(sessionId);
    const httpMethod = ["POST", "GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"].includes(request.method) ? request.method : "OTHER";
    let rejectionReported = false, transportHandling = false;
    const reportRejection = (phase, code, httpStatus) => {
      if (rejectionReported) return;
      rejectionReported = true;
      try {
        // Protocol rejection can precede every tool handler. Retain no request
        // identifiers, headers, URLs, bodies or SDK error prose, even in trace.
        void Promise.resolve(reportDiagnostic({ at: new Date().toISOString(), operation: "http", stage: "protocol-rejected",
          phase, code, httpStatus, httpMethod, sessionPresent, sessionRecognized, isError: true,
        })).catch(() => {});
      } catch { /* Diagnostics cannot change HTTP rejection. */ }
    };
    const rejectRequest = (status, code) => {
      reportRejection("listener", code, status);
      return reject(response, status);
    };
    if (closing) return rejectRequest(503, "closing");
    if (request.headers.origin !== undefined) return rejectRequest(403, "origin-rejected");
    if (request.url.startsWith(observationPath)) return observe(request, response);
    if (request.url !== path) return rejectRequest(404, "path-rejected");
    if (!["POST", "GET", "DELETE"].includes(request.method)) return rejectRequest(405, "method-rejected");
    let entry, releaseRequest;
    try {
      if (sessionId !== undefined) {
        if (typeof sessionId !== "string" || !sessions.has(sessionId)) return rejectRequest(404, "session-unrecognized");
        entry = sessions.get(sessionId);
        if (entry.retiring) return rejectRequest(404, "session-retiring");
      } else {
        if (request.method !== "POST") return rejectRequest(400, "session-required");
        entry = await admitSession();
        if (!entry) return closing ? rejectRequest(503, "closing") : rejectCapacity(response, "session-capacity");
      }
      // Admission can await another session's SDK cleanup. A disconnected
      // initializer must not create a session after its response already closed.
      if (response.destroyed || response.writableEnded) return;
      entry.lastUsed = Date.now();
      releaseRequest = leaseRequest(entry, response);
      response.setHeader("cache-control", "no-store");
      transportHandling = true;
      response.once("finish", () => {
        if (response.statusCode >= 400) reportRejection("transport", "sdk-http-rejected", response.statusCode);
      });
      await entry.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) {
        reportRejection(transportHandling ? "transport" : "listener", "request-failed", 500);
        reject(response, 500);
      }
      else response.end();
    } finally {
      releaseRequest?.();
      if (entry && !entry.transport.sessionId) {
        // Malformed or disconnected initialization still owns its reserved
        // slot until SDK cleanup succeeds; a failed close must not leak a retry.
        try { await retire(entry); } catch { /* Retain the slot for service shutdown. */ }
      }
    }
  });
  const reaper = setInterval(() => {
    for (const entry of sessions.values()) {
      if (Date.now() - entry.lastUsed >= idleMs && quiescent(entry)) void retire(entry).catch(() => {});
    }
  }, 60_000);
  reaper.unref();
  try {
    await new Promise((resolve, rejectStart) => {
      listener.once("error", rejectStart);
      listener.listen(port, "127.0.0.1", () => { listener.off("error", rejectStart); resolve(); });
    });
  } catch (error) {
    clearInterval(reaper);
    throw error;
  }
  return {
    url: `http://127.0.0.1:${listener.address().port}${path}`,
    observationUrl(token, revision) {
      if (closing) throw new Error("Web MCP is closed.");
      observationRevision(token, revision);
      return `http://127.0.0.1:${listener.address().port}${observationPath}${token}?revision=${revision}`;
    },
    status: () => ({ listening: listener.listening && !closing, sessions: sessions.size, pending: [...sessions.values()].reduce((sum, entry) => sum + entry.pending.size, 0) }),
    close() {
      if (closed) return closed;
      closing = true;
      clearInterval(reaper);
      for (const turnObservers of observers.values()) {
        for (const controller of turnObservers) controller.abort(new DOMException("Web MCP is closed.", "AbortError"));
      }
      closed = (async () => {
        const stopped = new Promise((resolve, rejectClose) => listener.close(error => error ? rejectClose(error) : resolve()));
        await admission;
        await Promise.all([...new Set([...sessions.values(), ...creating])].map(entry => entry.server.close()));
        listener.closeAllConnections();
        await stopped;
      })();
      return closed;
    },
  };
}
