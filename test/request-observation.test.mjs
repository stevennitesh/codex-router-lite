import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { observationFields, observationIdentity, requestObservation } from "../src/request-observation.mjs";

const thread = "019a0780-0000-7000-8000-000000000001";
const session = "019a0780-0000-7000-8000-000000000003";
const hash = (kind, value) => createHash("sha256").update(`codex-router/${kind}/v1\0${value.toLowerCase()}`).digest("hex");

test("private request correlation separates thread from session/cache identity", () => {
  assert.equal(observationIdentity("thread",thread.toUpperCase()),hash("thread",thread));
  assert.notEqual(observationIdentity("thread",thread),observationIdentity("session",thread));
  const observation = requestObservation({"thread-id":thread,"session-id":"a-cache-affinity-key",
    "x-codex-turn-metadata":JSON.stringify({thread_id:thread,session_id:session})});
  assert.deepEqual(observation,{thread:hash("thread",thread),session:hash("session",session)});
  const fields = observationFields(observation);
  assert.match(fields,/ thread_sha256=[a-f0-9]{64} session_sha256=[a-f0-9]{64}$/u);
  assert.ok(!fields.includes(thread) && !fields.includes(session) && !fields.includes("cache-affinity"));
});

test("each WebSocket response uses its current metadata rather than handshake identity", () => {
  const headers = {"thread-id":session,"session-id":thread};
  assert.deepEqual(requestObservation(headers,{thread_id:thread,session_id:session,
    "x-codex-turn-metadata":"x".repeat(100_000)}),{thread:hash("thread",thread),session:hash("session",session)});
  assert.deepEqual(requestObservation(headers,{thread_id:session,session_id:thread}),{thread:hash("thread",session),session:hash("session",thread)});
});

test("absent, malformed and conflicting identities cannot become timing authority", () => {
  for (const value of [undefined,null,[],{},"",`${thread}\nPRIVATE_CANARY`,"PRIVATE_CANARY"]) {
    assert.equal(observationIdentity("thread",value),undefined);
  }
  for (const headers of [
    {}, {"session-id":session}, {"thread-id":[thread]},
    {"thread-id":thread,"x-codex-turn-metadata":"BROKEN_PRIVATE_CANARY"},
    {"thread-id":thread,"x-codex-turn-metadata":JSON.stringify({thread_id:session})},
    {"x-codex-turn-metadata":`{"thread_id":"${thread}","thread_id":"${session}"}`},
  ]) {
    const observation = requestObservation(headers);
    assert.equal(observation.thread,undefined);
    assert.ok(!observationFields(observation).includes("PRIVATE_CANARY"));
  }
});
