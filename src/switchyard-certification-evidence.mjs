import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_PATH } from "./paths.mjs";
import { latestSwitchyardGeneration, summarizeSwitchyardTrace } from "./switchyard-trace.mjs";
import { switchyardRuntimeStatus } from "./switchyard-runtime.mjs";

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
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Certification evidence limit must be an integer from 1 to 100.");
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
    .filter((record) => !Number.isFinite(sinceMs) || Date.parse(record.at) >= sinceMs);
  const sessionCount = new Set(parsedRouting.map(({ sessionId }) => sessionId).filter(Boolean)).size;
  const routing = parsedRouting.map(({ sessionId: _sessionId, ...record }) => record);

  return {
    version: 1,
    generationFound: true,
    since: trace.since,
    until: trace.until,
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
