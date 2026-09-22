import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  explicitConversationIdentity,
  SwitchyardNativeAttemptObserver,
} from "../src/switchyard-native-observation.mjs";
import { summarizeNativeAttemptObservations } from "../src/switchyard-trace.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "switchyard-native-observation-"));
  const log = path.join(root, "attempts.jsonl");
  const capability = "fixture-switchyard-generation-capability";
  const observer = new SwitchyardNativeAttemptObserver({
    capability,
    env: {
      CODEX_ROUTER_SWITCHYARD_ATTEMPT_OBSERVATION: "1",
      CODEX_ROUTER_SWITCHYARD_ATTEMPT_LOG: log,
    },
  });
  return { root, log, capability, observer };
}

function marker(capability) {
  return createHash("sha256").update(capability).digest("hex");
}

test("native attempt observations keep raw identity and hostile metadata out of records", () => {
  const { root, log, capability, observer } = fixture();
  try {
    const headers = {
      "session-id": "private-synthetic-session",
      "x-codex-router-switchyard-observation": marker(capability),
    };
    assert.equal(observer.consumeAttribution(headers), true);
    assert.equal(headers["x-codex-router-switchyard-observation"], undefined);
    const request = observer.beginRequest(headers, {
      model: "gpt-hostile-private-model",
      effort: "private-effort",
      requestedTier: "private-tier",
    });
    observer.beginAttempt(request, 100);
    observer.finishAttempt(request, {
      httpStatus: 200,
      outcome: "completed",
      returnedModel: "gpt-hostile-returned-model",
      returnedTier: "private-returned-tier",
      usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
    }, 125);
    observer.endRequest(request);

    const rendered = readFileSync(log, "utf8");
    assert.doesNotMatch(rendered, /private-synthetic|hostile|private-effort|private-tier/u);
    const records = rendered.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(records.at(-1), {
      schemaVersion: 1,
      event: "native_attempt",
      association: 1,
      request: 1,
      attempt: 1,
      model: "unknown",
      effort: "unknown",
      requestedTier: "unknown",
      compactionItems: "unknown",
      elapsedMs: 25,
      httpStatus: 200,
      outcome: "completed",
      usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit association rejects missing, conflicting, oversized, and malformed identities", () => {
  assert.equal(explicitConversationIdentity({}), undefined);
  assert.equal(explicitConversationIdentity({ "session-id": "one", "x-session-id": "two" }), undefined);
  assert.equal(explicitConversationIdentity({ "session-id": "contains space" }), undefined);
  assert.equal(explicitConversationIdentity({ "session-id": "x".repeat(257) }), undefined);
  assert.equal(explicitConversationIdentity({ "session-id": "valid", "x-session-id": "bad value" }), undefined);
  assert.equal(explicitConversationIdentity({ "session-id": "valid", "x-session-id": ["valid", "valid"] }), undefined);
  assert.equal(explicitConversationIdentity({ "session-id": "same", "x-session-id": "same" }), "same");
});

test("a diagnostic write failure disables the observer for the process", () => {
  const env = {
    CODEX_ROUTER_SWITCHYARD_ATTEMPT_OBSERVATION: "1",
    CODEX_ROUTER_SWITCHYARD_ATTEMPT_LOG: "unused.jsonl",
  };
  const failedAtStart = new SwitchyardNativeAttemptObserver({
    env,
    capability: "capability",
    append: () => { throw new Error("synthetic write failure"); },
  });
  assert.equal(failedAtStart.enabled(), false);

  let writes = 0;
  const failedLater = new SwitchyardNativeAttemptObserver({
    env,
    capability: "capability",
    append: () => {
      writes += 1;
      if (writes === 2) throw new Error("synthetic write failure");
    },
  });
  assert.equal(failedLater.enabled(), true);
  const request = failedLater.beginRequest({ "session-id": "valid" }, {
    model: "gpt-5.6-sol", effort: "medium", requestedTier: "default",
  });
  failedLater.beginAttempt(request, 0);
  failedLater.finishAttempt(request, { outcome: "completed" }, 1);
  assert.equal(failedLater.enabled(), false);
  failedLater.beginAttempt(request, 2);
  failedLater.finishAttempt(request, { outcome: "completed" }, 3);
  assert.equal(writes, 2);
});

test("overlap resets transition order while retries and incomplete outcomes retain attempt coverage", () => {
  const { root, log, observer } = fixture();
  try {
    const headers = { "session-id": "bounded-association" };
    const first = observer.beginRequest(headers, {
      model: "gpt-5.6-sol", effort: "medium", requestedTier: "default",
    });
    observer.beginAttempt(first, 0);
    observer.finishAttempt(first, {
      outcome: "retryable_http", httpStatus: 503,
    }, 5);
    observer.beginAttempt(first, 10);
    observer.finishAttempt(first, {
      outcome: "completed",
      usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 3 },
    }, 20);
    observer.endRequest(first);

    const second = observer.beginRequest(headers, {
      model: "gpt-6-astra", effort: "xhigh", requestedTier: "priority",
      compactionItems: "present",
    });
    observer.beginAttempt(second, 30);
    observer.finishAttempt(second, { outcome: "retryable_http", httpStatus: 503 }, 35);
    observer.beginAttempt(second, 36);
    observer.finishAttempt(second, {
      outcome: "incomplete",
      returnedTier: "default",
      usage: { inputTokens: 80, cacheWriteTokens: 0, outputTokens: 1 },
    }, 45);
    observer.endRequest(second);

    const overlappingA = observer.beginRequest(headers, {
      model: "gpt-5.6-sol", effort: "medium", requestedTier: "default",
    });
    observer.beginAttempt(overlappingA, 50);
    const overlappingB = observer.beginRequest(headers, {
      model: "gpt-6-astra", effort: "medium", requestedTier: "default",
    });
    observer.beginAttempt(overlappingB, 51);
    observer.finishAttempt(overlappingA, { outcome: "cancelled" }, 60);
    observer.endRequest(overlappingA);
    observer.finishAttempt(overlappingB, { outcome: "transport_error" }, 61);
    observer.endRequest(overlappingB);

    const afterReset = observer.beginRequest(headers, {
      model: "gpt-5.6-sol", effort: "medium", requestedTier: "default",
    });
    observer.beginAttempt(afterReset, 70);
    observer.finishAttempt(afterReset, { outcome: "completed" }, 75);
    observer.endRequest(afterReset);

    const summary = summarizeNativeAttemptObservations(readFileSync(log, "utf8"));
    assert.equal(summary.coverage.parsedAttempts, 7);
    assert.equal(summary.coverage.associatedAttempts, 5);
    assert.equal(summary.coverage.unassociatedAttempts, 2);
    assert.equal(summary.coverage.associationResets, 1);
    assert.deepEqual(summary.transitions, {
      "sol:medium:default->astra:xhigh:priority": 1,
    });
    assert.deepEqual(summary.outcomes, {
      retryable_http: 2,
      completed: 2,
      incomplete: 1,
      cancelled: 1,
      transport_error: 1,
    });
    assert.deepEqual(summary.readShareCohort, {
      records: 1,
      inputTokens: 100,
      cachedInputTokens: 40,
      share: 0.4,
      excludedRecords: 6,
      invalidRecords: 0,
    });
    assert.equal(summary.transitionDetails["sol:medium:default->astra:xhigh:priority"].requests, 1);
    assert.equal(summary.transitionDetails["sol:medium:default->astra:xhigh:priority"].attempts, 2);
    assert.deepEqual(
      summary.transitionDetails["sol:medium:default->astra:xhigh:priority"].latency,
      { recordedMs: 14, validAttempts: 2, missingAttempts: 0, invalidAttempts: 0, weightedAverageMs: 7 },
    );
    assert.equal(
      summary.transitionDetails["sol:medium:default->astra:xhigh:priority"].returnedTier.differentRequestedAttempts,
      1,
    );
    assert.deepEqual(
      summary.transitionDetails["sol:medium:default->astra:xhigh:priority"].compactionItems,
      { present: 1, absent: 0, unknown: 0 },
    );
    assert.equal(summary.usage.cacheWriteTokens.validRecords, 1);
    assert.equal(summary.usage.cacheWriteTokens.explicitZeroRecords, 1);
    assert.equal(summary.usage.cacheWriteTokens.missingRecords, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded idle eviction starts a fresh association and breaks transition order", () => {
  const { root, log, observer } = fixture();
  try {
    for (let index = 0; index < 129; index += 1) {
      const request = observer.beginRequest({ "session-id": `association-${index}` }, {
        model: "gpt-5.6-sol", effort: "medium", requestedTier: "default",
      });
      observer.beginAttempt(request, index);
      observer.finishAttempt(request, { outcome: "completed" }, index + 1);
      observer.endRequest(request);
    }

    const revisited = observer.beginRequest({ "session-id": "association-0" }, {
      model: "gpt-6-astra", effort: "medium", requestedTier: "default",
    });
    observer.beginAttempt(revisited, 200);
    observer.finishAttempt(revisited, { outcome: "completed" }, 201);
    observer.endRequest(revisited);

    const records = readFileSync(log, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(records.at(-1), {
      schemaVersion: 1,
      event: "native_attempt",
      association: 130,
      request: 1,
      attempt: 1,
      model: "gpt-6-astra",
      effort: "medium",
      requestedTier: "default",
      compactionItems: "unknown",
      elapsedMs: 1,
      outcome: "completed",
    });

    const summary = summarizeNativeAttemptObservations(readFileSync(log, "utf8"));
    assert.deepEqual(summary.transitions, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later generation start makes prior associations and attempts unavailable", () => {
  const contents = [
    { schemaVersion: 1, event: "generation_start" },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 1, attempt: 1, model: "gpt-5.6-sol", effort: "medium", requestedTier: "default", outcome: "completed" },
    { schemaVersion: 1, event: "generation_start" },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 1, attempt: 1, model: "gpt-6-astra", effort: "medium", requestedTier: "default", outcome: "cancelled" },
  ].map(JSON.stringify).join("\n");
  const summary = summarizeNativeAttemptObservations(contents);
  assert.equal(summary.coverage.parsedAttempts, 1);
  assert.deepEqual(summary.targets, { "astra:medium:default": 1 });
  assert.deepEqual(summary.outcomes, { cancelled: 1 });
});

test("ordering gaps cannot bridge transitions and cached counts above input are excluded", () => {
  const contents = [
    { schemaVersion: 1, event: "generation_start" },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 1, attempt: 1, model: "gpt-5.6-sol", effort: "medium", requestedTier: "default", compactionItems: "absent", elapsedMs: 5, outcome: "completed", usage: { inputTokens: 10, cachedInputTokens: 11 } },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 3, attempt: 1, model: "gpt-6-astra", effort: "medium", requestedTier: "default", compactionItems: "unknown", elapsedMs: 7, outcome: "completed", usage: { inputTokens: 10, cachedInputTokens: 2 } },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 4, attempt: 1, model: "gpt-5.6-sol", effort: "medium", requestedTier: "default", compactionItems: "absent", elapsedMs: 9, outcome: "completed", usage: { inputTokens: 10, cachedInputTokens: 4 } },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 4, attempt: 3, model: "gpt-5.6-sol", effort: "medium", requestedTier: "default", compactionItems: "absent", elapsedMs: 2, outcome: "completed" },
    { schemaVersion: 1, event: "native_attempt", association: null, request: null, attempt: 1, model: "gpt-5.6-sol", effort: "medium", requestedTier: "default", compactionItems: "unknown", elapsedMs: 1, outcome: "completed" },
  ].map(JSON.stringify).join("\n");
  const summary = summarizeNativeAttemptObservations(contents);
  assert.deepEqual(summary.transitions, {});
  assert.equal(summary.coverage.invalidOrdering, 1);
  assert.equal(summary.outsideTransitions.orderingInvalidRequests, 2);
  assert.equal(summary.outsideTransitions.unassociatedAttempts, 1);
  assert.deepEqual(summary.readShareCohort, {
    records: 2,
    inputTokens: 20,
    cachedInputTokens: 6,
    share: 0.3,
    excludedRecords: 3,
    invalidRecords: 1,
  });
});

test("duplicate request starts cannot contribute a transition", () => {
  const contents = [
    { schemaVersion: 1, event: "generation_start" },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 1, attempt: 1, model: "gpt-5.6-sol", effort: "medium", requestedTier: "default", outcome: "completed" },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 2, attempt: 1, model: "gpt-6-astra", effort: "medium", requestedTier: "default", outcome: "completed" },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 2, attempt: 1, model: "gpt-6-astra", effort: "medium", requestedTier: "default", outcome: "completed" },
    { schemaVersion: 1, event: "native_attempt", association: 1, request: 3, attempt: 1, model: "gpt-5.6-sol", effort: "medium", requestedTier: "default", outcome: "completed" },
  ].map(JSON.stringify).join("\n");
  const summary = summarizeNativeAttemptObservations(contents);
  assert.deepEqual(summary.transitions, {});
  assert.equal(summary.coverage.invalidOrdering, 1);
  assert.equal(summary.outsideTransitions.orderingInvalidRequests, 3);
});
