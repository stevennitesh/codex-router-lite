import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { nativeAccountCatalogHeaders } from "../src/codex-native-session.mjs";
import { CALLER_SECRET_PATH, NATIVE_CATALOG_PATH, PORTS } from "../src/paths.mjs";

const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2] || path.join(root, "docs", "history", "2026-09-18-switchyard-b2-r3-x03-counterfactual.json"));
const targets = [
  { target: "astra_medium", model: "gpt-6-astra", effort: "medium" },
  { target: "astra_xhigh", model: "gpt-6-astra", effort: "xhigh" },
];
const rubric = [
  {
    id: "epoch_monotonicity",
    requirement: "Define a durable per-tenant monotonic epoch or fencing invariant and reject stale writers or lower-epoch material before cryptographic use.",
    indicators: [/monotonic|high[- ]water|fenc/iu, /reject|fail closed|deny/iu, /epoch|generation|version/iu],
  },
  {
    id: "tenant_binding",
    requirement: "Bind tenant identity to KMS authorization and authenticated cryptographic context so another tenant's key or envelope cannot be substituted.",
    indicators: [/tenant/iu, /AAD|authenticated|associated data|key policy|KMS/iu, /reject|deny|scop/iu],
  },
  {
    id: "compromised_material",
    requirement: "Never restore compromised material to encrypt, sign, unwrap, or authorize; any legacy read path must be scoped, audited, and migration-only.",
    indicators: [/comprom/iu, /never|must not|disable|revoke|destroy|deny/iu, /encrypt|sign|unwrap|legacy|decrypt/iu],
  },
  {
    id: "rollback_condition",
    requirement: "Permit rollback only before activation or exposure and only to non-compromised material; otherwise require forward recovery.",
    indicators: [/rollback/iu, /before|only if|pre-activation|not after|never/iu, /forward|new epoch|new key|non-compromised/iu],
  },
  {
    id: "atomic_activation",
    requirement: "Give a crash-safe activation sequence that gates writers on committed tenant state and prevents lagging replicas or caches from reactivating an old epoch.",
    indicators: [/atomic|compare-and-swap|two-phase|prepare|commit|fenc/iu, /writer|cache|replica/iu, /crash|partial|lag|stale/iu],
  },
  {
    id: "adversarial_tests",
    requirement: "Specify decisive tests for downgrade, cross-tenant substitution, crash windows, and attempted reuse of compromised material.",
    indicators: [/test|simulate|inject/iu, /downgrade|stale|lower epoch/iu, /cross-tenant|other tenant|tenant substitution/iu, /crash|comprom/iu],
  },
];
const fixtures = [
  {
    id: "X03-A-state-machine",
    prompt: `Audit and correct this entirely synthetic key-rotation design.

Each tenant has a control row { tenant, current_epoch, key_uri, status }. Writers cache the row for ten minutes. Ciphertext carries tenant, epoch, and key_uri in an unauthenticated header. One shared service role may call encrypt and decrypt for every tenant key. Rotation creates epoch e+1, updates the primary row, and leaves epoch e enabled for 24 hours. Read replicas may lag. On any error, an operator may set current_epoch back to e, even when e was reported compromised. There is no durable high-water mark outside the restored control row.

Provide enforceable invariants, a crash-safe activation and recovery sequence, the exact safe rollback condition, and decisive adversarial tests. Prevent downgrade, cross-tenant key reuse, and rollback to compromised material. Do not use real keys or credentials.`,
  },
  {
    id: "X03-B-recovery",
    prompt: `Review this entirely synthetic recovery proposal.

Tenant red used epoch 7 when its key was declared compromised. Epoch 8 was created, but one writer may have used it before the activation acknowledgement was recorded. A control-database restore now reports epoch 6. The backup includes mutable key aliases, and another tenant has a similarly named alias. An operator proposes restoring the database, pointing red's active alias back to epoch 7 until epoch 8 is validated, then re-encrypting later.

State whether that rollback is ever valid. Supply a safe forward-recovery protocol with enforceable tenant and epoch bindings, crash/replay behavior, and decisive tests for stale writers, cross-tenant substitution, downgrade, and attempted reuse of the compromised key. Do not use real keys or credentials.`,
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function textFrom(value, events = []) {
  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta || "");
  if (deltas.length) return deltas.join("");
  value = events.findLast((event) => event.response)?.response || value;
  return (value?.output || []).flatMap((item) => item?.content || [])
    .filter((part) => part?.type === "output_text").map((part) => part.text || "").join("");
}

function automaticChecks(text) {
  return rubric.map((criterion) => ({
    id: criterion.id,
    markerPass: criterion.indicators.every((pattern) => pattern.test(text)),
  }));
}

const predeclaredAt = new Date().toISOString();
const evidence = {
  schemaVersion: 1,
  checkpoint: "SY-B2-R3",
  status: "predeclared",
  predeclaredAt,
  scope: "two fixed synthetic X03 outcome comparisons; Astra Medium and Astra XHigh receive identical task text, instructions, tools, and transport conditions",
  privateDataSent: false,
  realKeyMaterialSent: false,
  policyChanged: false,
  thresholdChanged: false,
  holdoutChanged: false,
  acceptanceRule: "A leg is semantically acceptable only if every rubric requirement is substantively satisfied. Marker checks aid review but cannot establish semantic correctness by themselves.",
  rubric: rubric.map(({ id, requirement }) => ({ id, requirement })),
  fixtures: fixtures.map(({ id, prompt }) => ({ id, promptSha256: sha256(prompt), syntheticScenario: prompt })),
  targets,
  results: [],
};
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);

const callerSecret = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
const headers = await nativeAccountCatalogHeaders();
if (!headers) throw new Error("native account headers unavailable");
const url = `${callerBaseUrl(PORTS.router, callerSecret)}/responses`;
const nativeCatalog = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
for (const fixture of fixtures) {
  const legs = [];
  for (const target of targets) {
    const nativeModel = nativeCatalog.models.find((item) => item.slug === target.model);
    if (!nativeModel?.base_instructions) throw new Error(`native instructions unavailable for ${target.model}`);
    const started = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model: target.model,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: fixture.prompt }] }],
        instructions: `${nativeModel.base_instructions}\nAnalyze only the supplied synthetic fixture. Give concrete enforceable invariants, recovery steps, rollback conditions, and decisive tests. Be concise.`,
        tools: [],
        reasoning: { effort: target.effort },
        store: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await response.text();
    const events = raw.split(/\r?\n/u).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => { try { return JSON.parse(line.slice(6)); } catch { return undefined; } }).filter(Boolean);
    let body;
    if (!events.length && raw) { try { body = JSON.parse(raw); } catch {} }
    const completed = events.findLast((event) => event.type === "response.completed")?.response;
    const text = textFrom(body, events).slice(0, 16_000);
    legs.push({
      ...target,
      status: response.status,
      completed: response.ok && (completed?.status === "completed" || body?.status === "completed"),
      latencyMs: Math.round(performance.now() - started),
      outputSha256: sha256(text),
      outputChars: text.length,
      automaticChecks: automaticChecks(text),
      syntheticOutput: text,
    });
  }
  evidence.results.push({ id: fixture.id, legs });
}
evidence.status = "responses_captured_pending_semantic_review";
evidence.completedAt = new Date().toISOString();
evidence.requiredTransportFailures = evidence.results.flatMap((result) => result.legs
  .filter((leg) => leg.status !== 200 || !leg.completed)
  .map((leg) => `${result.id}:${leg.target}`));
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  output,
  predeclaredAt,
  completedAt: evidence.completedAt,
  results: evidence.results.map((result) => ({
    id: result.id,
    legs: result.legs.map((leg) => ({
      target: leg.target,
      status: leg.status,
      completed: leg.completed,
      latencyMs: leg.latencyMs,
      outputSha256: leg.outputSha256,
      automaticChecks: leg.automaticChecks,
    })),
  })),
  requiredTransportFailures: evidence.requiredTransportFailures,
}, null, 2)}\n`);
if (evidence.requiredTransportFailures.length) process.exitCode = 1;
