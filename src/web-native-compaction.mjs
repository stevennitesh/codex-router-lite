import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isUtf8 } from "node:buffer";

import { privateFileIsProtected } from "./file-security.mjs";
import { decodeCompaction } from "./compaction-checkpoint.mjs";
import { jsonIsUnambiguousForRewrite } from "./namespace-relay.mjs";
import { ResponseUsageTransform } from "./response-usage.mjs";
import { SseFrameBuffer, sseFrameFields } from "./sse-framing.mjs";

export const MAX_NATIVE_COMPACTION_WITNESS_BYTES = 16 * 1024 * 1024;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = () => Object.assign(new Error("Native compaction has no valid durable readable source."), { code: "web_native_compaction_state", status: 409 });
const opaque = item => record(item) && item.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
  && (item.status === undefined || item.status === "completed");
const ignored = new Set(["reasoning", "additional_tools", "compaction_trigger"]);

// Current request tool declarations never enter historical projection authority.
export function nativeCompactionSource(input) {
  if (typeof input === "string") input = [{ role: "user", content: input }];
  if (!Array.isArray(input) || input.some(item => !record(item))) throw failure();
  const source = input.filter(item => !ignored.has(item.type));
  const serialized = JSON.stringify(source);
  if (Buffer.byteLength(serialized) > MAX_NATIVE_COMPACTION_WITNESS_BYTES / 2) throw failure();
  return JSON.parse(serialized);
}

export function validNativeCompactionReference(value) {
  return record(value) && Object.keys(value).sort().join() === "checkpointSha256,opaqueSha256,sourceSha256,witnessSha256"
    && [value.checkpointSha256, value.opaqueSha256, value.sourceSha256, value.witnessSha256].every(sha256);
}

export function validNativeCompactionWitness(value, { threadId, opaqueItem, reference } = {}) {
  try {
    if (!record(value) || value.version !== 1 || !uuid(value.threadId) || threadId !== undefined && value.threadId !== threadId
        || !sha256(value.opaqueSha256) || !sha256(value.sourceSha256) || !sha256(value.checkpointSha256)
        || !Array.isArray(value.source) || value.source.some(item => !record(item) || ignored.has(item.type)
          || item.type === "compaction" && !decodeCompaction(item.encrypted_content))
        || digest(value.source) !== value.sourceSha256 || !record(value.provenance)
        || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
        || Buffer.byteLength(JSON.stringify(value)) > MAX_NATIVE_COMPACTION_WITNESS_BYTES) return false;
    if (value.provenance.kind === "router-native-request") {
      if (!uuid(value.provenance.requestId) || typeof value.responseId !== "string" || !value.responseId.length) return false;
    } else if (value.provenance.kind === "canonical-readable-history") {
      if (!sha256(value.provenance.rolloutSha256) || value.responseId !== null && (typeof value.responseId !== "string" || !value.responseId.length)) return false;
      if (value.provenance.boundary !== undefined || value.provenance.rolloutByteLength !== undefined) {
        const boundary = value.provenance.boundary;
        if (!Number.isSafeInteger(value.provenance.rolloutByteLength) || value.provenance.rolloutByteLength <= 0 || !record(boundary)
            || !Number.isSafeInteger(boundary.byteStart) || !Number.isSafeInteger(boundary.byteEnd) || boundary.byteStart < 0
            || boundary.byteStart >= boundary.byteEnd || boundary.byteEnd > value.provenance.rolloutByteLength
            || ![boundary.recordSha256, boundary.sourcePrefixSha256, boundary.replacementSha256].every(sha256)) return false;
      }
    } else return false;
    if (opaqueItem !== undefined && (!opaque(opaqueItem) || digest(opaqueItem) !== value.opaqueSha256)) return false;
    return reference === undefined || validNativeCompactionReference(reference)
      && reference.witnessSha256 === digest(value) && reference.opaqueSha256 === value.opaqueSha256
      && reference.sourceSha256 === value.sourceSha256 && reference.checkpointSha256 === value.checkpointSha256;
  } catch { return false; }
}

export function createNativeCompactionWitness({ threadId, source, opaqueItem, responseId, checkpoint, provenance, createdAt = new Date().toISOString() }) {
  if (!opaque(opaqueItem) || !Array.isArray(checkpoint) || !checkpoint.every(sha256)) throw failure();
  source = nativeCompactionSource(source);
  const witness = { version: 1, threadId, opaqueSha256: digest(opaqueItem), responseId, source,
    sourceSha256: digest(source), checkpointSha256: digest(checkpoint), provenance: structuredClone(provenance), createdAt };
  if (!validNativeCompactionWitness(witness)) throw failure();
  return witness;
}

export function nativeCompactionWitnessReference(witness) {
  if (!validNativeCompactionWitness(witness)) throw failure();
  return { opaqueSha256: witness.opaqueSha256, witnessSha256: digest(witness), sourceSha256: witness.sourceSha256,
    checkpointSha256: witness.checkpointSha256 };
}

export function nativeCompactionWitnessPath(stateDir, threadId, opaqueSha256) {
  if (!uuid(threadId) || !sha256(opaqueSha256)) throw failure();
  return path.join(stateDir, "web-in-app", "conversations", `${threadId}.native-compaction-${opaqueSha256}.json`);
}

export function readNativeCompactionWitness({ stateDir, threadId, reference, stateIsProtected = privateFileIsProtected }) {
  if (!validNativeCompactionReference(reference)) throw failure();
  const filePath = nativeCompactionWitnessPath(stateDir, threadId, reference.opaqueSha256);
  let descriptor;
  try {
    const info = lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_NATIVE_COMPACTION_WITNESS_BYTES || !stateIsProtected(filePath)) throw failure();
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw failure();
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0, read;
    do { read = readSync(descriptor, buffer, offset, buffer.length - offset, offset); offset += read; } while (read && offset < buffer.length);
    const after = fstatSync(descriptor), current = lstatSync(filePath);
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
        || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw failure();
    const bytes = buffer.subarray(0, offset);
    if (bytes.length > MAX_NATIVE_COMPACTION_WITNESS_BYTES || !isUtf8(bytes) || !jsonIsUnambiguousForRewrite(bytes.toString("utf8"))) throw failure();
    const witness = JSON.parse(bytes.toString("utf8"));
    if (!validNativeCompactionWitness(witness, { threadId, reference })) throw failure();
    return witness;
  } catch { throw failure(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

// Exact matching consumes occurrences, so a repeated native prefix remains
// repeated while changed current instructions and post-checkpoint input survive.
export function expandNativeCompactionWitnesses(input, witnesses, { threadId, itemIdentity = digest } = {}) {
  if (!Array.isArray(input) || !Array.isArray(witnesses)) throw failure();
  const known = new Map();
  for (const witness of witnesses) {
    if (!validNativeCompactionWitness(witness, { threadId }) || known.has(witness.opaqueSha256)) throw failure();
    known.set(witness.opaqueSha256, witness);
  }
  let result = [];
  for (const item of input) {
    const witness = item?.type === "compaction" ? known.get(digest(item)) : undefined;
    if (!witness) { result.push(item); continue; }
    const counts = new Map();
    for (const source of witness.source) {
      const hash = itemIdentity(source);
      if (hash !== undefined && hash !== null) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
    const unmatched = result.filter(prefix => {
      const hash = itemIdentity(prefix), remaining = counts.get(hash) ?? 0;
      if (!remaining) return true;
      counts.set(hash, remaining - 1); return false;
    });
    result = [...structuredClone(witness.source), ...unmatched];
  }
  return result;
}

// Withhold an owned compact response until this complete bounded observation
// has qualified it. The existing observer supplies terminal/output bounds;
// exact terminal snapshots additionally bind response and compaction identity.
export async function nativeCompactionResponse(bytes, contentType, { compactV1 = false, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > maxBytes || !isUtf8(bytes)) throw failure();
  const text = bytes.toString("utf8");
  const stream = String(contentType).includes("text/event-stream") || /^\s*(?:event:|data:)/u.test(text);
  let terminal, count = 0;
  const identities = new Set(), done = [];
  const consume = payload => {
    if (!record(payload)) throw failure();
    if (["error", "response.failed", "response.incomplete"].includes(payload.type) || payload.error) throw failure();
    if (payload.response?.id) identities.add(payload.response.id);
    if (payload.response_id !== undefined) identities.add(payload.response_id);
    if (payload.type === "response.output_item.done") done.push(payload.item);
    if (payload.type === "response.completed") { count += 1; terminal = payload.response; }
  };
  if (stream) {
    const frames = new SseFrameBuffer({ maxFrameBytes: bytes.length + 1, maxLineBytes: bytes.length + 1 });
    for (const frame of frames.write(bytes)) {
      if (frame.continuation) continue;
      const fields = sseFrameFields(frame.bytes, frame.atStreamStart);
      if (!fields.hasData || fields.data === "[DONE]") continue;
      if (!jsonIsUnambiguousForRewrite(fields.data)) throw failure();
      const payload = JSON.parse(fields.data);
      if (fields.eventCount > 1 || fields.eventName && !["message", payload.type].includes(fields.eventName)) throw failure();
      consume(payload);
    }
    if (frames.pendingBytes || count !== 1) throw failure();
  } else {
    if (!jsonIsUnambiguousForRewrite(text)) throw failure();
    terminal = JSON.parse(text);
  }
  if (!record(terminal) || terminal.error || terminal.status !== undefined && terminal.status !== "completed"
      || (!compactV1 || stream) && terminal.status !== "completed"
      || typeof terminal.id !== "string" || !terminal.id.length || !Array.isArray(terminal.output)
      || identities.size > 1 || identities.size === 1 && !identities.has(terminal.id)) throw failure();
  const compacted = terminal.output.filter(opaque);
  if (compacted.length !== 1 || terminal.output.some(item => item?.type === "compaction" && !opaque(item))
      || done.some(item => !terminal.output.some(final => digest(final) === digest(item)))) throw failure();
  const observer = new ResponseUsageTransform(stream ? "text/event-stream" : "application/json");
  observer.resume();
  await new Promise((resolve, reject) => { observer.once("error", reject); observer.once("finish", resolve); observer.end(bytes); });
  if ((!compactV1 || stream) && (!observer.completedResponseObserved() || !observer.responseOutputObservation().complete)) throw failure();
  return { responseId: terminal.id, output: terminal.output, opaqueItem: compacted[0] };
}
