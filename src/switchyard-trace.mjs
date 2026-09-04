import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_PATH } from "./paths.mjs";

const SWITCHYARD_START = "Switchyard libsy server";

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function statusFrom(line) {
  const match = /\bstatus=(\d{3})\b/u.exec(line);
  return match ? match[1] : undefined;
}

function timestampFrom(line) {
  return /\bat=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/u.exec(line)?.[1] ||
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/u.exec(line)?.[1];
}

export function summarizeSwitchyardTrace(contents) {
  const text = String(contents || "");
  const marker = text.lastIndexOf(SWITCHYARD_START);
  if (marker < 0) {
    return { version: 1, generationFound: false };
  }

  const lines = text.slice(marker).split(/\r?\n/u);
  const summary = {
    version: 1,
    generationFound: true,
    since: null,
    until: null,
    classifierConsultations: 0,
    routedRequests: { total: 0, statuses: {} },
    nativeOpenAIRequests: {
      total: 0,
      statuses: {},
      scope: "all native OpenAI timings since this Switchyard generation started",
    },
    switchyardServerRequests: { total: 0, statuses: {} },
    selectedTargets: {},
    failures: {
      http: 0,
      nonEmptyServerErrors: 0,
      judgeUnavailable: 0,
      parseErrors: 0,
      fallback: 0,
    },
    continuity: { uniqueAgentIds: 0, uniqueCorrelationIds: 0 },
  };
  const agentIds = new Set();
  const correlationIds = new Set();

  for (const line of lines) {
    const timestamp = timestampFrom(line);
    if (timestamp) {
      summary.since ||= timestamp;
      summary.until = timestamp;
    }

    const agentId = /\bagent_id="([^"]+)"/u.exec(line)?.[1];
    const correlationId = /\bcorrelation_id="([^"]+)"/u.exec(line)?.[1];
    if (agentId) agentIds.add(agentId);
    if (correlationId) correlationIds.add(correlationId);

    if (line.includes("consulting llm judge")) summary.classifierConsultations += 1;
    if (/judge verdict unavailable/iu.test(line)) summary.failures.judgeUnavailable += 1;
    if (/parse error|failed to parse|could not parse/iu.test(line)) summary.failures.parseErrors += 1;
    if (/falling back|fallback route|fallback target/iu.test(line)) summary.failures.fallback += 1;

    const selected = /\bselected_model="([^"]+)"/u.exec(line)?.[1];
    if (selected) increment(summary.selectedTargets, selected);

    const status = statusFrom(line);
    if (status && Number(status) >= 400) summary.failures.http += 1;
    if (/\berror="[^"]+"/u.test(line)) summary.failures.nonEmptyServerErrors += 1;

    let bucket;
    if (line.includes("model=switchyard/auto") && line.includes("provider=switchyard")) {
      bucket = summary.routedRequests;
    } else if (/\bmodel=gpt-[^ ]+\s+provider=openai\b/u.test(line)) {
      bucket = summary.nativeOpenAIRequests;
    } else if (line.includes("LLM request handled") && line.includes("wire_format=openai_responses")) {
      bucket = summary.switchyardServerRequests;
    }
    if (bucket && status) {
      bucket.total += 1;
      increment(bucket.statuses, status);
    }
  }

  summary.continuity.uniqueAgentIds = agentIds.size;
  summary.continuity.uniqueCorrelationIds = correlationIds.size;
  return summary;
}

function main() {
  const summary = summarizeSwitchyardTrace(readFileSync(LOG_PATH, "utf8"));
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
