import { safeLocalHttpError } from "./http-utils.mjs";

const marker = "ROUTER_WEB_RECOVERY_DIAGNOSTIC";
const stages = new Set(["bootstrap", "open", "send", "observe", "retain", "continue", "rollover", "recover"]);
const phases = new Set(["initial-proof", "registered-recheck", "ownership-guard", "browser-discovery", "browser-acquisition",
  "active-owner", "saved-tab-discovery", "saved-tab-acquisition", "saved-url-readiness", "checkpoint-readiness",
  "browser-recheck", "saved-url-recheck", "dom-snapshot", "generation-state", "composer-state", "normal-chat-state",
  "idle-control-state", "message-identities", "accepted-checkpoint", "reply-history", "anchor-snapshot", "revoked-turn-order",
  "reply-prefix", "reply-content-readiness", "snapshot-stability", "handoff", "ownership-transfer"]);
const reasons = new Set([
  "saved-url-changed", "temporary-mode-active", "invalid-reply-identities", "generation-turn-not-unique",
  "generation-turn-not-latest", "generation-turn-incomplete", "fresh-reply-not-latest", "expected-reply-mismatch",
  "missing-fresh-reply", "reply-text-unavailable", "reply-prefix-too-short", "reply-prefix-mismatch",
  "recorded-reply-missing", "composer-ambiguous", "composer-unavailable", "composer-shape-invalid", "composer-draft-present",
  "prior-recovery-unverified", "foreign-recovery-owner",
  "generation-active", "idle-control-missing", "snapshot-changed", "ownership-changed",
]);
const booleans = ["urlMatches", "temporaryInactive", "replyIdentitiesValid", "generationIsLatest", "freshReplyIsLatest",
  "expectedReplyMatches", "replyTextAvailable", "recordedReplyPresent", "prefixLongEnough", "prefixMatches",
  "composerShapeValid", "composerEmpty", "latestReplyPrefixMatches", "checkpointIsLatestReply", "checkpointPrefixLongEnough",
  "checkpointPrefixMatches", "checkpointHasTurnIdentity", "checkpointTurnIsLatest", "viewportReadSucceeded", "viewportUrlMatches",
  "viewportLastReplyMatches", "scrollChainComplete", "scrollHasAbove", "scrollHasBelow", "scrollAtEnd",
  "documentHasAbove", "documentHasBelow", "documentAtEnd", "recordedReplyUtf16LengthCapped", "recordedReplyHasAnswer"];
const counts = ["browserCount", "tabMatchCount", "replyCount", "generationTurnCount", "freshReplyCount", "composerCount", "mountedTurnCount",
  "prefixMatchingReplyCount", "checkpointReplyCount", "checkpointTurnCount", "scrollAncestorCount", "scrollUnknownCount", "recordedReplyUtf16Length"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Native MCP results may be JSON-encoded more than once. Follow only their
// established output wrappers, with one shared budget; never retain their text.
export function savedChatRecoveryError(output, stage) {
  if (!stages.has(stage)) return undefined;
  const texts = [];
  let nodes = 0, characters = 0, executionFailed = false, bounded = true;
  const visit = (value, depth = 0) => {
    if (++nodes > 128 || depth > 8) { bounded = false; return; }
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 64 * 1024) { bounded = false; return; }
      let parsed;
      try { parsed = JSON.parse(value); } catch { texts.push(value); return; }
      visit(parsed, depth + 1);
    } else if (Array.isArray(value)) {
      if (value.length > 128) { bounded = false; return; }
      for (const child of value) visit(child, depth + 1);
    } else if (record(value)) {
      if (value.isError === true) executionFailed = true;
      for (const key of ["text", "content", "output"]) if (Object.hasOwn(value, key)) visit(value[key], depth + 1);
    }
  };
  visit(output);
  if (!bounded || !executionFailed) return undefined;
  const matches = texts.filter(text => text.includes(marker));
  if (matches.length !== 1 || matches[0].split(marker).length !== 2) return undefined;
  const suffix = matches[0].slice(matches[0].indexOf(marker) + marker.length);
  if (!suffix.startsWith(" ")) return undefined;
  const tail = suffix.slice(1);
  // The native emitter writes one compact JSON object on one line. Requiring
  // that exact representation also rejects duplicate keys and trailing data.
  const line = tail.split(/\r?\n/u, 1)[0];
  if (!line || line.length > 8192) return undefined;
  let value;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!record(value) || JSON.stringify(value) !== line || !reasons.has(value.reason)) return undefined;
  const diagnostic = { stage, reason: value.reason };
  if (phases.has(value.phase)) diagnostic.phase = value.phase;
  for (const key of booleans) if (typeof value[key] === "boolean") diagnostic[key] = value[key];
  for (const key of counts) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 10000) diagnostic[key] = value[key];
  if (Number.isSafeInteger(value.expectedPrefixUtf16Length) && value.expectedPrefixUtf16Length >= 0 && value.expectedPrefixUtf16Length <= 1024) {
    diagnostic.expectedPrefixUtf16Length = value.expectedPrefixUtf16Length;
  }
  const error = safeLocalHttpError(
    `ChatGPT saved-chat recovery failed (stage=${stage}, reason=${value.reason}). Keep the saved chat and any draft; inspect its current reply before continuing. Recovery diagnostics: ${JSON.stringify(diagnostic)}`,
    { status: 409, code: "web_saved_chat_recovery_failed" },
  );
  error.diagnostic = diagnostic;
  return error;
}
