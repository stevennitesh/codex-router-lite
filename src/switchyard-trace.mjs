import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_PATH } from "./paths.mjs";
import { switchyardRuntimeStatus } from "./switchyard-runtime.mjs";
import { nativeAttemptLogPath } from "./switchyard-native-observation.mjs";

const SWITCHYARD_START = "Switchyard libsy server";
const TOKEN_FIELDS = Object.freeze([
  ["prompt_tokens", "promptTokens"],
  ["cached_tokens", "cachedTokens"],
  ["cache_creation_tokens", "cacheCreationTokens"],
  ["completion_tokens", "completionTokens"],
  ["reasoning_tokens", "reasoningTokens"],
  ["total_tokens", "totalTokens"],
]);
const KNOWN_TARGETS = Object.freeze({
  "switchyard/luna-max": Object.freeze({ key: "lunaMax", model: "gpt-5.6-luna", effort: "max" }),
  "switchyard/sol-medium": Object.freeze({ key: "solMedium", model: "gpt-5.6-sol", effort: "medium" }),
  "switchyard/astra-medium": Object.freeze({ key: "astraMedium", model: "gpt-6-astra", effort: "medium" }),
  "switchyard/astra-xhigh": Object.freeze({ key: "astraXhigh", model: "gpt-6-astra", effort: "xhigh" }),
});
const KNOWN_ALGORITHMS = new Set(["type_safe_task_classifier", "noop"]);
const KNOWN_FALLBACK_REASONS = new Set([
  "empty_state", "non_text_state", "low_confidence", "classifier_unavailable",
  "classifier_timeout", "provider_http_error", "malformed_response", "state_too_large",
  "invalid_confidence", "unresolved_label",
]);
const KNOWN_CLASSIFIER_TARGETS = new Set(["luna_max", "sol_medium", "astra_medium", "astra_xhigh"]);

export function latestSwitchyardGeneration(contents) {
  const text = String(contents || "");
  const marker = text.lastIndexOf(SWITCHYARD_START);
  if (marker < 0) return undefined;
  const lineStart = text.lastIndexOf("\n", marker) + 1;
  return text.slice(lineStart);
}

function increment(record, key, amount = 1) {
  record[key] = (record[key] || 0) + amount;
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
  const generation = latestSwitchyardGeneration(contents);
  if (generation === undefined) {
    return { version: 1, generationFound: false };
  }

  const lines = generation.split(/\r?\n/u);
  const summary = {
    version: 1,
    generationFound: true,
    since: null,
    until: null,
    classifierConsultations: 0,
    classifier: {
      decisions: 0,
      fallbacks: 0,
      providerModels: {},
      finalTargets: {},
      latency: { count: 0, maximumMs: null },
      recent: [],
    },
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

    const evidenceSource = /\b(?:evidence\.source|evidence_source)="([^"]+)"/u.exec(line)?.[1];
    if (evidenceSource === "type_safe_classifier" || evidenceSource === "fail_open") {
      const providerModel = /\b(?:evidence\.provider_model|evidence_provider_model)="([^"]+)"/u.exec(line)?.[1];
      const finalTarget = /\b(?:evidence\.final_target|evidence_final_target)="([^"]+)"/u.exec(line)?.[1];
      const reasonCode = /\b(?:evidence\.reason_code|evidence_reason_code)="([^"]+)"/u.exec(line)?.[1];
      const httpStatus = Number(/\b(?:evidence\.http_status|evidence_http_status)=(\d{3})/u.exec(line)?.[1]);
      const confidence = Number(/\b(?:evidence\.confidence|evidence_confidence)=([0-9]+(?:\.[0-9]+)?)/u.exec(line)?.[1]);
      const threshold = Number(/\b(?:evidence\.threshold|evidence_threshold)=([0-9]+(?:\.[0-9]+)?)/u.exec(line)?.[1]);
      const decisionLatencyMs = Number(/\b(?:evidence\.decision_latency_ms|evidence_decision_latency_ms)=(\d+)/u.exec(line)?.[1]);
      const probabilities = Object.fromEntries([
        "luna_max",
        "sol_medium",
        "astra_medium",
        "astra_xhigh",
      ].flatMap((label) => {
        const value = Number(new RegExp(`\\b(?:evidence\\.probability_${label}|evidence_probability_${label})=([0-9]+(?:\\.[0-9]+)?)`, "u").exec(line)?.[1]);
        return Number.isFinite(value) && value >= 0 && value <= 1 ? [[label, value]] : [];
      }));
      summary.classifier.decisions += 1;
      if (evidenceSource === "fail_open") summary.classifier.fallbacks += 1;
      if (providerModel) increment(summary.classifier.providerModels, providerModel);
      if (finalTarget) increment(summary.classifier.finalTargets, finalTarget);
      if (Number.isFinite(decisionLatencyMs)) {
        summary.classifier.latency.count += 1;
        summary.classifier.latency.maximumMs = Math.max(summary.classifier.latency.maximumMs ?? 0, decisionLatencyMs);
      }
      summary.classifier.recent.push({
        ...(timestamp ? { at: timestamp } : {}),
        source: evidenceSource,
        ...(providerModel ? { providerModel } : {}),
        ...(finalTarget ? { finalTarget } : {}),
        ...(reasonCode ? { reasonCode } : {}),
        ...(Number.isFinite(httpStatus) ? { httpStatus } : {}),
        ...(Number.isFinite(confidence) ? { confidence } : {}),
        ...(Number.isFinite(threshold) ? { threshold } : {}),
        ...(Number.isFinite(decisionLatencyMs) ? { decisionLatencyMs } : {}),
        ...(evidenceSource === "type_safe_classifier" && Object.keys(probabilities).length === 4
          ? { probabilities }
          : {}),
      });
      if (summary.classifier.recent.length > 20) summary.classifier.recent.shift();
    }

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

function emptyUsageCoverage() {
  return Object.fromEntries(TOKEN_FIELDS.map(([, output]) => [output, {
    recordedSum: 0,
    validRecords: 0,
    missingRecords: 0,
    invalidRecords: 0,
    explicitZeroRecords: 0,
  }]));
}

function recordUsage(coverage, record) {
  for (const [input, output] of TOKEN_FIELDS) {
    if (!Object.hasOwn(record, input) || record[input] === null) {
      coverage[output].missingRecords += 1;
      continue;
    }
    const value = record[input];
    if (!Number.isSafeInteger(value) || value < 0) {
      coverage[output].invalidRecords += 1;
      continue;
    }
    coverage[output].validRecords += 1;
    coverage[output].recordedSum += value;
    if (value === 0) coverage[output].explicitZeroRecords += 1;
  }
}

function safeTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? { value: new Date(milliseconds).toISOString(), milliseconds }
    : undefined;
}

function selectionTime(value, name) {
  if (value === undefined) return undefined;
  const timestamp = safeTimestamp(value);
  if (!timestamp) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return timestamp;
}

function safeBucket(value, known) {
  return typeof value === "string" && known.has(value) ? value : "unknown";
}

function incrementSession(session, record, targetKey) {
  session.records += 1;
  increment(session.targets, targetKey);
  recordUsage(session.usage, record);
  const timestamp = safeTimestamp(record.ts);
  if (timestamp) {
    if (!session.since || timestamp.milliseconds < session.sinceMs) {
      session.since = timestamp.value;
      session.sinceMs = timestamp.milliseconds;
    }
    if (!session.until || timestamp.milliseconds > session.untilMs) {
      session.until = timestamp.value;
      session.untilMs = timestamp.milliseconds;
    }
  }
}

/**
 * Summarize Switchyard serving records without exposing grouping identifiers or
 * treating normalized zeros as proof that usage was observed by the provider.
 */
export function summarizeSwitchyardUsage(routingContents, options = {}) {
  const since = selectionTime(options.since, "--since");
  const until = selectionTime(options.until, "--until");
  if (since && until && since.milliseconds > until.milliseconds) {
    throw new Error("--since must not be after --until");
  }
  const sessionId = options.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) {
    throw new Error("--session-id must be non-empty");
  }
  const detailLimit = options.limit ?? 20;
  if (!Number.isInteger(detailLimit) || detailLimit < 1 || detailLimit > 50) {
    throw new Error("--limit must be an integer from 1 through 50");
  }

  const summary = {
    version: 1,
    scope: "observed Switchyard routing.jsonl serving records only",
    selection: {
      session: sessionId === undefined ? "all sessions" : "one explicitly selected private session",
      since: since?.value ?? null,
      until: until?.value ?? null,
      taskBoundary: "user-selected segment; no task boundary or outcome inferred",
    },
    coverage: {
      totalLines: 0,
      parsedRecords: 0,
      malformedLines: 0,
      selectedRecords: 0,
      recordsOutsideSelection: 0,
      recordsWithoutUsableSession: 0,
      recordsWithoutValidTimestamp: 0,
      excludedWithoutValidTimestamp: 0,
    },
    targets: {
      lunaMax: { model: "gpt-5.6-luna", effort: "max", records: 0 },
      solMedium: { model: "gpt-5.6-sol", effort: "medium", records: 0 },
      astraMedium: { model: "gpt-6-astra", effort: "medium", records: 0 },
      astraXhigh: { model: "gpt-6-astra", effort: "xhigh", records: 0 },
      unknown: { model: "unknown", effort: "unknown", records: 0 },
    },
    algorithms: {},
    fallbackReasons: {},
    usage: emptyUsageCoverage(),
    sessions: [],
    sessionsOmitted: 0,
    serviceTier: {
      status: "unavailable",
      note: "blank or present routing-log tier values do not establish the billed service tier",
    },
    policyProvenance: {
      routingRecords: "unavailable",
      note: "current source or template identity is not assigned retroactively to routing records",
    },
    limitations: [
      "Recorded sums are partial observations, not task totals or subscription debits.",
      "Missing counters remain missing; explicit zero is ambiguous in this log version.",
      "Failed streaming attempts may have no routing record, and retries or extraction overhead are unlinked.",
      "Reasoning tokens are reported separately and are never added to completion tokens.",
      "HTTP success, a routing record, a session, and a completed user task are distinct facts.",
    ],
  };
  const sessions = new Map();
  for (const line of String(routingContents || "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    summary.coverage.totalLines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      summary.coverage.malformedLines += 1;
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      summary.coverage.malformedLines += 1;
      continue;
    }
    summary.coverage.parsedRecords += 1;
    const recordSession = typeof record.session_id === "string" && record.session_id.length
      ? record.session_id
      : undefined;
    if (!recordSession) summary.coverage.recordsWithoutUsableSession += 1;
    const timestamp = safeTimestamp(record.ts);
    if (!timestamp) summary.coverage.recordsWithoutValidTimestamp += 1;
    const sessionMatches = sessionId === undefined || recordSession === sessionId;
    const requiresTimestamp = Boolean(since || until);
    const timeMatches = !requiresTimestamp || Boolean(timestamp &&
      (!since || timestamp.milliseconds >= since.milliseconds) &&
      (!until || timestamp.milliseconds <= until.milliseconds));
    if (requiresTimestamp && !timestamp && sessionMatches) {
      summary.coverage.excludedWithoutValidTimestamp += 1;
    }
    if (!sessionMatches || !timeMatches) {
      summary.coverage.recordsOutsideSelection += 1;
      continue;
    }
    summary.coverage.selectedRecords += 1;
    const target = typeof record.model === "string" && Object.hasOwn(KNOWN_TARGETS, record.model)
      ? KNOWN_TARGETS[record.model]
      : undefined;
    const targetKey = target?.key || "unknown";
    summary.targets[targetKey].records += 1;
    increment(summary.algorithms, safeBucket(record.algorithm, KNOWN_ALGORITHMS));
    if (Object.hasOwn(record, "fallback_reason") && record.fallback_reason !== null) {
      increment(summary.fallbackReasons, safeBucket(record.fallback_reason, KNOWN_FALLBACK_REASONS));
    }
    recordUsage(summary.usage, record);

    const groupingKey = recordSession ?? null;
    let session = sessions.get(groupingKey);
    if (!session) {
      session = {
        records: 0,
        since: null,
        until: null,
        sinceMs: Number.POSITIVE_INFINITY,
        untilMs: Number.NEGATIVE_INFINITY,
        targets: {},
        usage: emptyUsageCoverage(),
      };
      sessions.set(groupingKey, session);
    }
    incrementSession(session, record, targetKey);
  }

  const ordered = [...sessions.entries()].sort((left, right) =>
    right[1].untilMs - left[1].untilMs || right[1].records - left[1].records);
  summary.sessions = ordered.slice(0, detailLimit).map(([key, session], index) => ({
    label: sessionId !== undefined
      ? "selected-session"
      : key === null ? "unassociated" : `session-${index + 1}`,
    records: session.records,
    since: session.since,
    until: session.until,
    targets: session.targets,
    usage: session.usage,
  }));
  summary.sessionsOmitted = Math.max(0, ordered.length - summary.sessions.length);
  return summary;
}

const NATIVE_MODELS = new Map([
  ["gpt-5.6-luna", "luna"],
  ["gpt-5.6-sol", "sol"],
  ["gpt-6-astra", "astra"],
]);
const NATIVE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "unknown"]);
const NATIVE_TIERS = new Set(["default", "priority", "flex", "unknown"]);
const NATIVE_OUTCOMES = new Set([
  "completed", "incomplete", "cancelled", "http_error", "stream_error",
  "transport_error", "empty_completion", "retryable_http", "unknown",
]);

function attemptCounterCoverage() {
  return Object.fromEntries([
    "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens",
  ].map((field) => [field, {
    recordedSum: 0,
    validRecords: 0,
    missingRecords: 0,
    invalidRecords: 0,
    explicitZeroRecords: 0,
  }]));
}

function recordAttemptCounters(coverage, usage) {
  for (const [field, result] of Object.entries(coverage)) {
    if (!usage || !Object.hasOwn(usage, field)) {
      result.missingRecords += 1;
      continue;
    }
    const value = usage[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      result.invalidRecords += 1;
      continue;
    }
    result.validRecords += 1;
    result.recordedSum += value;
    if (value === 0) result.explicitZeroRecords += 1;
  }
}

function readShareCohort() {
  return {
    records: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    share: null,
    excludedRecords: 0,
    invalidRecords: 0,
  };
}

function recordReadShare(cohort, usage) {
  const input = usage?.inputTokens;
  const cached = usage?.cachedInputTokens;
  if (!Number.isSafeInteger(input) || input < 0 ||
      !Number.isSafeInteger(cached) || cached < 0) {
    cohort.excludedRecords += 1;
    return;
  }
  if (cached > input) {
    cohort.excludedRecords += 1;
    cohort.invalidRecords += 1;
    return;
  }
  cohort.records += 1;
  cohort.inputTokens += input;
  cohort.cachedInputTokens += cached;
}

function finalizeReadShare(cohort) {
  if (cohort.inputTokens > 0) cohort.share = cohort.cachedInputTokens / cohort.inputTokens;
}

function tierCoverage() {
  return {
    reportedAttempts: 0,
    matchingRequestedAttempts: 0,
    differentRequestedAttempts: 0,
    missingAttempts: 0,
    unknownRequestedAttempts: 0,
  };
}

function recordTierCoverage(coverage, record) {
  if (!NATIVE_TIERS.has(record.returnedTier) || record.returnedTier === "unknown") {
    coverage.missingAttempts += 1;
    return;
  }
  coverage.reportedAttempts += 1;
  if (!NATIVE_TIERS.has(record.requestedTier) || record.requestedTier === "unknown") {
    coverage.unknownRequestedAttempts += 1;
  } else if (record.returnedTier === record.requestedTier) {
    coverage.matchingRequestedAttempts += 1;
  } else {
    coverage.differentRequestedAttempts += 1;
  }
}

function compactionCoverage() {
  return { present: 0, absent: 0, unknown: 0 };
}

function recordCompactionCoverage(coverage, value) {
  if (value === "present" || value === "absent") coverage[value] += 1;
  else coverage.unknown += 1;
}

function transitionBucket() {
  return {
    requests: 0,
    attempts: 0,
    usage: attemptCounterCoverage(),
    readShareCohort: readShareCohort(),
    latency: {
      recordedMs: 0,
      validAttempts: 0,
      missingAttempts: 0,
      invalidAttempts: 0,
      weightedAverageMs: null,
    },
    returnedTier: tierCoverage(),
    compactionItems: compactionCoverage(),
  };
}

function recordTransitionGroup(bucket, records) {
  bucket.requests += 1;
  bucket.attempts += records.length;
  recordCompactionCoverage(bucket.compactionItems, records[0]?.compactionItems);
  for (const record of records) {
    recordAttemptCounters(bucket.usage, record.usage);
    recordReadShare(bucket.readShareCohort, record.usage);
    recordTierCoverage(bucket.returnedTier, record);
    if (!Object.hasOwn(record, "elapsedMs")) bucket.latency.missingAttempts += 1;
    else if (!Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0) {
      bucket.latency.invalidAttempts += 1;
    } else {
      bucket.latency.validAttempts += 1;
      bucket.latency.recordedMs += record.elapsedMs;
    }
  }
}

function finalizeTransitionBucket(bucket) {
  finalizeReadShare(bucket.readShareCohort);
  if (bucket.latency.validAttempts) {
    bucket.latency.weightedAverageMs = bucket.latency.recordedMs / bucket.latency.validAttempts;
  }
}

export function summarizeNativeAttemptObservations(contents) {
  const lines = String(contents || "").split(/\r?\n/u).filter((line) => line.trim());
  let latestStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      if (JSON.parse(lines[index])?.event === "generation_start") latestStart = index;
    } catch {}
  }
  const summary = {
    version: 1,
    scope: "latest opt-in attributable native answering generation only",
    generationFound: latestStart >= 0,
    coverage: {
      totalLines: latestStart >= 0 ? lines.length - latestStart - 1 : lines.length,
      parsedAttempts: 0,
      malformedRecords: 0,
      associatedAttempts: 0,
      unassociatedAttempts: 0,
      associationResets: 0,
      invalidOrdering: 0,
    },
    targets: {},
    outcomes: {},
    transitions: {},
    transitionDetails: {},
    usage: attemptCounterCoverage(),
    readShareCohort: readShareCohort(),
    metadataCoverage: {
      returnedTier: tierCoverage(),
      compactionItems: compactionCoverage(),
    },
    outsideTransitions: {
      initialRequests: 0,
      orderingInvalidRequests: 0,
      unassociatedAttempts: 0,
    },
    limitations: [
      "Transitions use explicit process-local association and request ordinals; resets, overlap, eviction and restart break continuity.",
      "Attempts are transport observations, not task outcomes, causal cache effects, subscription debits or complete task costs.",
      "Read share includes only attempts reporting both input and cached-input counters; missing counters are never zero-filled.",
      "Historical routing.jsonl records remain a separate partial accounting surface.",
    ],
  };
  if (latestStart < 0) return summary;
  const groups = [];
  const groupByAssociation = new Map();
  const flushGroups = (breakOrdering = false) => {
    for (const group of groupByAssociation.values()) {
      if (breakOrdering) group.contiguous = false;
      groups.push(group);
    }
    groupByAssociation.clear();
  };
  for (const line of lines.slice(latestStart + 1)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      summary.coverage.malformedRecords += 1;
      flushGroups(true);
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record) || record.schemaVersion !== 1) {
      summary.coverage.malformedRecords += 1;
      flushGroups(true);
      continue;
    }
    if (record.event === "association_reset") {
      if (Number.isSafeInteger(record.association) && record.association > 0) {
        const group = groupByAssociation.get(record.association);
        if (group) groups.push(group);
        groups.push({ association: record.association, reset: true });
        groupByAssociation.delete(record.association);
        summary.coverage.associationResets += 1;
      }
      continue;
    }
    if (record.event !== "native_attempt") continue;
    summary.coverage.parsedAttempts += 1;
    const model = NATIVE_MODELS.get(record.model) || "unknown";
    const effort = NATIVE_EFFORTS.has(record.effort) ? record.effort : "unknown";
    const tier = NATIVE_TIERS.has(record.requestedTier) ? record.requestedTier : "unknown";
    const target = `${model}:${effort}:${tier}`;
    increment(summary.targets, target);
    increment(summary.outcomes, NATIVE_OUTCOMES.has(record.outcome) ? record.outcome : "unknown");
    recordAttemptCounters(summary.usage, record.usage);
    recordReadShare(summary.readShareCohort, record.usage);
    recordTierCoverage(summary.metadataCoverage.returnedTier, record);
    recordCompactionCoverage(summary.metadataCoverage.compactionItems, record.compactionItems);
    const associated = Number.isSafeInteger(record.association) && record.association > 0 &&
      Number.isSafeInteger(record.request) && record.request > 0 &&
      Number.isSafeInteger(record.attempt) && record.attempt > 0;
    if (!associated) {
      summary.coverage.unassociatedAttempts += 1;
      summary.outsideTransitions.unassociatedAttempts += 1;
      continue;
    }
    summary.coverage.associatedAttempts += 1;
    const current = groupByAssociation.get(record.association);
    if (record.attempt === 1) {
      const duplicateRequest = current?.request === record.request;
      if (current) {
        if (duplicateRequest) {
          current.contiguous = false;
          summary.coverage.invalidOrdering += 1;
        }
        groups.push(current);
      }
      groupByAssociation.set(record.association, {
        association: record.association,
        request: record.request,
        target,
        records: [record],
        contiguous: !duplicateRequest,
      });
      continue;
    }
    if (!current || current.request !== record.request || record.attempt !== current.records.length + 1) {
      summary.coverage.invalidOrdering += 1;
      if (current) current.contiguous = false;
      continue;
    }
    current.records.push(record);
  }
  flushGroups();
  const lastByAssociation = new Map();
  for (const group of groups) {
    if (group.reset) {
      lastByAssociation.delete(group.association);
      continue;
    }
    const previous = lastByAssociation.get(group.association);
    const sequential = previous && group.request === previous.request + 1;
    if (!group.contiguous || (previous && !sequential) || (!previous && group.request !== 1)) {
      summary.outsideTransitions.orderingInvalidRequests += 1;
      lastByAssociation.set(group.association, group.contiguous ? group : undefined);
      continue;
    }
    if (!previous) {
      summary.outsideTransitions.initialRequests += 1;
    } else {
      const key = `${previous.target}->${group.target}`;
      increment(summary.transitions, key);
      const bucket = summary.transitionDetails[key] ??= transitionBucket();
      recordTransitionGroup(bucket, group.records);
    }
    lastByAssociation.set(group.association, group);
  }
  finalizeReadShare(summary.readShareCohort);
  for (const bucket of Object.values(summary.transitionDetails)) finalizeTransitionBucket(bucket);
  return summary;
}

export function buildSwitchyardUsageReport(
  routingContents,
  routerContents,
  options = {},
  nativeAttemptContents = "",
) {
  const trace = summarizeSwitchyardTrace(routerContents);
  const safeClassifier = trace.classifier ? {
    ...trace.classifier,
    providerModels: Object.entries(trace.classifier.providerModels).reduce((counts, [key, count]) => {
      increment(counts, /^typesafe\/jev-1\.13-[A-Za-z0-9.-]+$/u.test(key) ? "jev113" : "unknown", count);
      return counts;
    }, {}),
    finalTargets: Object.entries(trace.classifier.finalTargets).reduce((counts, [key, count]) => {
      increment(counts, safeBucket(key, KNOWN_CLASSIFIER_TARGETS), count);
      return counts;
    }, {}),
    recent: trace.classifier.recent.map((entry) => ({
      ...entry,
      ...(entry.providerModel ? {
        providerModel: /^typesafe\/jev-1\.13-[A-Za-z0-9.-]+$/u.test(entry.providerModel)
          ? "jev-1.13 build"
          : "unknown",
      } : {}),
      ...(entry.finalTarget ? { finalTarget: safeBucket(entry.finalTarget, KNOWN_CLASSIFIER_TARGETS) } : {}),
      ...(entry.reasonCode ? { reasonCode: safeBucket(entry.reasonCode, KNOWN_FALLBACK_REASONS) } : {}),
    })),
  } : undefined;
  const safeSelectedTargets = Object.entries(trace.selectedTargets || {}).reduce((counts, [key, count]) => {
    increment(counts, KNOWN_TARGETS[key]?.key || "unknown", count);
    return counts;
  }, {});
  return {
    ...summarizeSwitchyardUsage(routingContents, options),
    nativeAttempts: summarizeNativeAttemptObservations(nativeAttemptContents),
    generationDiagnostics: {
      scope: "unassociated Router and classifier observations from the latest logged generation",
      ...trace,
      ...(safeClassifier ? { classifier: safeClassifier } : {}),
      ...(trace.selectedTargets ? { selectedTargets: safeSelectedTargets } : {}),
    },
  };
}

function parseUsageArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--session-id") options.sessionId = value();
    else if (argument === "--since") options.since = value();
    else if (argument === "--until") options.until = value();
    else if (argument === "--limit") options.limit = Number(value());
    else throw new Error(`unknown switchyard-trace --usage argument: ${argument}`);
  }
  return options;
}

function main() {
  const argv = process.argv.slice(2);
  let summary;
  if (argv[0] === "--usage") {
    const runtime = switchyardRuntimeStatus();
    const routingPath = path.join(runtime.runtimeRoot, "routing.jsonl");
    const attemptsPath = nativeAttemptLogPath({
      ...process.env,
      CODEX_ROUTER_SWITCHYARD_ATTEMPT_OBSERVATION: "1",
    });
    summary = buildSwitchyardUsageReport(
      readFileSync(routingPath, "utf8"),
      readFileSync(LOG_PATH, "utf8"),
      parseUsageArguments(argv.slice(1)),
      attemptsPath && existsSync(attemptsPath) ? readFileSync(attemptsPath, "utf8") : "",
    );
  } else {
    if (argv.length) throw new Error("usage: switchyard-trace [--usage [--session-id ID] [--since ISO] [--until ISO] [--limit N]]");
    summary = summarizeSwitchyardTrace(readFileSync(LOG_PATH, "utf8"));
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (argv[0] !== "--usage" && !summary.generationFound) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
