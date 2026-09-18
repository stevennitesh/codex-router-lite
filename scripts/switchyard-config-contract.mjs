import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_ANSWERS = Object.freeze({
  luna_max: Object.freeze({
    model: "gpt-5.6-luna",
    routingId: "switchyard/luna-max",
    effort: "max",
  }),
  sol_medium: Object.freeze({
    model: "gpt-5.6-sol",
    routingId: "switchyard/sol-medium",
    effort: "medium",
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

function integer(body, field) {
  const value = new RegExp(`(?:^|\\n)${field}\\s*=\\s*(\\d+)`, "u").exec(body)?.[1];
  return value === undefined ? undefined : Number(value);
}

function decimal(body, field) {
  const value = new RegExp(`(?:^|\\n)${field}\\s*=\\s*(\\d+(?:\\.\\d+)?)`, "u").exec(body)?.[1];
  return value === undefined ? undefined : Number(value);
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
  const auto = section(routesTemplate, "routes", "auto");
  const answerNames = [...(/candidates\s*=\s*\[([^\]]*)\]/u.exec(auto)?.[1] || "")
    .matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  const typeSafeClient = /\[type_safe_client\]([\s\S]*?)(?=\n\[|$)/u.exec(routesTemplate)?.[1] || "";
  return {
    routeModel,
    dispatchId: quoted(auto, "id"),
    contextWindow: integer(auto, "context_window"),
    classifyTrigger: quoted(auto, "classify_trigger"),
    defaultTarget: quoted(auto, "default_target"),
    classifier: {
      type: quoted(auto, "type"),
      model: quoted(typeSafeClient, "model"),
      endpoint: quoted(typeSafeClient, "base_url"),
      apiKeyEnv: quoted(typeSafeClient, "api_key_env"),
      timeoutMs: integer(typeSafeClient, "timeout_ms"),
      maxRequestBytes: integer(typeSafeClient, "max_request_bytes"),
      threshold: decimal(auto, "base_threshold"),
      policyHash: quoted(auto, "policy_hash"),
    },
    answers: answerNames.map((name) => target(routesTemplate, name)),
    smokeContextWindow: integer(section(routesTemplate, "routes", "smoke"), "context_window"),
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
  if (model.upstreamModel !== "gpt-5.6-sol") {
    throw new Error("Switchyard Auto native compaction model must remain gpt-5.6-sol.");
  }
  if (
    contract.classifier?.type !== "type_safe_classifier" ||
    contract.classifier.model !== "typesafe/jev-1.13" ||
    contract.classifier.endpoint !== "https://openrouter.ai/api/alpha/decisions" ||
    contract.classifier.apiKeyEnv !== "OPENROUTER_API_KEY" ||
    contract.classifier.timeoutMs !== 30000 ||
    contract.classifier.maxRequestBytes !== 32768 ||
    contract.classifier.threshold !== 0.35 ||
    contract.classifier.policyHash !== "5fd25e076c6997fe4e997ba313206766e896bcf082ac83e29e57ba54f989748f"
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
    contract.defaultTarget !== "sol_medium" ||
    contract.classifyTrigger !== "user_turn" ||
    contract.contextWindow !== 272000 ||
    contract.smokeContextWindow !== 272000
  ) {
    throw new Error("Switchyard routes must keep Sol fallback, user-turn classification, and 272000 context.");
  }
  return contract;
}
