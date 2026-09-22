import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSwitchyardUsageReport,
  summarizeSwitchyardTrace,
  summarizeSwitchyardUsage,
} from "../src/switchyard-trace.mjs";

test("Switchyard trace summarizes only the latest generation without raw identifiers", () => {
  const summary = summarizeSwitchyardTrace([
    "old agent_id=\"old-secret-looking-id\" status=400",
    "Switchyard libsy server",
    "2026-09-04T05:10:06.453Z INFO agent_id=\"agent-one\" correlation_id=\"agent-one\" consulting llm judge",
    "2026-09-04T05:10:07Z INFO evidence.source=\"type_safe_classifier\" evidence.provider_model=\"typesafe/jev-1.13-20260917\" evidence.final_target=\"sol_medium\" evidence.confidence=0.82 evidence.threshold=0.35 evidence.decision_latency_ms=210 evidence.probability_luna_max=0.08 evidence.probability_sol_medium=0.82 evidence.probability_astra_medium=0.07 evidence.probability_astra_xhigh=0.03",
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
    latency: { count: 1, maximumMs: 210 },
    recent: [{
      at: "2026-09-04T05:10:07Z",
      source: "type_safe_classifier",
      providerModel: "typesafe/jev-1.13-20260917",
      finalTarget: "sol_medium",
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
    "2026-09-18T21:09:40Z INFO libsy.run: routing decision evidence evidence_source=\"type_safe_classifier\" evidence_provider_model=\"typesafe/jev-1.13-20260917\" evidence_final_target=\"astra_xhigh\" evidence_reason_code=\"selected\" evidence_confidence=0.81 evidence_threshold=0.35 evidence_decision_latency_ms=202 evidence_probability_luna_max=0.02 evidence_probability_sol_medium=0.05 evidence_probability_astra_medium=0.12 evidence_probability_astra_xhigh=0.81",
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

test("Switchyard trace retains the sanitized empty-state fallback reason", () => {
  const summary = summarizeSwitchyardTrace([
    "Switchyard libsy server",
    "2026-09-19T05:00:00Z INFO libsy.run: routing decision evidence evidence_source=\"fail_open\" evidence_final_target=\"sol_medium\" evidence_reason_code=\"empty_state\" evidence_confidence=0 evidence_threshold=0.35 evidence_decision_latency_ms=0",
  ].join("\n"));

  assert.equal(summary.classifier.decisions, 1);
  assert.equal(summary.classifier.fallbacks, 1);
  assert.equal(summary.classifier.recent[0].reasonCode, "empty_state");
  assert.equal(summary.classifier.recent[0].finalTarget, "sol_medium");
});

test("Switchyard trace fails closed when no service generation marker exists", () => {
  assert.deepEqual(summarizeSwitchyardTrace("status=200"), {
    version: 1,
    generationFound: false,
  });
});

test("routing usage keeps mixed accounting partial, bounded, and identifier-free", () => {
  const privateSessionA = "private-session-alpha";
  const privateSessionB = "private-session-beta";
  const hostile = "hostile-model-string-do-not-copy";
  const log = [
    { ts: "2026-09-21T01:00:00Z", session_id: privateSessionA, model: "switchyard/sol-medium", algorithm: "type_safe_task_classifier", prompt_tokens: 10, cached_tokens: 4, cache_creation_tokens: 2, completion_tokens: 3, reasoning_tokens: 2, total_tokens: 13, tier: "" },
    { ts: "2026-09-21T01:01:00Z", session_id: privateSessionB, model: "switchyard/astra-xhigh", algorithm: "type_safe_task_classifier", prompt_tokens: 20, cached_tokens: 0, completion_tokens: 5, reasoning_tokens: 4, total_tokens: 25 },
    { ts: "2026-09-21T01:02:00Z", session_id: privateSessionA, model: hostile, algorithm: "evil-algorithm", fallback_reason: "secret-reason", prompt_tokens: 7, cached_tokens: "bad", completion_tokens: 0, reasoning_tokens: 1, total_tokens: 7 },
    { ts: "not-a-time", session_id: privateSessionA, model: "switchyard/luna-max", prompt_tokens: 999 },
    { ts: "2026-09-21T01:03:00Z", model: "switchyard/astra-medium", prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  ].map((record) => JSON.stringify(record));
  log.splice(3, 0, "not json and private payload");

  const report = summarizeSwitchyardUsage(log.join("\n"), {
    since: "2026-09-21T01:00:30Z",
    until: "2026-09-21T01:03:00Z",
    limit: 2,
  });
  assert.equal(report.coverage.totalLines, 6);
  assert.equal(report.coverage.parsedRecords, 5);
  assert.equal(report.coverage.malformedLines, 1);
  assert.equal(report.coverage.selectedRecords, 3);
  assert.equal(report.coverage.recordsOutsideSelection, 2);
  assert.equal(report.coverage.excludedWithoutValidTimestamp, 1);
  assert.equal(report.targets.astraXhigh.records, 1);
  assert.equal(report.targets.astraMedium.records, 1);
  assert.equal(report.targets.unknown.records, 1);
  assert.deepEqual(report.algorithms, { type_safe_task_classifier: 1, unknown: 2 });
  assert.deepEqual(report.fallbackReasons, { unknown: 1 });
  assert.deepEqual(report.usage.promptTokens, {
    recordedSum: 28,
    validRecords: 3,
    missingRecords: 0,
    invalidRecords: 0,
    explicitZeroRecords: 0,
  });
  assert.deepEqual(report.usage.cachedTokens, {
    recordedSum: 0,
    validRecords: 1,
    missingRecords: 1,
    invalidRecords: 1,
    explicitZeroRecords: 1,
  });
  assert.equal(report.usage.completionTokens.recordedSum, 6);
  assert.equal(report.usage.reasoningTokens.recordedSum, 5);
  assert.equal(report.sessions.length, 2);
  assert.equal(report.sessionsOmitted, 1);
  const rendered = JSON.stringify(report);
  assert.doesNotMatch(rendered, /private-session|hostile-model|string-do-not-copy|secret-reason|private payload/u);
  assert.match(rendered, /Failed streaming attempts may have no routing record/u);
});

test("explicit session selection uses a local ordinal and does not infer outcomes", () => {
  const report = summarizeSwitchyardUsage([
    JSON.stringify({ ts: "2026-09-21T01:00:00Z", session_id: "chosen-private", model: "switchyard/luna-max", prompt_tokens: 4 }),
    JSON.stringify({ ts: "2026-09-21T01:00:01Z", session_id: "other-private", model: "switchyard/sol-medium", prompt_tokens: 100 }),
  ].join("\n"), { sessionId: "chosen-private" });
  assert.equal(report.coverage.selectedRecords, 1);
  assert.equal(report.sessions[0].label, "selected-session");
  assert.equal(report.usage.promptTokens.recordedSum, 4);
  assert.equal(report.selection.taskBoundary, "user-selected segment; no task boundary or outcome inferred");
  assert.doesNotMatch(JSON.stringify(report), /chosen-private|other-private/u);
});

test("usage report keeps generation diagnostics separate from serving records", () => {
  const report = buildSwitchyardUsageReport(
    JSON.stringify({ ts: "2026-09-21T01:00:00Z", session_id: "private", model: "switchyard/sol-medium" }),
    [
      "Switchyard libsy server",
      "2026-09-21T01:00:00Z INFO libsy.run: routing decision evidence evidence_source=\"type_safe_classifier\" evidence_provider_model=\"typesafe/jev-1.13-safe-build\" evidence_final_target=\"astra_medium\"",
      "2026-09-21T01:00:01Z INFO libsy.run: routing decision evidence evidence_source=\"fail_open\" evidence_provider_model=\"hostile-provider-string\" evidence_final_target=\"hostile-target-string\" evidence_reason_code=\"hostile-reason-string\"",
      "2026-09-21T01:00:02Z INFO LLM request handled wire_format=openai_responses status=200 selected_model=\"hostile-selected-string\" error=\"\"",
    ].join("\n"),
  );
  assert.equal(report.coverage.selectedRecords, 1);
  assert.equal(report.generationDiagnostics.classifier.fallbacks, 1);
  assert.deepEqual(report.generationDiagnostics.classifier.providerModels, { jev113: 1, unknown: 1 });
  assert.deepEqual(report.generationDiagnostics.classifier.finalTargets, { astra_medium: 1, unknown: 1 });
  assert.deepEqual(report.generationDiagnostics.selectedTargets, { unknown: 1 });
  assert.equal(report.generationDiagnostics.classifier.recent[0].providerModel, "jev-1.13 build");
  assert.equal(report.generationDiagnostics.classifier.recent[1].reasonCode, "unknown");
  assert.match(report.generationDiagnostics.scope, /unassociated/u);
  assert.equal(report.policyProvenance.routingRecords, "unavailable");
  assert.doesNotMatch(JSON.stringify(report), /hostile-provider|hostile-target|hostile-reason|hostile-selected/u);
});

test("usage report rejects invalid time and detail selections", () => {
  assert.throws(() => summarizeSwitchyardUsage("", { since: "yesterday" }), /ISO-8601/u);
  assert.throws(() => summarizeSwitchyardUsage("", {
    since: "2026-09-22T00:00:00Z",
    until: "2026-09-21T00:00:00Z",
  }), /must not be after/u);
  assert.throws(() => summarizeSwitchyardUsage("", { limit: 51 }), /1 through 50/u);
});

test("usage report canonicalizes parseable timestamps and tolerates malformed model metadata", () => {
  const report = summarizeSwitchyardUsage(JSON.stringify({
    ts: "Mon, 21 Sep 2026 01:00:00 GMT (PRIVATE-MARKER)",
    session_id: "private-session",
    model: { toString: null },
  }), {
    since: "Mon, 21 Sep 2026 00:59:00 GMT (PRIVATE-SELECTION)",
    until: "Mon, 21 Sep 2026 01:01:00 GMT (PRIVATE-SELECTION)",
  });
  assert.equal(report.coverage.selectedRecords, 1);
  assert.equal(report.targets.unknown.records, 1);
  assert.equal(report.selection.since, "2026-09-21T00:59:00.000Z");
  assert.equal(report.selection.until, "2026-09-21T01:01:00.000Z");
  assert.equal(report.sessions[0].since, "2026-09-21T01:00:00.000Z");
  assert.equal(report.sessions[0].until, "2026-09-21T01:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|private-session/u);
});
