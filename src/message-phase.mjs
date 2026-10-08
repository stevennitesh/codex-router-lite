import { Transform } from "node:stream";
import { jsonIsUnambiguousForRewrite } from "./namespace-relay.mjs";
import { SseFrameBuffer, sseFrameFields, rewriteSseFrameData } from "./sse-framing.mjs";
import { responseTerminalOutcome } from "./response-usage.mjs";

// Native Codex models label every assistant message with a `phase`:
// `commentary` for a progress note written before more tool calls, and
// `final_answer` for the message that ends the turn. Codex keys its display on
// that label -- commentary folds into the collapsible "Worked for ..." group
// and the final answer renders below it -- and its thread history looks the
// answer up by `phase = 'final_answer'`. Routed providers never send the label,
// so every progress note rendered as a standalone answer.
//
// This stage assigns the label from the item order the stream already carries,
// using the rule native turns follow: a message that a tool call or another
// message follows is commentary, and the last message of a completed response
// is the final answer. A reasoning item after a message decides nothing, so a
// message followed only by reasoning is still the answer. It spends no model
// tokens. Codex replays the label with the message on later turns: a
// Chat-translated route drops it (LiteLLM rebuilds chat history from role and
// content), while a Responses provider receives the original message phase.
//
// Only a message's `output_item.done` is rewritten, and only while its phase is
// absent; a phase the provider sent always wins. Text deltas stream unchanged.
// The done frame is held until a tool call or message opens (commentary) or the
// response completes (final answer); a reasoning item in between is held with
// it, and every held frame is replayed in order behind it. A failed, errored,
// incomplete, or `[DONE]`-terminated response, a clean end of stream without a
// terminal, or anything this stage cannot parse releases the held frame
// untouched. An upstream error is different: the pipeline destroys this stage,
// a destroyed stream cannot push, and the held frames are lost with the stream
// -- as they are in every other holding stage -- before the router ends the
// body with a stream error. GLM message-envelope repair runs before this stage.
const COMMENTARY = "commentary";
const FINAL_ANSWER = "final_answer";
// Terminals that settle a delivered response: its last message is the answer.
const ANSWER_TERMINALS = new Set(["response.completed", "response.done"]);
// Terminals that end the turn without an answer. Codex treats
// `response.incomplete` as a stream error, like `response.failed`.
const FAILURE_TERMINALS = new Set(["response.failed", "response.incomplete", "error"]);
// Output items that neither make a preceding message commentary nor end it as
// the answer. Native turns never place one after a message; a routed provider
// can, and labelling the message commentary then left the turn with no answer.
const NEUTRAL_ITEM_TYPES = new Set(["reasoning"]);
// The window between a message closing and the next item opening normally holds
// a few small frames. Past this bound the frame is released unlabelled.
const DEFAULT_MAX_HELD_BYTES = 1024 * 1024;
// Oversized or ambiguous frames disable rewriting without guessing their type.
const MAX_PARSE_CHARS = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;

function parseFrame(fields) {
  const data = fields.data;
  if (!fields.hasData) return undefined;
  const generic = !fields.eventName || fields.eventName === "message";
  if (data === "[DONE]") return generic ? { done: true } : { invalid: true };
  if (data.length > MAX_PARSE_CHARS || !jsonIsUnambiguousForRewrite(data)) return { invalid: true };
  const event = JSON.parse(data);
  if (!generic && fields.eventName !== event?.type) return { invalid: true };
  return typeof event?.type === "string" ? { type: event.type, event } : undefined;
}

function unlabelledAssistantMessage(item) {
  return (
    item !== null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    item.type === "message" &&
    item.role === "assistant" &&
    (item.phase === undefined || item.phase === null)
  );
}

function rewrittenFrame(fields, event) {
  return Buffer.from(rewriteSseFrameData(fields, JSON.stringify(event)), "utf8");
}

// Labels the terminal snapshot's messages by the same rule the stream used: a
// message before the last non-reasoning item is commentary.
export function labelResponseOutput(output) {
  if (!Array.isArray(output)) return undefined;
  const lastDecisive = output.findLastIndex((item) => !NEUTRAL_ITEM_TYPES.has(item?.type));
  let changed = false;
  const labelled = output.map((item, index) => {
    if (!unlabelledAssistantMessage(item)) return item;
    changed = true;
    return { ...item, phase: index < lastDecisive ? COMMENTARY : FINAL_ANSWER };
  });
  return changed ? labelled : undefined;
}

export class MessagePhaseTransform extends Transform {
  #frames = new SseFrameBuffer();
  #passthrough = false;
  #maxHeldBytes;
  // The unlabelled message done frame awaiting its label, and the frames that
  // arrived after it.
  #pending;
  #held = [];
  #heldBytes = 0;

  constructor({ maxHeldBytes = DEFAULT_MAX_HELD_BYTES } = {}) {
    super();
    this.#maxHeldBytes = maxHeldBytes;
  }

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#passthrough) {
      this.push(piece);
      callback();
      return;
    }
    try {
      for (const frame of this.#frames.write(piece)) {
        if (this.#passthrough) this.push(frame.bytes);
        else this.#frame(frame.bytes, frame.atStreamStart);
      }
      if (this.#frames.pendingBytes > MAX_FRAME_BYTES) this.#disable();
      else if (this.#passthrough && this.#frames.pendingBytes) this.push(this.#frames.take());
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    // A stream that ended without a terminal has no answer to label.
    this.#release(undefined);
    if (this.#frames.pendingBytes) this.push(this.#frames.take());
    callback();
  }

  #frame(original, atStreamStart) {
    if (original.length > MAX_FRAME_BYTES) {
      this.#disable(original);
      return;
    }
    let fields;
    try {
      fields = sseFrameFields(original, atStreamStart);
    } catch {
      // Invalid UTF-8 disables labelling for the rest of the stream.
      this.#release(undefined);
      this.push(original);
      if (this.#frames.pendingBytes) this.push(this.#frames.take());
      this.#passthrough = true;
      return;
    }
    const parsed = parseFrame(fields);
    if (parsed?.invalid) {
      this.#disable(original);
      return;
    }
    const type = parsed?.type;
    const outcome = responseTerminalOutcome(parsed?.event);
    const answerTerminal = ANSWER_TERMINALS.has(type) && outcome === "completed";
    const failureTerminal = FAILURE_TERMINALS.has(type) || outcome === "incomplete" || outcome === "stream_error";

    if (this.#pending) {
      const itemFrame = type === "response.output_item.added" || type === "response.output_item.done";
      if (itemFrame && !NEUTRAL_ITEM_TYPES.has(parsed.event?.item?.type)) {
        // A tool call or another message follows the held message, so it was
        // commentary. An item this stage could not parse counts as one.
        this.#release(COMMENTARY);
      } else if (answerTerminal) {
        this.#release(FINAL_ANSWER);
      } else if (failureTerminal || parsed?.done) {
        this.#release(undefined);
      } else {
        this.#held.push(original);
        this.#heldBytes += original.length;
        if (this.#heldBytes > this.#maxHeldBytes) this.#release(undefined);
        return;
      }
    }

    if (type === "response.output_item.done" && unlabelledAssistantMessage(parsed.event?.item)) {
      this.#pending = { fields, original, event: parsed.event };
      this.#heldBytes = original.length;
      if (this.#heldBytes > this.#maxHeldBytes) this.#release(undefined);
      return;
    }
    if (answerTerminal && parsed.event) {
      const output = labelResponseOutput(parsed.event.response?.output);
      if (output) {
        this.push(rewrittenFrame(fields, {
          ...parsed.event,
          response: { ...parsed.event.response, output },
        }));
        this.#disable();
        return;
      }
    }
    this.push(original);
    if (ANSWER_TERMINALS.has(type) || failureTerminal || parsed?.done) this.#disable();
  }

  #disable(original) {
    this.#release(undefined);
    if (original) this.push(original);
    if (this.#frames.pendingBytes) this.push(this.#frames.take());
    this.#passthrough = true;
  }

  // Emits the held message frame -- labelled with `phase`, or untouched when
  // `phase` is undefined -- followed by every frame held behind it.
  #release(phase) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.push(
      phase
        ? rewrittenFrame(pending.fields, {
            ...pending.event,
            item: { ...pending.event.item, phase },
          })
        : pending.original,
    );
    for (const frame of this.#held) this.push(frame);
    this.#held = [];
    this.#heldBytes = 0;
  }
}

export function messagePhaseTransform(contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new MessagePhaseTransform();
}
