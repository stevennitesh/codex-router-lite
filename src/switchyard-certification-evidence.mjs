import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_PATH } from "./paths.mjs";
import { latestSwitchyardGeneration, summarizeSwitchyardTrace } from "./switchyard-trace.mjs";
import { switchyardRuntimeStatus } from "./switchyard-runtime.mjs";
import { observationIdentity } from "./request-observation.mjs";

function field(line, name) { return new RegExp(`\\b${name}=([^ \\t]+)`, "u").exec(line)?.[1]; }

// Rust traces retain sub-millisecond precision at the bounded proof window.
function traceInstant(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value || "");
  if (!match) return undefined;
  const base = `${match[1]}.000Z`, milliseconds = Date.parse(base);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== base) return undefined;
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] || "").padEnd(9, "0"));
}

function selectChildObservations(generation, routingLog, child) {
  const thread = observationIdentity("thread", child.threadId);
  const start = traceInstant(child.startedAt), end = traceInstant(child.endedAt);
  if (!thread || start === undefined || end === undefined || start >= end) throw new Error("A bounded child observation identity is required.");
  const within = value => { const at = traceInstant(value); return at !== undefined && at >= start && at <= end; };
  const lines = generation.split(/\r?\n/u);
  const timings = lines.filter(line => line.includes(" timing ") && field(line, "thread_sha256") === thread &&
    field(line, "model") === "switchyard/auto" && within(field(line, "at")));
  const sessions = new Set(timings.map(line => field(line, "session_sha256")));
  const session = sessions.size === 1 ? [...sessions][0] : undefined;
  const validSession = typeof session === "string" && /^[a-f0-9]{64}$/u.test(session);
  // The upstream routing log has session IDs but no agent IDs. Do not attribute
  // a shared session to a child when another observed thread uses it too.
  const ambiguous = validSession && lines.some(line => line.includes(" timing ") &&
    field(line, "session_sha256") === session && field(line, "thread_sha256") !== thread &&
    field(line, "model") === "switchyard/auto" && within(field(line, "at")));
  const selected = lines.filter((line, index) => {
    if (index === 0) return true;
    const agent = /\bagent_id="([^"]+)"/u.exec(line)?.[1];
    const matches = field(line, "thread_sha256") === thread || observationIdentity("thread", agent) === thread;
    const at = field(line, "at") || /^(\d{4}-\d{2}-\d{2}T[^ ]+Z)/u.exec(line)?.[1];
    return matches && within(at);
  });
  const routing = String(routingLog || "").split(/\r?\n/u).flatMap(line => {
    try {
      const record = JSON.parse(line);
      return validSession && observationIdentity("session", record?.session_id) === session && within(record.ts) ? [line] : [];
    } catch { return []; }
  });
  return {routerLog:selected.join("\n"),routingLog:routing.join("\n"),attributed:Boolean(validSession && !ambiguous)};
}

function numericField(line, name) {
  const match = new RegExp(`\\b${name}=(\\d+)\\b`, "u").exec(line);
  return match ? Number(match[1]) : undefined;
}

function routerTiming(line) {
  if (!line.includes("model=switchyard/auto") || !line.includes("provider=switchyard")) {
    return undefined;
  }
  const at = /\bat=([^ ]+)/u.exec(line)?.[1];
  const status = numericField(line, "status");
  if (!at || status === undefined) return undefined;
  return {
    at,
    status,
    ...(numericField(line, "total_ms") !== undefined
      ? { totalMs: numericField(line, "total_ms") }
      : {}),
    ...(numericField(line, "out_tokens") !== undefined
      ? { outputTokens: numericField(line, "out_tokens") }
      : {}),
    ...(numericField(line, "cached_tokens") !== undefined
      ? { cachedTokens: numericField(line, "cached_tokens") }
      : {}),
  };
}

function routingRecord(line) {
  try {
    const record = JSON.parse(line);
    if (!record?.ts || !record?.model) return undefined;
    return {
      at: record.ts,
      model: record.model,
      promptTokens: Number(record.prompt_tokens) || 0,
      cachedTokens: Number(record.cached_tokens) || 0,
      completionTokens: Number(record.completion_tokens) || 0,
      sessionId: typeof record.session_id === "string" ? record.session_id : undefined,
    };
  } catch {
    return undefined;
  }
}

function statusCounts(timings) {
  const counts = {};
  for (const { status } of timings) counts[status] = (counts[status] || 0) + 1;
  return counts;
}

export function summarizeSwitchyardCertificationEvidence({
  routerLog,
  routingLog,
  limit = 20,
  child,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Certification evidence limit must be an integer from 1 to 100.");
  }
  let attribution;
  if (child) {
    const generation = latestSwitchyardGeneration(routerLog);
    if (generation === undefined) return { version: 1, generationFound: false };
    attribution = selectChildObservations(generation, routingLog, child);
    ({routerLog,routingLog} = attribution);
  }
  const trace = summarizeSwitchyardTrace(routerLog);
  if (!trace.generationFound) return { version: 1, generationFound: false };

  const generation = latestSwitchyardGeneration(routerLog);
  const timings = generation.split(/\r?\n/u).map(routerTiming).filter(Boolean);
  const sinceMs = trace.since ? Date.parse(trace.since) : Number.NaN;
  const parsedRouting = String(routingLog || "")
    .split(/\r?\n/u)
    .map(routingRecord)
    .filter(Boolean)
    .filter((record) => child || !Number.isFinite(sinceMs) || Date.parse(record.at) >= sinceMs);
  const sessionCount = new Set(parsedRouting.map(({ sessionId }) => sessionId).filter(Boolean)).size;
  const routing = parsedRouting.map(({ sessionId: _sessionId, ...record }) => record);

  return {
    version: 1,
    generationFound: true,
    ...(child ? {scope:"child",attributed:attribution.attributed && trace.continuity.uniqueAgentIds === 1 && Object.keys(trace.selectedTargets).length > 0} : {}),
    since: child?.startedAt || trace.since,
    until: child?.endedAt || trace.until,
    router: {
      total: timings.length,
      successful: timings.filter(({ status }) => status >= 200 && status < 300).length,
      statuses: statusCounts(timings),
      recent: timings.slice(-limit),
    },
    routing: {
      total: routing.length,
      uniqueSessions: sessionCount,
      selectedModels: trace.selectedTargets,
      recent: routing.slice(-limit),
    },
    classifier: trace.classifier,
    failures: trace.failures,
  };
}

function limitFrom(args) {
  const index = args.indexOf("--limit");
  if (index < 0) return 20;
  return Number(args[index + 1]);
}

function main() {
  const runtime = switchyardRuntimeStatus();
  if (!runtime.ready) {
    throw new Error("Switchyard certification evidence is unavailable because the runtime is not readable.");
  }
  const summary = summarizeSwitchyardCertificationEvidence({
    routerLog: readFileSync(LOG_PATH, "utf8"),
    routingLog: readFileSync(path.join(runtime.runtimeRoot, "routing.jsonl"), "utf8"),
    limit: limitFrom(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.generationFound) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
