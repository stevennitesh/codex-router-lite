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
const requestTimeoutMs = 8_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCorpus(corpus) {
  if (corpus.schemaVersion !== 1 || corpus.privateData !== false) {
    throw new Error("routing corpus must be schema v1 synthetic data");
  }
  if (JSON.stringify(corpus.labels) !== JSON.stringify(labels)) {
    throw new Error("routing corpus label order differs from the canonical route");
  }
  if (!corpus.development?.length || !corpus.holdout?.length) {
    throw new Error("routing corpus requires development and holdout cases");
  }
  const cases = [...corpus.development, ...corpus.holdout];
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("routing corpus case ids must be unique");
  }
  for (const item of cases) {
    if (!item.id || !item.input || !labels.includes(item.expected)) {
      throw new Error("routing corpus case lacks id, input, or expected target");
    }
    if (!item.acceptable?.length || !item.acceptable.every((label) => labels.includes(label))) {
      throw new Error(`routing corpus case ${item.id} has invalid acceptable targets`);
    }
    if (!["normal", "severe"].includes(item.severity)) {
      throw new Error(`routing corpus case ${item.id} has invalid severity`);
    }
  }
  if (corpus.gates?.maximumRetriesPerRequest !== 1) {
    throw new Error("routing evaluation permits exactly one transient retry");
  }
  if (!Number.isInteger(corpus.gates?.minimumAcceptablePerSplit)) {
    throw new Error("routing corpus requires an integer acceptable-count gate");
  }
}

function materializedConfig(template, routerBase) {
  const source = template.replace(
    "__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__",
    routerBase,
  );
  if (source.includes("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__")) {
    throw new Error("route template retained its private URL placeholder");
  }
  return source;
}

export function applyPolicy(vector, threshold) {
  if (vector.measurementKind === "local_fallback") return vector.runtimeFinalTarget;
  return vector.confidence < threshold ? "sol_medium" : vector.rawSelected;
}

export function score(items, vectors, threshold) {
  const byId = new Map(vectors.map((vector) => [vector.id, vector]));
  const rows = items.map((item) => {
    const vector = byId.get(item.id);
    if (!vector) throw new Error(`missing vector for ${item.id}`);
    const target = applyPolicy(vector, threshold);
    const minimumRank = Math.min(...item.acceptable.map((label) => rank.get(label)));
    const underRouteDistance = Math.max(0, minimumRank - rank.get(target));
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
    count: rows.length,
    acceptable: rows.filter((row) => row.acceptableResult).length,
    severeUnderRoutes: rows.filter((row) => row.severeUnderRoute).length,
    rows,
  };
}

function latestUserHasNonText(input) {
  if (!Array.isArray(input)) return false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type !== "message" || item.role !== "user") continue;
    return (Array.isArray(item.content) ? item.content : [])
      .some((part) => part?.type !== "input_text");
  }
  return false;
}

function expectedLocalFallback(item, reasonCode) {
  if (reasonCode === "non_text_state") return latestUserHasNonText(item.input);
  return item.expectedLocalFallbackReasons?.includes(reasonCode) === true;
}

export function validateEvidence(item, response, body, fullBodyLatencyMs, threshold = 0.35) {
  if (!response.ok) throw new Error(`candidate HTTP ${response.status}`);
  const evidence = body?.decision_evidence;
  const reasonCode = evidence?.reason_code;
  if (evidence?.source === "fail_open" && ["non_text_state", "state_too_large"].includes(reasonCode)) {
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
      fullBodyLatencyMs,
    };
  }
  const lowConfidence = evidence?.source === "fail_open" && reasonCode === "low_confidence";
  if (evidence?.source !== "type_safe_classifier" && !lowConfidence) {
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
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("invalid probability");
    return total + value;
  }, 0);
  if (Math.abs(sum - 1) > 0.02) throw new Error("invalid probability sum");
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    throw new Error("invalid confidence");
  }
  if (lowConfidence && evidence.confidence >= threshold) {
    throw new Error("low-confidence evidence is not below threshold");
  }
  return {
    id: item.id,
    measurementKind: lowConfidence ? "low_confidence" : "classifier",
    reasonCode: lowConfidence ? "low_confidence" : null,
    rawSelected: evidence.label,
    confidence: evidence.confidence,
    probabilities,
    runtimeFinalTarget: evidence.final_target,
    providerModel: evidence.provider_model,
    providerLatencyMs: evidence.decision_latency_ms,
    fullBodyLatencyMs,
  };
}

export function runtimeParity(items, vectors, threshold) {
  const byId = new Map(vectors.map((vector) => [vector.id, vector]));
  const mismatches = [];
  for (const item of items) {
    const vector = byId.get(item.id);
    if (!vector || vector.measurementKind === "local_fallback") continue;
    const expectedTarget = applyPolicy(vector, threshold);
    if (vector.runtimeFinalTarget !== expectedTarget) {
      mismatches.push({ id: item.id, expectedTarget, runtimeTarget: vector.runtimeFinalTarget });
    }
  }
  return { passed: mismatches.length === 0, mismatches };
}

export function stableProviderBuild(vectors) {
  const builds = [...new Set(vectors
    .filter((vector) => vector.measurementKind !== "local_fallback")
    .map((vector) => vector.providerModel))];
  return { passed: builds.length === 1, builds };
}

export function allGatesPass(gates) {
  return Object.values(gates).every(Boolean);
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

async function withCandidate(binary, configPath, credential, action) {
  const port = await openPort();
  const capability = randomBytes(32).toString("hex");
  const env = {
    ...process.env,
    OPENROUTER_API_KEY: credential,
    CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability,
  };
  const dryRun = spawnSync(binary, ["--config", configPath, "--host", "127.0.0.1", "--dry-run"], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  if (dryRun.status !== 0) throw new Error("candidate config dry-run failed");
  const child = spawn(
    binary,
    ["--config", configPath, "--host", "127.0.0.1", "--port", String(port)],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env },
  );
  child.stderr.on("data", () => {});
  try {
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error("candidate exited before health");
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!healthy) throw new Error("candidate did not become healthy");
    return await action(base, capability);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

export async function requestVector(base, capability, item, maxRetries, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
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
          "x-switchyard-session-id": `routing-eval-${item.id}-${attempt}`,
        },
        body: JSON.stringify({
          input_format: "openai_responses",
          request: { model: "switchyard-auto", input: item.input, store: false, stream: false },
        }),
        signal: AbortSignal.timeout(options.timeoutMs || requestTimeoutMs),
      });
    } catch (error) {
      attempts.push({
        attempt,
        status: null,
        errorClass: error instanceof Error ? error.name : "unknown",
        latencyMs: Math.round(performance.now() - started),
      });
      if (attempt >= maxRetries) throw Object.assign(new Error("decision request failed"), { attempts });
      continue;
    }
    attempts.push({ attempt, status: response.status });
    if (response.status === 429 || response.status >= 500) {
      attempts.at(-1).latencyMs = Math.round(performance.now() - started);
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
    const evidence = body?.decision_evidence;
    Object.assign(attempts.at(-1), {
      latencyMs,
      source: evidence?.source || "missing",
      ...(evidence?.reason_code ? { reasonCode: evidence.reason_code } : {}),
    });
    if (
      evidence?.source === "fail_open" &&
      ["classifier_timeout", "classifier_unavailable", "provider_http_error"].includes(evidence.reason_code) &&
      attempt < maxRetries
    ) continue;
    try {
      return {
        vector: validateEvidence(item, response, body, latencyMs, options.threshold),
        attempts,
      };
    } catch (error) {
      error.attempts = attempts;
      throw error;
    }
  }
  throw new Error("decision retry loop exhausted");
}

async function evaluate(binary, configPath, credential, items, maxRetries, threshold) {
  const vectors = [];
  const attempts = [];
  await withCandidate(binary, configPath, credential, async (base, capability) => {
    for (const item of items) {
      try {
        const result = await requestVector(base, capability, item, maxRetries, { threshold });
        vectors.push(result.vector);
        attempts.push({ id: item.id, attempts: result.attempts });
      } catch (error) {
        error.itemId = item.id;
        throw error;
      }
    }
  });
  return { vectors, attempts };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length < 3) {
    throw new Error("usage: evaluate-switchyard-routing.mjs BINARY CORPUS_JSON OUTPUT_JSON");
  }
  const [binaryArg, corpusArg, outputArg] = argv;
  const binary = path.resolve(binaryArg);
  const corpusPath = path.resolve(corpusArg);
  const outputPath = path.resolve(outputArg);
  const templatePath = path.join(root, "config", "switchyard", "routes.template.toml");
  const sourceLockPath = path.join(root, "config", "switchyard", "source.lock");
  const patchPath = path.join(root, "config", "switchyard", "patches", "switchyard-codex-compat.patch");
  const corpusBytes = readFileSync(corpusPath);
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  assertCorpus(corpus);
  const templateBytes = readFileSync(templatePath);
  const sourceLockBytes = readFileSync(sourceLockPath);
  const patchBytes = readFileSync(patchPath);
  const binaryBytes = readFileSync(binary);
  const lock = JSON.parse(sourceLockBytes.toString("utf8"));
  if (lock.patchSha256 !== sha256(patchBytes)) throw new Error("source lock does not bind the patch");
  const template = templateBytes.toString("utf8");
  if (!template.includes(`question = ${JSON.stringify(corpus.question)}`)) {
    throw new Error("corpus question differs from the canonical route");
  }
  if (!template.includes(`base_threshold = ${corpus.policies.threshold}`)) {
    throw new Error("corpus threshold differs from the canonical route");
  }
  if (!/^default_target = "sol_medium"$/mu.test(template)) {
    throw new Error("canonical uncertainty fallback is not Sol Medium");
  }
  const credential = resolveProviderCredential("openrouter")?.value;
  if (!credential) throw new Error("protected OpenRouter credential is unavailable");
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "switchyard-routing-eval-"));
  const config = materializedConfig(template, "http://127.0.0.1:1/v1");
  const configPath = path.join(tempRoot, "routes.toml");
  writeFileSync(configPath, config);
  const evidence = {
    schemaVersion: 1,
    checkpoint: corpus.checkpoint || "switchyard-routing-evaluation",
    status: "predeclared",
    syntheticAuthoredCorpus: true,
    independentDataset: false,
    privateDataSent: false,
    productionChanged: false,
    identities: {
      binarySha256: sha256(binaryBytes),
      sourceLockSha256: sha256(sourceLockBytes),
      compatibilityPatchSha256: sha256(patchBytes),
      routesTemplateSha256: sha256(templateBytes),
      generatedConfigSha256: sha256(config),
      corpusSha256: sha256(corpusBytes),
      evaluatorSha256: sha256(readFileSync(import.meta.filename)),
    },
    runs: {},
  };
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  let stage = "development";
  try {
    const threshold = corpus.policies.threshold;
    const maxRetries = corpus.gates.maximumRetriesPerRequest;
    const development = await evaluate(
      binary, configPath, credential, corpus.development, maxRetries, threshold,
    );
    const developmentScore = score(corpus.development, development.vectors, threshold);
    const developmentBuild = stableProviderBuild(development.vectors);
    const developmentParity = runtimeParity(corpus.development, development.vectors, threshold);
    evidence.runs.development = {
      vectors: development.vectors,
      attempts: development.attempts,
      score: developmentScore,
    };
    evidence.developmentGates = {
      complete: development.vectors.length === corpus.development.length,
      acceptable: developmentScore.acceptable >= corpus.gates.minimumAcceptablePerSplit,
      severeUnderRoutes: developmentScore.severeUnderRoutes <= corpus.gates.maximumSevereUnderRoutes,
      providerBuildStable: !corpus.gates.providerBuildMustRemainConstant || developmentBuild.passed,
      runtimeParity: developmentParity.passed,
    };
    evidence.providerBuilds = developmentBuild.builds;
    if (!allGatesPass(evidence.developmentGates)) {
      evidence.status = "stopped_development_gate";
      throw new Error("development gate failed");
    }
    evidence.status = "candidate_frozen_before_holdout";
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);

    stage = "holdout";
    const holdout = await evaluate(
      binary, configPath, credential, corpus.holdout, maxRetries, threshold,
    );
    const holdoutScore = score(corpus.holdout, holdout.vectors, threshold);
    const allVectors = [...development.vectors, ...holdout.vectors];
    const finalBuild = stableProviderBuild(allVectors);
    const holdoutParity = runtimeParity(corpus.holdout, holdout.vectors, threshold);
    evidence.runs.holdout = {
      vectors: holdout.vectors,
      attempts: holdout.attempts,
      score: holdoutScore,
    };
    evidence.gateResults = {
      ...evidence.developmentGates,
      completeHoldout: holdout.vectors.length === corpus.holdout.length,
      holdoutAcceptable: holdoutScore.acceptable >= corpus.gates.minimumAcceptablePerSplit,
      holdoutSevereUnderRoutes: holdoutScore.severeUnderRoutes <= corpus.gates.maximumSevereUnderRoutes,
      providerBuildStableAcrossSplits:
        !corpus.gates.providerBuildMustRemainConstant || finalBuild.passed,
      holdoutRuntimeParity: holdoutParity.passed,
    };
    evidence.providerBuilds = finalBuild.builds;
    evidence.paidDecisionRequests = Object.values(evidence.runs)
      .flatMap((run) => run.attempts)
      .reduce((sum, entry) => sum + entry.attempts.length, 0);
    evidence.promotionEligible = allGatesPass(evidence.gateResults);
    evidence.status = evidence.promotionEligible ? "routing_gates_passed" : "routing_gates_failed";
    evidence.completedAt = new Date().toISOString();
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      outputPath,
      developmentAcceptable: developmentScore.acceptable,
      holdoutAcceptable: holdoutScore.acceptable,
      providerBuilds: evidence.providerBuilds,
      paidDecisionRequests: evidence.paidDecisionRequests,
      gateResults: evidence.gateResults,
      promotionEligible: evidence.promotionEligible,
    }, null, 2)}\n`);
    if (!evidence.promotionEligible) process.exitCode = 1;
  } catch (error) {
    if (!String(evidence.status).startsWith("stopped_")) evidence.status = "evaluation_failed";
    evidence.failure = {
      stage,
      itemId: error?.itemId,
      message: error instanceof Error
        ? error.message.replace(/[^A-Za-z0-9 _-]/gu, "")
        : "unknown",
      attempts: error?.attempts,
    };
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    throw error;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
