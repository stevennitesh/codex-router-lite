import assert from "node:assert/strict";
import test from "node:test";

import { summarizeSwitchyardTrace } from "../src/switchyard-trace.mjs";

test("Switchyard trace summarizes only the latest generation without raw identifiers", () => {
  const summary = summarizeSwitchyardTrace([
    "old agent_id=\"old-secret-looking-id\" status=400",
    "Switchyard libsy server",
    "2026-09-04T05:10:06.453Z INFO agent_id=\"agent-one\" correlation_id=\"agent-one\" consulting llm judge",
    "2026-09-04T05:10:07Z INFO evidence.source=\"type_safe_classifier\" evidence.provider_model=\"typesafe/jev-1.13-20260917\" evidence.final_target=\"sol_medium\" evidence.policy_hash=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\" evidence.confidence=0.82 evidence.threshold=0.35 evidence.decision_latency_ms=210 evidence.probability_luna_max=0.08 evidence.probability_sol_medium=0.82 evidence.probability_astra_medium=0.07 evidence.probability_astra_xhigh=0.03",
    "[codex-router] timing at=2026-09-04T05:10:10.376Z model=gpt-5.6-luna provider=openai status=200 total_ms=3922",
    "2026-09-04T05:10:11.274Z INFO LLM request handled wire_format=openai_responses status=200 selected_model=\"switchyard/luna-high\" agent_id=\"agent-one\" correlation_id=\"agent-one\" error=\"\"",
    "[codex-router] timing at=2026-09-04T05:10:15.031Z model=switchyard/auto provider=switchyard status=200 total_ms=8584",
  ].join("\n"));

  assert.equal(summary.generationFound, true);
  assert.equal(summary.classifierConsultations, 1);
  assert.deepEqual(summary.classifier, {
    decisions: 1,
    fallbacks: 0,
    providerModels: { "typesafe/jev-1.13-20260917": 1 },
    finalTargets: { sol_medium: 1 },
    policyHashes: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 1 },
    latency: { count: 1, maximumMs: 210 },
    recent: [{
      at: "2026-09-04T05:10:07Z",
      source: "type_safe_classifier",
      providerModel: "typesafe/jev-1.13-20260917",
      finalTarget: "sol_medium",
      policyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      confidence: 0.82,
      threshold: 0.35,
      decisionLatencyMs: 210,
      probabilities: { luna_max: 0.08, sol_medium: 0.82, astra_medium: 0.07, astra_xhigh: 0.03 },
    }],
  });
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

test("Switchyard trace reads the candidate's emitted bounded evidence event", () => {
  const summary = summarizeSwitchyardTrace([
    "Switchyard libsy server",
    "2026-09-18T21:09:40Z INFO libsy.run: routing decision evidence evidence_source=\"type_safe_classifier\" evidence_provider_model=\"typesafe/jev-1.13-20260917\" evidence_final_target=\"astra_xhigh\" evidence_policy_hash=\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\" evidence_reason_code=\"selected\" evidence_confidence=0.81 evidence_threshold=0.35 evidence_decision_latency_ms=202 evidence_probability_luna_max=0.02 evidence_probability_sol_medium=0.05 evidence_probability_astra_medium=0.12 evidence_probability_astra_xhigh=0.81",
  ].join("\n"));

  assert.equal(summary.classifier.decisions, 1);
  assert.deepEqual(summary.classifier.providerModels, { "typesafe/jev-1.13-20260917": 1 });
  assert.deepEqual(summary.classifier.finalTargets, { astra_xhigh: 1 });
  assert.equal(summary.classifier.recent[0].confidence, 0.81);
  assert.deepEqual(summary.classifier.recent[0].probabilities, {
    luna_max: 0.02,
    sol_medium: 0.05,
    astra_medium: 0.12,
    astra_xhigh: 0.81,
  });
});

test("Switchyard trace fails closed when no service generation marker exists", () => {
  assert.deepEqual(summarizeSwitchyardTrace("status=200"), {
    version: 1,
    generationFound: false,
  });
});
