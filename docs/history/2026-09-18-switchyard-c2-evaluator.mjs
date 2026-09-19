import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { resolveProviderCredential } from "../src/provider-credentials.mjs";

const root = path.resolve(import.meta.dirname, "..");
const labels = ["luna_max", "sol_medium", "astra_medium", "astra_xhigh"];
const rank = new Map(labels.map((label, index) => [label, index]));
const acceptedC1Identity = "8b55ddec0621a0b439eaa871548683d426cbae08734a31fadedf4373407a74a5";
const acceptedC1Binary = "06950a63e244e54c22b7cc43eb69afd5ab89ff4cd3caa1a06b5d6343386fd709";
const acceptedC1Patch = "745556b814fee78c898482c38b1b672e95e3eddcc4ff6a1e1a9b4eebd6bdeccb";
const acceptedC1Template = "235c36109e88d44b0c974de6682d8c56972798aecd3ebd4e505c0c6dfe2daabe";
const routesTemplatePath = path.join(root, "config", "switchyard", "routes.template.toml");
const sourceLockPath = path.join(root, "config", "switchyard", "source.lock");
const compatibilityPatchPath = path.join(
  root,
  "config",
  "switchyard",
  "patches",
  "switchyard-codex-compat.patch",
);
const requestTimeoutMs = 8_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function assertFrozenCorpus(corpus) {
  if (corpus.schemaVersion !== 1 || corpus.checkpoint !== "SY-FOLLOWUP-C2") {
    throw new Error("unexpected C2 corpus contract");
  }
  if (corpus.privateData !== false) throw new Error("C2 corpus must declare synthetic-only data");
  if (JSON.stringify(corpus.labels) !== JSON.stringify(labels)) {
    throw new Error("C2 label order changed");
  }
  if (corpus.development?.length !== 20 || corpus.holdout?.length !== 20) {
    throw new Error("C2 requires exactly 20 development and 20 holdout cases");
  }
  if (corpus.development.filter((item) => item.boundary).length !== 6) {
    throw new Error("C2 requires exactly six predeclared development boundary cases");
  }
  const ids = [...corpus.development, ...corpus.holdout].map((item) => item.id);
  if (new Set(ids).size !== 40) throw new Error("C2 case ids must be unique");
  for (const item of [...corpus.development, ...corpus.holdout]) {
    if (!labels.includes(item.expected) || !item.acceptable?.length) {
      throw new Error(`C2 case ${item.id} lacks a valid expectation`);
    }
    if (!item.acceptable.every((label) => labels.includes(label))) {
      throw new Error(`C2 case ${item.id} has an unknown acceptable target`);
    }
    if (!item.input) throw new Error(`C2 case ${item.id} lacks input`);
  }
  if (corpus.gates?.maximumRetriesPerRequest !== 1) {
    throw new Error("C2 permits exactly one predeclared transient retry");
  }
}

function materializedConfig(template, criteria, routerBase) {
  const descriptions = labels
    .map((label) => `${label} = ${JSON.stringify(criteria[label])}`)
    .join(", ");
  let source = template.replace(
    /^candidate_descriptions = .*$/mu,
    `candidate_descriptions = { ${descriptions} }`,
  );
  source = source.replace("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__", routerBase);
  if (source.includes("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__")) {
    throw new Error("candidate config retained a private URL placeholder");
  }
  return source;
}

export function applyPolicy(vector, policy, threshold) {
  if (vector.measurementKind === "local_fallback") return vector.runtimeFinalTarget;
  if (vector.confidence >= threshold) return vector.rawSelected;
  if (policy === "A") return "sol_medium";
  if (vector.rawSelected === "astra_xhigh") return "astra_medium";
  if (vector.rawSelected === "astra_medium") return "astra_medium";
  return "sol_medium";
}

export function score(items, vectors, policy, threshold) {
  const byId = new Map(vectors.map((vector) => [vector.id, vector]));
  const rows = items.map((item) => {
    const vector = byId.get(item.id);
    if (!vector) throw new Error(`missing vector for ${item.id}`);
    const target = applyPolicy(vector, policy, threshold);
    const minimumAcceptableRank = Math.min(...item.acceptable.map((label) => rank.get(label)));
    const underRouteDistance = Math.max(0, minimumAcceptableRank - rank.get(target));
    return {
      id: item.id,
      expected: item.expected,
      acceptable: item.acceptable,
      severity: item.severity,
      rawSelected: vector.rawSelected,
      confidence: vector.confidence,
      finalTarget: target,
      acceptableResult: item.acceptable.includes(target),
      severeUnderRoute: item.severity === "severe" && underRouteDistance > 0,
      underRouteDistance,
    };
  });
  return {
    policy,
    count: rows.length,
    acceptable: rows.filter((row) => row.acceptableResult).length,
    severeUnderRoutes: rows.filter((row) => row.severeUnderRoute).length,
    underRouteDistance: rows.reduce((sum, row) => sum + row.underRouteDistance, 0),
    selectedCounts: Object.fromEntries(
      labels.map((label) => [label, rows.filter((row) => row.finalTarget === label).length]),
    ),
    rows,
  };
}

function pairedRegressions(baseline, candidate) {
  const byId = new Map(candidate.rows.map((row) => [row.id, row]));
  return baseline.rows
    .filter((row) => row.severity !== "severe" && row.acceptableResult && !byId.get(row.id)?.acceptableResult)
    .map((row) => row.id);
}

function latestUserHasNonText(input) {
  if (!Array.isArray(input)) return false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type !== "message" || item.role !== "user") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    return content.some((part) => part?.type !== "input_text");
  }
  return false;
}

function expectedLocalFallback(item, reasonCode) {
  if (reasonCode === "non_text_state") return latestUserHasNonText(item.input);
  return item.expectedLocalFallbackReasons?.includes(reasonCode) === true;
}

export function runtimeParity(items, vectors, policy, threshold) {
  const byId = new Map(vectors.map((vector) => [vector.id, vector]));
  const mismatches = [];
  for (const item of items) {
    const vector = byId.get(item.id);
    if (!vector || vector.measurementKind === "local_fallback") continue;
    const expectedTarget = applyPolicy(vector, policy, threshold);
    if (vector.runtimeFinalTarget !== expectedTarget) {
      mismatches.push({ id: item.id, expectedTarget, runtimeTarget: vector.runtimeFinalTarget });
    }
  }
  return { passed: mismatches.length === 0, mismatches };
}

export function boundaryPolicyChanges(items, baseline, candidate) {
  const boundaryIds = new Set(items.filter((item) => item.boundary).map((item) => item.id));
  return changedSelections(baseline, candidate).filter((change) => boundaryIds.has(change.id));
}

export function stableProviderBuild(vectors) {
  const builds = [...new Set(
    vectors
      .filter((vector) => vector.measurementKind !== "local_fallback")
      .map((vector) => vector.providerModel),
  )];
  return { passed: builds.length === 1, builds };
}

export function selectPolicyB(items, selectedA, selectedB, gates) {
  const policyChanges = changedSelections(selectedA, selectedB);
  const boundaryChanges = boundaryPolicyChanges(items, selectedA, selectedB);
  const policyRegressions = pairedRegressions(selectedA, selectedB);
  const selected =
    boundaryChanges.length >= gates.minimumDevelopmentPolicyDisagreements &&
    selectedB.acceptable > selectedA.acceptable &&
    selectedB.severeUnderRoutes <= gates.maximumSevereUnderRoutes &&
    policyRegressions.length <= gates.maximumPairedNonCriticalRegressions;
  return { selected, policyChanges, boundaryChanges, policyRegressions };
}

export function allGatesPass(gateResults) {
  return Object.values(gateResults).every(Boolean);
}

export function changedSelections(baseline, candidate) {
  const byId = new Map(candidate.rows.map((row) => [row.id, row]));
  return baseline.rows
    .filter((row) => row.finalTarget !== byId.get(row.id)?.finalTarget)
    .map((row) => ({
      id: row.id,
      baseline: row.finalTarget,
      candidate: byId.get(row.id).finalTarget,
      severity: row.severity,
    }));
}

async function openPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitHealthy(base, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("candidate exited before health");
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("candidate did not become healthy");
}

async function withCandidate(binary, configPath, credential, action) {
  const port = await openPort();
  const capability = randomBytes(32).toString("hex");
  const env = {
    ...process.env,
    OPENROUTER_API_KEY: credential,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability,
  };
  const dryRun = spawnSync(
    binary,
    ["--config", configPath, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", windowsHide: true, env },
  );
  if (dryRun.status !== 0) throw new Error("candidate config dry-run failed");
  const child = spawn(
    binary,
    ["--config", configPath, "--host", "127.0.0.1", "--port", String(port)],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env },
  );
  child.stderr.on("data", () => {});
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitHealthy(base, child);
    return await action(base, capability);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

export function validateEvidence(item, response, body, latencyMs, threshold = 0.35) {
  if (!response.ok) throw new Error(`candidate HTTP ${response.status}`);
  const evidence = body?.decision_evidence;
  const reasonCode = evidence?.reason_code;
  if (
    evidence?.source === "fail_open" &&
    ["non_text_state", "state_too_large"].includes(reasonCode)
  ) {
    if (!expectedLocalFallback(item, reasonCode)) {
      throw new Error(`unexpected local fallback ${reasonCode}`);
    }
    if (!labels.includes(evidence.final_target)) throw new Error("invalid local fallback target");
    return {
      id: item.id,
      measurementKind: "local_fallback",
      reasonCode,
      rawSelected: evidence.final_target,
      confidence: 0,
      probabilities: null,
      runtimeFinalTarget: evidence.final_target,
      providerModel: null,
      providerLatencyMs: null,
      fullBodyLatencyMs: latencyMs,
    };
  }
  const measuredLowConfidence = evidence?.source === "fail_open" && reasonCode === "low_confidence";
  if (evidence?.source !== "type_safe_classifier" && !measuredLowConfidence) {
    throw new Error(`classifier source ${evidence?.source || "missing"}`);
  }
  if (!/^typesafe\/jev-1\.13-/u.test(evidence.provider_model || "")) {
    throw new Error("unexpected provider build");
  }
  if (!labels.includes(evidence.label) || !labels.includes(evidence.final_target)) {
    throw new Error("invalid selected target");
  }
  const probabilities = evidence.probabilities || {};
  if (Object.keys(probabilities).sort().join("|") !== [...labels].sort().join("|")) {
    throw new Error("incomplete probability map");
  }
  const sum = labels.reduce((total, label) => {
    const value = probabilities[label];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("invalid probability");
    }
    return total + value;
  }, 0);
  if (Math.abs(sum - 1) > 0.02) throw new Error("invalid probability sum");
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    throw new Error("invalid confidence");
  }
  if (measuredLowConfidence && evidence.confidence >= threshold) {
    throw new Error("low-confidence evidence is not below threshold");
  }
  return {
    id: item.id,
    measurementKind: measuredLowConfidence ? "low_confidence" : "classifier",
    reasonCode: measuredLowConfidence ? "low_confidence" : null,
    rawSelected: evidence.label,
    confidence: evidence.confidence,
    probabilities,
    runtimeFinalTarget: evidence.final_target,
    providerModel: evidence.provider_model,
    providerLatencyMs: evidence.decision_latency_ms,
    fullBodyLatencyMs: latencyMs,
  };
}

export async function requestVector(
  base,
  capability,
  item,
  maxRetries,
  attemptOffset = 0,
  options = {},
) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || requestTimeoutMs;
  const threshold = options.threshold ?? 0.35;
  const attempts = [];
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const started = performance.now();
    let response;
    try {
      response = await fetchImpl(`${base}/v1/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codex-router-switchyard-capability": capability,
          "x-switchyard-session-id": `c2-${item.id}-${attempt + attemptOffset}`,
        },
        body: JSON.stringify({
          input_format: "openai_responses",
          request: { model: "switchyard-auto", input: item.input, store: false, stream: false },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      attempts.push({
        attempt: attempt + attemptOffset,
        status: null,
        errorClass: error instanceof Error ? error.name : "unknown",
        latencyMs: Math.round(performance.now() - started),
      });
      if (attempt >= maxRetries) throw Object.assign(new Error("decision request failed"), { attempts });
      continue;
    }
    attempts.push({ attempt: attempt + attemptOffset, status: response.status });
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxRetries) continue;
      throw Object.assign(new Error(`transient decision HTTP ${response.status}`), { attempts });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      attempts.at(-1).latencyMs = Math.round(performance.now() - started);
      throw Object.assign(new Error("decision response was not JSON"), { attempts });
    }
    const latencyMs = Math.round(performance.now() - started);
    attempts.at(-1).latencyMs = latencyMs;
    const source = body?.decision_evidence?.source;
    const reasonCode = body?.decision_evidence?.reason_code;
    attempts.at(-1).source = source || "missing";
    if (reasonCode) attempts.at(-1).reasonCode = reasonCode;
    if (
      source === "fail_open" &&
      ["classifier_timeout", "classifier_unavailable", "provider_http_error"].includes(reasonCode) &&
      attempt < maxRetries
    ) {
      continue;
    }
    try {
      return { vector: validateEvidence(item, response, body, latencyMs, threshold), attempts };
    } catch (error) {
      error.attempts = attempts;
      throw error;
    }
  }
  throw new Error("decision retry loop exhausted");
}

async function evaluate(binary, items, configPath, credential, maxRetries, retryOverrides = {}) {
  const vectors = [];
  const attempts = [];
  await withCandidate(binary, configPath, credential, async (base, capability) => {
    for (const item of items) {
      let result;
      try {
        const override = retryOverrides[item.id] || {};
        result = await requestVector(
          base,
          capability,
          item,
          override.maxRetries ?? maxRetries,
          override.attemptOffset ?? 0,
          { threshold: override.threshold },
        );
      } catch (error) {
        error.itemId = item.id;
        throw error;
      }
      vectors.push(result.vector);
      attempts.push({ id: item.id, attempts: result.attempts });
    }
  });
  return { vectors, attempts };
}

function publicVectors(vectors) {
  return vectors.map((vector) => ({
    id: vector.id,
    measurementKind: vector.measurementKind,
    reasonCode: vector.reasonCode,
    rawSelected: vector.rawSelected,
    confidence: vector.confidence,
    probabilities: vector.probabilities,
    runtimeFinalTarget: vector.runtimeFinalTarget,
    providerModel: vector.providerModel,
    providerLatencyMs: vector.providerLatencyMs,
    fullBodyLatencyMs: vector.fullBodyLatencyMs,
  }));
}

export async function main(argv = process.argv.slice(2)) {
const binary = path.resolve(argv[0] || "");
const corpusPath = path.resolve(argv[1] || path.join(root, "docs", "switchyard-c2-corpus.json"));
const outputPath = path.resolve(argv[2] || path.join(root, "docs", "switchyard-c2-r1-evidence.json"));
const mode = argv[3] || "evaluate";
if (!argv[0] || !["evaluate", "diagnostic"].includes(mode)) {
  throw new Error(
    "usage: evaluate-switchyard-c2.mjs CANDIDATE_BINARY [CORPUS_JSON] [OUTPUT_JSON] [evaluate|diagnostic]",
  );
}
const corpusBytes = readFileSync(corpusPath);
const corpus = JSON.parse(corpusBytes.toString("utf8"));
assertFrozenCorpus(corpus);
const template = readFileSync(routesTemplatePath, "utf8");
const sourceLockBytes = readFileSync(sourceLockPath);
const patchBytes = readFileSync(compatibilityPatchPath);
const binaryBytes = readFileSync(binary);
if (sha256(binaryBytes) !== acceptedC1Binary) throw new Error("C1 binary identity drifted");
if (sha256(patchBytes) !== acceptedC1Patch) throw new Error("C1 compatibility patch identity drifted");
if (sha256(template) !== acceptedC1Template) throw new Error("C1 route template identity drifted");
if (!template.includes(`question = ${JSON.stringify(corpus.question)}`)) {
  throw new Error("frozen C2 question differs from the C1 decision path");
}
const lockedPatch = JSON.parse(sourceLockBytes.toString("utf8")).patchSha256;
if (lockedPatch !== acceptedC1Patch) throw new Error("C1 source lock no longer binds the patch");
const credential = resolveProviderCredential("openrouter")?.value;
if (!credential) throw new Error("protected OpenRouter credential is unavailable");

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "switchyard-c2-"));
const baselineConfig = materializedConfig(
  template,
  corpus.criteria.c1,
  "http://127.0.0.1:1/v1",
);
const genericConfig = materializedConfig(
  template,
  corpus.criteria.genericCandidate,
  "http://127.0.0.1:1/v1",
);
const baselineConfigPath = path.join(tempRoot, "c1.toml");
const genericConfigPath = path.join(tempRoot, "generic.toml");
writeFileSync(baselineConfigPath, baselineConfig);
writeFileSync(genericConfigPath, genericConfig);

const evidence = {
  schemaVersion: 1,
  checkpoint: "SY-FOLLOWUP-C2",
  status: "predeclared",
  predeclaredAt: new Date().toISOString(),
  syntheticAuthoredCorpus: true,
  independentDataset: false,
  privateDataSent: false,
  productionChanged: false,
  acceptedC1Identity,
  identities: {
    binarySha256: sha256(binaryBytes),
    sourceLockSha256: sha256(sourceLockBytes),
    compatibilityPatchSha256: sha256(patchBytes),
    routesTemplateSha256: sha256(template),
    corpusSha256: sha256(corpusBytes),
    c1ConfigSha256: sha256(baselineConfig),
    genericConfigSha256: sha256(genericConfig),
    c1CriteriaSha256: sha256(JSON.stringify(corpus.criteria.c1)),
    genericCriteriaSha256: sha256(JSON.stringify(corpus.criteria.genericCandidate)),
    evaluatorSha256: sha256(readFileSync(import.meta.filename)),
  },
  frozen: {
    developmentIds: corpus.development.map((item) => item.id),
    holdoutIds: corpus.holdout.map((item) => item.id),
    boundaryIds: corpus.development.filter((item) => item.boundary).map((item) => item.id),
    question: corpus.question,
    policies: corpus.policies,
    gates: corpus.gates,
  },
  runs: {},
  predecessorEvidence: {
    path: "docs/switchyard-c2-evidence.json",
    sha256: "895a2b8d2c9715b0af1561520350c276bc0db8bcb21a2f03bf388a94b250306e",
    interpretation: "historical attempts had source fail_open with an unretained reason; no failure class is inferred",
  },
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);

let activeStage = "c1_development";
try {
  const maxRetries = corpus.gates.maximumRetriesPerRequest;
  if (mode === "diagnostic") {
    activeStage = "d01_diagnostic";
    const diagnostic = await evaluate(
      binary,
      [corpus.development[0]],
      baselineConfigPath,
      credential,
      0,
    );
    evidence.runs.diagnostic = {
      vectors: publicVectors(diagnostic.vectors),
      attempts: diagnostic.attempts,
    };
    evidence.paidDecisionRequests = 1;
    evidence.status = "diagnostic_complete";
    evidence.completedAt = new Date().toISOString();
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  }
  const c1Development = await evaluate(
    binary,
    corpus.development,
    baselineConfigPath,
    credential,
    maxRetries,
  );
  evidence.runs.c1Development = {
    vectors: publicVectors(c1Development.vectors),
    attempts: c1Development.attempts,
  };
  const c1DevelopmentScore = score(
    corpus.development,
    c1Development.vectors,
    "A",
    corpus.policies.threshold,
  );
  evidence.development = { c1: c1DevelopmentScore };
  const c1DevelopmentGate =
    c1DevelopmentScore.acceptable >= corpus.gates.minimumC1AcceptablePerSplit &&
    c1DevelopmentScore.severeUnderRoutes <= corpus.gates.maximumSevereUnderRoutes;
  if (!c1DevelopmentGate) {
    evidence.status = "stopped_c1_development_semantic_gate";
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    throw new Error("C1 failed the predeclared development semantic gate");
  }

  activeStage = "generic_development";
  const genericDevelopment = await evaluate(
    binary,
    corpus.development,
    genericConfigPath,
    credential,
    maxRetries,
  );
  evidence.runs.genericDevelopment = {
    vectors: publicVectors(genericDevelopment.vectors),
    attempts: genericDevelopment.attempts,
  };
  const genericA = score(
    corpus.development,
    genericDevelopment.vectors,
    "A",
    corpus.policies.threshold,
  );
  const criteriaRegressions = pairedRegressions(c1DevelopmentScore, genericA);
  const criteriaSelected =
    genericA.acceptable > c1DevelopmentScore.acceptable &&
    genericA.severeUnderRoutes <= corpus.gates.maximumSevereUnderRoutes &&
    criteriaRegressions.length <= corpus.gates.maximumPairedNonCriticalRegressions;
  const selectedCriteria = criteriaSelected ? "genericCandidate" : "c1";
  const selectedDevelopmentVectors = criteriaSelected
    ? genericDevelopment.vectors
    : c1Development.vectors;
  const selectedA = criteriaSelected ? genericA : c1DevelopmentScore;
  const selectedB = score(
    corpus.development,
    selectedDevelopmentVectors,
    "B",
    corpus.policies.threshold,
  );
  const policyDecision = selectPolicyB(
    corpus.development,
    selectedA,
    selectedB,
    corpus.gates,
  );
  const policyChanges = policyDecision.policyChanges;
  const boundaryChanges = policyDecision.boundaryChanges;
  const policyRegressions = policyDecision.policyRegressions;
  const policyBSelected = policyDecision.selected;
  const selectedPolicy = policyBSelected ? "B" : "A";
  const selectedDevelopmentScore = policyBSelected ? selectedB : selectedA;
  const developmentBuildGate = stableProviderBuild([
    ...c1Development.vectors,
    ...genericDevelopment.vectors,
  ]);
  const selectedRuntimeParity = runtimeParity(
    corpus.development,
    selectedDevelopmentVectors,
    selectedPolicy,
    corpus.policies.threshold,
  );
  const consequentialDevelopmentChanges = changedSelections(
    c1DevelopmentScore,
    selectedDevelopmentScore,
  ).filter((change) => {
    const baselineRow = c1DevelopmentScore.rows.find((row) => row.id === change.id);
    const candidateRow = selectedDevelopmentScore.rows.find((row) => row.id === change.id);
    return change.severity === "severe" ||
      (baselineRow?.acceptableResult && !candidateRow?.acceptableResult) ||
      (candidateRow?.underRouteDistance || 0) > (baselineRow?.underRouteDistance || 0);
  });
  evidence.development = {
    c1: c1DevelopmentScore,
    genericA,
    criteriaRegressions,
    criteriaSelected,
    selectedCriteria,
    selectedA,
    selectedB,
    policyChanges,
    boundaryPolicyChanges: boundaryChanges,
    policyRegressions,
    policyBSelected,
    selectedPolicy,
  };
  evidence.developmentProviderBuilds = developmentBuildGate.builds;
  evidence.developmentRuntimeParity = selectedRuntimeParity;
  evidence.counterfactualAssessment = {
    consequentialChanges: consequentialDevelopmentChanges,
    authorizedMaximumAnswerCalls: 8,
    answerCallsMade: 0,
    resolved: consequentialDevelopmentChanges.length === 0,
  };
  if (corpus.gates.providerBuildMustRemainConstant && !developmentBuildGate.passed) {
    evidence.status = "stopped_development_provider_build_drift";
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    throw new Error("provider build changed during development");
  }
  if (!selectedRuntimeParity.passed) {
    evidence.status = "stopped_candidate_runtime_parity";
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    throw new Error("selected policy does not match the candidate runtime path");
  }
  if (consequentialDevelopmentChanges.length > 0) {
    evidence.status = "stopped_counterfactual_required";
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    throw new Error("consequential development changes require outcome proof before holdout");
  }
  evidence.frozenCandidate = {
    frozenAt: new Date().toISOString(),
    criteria: selectedCriteria,
    policy: selectedPolicy,
    developmentAcceptable: selectedDevelopmentScore.acceptable,
    developmentSevereUnderRoutes: selectedDevelopmentScore.severeUnderRoutes,
  };
  evidence.status = "candidate_frozen_before_holdout";
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);

  activeStage = "c1_holdout";
  const c1Holdout = await evaluate(
    binary,
    corpus.holdout,
    baselineConfigPath,
    credential,
    maxRetries,
  );
  evidence.runs.c1Holdout = {
    vectors: publicVectors(c1Holdout.vectors),
    attempts: c1Holdout.attempts,
  };
  const c1HoldoutScore = score(
    corpus.holdout,
    c1Holdout.vectors,
    "A",
    corpus.policies.threshold,
  );
  const c1HoldoutGate =
    c1HoldoutScore.acceptable >= corpus.gates.minimumC1AcceptablePerSplit &&
    c1HoldoutScore.severeUnderRoutes <= corpus.gates.maximumSevereUnderRoutes;
  evidence.holdout = { c1: c1HoldoutScore };
  if (!c1HoldoutGate) {
    evidence.status = "stopped_c1_holdout_semantic_gate";
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    throw new Error("C1 failed the predeclared holdout semantic gate");
  }

  let candidateHoldout;
  if (criteriaSelected) {
    activeStage = "candidate_holdout";
    candidateHoldout = await evaluate(
      binary,
      corpus.holdout,
      genericConfigPath,
      credential,
      maxRetries,
    );
    evidence.runs.candidateHoldout = {
      vectors: publicVectors(candidateHoldout.vectors),
      attempts: candidateHoldout.attempts,
      reusedC1Vectors: false,
    };
  } else {
    candidateHoldout = c1Holdout;
    evidence.runs.candidateHoldout = {
      vectors: publicVectors(candidateHoldout.vectors),
      attempts: [],
      reusedC1Vectors: true,
    };
  }
  const candidateHoldoutScore = score(
    corpus.holdout,
    candidateHoldout.vectors,
    selectedPolicy,
    corpus.policies.threshold,
  );
  const holdoutRegressions = pairedRegressions(c1HoldoutScore, candidateHoldoutScore);
  const providerBuilds = [...new Set(
    Object.values(evidence.runs)
      .flatMap((run) => run.vectors || [])
      .map((vector) => vector.providerModel),
  )];
  const holdoutChanges = changedSelections(c1HoldoutScore, candidateHoldoutScore);
  evidence.holdout = {
    c1: c1HoldoutScore,
    candidate: candidateHoldoutScore,
    pairedNonCriticalRegressions: holdoutRegressions,
    changedSelections: holdoutChanges,
  };
  evidence.gateResults = {
    completeDevelopment:
      c1Development.vectors.length === 20 && genericDevelopment.vectors.length === 20,
    completeHoldout:
      c1Holdout.vectors.length === 20 && candidateHoldout.vectors.length === 20,
    c1DevelopmentSemantic: c1DevelopmentGate,
    c1HoldoutSemantic: c1HoldoutGate,
    candidateSevereUnderRoutes:
      candidateHoldoutScore.severeUnderRoutes <= corpus.gates.maximumSevereUnderRoutes,
    pairedNonCriticalRegressions:
      holdoutRegressions.length <= corpus.gates.maximumPairedNonCriticalRegressions,
    acceptableTargetCount:
      candidateHoldoutScore.acceptable >= c1HoldoutScore.acceptable,
    providerBuildStable:
      !corpus.gates.providerBuildMustRemainConstant || providerBuilds.length === 1,
    developmentProviderBuildStable:
      !corpus.gates.providerBuildMustRemainConstant || developmentBuildGate.passed,
    selectedRuntimeParity: selectedRuntimeParity.passed,
    counterfactualConcernsResolved: evidence.counterfactualAssessment.resolved,
  };
  evidence.providerBuilds = providerBuilds;
  evidence.counterfactualCandidates = holdoutChanges.filter((item) => item.severity === "severe");
  evidence.paidDecisionRequests = Object.values(evidence.runs)
    .flatMap((run) => run.attempts || [])
    .reduce((sum, item) => sum + item.attempts.length, 0);
  evidence.promotionEligible = allGatesPass(evidence.gateResults);
  evidence.status = evidence.promotionEligible ? "c2_gates_passed" : "c2_gates_failed";
  evidence.completedAt = new Date().toISOString();
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outputPath,
    corpusSha256: evidence.identities.corpusSha256,
    binarySha256: evidence.identities.binarySha256,
    selectedCriteria,
    selectedPolicy,
    development: {
      c1Acceptable: c1DevelopmentScore.acceptable,
      genericAcceptable: genericA.acceptable,
      policyDisagreements: policyChanges.length,
      selectedAcceptable: selectedDevelopmentScore.acceptable,
    },
    holdout: {
      c1Acceptable: c1HoldoutScore.acceptable,
      candidateAcceptable: candidateHoldoutScore.acceptable,
      severeUnderRoutes: candidateHoldoutScore.severeUnderRoutes,
      regressions: holdoutRegressions,
      changes: holdoutChanges,
    },
    providerBuilds,
    paidDecisionRequests: evidence.paidDecisionRequests,
    gateResults: evidence.gateResults,
    promotionEligible: evidence.promotionEligible,
  }, null, 2)}\n`);
  if (!evidence.promotionEligible) process.exitCode = 1;
} catch (error) {
  if (!String(evidence.status).startsWith("stopped_")) {
    evidence.status = "evaluation_failed";
  }
  evidence.failure = {
    stage: activeStage,
    itemId: error?.itemId,
    message: error instanceof Error
      ? error.message.replace(/[^A-Za-z0-9 _-]/gu, "")
      : "unknown",
    attempts: error?.attempts,
  };
  evidence.paidDecisionRequests = Object.values(evidence.runs)
    .flatMap((run) => run.attempts || [])
    .reduce((sum, item) => sum + item.attempts.length, 0) +
    (error?.attempts?.length || 0);
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  throw error;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
