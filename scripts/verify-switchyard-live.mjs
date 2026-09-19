import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { nativeAccountCatalogHeaders } from "../src/codex-native-session.mjs";
import { CALLER_SECRET_PATH, CODEX_HOME, LOG_PATH, PORTS } from "../src/paths.mjs";
import { summarizeSwitchyardTrace } from "../src/switchyard-trace.mjs";

const root = path.resolve(import.meta.dirname, "..");
const output = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!output) throw new Error("usage: verify-switchyard-live.mjs OUTPUT_JSON");
const expectedTemplateHash = createHash("sha256").update(readFileSync(
  path.join(root, "config", "switchyard", "routes.template.toml"),
)).digest("hex");
const session = "switchyard-live-synthetic-verification";
const startedAt = Date.now();

function parseSse(text) {
  return text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => {
      try { return JSON.parse(line.slice(6)); } catch { return undefined; }
    })
    .filter(Boolean);
}

function responseOutput(value, events = []) {
  const completed = events.findLast((event) => event.type === "response.completed");
  const finalOutput = Array.isArray(completed?.response?.output) ? completed.response.output : [];
  const done = events.filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item);
  if (done.length) {
    const identities = new Set(finalOutput.map((item) => item?.id || item?.call_id).filter(Boolean));
    return [...finalOutput, ...done.filter((item) => !identities.has(item?.id || item?.call_id))];
  }
  return finalOutput.length ? finalOutput : Array.isArray(value?.output) ? value.output : [];
}

function responseText(result) {
  return result.output.flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text)
    .join(" ")
    .trim();
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const kind = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}

function solidRedPngDataUrl(width = 128, height = 128) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let pixel = 0; pixel < width; pixel += 1) row.set([255, 0, 0], 1 + pixel * 3);
  const image = Buffer.concat(Array.from({ length: height }, () => row));
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(image)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function functionCall(result) {
  return result.output.find((item) =>
    item?.type === "function_call" && item.name === "synthetic_lookup");
}

async function post(url, body, headers, timeoutMs = 180_000) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  const events = response.headers.get("content-type")?.includes("text/event-stream") ||
    /^(?:event|data):/mu.test(raw) ? parseSse(raw) : [];
  let value;
  if (!events.length && raw) {
    try { value = JSON.parse(raw); } catch {}
  }
  const terminal = events.findLast((event) => [
    "response.completed", "response.failed", "response.incomplete", "error",
  ].includes(event.type));
  const finalValue = terminal?.response || value;
  return {
    status: response.status,
    latencyMs: Math.round(performance.now() - started),
    selected: response.headers.get("x-switchyard-selected-model"),
    value: finalValue,
    terminalType: terminal?.type || (finalValue?.status ? `response.${finalValue.status}` : null),
    output: responseOutput(value, events),
  };
}

function completed(result) {
  return result.status === 200 && result.value?.status === "completed";
}

function compact(result) {
  return {
    status: result.status,
    latencyMs: result.latencyMs,
    selected: result.selected,
    publicModel: result.value?.model || null,
    completed: completed(result),
    terminalType: result.terminalType,
    outputKinds: result.output.map((item) => ({
      type: item?.type || null,
      ...(item?.name ? { name: item.name } : {}),
    })),
  };
}

function providerCallCount(trace) {
  return Object.values(trace.classifier.providerModels).reduce((sum, count) => sum + count, 0);
}

const callerSecret = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
const nativeHeaders = await nativeAccountCatalogHeaders();
if (!nativeHeaders) throw new Error("signed-in native Codex authentication is unavailable");
const headers = { ...nativeHeaders, "session-id": session };
const base = callerBaseUrl(PORTS.router, callerSecret);
const health = await fetch(`http://127.0.0.1:${PORTS.router}/health`, {
  signal: AbortSignal.timeout(5_000),
});
if (!health.ok) throw new Error("managed Router is unhealthy");

const tool = {
  type: "function",
  name: "synthetic_lookup",
  description: "Return the fixed synthetic verification value.",
  strict: true,
  parameters: {
    type: "object",
    properties: { key: { type: "string", enum: ["fixture"] } },
    required: ["key"],
    additionalProperties: false,
  },
};
const openingInput = [{
  type: "message",
  role: "user",
  content: [{
    type: "input_text",
    text: "Use the supplied synthetic lookup tool once, then report its value. This is a bounded implementation verification.",
  }],
}];
const first = await post(`${base}/responses`, {
  model: "switchyard/auto",
  input: openingInput,
  tools: [tool],
  tool_choice: { type: "function", name: tool.name },
  store: false,
  stream: false,
}, headers);
const call = functionCall(first);
let argumentsValid = false;
try {
  argumentsValid = JSON.parse(call?.arguments || "null")?.key === "fixture";
} catch {}
if (!call || !argumentsValid) throw new Error("routed tool call did not match the synthetic fixture");

const second = await post(`${base}/responses`, {
  model: "switchyard/auto",
  input: [
    ...openingInput,
    { type: "function_call", name: call.name, call_id: call.call_id, arguments: call.arguments },
    { type: "function_call_output", call_id: call.call_id, output: "SYNTHETIC_VALUE_42" },
  ],
  tools: [tool],
  tool_choice: "none",
  store: false,
  stream: false,
}, headers);

const mediaInput = [{
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text: "What single dominant color fills this synthetic image? Reply with only the lowercase color name." },
    { type: "input_image", image_url: solidRedPngDataUrl(), detail: "low" },
  ],
}];
const nativeMedia = await post(`${base}/responses`, {
  model: "gpt-5.6-sol",
  input: mediaInput,
  store: false,
  stream: true,
}, { ...nativeHeaders, "session-id": `${session}-media-native` });
const beforeMedia = summarizeSwitchyardTrace(readFileSync(LOG_PATH, "utf8"));
const media = await post(`${base}/responses`, {
  model: "switchyard/auto",
  input: mediaInput,
  store: false,
  stream: true,
}, { ...nativeHeaders, "session-id": `${session}-media-auto` });
const afterMedia = summarizeSwitchyardTrace(readFileSync(LOG_PATH, "utf8"));

const beforeCompact = afterMedia;
const nativeCompact = await post(`${base}/responses`, {
  model: "switchyard/auto",
  input: [
    { role: "user", content: "Compact this synthetic two-sentence local history." },
    { type: "compaction_trigger" },
  ],
  store: false,
  stream: true,
}, nativeHeaders);
const afterCompact = summarizeSwitchyardTrace(readFileSync(LOG_PATH, "utf8"));

const installedProvenance = JSON.parse(readFileSync(
  path.join(CODEX_HOME, "switchyard", "provenance.json"),
  "utf8",
));
const recentClassifier = afterCompact.classifier.recent
  .filter((item) => Date.parse(item.at) >= startedAt)
  .slice(-10);
const providerVersions = [...new Set(recentClassifier.map((item) => item.providerModel).filter(Boolean))];
const routingRecords = readFileSync(path.join(CODEX_HOME, "switchyard", "routing.jsonl"), "utf8")
  .split(/\r?\n/u)
  .flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })
  .filter((item) => Date.parse(item.ts) >= startedAt);
const firstSelected = routingRecords[0]?.model || null;
const secondSelected = routingRecords[1]?.model || null;
const templateObserved = installedProvenance.templateSha256 === expectedTemplateHash;
const mediaFallbackObserved = recentClassifier.some((item) =>
  item.source === "fail_open" && item.reasonCode === "non_text_state" && item.finalTarget === "sol_medium");
const probabilityMapObserved = recentClassifier.some((item) =>
  item.source === "type_safe_classifier" &&
  item.probabilities &&
  Object.keys(item.probabilities).length === 4);

const evidence = {
  schemaVersion: 1,
  checkpoint: "switchyard-live",
  testedAt: new Date().toISOString(),
  binding: {
    routerCommit: installedProvenance.routerCommit,
    upstreamCommit: installedProvenance.upstreamCommit,
    binarySha256: installedProvenance.binarySha256,
    routesSha256: installedProvenance.routesSha256,
    templateSha256: expectedTemplateHash,
  },
  ordinaryToolRoundTrip: {
    first: compact(first),
    second: compact(second),
    callObserved: Boolean(call),
    argumentsValid,
    selectedTargets: [firstSelected, secondSelected],
    affinityStable: Boolean(firstSelected) && firstSelected === secondSelected,
  },
  nativeMediaControl: {
    ...compact(nativeMedia),
    answer: responseText(nativeMedia),
  },
  mediaFallback: {
    ...compact(media),
    answer: responseText(media),
    fallbackObserved: mediaFallbackObserved,
    providerCallsBefore: providerCallCount(beforeMedia),
    providerCallsAfter: providerCallCount(afterMedia),
    zeroProviderCalls: providerCallCount(beforeMedia) === providerCallCount(afterMedia),
  },
  nativeCompaction: {
    status: nativeCompact.status,
    latencyMs: nativeCompact.latencyMs,
    publicModel: nativeCompact.value?.model || null,
    classifierDecisionsBefore: beforeCompact.classifier.decisions,
    classifierDecisionsAfter: afterCompact.classifier.decisions,
    bypassedClassifier: beforeCompact.classifier.decisions === afterCompact.classifier.decisions,
  },
  classifier: {
    providerVersions,
    templateObserved,
    probabilityMapObserved,
    fallbacks: afterCompact.classifier.fallbacks,
    recent: recentClassifier,
  },
  privatePayloadsRetained: false,
  priorInvalidFixture: {
    status: 400,
    reason: "The former one-pixel PNG was rejected because its data did not represent a valid image; it was replaced by a programmatically generated 128x128 PNG.",
  },
  limitations: [],
};
evidence.requiredFailures = [];
if (!completed(first) || !completed(second)) evidence.requiredFailures.push("tool round trip did not complete");
if (first.value?.model !== "switchyard/auto" || second.value?.model !== "switchyard/auto") {
  evidence.requiredFailures.push("public response identity drifted");
}
if (!evidence.ordinaryToolRoundTrip.affinityStable) evidence.requiredFailures.push("tool continuation affinity drifted");
if (!firstSelected || !secondSelected) evidence.requiredFailures.push("selected answer identity was not recorded");
if (!completed(nativeMedia) || nativeMedia.value?.model !== "gpt-5.6-sol" || responseText(nativeMedia).toLowerCase() !== "red") {
  evidence.requiredFailures.push("native Sol media control did not complete with the expected visual answer");
}
if (!completed(media) || media.value?.model !== "switchyard/auto" || responseText(media).toLowerCase() !== "red") {
  evidence.requiredFailures.push("routed media answer did not complete with the expected public identity and visual answer");
}
if (!mediaFallbackObserved || !evidence.mediaFallback.zeroProviderCalls) {
  evidence.requiredFailures.push("non-text zero-call fallback was not observed");
}
if (nativeCompact.status !== 200 || !evidence.nativeCompaction.bypassedClassifier) {
  evidence.requiredFailures.push("native compaction did not bypass the classifier");
}
if (
  !templateObserved ||
  !probabilityMapObserved ||
  !providerVersions.some((model) => model.startsWith("typesafe/jev-1.13-"))
) {
  evidence.requiredFailures.push("classifier binding evidence is incomplete");
}
evidence.evidenceSha256 = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  output,
  evidenceSha256: evidence.evidenceSha256,
  requiredFailures: evidence.requiredFailures,
  selected: [firstSelected, secondSelected],
  providerVersions,
  templateObserved,
  probabilityMapObserved,
  compactionBypassedClassifier: evidence.nativeCompaction.bypassedClassifier,
}, null, 2)}\n`);
if (evidence.requiredFailures.length) process.exitCode = 1;
