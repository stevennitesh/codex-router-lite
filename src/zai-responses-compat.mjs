import { Transform } from "node:stream";
import { jsonIsUnambiguousForRewrite } from "./namespace-relay.mjs";
import { SseFrameBuffer, sseFrameFields, rewriteSseFrameData } from "./sse-framing.mjs";

const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const MAX_HELD_ITEMS = 4096;

const COMPATIBLE_ROUTES = new Set([
  "openrouter/glm-5.3-flash-streamlake",
  "openrouter/glm-5.3-flash-together",
]);

function rewrittenBlock(parsed, event) {
  const wire = rewriteSseFrameData(parsed, JSON.stringify(event));
  return { block: parsed.separator ? wire.slice(0, -parsed.separator.length) : wire,
    parsed: { ...parsed, event } };
}

function syntheticBlock(type, event, parsed) {
  const hasEventLine = parsed.eventName !== undefined;
  const lines = hasEventLine ? [`event: ${type}`] : [];
  const next = { type, ...event };
  lines.push(`data: ${JSON.stringify(next)}`);
  return { block: lines.join(parsed.newline), parsed: { event: next, done: false } };
}

function messageText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// A malformed Z.ai close can put its private reasoning part inside the
// assistant message item itself, rather than only in content_part.done. Keep
// visible output parts and replace the hidden part with the text observed from
// the stream. Never relay a reasoning_text/thinking part as message content.
function sanitizeMessageItem(item, fallbackText = "") {
  if (item?.type !== "message" || !Array.isArray(item.content)) return item;
  let changed = false;
  const content = [];
  for (const part of item.content) {
    if (!part || typeof part !== "object") {
      content.push(part);
      continue;
    }
    const hidden =
      part.type === "reasoning_text" ||
      part.type === "reasoning" ||
      part.type === "thinking" ||
      typeof part.reasoning === "string";
    if (hidden) {
      changed = true;
      continue;
    }
    content.push(part);
  }
  if (!changed) return item;
  if (!content.length) {
    content.push({ type: "output_text", text: fallbackText, annotations: [] });
  }
  return { ...item, content };
}

export class ZaiResponsesCompatTransform extends Transform {
  #frames;
  #heldOutputItems = new Map();
  #heldBytes = 0;
  #lastHeldBlock;
  #maxHeldBytes;
  #maxHeldItems;
  #maxMessageBytes;
  #committed = false;
  #disabled = false;
  #maxOutputIndex = -1;
  #message;
  #openOutputIndex;
  #pendingDrain = false;

  constructor({ maxFrameBytes = MAX_RETAINED_BYTES, maxHeldBytes = MAX_RETAINED_BYTES,
    maxHeldItems = MAX_HELD_ITEMS, maxMessageBytes = MAX_RETAINED_BYTES } = {}) {
    super();
    this.#frames = new SseFrameBuffer({ maxFrameBytes });
    this.#maxHeldBytes = maxHeldBytes;
    this.#maxHeldItems = maxHeldItems;
    this.#maxMessageBytes = maxMessageBytes;
  }

  _transform(chunk, _encoding, callback) {
    try {
      for (const frame of this.#frames.write(chunk)) this.#emitFrame(frame);
      // A split CRLF's LF belongs before any held item drained by this close.
      // Bare CR still emits the completed close immediately.
      if (chunk.length && chunk.at(-1) !== 13) this.#drainPending();
      callback();
    } catch (error) { callback(error); }
  }

  _flush(callback) {
    // An unterminated tail is preserved, without dispatching it or inferring
    // a close. Downstream completion guards decide whether EOF is success.
    this.#flushHeldOutputItems();
    if (this.#frames.pendingBytes) this.push(this.#frames.take());
    callback();
  }

  #emitFrame(frame) {
    if (frame.continuation) {
      if (this.#lastHeldBlock) {
        this.#assertHeldBytes(frame.bytes.length);
        this.#lastHeldBlock.block = Buffer.concat([this.#lastHeldBlock.block, frame.bytes]);
        this.#heldBytes += frame.bytes.length;
      } else this.push(frame.bytes);
      return;
    }
    this.#drainPending();
    if (this.#disabled) { this.#pushBlock(frame.bytes); return; }
    let parsed;
    try { parsed = sseFrameFields(frame.bytes, frame.atStreamStart); }
    catch { this.#unsafe(frame.bytes, "invalid UTF-8"); return; }
    const text = parsed.text;
    const separator = text.match(/(\r\n|\r|\n)(\r\n|\r|\n)$/u)?.[0] ?? "";
    const block = separator ? text.slice(0, -separator.length) : text;
    parsed.separator = separator;
    const pieces = this.#rewriteBlock(block, parsed);
    if (this.#disabled) { this.#pushBlock(frame.bytes); return; }
    if (pieces.length !== 1 || pieces[0].block !== block) this.#committed = true;
    if (pieces.length > 1 && frame.atStreamStart && text.startsWith("\uFEFF")) {
      for (const piece of pieces) piece.block = piece.block.replace(/^\uFEFF/u, "");
      pieces[0].block = "\uFEFF" + pieces[0].block;
    }
    for (const piece of pieces) this.#emitLifecycleBlock(piece, separator);
  }

  #unsafe(bytes, reason) {
    if (this.#committed) {
      throw new Error(`GLM response became unsafe after compatibility repair (${reason}).`);
    }
    this.#disabled = true;
    this.#flushHeldOutputItems();
    this.#message = undefined;
    if (bytes) this.#pushBlock(bytes);
  }

  #pushBlock(block) {
    this.#lastHeldBlock = undefined;
    this.push(typeof block === "string" ? Buffer.from(block) : block);
  }

  #emitLifecycleBlock(piece, separator) {
    const block = Buffer.from(`${piece.block}${separator}`);
    const event = piece.parsed.event;
    const type = event?.type;
    const terminal = ["response.completed", "response.done"].includes(type) ||
      piece.parsed.done;
    if (terminal) {
      this.#flushHeldOutputItems();
      this.#pushBlock(block);
      return;
    }

    const outputIndex = Number.isInteger(event?.output_index)
      ? event.output_index
      : undefined;
    if (outputIndex === undefined) {
      this.#pushBlock(block);
      return;
    }
    if (this.#openOutputIndex === undefined) {
      this.#pushBlock(block);
      if (type === "response.output_item.added") this.#openOutputIndex = outputIndex;
      return;
    }
    if (outputIndex === this.#openOutputIndex) {
      this.#pushBlock(block);
      if (type === "response.output_item.done") {
        this.#openOutputIndex = undefined;
        this.#pendingDrain = true;
      }
      return;
    }

    this.#assertHeldBytes(block.length);
    let group = this.#heldOutputItems.get(outputIndex);
    if (!group) {
      if (this.#heldOutputItems.size >= this.#maxHeldItems) {
        throw new Error(`GLM held output exceeds ${this.#maxHeldItems} items.`);
      }
      group = { outputIndex, blocks: [] };
      this.#heldOutputItems.set(outputIndex, group);
    }
    this.#lastHeldBlock = { block, type };
    group.blocks.push(this.#lastHeldBlock);
    this.#heldBytes += block.length;
  }

  #assertHeldBytes(bytes) {
    if (this.#heldBytes + bytes > this.#maxHeldBytes) {
      throw new Error(`GLM held output exceeds ${this.#maxHeldBytes} bytes.`);
    }
  }

  #drainPending() {
    if (!this.#pendingDrain) return;
    this.#pendingDrain = false;
    this.#drainHeldOutputItems();
  }

  #drainHeldOutputItems() {
    while (this.#openOutputIndex === undefined && this.#heldOutputItems.size) {
      const [index, group] = this.#heldOutputItems.entries().next().value;
      this.#heldOutputItems.delete(index);
      for (const { block, type } of group.blocks) {
        this.#heldBytes -= block.length;
        this.#pushBlock(block);
        if (type === "response.output_item.added") {
          this.#openOutputIndex = group.outputIndex;
        } else if (type === "response.output_item.done") {
          this.#openOutputIndex = undefined;
        }
      }
    }
  }

  #flushHeldOutputItems() {
    for (const group of this.#heldOutputItems.values()) {
      for (const { block } of group.blocks) this.#pushBlock(block);
    }
    this.#heldOutputItems.clear();
    this.#heldBytes = 0;
    this.#pendingDrain = false;
    this.#openOutputIndex = undefined;
  }

  #messageIndex(event) {
    if (this.#message) return this.#message.outputIndex;
    const reported = Number.isInteger(event?.output_index) ? event.output_index : 0;
    return this.#maxOutputIndex >= 0
      ? Math.max(this.#maxOutputIndex + 1, reported)
      : reported;
  }

  #retireMessage() {
    if (Number.isInteger(this.#message?.outputIndex)) {
      this.#maxOutputIndex = Math.max(this.#maxOutputIndex, this.#message.outputIndex);
    }
    this.#message = undefined;
  }

  #startMessage(event, parsed) {
    const id = String(event?.item_id || "");
    if (this.#message && id && this.#message.id !== id) this.#retireMessage();
    const outputIndex = this.#messageIndex(event);
    const contentIndex = Number.isInteger(event?.content_index) ? event.content_index : 0;
    this.#message = {
      id,
      outputIndex,
      contentIndex,
      text: "",
      contentStarted: true,
    };
    this.#maxOutputIndex = Math.max(this.#maxOutputIndex, outputIndex);
    const common = {
      output_index: outputIndex,
      ...(typeof event?.model === "string" ? { model: event.model } : {}),
    };
    return [
      syntheticBlock("response.output_item.added", {
        ...common,
        item: {
          id: this.#message.id,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }, parsed),
      syntheticBlock("response.content_part.added", {
        ...common,
        item_id: this.#message.id,
        content_index: contentIndex,
        part: { type: "output_text", text: "", annotations: [] },
      }, parsed),
    ];
  }

  #rewriteMessageEvent(event) {
    if (!this.#message) return event;
    if (event.output_index === this.#message.outputIndex) return event;
    return { ...event, output_index: this.#message.outputIndex };
  }

  #rewriteBlock(block, parsed) {
    const generic = !parsed.eventName || parsed.eventName === "message";
    parsed.done = parsed.hasData && parsed.data === "[DONE]";
    if (parsed.hasData && parsed.data && !parsed.done) {
      if (!jsonIsUnambiguousForRewrite(parsed.data)) {
        this.#unsafe(undefined, "ambiguous or malformed JSON");
      } else parsed.event = JSON.parse(parsed.data);
    }
    if (parsed.hasData && !generic && parsed.event?.type !== parsed.eventName) {
      this.#unsafe(undefined, "conflicting SSE event and JSON type");
    }
    // Keep the parsed event alongside its bytes through envelope repair and
    // lifecycle ordering, instead of parsing original and synthetic JSON twice.
    const original = parsed.event !== undefined && (parsed.dataCount > 1 || parsed.eventCount > 1)
      ? rewrittenBlock(parsed, parsed.event) : { block, parsed };
    if (this.#disabled || parsed.event === undefined) return [original];
    const event = parsed.event;
    const type = event?.type;
    if (type === "response.output_item.added") {
      if (Number.isInteger(event.output_index)) {
        this.#maxOutputIndex = Math.max(this.#maxOutputIndex, event.output_index);
      }
      if (event?.item?.type === "message") {
        const item = sanitizeMessageItem(event.item);
        this.#message = {
          id: String(item.id || ""),
          outputIndex: Number.isInteger(event.output_index) ? event.output_index : 0,
          contentIndex: 0,
          text: messageText(item),
          contentStarted: false,
        };
        this.#setMessageText(this.#message.text);
        if (item !== event.item) {
          return [rewrittenBlock(parsed, { ...event, item })];
        }
      }
      return [original];
    }

    if (type === "response.content_part.added" && event?.item_id) {
      const itemId = String(event.item_id);
      if (this.#message && this.#message.id !== itemId) this.#retireMessage();
      if (!this.#message) {
        // LiteLLM can omit only output_item.added. Adopt the existing content
        // part and inject the missing item envelope without duplicating this
        // part in the stream.
        const injected = this.#startMessage(event, parsed);
        if (event.part?.type === "output_text" && typeof event.part.text === "string") {
          this.#setMessageText(event.part.text);
        }
        const next = this.#rewriteMessageEvent(event);
        return [
          injected[0],
          next === event ? original : rewrittenBlock(parsed, next),
        ];
      }
      this.#message.contentStarted = true;
      const next = this.#rewriteMessageEvent(event);
      return [
        next === event ? original : rewrittenBlock(parsed, next),
      ];
    }

    if (type === "response.output_item.done" && event?.item?.type === "reasoning") {
      if (Number.isInteger(event.output_index)) {
        this.#maxOutputIndex = Math.max(this.#maxOutputIndex, event.output_index);
      }
      return [original];
    }

    if (type === "response.output_text.delta" || type === "response.output_text.done") {
      const itemId = String(event?.item_id || "");
      if (this.#message && itemId && this.#message.id !== itemId) this.#retireMessage();
      const injected = this.#message ? [] : this.#startMessage(event, parsed);
      let next = this.#rewriteMessageEvent(event);
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        this.#setMessageText(event.delta, true);
      }
      if (type === "response.output_text.done" && typeof event.text === "string") {
        this.#setMessageText(event.text);
      }
      return [...injected, next === event ? original : rewrittenBlock(parsed, next)];
    }

    if (type === "response.content_part.done" && event?.item_id) {
      const itemId = String(event.item_id);
      const injected = [];
      if (this.#message && this.#message.id !== itemId) this.#retireMessage();
      if (!this.#message) injected.push(...this.#startMessage(event, parsed));
      let next = this.#rewriteMessageEvent(event);
      const part = event.part;
      if (part?.type !== "output_text" || typeof part?.reasoning === "string") {
        next = {
          ...next,
          part: {
            type: "output_text",
            text: this.#message.text,
            annotations: Array.isArray(part?.annotations) ? part.annotations : [],
          },
        };
      }
      if (part?.type === "output_text" && typeof part.text === "string") {
        this.#setMessageText(part.text);
      }
      return [
        ...injected,
        next === event ? original : rewrittenBlock(parsed, next),
      ];
    }

    if (type === "response.output_item.done" && event?.item?.type === "message") {
      const itemId = String(event.item.id || "");
      const injected = [];
      if (this.#message && itemId && this.#message.id !== itemId) this.#retireMessage();
      if (!this.#message) {
        injected.push(...this.#startMessage({ ...event, item_id: itemId }, parsed));
      }
      const item = sanitizeMessageItem(event.item, this.#message.text);
      this.#setMessageText(messageText(item) || this.#message.text);
      const next = this.#rewriteMessageEvent(
        item === event.item ? event : { ...event, item },
      );
      return [
        ...injected,
        next === event ? original : rewrittenBlock(parsed, next),
      ];
    }

    return [original];
  }

  #setMessageText(text, append = false) {
    const bytes = (append ? this.#message.textBytes ?? Buffer.byteLength(this.#message.text) : 0)
      + Buffer.byteLength(text);
    if (bytes > this.#maxMessageBytes) {
      throw new Error(`GLM message text exceeds ${this.#maxMessageBytes} bytes.`);
    }
    this.#message.textBytes = bytes;
    this.#message.text = append ? this.#message.text + text : text;
  }
}

export function zaiResponsesCompatTransform(providerId, contentType = "", routeSlug = "") {
  if (
    String(providerId) !== "openrouter" ||
    !COMPATIBLE_ROUTES.has(routeSlug)
  ) return undefined;
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new ZaiResponsesCompatTransform();
}
