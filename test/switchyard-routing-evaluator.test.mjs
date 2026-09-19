import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  allGatesPass,
  requestVector,
  runtimeParity,
  stableProviderBuild,
  validateEvidence,
} from "../scripts/evaluate-switchyard-routing.mjs";

const item = { id: "D01", input: "Continue." };
const root = path.resolve(import.meta.dirname, "..");

function decisionBody(overrides = {}) {
  return {
    decision_evidence: {
      source: "type_safe_classifier",
      label: "astra_xhigh",
      final_target: "astra_xhigh",
      confidence: 0.7,
      probabilities: {
        luna_max: 0.1,
        sol_medium: 0.1,
        astra_medium: 0.1,
        astra_xhigh: 0.7,
      },
      provider_model: "typesafe/jev-1.13-test",
      decision_latency_ms: 8,
      ...overrides,
    },
  };
}

test("low-confidence fail-open is a measured vector and receives no retry", async () => {
  let calls = 0;
  const body = decisionBody({
    source: "fail_open",
    reason_code: "low_confidence",
    final_target: "sol_medium",
    confidence: 0.3,
    probabilities: {
      luna_max: 0.2,
      sol_medium: 0.2,
      astra_medium: 0.25,
      astra_xhigh: 0.35,
    },
  });
  const result = await requestVector("http://local", "cap", item, 1, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.vector.measurementKind, "low_confidence");
  assert.equal(result.vector.rawSelected, "astra_xhigh");
  assert.equal(result.vector.runtimeFinalTarget, "sol_medium");
});

test("malformed vectors fail without consuming a retry", async () => {
  let calls = 0;
  await assert.rejects(
    requestVector("http://local", "cap", item, 1, {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(decisionBody({ probabilities: { sol_medium: 1 } })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    /incomplete probability map/u,
  );
  assert.equal(calls, 1);
});

test("transport timeout and retryable status each use the single retry", async () => {
  for (const first of [
    () => { throw Object.assign(new Error("late"), { name: "TimeoutError" }); },
    () => new Response(null, { status: 503 }),
  ]) {
    let calls = 0;
    const result = await requestVector("http://local", "cap", item, 1, {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return first();
        return new Response(JSON.stringify(decisionBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.attempts.length, 2);
  }
});

test("full-body latency includes response parsing", async () => {
  const response = {
    ok: true,
    status: 200,
    async json() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return decisionBody();
    },
  };
  const result = await requestVector("http://local", "cap", item, 0, {
    fetchImpl: async () => response,
  });
  assert.ok(result.vector.fullBodyLatencyMs >= 20);
});

test("expected local fallback is admitted separately from provider vectors", () => {
  const mediaItem = {
    id: "M01",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    }],
  };
  const vector = validateEvidence(mediaItem, { ok: true, status: 200 }, {
    decision_evidence: {
      source: "fail_open",
      reason_code: "non_text_state",
      final_target: "sol_medium",
    },
  }, 1);
  assert.equal(vector.measurementKind, "local_fallback");
  assert.equal(vector.providerModel, null);
  assert.throws(
    () => validateEvidence(item, { ok: true, status: 200 }, {
      decision_evidence: {
        source: "fail_open",
        reason_code: "non_text_state",
        final_target: "sol_medium",
      },
    }, 1),
    /unexpected local fallback/u,
  );
});

test("runtime parity, provider stability, and promotion gates are behavioral", () => {
  const vector = {
    id: "B1",
    measurementKind: "low_confidence",
    rawSelected: "astra_xhigh",
    confidence: 0.3,
    runtimeFinalTarget: "sol_medium",
    providerModel: "typesafe/jev-1.13-test",
  };
  assert.equal(runtimeParity([{ id: "B1" }], [vector], 0.35).passed, true);
  assert.equal(runtimeParity([{ id: "B1" }], [{ ...vector, runtimeFinalTarget: "astra_medium" }], 0.35).passed, false);
  assert.deepEqual(stableProviderBuild([vector]), {
    passed: true,
    builds: ["typesafe/jev-1.13-test"],
  });
  assert.equal(stableProviderBuild([
    vector,
    { ...vector, id: "B2", providerModel: "typesafe/jev-1.13-other" },
  ]).passed, false);

  assert.equal(allGatesPass({ semantic: true, runtimeParity: false }), false);
  assert.equal(allGatesPass({ semantic: true, runtimeParity: true }), true);
});

test("C2 review evidence binds the repaired evaluator and every frozen gate", () => {
  const evidence = JSON.parse(readFileSync(
    path.join(root, "docs", "switchyard-c2-r1-evidence.json"),
    "utf8",
  ));
  const evaluatorHash = createHash("sha256").update(readFileSync(
    path.join(root, "docs", "history", "2026-09-18-switchyard-c2-evaluator.mjs"),
  )).digest("hex");
  const predecessorHash = createHash("sha256").update(readFileSync(
    path.join(root, "docs", "switchyard-c2-evidence.json"),
  )).digest("hex");
  const canonicalTemplate = readFileSync(
    path.join(root, "config", "switchyard", "routes.template.toml"),
    "utf8",
  );
  const canonicalConfigHash = createHash("sha256").update(canonicalTemplate.replace(
    "__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__",
    "http://127.0.0.1:1/v1",
  )).digest("hex");
  assert.equal(evidence.status, "c2_gates_passed");
  assert.equal(evidence.promotionEligible, true);
  assert.equal(evidence.identities.evaluatorSha256, evaluatorHash);
  assert.equal(evidence.identities.genericConfigSha256, canonicalConfigHash);
  assert.equal(evidence.predecessorEvidence.sha256, predecessorHash);
  assert.equal(evidence.paidDecisionRequests, 80);
  assert.equal(evidence.development.selectedCriteria, "genericCandidate");
  assert.equal(evidence.development.selectedPolicy, "A");
  assert.equal(evidence.development.boundaryPolicyChanges.length, 0);
  assert.equal(evidence.counterfactualAssessment.answerCallsMade, 0);
  assert.ok(Object.values(evidence.gateResults).every(Boolean));
  const attempts = Object.values(evidence.runs)
    .flatMap((run) => run.attempts)
    .flatMap((entry) => entry.attempts);
  assert.equal(attempts.length, 80);
  assert.ok(attempts.every((attempt) => attempt.attempt === 0));
  assert.equal(attempts.filter((attempt) => attempt.reasonCode === "low_confidence").length, 2);
});
