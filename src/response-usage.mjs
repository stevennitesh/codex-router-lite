import { Transform } from "node:stream";
import { isUtf8 } from "node:buffer";

import { HeaderlessSseDetector } from "./sse-prefix.mjs";
import { SseFrameBuffer, SseLineScanner, sseFrameFields, rewriteSseFrameData } from "./sse-framing.mjs";
import { jsonIsUnambiguousForRewrite } from "./namespace-relay.mjs";

const MAX_JSON_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_SSE_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVED_OUTPUT_ITEMS = 256;

// Bytes of *model-visible* request body per prompt token.
//
// The familiar rule is four characters per token, which is roughly where plain
// English lands. Source code and tool output -- what a Codex session is mostly
// made of -- tokenize denser, near 3.3, and JSON serialization adds only about
// 4% on top of the text it carries (measured on a request built from this
// repository's own files: 369,460 body bytes over 354,429 model-visible
// characters). Taking the dense figure as the divisor assumes the whole
// conversation tokenizes like code, which is the assumption that errs high on
// everything else.
//
// The direction is arithmetic, not taste. Compaction fires at 900,000 tokens
// of a 1,048,576-token window, a margin of 14%, so an estimate more than 14%
// low still lets the provider reject the turn -- the failure this exists to
// prevent -- while a high estimate only compacts sooner, which costs context
// the session can be summarized out of. Against real text this lands between
// about 1.0x (code-heavy) and 1.3x (prose-heavy) of the true count, so
// compaction fires somewhere between 690,000 and 900,000 real tokens.
//
// That band only holds if the bytes handed to it are bytes the model reads.
// Known opaque reasoning input is discounted structurally below.
const ESTIMATE_BYTES_PER_TOKEN = 3.3;

// Below this the substitution could not affect compaction anyway, and leaving
// small turns alone keeps the router out of responses whose reported numbers
// barely matter. It is a "do not bother" floor, not the safety property: the
// safety property is that only an explicit zero is ever replaced, and no
// tokenizer returns zero for a prompt that serializes to kilobytes.
const MIN_ESTIMATED_INPUT_TOKENS = 1_000;

// Only reasoning items in the prepared input carry known opaque provider data.
// Schema keys, tool results and unknown fields remain model-visible by default.
const NON_VISIBLE_KEY = Buffer.from('"encrypted_content"', "utf8");
function nonVisibleBytes(buffer, payload) {
  if (!buffer.includes(NON_VISIBLE_KEY) && payload === undefined) return 0;
  if (payload === undefined) {
    if (!isUtf8(buffer)) return 0;
    const text = buffer.toString("utf8");
    if (!jsonIsUnambiguousForRewrite(text, { allowLossyNumbers: true })) return 0;
    payload = JSON.parse(text);
  }
  if (!Array.isArray(payload?.input)) return 0;
  let total = 0;
  for (const item of payload.input) {
    if (item?.type === "reasoning" && typeof item.encrypted_content === "string") {
      total += Buffer.byteLength(JSON.stringify(item.encrypted_content), "utf8");
    }
  }
  return total;
}

function tokenCount(value) {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && value.trim().length > 0)
  ) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const inputTokens = tokenCount(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = tokenCount(value.output_tokens ?? value.completion_tokens);
  const explicitTotal = tokenCount(value.total_tokens);
  const totalTokens = explicitTotal ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  if (totalTokens === undefined && inputTokens === undefined && outputTokens === undefined) return undefined;
  // Providers that do prefix caching report the shared prefix they did not
  // have to re-process. Compatible shapes use prompt_cache_hit_tokens or
  // input_tokens_details /
  // prompt_tokens_details.cached_tokens. The router forwards it for
  // diagnostics so the meter can show whether caching is actually happening.
  const cachedInputTokens = tokenCount(
    value.input_tokens_details?.cached_tokens ??
      value.prompt_tokens_details?.cached_tokens ??
      value.prompt_cache_hit_tokens,
  );
  const cacheWriteTokens = tokenCount(
    value.input_tokens_details?.cache_write_tokens ??
      value.prompt_tokens_details?.cache_write_tokens ??
      value.prompt_tokens_details?.cache_creation_tokens,
  );
  const retries = tokenCount(value.retries);
  const progressOnlyRetried =
    value.progress_only_retried === true || value.progressOnlyRetried === true;
  const billedInputTokens = tokenCount(
    value.billed_input_tokens ?? value.billed_prompt_tokens ?? value.billedInputTokens,
  );
  const billedOutputTokens = tokenCount(
    value.billed_output_tokens ?? value.billed_completion_tokens ?? value.billedOutputTokens,
  );
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(retries !== undefined && retries > 0 ? { retries } : {}),
    ...(progressOnlyRetried ? { progressOnlyRetried: true } : {}),
    ...(billedInputTokens !== undefined ? { billedInputTokens } : {}),
    ...(billedOutputTokens !== undefined ? { billedOutputTokens } : {}),
  };
}

// Add up the usage of two attempts at the same turn. A turn the router had to
// send twice cost twice; the meter has to say so, or the retry marker names a
// turn whose reported spend still looks like one attempt.
export function mergeTokenUsage(first, second) {
  if (!first && !second) return undefined;
  const attempts = [first, second];
  const usageComplete = attempts.every(Boolean) &&
    attempts.every((usage) => usage.usageComplete !== false &&
      usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== undefined);
  const aggregateOptionalCounter = (field, completenessField, onlyIncomplete = false) => {
    const reported = attempts.filter((usage) => usage?.[field] !== undefined);
    if (!reported.length) return {};
    const complete = attempts.every(Boolean) && reported.length === attempts.length &&
      reported.every((usage) => usage[completenessField] !== false);
    return {
      [field]: reported.reduce((sum, usage) => sum + usage[field], 0),
      ...(!onlyIncomplete || !complete ? { [completenessField]: complete } : {}),
    };
  };
  const cached = aggregateOptionalCounter(
    "cachedInputTokens",
    "cachedInputTokensComplete",
  );
  const written = aggregateOptionalCounter(
    "cacheWriteTokens",
    "cacheWriteTokensComplete",
  );
  const retries =
    first?.retries === undefined && second?.retries === undefined
      ? undefined
      : (first?.retries || 0) + (second?.retries || 0);
  return {
    ...aggregateOptionalCounter("inputTokens", "inputTokensComplete", true),
    ...aggregateOptionalCounter("outputTokens", "outputTokensComplete", true),
    ...aggregateOptionalCounter("totalTokens", "totalTokensComplete", true),
    usageComplete,
    ...cached,
    ...written,
    ...(retries !== undefined && retries > 0 ? { retries } : {}),
  };
}

export function tokenUsageFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  for (const candidate of [payload.usage, payload.response?.usage]) {
    const usage = normalizeTokenUsage(candidate);
    if (usage) return usage;
  }
  return undefined;
}

// Provider observation keeps field presence separate from the meter's
// compatibility defaults. In particular, a missing input count is not an
// observed zero, and an input estimate substituted into the relayed response
// never enters this object.
export function reportedTokenUsageFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  for (const candidate of [payload.usage, payload.response?.usage]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const reportedCount = (value) => Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
    const inputTokens = reportedCount(candidate.input_tokens ?? candidate.prompt_tokens);
    const cachedInputTokens = reportedCount(
      candidate.input_tokens_details?.cached_tokens ??
        candidate.prompt_tokens_details?.cached_tokens ??
        candidate.prompt_cache_hit_tokens,
    );
    const cacheWriteTokens = reportedCount(
      candidate.input_tokens_details?.cache_write_tokens ??
        candidate.prompt_tokens_details?.cache_write_tokens ??
        candidate.prompt_tokens_details?.cache_creation_tokens,
    );
    const outputTokens = reportedCount(candidate.output_tokens ?? candidate.completion_tokens);
    const reported = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
    if (Object.keys(reported).length) return reported;
  }
  return undefined;
}

// Estimates the prompt tokens in a request the router has already serialized.
//
// Character-count-over-a-ratio is crude, but it is predictable, needs no
// dependency and no tokenizer download, and it is measured against the exact
// bytes that went upstream rather than against a model of the conversation.
// Returns undefined when the request is too small for the estimate to matter,
// which is also what keeps it away from genuinely small turns.
//
// Pass the prepared payload together with its serialized body to avoid parsing
// it again. Raw callers discount only validated JSON. Unknown fields and data
// outside known reasoning input remain counted, including tool schemas.
export function estimateInputTokens(body, { contextWindow, payload } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const bytes = buffer.byteLength - nonVisibleBytes(buffer, payload);
  const estimate = Math.ceil(bytes / ESTIMATE_BYTES_PER_TOKEN);
  if (estimate < MIN_ESTIMATED_INPUT_TOKENS) return undefined;
  // A request the provider answered cannot have exceeded the window, so the
  // estimate is never allowed to claim it did.
  //
  // Clamping to the window is the same value it always was, but it no longer
  // means the same thing. It used to fire on conversations nowhere near the
  // limit -- a body three quarters ciphertext crossed the window at a quarter
  // of its real size -- and because `autoCompact` is 85% of the window, a
  // clamped estimate sits above the compaction threshold by construction, so
  // every one of those turns compacted for nothing. That was the bug: not the
  // clamp, but what was allowed to reach it.
  //
  // Counting only model-visible bytes puts a floor under it. For the estimate
  // to exceed the window the visible text must exceed `contextWindow * 3.3`
  // bytes, and real text tokenizes between 3.3 (code) and 4.0 (prose) bytes per
  // token -- so a clamped estimate means the true count is between 82.5% and
  // 100% of the window. `autoCompact` sits at 85%. Compacting there is correct:
  // the conversation really is against the limit, and the alternative, reporting
  // something below the threshold, would skip the compaction and hand the next
  // turn to the provider to reject. Erring high costs a summary; erring low
  // costs the turn.
  return Number.isInteger(contextWindow) && contextWindow > 0
    ? Math.min(estimate, contextWindow)
    : estimate;
}

// True only when the upstream explicitly said the prompt was empty. A missing
// key, a null, a string, or any positive count is left alone: the router
// replaces a value it knows to be false, never one it merely dislikes. `null`
// in particular means "no count yet", not "no tokens", and `Number(null)` is 0,
// so the type is checked rather than coerced.
function reportsZeroPromptTokens(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  for (const key of ["input_tokens", "prompt_tokens"]) {
    if (typeof usage[key] === "number" && usage[key] === 0) return true;
  }
  return false;
}

function withEstimatedPromptTokens(usage, estimate) {
  const outputTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens) || 0;
  const next = { ...usage, total_tokens: estimate + outputTokens };
  if ("input_tokens" in usage) next.input_tokens = estimate;
  if ("prompt_tokens" in usage) next.prompt_tokens = estimate;
  return next;
}

// Returns a copy of a payload whose zero prompt count has been replaced by the
// estimate, or undefined when the payload does not qualify.
function substituteZeroInputUsage(payload, estimate) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (!Number.isInteger(estimate) || estimate <= 0) return undefined;
  if (reportsZeroPromptTokens(payload.usage)) {
    return { ...payload, usage: withEstimatedPromptTokens(payload.usage, estimate) };
  }
  const nested = payload.response;
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    reportsZeroPromptTokens(nested.usage)
  ) {
    return {
      ...payload,
      response: { ...nested, usage: withEstimatedPromptTokens(nested.usage, estimate) },
    };
  }
  return undefined;
}


// Terminal type and nested status must agree. Missing status is compatible
// with Responses bridges; a contradictory status or error cannot prove success.
// Phase inference and raw response observation use the same terminal meaning.
export function responseTerminalOutcome(payload) {
  const response = payload?.response && typeof payload.response === "object" ? payload.response : payload;
  const type = payload?.type;
  const status = response?.status;
  if (type === "error" || type === "response.failed" || status === "failed" || response?.error) return "stream_error";
  if (type === "response.incomplete" || status === "incomplete") return "incomplete";
  const completed = type === "response.completed" || type === "response.done";
  if (completed && status !== undefined && status !== "completed") return "stream_error";
  if (completed || (type === undefined && status === "completed")) return "completed";
  return undefined;
}

export class ResponseUsageTransform extends Transform {
  #eventStream;
  #frames;
  #progressLines = new SseLineScanner();
  #usage;
  #reportedUsage;
  #providerResponse = {};
  #estimate;
  #substituted;
  #committed = false;
  #pendingParts = [];
  #pendingBytes = 0;
  #pendingTailBytes = 0;
  #nextPartBytes = 1_024;
  #released = false;
  #headerlessDetector;
  #firstTokenAt;
  #completedResponseObserved = false;
  #terminalFailure = false;
  #completedOutput;
  #doneOutputItems = [];
  #outputObservationOverflow = false;

  constructor(contentType = "", { estimatedInputTokens, maxPendingBytes = MAX_SSE_PENDING_BYTES } = {}) {
    super();
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#headerlessDetector = !this.#eventStream && !declared.includes("json") ? new HeaderlessSseDetector() : undefined;
    this.#estimate = Number.isSafeInteger(estimatedInputTokens) && estimatedInputTokens > 0 ? estimatedInputTokens : undefined;
    this.maxPendingBytes = maxPendingBytes;
    this.#frames = new SseFrameBuffer({ maxLineBytes: maxPendingBytes, maxFrameBytes: MAX_SSE_PENDING_BYTES + 4 });
  }

  _transform(chunk, _encoding, callback) {
    try {
      if (this.#headerlessDetector) {
        const detected = this.#headerlessDetector.write(chunk);
        if (detected.decision === "pending") { callback(); return; }
        this.#headerlessDetector = undefined;
        this.#eventStream = detected.decision === "event-stream";
        for (const buffered of detected.chunks) this.#transformChunk(buffered);
      } else this.#transformChunk(chunk);
      callback();
    } catch (error) { callback(error); }
  }

  #transformChunk(chunk) {
    const observeOnly = this.#estimate === undefined;
    if (observeOnly) this.push(chunk); // Observation never holds client bytes.
    if (this.#released) { if (!observeOnly) this.push(chunk); return; }
    if (this.#eventStream) { this.#consumeEventChunk(chunk); return; }
    if (this.#pendingBytes + chunk.length > MAX_JSON_CAPTURE_BYTES) {
      this.#release();
      if (!observeOnly) this.push(chunk);
    } else this.#appendPending(chunk);
  }

  _flush(callback) {
    try {
      if (this.#headerlessDetector) {
        const detected = this.#headerlessDetector.end();
        this.#headerlessDetector = undefined;
        this.#eventStream = detected.decision === "event-stream";
        for (const buffered of detected.chunks) this.#transformChunk(buffered);
      }
      const observeOnly = this.#estimate === undefined;
      if (this.#eventStream) {
        // EOF does not dispatch an unfinished event or grant terminal evidence.
        if (this.#estimate !== undefined && this.#frames.pendingBytes) this.push(this.#frames.take());
        this.#clearPending();
        callback(); return;
      }
      const body = this.#takePending();
      if (this.#released || !body.length) { callback(); return; }
      const text = isUtf8(body) ? body.toString("utf8") : undefined;
      if (text === undefined || !jsonIsUnambiguousForRewrite(text)) {
        if (!observeOnly) this.push(body);
        callback(); return;
      }
      const payload = JSON.parse(text);
      this.#observe(payload);
      if (!observeOnly) {
        const substituted = substituteZeroInputUsage(payload, this.#estimate);
        this.#substituted = substituted ? this.#estimate : undefined;
        this.push(substituted ? Buffer.from(JSON.stringify(substituted), "utf8") : body);
      }
      callback();
    } catch (error) { callback(error); }
  }

  tokenUsage() { return this.#usage; }
  reportedTokenUsage() { return this.#reportedUsage; }
  providerResponseObservation() { return { ...this.#providerResponse }; }
  substitutedInputTokens() { return this.#substituted; }
  firstTokenAt() { return this.#firstTokenAt; }
  completedResponseObserved() { return this.#completedResponseObserved; }

  #release() {
    this.#released = true;
    this.#completedResponseObserved = false;
    this.#completedOutput = undefined;
    this.#doneOutputItems = [];
    delete this.#providerResponse.outcome;
    if (!this.#eventStream && this.#estimate !== undefined) for (const part of this.#pendingBuffers()) this.push(part);
    this.#clearPending();
  }

  #consumeEventChunk(chunk) {
    this.#observeProgressLines(chunk);
    const priorBytes = this.#frames.pendingBytes;
    let consumed = 0;
    try {
      for (const frame of this.#frames.write(chunk)) {
        consumed += frame.bytes.length;
        if (frame.continuation || this.#released) {
          if (this.#estimate !== undefined) this.push(frame.bytes);
          continue;
        }
        const rewritten = this.#observeFrame(frame);
        if (this.#estimate !== undefined) this.push(rewritten ?? frame.bytes);
      }
      if (this.#released && this.#estimate !== undefined && this.#frames.pendingBytes) this.push(this.#frames.take());
    } catch (error) {
      if (this.#committed || !["SSE_LINE_LIMIT", "SSE_FRAME_LIMIT"].includes(error.code)) {
        this.#completedResponseObserved = false;
        this.#providerResponse.outcome = "stream_error";
        throw error;
      }
      // Before any edit, stop capturing oversized data and forward it exactly.
      if (this.#estimate !== undefined) {
        if (this.#frames.pendingBytes) this.push(this.#frames.take());
        this.push(chunk.subarray(Math.max(0, consumed - priorBytes)));
      }
      this.#clearPending();
      this.#released = true;
      this.#completedResponseObserved = false;
      delete this.#providerResponse.outcome;
    }
  }

  #observeFrame(frame) {
    let fields;
    try { fields = sseFrameFields(frame.bytes, frame.atStreamStart); }
    catch { return this.#unsafe(frame, "invalid UTF-8"); }
    if (!fields.hasData) return undefined;
    const generic = !fields.eventName || fields.eventName === "message";
    if (!fields.data || fields.data === "[DONE]") {
      if (!generic) return this.#unsafe(frame, "conflicting event label");
      return undefined;
    }
    if (!jsonIsUnambiguousForRewrite(fields.data)) return this.#unsafe(frame, "ambiguous or malformed JSON");
    const payload = JSON.parse(fields.data);
    if (!generic && fields.eventName !== payload?.type) return this.#unsafe(frame, "conflicting event label");
    this.#observe(payload);
    const substituted = substituteZeroInputUsage(payload, this.#estimate);
    if (substituted) {
      this.#committed = true;
      this.#substituted = this.#estimate;
      return Buffer.from(rewriteSseFrameData(fields, JSON.stringify(substituted)), "utf8");
    }
    if (tokenUsageFromPayload(payload)) this.#substituted = undefined;
    return undefined;
  }

  #unsafe(frame, reason) {
    if (this.#committed) {
      this.#completedResponseObserved = false;
      this.#providerResponse.outcome = "stream_error";
      throw new Error(`Response usage became unsafe after substitution (${reason}).`);
    }
    this.#release();
    return frame.bytes;
  }

  // Progress timing may observe a complete data line before event dispatch.
  // It never records usage, terminal state or tool output from that line.
  #observeProgressLines(chunk) {
    if (this.#firstTokenAt !== undefined) return;
    for (const piece of this.#progressLines.scan(chunk)) {
      if (!piece.endLine && !piece.content.length && piece.ending.length) continue;
      if (this.#pendingBytes + piece.content.length > this.maxPendingBytes) { this.#clearPending(); return; }
      this.#appendPending(piece.content);
      if (!piece.endLine) continue;
      const line = this.#takePending();
      if (!isUtf8(line)) continue;
      const text = line.toString("utf8").replace(/^\uFEFF/u, "");
      if (!text.startsWith("data:")) continue;
      const data = text.slice(5).trim();
      // Timing is best effort: avoid a second full parse of large terminal
      // snapshots. Unusually ordered progress is still observed at dispatch.
      if (!/"type"\s*:\s*"response\.(?:output_text|reasoning_summary_text|function_call_arguments|audio_transcript)\.delta"|"choices"\s*:/u.test(data.slice(0, 512))) continue;
      if (jsonIsUnambiguousForRewrite(data)) this.#noteFirstToken(JSON.parse(data));
      if (this.#firstTokenAt !== undefined) return;
    }
  }

  #appendPending(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      let tail = this.#pendingParts.at(-1);
      if (!tail || this.#pendingTailBytes === tail.length) {
        tail = Buffer.allocUnsafe(this.#nextPartBytes);
        this.#nextPartBytes = Math.min(64 * 1024, this.#nextPartBytes * 2);
        this.#pendingParts.push(tail); this.#pendingTailBytes = 0;
      }
      const count = Math.min(tail.length - this.#pendingTailBytes, bytes.length - offset);
      bytes.copy(tail, this.#pendingTailBytes, offset, offset + count);
      this.#pendingTailBytes += count; this.#pendingBytes += count; offset += count;
    }
  }
  #pendingBuffers() {
    return this.#pendingParts.map((part, index) => index === this.#pendingParts.length - 1 ? part.subarray(0, this.#pendingTailBytes) : part);
  }
  #takePending() {
    const parts = this.#pendingBuffers();
    const body = parts.length === 1 ? parts[0] : Buffer.concat(parts, this.#pendingBytes);
    this.#clearPending(); return body;
  }
  #clearPending() {
    this.#pendingParts = []; this.#pendingBytes = 0; this.#pendingTailBytes = 0; this.#nextPartBytes = 1_024;
  }
  _destroy(error, callback) {
    this.#clearPending();
    this.#frames.take();
    callback(error);
  }

  #observe(payload) {
    this.#noteFirstToken(payload);
    if (payload?.type === "response.output_item.done" && payload.item) {
      if (this.#doneOutputItems.length < MAX_OBSERVED_OUTPUT_ITEMS) this.#doneOutputItems.push(payload.item);
      else this.#outputObservationOverflow = true;
    }
    const response = payload?.response && typeof payload.response === "object" ? payload.response : payload;
    const outcome = responseTerminalOutcome(payload);
    if (outcome === "incomplete" || outcome === "stream_error") {
      this.#terminalFailure = true;
      this.#completedResponseObserved = false;
      this.#providerResponse.outcome = outcome;
    } else if (outcome === "completed" && !this.#terminalFailure) {
      this.#completedResponseObserved = true;
      this.#providerResponse.outcome = outcome;
      if (Array.isArray(response?.output)) {
        if (response.output.length <= MAX_OBSERVED_OUTPUT_ITEMS) this.#completedOutput = response.output;
        else this.#outputObservationOverflow = true;
      }
    }
    if (typeof response?.model === "string") this.#providerResponse.returnedModel = response.model;
    if (typeof response?.service_tier === "string") this.#providerResponse.returnedTier = response.service_tier;
    const reported = reportedTokenUsageFromPayload(payload);
    if (reported) this.#reportedUsage = reported;
    const usage = tokenUsageFromPayload(payload);
    if (usage) this.#usage = usage;
  }

  #noteFirstToken(payload) {
    if (this.#firstTokenAt !== undefined) return;
    const type = payload?.type;
    const producesOutput = ["response.output_text.delta", "response.reasoning_summary_text.delta",
      "response.function_call_arguments.delta", "response.audio_transcript.delta"].includes(type) &&
      typeof payload.delta === "string" && payload.delta.length > 0;
    const chatDelta = payload?.choices?.[0]?.delta;
    if (producesOutput || (typeof chatDelta?.content === "string" && chatDelta.content.length > 0)) this.#firstTokenAt = Date.now();
  }

  responseOutputObservation() {
    if (!this.#completedResponseObserved || this.#outputObservationOverflow) return { complete: false, output: [] };
    const output = Array.isArray(this.#completedOutput) ? [...this.#completedOutput] : [];
    const known = new Set(output.map(item => item?.call_id || item?.id).filter(Boolean));
    for (const item of this.#doneOutputItems) {
      const key = item?.call_id || item?.id;
      if (!key || !known.has(key)) output.push(item);
      if (key) known.add(key);
    }
    return { complete: Array.isArray(this.#completedOutput) || this.#doneOutputItems.length > 0, output };
  }
}
