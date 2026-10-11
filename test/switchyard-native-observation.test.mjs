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
import { fetchWithRetry } from "../src/upstream-retry.mjs";

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

function resetSchedule(activeDestination, outcome = "transport_error") {
  const lines = [];
  const observer = new SwitchyardNativeAttemptObserver({capability:"synthetic-capability",
    env:{CODEX_ROUTER_SWITCHYARD_ATTEMPT_OBSERVATION:"1",CODEX_ROUTER_SWITCHYARD_ATTEMPT_LOG:"unused-in-memory"},
    append:(_path,value)=>lines.push(value)});
  const headers = {"session-id":"PRIVATE_RESET_SESSION"};
  const first = observer.beginRequest(headers,{model:"gpt-6.1-sol",effort:"high",requestedTier:"default"});
  observer.beginAttempt(first,0); observer.finishAttempt(first,{outcome:"completed"},1); observer.endRequest(first);
  const destination = observer.beginRequest(headers,{model:"gpt-6-astra",effort:"xhigh",requestedTier:"default"});
  observer.beginAttempt(destination,2); observer.finishAttempt(destination,{outcome},3);
  let active = destination;
  if (!activeDestination) {
    observer.endRequest(destination);
    active = observer.beginRequest(headers,{model:"gpt-6.1-sol",effort:"high",requestedTier:"default"});
  }
  observer.beginAttempt(active,4);
  const overlap = observer.beginRequest(headers,{model:"gpt-6-astra",effort:"medium",requestedTier:"default"});
  return {observer,lines,headers,active,overlap};
}

test("the reset fact distinguishes byte-identical legacy retry and ended-failure histories without guessing outcomes", () => {
  for (const outcome of ["completed","incomplete","cancelled","http_error","stream_error","transport_error","empty_completion","retryable_http","unknown"]) {
    const retry = resetSchedule(true,outcome), ended = resetSchedule(false,outcome);
    const beforeFact = lines=>lines.join("").replace(/,"invalidatedRequest":\d+(?=\})/gu,"");
    assert.equal(beforeFact(retry.lines),beforeFact(ended.lines));
    assert.equal(JSON.parse(retry.lines.at(-1)).invalidatedRequest,2);
    assert.equal(JSON.parse(ended.lines.at(-1)).invalidatedRequest,3);
    for (const [fixture,expected] of [[retry,0],[ended,1]]) {
      const summary = summarizeNativeAttemptObservations(fixture.lines.join(""));
      assert.equal(Object.values(summary.transitions).reduce((sum,count)=>sum+count,0),expected,outcome);
      assert.equal(summary.coverage.parsedAttempts,2);
      assert.equal(summary.coverage.uncertainResets,0);
      assert.doesNotMatch(fixture.lines.join(""),/PRIVATE_RESET_SESSION/u);
    }
    const legacy = summarizeNativeAttemptObservations(beforeFact(retry.lines));
    assert.deepEqual(legacy.transitions,{});
    assert.equal(legacy.coverage.parsedAttempts,2);
    assert.equal(legacy.coverage.uncertainResets,1);
    assert.equal(legacy.outsideTransitions.uncertainResetRequests,1);
    assert.equal(legacy.outcomes[outcome],outcome === "completed" ? 2 : 1);
  }
});

test("repeated overlaps record explicit null after ordered custody is lost", () => {
  const fixture = resetSchedule(true);
  fixture.observer.beginRequest(fixture.headers,{model:"gpt-6.1-sol",effort:"high",requestedTier:"default"});
  const resets = fixture.lines.map(JSON.parse).filter(record=>record.event === "association_reset");
  assert.deepEqual(resets.map(record=>record.invalidatedRequest),[2,null]);
  assert.ok(resets.every(record=>record.schemaVersion === 1 && record.reason === "overlap"));
  const summary = summarizeNativeAttemptObservations(fixture.lines.join(""));
  assert.deepEqual(summary.transitions,{});
  assert.equal(summary.coverage.associationResets,2);
  assert.equal(summary.coverage.uncertainResets,0);
});

test("malformed reset ordinals exclude uncertain transitions while preserving attempt aggregates", () => {
  const fixture = resetSchedule(false), original = fixture.lines.map(JSON.parse);
  for (const value of [0,-1,1,1.5,"PRIVATE_ORDINAL",[],{},Number.MAX_SAFE_INTEGER+1]) {
    const records = structuredClone(original); records.at(-1).invalidatedRequest = value;
    const summary = summarizeNativeAttemptObservations(records.map(JSON.stringify).join("\n"));
    assert.deepEqual(summary.transitions,{});
    assert.equal(summary.coverage.parsedAttempts,2);
    assert.equal(summary.coverage.malformedRecords,1);
    assert.equal(summary.coverage.uncertainResets,1);
    assert.doesNotMatch(JSON.stringify(summary),/PRIVATE_ORDINAL/u);
  }
});

test("actual preconnect retry and exhausted failure share an outcome label but preserve no-overlap attempt coverage", async () => {
  const lines = [], observer = new SwitchyardNativeAttemptObserver({capability:"synthetic-capability",
    env:{CODEX_ROUTER_SWITCHYARD_ATTEMPT_OBSERVATION:"1",CODEX_ROUTER_SWITCHYARD_ATTEMPT_LOG:"unused-in-memory"},append:(_path,value)=>lines.push(value)});
  const request = observer.beginRequest({"session-id":"private-retry"},{model:"gpt-6.1-sol",effort:"high",requestedTier:"default"});
  observer.beginAttempt(request,0);
  let attempts = 0;
  const failure = Object.assign(new Error("synthetic preconnect failure"),{code:"ECONNREFUSED"});
  await assert.rejects(fetchWithRetry("http://invalid.invalid/",{method:"POST"},{retries:1,backoffMs:0,budgetMs:1000,now:()=>0,
    fetchImpl:async()=> { attempts++; throw failure; },sleepImpl:async()=>{},onRetry:()=> {
      observer.finishAttempt(request,{outcome:"transport_error"},1); observer.beginAttempt(request,2);
    }}),error=>error === failure);
  observer.finishAttempt(request,{outcome:"transport_error"},3); observer.endRequest(request);
  assert.equal(attempts,2);
  const summary = summarizeNativeAttemptObservations(lines.join(""));
  assert.equal(summary.coverage.parsedAttempts,2); assert.deepEqual(summary.outcomes,{transport_error:2});
  assert.deepEqual(summary.transitions,{}); assert.equal(summary.coverage.associationResets,0);
});

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

test("writer-produced observations retain the shared model, effort, tier and outcome vocabulary", () => {
  const {root,log,observer} = fixture();
  try {
    const models = [["gpt-5.6-luna","luna"],["gpt-5.6-sol","sol"],["gpt-6.1-sol","sol"],["gpt-6-astra","astra"]];
    const efforts = ["low","medium","high","xhigh","max"];
    const tiers = ["default","priority","flex"];
    const outcomes = ["completed","incomplete","cancelled","http_error","stream_error",
      "transport_error","empty_completion","retryable_http","unknown"];
    const expectedTargets = {}, expectedOutcomes = {};
    let index = 0;
    for (const [model,family] of models) for (const effort of efforts) {
      const tier = tiers[index % tiers.length], outcome = outcomes[index % outcomes.length];
      const request = observer.beginRequest({"session-id":`synthetic-vocabulary-${index}`},{model,effort,requestedTier:tier});
      observer.beginAttempt(request,index * 2);
      observer.finishAttempt(request,{outcome,httpStatus:200,returnedModel:model,returnedTier:tier},index * 2 + 1);
      observer.endRequest(request);
      const key = `${family}:${effort}:${tier}`;
      expectedTargets[key] = (expectedTargets[key] || 0) + 1;
      expectedOutcomes[outcome] = (expectedOutcomes[outcome] || 0) + 1;
      index++;
    }
    const summary = summarizeNativeAttemptObservations(readFileSync(log,"utf8"));
    assert.equal(summary.coverage.parsedAttempts,index);
    assert.deepEqual(summary.targets,expectedTargets);
    assert.deepEqual(summary.outcomes,expectedOutcomes);
    assert.doesNotMatch(JSON.stringify(summary),/synthetic-vocabulary/u);
  } finally { rmSync(root,{recursive:true,force:true}); }
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
