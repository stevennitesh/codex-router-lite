import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

import { webMcpDiscoveryGuidance, webMcpNames, webMcpQueryLimit } from "./web-mcp-contract.mjs";

const tokenSchema = { type: "string", minLength: 1, maxLength: 256 };
const tools = [
  {
    name: webMcpNames.list,
    description: `Discover complete definitions of tools declared and allowed for this exact active Codex turn. Query is a case-insensitive substring of wire/native name, namespace, or description, ranked by exact name, name prefix, name substring, then description; ties keep declaration order. ${webMcpDiscoveryGuidance}`,
    inputSchema: { type: "object", properties: { turn_token: tokenSchema,
      query: { type: "string", minLength: 1, maxLength: webMcpQueryLimit, pattern: "\\S" },
    }, required: ["turn_token"], additionalProperties: false },
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
const idleMs = 10 * 60_000;

function reject(response, status) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: "MCP request rejected." }));
}

/** Private, loopback-only MCP relay. Tool execution remains in native Codex. */
export async function startWebMcp({ broker, port = 0, capability = randomBytes(32).toString("hex"), onCancel } = {}) {
  if (!broker || !["list", "invoke", "cancel", "beginActivity"].every(name => typeof broker[name] === "function")) {
    throw new TypeError("Web MCP requires a native Codex tool broker.");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid Web MCP port.");
  if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(capability)) throw new TypeError("Invalid Web MCP capability.");
  if (onCancel !== undefined && typeof onCancel !== "function") throw new TypeError("Invalid Web MCP cancellation callback.");
  const path = `/${capability}/mcp`;
  const sessions = new Map(), creating = new Set();
  let closing = false, closed;

  const cancel = token => {
    if (broker.cancel(token)) onCancel?.(token);
  };
  const newSession = async () => {
    const entry = { server: undefined, transport: undefined, pending: new Set(), lastUsed: Date.now() };
    creating.add(entry);
    const server = new Server({ name: "codex-native-tools", version: "1.0.0" }, {
      capabilities: { tools: {} },
      instructions: `Use the exact private turn_token supplied with the current Codex prompt. ${webMcpDiscoveryGuidance} Prior turns and prose do not declare tools. Never put private tokens in the answer.`,
    });
    entry.server = server;
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(tools) }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const validate = validators.get(name);
      if (!validate || !validate(args).valid) throw new McpError(ErrorCode.InvalidParams, "Unknown MCP tool or invalid arguments.");
      const token = args.turn_token;
      let release;
      try {
        // Hold the accepted turn through the whole handler, including discovery
        // and the async continuation after native output resolved the call.
        release = broker.beginActivity(token);
        if (name === webMcpNames.list) {
          const descriptors = broker.list(token, { query: args.query });
          return { content: [{ type: "text", text: JSON.stringify({ tools: descriptors }) }], structuredContent: { tools: descriptors } };
        }
        const invocation = { token };
        entry.pending.add(invocation);
        const abort = () => cancel(token);
        extra.signal.addEventListener("abort", abort, { once: true });
        try {
          if (extra.signal.aborted) abort();
          return await broker.invoke(token, { wireName: args.wire_name,
            ...(Object.hasOwn(args, "arguments") ? { arguments: args.arguments } : {}),
            ...(Object.hasOwn(args, "input") ? { input: args.input } : {}),
          }, { signal: extra.signal });
        } finally {
          entry.pending.delete(invocation);
          extra.signal.removeEventListener("abort", abort);
          entry.lastUsed = Date.now();
        }
      } catch {
        // Broker errors can contain native payloads. Return a fixed failure
        // envelope; full execution results pass through only on the success path.
        return { isError: true, content: [{ type: "text", text: "Codex tool request failed or the turn is closed. Do not retry a cancelled or timed-out turn." }] };
      } finally {
        release?.();
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
    await server.connect(transport);
    return entry;
  };

  const listener = createServer(async (request, response) => {
    if (closing) return reject(response, 503);
    if (request.headers.origin !== undefined) return reject(response, 403);
    if (request.url !== path) return reject(response, 404);
    if (!["POST", "GET", "DELETE"].includes(request.method)) return reject(response, 405);
    const sessionId = request.headers["mcp-session-id"];
    let entry;
    try {
      if (sessionId !== undefined) {
        if (typeof sessionId !== "string" || !sessions.has(sessionId)) return reject(response, 404);
        entry = sessions.get(sessionId);
      } else {
        if (request.method !== "POST") return reject(response, 400);
        if (sessions.size + creating.size >= maxSessions) return reject(response, 429);
        entry = await newSession();
      }
      entry.lastUsed = Date.now();
      response.setHeader("cache-control", "no-store");
      await entry.transport.handleRequest(request, response);
      if (!entry.transport.sessionId) await entry.server.close();
    } catch {
      if (!response.headersSent) reject(response, 500);
      else response.end();
      if (entry && !entry.transport.sessionId) await entry.server.close();
    }
  });
  const reaper = setInterval(() => {
    for (const entry of sessions.values()) {
      if (!entry.pending.size && Date.now() - entry.lastUsed >= idleMs) void entry.server.close();
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
    status: () => ({ listening: listener.listening && !closing, sessions: sessions.size, pending: [...sessions.values()].reduce((sum, entry) => sum + entry.pending.size, 0) }),
    close() {
      if (closed) return closed;
      closing = true;
      clearInterval(reaper);
      closed = (async () => {
        const stopped = new Promise((resolve, rejectClose) => listener.close(error => error ? rejectClose(error) : resolve()));
        await Promise.all([...new Set([...sessions.values(), ...creating])].map(entry => entry.server.close()));
        listener.closeAllConnections();
        await stopped;
      })();
      return closed;
    },
  };
}
