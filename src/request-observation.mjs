import { createHash } from "node:crypto";
import { jsonIsUnambiguousForRewrite } from "./namespace-relay.mjs";
import { explicitConversationIdentity } from "./switchyard-native-observation.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

// Private log correlation only: neither a capability nor caller authentication.
// Restrict inputs to native UUID identities and never retain the raw value.
export function observationIdentity(kind, value) {
  if (!["thread", "session"].includes(kind) || typeof value !== "string" || !UUID.test(value)) return undefined;
  return createHash("sha256").update(`codex-router/${kind}/v1\0${value.toLowerCase()}`).digest("hex");
}

function turnMetadata(encoded) {
  if (encoded === undefined) return {};
  if (typeof encoded !== "string" || encoded.length > 64 * 1024 ||
      !jsonIsUnambiguousForRewrite(encoded, { allowLossyNumbers: true })) return undefined;
  try {
    const value = JSON.parse(encoded);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

function consistent(kind, values) {
  const present = values.filter(value => value !== undefined);
  const hashes = present.map(value => observationIdentity(kind, value));
  return hashes.length && hashes.every(Boolean) && new Set(hashes).size === 1 ? hashes[0] : undefined;
}

export function requestObservation(headers = {}, clientMetadata) {
  // Per-response WebSocket metadata is current; handshake headers can describe
  // an older turn. Its flat UUID fields avoid parsing the unbounded tool inventory.
  const current = clientMetadata && typeof clientMetadata === "object" && !Array.isArray(clientMetadata) ? clientMetadata : {};
  const hasCurrentThread = Object.hasOwn(current, "thread_id");
  const hasCurrentSession = Object.hasOwn(current, "session_id");
  if (hasCurrentThread && hasCurrentSession) return {
    thread: observationIdentity("thread", current.thread_id),
    session: observationIdentity("session", current.session_id),
  };
  const turn = turnMetadata(current["x-codex-turn-metadata"] ?? headers["x-codex-turn-metadata"]);
  if (!turn) return {};
  return {
    thread: hasCurrentThread ? observationIdentity("thread", current.thread_id) :
      consistent("thread", [turn.thread_id, headers["thread-id"]]),
    // Responses session-id can be a cache-affinity key. Switchyard uses the
    // actual session in turn metadata; do not mistake either for a thread ID.
    session: hasCurrentSession ? observationIdentity("session", current.session_id) :
      observationIdentity("session", turn.session_id ?? explicitConversationIdentity(headers)),
  };
}

export function observationFields(observation) {
  return Object.entries(observation).filter(([, value]) => value !== undefined)
    .map(([kind, value]) => ` ${kind}_sha256=${value}`).join("");
}
