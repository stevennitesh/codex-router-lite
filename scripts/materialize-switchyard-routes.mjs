import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
const routerBase = process.argv[3];
const evidencePath = process.argv[4] || path.join(root, "docs", "history", "2026-09-18-switchyard-b2-evidence.json");
if (!output || !routerBase) throw new Error("usage: materialize-switchyard-routes.mjs OUTPUT ROUTER_BASE [EVIDENCE]");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (!evidence.promotionEligible || !/^[a-f0-9]{64}$/u.test(evidence.policy.sha256)) {
  throw new Error("B2 whole-candidate evidence is incomplete or not promotion eligible");
}
const { sha256: recordedPolicyHash, ...policy } = evidence.policy;
const computedPolicyHash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
if (computedPolicyHash !== recordedPolicyHash || policy.threshold !== evidence.selectedThreshold) {
  throw new Error("B2 evidence policy hash or threshold does not match the frozen policy");
}
if (policy.transport.endpoint !== "https://openrouter.ai/api/alpha/decisions" ||
    policy.transport.model !== "typesafe/jev-1.13" || policy.transport.redirects !== "disabled" ||
    policy.transport.timeoutMs !== 30000 || policy.transport.maxRequestBytes !== 32768) {
  throw new Error("B2 frozen transport policy is not the supported runtime contract");
}
const sourcePath = path.join(root, "config", "switchyard", "routes.template.toml");
const source = readFileSync(sourcePath, "utf8").replace(/\r\n/gu, "\n");
const start = source.indexOf("[routes.auto]\n");
const end = source.indexOf("[routes.smoke]\n", start);
if (start < 0 || end < 0) throw new Error("Switchyard auto route block was not found");
const criteria = Object.fromEntries(policy.candidates.map(({ label, description }) => [label, description]));
const labels = policy.candidates.map(({ label }) => label);
if (labels.join("|") !== "luna_max|sol_medium|astra_medium|astra_xhigh") {
  throw new Error("B2 frozen candidate order is not the supported route contract");
}
const quote = (value) => JSON.stringify(value);
const route = `[routes.auto]
id = "switchyard-auto"
type = "type_safe_classifier"
candidates = [${labels.map(quote).join(", ")}]
candidate_descriptions = { luna_max = ${quote(criteria.luna_max)}, sol_medium = ${quote(criteria.sol_medium)}, astra_medium = ${quote(criteria.astra_medium)}, astra_xhigh = ${quote(criteria.astra_xhigh)} }
default_target = "sol_medium"
question = ${quote(policy.question)}
base_threshold = ${policy.threshold}
classify_trigger = "user_turn"
policy_hash = "${recordedPolicyHash}"
context_window = 272000
tool_calling = true
reasoning = true

`;
const configuredRoute = source.slice(start, end);
if (configuredRoute !== route) {
  throw new Error("Canonical Switchyard route does not match the accepted frozen policy");
}
const client = `[type_safe_client]
api_key_env = "OPENROUTER_API_KEY"
base_url = "${policy.transport.endpoint}"
model = "${policy.transport.model}"
timeout_ms = ${policy.transport.timeoutMs}
max_request_bytes = ${policy.transport.maxRequestBytes}
`;
if (!source.includes(client) || source.includes("[targets.luna_high]") || source.includes('type = "llm_classifier"')) {
  throw new Error("Canonical Switchyard classifier authority does not match the accepted production design");
}
if (!source.includes("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__")) {
  throw new Error("Canonical Switchyard route template lacks its private Router URL placeholder");
}
writeFileSync(output, source.replace("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__", routerBase));
