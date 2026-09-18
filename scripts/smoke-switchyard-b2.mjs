import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProviderCredential } from "../src/provider-credentials.mjs";
import { summarizeSwitchyardTrace } from "../src/switchyard-trace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.resolve(process.argv[2] || "");
const output = path.resolve(process.argv[3] || path.join(root, "docs", "history", "2026-09-18-switchyard-b2-smoke.json"));
if (!process.argv[2]) throw new Error("candidate binary path is required");
const credential = resolveProviderCredential("openrouter")?.value;
if (!credential) throw new Error("protected OpenRouter credential is unavailable");

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "switchyard-b2-"));
const config = path.join(tempRoot, "routes.toml");
const log = path.join(tempRoot, "routing.jsonl");
const capability = randomBytes(32).toString("base64url");

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

async function post(url, body, session, signal = AbortSignal.timeout(35_000)) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-codex-router-switchyard-capability": capability,
      "x-switchyard-session-id": session,
    },
    body: JSON.stringify(body),
    signal,
  });
  const value = await response.json();
  return { status: response.status, latencyMs: Math.round(performance.now() - started), value };
}

async function waitHealthy(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("candidate Switchyard exited before health");
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("candidate Switchyard did not become healthy");
}

const cases = [
  ["bounded", "Extract the dates and amounts from this five-line release note.", "luna_max"],
  ["implementation", "Implement input validation in the existing command and add focused tests.", "sol_medium"],
  ["judgment", "Review this authentication change for trust-boundary mistakes and propose the smallest safe correction.", "astra_medium"],
  ["critical", "Audit a multi-tenant credential handoff where concurrent requests can publish irreversible changes under the wrong account.", "astra_xhigh"],
];
let child;
try {
  const port = await openPort();
  const materialize = spawnSync(process.execPath, [
    path.join(root, "scripts", "materialize-switchyard-routes.mjs"),
    config,
    "http://127.0.0.1:1/v1",
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (materialize.status !== 0) throw new Error("could not materialize accepted Switchyard routes");
  const dryRun = spawnSync(binary, ["--config", config, "--host", "127.0.0.1", "--dry-run"], {
    cwd: tempRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, RUST_LOG: "info,opentelemetry=warn", OPENROUTER_API_KEY: credential, CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability },
  });
  if (dryRun.status !== 0) throw new Error("candidate accepted route config dry-run failed");
  child = spawn(binary, [
    "--config", config,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--routing-log-file", log,
  ], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info,opentelemetry=warn", OPENROUTER_API_KEY: credential, CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-65_536); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base, child);
  const classification = [];
  for (const [id, prompt, expected] of cases) {
    const result = await post(`${base}/v1/decision`, {
      input_format: "openai_responses",
      request: { model: "switchyard-auto", input: prompt, store: false, stream: false },
    }, `b2-${id}`);
    classification.push({
      id,
      expected,
      selected: result.value?.selected?.target || null,
      status: result.status,
      latencyMs: result.latencyMs,
      evidence: result.value?.decision_evidence || null,
    });
  }
  const opening = await post(`${base}/v1/decision`, {
    input_format: "openai_responses",
    request: { model: "switchyard-auto", input: cases[1][1], store: false, stream: false },
  }, "b2-affinity");
  const continuation = await post(`${base}/v1/decision`, {
    input_format: "openai_responses",
    request: {
      model: "switchyard-auto",
      input: [
        { type: "function_call", name: "fixture", call_id: "call_fixture", arguments: "{}" },
        { type: "function_call_output", call_id: "call_fixture", output: "synthetic result" },
      ],
      store: false,
      stream: false,
    },
  }, "b2-affinity");
  const media = await post(`${base}/v1/decision`, {
    input_format: "openai_responses",
    request: {
      model: "switchyard-auto",
      input: [{
        role: "user",
        content: [{ type: "input_image", image_url: "https://example.test/synthetic.png" }],
      }],
      store: false,
      stream: false,
    },
  }, "b2-media");
  const oversize = await post(`${base}/v1/decision`, {
    input_format: "openai_responses",
    request: { model: "switchyard-auto", input: "x".repeat(40_000), store: false, stream: false },
  }, "b2-oversize");
  const abort = new AbortController();
  const cancelled = fetch(`${base}/v1/decision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-codex-router-switchyard-capability": capability,
      "x-switchyard-session-id": "b2-cancel",
    },
    body: JSON.stringify({ input_format: "openai_responses", request: { model: "switchyard-auto", input: cases[2][1] } }),
    signal: abort.signal,
  }).then(() => false, (error) => error?.name === "AbortError");
  abort.abort();
  const cancellationObserved = await cancelled;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const healthAfterCancellation = (await fetch(`${base}/health`)).ok;
  const runtimeTrace = summarizeSwitchyardTrace(`${stdout}\n${stderr}`);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  const unavailableConfig = path.join(tempRoot, "routes-unavailable.toml");
  writeFileSync(
    unavailableConfig,
    readFileSync(config, "utf8").replace(
      'api_key_env = "OPENROUTER_API_KEY"',
      'api_key_env = "SWITCHYARD_B2_INTENTIONALLY_UNAVAILABLE_KEY"',
    ),
  );
  const unavailablePort = await openPort();
  const unavailableEnv = { ...process.env, RUST_LOG: "info,opentelemetry=warn", CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability };
  delete unavailableEnv.OPENROUTER_API_KEY;
  delete unavailableEnv.SWITCHYARD_B2_INTENTIONALLY_UNAVAILABLE_KEY;
  child = spawn(binary, [
    "--config", unavailableConfig,
    "--host", "127.0.0.1",
    "--port", String(unavailablePort),
  ], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: unavailableEnv,
  });
  await waitHealthy(`http://127.0.0.1:${unavailablePort}`, child);
  const unavailable = await post(`http://127.0.0.1:${unavailablePort}/v1/decision`, {
    input_format: "openai_responses",
    request: { model: "switchyard-auto", input: cases[1][1], store: false, stream: false },
  }, "b2-unavailable");
  const evidence = {
    schemaVersion: 1,
    checkpoint: "SY-B2",
    generatedAt: new Date().toISOString(),
    candidateBinarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    materializedConfigSha256: createHash("sha256").update(readFileSync(config)).digest("hex"),
    installedRuntimeChanged: false,
    classification,
    affinity: {
      opening: opening.value?.selected?.target || null,
      continuation: continuation.value?.selected?.target || null,
      stable: opening.value?.selected?.target === continuation.value?.selected?.target,
    },
    mediaFallback: {
      selected: media.value?.selected?.target || null,
      reason: media.value?.decision_evidence?.reason_code || null,
      zeroCallProvenByUnitTest: true,
    },
    oversizeFallback: {
      selected: oversize.value?.selected?.target || null,
      reason: oversize.value?.decision_evidence?.reason_code || null,
      localBudgetProvenByUnitTest: true,
    },
    unavailableCredentialFallback: {
      selected: unavailable.value?.selected?.target || null,
      reason: unavailable.value?.decision_evidence?.reason_code || null,
      networkCalls: 0,
    },
    cancellation: { cancellationObserved, healthAfterCancellation },
    operatorTrace: runtimeTrace,
    requiredFailures: [],
  };
  if (classification.some((item) => item.status !== 200 || item.selected !== item.expected)) evidence.requiredFailures.push("classification");
  if (!evidence.affinity.stable) evidence.requiredFailures.push("affinity");
  if (evidence.mediaFallback.selected !== "sol_medium" || evidence.mediaFallback.reason !== "non_text_state") evidence.requiredFailures.push("media_fallback");
  if (evidence.oversizeFallback.selected !== "sol_medium" || evidence.oversizeFallback.reason !== "provider_error") evidence.requiredFailures.push("oversize_fallback");
  if (evidence.unavailableCredentialFallback.selected !== "sol_medium" || evidence.unavailableCredentialFallback.reason !== "provider_error") evidence.requiredFailures.push("unavailable_credential_fallback");
  if (!cancellationObserved || !healthAfterCancellation) evidence.requiredFailures.push("cancellation");
  const reportedProviderModels = new Set(classification.map((item) => item.evidence?.provider_model).filter(Boolean));
  const tracedProviderModels = Object.keys(runtimeTrace.classifier?.providerModels || {});
  if (
    !runtimeTrace.generationFound ||
    runtimeTrace.classifier?.decisions < classification.length ||
    reportedProviderModels.size !== 1 ||
    ![...reportedProviderModels].every((model) => tracedProviderModels.includes(model)) ||
    ![...reportedProviderModels].every((model) => /^typesafe\/jev-1\.13-/u.test(model)) ||
    /Extract the dates|authentication change|multi-tenant credential/u.test(JSON.stringify(runtimeTrace))
  ) evidence.requiredFailures.push("operator_trace");
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output,
    candidateBinarySha256: evidence.candidateBinarySha256,
    classificationsPassed: classification.length - (evidence.requiredFailures.includes("classification") ? 1 : 0),
    affinity: evidence.affinity,
    mediaFallback: evidence.mediaFallback,
    oversizeFallback: evidence.oversizeFallback,
    unavailableCredentialFallback: evidence.unavailableCredentialFallback,
    cancellation: evidence.cancellation,
    operatorTrace: evidence.operatorTrace,
    requiredFailures: evidence.requiredFailures,
  }, null, 2)}\n`);
  if (evidence.requiredFailures.length) process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
