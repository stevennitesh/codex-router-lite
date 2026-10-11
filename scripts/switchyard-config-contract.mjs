import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanTomlDocument, tomlStringValue } from "../src/toml-structure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_ANSWERS = Object.freeze({
  luna_max: Object.freeze({
    model: "gpt-5.6-luna",
    routingId: "switchyard/luna-max",
    effort: "max",
  }),
  sol_high: Object.freeze({
    model: "gpt-6.1-sol",
    routingId: "switchyard/sol-high",
    effort: "high",
  }),
  astra_medium: Object.freeze({
    model: "gpt-6-astra",
    routingId: "switchyard/astra-medium",
    effort: "medium",
  }),
  astra_xhigh: Object.freeze({
    model: "gpt-6-astra",
    routingId: "switchyard/astra-xhigh",
    effort: "xhigh",
  }),
});

function assignmentFor(document, tablePath, field) {
  const matches = document.assignments.filter(assignment =>
    assignment.tablePath.length === tablePath.length &&
    assignment.tablePath.every((part, index) => part === tablePath[index]) &&
    assignment.key.length === 1 && assignment.key[0] === field);
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw new Error(`Duplicate Switchyard setting ${field}.`);
  return matches[0];
}

function numeric(document, tablePath, field, { integer = false } = {}) {
  const assignment = assignmentFor(document, tablePath, field);
  if (!assignment) return undefined;
  // The shared scanner owns assignment context; this checker supports complete
  // decimal values only, and explicitly refuses every other representation.
  const value = document.lines[assignment.index].slice(assignment.valueStart)
    .split("#", 1)[0].trim();
  const grammar = integer
    ? /^[+-]?(?:0|[1-9](?:_?\d)*)$/u
    : /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/u;
  const parsed = Number(value.replaceAll("_", ""));
  if (assignment.kind !== "other" || !grammar.test(value) || !Number.isFinite(parsed) ||
      (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(`Switchyard setting ${field} must be a complete ${integer ? "safe decimal integer" : "decimal number"}.`);
  }
  return parsed;
}

// Only the maintained candidate array and inline override values need compound
// decoding. Keep that bounded semantic grammar here, outside the shared lexer.
function compoundValue(document, tablePath, field) {
  const assignment = assignmentFor(document, tablePath, field);
  if (!assignment) return undefined;
  const end = Math.min(document.lines.length, ...[...document.assignments, ...document.headers]
    .filter(record => record.index > assignment.index).map(record => record.index));
  const source = document.lines.slice(assignment.index, end).join("\n").slice(assignment.valueStart);
  const invalid = () => { throw new Error(`Unsupported or ambiguous Switchyard setting ${field}.`); };
  if (source.length > 65536) invalid();
  let index = 0, count = 0, inlineDepth = 0;
  function skip() {
    while (index < source.length) {
      if (inlineDepth && (source[index] === "\n" || source[index] === "\r" || source[index] === "#")) invalid();
      if (/\s/u.test(source[index])) index += 1;
      else if (source[index] === "#") {
        while (index < source.length && source[index] !== "\n") index += 1;
      } else break;
    }
  }
  function string() {
    const start = index, quote = source[index++];
    if (source.slice(start, start + 3) === quote.repeat(3)) invalid();
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\n" || source[index] === "\r") invalid();
      if (quote === '"' && source[index] === "\\") index += 1;
      index += 1;
    }
    if (source[index++] !== quote) invalid();
    return tomlStringValue(scanTomlDocument(`value = ${source.slice(start, index)}`), [], "value");
  }
  function value(depth = 0) {
    if (depth > 8 || ++count > 256) invalid();
    skip();
    if (source[index] === '"' || source[index] === "'") return string();
    const open = source[index];
    if (open === "[" || open === "{") {
      const table = open === "{", close = table ? "}" : "]";
      const result = table ? Object.create(null) : [];
      if (table) inlineDepth += 1;
      index += 1; skip();
      while (source[index] !== close) {
        if (table) {
          const quoted = source[index] === '"' || source[index] === "'";
          const key = quoted ? string() : /^[A-Za-z0-9_-]+/u.exec(source.slice(index))?.[0];
          if (key === undefined || Object.hasOwn(result, key)) invalid();
          if (!quoted) index += key.length;
          skip(); if (source[index++] !== "=") invalid();
          result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        skip();
        if (source[index] === close) break;
        if (source[index++] !== ",") invalid();
        skip();
        if (table && source[index] === close) invalid();
      }
      if (source[index++] !== close) invalid();
      if (table) inlineDepth -= 1;
      return result;
    }
    const boolean = /^(?:true|false)(?![A-Za-z0-9_-])/u.exec(source.slice(index));
    if (!boolean) invalid();
    index += boolean[0].length;
    return boolean[0] === "true";
  }
  const result = value();
  skip(); if (index !== source.length) invalid();
  return result;
}

function target(document, name) {
  const table = ["targets", name];
  const overrides = compoundValue(document, table, "body_overrides");
  return {
    name,
    model: tomlStringValue(document, table, "id"),
    routingId: tomlStringValue(document, table, "routing_id"),
    effort: overrides?.reasoning?.effort,
  };
}

export function parseSwitchyardConfigContract(routesTemplate, routeModel) {
  const document = scanTomlDocument(routesTemplate);
  const tables = new Set();
  for (const header of document.headers) {
    const key = JSON.stringify(header.path);
    if (tables.has(key) || header.array) {
      throw new Error("Switchyard contract requires unique ordinary tables.");
    }
    tables.add(key);
  }
  const auto = ["routes", "auto"], client = ["type_safe_client"];
  const answerNames = compoundValue(document, auto, "candidates") || [];
  if (!Array.isArray(answerNames) || answerNames.some(name => typeof name !== "string")) {
    throw new Error("Switchyard candidates must be an array of strings.");
  }
  return {
    routeModel,
    dispatchId: tomlStringValue(document, auto, "id"),
    contextWindow: numeric(document, ["routes", "auto"], "context_window", { integer: true }),
    classifyTrigger: tomlStringValue(document, auto, "classify_trigger"),
    defaultTarget: tomlStringValue(document, auto, "default_target"),
    classifier: {
      type: tomlStringValue(document, auto, "type"),
      model: tomlStringValue(document, client, "model"),
      endpoint: tomlStringValue(document, client, "base_url"),
      apiKeyEnv: tomlStringValue(document, client, "api_key_env"),
      timeoutMs: numeric(document, ["type_safe_client"], "timeout_ms", { integer: true }),
      maxRequestBytes: numeric(document, ["type_safe_client"], "max_request_bytes", { integer: true }),
      threshold: numeric(document, ["routes", "auto"], "base_threshold"),
    },
    answers: answerNames.map((name) => target(document, name)),
    smokeContextWindow: numeric(document, ["routes", "smoke"], "context_window", { integer: true }),
  };
}

export function readSwitchyardConfigContract(root = ROOT) {
  const routesTemplate = readFileSync(
    path.join(root, "config", "switchyard", "routes.template.toml"),
    "utf8",
  );
  const routeModel = JSON.parse(readFileSync(
    path.join(root, "config", "switchyard", "auto.json"),
    "utf8",
  )).models[0];
  return parseSwitchyardConfigContract(routesTemplate, routeModel);
}

export function validateSwitchyardConfigContract(contract) {
  const model = contract?.routeModel;
  if (
    model?.slug !== "switchyard/auto" ||
    model.gatewayModel !== "switchyard-auto" ||
    contract.dispatchId !== model.gatewayModel
  ) {
    throw new Error("Switchyard Auto dispatch id must match the registered routes.auto id.");
  }
  if (model.upstreamModel !== "gpt-6.1-sol") {
    throw new Error("Switchyard Auto native compaction model must remain gpt-6.1-sol.");
  }
  if (model.defaultEffort !== "high" || model.behaviorTemplate !== "gpt-6.1-sol") {
    throw new Error("Switchyard Auto must use the Sol 6.1 behavior template and default high effort.");
  }
  if (
    contract.classifier?.type !== "type_safe_classifier" ||
    contract.classifier.model !== "typesafe/jev-1.13" ||
    contract.classifier.endpoint !== "https://openrouter.ai/api/alpha/decisions" ||
    contract.classifier.apiKeyEnv !== "OPENROUTER_API_KEY" ||
    contract.classifier.timeoutMs !== 3000 ||
    contract.classifier.maxRequestBytes !== 32768 ||
    contract.classifier.threshold !== 0.35
  ) {
    throw new Error("Switchyard classifier must match the accepted Jev policy and bounded OpenRouter Decisions transport.");
  }
  const expectedNames = Object.keys(EXPECTED_ANSWERS);
  const actualByName = new Map(contract.answers?.map((answer) => [answer.name, answer]) || []);
  if (
    contract.answers?.length !== expectedNames.length ||
    actualByName.size !== expectedNames.length ||
    expectedNames.some((name) => !actualByName.has(name))
  ) {
    throw new Error(`Switchyard answer targets must contain exactly: ${expectedNames.join(", ")}.`);
  }
  const routingIds = new Set();
  for (const name of expectedNames) {
    const expected = EXPECTED_ANSWERS[name];
    const actual = actualByName.get(name);
    if (
      actual.model !== expected.model ||
      actual.routingId !== expected.routingId ||
      actual.effort !== expected.effort
    ) {
      throw new Error(
        `Switchyard target ${name} must use ${expected.model}, ${expected.routingId}, and ${expected.effort} effort.`,
      );
    }
    if (routingIds.has(actual.routingId)) {
      throw new Error(`Switchyard target routing identity ${actual.routingId} must be unique.`);
    }
    routingIds.add(actual.routingId);
  }
  const answerModels = new Set(contract.answers.map((answer) => answer.model));
  const compatibilityModels = new Set(model.compatibilityModels);
  if (
    compatibilityModels.size !== answerModels.size ||
    [...compatibilityModels].some((slug) => !answerModels.has(slug))
  ) {
    throw new Error("Switchyard answer targets must match the catalog compatibility families.");
  }
  if (
    contract.defaultTarget !== "sol_high" ||
    contract.classifyTrigger !== "user_turn" ||
    contract.contextWindow !== 272000 ||
    contract.smokeContextWindow !== 272000
  ) {
    throw new Error("Switchyard routes must keep Sol fallback, user-turn classification, and 272000 context.");
  }
  return contract;
}
