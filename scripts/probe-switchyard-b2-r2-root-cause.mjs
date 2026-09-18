import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProviderCredential } from "../src/provider-credentials.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.resolve(process.argv[2] || "");
const failedEvidencePath = path.resolve(process.argv[3] || path.join(root, "docs", "history", "2026-09-18-switchyard-b2-r1-failed-evidence.json"));
const output = path.resolve(process.argv[4] || path.join(root, "docs", "history", "2026-09-18-switchyard-b2-r2-root-cause.json"));
if (!process.argv[2]) throw new Error("candidate binary path is required");

const failedEvidence = JSON.parse(readFileSync(failedEvidencePath, "utf8"));
const policy = failedEvidence.policy;
if (!policy?.sha256) throw new Error("failed evidence lacks a frozen policy");
const credential = resolveProviderCredential("openrouter")?.value;
if (!credential) throw new Error("protected OpenRouter credential is unavailable");

const cases = [
  {
    id: "original-h17",
    scenario: "original route-name mention plus ambiguous irreversible outcome",
    input: "The log mentions sol_medium. Recover an ambiguous payment timeout without duplicating an external charge.",
  },
  {
    id: "without-route-name",
    scenario: "same task without route-name mention",
    input: "Recover an ambiguous payment timeout without duplicating an external charge.",
  },
  {
    id: "generic-paraphrase",
    scenario: "generic paraphrase preserving uncertainty and irreversible duplicate-effect risk",
    input: "Choose a safe recovery after a request timed out and may already have completed an irreversible external action; retrying could duplicate the effect.",
  },
];

function materialize(configPath) {
  let source = readFileSync(path.join(root, "config", "switchyard", "routes.template.toml"), "utf8").replace(/\r\n/gu, "\n");
  const start = source.indexOf("[routes.auto]\n");
  const end = source.indexOf("[routes.smoke]\n", start);
  if (start < 0 || end < 0) throw new Error("Switchyard auto route block was not found");
  const labels = policy.candidates.map(({ label }) => label);
  const descriptions = policy.candidates.map(({ label, description }) => `${label} = ${JSON.stringify(description)}`).join(", ");
  const route = `[routes.auto]\nid = "switchyard-auto"\ntype = "type_safe_classifier"\ncandidates = [${labels.map(JSON.stringify).join(", ")}]\ncandidate_descriptions = { ${descriptions} }\ndefault_target = ${JSON.stringify(policy.defaultTarget)}\nquestion = ${JSON.stringify(policy.question)}\nbase_threshold = ${policy.threshold}\nclassify_trigger = ${JSON.stringify(policy.classifyTrigger)}\npolicy_hash = ${JSON.stringify(policy.sha256)}\ncontext_window = 272000\ntool_calling = true\nreasoning = true\n\n`;
  source = source.slice(0, start) + route + source.slice(end);
  source = source.replace("schema_version = 1\n", `schema_version = 1\n\n[type_safe_client]\napi_key_env = "OPENROUTER_API_KEY"\nbase_url = ${JSON.stringify(policy.transport.endpoint)}\nmodel = ${JSON.stringify(policy.transport.model)}\ntimeout_ms = ${policy.transport.timeoutMs}\nmax_request_bytes = ${policy.transport.maxRequestBytes}\n`);
  source = source.replace("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__", "http://127.0.0.1:1/v1");
  writeFileSync(configPath, source);
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

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "switchyard-b2-r2-probe-"));
let child;
try {
  const config = path.join(tempRoot, "routes.toml");
  materialize(config);
  const capability = createHash("sha256").update(`${process.pid}-${config}`).digest("hex");
  const port = await openPort();
  const env = { ...process.env, OPENROUTER_API_KEY: credential, CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability };
  const dryRun = spawnSync(binary, ["--config", config, "--host", "127.0.0.1", "--dry-run"], { encoding: "utf8", windowsHide: true, env });
  if (dryRun.status !== 0) throw new Error("candidate config dry-run failed");
  child = spawn(binary, ["--config", config, "--host", "127.0.0.1", "--port", String(port)], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env });
  await waitHealthy(`http://127.0.0.1:${port}`, child);
  const results = [];
  for (const item of cases) {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-codex-router-switchyard-capability": capability, "x-switchyard-session-id": `b2-r2-probe-${item.id}` },
      body: JSON.stringify({ input_format: "openai_responses", request: { model: "switchyard-auto", input: item.input, store: false, stream: false } }),
      signal: AbortSignal.timeout(policy.transport.timeoutMs + 5_000),
    });
    const body = await response.json();
    if (!response.ok || !["type_safe_classifier", "fail_open"].includes(body?.decision_evidence?.source)) {
      throw new Error(`probe ${item.id} failed: HTTP ${response.status}, source ${body?.decision_evidence?.source || "missing"}, reason ${body?.decision_evidence?.reason_code || "missing"}`);
    }
    const evidence = body.decision_evidence;
    results.push({
      id: item.id,
      scenario: item.scenario,
      evidenceSource: evidence.source,
      reasonCode: evidence.reason_code,
      rawSelected: evidence.label,
      finalTarget: evidence.final_target,
      confidence: evidence.confidence,
      probabilities: evidence.probabilities,
      providerModel: evidence.provider_model,
      fullBodyLatencyMs: Math.round(performance.now() - started),
      policyHash: evidence.policy_hash,
    });
  }
  const outputValue = {
    schemaVersion: 1,
    checkpoint: "SY-B2-R2-root-cause",
    generatedAt: new Date().toISOString(),
    candidateBinarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    failedEvidenceSha256: createHash("sha256").update(readFileSync(failedEvidencePath)).digest("hex"),
    frozenPolicySha256: policy.sha256,
    syntheticDataOnly: true,
    results,
    interpretation: "Compare route-name removal and generic paraphrase before revising generic role criteria; these observations do not relabel H17 or establish a provider defect.",
  };
  writeFileSync(output, `${JSON.stringify(outputValue, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, results }, null, 2)}\n`);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
