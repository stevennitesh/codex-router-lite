import assert from "node:assert/strict";
import test from "node:test";

import { summarizeSwitchyardTrace } from "../src/switchyard-trace.mjs";

test("Switchyard trace summarizes only the latest generation without raw identifiers", () => {
  const summary = summarizeSwitchyardTrace([
    "old agent_id=\"old-secret-looking-id\" status=400",
    "Switchyard libsy server",
    "2026-09-04T05:10:06.453Z INFO agent_id=\"agent-one\" correlation_id=\"agent-one\" consulting llm judge",
    "[codex-router] timing at=2026-09-04T05:10:10.376Z model=gpt-5.6-luna provider=openai status=200 total_ms=3922",
    "2026-09-04T05:10:11.274Z INFO LLM request handled wire_format=openai_responses status=200 selected_model=\"switchyard/luna-high\" agent_id=\"agent-one\" correlation_id=\"agent-one\" error=\"\"",
    "[codex-router] timing at=2026-09-04T05:10:15.031Z model=switchyard/auto provider=switchyard status=200 total_ms=8584",
  ].join("\n"));

  assert.equal(summary.generationFound, true);
  assert.equal(summary.classifierConsultations, 1);
  assert.deepEqual(summary.routedRequests, { total: 1, statuses: { 200: 1 } });
  assert.deepEqual(summary.nativeOpenAIRequests, {
    total: 1,
    statuses: { 200: 1 },
    scope: "all native OpenAI timings since this Switchyard generation started",
  });
  assert.deepEqual(summary.switchyardServerRequests, { total: 1, statuses: { 200: 1 } });
  assert.deepEqual(summary.selectedTargets, { "switchyard/luna-high": 1 });
  assert.deepEqual(summary.failures, {
    http: 0,
    nonEmptyServerErrors: 0,
    judgeUnavailable: 0,
    parseErrors: 0,
    fallback: 0,
  });
  assert.deepEqual(summary.continuity, { uniqueAgentIds: 1, uniqueCorrelationIds: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /agent-one|old-secret-looking-id/u);
});

test("Switchyard trace reports actionable failure classes without copying log text", () => {
  const summary = summarizeSwitchyardTrace([
    "Switchyard libsy server",
    "2026-09-04T05:10:06Z judge verdict unavailable: failed to parse response, falling back",
    "2026-09-04T05:10:07Z LLM request handled wire_format=openai_responses status=400 error=\"Input must be a list\"",
  ].join("\n"));

  assert.equal(summary.failures.http, 1);
  assert.equal(summary.failures.nonEmptyServerErrors, 1);
  assert.equal(summary.failures.judgeUnavailable, 1);
  assert.equal(summary.failures.parseErrors, 1);
  assert.equal(summary.failures.fallback, 1);
  assert.doesNotMatch(JSON.stringify(summary), /Input must be a list/u);
});

test("Switchyard trace fails closed when no service generation marker exists", () => {
  assert.deepEqual(summarizeSwitchyardTrace("status=200"), {
    version: 1,
    generationFound: false,
  });
});
