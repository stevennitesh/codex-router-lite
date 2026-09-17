import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateFile } from "./file-security.mjs";
import { LITELLM_CONFIG_PATH } from "./paths.mjs";
import { CHECKED_IN_MODELS, routedTransport } from "./routed-models.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function renderLiteLlmConfig() {
  const models = CHECKED_IN_MODELS.filter((model) => routedTransport(model) === "chat");
  const lines = ["model_list:"];
  for (const model of models) {
    lines.push(
      `  - model_name: ${yamlString(model.gatewayModel)}`,
      "    litellm_params:",
      `      model: ${yamlString(`openai/${model.gatewayModel}`)}`,
      '      api_base: "os.environ/CODEX_ROUTER_API_FORWARD_BASE_URL"',
      '      api_key: "os.environ/CODEX_ROUTER_INTERNAL_KEY"',
      "      use_chat_completions_api: true",
      "",
    );
  }
  lines.push(
    "litellm_settings:",
    "  drop_params: true",
    "  request_timeout: 600",
    "",
    // Every model_name above has exactly one deployment, so a cooldown can
    // never route around a failure -- it can only hide it. LiteLLM cools a
    // deployment down on a 401 and then answers with its own 429 "No
    // deployments available", which the router translates into "provider is
    // rate-limiting, wait a bit and retry": the one piece of advice that cannot
    // fix a rejected credential. Relay the provider's real status instead.
    "router_settings:",
    "  disable_cooldowns: true",
    "general_settings:",
    "  disable_spend_logs: true",
    "",
  );
  return lines.join("\n");
}

export function writeLiteLlmConfig(target = LITELLM_CONFIG_PATH) {
  // Only guard the managed path. Tests and tooling that render to an explicit
  // temporary file are not touching the live gateway config.
  if (target === LITELLM_CONFIG_PATH) {
    assertStateOwnership("write the gateway routing config");
  }
  writePrivateFile(target, renderLiteLlmConfig());
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = writeLiteLlmConfig();
  const models = CHECKED_IN_MODELS.filter((model) => routedTransport(model) === "chat").length;
  process.stdout.write(`${JSON.stringify({ path: target, models })}\n`);
}
