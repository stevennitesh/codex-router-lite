import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  allGatesPass,
  applyPolicy,
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
        sol_high: 0.1,
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
    final_target: "sol_high",
    confidence: 0.3,
    probabilities: {
      luna_max: 0.2,
      sol_high: 0.2,
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
  assert.equal(result.vector.runtimeFinalTarget, "sol_high");
});

test("malformed vectors fail without consuming a retry", async () => {
  let calls = 0;
  await assert.rejects(
    requestVector("http://local", "cap", item, 1, {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(decisionBody({ probabilities: { sol_high: 1 } })), {
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

test("paid vectors use the authenticated decision endpoint and fixed request contract", async () => {
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
    fetchImpl: async (url, options) => {
      sent = { url, method: options.method, headers: new Headers(options.headers), body: JSON.parse(options.body) };
      return new Response(JSON.stringify(decisionBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(sent.url, "http://local/v1/decision");
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.get("content-type"), "application/json");
  assert.equal(sent.headers.get("x-codex-router-switchyard-capability"), "cap");
  assert.deepEqual(sent.body, {
    input_format: "openai_responses",
    request: {
      model: "switchyard-auto",
      input: item.input,
      store: false,
      stream: false,
    },
  });
});

test("ordinary paid corpus validation does not require fidelity fixtures", () => {
  const caseBase = {
    input: "Synthetic request",
    expected: "sol_high",
    acceptable: ["sol_high"],
    severity: "normal",
  };
  const corpus = {
    schemaVersion: 1,
    privateData: false,
    labels: ["luna_max", "sol_high", "astra_medium", "astra_xhigh"],
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
      final_target: "sol_high",
    },
  }, 1);
  assert.equal(vector.measurementKind, "local_fallback");
  assert.equal(vector.providerModel, null);
  assert.throws(
    () => validateEvidence(item, { ok: true, status: 200 }, {
      decision_evidence: {
        source: "fail_open",
        reason_code: "non_text_state",
        final_target: "sol_high",
      },
    }, 1),
    /unexpected local fallback/u,
  );
});

test("expected zero-call fallbacks enforce Sol High independently of quality scores and retries", async () => {
  for (const reason of ["non_text_state", "state_too_large"]) {
    const fixture = reason === "non_text_state" ? {
      id: "media", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "synthetic" }] }],
    } : { ...item, expectedLocalFallbackReasons: [reason] };
    for (const target of ["sol_high", "luna_max", "astra_medium", "astra_xhigh"]) {
      let calls = 0;
      const request = requestVector("http://local", "synthetic", fixture, 1, {
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ decision_evidence: { source: "fail_open", reason_code: reason, final_target: target } }));
        },
      });
      if (target === "sol_high") assert.equal((await request).vector.measurementKind, "local_fallback");
      else await assert.rejects(request, /local fallback must use sol_high/u);
      assert.equal(calls, 1);
      const vector = { id: fixture.id, measurementKind: "local_fallback", runtimeFinalTarget: target };
      assert.equal(applyPolicy(vector, 0.35), "sol_high");
      assert.equal(runtimeParity([fixture], [vector], 0.35).passed, target === "sol_high");
    }
  }
});

test("media fallback follows the latest genuine explicit user task without changing input", async () => {
  const message = content => ({ type: "message", role: "user", content });
  const media = message([{ type: "input_image", image_url: "data:image/png;base64,AA==" }]);
  const text = message([{ type: "input_text", text: "Current text task." }]);
  const blank = message([{ type: "input_text", text: "  \n\t" }]);
  const body = { decision_evidence: { source: "fail_open", reason_code: "non_text_state", final_target: "sol_high" } };
  const corpus = JSON.parse(readFileSync(path.join(root, "docs/switchyard-routing-corpus.json"), "utf8"));
  assertCorpus(corpus, { requireFidelity: true });
  const authored = corpus.fidelity.filter(sample => /^F(?:09|10|11)-/u.test(sample.id));
  assert.equal(authored.length, 3);
  for (const [input, expected] of [
    [[media], true], [[media, message([])], true], [[media, blank], true],
    [[text, media, message([]), blank], true], [[media, text, blank], false],
    [[message([]), blank], false],
    ...authored.map(sample => [sample.input, sample.expectedZeroCalls === true]),
  ]) {
    const sample = { id: "media-control", input, expected: "sol_high", acceptable: ["sol_high"], severity: "normal" };
    let sent, calls = 0;
    const request = requestVector("http://local", "synthetic", sample, 1, {
      fetchImpl: async (_url, options) => {
        calls++;
        sent = JSON.parse(options.body).request.input;
        return new Response(JSON.stringify(body));
      },
    });
    if (expected) {
      const { vector } = await request;
      assert.equal(vector.measurementKind, "local_fallback");
      const diagnostics = routingDiagnostics([sample], [vector], 0.35);
      assert.equal(diagnostics.currentPolicy.classifierMeasured, 0);
      assert.equal(diagnostics.probabilities.multiclassBrierExact, null);
    } else {
      await assert.rejects(request, /unexpected local fallback/u);
      const measured = await requestVector("http://local", "synthetic", sample, 0, {
        fetchImpl: async () => new Response(JSON.stringify(decisionBody())),
      });
      assert.equal(measured.vector.measurementKind, "classifier");
    }
    assert.equal(calls, 1);
    assert.deepEqual(sent, input);
  }
});

test("runtime parity, provider stability, and promotion gates are behavioral", () => {
  const vector = {
    id: "B1",
    measurementKind: "low_confidence",
    rawSelected: "astra_xhigh",
    confidence: 0.3,
    runtimeFinalTarget: "sol_high",
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
    { id: "C", expected: "sol_high", acceptable: ["sol_high"], severity: "normal" },
    { id: "D", expected: "astra_medium", acceptable: ["sol_high", "astra_medium"], severity: "normal" },
  ];
  const vector = (id, rawSelected, confidence, probabilities) => ({
    id,
    measurementKind: confidence < 0.35 ? "low_confidence" : "classifier",
    rawSelected,
    confidence,
    probabilities,
    runtimeFinalTarget: confidence < 0.35 ? "sol_high" : rawSelected,
    providerModel: "typesafe/jev-1.13-test",
  });
  const vectors = [
    vector("A", "luna_max", 0.9, {
      luna_max: 0.85, sol_high: 0.05, astra_medium: 0.05, astra_xhigh: 0.05,
    }),
    vector("B", "sol_high", 0.8, {
      luna_max: 0.05, sol_high: 0.7, astra_medium: 0.15, astra_xhigh: 0.1,
    }),
    vector("C", "astra_xhigh", 0.7, {
      luna_max: 0.05, sol_high: 0.1, astra_medium: 0.15, astra_xhigh: 0.7,
    }),
    vector("D", "astra_medium", 0.3, {
      luna_max: 0.1, sol_high: 0.15, astra_medium: 0.55, astra_xhigh: 0.2,
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
  assert.equal(diagnostics.rawConfusion.astra_xhigh.sol_high, 1);
  assert.equal(diagnostics.finalConfusion.astra_medium.sol_high, 1);
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

test("offline fidelity binds both source patches and keeps its Rust fixture offline", () => {
  const lockBytes = readFileSync(path.join(root, "config", "switchyard", "source.lock"));
  const contributionBytes = readFileSync(path.join(
    root, "config", "switchyard", "patches", "switchyard-typesafe-pr-762.patch",
  ));
  const patchBytes = readFileSync(path.join(
    root, "config", "switchyard", "patches", "switchyard-codex-compat.patch",
  ));
  const lock = verifyFidelitySourceInputs(lockBytes, contributionBytes, patchBytes);
  assert.deepEqual(lock, JSON.parse(lockBytes.toString("utf8")));
  assert.throws(
    () => verifyFidelitySourceInputs(lockBytes, Buffer.concat([contributionBytes, Buffer.from("changed")]), patchBytes),
    /does not bind the upstream contribution patch/u,
  );
  assert.throws(
    () => verifyFidelitySourceInputs(lockBytes, contributionBytes, Buffer.concat([patchBytes, Buffer.from("changed")])),
    /does not bind the compatibility patch/u,
  );
  const fixture = readFileSync(path.join(
    root, "scripts", "fixtures", "switchyard-input-fidelity.rs",
  ), "utf8");
  assert.doesNotMatch(fixture, /OPENROUTER|api_key|reqwest/u);
});
