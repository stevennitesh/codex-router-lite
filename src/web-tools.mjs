import { createHash, createHmac, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { nativeToolWireNames } from "./namespace-relay.mjs";
import { webMcpDiscoveryDefaultLimit, webMcpDiscoveryMaxLimit, webMcpQueryLimit } from "./web-mcp-contract.mjs";
import { terminalWebToolSearchOutput, validWebToolSearchArguments, webToolIdentity, webToolKinds, webToolSearchParameters } from "./web-tool-contract.mjs";

const hostedTools = new Set(["web_search", "web_search_preview", "image_generation"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function failure(message, code = "invalid_web_tool_call", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function declarations(tools) {
  if (!Array.isArray(tools)) throw failure("Web tool declarations must be an array.");
  const entries = new Map();
  const visit = (tool, namespace) => {
    if (!record(tool)) throw failure("Invalid Web tool declaration.");
    if (hostedTools.has(tool.type)) return;
    if (tool.type === "namespace") {
      if (namespace !== undefined || typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) {
        throw failure("Invalid Web tool namespace.");
      }
      for (const child of tool.tools) visit(child, tool.name);
      return;
    }
    if (!Object.hasOwn(webToolKinds, tool.type)) {
      throw failure(`Unsupported client tool declaration: ${tool.type}.`);
    }
    if (tool.type === "tool_search" && (namespace !== undefined || tool.execution !== "client")) {
      throw failure("Web tool search must be a declared client-executed tool.");
    }
    const name = tool.type === "tool_search" ? "tool_search" : tool.name;
    if (typeof name !== "string" || !name) throw failure("Web tool declaration is missing its name.");
    const entry = { name, kind: tool.type, ...(namespace === undefined ? {} : { namespace }),
      description: tool.description ?? "",
      ...(tool.type === "custom" ? { format: structuredClone(tool.format) }
        : { parameters: structuredClone(tool.type === "tool_search" ? webToolSearchParameters
          : tool.parameters ?? tool.inputSchema ?? { type: "object", properties: {} }) }) };
    if (typeof entry.description !== "string" || (entry.parameters !== undefined && !record(entry.parameters))) {
      throw failure(`Invalid declaration for Web tool ${name}.`);
    }
    const key = webToolIdentity(entry);
    if (entries.has(key)) throw failure(`Duplicate Web tool declaration: ${name}.`);
    entries.set(key, entry);
  };
  for (const tool of tools) visit(tool);
  return entries;
}

function registry(tools, names) {
  const native = declarations(tools);
  const result = new Map();
  for (const { wireName: suggested, ...identity } of nativeToolWireNames(tools)) {
    const entry = native.get(webToolIdentity(identity));
    if (!entry) throw failure("Web tool declaration could not retain its native identity.");
    const key = webToolIdentity(entry);
    let wireName = names.byIdentity.get(key);
    if (!wireName) {
      wireName = suggested;
      // A removed declaration's wire name remains reserved for this generation.
      // A delayed model call must never address a different newly discovered tool.
      for (let attempt = 0; names.byWire.has(wireName); attempt += 1) {
        wireName = `${suggested}_${createHash("sha256").update(`${key}:${attempt}`).digest("hex").slice(0, 12)}`;
      }
      names.byIdentity.set(key, wireName);
      names.byWire.set(wireName, key);
    }
    result.set(wireName, { wireName, ...entry });
  }
  return result;
}

function choicePolicy(choice, tools) {
  if (choice === undefined || choice === "auto") return { allowed: new Set(tools.keys()), required: false };
  if (choice === "none") return { allowed: new Set(), required: false };
  if (choice === "required") {
    if (!tools.size) throw failure("Web tool_choice required has no declared client tools.", "unsupported_tool_choice");
    return { allowed: new Set(tools.keys()), required: true };
  }
  const resolve = reference => {
    if (!record(reference)) throw failure("Invalid Web tool choice.", "unsupported_tool_choice");
    const matches = [...tools.values()].filter(tool => {
      if (tool.kind !== reference.type) return false;
      if (tool.kind === "tool_search") return reference.name === undefined || reference.name === tool.name;
      if (reference.namespace !== undefined) return reference.namespace === tool.namespace && reference.name === tool.name;
      return reference.name === tool.wireName || (reference.name === tool.name && tool.namespace === undefined);
    });
    // Native Codex permits the default functions namespace to be omitted.
    if (matches.length === 0 && reference.namespace === undefined) {
      matches.push(...[...tools.values()].filter(tool => tool.kind === reference.type
        && tool.namespace === "functions" && tool.name === reference.name));
    }
    if (matches.length !== 1) throw failure("Web tool_choice does not name one exact declared tool.", "unsupported_tool_choice");
    return matches[0].wireName;
  };
  if (choice?.type === "allowed_tools") {
    if (!["auto", "required"].includes(choice.mode) || !Array.isArray(choice.tools) || !choice.tools.length) {
      throw failure("Invalid Web allowed_tools choice.", "unsupported_tool_choice");
    }
    return { allowed: new Set(choice.tools.map(resolve)), required: choice.mode === "required" };
  }
  return { allowed: new Set([resolve(choice)]), required: true };
}

function discoveryVersion(tools, policy) {
  return createHash("sha256").update(JSON.stringify({ tools: [...tools.values()],
    allowed: [...policy.allowed].sort(), required: policy.required })).digest("hex");
}

function nativeCall(tool, payload) {
  const representation = webToolKinds[tool.kind];
  const callId = `call_${randomUUID().replaceAll("-", "")}`;
  const base = { id: `${representation.idPrefix}_${randomUUID().replaceAll("-", "")}`,
    type: representation.callType, call_id: callId, status: "completed" };
  if (tool.kind === "custom") {
    if (typeof payload.input !== "string" || payload.arguments !== undefined) {
      throw failure(`Custom Web tool ${tool.wireName} requires raw input only.`);
    }
    return { ...base, name: tool.name, ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }), input: payload.input };
  }
  if (payload.input !== undefined || (payload.arguments !== undefined && !record(payload.arguments))) {
    throw failure(`Web tool ${tool.wireName} requires structured arguments only.`);
  }
  const args = payload.arguments ?? {};
  // A native function receives JSON text; round-trip here before enqueueing so
  // caller mutation cannot change a call already handed to Codex.
  let text;
  try { text = JSON.stringify(args); }
  catch { throw failure("Web tool arguments are not JSON serializable."); }
  const serialized = JSON.parse(text);
  if (!record(serialized)) throw failure("Web tool arguments must serialize to an object.");
  if (tool.kind === "tool_search") {
    if (!validWebToolSearchArguments(args) || !validWebToolSearchArguments(serialized)) {
      throw failure("Native Web tool search requires a nonempty query and an optional positive safe-integer limit, with no other arguments.");
    }
    return { ...base, execution: "client", arguments: serialized };
  }
  return { ...base, name: tool.name, ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }), arguments: text };
}

function contentBlock(block) {
  if (typeof block === "string") return { type: "text", text: block };
  if (!record(block)) throw failure("Invalid native Web tool content.");
  if (["text", "image", "audio", "resource", "resource_link"].includes(block.type)) return structuredClone(block);
  if (block.type === "input_text") return { type: "text", text: block.text };
  if (block.type === "input_image") {
    const url = block.image_url;
    const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(url ?? "");
    if (data) return { type: "image", mimeType: data[1], data: data[2] };
    // Preserve URL-bearing content without fetching it or inventing image bytes.
    if (typeof url === "string") return { type: "resource_link", uri: url, name: "Native tool image", mimeType: "image/*" };
  }
  return { type: "text", text: JSON.stringify(block) };
}

function mcpResult(output) {
  let value = output.type === "tool_search_output" ? output : output.output;
  if (value === undefined) throw failure("Native Web tool result is missing its output.");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (record(parsed)) value = parsed;
    } catch { /* Ordinary native text is not a JSON envelope. */ }
  }
  const envelope = record(value) && (Array.isArray(value.content) || record(value.structuredContent)
    && Object.keys(value).every(key => ["structuredContent", "isError", "_meta"].includes(key))) ? value : undefined;
  const content = envelope ? (envelope.content ?? []).map(contentBlock)
    : Array.isArray(value) ? value.map(contentBlock)
      : [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
  return { content,
    ...(envelope?.structuredContent === undefined ? {} : { structuredContent: structuredClone(envelope.structuredContent) }),
    ...(output.isError === true || value?.isError === true
      || output.status === "failed" ? { isError: true } : {}),
    ...(envelope?._meta === undefined ? {} : { _meta: structuredClone(envelope._meta) }) };
}

/**
 * Relay only: pending MCP calls become native Responses items, then resolve
 * from the next native Codex round. This module has no tool executor.
 */
export function createWebToolBroker({ invocationTimeoutMs = 90_000 } = {}) {
  if (!Number.isSafeInteger(invocationTimeoutMs) || invocationTimeoutMs <= 0) throw new TypeError("Invalid Web tool invocation timeout.");
  const turns = new Map(), owners = new Map(), closed = new Map();
  const active = token => {
    const turn = turns.get(token);
    if (!turn) throw failure("Web tool turn is invalid or already closed.", "web_tool_turn_closed", 409);
    return turn;
  };
  const notify = (turn, retired = false) => {
    for (const waiter of turn.waiters) {
      if (retired || !waiter.actionableOnly || turn.actionableRevision > waiter.previous) {
        waiter.resolve({ revision: turn.revision, closed: retired });
      }
    }
  };
  const change = (turn, actionable = true) => {
    turn.revision += 1;
    if (actionable) turn.actionableRevision = turn.revision;
    notify(turn);
  };
  const observed = token => {
    const turn = turns.get(token) ?? closed.get(token);
    if (!turn) throw failure("Web tool turn is invalid or already closed.", "web_tool_turn_closed", 409);
    return turn;
  };
  const revision = token => observed(token).revision;
  const waitForChange = (token, previous, { signal, timeoutMs = 25_000, actionableOnly = false } = {}) => {
    if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000
      || typeof actionableOnly !== "boolean") {
      throw failure("Invalid Web tool observation.");
    }
    const turn = observed(token);
    if (previous > turn.revision) throw failure("Invalid Web tool observation revision.");
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("Web tool observation cancelled.", "AbortError"));
    if (turns.get(token) !== turn || (actionableOnly ? turn.actionableRevision : turn.revision) > previous) {
      return Promise.resolve({ revision: turn.revision, closed: turns.get(token) !== turn });
    }
    // Comparing and subscribing happen in one synchronous turn. A revision
    // change between the caller's read and this subscription cannot be lost.
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); turn.waiters.delete(waiter); };
      const waiter = { previous, actionableOnly, resolve: value => { cleanup(); resolve(value); } };
      const abort = () => {
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("Web tool observation cancelled.", "AbortError"));
      };
      const timer = setTimeout(() => waiter.resolve({ revision: actionableOnly ? previous : turn.revision, closed: false }), timeoutMs);
      turn.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const beginActivity = token => {
    const turn = active(token);
    const firstAcceptance = !turn.hasClientActivity;
    turn.hasClientActivity = true;
    turn.activity += 1;
    change(turn, firstAcceptance);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A cancelled request may settle after its turn was retired. Its lease
      // cannot mutate a replacement turn or make the old capability live again.
      if (turns.get(token) !== turn) return;
      turn.activity -= 1;
      change(turn, false);
    };
  };
  const rememberClosed = (token, turn, state) => {
    closed.set(token, { state, revision: turn.revision, hasClientActivity: turn.hasClientActivity });
    if (closed.size > 64) closed.delete(closed.keys().next().value);
  };
  const terminate = (token, state, reason) => {
    const turn = turns.get(token);
    if (!turn) return false;
    turns.delete(token);
    owners.delete(turn.owner);
    rememberClosed(token, turn, state);
    notify(turn, true);
    for (const pending of turn.calls.values()) {
      pending.cleanup();
      pending.reject(reason);
    }
    return true;
  };
  const takeCalls = token => {
    const turn = active(token);
    const delivered = [...turn.calls.values()].filter(call => call.delivered);
    const batch = delivered.length ? delivered : [...turn.calls.values()];
    for (const call of batch) {
      if (!call.delivered) change(turn);
      call.delivered = true;
    }
    return batch.map(call => structuredClone(call.item));
  };
  const list = (token, { query, names, limit = webMcpDiscoveryDefaultLimit, cursor } = {}) => {
    const turn = active(token);
    if (query !== undefined && (typeof query !== "string" || !query.trim() || query.length > webMcpQueryLimit)) {
      throw failure(`Web tool discovery query must be a nonempty string of at most ${webMcpQueryLimit} characters.`);
    }
    if (names !== undefined && (query !== undefined || !Array.isArray(names) || !names.length || names.length > webMcpDiscoveryMaxLimit
      || names.some(name => typeof name !== "string" || !name.trim() || name.length > webMcpQueryLimit))) {
      throw failure(`Web tool discovery names must contain 1 through ${webMcpDiscoveryMaxLimit} exact identities and cannot be combined with query.`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > webMcpDiscoveryMaxLimit) {
      throw failure(`Web tool discovery limit must be an integer from 1 through ${webMcpDiscoveryMaxLimit}.`);
    }
    const needle = query?.trim().toLowerCase();
    const exactNames = names === undefined ? undefined : new Set(names.map(name => name.trim().toLowerCase()));
    const selection = JSON.stringify(exactNames === undefined ? ["query", needle ?? null] : ["names", [...exactNames].sort()]);
    const cursorFor = offset => `${offset}.${createHmac("sha256", turn.cursorKey)
      .update(JSON.stringify([turn.discoveryVersion, turn.discoveryGeneration, selection, offset])).digest("base64url")}`;
    let offset = 0;
    if (cursor !== undefined) {
      const parts = typeof cursor === "string" && /^([1-9][0-9]{0,15})\.[A-Za-z0-9_-]{43}$/u.exec(cursor);
      offset = parts ? Number(parts[1]) : NaN;
      if (!Number.isSafeInteger(offset) || cursor !== cursorFor(offset)) {
        throw failure("Web tool discovery cursor is invalid for this active turn, selection, or catalog.", "invalid_web_tool_cursor", 409);
      }
    }
    const matches = [];
    const wireNames = new Set([...turn.tools.keys()].map(name => name.toLowerCase()));
    for (const tool of turn.tools.values()) {
      if (!turn.policy.allowed.has(tool.wireName)) continue;
      let rank = 0;
      const wireName = tool.wireName.toLowerCase();
      const nativeName = (tool.namespace === undefined ? tool.name : `${tool.namespace}.${tool.name}`).toLowerCase();
      // An exact wire identity takes precedence over a native alias that was
      // reassigned a collision-safe wire name. Authorization still filters it.
      const identities = [wireName, ...(wireNames.has(nativeName) ? [] : [nativeName])];
      if (exactNames !== undefined && !identities.some(name => exactNames.has(name))) continue;
      if (needle !== undefined && wireNames.has(needle) && wireName !== needle) continue;
      if (needle !== undefined) {
        const searchable = [...identities, tool.name.toLowerCase(), ...(tool.namespace === undefined ? [] : [tool.namespace.toLowerCase()])];
        rank = searchable.some(value => value === needle) ? 0
          : searchable.some(value => value.startsWith(needle)) ? 1
            : searchable.some(value => value.includes(needle)) ? 2
              : tool.description.toLowerCase().includes(needle) ? 3 : -1;
        if (rank < 0) continue;
      }
      matches.push({ tool, rank });
    }
    // Exact identities exclude the fuzzy tail. Stable sorting retains current
    // declaration order within each rank; only a bounded page is cloned.
    const selected = needle !== undefined && matches.some(match => match.rank === 0)
      ? matches.filter(match => match.rank === 0) : matches;
    if (needle !== undefined) selected.sort((one, two) => one.rank - two.rank);
    if (offset && offset >= selected.length) {
      throw failure("Web tool discovery cursor is invalid for this active turn, selection, or catalog.", "invalid_web_tool_cursor", 409);
    }
    const end = Math.min(offset + limit, selected.length);
    return { tools: selected.slice(offset, end).map(({ tool }) => structuredClone(tool)), total: selected.length,
      ...(end < selected.length ? { nextCursor: cursorFor(end) } : {}) };
  };
  const update = (token, { tools, toolChoice = "auto" }) => {
    const turn = active(token);
    // Compare with our accepted snapshot, never the caller's mutable array.
    // Unchanged schemas keep their exact registry and reserved wire identities.
    const unchanged = isDeepStrictEqual(tools, turn.declarations);
    const nextNames = unchanged ? turn.names : { byIdentity: new Map(turn.names.byIdentity), byWire: new Map(turn.names.byWire) };
    const next = unchanged ? turn.tools : registry(tools, nextNames);
    const policy = choicePolicy(toolChoice, next);
    const accepted = unchanged ? turn.declarations : structuredClone(tools);
    let changedCatalog = false;
    if (!unchanged || !isDeepStrictEqual(policy, turn.policy)) {
      const nextVersion = discoveryVersion(next, policy);
      changedCatalog = nextVersion !== turn.discoveryVersion;
      if (changedCatalog) turn.discoveryGeneration += 1;
      turn.discoveryVersion = nextVersion;
    }
    turn.names = nextNames;
    turn.tools = next;
    turn.declarations = accepted;
    turn.policy = policy;
    // Emitted calls retain their original native identity until their real
    // result arrives. Queued work must still be authorized by the newest request.
    let revoked = false;
    for (const [callId, pending] of turn.calls) {
      if (pending.delivered) continue;
      const current = next.get(pending.tool.wireName);
      if (current && policy.allowed.has(current.wireName) && isDeepStrictEqual(current, pending.tool)) continue;
      turn.calls.delete(callId);
      turn.callsMade -= 1;
      pending.cleanup();
      pending.reject(failure("Queued Web tool call is no longer declared and allowed by the current native request.", "web_tool_policy_changed", 409));
      revoked = true;
    }
    if (changedCatalog || revoked) change(turn);
  };
  return {
    register({ threadId, turnId, tools = [], toolChoice = "auto" }) {
      if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) {
        throw failure("Web tools require the exact native thread and turn identity.");
      }
      const owner = JSON.stringify([threadId, turnId]);
      if (owners.has(owner)) throw failure("Web tool turn already has an active generation.", "web_tool_turn_active", 409);
      const names = { byIdentity: new Map(), byWire: new Map() };
      const definitions = registry(tools, names);
      const policy = choicePolicy(toolChoice, definitions);
      const token = `web_turn_${randomUUID().replaceAll("-", "")}`;
      turns.set(token, { owner, names, tools: definitions, declarations: structuredClone(tools), policy,
        discoveryVersion: discoveryVersion(definitions, policy), discoveryGeneration: 0, cursorKey: randomUUID(),
        calls: new Map(), callsMade: 0, revision: 0, actionableRevision: 0, activity: 0, hasClientActivity: false, waiters: new Set() });
      owners.set(owner, token);
      return { token };
    },
    list, update, takeCalls, beginActivity, revision, waitForChange,
    hasPendingCalls: token => active(token).calls.size > 0,
    isActive: token => turns.has(token),
    hasClientActivity: token => observed(token).hasClientActivity,
    async invoke(token, payload, { signal } = {}) {
      const release = beginActivity(token);
      try {
        const turn = active(token);
        if (!record(payload)) throw failure("Invalid Web tool invocation.");
        const tool = turn.tools.get(payload.wireName);
        if (!tool || !turn.policy.allowed.has(payload.wireName)) throw failure("Web tool is not declared and allowed in this turn.");
        if (signal?.aborted) {
          const error = signal.reason instanceof Error ? signal.reason : new DOMException("Web tool invocation cancelled.", "AbortError");
          terminate(token, "cancelled", error);
          throw error;
        }
        const item = nativeCall(tool, payload);
        return await new Promise((resolve, reject) => {
          const abort = () => terminate(token, "cancelled", signal.reason instanceof Error ? signal.reason : new DOMException("Web tool invocation cancelled.", "AbortError"));
          const timer = setTimeout(() => terminate(token, "cancelled", failure("Native Codex tool did not return before the MCP deadline; execution or approval may already have occurred. Do not retry this turn.", "web_tool_timeout", 504)), invocationTimeoutMs);
          const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
          turn.calls.set(item.call_id, { item, tool, kind: tool.kind, delivered: false, resolve, reject, cleanup });
          turn.callsMade += 1;
          change(turn);
          signal?.addEventListener("abort", abort, { once: true });
        });
      } finally {
        release();
      }
    },
    complete(token, outputs) {
      const turn = active(token);
      if (!Array.isArray(outputs)) throw failure("Native Web tool outputs must be an array.");
      const delivered = [...turn.calls.values()].filter(call => call.delivered);
      if (outputs.length !== delivered.length) throw failure("Native Web tool results must complete the whole delivered batch.");
      const seen = new Set();
      const completions = outputs.map(output => {
        if (!record(output) || typeof output.call_id !== "string" || seen.has(output.call_id)) {
          throw failure("Duplicate or invalid native Web tool result.");
        }
        seen.add(output.call_id);
        const pending = turn.calls.get(output.call_id);
        if (!pending?.delivered || output.type !== webToolKinds[pending.kind].outputType) throw failure("Native Web tool result does not match a delivered call.");
        if (pending.kind === "tool_search" && !terminalWebToolSearchOutput(output, pending.item.call_id)) {
          throw failure("Native Web tool search result is incomplete or malformed.");
        }
        if (pending.kind !== "tool_search" && !Object.hasOwn(output, "output")) throw failure("Native Web tool result is missing its output.");
        return { pending, output, result: mcpResult(output) };
      });
      // Validate the complete batch before resolving any MCP caller.
      for (const { pending, output, result } of completions) {
        turn.calls.delete(output.call_id);
        change(turn);
        pending.cleanup();
        pending.resolve(result);
      }
    },
    beginCompletion(token) {
      const turn = turns.get(token);
      return turn && !turn.calls.size && !turn.activity ? turn.revision : undefined;
    },
    finish(token, revision) {
      const retired = closed.get(token);
      if (retired?.state === "finished" && retired.revision === revision) return true;
      const turn = turns.get(token);
      if (!turn || revision === undefined || turn.revision !== revision || turn.calls.size || turn.activity
        || (turn.policy.required && !turn.callsMade)) return false;
      return terminate(token, "finished");
    },
    cancel(token, reason = new DOMException("Web tool turn cancelled.", "AbortError")) {
      return terminate(token, "cancelled", reason instanceof Error ? reason : new Error(String(reason)));
    },
  };
}
