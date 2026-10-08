import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { summarizeSwitchyardCertificationEvidence } from "../src/switchyard-certification-evidence.mjs";

test("certification evidence keeps useful route facts and removes identifiers", () => {
  const summary = summarizeSwitchyardCertificationEvidence({
    routerLog: [
      "Switchyard libsy server",
      "2026-09-04T05:10:06Z INFO selected_model=\"switchyard/sol-medium\" agent_id=\"secret-agent\" correlation_id=\"secret-correlation\"",
      "2026-09-04T05:10:06Z INFO evidence.source=\"fail_open\" evidence.final_target=\"sol_medium\" evidence.reason_code=\"classifier_timeout\" evidence.threshold=0.35",
      "[codex-router] timing at=2026-09-04T05:10:07Z model=switchyard/auto provider=switchyard status=200 total_ms=800 out_tokens=14 cached_tokens=120",
      "[codex-router] timing at=2026-09-04T05:10:08Z model=switchyard/auto provider=switchyard status=499 total_ms=900",
    ].join("\n"),
    routingLog: [
      JSON.stringify({ ts: "2026-09-04T05:09:00Z", session_id: "old-session", model: "switchyard/luna-high" }),
      JSON.stringify({ ts: "2026-09-04T05:10:07Z", session_id: "secret-session", model: "switchyard/sol-medium", prompt_tokens: 100, cached_tokens: 80, completion_tokens: 14 }),
    ].join("\n"),
  });

  assert.equal(summary.router.total, 2);
  assert.equal(summary.router.successful, 1);
  assert.deepEqual(summary.router.statuses, { 200: 1, 499: 1 });
  assert.equal(summary.routing.total, 1);
  assert.equal(summary.routing.uniqueSessions, 1);
  assert.equal(summary.routing.recent[0].model, "switchyard/sol-medium");
  assert.equal(summary.classifier.decisions, 1);
  assert.equal(summary.classifier.fallbacks, 1);
  assert.deepEqual(summary.classifier.finalTargets, { sol_medium: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /secret-agent|secret-correlation|secret-session|old-session/u);
});

test("certification evidence is bounded and fails closed without a generation", () => {
  assert.deepEqual(summarizeSwitchyardCertificationEvidence({ routerLog: "status=200" }), {
    version: 1,
    generationFound: false,
  });
  assert.throws(
    () => summarizeSwitchyardCertificationEvidence({ routerLog: "", limit: 101 }),
    /integer from 1 to 100/u,
  );
});

test("child selection excludes foreign Switchyard failures without hiding its own failures", () => {
  const thread = "019a0780-0000-7000-8000-000000000001", session = "019a0780-0000-7000-8000-000000000003";
  const foreign = "019a0780-0000-7000-8000-000000000002";
  const hash = (kind,value) => createHash("sha256").update(`codex-router/${kind}/v1\0${value}`).digest("hex");
  const at = second => `2026-10-07T12:00:${String(second).padStart(2,"0")}.000Z`;
  const timing = (second,id,sessionId,status=200) => `[codex-router] timing at=${at(second)} model=switchyard/auto provider=switchyard status=${status} total_ms=10 thread_sha256=${hash("thread",id)} session_sha256=${hash("session",sessionId)}`;
  const input = {child:{threadId:thread,startedAt:at(1),endedAt:at(12)},
    routerLog:["Switchyard libsy server",`${at(2)} INFO selected_model="switchyard/sol-medium" agent_id="${thread}"`,
      ...[3,4,10].map(second => timing(second,thread,session)),
      ...[0,3,8,16].map(second => timing(second,foreign,foreign,429)),
      `${at(5)} WARN judge verdict unavailable; falling back; parse error agent_id="${foreign}"`].join("\n"),
    routingLog:[...[3,4,10].map(second => JSON.stringify({ts:at(second).replace(".000Z",".000001Z"),session_id:session,model:"switchyard/sol-medium"})),
      JSON.stringify({ts:at(8),session_id:foreign,model:"switchyard/astra-xhigh"})].join("\n")};
  const summary = summarizeSwitchyardCertificationEvidence(input);
  assert.equal(summary.attributed,true); assert.equal(summary.router.total,3); assert.equal(summary.routing.total,3);
  assert.equal(summary.routing.uniqueSessions,1);
  assert.ok(Object.values(summary.failures).every(value => value === 0));
  for (const value of [thread,session,foreign,hash("thread",thread),hash("session",session)]) assert.ok(!JSON.stringify(summary).includes(value));
  const failed = structuredClone(input); failed.routerLog += `\n${at(7)} WARN falling back agent_id="${thread}"`;
  assert.equal(summarizeSwitchyardCertificationEvidence(failed).failures.fallback,1);
  for (const mutate of [
    value => { value.routerLog += "\n" + timing(7,foreign,session); },
    value => { value.routerLog = value.routerLog.replace(`session_sha256=${hash("session",session)}`,""); },
    value => { value.routerLog = value.routerLog.replace(`agent_id="${thread}"`,`agent_id="${foreign}"`); },
  ]) { const invalid = structuredClone(input); mutate(invalid); assert.equal(summarizeSwitchyardCertificationEvidence(invalid).attributed,false); }
  assert.equal(summarizeSwitchyardCertificationEvidence({...input,routingLog:""}).routing.total,0);
});
