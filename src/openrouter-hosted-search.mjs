import { Transform } from "node:stream";
import { isUtf8 } from "node:buffer";
import { jsonIsUnambiguousForRewrite } from "./namespace-relay.mjs";
import { SseFrameBuffer, sseFrameFields, rewriteSseFrameData } from "./sse-framing.mjs";

const NATIVE_SEARCH_TYPES = new Set(["web_search", "web_search_preview"]);
const OPENROUTER_SEARCH_TYPE = "openrouter:web_search";
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_SSE_PENDING_BYTES = 8 * 1024 * 1024;

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mapSearchChoice(choice) {
  if (!isObject(choice)) return choice;
  if (NATIVE_SEARCH_TYPES.has(choice.type)) {
    return { ...choice, type: OPENROUTER_SEARCH_TYPE };
  }
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    const tools = choice.tools.map(mapSearchChoice);
    return tools.some((tool, index) => tool !== choice.tools[index])
      ? { ...choice, tools }
      : choice;
  }
  return choice;
}

function searchParameters(tool, payload, route) {
  const parameters = { ...route.searchTool.parameters };
  const contextSize = tool.search_context_size ?? payload.web_search_options?.search_context_size;
  if (["low", "medium", "high"].includes(contextSize)) {
    parameters.search_context_size = contextSize;
  }
  const userLocation = payload.web_search_options?.user_location;
  if (isObject(userLocation)) parameters.user_location = userLocation;
  return parameters;
}

function mapSearchTool(tool, payload, route) {
  if (!NATIVE_SEARCH_TYPES.has(tool?.type)) return tool;
  return {
    type: OPENROUTER_SEARCH_TYPE,
    parameters: searchParameters(tool, payload, route),
  };
}

function mapSearchHistoryItem(item) {
  return item?.type === "web_search_call"
    ? { ...item, type: OPENROUTER_SEARCH_TYPE }
    : item;
}

function stripNativeSearchIncludes(include) {
  if (!Array.isArray(include)) return include;
  return include.filter(
    (entry) => typeof entry !== "string" || !entry.startsWith("web_search_call."),
  );
}

export function prepareOpenRouterHostedSearchRequest(payload, route) {
  if (route?.searchTool?.mode !== "hosted") return payload;
  const tools = Array.isArray(payload.tools)
    ? payload.tools.map((tool) => mapSearchTool(tool, payload, route))
    : payload.tools;
  const input = Array.isArray(payload.input)
    ? payload.input.map(mapSearchHistoryItem)
    : payload.input;
  const include = stripNativeSearchIncludes(payload.include);
  const configuredLimit = route.searchTool.maxToolCalls;
  const callerLimit = Number.isInteger(payload.max_tool_calls) && payload.max_tool_calls >= 0
    ? payload.max_tool_calls
    : undefined;
  const maxToolCalls = callerLimit === undefined
    ? configuredLimit
    : Math.min(callerLimit, configuredLimit);
  const next = {
    ...payload,
    tools,
    input,
    tool_choice: mapSearchChoice(payload.tool_choice),
    max_tool_calls: maxToolCalls,
  };
  delete next.web_search_options;
  if (Array.isArray(include)) {
    if (include.length) next.include = include;
    else delete next.include;
  }
  return next;
}

function mapResponseItem(item) {
  return item?.type === OPENROUTER_SEARCH_TYPE
    ? { ...item, type: "web_search_call" }
    : item;
}

export function restoreOpenRouterHostedSearchPayload(payload) {
  if (!isObject(payload)) return payload;
  let changed = false;
  let next = payload;
  if (payload.item) {
    const item = mapResponseItem(payload.item);
    if (item !== payload.item) {
      next = { ...next, item };
      changed = true;
    }
  }
  if (Array.isArray(payload.output)) {
    const output = payload.output.map(mapResponseItem);
    if (output.some((item, index) => item !== payload.output[index])) {
      next = { ...next, output };
      changed = true;
    }
  }
  if (isObject(payload.response) && Array.isArray(payload.response.output)) {
    const output = payload.response.output.map(mapResponseItem);
    if (output.some((item, index) => item !== payload.response.output[index])) {
      next = { ...next, response: { ...payload.response, output } };
      changed = true;
    }
  }
  return changed ? next : payload;
}

export class OpenRouterHostedSearchTransform extends Transform {
  #eventStream;
  #frames;
  #committed = false;
  #disabled = false;
  #jsonChunks = [];
  #jsonBytes = 0;

  constructor(contentType = "", { maxPendingBytes = MAX_SSE_PENDING_BYTES,
    maxFrameBytes = MAX_SSE_PENDING_BYTES } = {}) {
    super();
    this.#eventStream = String(contentType).toLowerCase().includes("text/event-stream");
    this.maxPendingBytes = maxPendingBytes;
    this.#frames = new SseFrameBuffer({ maxLineBytes: maxPendingBytes, maxFrameBytes });
  }

  _transform(chunk, _encoding, callback) {
    if (!this.#eventStream) {
      this.#jsonBytes += chunk.length;
      if (this.#jsonBytes > MAX_JSON_BYTES) {
        callback(new Error("OpenRouter hosted-search response exceeded the Router JSON limit."));
        return;
      }
      this.#jsonChunks.push(chunk);
      callback();
      return;
    }
    try {
      for (const frame of this.#frames.write(chunk)) {
        this.push(frame.continuation ? frame.bytes : this.#restoreFrame(frame));
      }
      callback();
    } catch (error) {
      callback(this.#limitError(error));
    }
  }

  _flush(callback) {
    if (!this.#eventStream) {
      const body = Buffer.concat(this.#jsonChunks);
      const text = isUtf8(body) ? body.toString("utf8") : "";
      if (!text || !jsonIsUnambiguousForRewrite(text)) {
        this.push(body);
        callback();
        return;
      }
      const payload = JSON.parse(text);
      const restored = restoreOpenRouterHostedSearchPayload(payload);
      this.push(restored === payload ? body : Buffer.from(JSON.stringify(restored), "utf8"));
      callback();
      return;
    }
    try {
      // EOF does not dispatch an unfinished SSE event. Preserve its bytes;
      // completion guards own whether the response actually completed.
      if (this.#frames.pendingBytes) this.push(this.#frames.take());
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #limitError(error) {
    if (error.code === "SSE_LINE_LIMIT" || error.code === "SSE_FRAME_LIMIT") {
      error.message = `OpenRouter hosted-search ${error.message}`;
    }
    return error;
  }

  #unsafe(frame, reason) {
    if (this.#committed) {
      throw new Error(`OpenRouter hosted-search response became unsafe after restoration (${reason}).`);
    }
    this.#disabled = true;
    return frame.bytes;
  }

  #restoreFrame(frame) {
    if (this.#disabled) return frame.bytes;
    let fields;
    try {
      fields = sseFrameFields(frame.bytes, frame.atStreamStart);
    } catch {
      return this.#unsafe(frame, "invalid UTF-8");
    }
    if (!fields.hasData) return frame.bytes;
    const generic = !fields.eventName || fields.eventName === "message";
    if (!fields.data || fields.data === "[DONE]") {
      return generic ? frame.bytes : this.#unsafe(frame, "conflicting SSE event");
    }
    if (!jsonIsUnambiguousForRewrite(fields.data)) {
      return this.#unsafe(frame, "ambiguous or malformed JSON");
    }
    const payload = JSON.parse(fields.data);
    if (!generic && fields.eventName !== payload?.type) {
      return this.#unsafe(frame, "conflicting SSE event and JSON type");
    }
    const restored = restoreOpenRouterHostedSearchPayload(payload);
    if (restored === payload && fields.dataCount <= 1 && fields.eventCount <= 1) return frame.bytes;
    this.#committed = true;
    // Canonical fields give downstream namespace/phase guards the same safe
    // event we inspected, including ordinary calls beside hosted search.
    return rewriteSseFrameData(fields, JSON.stringify(restored));
  }
}
