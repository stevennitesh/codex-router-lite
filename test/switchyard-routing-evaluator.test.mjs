import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  allGatesPass,
  assertCorpus,
  requestVector,
  routingDiagnostics,
  runtimeParity,
  stableProviderBuild,
  validateEvidence,
  verifyFidelitySourceInputs,
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

test("paid vectors retain their fixed request contract", async () => {
  let sent;
  await requestVector("http://local", "cap", {
    ...item,
    requestFields: {
      model: "hostile-model",
      input: "hostile-input",
      store: true,
      stream: true,
    },
  }, 0, {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body).request;
      return new Response(JSON.stringify(decisionBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(sent, {
    model: "switchyard-auto",
    input: item.input,
    store: false,
    stream: false,
  });
});

test("ordinary paid corpus validation does not require fidelity fixtures", () => {
  const caseBase = {
    input: "Synthetic request",
    expected: "sol_medium",
    acceptable: ["sol_medium"],
    severity: "normal",
  };
  const corpus = {
    schemaVersion: 1,
    privateData: false,
    labels: ["luna_max", "sol_medium", "astra_medium", "astra_xhigh"],
    development: [{ ...caseBase, id: "D01" }],
    holdout: [{ ...caseBase, id: "H01" }],
    gates: { maximumRetriesPerRequest: 1, minimumAcceptablePerSplit: 1 },
  };
  assert.doesNotThrow(() => assertCorpus(corpus));
  assert.doesNotThrow(() => assertCorpus({ ...corpus, fidelity: "ignored paid-path metadata" }));
  assert.throws(
    () => assertCorpus(corpus, { requireFidelity: true }),
    /requires synthetic fidelity cases/u,
  );
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

test("routing diagnostics expose selective risk without treating confidence as calibrated", () => {
  const items = [
    { id: "A", expected: "luna_max", acceptable: ["luna_max"], severity: "normal" },
    { id: "B", expected: "astra_xhigh", acceptable: ["astra_medium", "astra_xhigh"], severity: "severe" },
    { id: "C", expected: "sol_medium", acceptable: ["sol_medium"], severity: "normal" },
    { id: "D", expected: "astra_medium", acceptable: ["sol_medium", "astra_medium"], severity: "normal" },
  ];
  const vector = (id, rawSelected, confidence, probabilities) => ({
    id,
    measurementKind: confidence < 0.35 ? "low_confidence" : "classifier",
    rawSelected,
    confidence,
    probabilities,
    runtimeFinalTarget: confidence < 0.35 ? "sol_medium" : rawSelected,
    providerModel: "typesafe/jev-1.13-test",
  });
  const vectors = [
    vector("A", "luna_max", 0.9, {
      luna_max: 0.85, sol_medium: 0.05, astra_medium: 0.05, astra_xhigh: 0.05,
    }),
    vector("B", "sol_medium", 0.8, {
      luna_max: 0.05, sol_medium: 0.7, astra_medium: 0.15, astra_xhigh: 0.1,
    }),
    vector("C", "astra_xhigh", 0.7, {
      luna_max: 0.05, sol_medium: 0.1, astra_medium: 0.15, astra_xhigh: 0.7,
    }),
    vector("D", "astra_medium", 0.3, {
      luna_max: 0.1, sol_medium: 0.15, astra_medium: 0.55, astra_xhigh: 0.2,
    }),
  ];

  const diagnostics = routingDiagnostics(items, vectors, 0.35, {
    includeThresholdSweep: true,
  });

  assert.equal(diagnostics.interpretation.confidenceCalibratedProbability, false);
  assert.equal(diagnostics.interpretation.candidateOrderStability.available, false);
  assert.equal(diagnostics.currentPolicy.classifierMeasured, 4);
  assert.equal(diagnostics.currentPolicy.fallbackCount, 1);
  assert.equal(diagnostics.currentPolicy.severeUnderRoutes, 1);
  assert.equal(diagnostics.currentPolicy.expensiveOverRoutes, 1);
  assert.equal(diagnostics.rawConfusion.astra_xhigh.sol_medium, 1);
  assert.equal(diagnostics.finalConfusion.astra_medium.sol_medium, 1);
  assert.equal(
    diagnostics.confidenceReliability.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    4,
  );
  assert.ok(Number.isFinite(diagnostics.confidenceReliability.eceExact));
  assert.ok(Number.isFinite(diagnostics.probabilities.multiclassBrierExact));
  assert.ok(Number.isFinite(diagnostics.probabilities.meanTopTwoMargin));
  assert.ok(diagnostics.thresholdSweep.some((entry) => entry.threshold === 0.35));
  assert.ok(diagnostics.thresholdSweep.some((entry) => entry.threshold === 0.5));
});

test("offline fidelity binds the ordered source patches and authored Rust fixture", () => {
  const lockBytes = readFileSync(path.join(root, "config", "switchyard", "source.lock"));
  const contributionBytes = readFileSync(path.join(
    root, "config", "switchyard", "patches", "switchyard-typesafe-pr-762.patch",
  ));
  const patchBytes = readFileSync(path.join(
    root, "config", "switchyard", "patches", "switchyard-codex-compat.patch",
  ));
  const lock = verifyFidelitySourceInputs(lockBytes, contributionBytes, patchBytes);
  assert.equal(lock.commit, "70f277e094981706854f05674da2f2ec939ac443");
  const fixture = readFileSync(path.join(
    root, "scripts", "fixtures", "switchyard-input-fidelity.rs",
  ), "utf8");
  assert.match(fixture, /exact outgoing classifier state/u);
  assert.match(fixture, /expected zero classifier calls/u);
  assert.doesNotMatch(fixture, /OPENROUTER|api_key|reqwest/u);
});

test("C2 review evidence binds the repaired evaluator and every frozen gate", () => {
  const evidence = JSON.parse(readFileSync(
    path.join(root, "docs", "history", "2026-09-18-switchyard-c2-r1-accepted-evidence.json"),
    "utf8",
  ));
  const canonicalTextHash = (file) => createHash("sha256").update(
    readFileSync(file, "utf8").replace(/\r\n?/gu, "\n"),
    "utf8",
  ).digest("hex");
  const evaluatorHash = canonicalTextHash(
    path.join(root, "docs", "history", "2026-09-18-switchyard-c2-evaluator.mjs"),
  );
  const predecessorHash = canonicalTextHash(
    path.join(root, "docs", "history", "2026-09-18-switchyard-c2-r0-failed-evidence.json"),
  );
  const canonicalTemplate = readFileSync(
    path.join(root, "config", "switchyard", "routes.template.toml"),
    "utf8",
  ).replace(/\r\n?/gu, "\n");
  const canonicalConfigSourceHash = createHash("sha256").update(canonicalTemplate.replace(
    "__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__",
    "http://127.0.0.1:1/v1",
  )).digest("hex");
  assert.equal(evidence.status, "c2_gates_passed");
  assert.equal(evidence.promotionEligible, true);
  assert.equal(evidence.identities.evaluatorSha256, evaluatorHash);
  assert.equal(evidence.identities.genericConfigSourceSha256, canonicalConfigSourceHash);
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
