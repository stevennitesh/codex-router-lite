import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserOutput } from "../src/web-browser.mjs";
import { savedChatRecoveryError } from "../src/web-browser-diagnostics.mjs";
import { safeLocalHttpErrorPayload } from "../src/http-utils.mjs";

const token = "diagnostic_frame_token_123456";
const marker = "ROUTER_WEB_RECOVERY_DIAGNOSTIC ";
const wrapped = text => JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ isError: true,
  content: [{ type: "text", text: `Error: native recovery rejected. ${text}\n    at nativeBrowser (private-path:1:1)` }] }) }] });
const capture = (output, stage = "continue") => {
  try { parseBrowserOutput(output, token, stage, savedChatRecoveryError); assert.fail("Native error must reject."); }
  catch (error) { return error; }
};

test("wrapped native recovery errors expose only fixed categories and bounded diagnostic facts", () => {
  const privateCanary = "PRIVATE_SAVED_CHAT_REPLY_TOKEN_PROMPT_837462";
  const error = capture(wrapped(marker + JSON.stringify({ reason: "reply-prefix-too-short", stage: privateCanary, phase: "initial-proof",
    urlMatches: true, generationTurnCount: 1, prefixLongEnough: false, replyCount: 10000, composerCount: -1,
    expectedPrefixUtf16Length: 1024, recordedReplyUtf16Length: 10000, recordedReplyUtf16LengthCapped: true, recordedReplyHasAnswer: true,
    scrollUnknownCount: 10001, freshReplyCount: 1.5, checkpointReplyCount: "1", prefixMatches: privateCanary,
    replyId: privateCanary, url: `https://chatgpt.com/c/${privateCanary}`, token: privateCanary,
    prompt: privateCanary, reply: privateCanary, rawOutput: { text: privateCanary } })));
  assert.equal(error.code, "web_saved_chat_recovery_failed");
  assert.equal(error.status, 409);
  assert.deepEqual(error.diagnostic, { stage: "continue", reason: "reply-prefix-too-short", phase: "initial-proof", urlMatches: true,
    prefixLongEnough: false, recordedReplyUtf16LengthCapped: true, recordedReplyHasAnswer: true,
    replyCount: 10000, generationTurnCount: 1, recordedReplyUtf16Length: 10000, expectedPrefixUtf16Length: 1024 });
  const payload = safeLocalHttpErrorPayload(error, { type: "local_router_error" });
  assert.equal(payload.error.type, "local_router_error");
  assert.equal(payload.error.code, error.code);
  assert.match(payload.error.message, /stage=continue, reason=reply-prefix-too-short/u);
  assert.match(payload.error.message, /Keep the saved chat and any draft/u);
  assert.equal(JSON.stringify({ error, payload }).includes(privateCanary), false);
  assert.equal(payload.error.message.includes("private-path"), false);
});

test("controlled recovery exposes only fixed refusal reasons through the current native browser boundary", () => {
  for (const reason of ["composer-draft-present", "generation-active", "idle-control-missing", "snapshot-changed", "ownership-changed"]) {
    const error = capture(wrapped(marker + JSON.stringify({ reason, phase: "initial-proof", prompt: "PRIVATE_DRAFT", token: "PRIVATE_TOKEN" })), "recover");
    assert.equal(error.code, "web_saved_chat_recovery_failed");
    assert.equal(error.diagnostic.reason, reason); assert.equal(error.diagnostic.stage, "recover");
    assert.doesNotMatch(JSON.stringify(safeLocalHttpErrorPayload(error)), /PRIVATE_DRAFT|PRIVATE_TOKEN/u);
  }
});

test("controlled recovery retains fixed read-only boundary phases and bounded browser or tab counts", () => {
  const phases = ["browser-discovery", "browser-acquisition", "active-owner", "saved-tab-discovery", "saved-tab-acquisition",
    "saved-url-readiness", "checkpoint-readiness", "browser-recheck", "saved-url-recheck", "dom-snapshot", "generation-state",
    "composer-state", "normal-chat-state", "idle-control-state", "message-identities", "accepted-checkpoint", "reply-history",
    "anchor-snapshot", "revoked-turn-order", "reply-prefix", "reply-content-readiness", "snapshot-stability", "handoff", "ownership-transfer"];
  for (const phase of phases) {
    const error = capture(wrapped(marker + JSON.stringify({ reason: "ownership-changed", phase, browserCount: 2,
      tabMatchCount: 10000, browserId: "PRIVATE_BROWSER", tabId: "PRIVATE_TAB", owner: "PRIVATE_OWNER" })), "recover");
    assert.deepEqual(error.diagnostic, { stage: "recover", reason: "ownership-changed", phase, browserCount: 2, tabMatchCount: 10000 });
    assert.doesNotMatch(error.message, /PRIVATE_/u);
  }
  for (const [browserCount, tabMatchCount] of [[-1, 10001], [1.5, "2"], [null, {}]]) {
    const error = capture(wrapped(marker + JSON.stringify({ reason: "ownership-changed", phase: "saved-tab-discovery", browserCount, tabMatchCount })), "recover");
    assert.deepEqual(error.diagnostic, { stage: "recover", reason: "ownership-changed", phase: "saved-tab-discovery" });
  }
});

test("recovery ownership guards have fixed reasons and phases without owner identities", () => {
  for (const reason of ["prior-recovery-unverified", "foreign-recovery-owner"]) {
    const error = capture(wrapped(marker + JSON.stringify({ reason, phase: "ownership-guard", ownerId: "PRIVATE_OWNER_CANARY" })));
    assert.deepEqual(error.diagnostic, { stage: "continue", reason, phase: "ownership-guard" });
    assert.equal(safeLocalHttpErrorPayload(error).error.message.includes("PRIVATE_OWNER_CANARY"), false);
  }
  const error = capture(wrapped(marker + JSON.stringify({ reason: "reply-prefix-too-short", phase: "PRIVATE_PHASE_CANARY",
    expectedPrefixUtf16Length: 1025, recordedReplyUtf16Length: -1 })));
  assert.deepEqual(error.diagnostic, { stage: "continue", reason: "reply-prefix-too-short" });
});

test("ambiguous, malformed, unknown and oversized recovery markers keep the generic unsafe error", () => {
  const good = marker + JSON.stringify({ reason: "reply-prefix-too-short" });
  for (const output of [
    wrapped(`${good} ${good}`), wrapped(`${good}\n${good}`), wrapped(`${good}\nROUTER_WEB_RECOVERY_DIAGNOSTIC`),
    JSON.stringify([{ isError: true, content: [{ text: good }] }, { content: [{ text: good }] }]),
    wrapped(marker + '{"reason":"reply-prefix-too-short","reason":"composer-draft-present"}'),
    wrapped(marker + '{"reason":"reply-prefix-too-short"'), wrapped(`${good} trailing-data`),
    wrapped(marker + JSON.stringify({ reason: "unrecognized-private-reason" })),
    wrapped(marker + JSON.stringify({ reason: "reply-prefix-too-short", prompt: "x".repeat(8192) })),
    wrapped("x".repeat(64 * 1024) + good),
  ]) {
    const error = capture(output);
    assert.equal(error.code, "web_browser_execution_failed");
    assert.equal(error.message, "Native JavaScript execution failed.");
    assert.equal(safeLocalHttpErrorPayload(error), undefined);
  }
  for (const stage of [null, "untrusted-private-stage", { operation: "continue" }]) {
    assert.equal(capture(wrapped(good), stage).code, "web_browser_execution_failed");
  }
  assert.throws(() => parseBrowserOutput(wrapped(good), token), { code: "web_browser_execution_failed" });
  assert.throws(() => parseBrowserOutput({ content: [{ text: good }] }, token, "continue"), { code: "web_browser_output_shape" });
  const arbitrary = Object.assign(new Error("private native error"), { code: "web_saved_chat_recovery_failed", status: 409 });
  assert.equal(safeLocalHttpErrorPayload(arbitrary), undefined);
});
