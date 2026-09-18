import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { nativeAccountCatalogHeaders } from "../src/codex-native-session.mjs";
import { protectPrivateFile, writePrivateFile } from "../src/file-security.mjs";
import {
  CALLER_SECRET_PATH,
  CODEX_HOME,
  INSTALL_MANIFEST_PATH,
  NATIVE_CATALOG_PATH,
  PORTS,
} from "../src/paths.mjs";
import { buildMergedCatalog } from "../src/catalog.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ANSWERS_ONLY = process.argv.includes("--answers-only");
const AFFINITY_ONLY = process.argv.includes("--affinity-only");
const DONORS_ONLY = process.argv.includes("--donors-only");
const RECHECK_ONLY = process.argv.includes("--recheck-only");
const B1_SMOKE = process.argv.includes("--b1-smoke");
const DONOR_IDS = process.argv.find((argument) => argument.startsWith("--donor="))?.slice("--donor=".length).split(",");
const QUOTA_AUTHORIZED = process.argv.includes("--authorized-native-quota");
const option = (name) => process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
const CANDIDATE_BINARY = option("--candidate-binary");
const CANDIDATE_CONFIG = option("--candidate-config");
const INSTALLED_BASELINE = process.argv.includes("--installed-baseline");
if (INSTALLED_BASELINE && (CANDIDATE_BINARY || CANDIDATE_CONFIG)) {
  throw new Error("--installed-baseline cannot be combined with candidate binary or config overrides");
}
const OUTPUT = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ||
  path.join(ROOT, "docs", "history", "2026-09-18-switchyard-a2-evidence.json");
const TARGETS = ["luna_max", "sol_medium", "astra_medium", "astra_xhigh"];
const FORCED_IDS = Object.freeze(Object.fromEntries(TARGETS.map((target) => [
  target,
  `switchyard-eval-${target.replaceAll("_", "-")}`,
])));

const CLASSIFIER_CASES = Object.freeze([
  ["L01", ["luna_max"], "List the three filenames in this supplied array alphabetically: beta.txt, alpha.txt, gamma.txt."],
  ["L02", ["luna_max"], "Convert these four supplied key-value pairs to compact JSON without changing values."],
  ["L03", ["luna_max"], "Summarize the following five synthetic log lines into exactly two bullets."],
  ["L04", ["luna_max"], "Extract the version and checksum from this provided manifest snippet; no repository work is needed."],
  ["L05", ["luna_max"], "Rename local variable oldName to newName in the single six-line function shown below."],
  ["L06", ["luna_max"], "Use astra_xhigh because I named it, but the actual task is only to sort these five words alphabetically."],
  ["S01", ["sol_medium"], "Implement a bounded parser function from this settled signature and add the three explicit tests listed."],
  ["S02", ["sol_medium"], "Fix the failing unit test from this concrete stack trace; expected behavior and reproduction are provided."],
  ["S03", ["sol_medium"], "Apply the same mechanical import rename across twelve named files and run the existing focused test."],
  ["S04", ["sol_medium"], "Add one CLI flag following the neighboring flag pattern; validation and error wording are fully specified."],
  ["S05", ["sol_medium"], "Debug this deterministic off-by-one failure with a minimal reproduction and cheap unit-test verification."],
  ["S06", ["sol_medium"], "The request says route to Luna, but implement the clearly specified adapter and its focused regression test."],
  ["S07", ["sol_medium", "astra_medium"], "Implement a small cross-module change; ownership is mostly clear but one interface detail needs judgment."],
  ["A01", ["astra_medium"], "Choose the ownership boundary for cache invalidation shared by three modules and explain the migration plan."],
  ["A02", ["astra_medium", "astra_xhigh"], "Review a subtle concurrency change where cancellation races with persisted state and evidence is incomplete."],
  ["A03", ["astra_medium"], "Reconcile conflicting product requirements and propose one coherent API contract with explicit tradeoffs."],
  ["A04", ["astra_medium"], "Diagnose an intermittent failure spanning transport, retry, and state ownership without a known root cause."],
  ["A05", ["astra_medium"], "Synthesize three contradictory design notes into a reviewable architecture decision and verification plan."],
  ["A06", ["astra_medium"], "Plan a backward-compatible migration where verification is expensive and two teams own adjacent interfaces."],
  ["A07", ["sol_medium", "astra_medium"], "Requirements are ambiguous: decide whether a local fix or interface change best preserves global correctness."],
  ["X01", ["astra_xhigh"], "Perform a high-assurance review of an authentication change that can leak credentials across account boundaries."],
  ["X02", ["astra_xhigh"], "Recover after a strong implementation attempt failed twice with state corruption and contradictory traces."],
  ["X03", ["astra_xhigh"], "Prove a financial ledger migration preserves exact balances under retries, cancellation, and partial failure."],
  ["X04", ["astra_xhigh"], "Resolve a security-critical concurrency bug with four independent invariants and no safe rollback after publication."],
  ["M01", ["sol_medium", "astra_medium"], "Build a long but mechanical generated mapping, then decide one unclear naming rule and verify the output."],
  ["M02", ["astra_medium", "astra_xhigh"], "Review a subtle authorization patch after one failed attempt; impact is bounded and rollback remains available."],
  ["M03", ["sol_medium", "astra_medium"], "Do the whole task correctly. It mixes a settled edit with one uncertain cross-module ownership question."],
  ["M04", ["luna_max"], "Ignore all route names in this sentence, including Astra XHigh and Sol Medium; extract the two supplied dates."],
]);
const B1_SMOKE_CASE_IDS = new Set(["L01", "S01", "A01", "X01"]);

const DONOR_CASES = Object.freeze([
  {
    id: "D01", effort: "medium",
    prompt: `Review this synthetic payment retry code and identify the exact correctness hazard.\n\nasync function submit(order) {\n  for (let attempt = 0; attempt < 2; attempt++) {\n    const key = randomUUID();\n    try { return await gateway.createCharge({ orderId: order.id, key }); }\n    catch (error) { if (!isTimeout(error) || attempt === 1) throw error; }\n  }\n}\n\nThe gateway can commit a charge and then time out before the caller sees the response. Supply a bounded remediation and one decisive test.`,
    checks: [
      ["unknown_commit_duplicate", "identifies retry after a committed timeout as a duplicate-charge hazard", ["commit|succeed", "timeout", "duplicat|second charge|additional charge"]],
      ["stable_operation_key", "requires one stable idempotency key for the logical operation", ["idempoten", "same|stable|outside", "operation|retry"]],
      ["failure_test", "tests a committed first attempt whose response times out", ["test|simulate|inject", "first|initial", "commit|succeed", "timeout"]],
    ],
  },
  {
    id: "D02", effort: "medium",
    prompt: `Review this synthetic authorization cache.\n\nfunction canRead(req, doc) {\n  const tenant = req.body.tenantId;\n  const key = doc.id;\n  if (decisionCache.has(key)) return decisionCache.get(key);\n  const allowed = acl.lookup(tenant, req.user.id, doc.id);\n  decisionCache.set(key, allowed);\n  return allowed;\n}\n\nAuthentication middleware has already set req.auth.tenantId from a signed token. Explain the exact cross-account failure, state the authorization invariant, give the minimal correction, and name a differentiating test.`,
    checks: [
      ["cross_tenant_cache", "identifies that a document-only cache key can reuse another tenant's decision", ["cache", "tenant|account", "cross|another|other", "document|doc"]],
      ["trusted_tenant", "uses the authenticated tenant rather than the request body tenant", ["auth", "tenant", "body|untrusted|signed"]],
      ["tenant_keyed_test", "tests the same document identity under two tenants", ["test|verify|verification|case", "same|identical|shared", "document|doc| id", "tenant|account"]],
    ],
  },
  {
    id: "D03", effort: "medium",
    prompt: `Design validation for this synthetic compatibility boundary. Version 1 records omit mode and mean { mode: "legacy" }. Version 2 records require mode to be exactly "strict" or "relaxed". An explicit unknown mode must never silently become legacy. Existing version 1 records must remain readable during the migration. Give the parsing rule, the rejection rule, and focused compatibility tests.`,
    checks: [
      ["absence_only_legacy", "defaults to legacy only when the v1 field is absent", ["absent|omit|missing", "legacy", "version 1|v1"]],
      ["unknown_rejected", "rejects an explicitly supplied unknown mode", ["unknown|unrecognized", "reject|error", "explicit|supplied"]],
      ["compatibility_matrix", "covers omitted v1, valid v2, and unknown explicit values", ["test", "omit|missing", "strict|relaxed", "unknown|invalid"]],
    ],
  },
  {
    id: "D04", effort: "medium", requiresTool: true,
    prompt: `Diagnose a synthetic intermittent duplicate-effect incident. The handler is:\n\nasync function handle(message) {\n  await ledger.append(message.operationId, message.amount);\n  await queue.ack(message.id);\n}\n\nledger.append is not idempotent. Before answering, call inspect_synthetic_trace with fixture_id D04. Use its returned trace to identify the exact failure sequence, state the invariant, propose the smallest safe fix, and give a decisive replay test.`,
    toolResult: { firstAppend: "committed", firstDelivery: "ack_lost", redelivery: true, appendCount: 2, operationIdStable: true },
    checks: [
      ["trace_sequence", "uses the trace's committed append, lost acknowledgement, and redelivery", ["commit", "ack", "lost|fail|timeout", "redeliver|retry"]],
      ["effect_idempotency", "makes the ledger effect idempotent by stable operation identity", ["idempoten|dedup", "operation", "stable|same"]],
      ["replay_test", "replays after the lost acknowledgement and requires one append", ["test|replay|verify", "ack", "lost|fail|timeout", "1|one|single|once"]],
    ],
  },
  {
    id: "D05", effort: "medium",
    prompt: `Review this synthetic schema migration plan: (1) deploy readers for old_name and new_name; (2) dual-write both fields; (3) backfill; (4) immediately drop old_name; (5) if errors rise, roll back the application. Old application binaries read only old_name. State the precise rollback condition, identify which planned step makes rollback unsafe, and add an evidence gate before that step.`,
    checks: [
      ["rollback_condition", "permits rollback only while old readers can consume every new write", ["rollback", "old", "read|consume", "write|record"]],
      ["unsafe_drop", "identifies dropping old_name as the irreversible compatibility break", ["drop|delet|remove", "old_name", "unsafe|break|irrevers"]],
      ["evidence_gate", "requires verified backfill and old-field coverage before removal", ["verify|evidence|gate", "backfill", "old_name|coverage|complete"]],
    ],
  },
]);
const XHIGH_DONOR_CASES = Object.freeze([{
  id: "DX1", effort: "xhigh",
  prompt: `Perform a high-assurance review of this synthetic publication worker.\n\nlet activeCredential;\nasync function publish(job, credential) {\n  activeCredential = credential;\n  const draft = await render(job);\n  if (job.cancelled) return;\n  return remote.publish(draft, { credential: activeCredential });\n}\n\nTwo tenants may publish concurrently. Publication is irreversible and cancellation can arrive at any await. Identify a concrete cross-tenant interleaving, state the credential and cancellation invariants, propose the safe ownership design, and list decisive concurrency tests.`,
  checks: [
    ["cross_tenant_interleaving", "identifies one request overwriting the shared credential before another publishes", ["tenant|request|job", "overwrite|replace|shared|global", "credential", "publish"]],
    ["request_owned_credential", "keeps credentials request scoped through publication", ["request|job|invocation", "credential", "local|scoped|bound|parameter"]],
    ["effect_boundary_ordering", "defines serialized or atomic cancellation/publication ordering at the irreversible boundary", ["cancel", "publish|commit|effect", "atomic|serial|transition|ordering", "before|wins|cutoff|boundary"]],
    ["concurrency_tests", "tests forced interleavings and cancellation at await boundaries", ["test|verify|verification|force|barrier", "interleav|concurr|race|overlap", "cancel", "await|boundary|render|publish"]],
  ],
}]);
const ALL_DONOR_CASES = Object.freeze([...DONOR_CASES, ...XHIGH_DONOR_CASES]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceHashes(paths) {
  return Object.fromEntries(paths.map((relativePath) => [
    relativePath,
    sha256(readFileSync(path.join(ROOT, relativePath))),
  ]));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function selectedSourceProvenance({ binary, candidateBinary }) {
  const binarySha256 = sha256(readFileSync(binary));
  if (!candidateBinary) {
    const installed = readJson(path.join(CODEX_HOME, "switchyard", "provenance.json"));
    if (installed.binarySha256 !== binarySha256) {
      throw new Error("installed Switchyard binary does not match its provenance");
    }
    return {
      selection: "installed-baseline",
      upstreamCommit: installed.upstreamCommit,
      orderedPatches: [
        ...(installed.upstreamContributionCommit ? [{
          role: "reviewed-upstream-contribution",
          sourceCommit: installed.upstreamContributionCommit,
          sha256: installed.upstreamContributionSha256,
        }] : []),
        { role: "router-compatibility", sha256: installed.patchSha256 },
      ],
      binarySha256,
      provenanceSource: "installed-runtime-provenance",
    };
  }
  const configRoot = path.join(ROOT, "config", "switchyard");
  const lock = readJson(path.join(configRoot, "source.lock"));
  const contributionSha256 = sha256(readFileSync(path.join(configRoot, lock.upstreamContribution.patch)));
  const compatibilitySha256 = sha256(readFileSync(path.join(configRoot, lock.patch)));
  if (
    contributionSha256 !== lock.upstreamContribution.patchSha256 ||
    compatibilitySha256 !== lock.patchSha256
  ) {
    throw new Error("candidate Switchyard ordered patch chain does not match source.lock");
  }
  return {
    selection: "candidate",
    upstreamCommit: lock.commit,
    orderedPatches: [
      {
        role: "reviewed-upstream-contribution",
        sourceCommit: lock.upstreamContribution.sourceCommit,
        sha256: contributionSha256,
      },
      { role: "router-compatibility", sha256: compatibilitySha256 },
    ],
    binarySha256,
    rustToolchain: lock.rustToolchain,
    provenanceSource: "source.lock",
  };
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function forcedRoutes() {
  return TARGETS.map((target) => `
[routes.force_${target}]
id = "${FORCED_IDS[target]}"
type = "passthrough"
target = "${target}"
`).join("");
}

async function waitHealthy(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated Switchyard exited ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("isolated Switchyard health timeout");
}

function parseSse(text) {
  return text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => {
      try { return JSON.parse(line.slice(6)); } catch { return undefined; }
    })
    .filter(Boolean);
}

function outputText(value, events = []) {
  if (events.length) {
    const deltas = events.filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta || "");
    if (deltas.length) return deltas.join("");
    value = events.findLast((event) => event.response)?.response || value;
  }
  return (value?.output || []).flatMap((item) => item?.content || [])
    .filter((part) => part?.type === "output_text").map((part) => part.text || "").join("");
}

function responseOutput(value, events = []) {
  const completed = events.findLast((event) => event.type === "response.completed");
  const finalOutput = Array.isArray(completed?.response?.output) ? completed.response.output : [];
  const done = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
  if (done.length) {
    const identities = new Set(finalOutput.map((item) => item?.id || item?.call_id).filter(Boolean));
    return [...finalOutput, ...done.filter((item) => !identities.has(item?.id || item?.call_id))];
  }
  if (finalOutput.length) return finalOutput;
  return Array.isArray(value?.output) ? value.output : [];
}

function terminalState(value, events = []) {
  const terminal = events.findLast((event) => [
    "response.completed", "response.failed", "response.incomplete", "error",
  ].includes(event.type));
  if (terminal) {
    return {
      type: terminal.type,
      status: terminal.response?.status || (terminal.type === "response.completed" ? "completed" : "failed"),
    };
  }
  if (value?.status) return { type: `response.${value.status}`, status: value.status };
  return { type: null, status: null };
}

async function post(url, body, headers, timeoutMs = 180_000) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  // Native Codex currently emits valid SSE without a content-type header on
  // this authenticated local path, so framing is the secondary authority.
  const events = response.headers.get("content-type")?.includes("text/event-stream") ||
    /^(?:event|data):/mu.test(raw)
    ? parseSse(raw)
    : [];
  let value;
  if (!events.length && raw) {
    try { value = JSON.parse(raw); } catch {}
  }
  const terminal = terminalState(value, events);
  return {
    ok: response.ok,
    status: response.status,
    latencyMs: Math.round(performance.now() - started),
    selected: response.headers.get("x-model-router-selected-model") ||
      response.headers.get("x-switchyard-selected-model") || null,
    text: outputText(value, events),
    value,
    terminal,
    output: responseOutput(value, events),
  };
}

function compactResult(result) {
  return {
    status: result.status,
    latencyMs: result.latencyMs,
    selected: result.selected,
    terminalType: result.terminal.type,
    responseStatus: result.terminal.status,
    completed: result.ok && result.terminal.type === "response.completed" && result.terminal.status === "completed",
    outputChars: result.text.length,
  };
}

function compactFailure(result) {
  if (result.ok) return {};
  const error = result.value?.error;
  const message = String(error?.message || "")
    .replaceAll(/https?:\/\/[^\s"']+/gu, "[URL]")
    .replaceAll(/[A-Za-z0-9_-]{32,}/gu, "[REDACTED]")
    .slice(0, 240);
  return {
    status: result.status,
    ...(error?.code !== undefined ? { errorCode: error.code } : {}),
    ...(message ? { errorMessage: message } : {}),
  };
}

function checkFixture(text, fixture) {
  const lower = text.toLowerCase();
  return fixture.checks.map(([id, description, patterns]) => ({
    id,
    description,
    pass: patterns.every((pattern) => new RegExp(pattern, "u").test(lower)),
  }));
}

function boundedJudgment(text) {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= 1600 ? normalized : `${normalized.slice(0, 1597)}...`;
}

function functionCall(result, name) {
  return result.output.find((item) => item?.type === "function_call" && item.name === name);
}

function toolDefinition() {
  return {
    type: "function",
    name: "inspect_synthetic_trace",
    description: "Return the fixed synthetic trace for a donor evaluation fixture.",
    strict: true,
    parameters: {
      type: "object",
      properties: { fixture_id: { type: "string", enum: ["D04"] } },
      required: ["fixture_id"],
      additionalProperties: false,
    },
  };
}

function responseInput(text) {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }];
}

async function runDonorLeg({ url, headers, model, instructions, fixture, selectedModel }) {
  const baseBody = {
    model,
    input: responseInput(fixture.prompt),
    instructions,
    store: false,
    stream: true,
    reasoning: { effort: fixture.effort },
  };
  let first;
  let final;
  let toolRoundTrip = null;
  if (fixture.requiresTool) {
    first = await post(url, {
      ...baseBody,
      tools: [toolDefinition()],
      tool_choice: "required",
    }, headers);
    const call = functionCall(first, "inspect_synthetic_trace");
    let validArguments = false;
    try { validArguments = JSON.parse(call?.arguments || "null")?.fixture_id === fixture.id; } catch {}
    toolRoundTrip = {
      requested: true,
      callCompleted: compactResult(first).completed,
      correctTool: Boolean(call),
      validArguments,
      resultSupplied: Boolean(call && validArguments),
      observedOutputKinds: first.output.map((item) => ({ type: item?.type || null, name: item?.name || null })),
    };
    if (call && validArguments) {
      final = await post(url, {
        ...baseBody,
        input: [
          ...responseInput(fixture.prompt),
          { type: "function_call", name: call.name, call_id: call.call_id, arguments: call.arguments },
          { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(fixture.toolResult) },
        ],
        tools: [toolDefinition()],
        tool_choice: "none",
      }, headers);
      toolRoundTrip.finalCompleted = compactResult(final).completed;
    } else {
      final = first;
      toolRoundTrip.finalCompleted = false;
    }
  } else {
    final = await post(url, baseBody, headers);
  }
  const checks = checkFixture(final.text, fixture);
  const compact = compactResult(final);
  return {
    ...compact,
    selectedExpected: selectedModel,
    selectedMatches: selectedModel === null ? final.selected === null : final.selected === selectedModel,
    semanticChecks: checks,
    semanticPass: compact.completed &&
      (selectedModel === null ? final.selected === null : final.selected === selectedModel) &&
      checks.every((check) => check.pass) &&
      (!toolRoundTrip || [
        toolRoundTrip.requested,
        toolRoundTrip.callCompleted,
        toolRoundTrip.correctTool,
        toolRoundTrip.validArguments,
        toolRoundTrip.resultSupplied,
        toolRoundTrip.finalCompleted,
      ].every(Boolean)),
    judgmentExcerpt: boundedJudgment(final.text),
    ...(toolRoundTrip ? { toolRoundTrip } : {}),
  };
}

function recheckDonorLeg(previous, fixture) {
  const checks = checkFixture(previous.judgmentExcerpt, fixture);
  const toolPassed = !previous.toolRoundTrip || [
    previous.toolRoundTrip.requested,
    previous.toolRoundTrip.callCompleted,
    previous.toolRoundTrip.correctTool,
    previous.toolRoundTrip.validArguments,
    previous.toolRoundTrip.resultSupplied,
    previous.toolRoundTrip.finalCompleted,
  ].every(Boolean);
  return {
    ...previous,
    semanticChecks: checks,
    semanticPass: previous.completed && previous.selectedMatches && checks.every((check) => check.pass) && toolPassed,
  };
}

function summaryLatencies(rows) {
  const values = rows.map((row) => row.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return { count: 0, medianMs: null, p95Ms: null };
  return {
    count: values.length,
    medianMs: values[Math.floor((values.length - 1) * 0.5)],
    p95Ms: values[Math.floor((values.length - 1) * 0.95)],
  };
}

async function main() {
  if (!QUOTA_AUTHORIZED) {
    throw new Error("pass --authorized-native-quota only after explicit native quota authorization");
  }
  const callerSecret = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
  // This harness is an explicitly authorized, bounded native-quota caller. It
  // uses the signed-in Codex session only for this isolated evaluation and
  // never changes the shared Router consent marker or installed service.
  const nativeHeaders = await nativeAccountCatalogHeaders();
  if (!nativeHeaders) throw new Error("no usable signed-in Codex session is available");
  const routerBase = callerBaseUrl(PORTS.router, callerSecret);
  const routerHealth = await fetch(`http://127.0.0.1:${PORTS.router}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!routerHealth.ok) throw new Error("installed Router is not healthy");
  const routerHealthValue = await routerHealth.json();

  const binary = CANDIDATE_BINARY
    ? path.resolve(CANDIDATE_BINARY)
    : path.join(CODEX_HOME, "switchyard", "switchyard-server.exe");
  const templatePath = INSTALLED_BASELINE
    ? path.join(CODEX_HOME, "switchyard", "routes.toml")
    : path.resolve(CANDIDATE_CONFIG || path.join(ROOT, "config", "switchyard", "routes.template.toml"));
  const template = readFileSync(templatePath, "utf8");
  const sourceProvenance = selectedSourceProvenance({
    binary,
    candidateBinary: Boolean(CANDIDATE_BINARY),
  });
  const routes = template.replace("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__", routerBase) + forcedRoutes();
  const tempRoot = path.join(os.tmpdir(), `switchyard-a2-${randomBytes(8).toString("hex")}`);
  const configPath = path.join(tempRoot, "routes.toml");
  const logPath = path.join(tempRoot, "routing.jsonl");
  const capability = randomBytes(32).toString("base64url");
  const port = await openPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;
  try {
    writePrivateFile(configPath, routes);
    protectPrivateFile(configPath);
    const dryRun = spawnSync(binary, ["--config", configPath, "--host", "127.0.0.1", "--dry-run"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability },
    });
    if (dryRun.status !== 0) throw new Error("candidate route dry-run failed");
    child = spawn(binary, [
      "--config", configPath, "--host", "127.0.0.1", "--port", String(port),
      "--routing-log-file", logPath,
    ], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, CODEX_ROUTER_SWITCHYARD_CAPABILITY: capability },
    });
    let childError = "";
    child.stderr.on("data", (chunk) => { childError = `${childError}${chunk}`.slice(-4096); });
    await waitHealthy(baseUrl, child);

    const commonHeaders = {
      ...nativeHeaders,
      "x-codex-router-switchyard-capability": capability,
    };
    const prior = ANSWERS_ONLY || AFFINITY_ONLY || DONORS_ONLY
      ? JSON.parse(readFileSync(OUTPUT, "utf8"))
      : undefined;
    const classifierCases = B1_SMOKE
      ? CLASSIFIER_CASES.filter(([id]) => B1_SMOKE_CASE_IDS.has(id))
      : CLASSIFIER_CASES;
    const classification = prior?.classification || [];
    if (!ANSWERS_ONLY && !AFFINITY_ONLY && !DONORS_ONLY) {
      for (const [id, acceptable, prompt] of classifierCases) {
        const result = await post(`${baseUrl}/v1/decision`, {
          input_format: "openai_responses",
          request: { model: "switchyard-auto", input: prompt, store: false, stream: false },
        }, { ...commonHeaders, "x-switchyard-session-id": `classifier-${id}` });
        const selected = result.value?.selected?.target || null;
        classification.push({
          id,
          acceptable,
          selected,
          pass: result.ok && acceptable.includes(selected),
          latencyMs: result.latencyMs,
          ...compactFailure(result),
        });
        process.stderr.write(`classifier ${classification.length}/${classifierCases.length}\r`);
      }
      process.stderr.write("\n");
    }

    const forced = prior?.forced && (AFFINITY_ONLY || DONORS_ONLY) ? prior.forced : [];
    if (!AFFINITY_ONLY && !DONORS_ONLY && !B1_SMOKE) {
      for (const target of TARGETS) {
        const result = await post(`${baseUrl}/v1/responses`, {
          model: FORCED_IDS[target],
          input: responseInput("Synthetic transport smoke. Reply with exactly: SWITCHYARD_FORCED_OK"),
          store: false,
          stream: false,
        }, { ...commonHeaders, "x-switchyard-session-id": `forced-${target}` });
        forced.push({ target, ...compactResult(result), marker: result.text.includes("SWITCHYARD_FORCED_OK") });
      }
    }

    const ordinary = prior?.ordinary && (AFFINITY_ONLY || DONORS_ONLY) ? prior.ordinary : [];
    if (!AFFINITY_ONLY && !DONORS_ONLY) {
      for (const target of TARGETS) {
        const chosen = classification.find((row) => row.selected === target);
        if (!chosen) {
          ordinary.push({ target, skipped: "classifier did not select target in sanity corpus" });
          continue;
        }
        const prompt = classifierCases.find(([id]) => id === chosen.id)[2];
        const result = await post(`${baseUrl}/v1/responses`, {
          model: "switchyard-auto",
          input: responseInput(`${prompt}\nRespond in at most 80 words.`),
          store: false,
          stream: false,
        }, { ...commonHeaders, "x-switchyard-session-id": `ordinary-${target}` });
        ordinary.push({ target, sourceCase: chosen.id, ...compactResult(result) });
      }
    }

    const transitions = prior?.transitions || [];
    if (!ANSWERS_ONLY && !AFFINITY_ONLY && !DONORS_ONLY && !B1_SMOKE) {
      const transitionPrompts = ["L01", "S01", "A01", "X01", "A03", "S02", "L02"];
      for (const id of transitionPrompts) {
        const prompt = CLASSIFIER_CASES.find(([caseId]) => caseId === id)[2];
        const result = await post(`${baseUrl}/v1/decision`, {
          input_format: "openai_responses",
          request: { model: "switchyard-auto", input: prompt, store: false, stream: false },
        }, { ...commonHeaders, "x-switchyard-session-id": "transition-sequence" });
        transitions.push({ id, selected: result.value?.selected?.target || null, status: result.status, latencyMs: result.latencyMs });
      }
    }

    const affinity = AFFINITY_ONLY ? [] : prior?.affinity || [];
    if ((!ANSWERS_ONLY && !DONORS_ONLY) || AFFINITY_ONLY) {
      const affinityOpening = await post(`${baseUrl}/v1/decision`, {
        input_format: "openai_responses",
        request: { model: "switchyard-auto", input: CLASSIFIER_CASES[7][2], store: false, stream: false },
      }, { ...commonHeaders, "x-switchyard-session-id": "affinity-sequence" });
      affinity.push({
        itemType: "message",
        selected: affinityOpening.value?.selected?.target || null,
        status: affinityOpening.status,
        ...compactFailure(affinityOpening),
      });
      const affinityItemTypes = B1_SMOKE ? ["function_call_output"] : [
        "function_call_output",
        "custom_tool_call_output",
        "computer_call_output",
        "local_shell_call_output",
        "tool_search_output",
      ];
      for (const itemType of affinityItemTypes) {
        const callType = itemType === "function_call_output"
          ? "function_call"
          : itemType === "custom_tool_call_output" ? "custom_tool_call" : undefined;
        const input = callType
          ? [
              callType === "function_call"
                ? { type: callType, name: "fixture_tool", call_id: "call_fixture", arguments: "{}" }
                : { type: callType, name: "fixture_tool", call_id: "call_fixture", input: "fixture" },
              { type: itemType, call_id: "call_fixture", output: "synthetic result" },
            ]
          : [{ type: itemType, call_id: "call_fixture", output: "synthetic result" }];
        const result = await post(`${baseUrl}/v1/decision`, {
          input_format: "openai_responses",
          request: { model: "switchyard-auto", input, store: false, stream: false },
        }, { ...commonHeaders, "x-switchyard-session-id": "affinity-sequence" });
        affinity.push({
          itemType,
          selected: result.value?.selected?.target || null,
          status: result.status,
          ...compactFailure(result),
        });
      }
    }

    const native = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    const candidateCatalog = buildMergedCatalog(native, [MODEL_BY_SLUG.get("switchyard/auto")]);
    const astra = native.models.find((model) => model.slug === "gpt-6-astra");
    const switchyard = candidateCatalog.find((model) => model.slug === "switchyard/auto");
    const donorFixtures = B1_SMOKE
      ? []
      : DONOR_IDS ? ALL_DONOR_CASES.filter((fixture) => DONOR_IDS.includes(fixture.id)) : ALL_DONOR_CASES;
    if (DONOR_IDS && donorFixtures.length !== DONOR_IDS.length) throw new Error(`unknown donor fixture in: ${DONOR_IDS.join(",")}`);
    const comparisons = AFFINITY_ONLY
      ? prior.donorComparisons
      : DONOR_IDS ? prior.donorComparisons.filter((row) => !DONOR_IDS.includes(row.id)) : [];
    const semanticInstruction = "Analyze only the supplied synthetic fixture. Return a concise factual review under 220 words with Finding, Invariant, Remediation, and Verification. Do not repeat the source code.";
    for (const fixture of AFFINITY_ONLY ? [] : donorFixtures) {
      const routedTarget = fixture.effort === "xhigh" ? "astra_xhigh" : "astra_medium";
      const previous = prior?.donorComparisons.find((row) => row.id === fixture.id);
      const direct = RECHECK_ONLY ? recheckDonorLeg(previous.direct, fixture) : await runDonorLeg({
        url: `${routerBase}/responses`,
        headers: nativeHeaders,
        model: "gpt-6-astra",
        instructions: `${astra.base_instructions}\n${semanticInstruction}`,
        fixture,
        selectedModel: null,
      });
      const routed = RECHECK_ONLY ? recheckDonorLeg(previous.routed, fixture) : await runDonorLeg({
        url: `${baseUrl}/v1/responses`,
        headers: { ...commonHeaders, "x-switchyard-session-id": `donor-${fixture.id}` },
        model: FORCED_IDS[routedTarget],
        instructions: `${switchyard.base_instructions}\n${semanticInstruction}`,
        fixture,
        selectedModel: `switchyard/${routedTarget.replace("_", "-")}`,
      });
      comparisons.push({
        id: fixture.id,
        effort: fixture.effort,
        expectedChecks: fixture.checks.map(([id, description]) => ({ id, description })),
        direct,
        routed,
        pairPass: direct.semanticPass && routed.semanticPass,
      });
      process.stderr.write(`donor ${fixture.id}\r`);
    }
    if (!AFFINITY_ONLY) process.stderr.write("\n");
    comparisons.sort((left, right) => ALL_DONOR_CASES.findIndex((row) => row.id === left.id) - ALL_DONOR_CASES.findIndex((row) => row.id === right.id));

    const decisionLatencies = [...classification, ...transitions];
    const answerLatencies = [
      ...forced.filter((row) => !row.skipped),
      ...ordinary.filter((row) => !row.skipped),
      ...comparisons.flatMap((row) => [row.direct, row.routed]),
    ];
    const candidateRouterSourceSha256 = sourceHashes([
      "src/catalog.mjs",
      "src/namespace-relay.mjs",
      "src/routed-models.mjs",
      "src/router.mjs",
    ]);
    const installManifest = readJson(INSTALL_MANIFEST_PATH);
    const installedRouterCommit = installManifest.current?.commit;
    if (!/^[a-f0-9]{40}$/u.test(installedRouterCommit || "")) {
      throw new Error("installed Router manifest does not name an exact commit");
    }
    const boundaryDisagreements = classification.filter((row) => !row.pass).map((row) => row.id);
    const ordinaryTargetsPassed = ordinary.filter((row) =>
      row.completed && row.selected === `switchyard/${row.target.replace("_", "-")}`
    ).length;
    const requiredFailures = B1_SMOKE
      ? [
          ...(classification.length === TARGETS.length && boundaryDisagreements.length === 0 ? [] : ["classifier_roles"]),
          ...(ordinaryTargetsPassed === TARGETS.length ? [] : ["ordinary_answers"]),
          ...(affinity.length > 0 && affinity.every((row) => row.status === 200 && row.selected === affinity[0].selected) ? [] : ["affinity"]),
        ]
      : [
          ...(forced.filter((row) => row.completed && row.marker && row.selected === `switchyard/${row.target.replace("_", "-")}`).length === TARGETS.length ? [] : ["forced_targets"]),
          ...(ordinary.filter((row) => row.completed).length === TARGETS.length ? [] : ["ordinary_answers"]),
          ...(transitions.every((row) => row.status === 200) ? [] : ["transitions"]),
          ...(affinity.length > 0 && affinity.every((row) => row.status === 200 && row.selected === affinity[0].selected) ? [] : ["affinity"]),
          ...comparisons.filter((row) => !row.pairPass).map((row) => `donor:${row.id}`),
        ];
    const evidence = {
      schemaVersion: 3,
      checkpoint: B1_SMOKE ? "SY-B1-R1" : "SY-A2",
      date: new Date().toISOString(),
      candidate: {
        installedRouterCommit,
        templateSha256: sha256(template),
        configSelection: INSTALLED_BASELINE ? "installed-baseline" : "candidate",
        switchyardSource: sourceProvenance,
        caseSetSha256: sha256(JSON.stringify({ CLASSIFIER_CASES, DONOR_CASES, XHIGH_DONOR_CASES })),
        routerSourceSha256: candidateRouterSourceSha256,
        routedInstructionsSha256: sha256(switchyard.base_instructions),
        donorInstructionsSha256: sha256(astra.base_instructions),
      },
      method: {
        isolatedRuntime: true,
        runtimeScope: `${sourceProvenance.selection} Switchyard binary with ${INSTALLED_BASELINE ? "installed" : "candidate"} configuration calling the installed Router service`,
        installedRouter: { service: routerHealthValue.service, version: routerHealthValue.version },
        candidateRouterExecutedEndToEnd: false,
        installedServiceChanged: false,
        protectedDecisionPath: true,
        fullPromptsOrResponsesRetained: false,
        boundedSyntheticJudgmentExcerptsRetained: !B1_SMOKE,
        donorTerminalEventsRequired: !B1_SMOKE,
        priorTransportRowsRetainedWithoutRerun: DONORS_ONLY,
        semanticRecheckFixtures: RECHECK_ONLY ? DONOR_IDS : [],
        checkerRepairNotes: B1_SMOKE ? [] : [
          "Equivalent synthetic wording such as second charge and numeric one was added after the first checker run exposed overly narrow keyword patterns.",
          "The XHigh cancellation criterion was corrected from a naive local recheck to serialized or atomic commit/cancel ordering after both answers identified the stronger invariant.",
        ],
        b1Smoke: B1_SMOKE,
        classifierCases: classifierCases.length,
        mediumDonorPairs: donorFixtures.filter((fixture) => fixture.effort === "medium").length,
        xhighDonorPairs: donorFixtures.filter((fixture) => fixture.effort === "xhigh").length,
      },
      preflightDiagnostics: prior?.preflightDiagnostics || [],
      classification,
      forced,
      ordinary,
      transitions,
      affinity,
      donorComparisons: comparisons,
      summary: {
        classificationAcceptable: classification.filter((row) => row.pass).length,
        classificationTotal: classification.length,
        selectedCounts: Object.fromEntries(TARGETS.map((target) => [target, classification.filter((row) => row.selected === target).length])),
        forcedPassed: forced.filter((row) => row.completed && row.marker && row.selected === `switchyard/${row.target.replace("_", "-")}`).length,
        ordinaryCompleted: ordinary.filter((row) => row.completed).length,
        ordinaryTargetIdentitiesPassed: ordinaryTargetsPassed,
        affinityStable: affinity.every((row) => row.status === 200 && row.selected === affinity[0].selected),
        donorPairsComplete: comparisons.filter((row) => row.direct.completed && row.routed.completed).length,
        semanticDonorPairsPassed: comparisons.filter((row) => row.pairPass).length,
        toolRoundTripLegsPassed: comparisons.flatMap((row) => [row.direct, row.routed])
          .filter((row) => row.toolRoundTrip && [
            row.toolRoundTrip.requested,
            row.toolRoundTrip.callCompleted,
            row.toolRoundTrip.correctTool,
            row.toolRoundTrip.validArguments,
            row.toolRoundTrip.resultSupplied,
            row.toolRoundTrip.finalCompleted,
          ].every(Boolean)).length,
        classifierBoundaryDisagreements: boundaryDisagreements,
        requiredFailures,
        requiredCasesPassed: requiredFailures.length === 0,
        decisionLatency: summaryLatencies(decisionLatencies),
        answerLatency: summaryLatencies(answerLatencies),
      },
      limitations: [
        "Synthetic sanity evidence is not a statistical accuracy estimate.",
        ...(B1_SMOKE ? [] : ["Semantic checks cover predeclared facts in six bounded fixtures; they do not establish general model quality."]),
        "The isolated runtime exercised the selected Switchyard binary and configuration against the unchanged installed Router; the Router source hashes are not a new Router deployment claim.",
        "No private conversation, repository payload, deployment, or v2 certification was exercised.",
      ],
    };
    writeFileSync(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(evidence.summary)}\n`);
    if (childError.includes("panicked")) throw new Error("isolated Switchyard reported a panic");
    if (requiredFailures.length) {
      throw new Error(`required ${B1_SMOKE ? "B1 smoke" : "A2"} cases failed: ${requiredFailures.join(", ")}`);
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const safe = String(error?.message || error)
    .replaceAll(/[A-Za-z0-9_-]{32,}/gu, "[REDACTED]")
    .replaceAll(/\/_codex-router\/[^/\s]+/gu, "/_codex-router/[REDACTED]");
  console.error(`Switchyard ${B1_SMOKE ? "B1 smoke" : "A2 evaluation"} failed: ${safe}`);
  process.exitCode = 1;
});
