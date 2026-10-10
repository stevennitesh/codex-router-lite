import { SseLineScanner, sseFrameFields } from "./sse-framing.mjs";
import { jsonIsUnambiguousForRewrite } from "./namespace-relay.mjs";

const contexts = new WeakMap();
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const TERMINALS = new Set(["response.completed", "response.failed", "response.incomplete"]);
const ANNOUNCEMENTS = new Set(["response.created", "response.in_progress", "response.queued"]);

function identity(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value) <= 512 && value.isWellFormed() &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

export function markResponsesStream(response, { model } = {}) {
  const requestedModel = identity(model);
  if (!contexts.has(response)) {
    const write = response.write;
    response.write = function(chunk, encoding) {
      const accepting = !this.writableEnded && !this.destroyed;
      const result = Reflect.apply(write, this, arguments);
      if (accepting) contexts.get(this)?.observer?.accept(chunk, encoding);
      return result;
    };
  }
  contexts.set(response, { requestedModel, model: requestedModel, trusted: true, terminal: false });
}

// Observe bytes accepted by the destination's write, after holding/rewriting
// stages and their readable buffers. Those queued bytes survive pipeline
// teardown and precede a locally appended failure. No client chunks are held.
export function observeResponsesStream(response, contentType, { maxEventBytes = MAX_EVENT_BYTES } = {}) {
  const context = contexts.get(response);
  if (!context || !String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1 || maxEventBytes > MAX_EVENT_BYTES) {
    throw new RangeError("Responses failure parse budget must be between 1 byte and 4 MiB.");
  }
  if (!response.headersSent) {
    // A discarded attempt must not supply identity for an empty-result retry.
    Object.assign(context, { id: undefined, createdAt: undefined, model: context.requestedModel,
      modelAnnounced: false, nextSequence: undefined, trusted: true, terminal: false });
  } else if (context.observer) context.trusted = false;
  context.observer = new FailureMetadataObserver(context, maxEventBytes);
}

class FailureMetadataObserver {
  #context;
  #limit;
  #lines = new SseLineScanner();
  #buffer;
  #bytes = 0;
  #dropping = false;
  #lineHasContent = false;
  #atStreamStart = true;

  constructor(context, limit) {
    this.#context = context;
    this.#limit = limit;
  }

  accept(chunk, encoding) {
    if (this.#context.terminal) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
      for (const { content, ending, endLine } of this.#lines.scan(bytes)) {
        this.#append(content);
        this.#append(ending);
        if (content.length) this.#lineHasContent = true;
        if (!endLine) continue;
        const blank = !this.#lineHasContent;
        this.#lineHasContent = false;
        if (blank) this.#finishFrame();
        if (this.#context.terminal) break;
      }
    } catch { this.#context.trusted = false; }
  }

  #append(bytes) {
    if (this.#dropping || !bytes.length) return;
    const required = this.#bytes + bytes.length;
    if (required > this.#limit) {
      this.#context.trusted = false;
      this.#buffer = undefined;
      this.#bytes = 0;
      this.#dropping = true;
      return;
    }
    if (!this.#buffer || this.#buffer.length < required) {
      const buffer = Buffer.allocUnsafe(Math.min(this.#limit, Math.max(required, (this.#buffer?.length || 512) * 2)));
      this.#buffer?.copy(buffer, 0, 0, this.#bytes);
      this.#buffer = buffer;
    }
    bytes.copy(this.#buffer, this.#bytes);
    this.#bytes = required;
  }

  #finishFrame({ partial = false } = {}) {
    try {
      if (!this.#dropping && this.#bytes) {
        const fields = sseFrameFields(this.#buffer.subarray(0, this.#bytes), this.#atStreamStart);
        if (fields.hasData && fields.data !== "[DONE]") {
          if (!jsonIsUnambiguousForRewrite(fields.data)) {
            // A broken stream often ends mid-JSON; that fragment announced
            // nothing. Complete ambiguous JSON can contradict prior metadata.
            try { JSON.parse(fields.data); this.#context.trusted = false; }
            catch { if (!partial) this.#context.trusted = false; }
          } else {
            const payload = JSON.parse(fields.data);
            const generic = !fields.eventName || fields.eventName === "message";
            if (!generic && fields.eventName !== payload?.type) this.#context.trusted = false;
            this.#observe(payload);
          }
        }
      }
    } catch { this.#context.trusted = false; }
    this.#atStreamStart = false;
    this.#buffer = undefined;
    this.#bytes = 0;
    this.#dropping = false;
  }

  #observe(payload) {
    const context = this.#context;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      context.trusted = false;
      return;
    }
    const snapshot = payload.response;
    const type = payload.type;
    if (typeof type !== "string" || !type.startsWith("response.")) {
      if (["sequence_number", "response", "response_id"].some(key => Object.hasOwn(payload, key))) context.trusted = false;
      return;
    }
    // Codex consumes failure/incomplete even with a bad snapshot, but ignores
    // completion without a non-null response. Generic errors do not settle it.
    if (TERMINALS.has(type) && (type !== "response.completed" || snapshot != null)) context.terminal = true;
    if (Object.hasOwn(payload, "sequence_number")) {
      const sequence = payload.sequence_number;
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER ||
          (context.nextSequence !== undefined && sequence < context.nextSequence)) context.trusted = false;
      else context.nextSequence = sequence + 1;
    }
    const announces = ANNOUNCEMENTS.has(type);
    if (announces && (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !identity(snapshot.id))) context.trusted = false;
    const id = snapshot?.id ?? payload.response_id;
    if (id !== undefined) {
      const valid = identity(id);
      if (!valid || (context.id && context.id !== valid)) context.trusted = false;
      else if (announces) context.id = valid;
    }
    if (announces) {
      if (snapshot?.model !== undefined) {
        const model = identity(snapshot.model);
        if (!model || (context.modelAnnounced && context.model !== model)) context.trusted = false;
        else { context.model = model; context.modelAnnounced = true; }
      }
      if (snapshot?.created_at !== undefined) {
        const date = snapshot.created_at;
        if (!Number.isFinite(date) || date < 0 || date > Number.MAX_SAFE_INTEGER ||
            (context.createdAt !== undefined && context.createdAt !== date)) context.trusted = false;
        else context.createdAt = date;
      }
    }
  }

  finishForFailure() {
    const pending = this.#bytes > 0 || this.#dropping;
    // The writer's leading blank lines dispatch a valid unfinished SSE frame.
    // Account for it before choosing the next sequence or another terminal.
    this.#finishFrame({ partial: true });
    this.#lineHasContent = false;
    return pending;
  }
}

export function responsesStreamFailure(response, { code, message }) {
  const context = contexts.get(response);
  if (!context) return undefined;
  const pending = context.observer?.finishForFailure() === true;
  if (context.terminal) return { terminal: true, closePendingFrame: pending };
  context.terminal = true;
  if (!context.trusted || !context.id || !context.model || context.createdAt === undefined || context.nextSequence === undefined) return undefined;
  return { event: {
    type: "response.failed", sequence_number: context.nextSequence,
    code: String(code || "local_router_stream_failed").slice(0, 128).toWellFormed(),
    response: { id: context.id, object: "response", created_at: context.createdAt, model: context.model,
      status: "failed", error: { code: "server_error", message: String(message || "The local router lost the upstream response stream.").slice(0, 2048).toWellFormed() },
      output: [], parallel_tool_calls: false, tool_choice: "none", tools: [] },
  } };
}
