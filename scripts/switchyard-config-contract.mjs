import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanTomlDocument } from "../src/toml-structure.mjs";

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

function section(source, kind, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\[${kind}\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`, "u")
    .exec(source)?.[1] || "";
}

function quoted(body, field) {
  return new RegExp(`(?:^|\\n)${field}\\s*=\\s*"([^"]+)"`, "u").exec(body)?.[1];
}

function numeric(document, tablePath, field, { integer = false } = {}) {
  const matches = document.assignments.filter(assignment =>
    assignment.tablePath.length === tablePath.length &&
    assignment.tablePath.every((part, index) => part === tablePath[index]) &&
    assignment.key.length === 1 && assignment.key[0] === field);
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw new Error(`Duplicate Switchyard numeric setting ${field}.`);
  const assignment = matches[0];
  // The shared scanner owns assignment context; this checker supports complete
  // decimal values only, and explicitly refuses every other representation.
  const value = document.lines[assignment.index].slice(document.lines[assignment.index].indexOf("=") + 1)
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

function target(source, name) {
  const body = section(source, "targets", name);
  return {
    name,
    model: quoted(body, "id"),
    routingId: quoted(body, "routing_id"),
    effort: /reasoning\s*=\s*\{\s*effort\s*=\s*"([^"]+)"/u.exec(body)?.[1],
  };
}

export function parseSwitchyardConfigContract(routesTemplate, routeModel) {
  const document = scanTomlDocument(routesTemplate);
  const auto = section(routesTemplate, "routes", "auto");
  const answerNames = [...(/candidates\s*=\s*\[([^\]]*)\]/u.exec(auto)?.[1] || "")
    .matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  const typeSafeClient = /\[type_safe_client\]([\s\S]*?)(?=\n\[|$)/u.exec(routesTemplate)?.[1] || "";
  return {
    routeModel,
    dispatchId: quoted(auto, "id"),
    contextWindow: numeric(document, ["routes", "auto"], "context_window", { integer: true }),
    classifyTrigger: quoted(auto, "classify_trigger"),
    defaultTarget: quoted(auto, "default_target"),
    classifier: {
      type: quoted(auto, "type"),
      model: quoted(typeSafeClient, "model"),
      endpoint: quoted(typeSafeClient, "base_url"),
      apiKeyEnv: quoted(typeSafeClient, "api_key_env"),
      timeoutMs: numeric(document, ["type_safe_client"], "timeout_ms", { integer: true }),
      maxRequestBytes: numeric(document, ["type_safe_client"], "max_request_bytes", { integer: true }),
      threshold: numeric(document, ["routes", "auto"], "base_threshold"),
    },
    answers: answerNames.map((name) => target(routesTemplate, name)),
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
