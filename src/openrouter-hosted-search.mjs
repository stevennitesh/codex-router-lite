import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const NATIVE_SEARCH_TYPES = new Set(["web_search", "web_search_preview"]);
const OPENROUTER_SEARCH_TYPE = "openrouter:web_search";
const MAX_JSON_BYTES = 32 * 1024 * 1024;

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
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #jsonChunks = [];
  #jsonBytes = 0;

  constructor(contentType = "") {
    super();
    this.#eventStream = String(contentType).toLowerCase().includes("text/event-stream");
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
    this.#buffer += this.#decoder.write(chunk);
    this.#consumeLines();
    callback();
  }

  _flush(callback) {
    if (!this.#eventStream) {
      const body = Buffer.concat(this.#jsonChunks);
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        this.push(body);
        callback();
        return;
      }
      const restored = restoreOpenRouterHostedSearchPayload(payload);
      this.push(restored === payload ? body : Buffer.from(JSON.stringify(restored), "utf8"));
      callback();
      return;
    }
    this.#buffer += this.#decoder.end();
    this.#consumeLines(true);
    callback();
  }

  #consumeLines(flush = false) {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.#buffer.slice(0, newline + 1);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.push(this.#restoreLine(line));
    }
    if (flush && this.#buffer) {
      this.push(this.#restoreLine(this.#buffer));
      this.#buffer = "";
    }
  }

  #restoreLine(line) {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const content = ending ? line.slice(0, -ending.length) : line;
    if (!content.startsWith("data:")) return line;
    const data = content.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return line;
    }
    const restored = restoreOpenRouterHostedSearchPayload(payload);
    return restored === payload ? line : `data: ${JSON.stringify(restored)}${ending}`;
  }
}
