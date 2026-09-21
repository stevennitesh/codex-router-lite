import { Transform } from "node:stream";

const LINE_FEED = 0x0a;
const MAX_SSE_PENDING_BYTES = 8 * 1024 * 1024;

// Z.ai reports authoritative prompt/cache usage on the same terminal chunk as
// finish_reason. LiteLLM 1.95/1.96 loses usage details on that choice-bearing
// shape, but preserves the standard OpenAI usage-only terminal chunk. Normalize
// the provider stream before it reaches LiteLLM and mirror cached_tokens into
// the compatibility field LiteLLM already understands. Never infer usage.
function cachedTokens(payload) {
  const value = payload?.usage?.prompt_tokens_details?.cached_tokens;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function usageObject(payload) {
  const usage = payload?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage) && Object.keys(usage).length
    ? usage
    : undefined;
}

function choiceBearingUsage(payload) {
  return Array.isArray(payload?.choices) && payload.choices.length > 0 && usageObject(payload);
}

export class ZaiCacheUsageCompatTransform extends Transform {
  #pending = Buffer.alloc(0);
  #released = false;

  constructor({ maxPendingBytes = MAX_SSE_PENDING_BYTES } = {}) {
    super();
    this.maxPendingBytes = maxPendingBytes;
  }

  _transform(chunk, _encoding, callback) {
    if (this.#released) {
      this.push(chunk);
      callback();
      return;
    }
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    this.#consumeLines();
    const splitCr = this.#pending.at(-1) === 0x0d;
    if (!this.#released && this.#pending.length > this.maxPendingBytes + (splitCr ? 1 : 0)) {
      this.#released = true;
      this.push(this.#pending);
      this.#pending = Buffer.alloc(0);
    }
    callback();
  }

  _flush(callback) {
    this.#consumeLines(true);
    callback();
  }

  #consumeLines(flush = false) {
    while (true) {
      const index = this.#pending.indexOf(LINE_FEED);
      if (index === -1) break;
      const contentBytes = index > 0 && this.#pending[index - 1] === 0x0d
        ? index - 1
        : index;
      if (contentBytes > this.maxPendingBytes) {
        this.#released = true;
        this.push(this.#pending);
        this.#pending = Buffer.alloc(0);
        return;
      }
      const line = this.#pending.subarray(0, index + 1);
      this.#pending = this.#pending.subarray(index + 1);
      this.push(this.#rewriteLine(line));
    }
    if (flush && this.#pending.length) {
      if (this.#pending.length > this.maxPendingBytes) {
        this.#released = true;
        this.push(this.#pending);
        this.#pending = Buffer.alloc(0);
        return;
      }
      this.push(this.#rewriteLine(this.#pending));
      this.#pending = Buffer.alloc(0);
    }
  }

  #rewriteLine(line) {
    const text = line.toString("utf8");
    const terminator = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
    const content = terminator ? text.slice(0, -terminator.length) : text;
    if (!content.startsWith("data:")) return line;
    const data = content.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return line;
    }

    const usage = usageObject(payload);
    if (usage === undefined) return line;
    const cached = cachedTokens(payload);
    let changed = false;
    if (cached !== undefined && usage.prompt_cache_hit_tokens === undefined) {
      usage.prompt_cache_hit_tokens = cached;
      changed = true;
    }

    if (!choiceBearingUsage(payload)) {
      return changed ? Buffer.from(`data: ${JSON.stringify(payload)}${terminator}`, "utf8") : line;
    }

    const terminal = { ...payload };
    delete terminal.usage;
    const usageOnly = { ...payload, choices: [], usage };
    const separator = terminator || "\n";
    return Buffer.from(
      `data: ${JSON.stringify(terminal)}${separator}${separator}data: ${JSON.stringify(usageOnly)}${terminator}`,
      "utf8",
    );
  }
}

// OpenRouter may place usage on the finish_reason chunk with non-empty choices,
// followed by [DONE]. LiteLLM discards that shape, so normalize it before the
// stream reaches the gateway.
const CHOICE_BEARING_USAGE_PROVIDERS = ["openrouter"];

export function zaiCacheUsageTransform(providerId, contentType = "") {
  if (!CHOICE_BEARING_USAGE_PROVIDERS.includes(String(providerId))) return undefined;
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new ZaiCacheUsageCompatTransform();
}
