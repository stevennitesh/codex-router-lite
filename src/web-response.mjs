import { randomUUID } from "node:crypto";

import { decodeCompaction, encodeCheckpoint, finalizeCheckpoint, prepareCompaction } from "./compaction-checkpoint.mjs";
import { webToolKinds } from "./web-tool-contract.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const id = prefix => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const failure = message => Object.assign(new Error(message), { code: "invalid_web_response", status: 502 });
const prefixes = { message: "msg", ...Object.fromEntries(Object.values(webToolKinds).map(kind => [kind.callType, kind.idPrefix])) };

function nonempty(value) { return typeof value === "string" && value.length > 0; }

function completedOutput(output) {
  if (!Array.isArray(output)) throw failure("Web output must be an array of native Responses items.");
  let items;
  try { items = structuredClone(output); }
  catch { throw failure("Web output could not be copied as native Responses items."); }
  const itemIds = new Set(), callIds = new Set();
  return items.map(item => {
    if (!record(item) || !Object.hasOwn(prefixes, item.type)) throw failure("Web output contains an unsupported native item type.");
    if (item.status !== undefined && item.status !== "completed") throw failure("Web output contains an unfinished item.");
    if (item.id !== undefined && !nonempty(item.id)) throw failure("Web output contains an invalid native item identity.");
    item.id ??= id(prefixes[item.type]);
    if (itemIds.has(item.id)) throw failure("Web output contains duplicate native item identities.");
    itemIds.add(item.id);
    item.status = "completed";
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)
          || item.content.some(part => !record(part) || part.type !== "output_text" || typeof part.text !== "string"
            || part.annotations !== undefined && !Array.isArray(part.annotations))) {
        throw failure("Web final output must contain assistant output_text content.");
      }
      item.phase = "final_answer";
      item.content = item.content.map(part => ({ ...part, annotations: part.annotations ?? [] }));
      return item;
    }
    if (!nonempty(item.call_id) || callIds.has(item.call_id)) throw failure("Web output contains an invalid or duplicate native tool call identity.");
    callIds.add(item.call_id);
    if (item.type === "tool_search_call") {
      if (item.execution !== "client" || item.arguments === undefined) throw failure("Web tool search requires native client execution and structured arguments.");
    } else {
      if (!nonempty(item.name) || item.namespace !== undefined && item.namespace !== null && !nonempty(item.namespace)) {
        throw failure("Web tool output contains an invalid native name or namespace.");
      }
      if (typeof (item.type === "function_call" ? item.arguments : item.input) !== "string") {
        throw failure("Web function arguments and custom-tool input must retain their native string encoding.");
      }
    }
    return item;
  });
}

function json(value) {
  try { return JSON.stringify(value); }
  catch { throw failure("Web response contains a value that cannot be encoded as JSON."); }
}

function* events(response) {
  const progress = { ...response, status: "in_progress", output: [] };
  yield { type: "response.created", response: progress };
  yield { type: "response.in_progress", response: progress };
  for (const [output_index, item] of response.output.entries()) {
    const identity = { output_index, item_id: item.id };
    const added = { ...item, status: "in_progress",
      ...(item.type === "message" ? { content: [] } : item.type === "function_call" ? { arguments: "" }
        : item.type === "custom_tool_call" ? { input: "" } : {}) };
    yield { type: "response.output_item.added", output_index, item: added };
    // Web output is already complete. Native tool dispatch consumes item.done;
    // repeating whole argument/input fields as synthetic deltas adds no progress.
    if (item.type === "message") {
      for (const [content_index, part] of item.content.entries()) {
        const contentIdentity = { ...identity, content_index };
        yield { type: "response.content_part.added", ...contentIdentity, part: { ...part, text: "" } };
        yield { type: "response.output_text.delta", ...contentIdentity, delta: part.text };
      }
    }
    yield { type: "response.output_item.done", output_index, item };
  }
  yield { type: "response.completed", response };
}

// These items already carry their native tool identity. The response envelope
// adds framing only; no provider namespace translation or tool execution occurs.
export function webResponse(payload, output, { responseId = id("resp"), createdAt = Math.floor(Date.now() / 1_000) } = {}) {
  const { body, init } = webResponseRecord(payload, output, { responseId, createdAt });
  return new Response(body, init);
}

// Runtime replay retains this serialized record, avoiding a Response body decode
// and another UTF-8 encode for every already-framed reply.
export function webResponseRecord(payload, output, { responseId = id("resp"), createdAt = Math.floor(Date.now() / 1_000) } = {}) {
  if (!nonempty(payload?.model) || !nonempty(responseId) || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw failure("Web response requires a model, response identity and Unix creation time.");
  }
  const response = { id: responseId, object: "response", created_at: createdAt, status: "completed",
    model: payload.model, output: completedOutput(output), usage: null, error: null };
  return responseRecord(payload, response);
}

function responseRecord(payload, response) {
  if (payload.stream !== true) return { body: json(response), init: { headers: { "content-type": "application/json", "cache-control": "no-store" } } };
  let sequence = 0;
  const wire = [...events(response)].map(event => `event: ${event.type}\ndata: ${json({ ...event, sequence_number: sequence++ })}\n\n`).join("") + "data: [DONE]\n\n";
  return { body: wire, init: { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } } };
}

// Local compaction is deliberately lossy. Keep actual Router-extracted source
// records and their machine-derived outcomes, without inventing a model summary
// or spending an inference request. Existing checkpoint limits own all excerpts.
export function webCompactOutput(payload, { retainedTail = [], compactV2 = false } = {}) {
  if (!Array.isArray(payload?.input)) throw Object.assign(new Error("Web compaction requires a native input array."), { code: "invalid_web_compaction", status: 400 });
  if (payload.input.some(item => item?.type === "compaction" && !decodeCompaction(item.encrypted_content))) {
    throw Object.assign(new Error("Web local compaction cannot read an opaque native checkpoint; use Router-readable conversation history."), { code: "encrypted_v2_unsupported", status: 422 });
  }
  const prepared = prepareCompaction(payload.input);
  const recent = prepared.recentTail.map(entry => entry.id).reverse();
  const priorities = [
    ...recent.filter(source => source.startsWith("U")),
    ...prepared.previousRefs.requirements,
    ...recent.filter(source => source.startsWith("C") || source.startsWith("R")),
    ...prepared.previousRefs.attempts, ...prepared.previousRefs.observations,
    ...prepared.catalogSourceIds,
  ];
  const selected = [...new Set(priorities)].filter(source => /^[UCR]/u.test(source) && prepared.catalogSourceIds.has(source)).slice(0, 32);
  const lossNotice = "Local deterministic compaction retains bounded source excerpts; omitted content, unrecorded actions and current mutable state remain unknown.";
  const selection = {
    objective: prepared.previous.objective,
    requirement_refs: selected.filter(source => source.startsWith("U")),
    attempt_refs: selected.filter(source => source.startsWith("C")),
    observation_refs: selected.filter(source => source.startsWith("R")),
    unverified: prepared.previous.unverified,
    unknowns: [lossNotice, ...prepared.previous.unknowns].slice(0, 32),
    blockers: prepared.previous.blockers,
    next_step: "Re-read current state and continue from the retained user requests and tool evidence.",
  };
  const checkpoint = finalizeCheckpoint(JSON.stringify(selection), prepared);
  // An established Web chat already owns its acknowledged history. Preserve
  // undelivered native items verbatim. V2 must carry them inside the checkpoint:
  // its native consumer discards ordinary adjacent output items.
  const itemId = id("cmp");
  const item = { type: "compaction", id: itemId, encrypted_content: encodeCheckpoint(checkpoint,
    compactV2 ? { retainedTail, retainedTailId: itemId } : {}) };
  return compactV2 ? [item] : [item, ...retainedTail];
}

export function webCompactResponse(payload, { retainedTail = [], compactV2 = false,
  output = webCompactOutput(payload, { retainedTail, compactV2 }) } = {}) {
  if (compactV2) {
    const { body, init } = responseRecord({ ...payload, stream: payload.stream !== false }, { id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1_000),
      status: "completed", model: payload.model, output, usage: null, error: null });
    return new Response(body, init);
  }
  return new Response(json({ output }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
