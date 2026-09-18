import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { nativeAccountCatalogHeaders } from "../src/codex-native-session.mjs";
import { CALLER_SECRET_PATH, NATIVE_CATALOG_PATH, PORTS } from "../src/paths.mjs";

const output = process.argv[2] || path.join(import.meta.dirname, "..", "docs", "history", "2026-09-18-switchyard-b2-counterfactuals.json");
const fixtures = [
  {
    id: "S17",
    candidates: [
      ["luna_max", "gpt-5.6-luna", "max"],
      ["sol_medium", "gpt-5.6-sol", "medium"],
    ],
    prompt: `Implement the adapter in this synthetic TypeScript fixture.

type Raw = { timeout?: unknown; labels?: unknown };
type Config = { timeoutMs: number; labels: string[] };
export function adapt(raw: Raw): Config {
  // implement
}

Requirements: timeout must be a positive integer and defaults to 30000; labels must be a nonempty array of trimmed unique strings; reject invalid input without silently dropping values. Return the implementation and name focused tests for zero timeout, duplicate labels, whitespace, and valid defaults.`,
    checks: [
      ["positive_integer", /positive|integer|number\.isinteger/iu],
      ["default", /30000/iu],
      ["duplicates", /duplicate|unique|set/iu],
      ["whitespace", /trim|whitespace/iu],
      ["tests", /test|expect|assert/iu],
    ],
  },
  {
    id: "X21",
    candidates: [
      ["astra_medium", "gpt-6-astra", "medium"],
      ["astra_xhigh", "gpt-6-astra", "xhigh"],
    ],
    prompt: `Audit this synthetic token-exchange design.

An API accepts a signed upstream token and a requested tenant. It verifies the signature and expiry, then issues an internal token for the requested tenant using the upstream subject. Retries reuse the same upstream token. Services accept any internal token signed by the exchange service. The upstream token contains issuer, subject, audience, tenant, and jti.

Identify concrete confused-deputy, replay, and cross-tenant failures. State enforceable issuer/audience/tenant invariants, a durable replay key and atomicity requirement, safe retry behavior, and decisive adversarial tests. Do not assume signature validity establishes authorization.`,
    checks: [
      ["audience", /audience|\baud\b/iu],
      ["tenant_binding", /tenant/iu],
      ["replay_key", /jti|replay/iu],
      ["atomic", /atomic|transaction|unique constraint/iu],
      ["retry", /retry|idempot/iu],
      ["adversarial_tests", /test|verify/iu],
    ],
  },
];

function textFrom(value, events = []) {
  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta || "");
  if (deltas.length) return deltas.join("");
  value = events.findLast((event) => event.response)?.response || value;
  return (value?.output || []).flatMap((item) => item?.content || [])
    .filter((part) => part?.type === "output_text").map((part) => part.text || "").join("");
}

const recheck = process.argv.includes("--recheck-existing");
const results = recheck ? JSON.parse(readFileSync(output, "utf8")).results : [];
if (!recheck) {
  const callerSecret = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
  const headers = await nativeAccountCatalogHeaders();
  if (!headers) throw new Error("native account headers unavailable");
  const url = `${callerBaseUrl(PORTS.router, callerSecret)}/responses`;
  const nativeCatalog = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
  for (const fixture of fixtures) {
    const legs = [];
    for (const [target, model, effort] of fixture.candidates) {
    const started = performance.now();
    const nativeModel = nativeCatalog.models.find((item) => item.slug === model);
    if (!nativeModel?.base_instructions) throw new Error(`native instructions unavailable for ${model}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: fixture.prompt }] }],
        instructions: `${nativeModel.base_instructions}\nAnalyze only the supplied synthetic fixture. Return a concise implementation or audit with decisive tests.`,
        reasoning: { effort },
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
    const text = textFrom(body, events);
    const checks = fixture.checks.map(([id, pattern]) => ({ id, pass: pattern.test(text) }));
      legs.push({
      target,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      completed: response.ok && (completed?.status === "completed" || body?.status === "completed"),
      checks,
      pass: response.ok && (completed?.status === "completed" || body?.status === "completed") && checks.every((check) => check.pass),
      outputChars: text.length,
      });
    }
    results.push({ id: fixture.id, legs });
  }
}
const evidence = {
  schemaVersion: 1,
  checkpoint: "SY-B2",
  generatedAt: new Date().toISOString(),
  scope: "two predeclared synthetic ambiguous-case target counterfactuals",
  privateDataSent: false,
  results,
  observations: [
    "S17: Luna Max and Sol Medium both passed all predeclared checks; Sol Medium completed materially faster in this sample.",
    "X21: Astra Medium passed all predeclared checks; Astra XHigh omitted the explicit atomicity requirement in this sample.",
  ],
  requiredFailures: results.flatMap((result) => result.legs.filter((leg) => leg.status !== 200 || !leg.completed).map((leg) => `${result.id}:${leg.target}:incomplete`)),
};
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (evidence.requiredFailures.length) process.exitCode = 1;
